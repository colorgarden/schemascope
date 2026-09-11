// =============================================================================
// parser.js —— 蓝图容器解析 + TypeIO + contentMap + 处理器逻辑提取
//
// 逐函数对照 msch.py：
//   class Reader / read_object() / parse_content_map() / make_resolver()
//   load_container() / parse_schematic() / extract_logic()
//
// 与 Python 版本的一处差异：解压是异步的（浏览器 DecompressionStream 是异步
// API），因此 load_container / parse_schematic / extract_logic 均返回 Promise。
// =============================================================================

import { inflate } from "./inflate.js";
import { TYPE_NAMES, CONTENT_TYPE_LABEL } from "./data.js";

// -----------------------------------------------------------------------------
// 2. 二进制读取器（大端序）
// -----------------------------------------------------------------------------

export class Reader {
  constructor(buf) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.pos = 0;
  }

  _need(n) {
    if (this.pos + n > this.buf.length) {
      throw new Error(
        `数据越界：需要 ${n} 字节，剩余 ${this.buf.length - this.pos}`
      );
    }
  }

  u8() {
    this._need(1);
    return this.view.getUint8(this.pos++);
  }

  i8() {
    const v = this.u8();
    return v >= 128 ? v - 256 : v;
  }

  i16() {
    this._need(2);
    const v = this.view.getInt16(this.pos);
    this.pos += 2;
    return v;
  }

  u16() {
    this._need(2);
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }

  i32() {
    this._need(4);
    const v = this.view.getInt32(this.pos);
    this.pos += 4;
    return v;
  }

  i64() {
    this._need(8);
    const v = this.view.getBigInt64(this.pos);
    this.pos += 8;
    return Number(v);
  }

  f32() {
    this._need(4);
    const v = this.view.getFloat32(this.pos);
    this.pos += 4;
    return v;
  }

  f64() {
    this._need(8);
    const v = this.view.getFloat64(this.pos);
    this.pos += 8;
    return v;
  }

  raw(n) {
    this._need(n);
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  bool() {
    return this.u8() !== 0;
  }

  // Mindustry 的 UTF：2 字节无符号长度 + UTF-8 字节
  utf() {
    const n = this.u16();
    return decodeUtf8(this.raw(n));
  }

  // TypeIO 字符串：1 字节存在标志，非 0 时再读 UTF
  nullableStr() {
    if (this.u8() === 0) return null;
    return this.utf();
  }
}

const _utf8Decoder = new TextDecoder("utf-8", { fatal: false });
function decodeUtf8(bytes) {
  return _utf8Decoder.decode(bytes);
}

// -----------------------------------------------------------------------------
// 3. TypeIO 对象解析
// -----------------------------------------------------------------------------

/**
 * 读取一个 TypeIO 对象，返回 { value, type }。
 * resolveContent(typeOrdinal, id) → 显示名（通常由 contentMap 得到）。
 */
export function readObject(r, resolveContent) {
  const tag = r.u8();
  const tname = TYPE_NAMES[tag] !== undefined ? TYPE_NAMES[tag] : "?" + tag;

  switch (tag) {
    case 0: // null
      return { value: null, type: tname };
    case 1: // int32
      return { value: r.i32(), type: tname };
    case 2: // int64
      return { value: r.i64(), type: tname };
    case 3: // float32
      return { value: r.f32(), type: tname };
    case 4: // string
      return { value: r.nullableStr(), type: tname };
    case 5: {
      // content
      const ct = r.u8();
      const cid = r.i16();
      return { value: resolveContent(ct, cid), type: tname };
    }
    case 6: {
      // intSeq: short n + n × int32
      const n = r.i16();
      const arr = [];
      for (let i = 0; i < n; i++) arr.push(r.i32());
      return { value: arr, type: tname };
    }
    case 7: // point2: int x, int y
      return { value: [r.i32(), r.i32()], type: tname };
    case 8: {
      // point2Array: byte n + n × packed int32
      const n = r.u8();
      const pts = [];
      for (let i = 0; i < n; i++) {
        const packed = r.i32();
        // arc Point2.pack：x 在高 16 位、y 在低 16 位（均为有符号）
        let x = (packed >> 16) & 0xffff;
        x = x >= 0x8000 ? x - 0x10000 : x;
        let y = packed & 0xffff;
        y = y >= 0x8000 ? y - 0x10000 : y;
        pts.push([x, y]);
      }
      return { value: pts, type: tname };
    }
    case 9: // techNode: byte + short
      r.u8();
      r.i16();
      return { value: null, type: tname };
    case 10: // bool
      return { value: r.bool(), type: tname };
    case 11: // double
      return { value: r.f64(), type: tname };
    case 12: // building: int pos
      return { value: r.i32(), type: tname };
    case 13: // lAccess: short
      return { value: r.i16(), type: tname };
    case 14: {
      // byteArray: int len + len bytes
      const n = r.i32();
      return { value: r.raw(n), type: tname };
    }
    case 15: // legacy: 读 1 字节后丢弃
      r.u8();
      return { value: null, type: tname };
    case 16: {
      // boolArray: int n + n 字节
      const n = r.i32();
      const arr = [];
      for (let i = 0; i < n; i++) arr.push(r.bool());
      return { value: arr, type: tname };
    }
    case 17: // unit: int id
      return { value: r.i32(), type: tname };
    case 18: {
      // vec2Array: short n + n × (f32, f32)
      const n = r.i16();
      const arr = [];
      for (let i = 0; i < n; i++) arr.push([r.f32(), r.f32()]);
      return { value: arr, type: tname };
    }
    case 19: // vec2: f32, f32
      return { value: [r.f32(), r.f32()], type: tname };
    case 20: // team: byte
      return { value: r.u8(), type: tname };
    case 21: {
      // intArray: short n + n × int32（见 TypeIO.readInts）
      const n = r.i16();
      const arr = [];
      for (let i = 0; i < n; i++) arr.push(r.i32());
      return { value: arr, type: tname };
    }
    case 22: {
      // objectArray: int n + n × 递归对象
      const n = r.i32();
      const arr = [];
      for (let i = 0; i < n; i++) arr.push(readObject(r, resolveContent).value);
      return { value: arr, type: tname };
    }
    case 23: // unitCommand: short
      return { value: r.u16(), type: tname };
    default:
      throw new Error(`未知的 TypeIO 标签 ${tag}（偏移 ${r.pos - 1}）`);
  }
}

// -----------------------------------------------------------------------------
// 4. contentMap 解析
// -----------------------------------------------------------------------------

/**
 * 解析 contentMap。官方为 JSON `{"0":{"copper":1,...}}`（type → name → id）；
 * 旧存档也可能是非标准 `{0:{surge-alloy:12}}`（无引号）→ 回退正则。
 * 返回 Map，键为 `${typeOrdinal},${id}`，值为名称。
 */
export function parseContentMap(text) {
  const rev = new Map();
  if (!text) return rev;
  const trimmed = String(text).trim();

  const take = (obj) => {
    if (!obj || typeof obj !== "object") return false;
    let any = false;
    for (const [typeKey, nameMap] of Object.entries(obj)) {
      const ct = Number(typeKey);
      if (!Number.isFinite(ct) || !nameMap || typeof nameMap !== "object") continue;
      for (const [name, id] of Object.entries(nameMap)) {
        rev.set(`${ct},${Number(id)}`, name);
        any = true;
      }
    }
    return any;
  };

  if (trimmed.startsWith("{")) {
    // 1) 严格 JSON
    try {
      if (take(JSON.parse(trimmed))) return rev;
    } catch (e) {
      // 继续
    }
    // 2) 官方 JsonIO 的非严格 JSON：{0:{sand:4,一级协议:37}}（键未加引号，可能含中文）
    try {
      const fixed = trimmed.replace(/([{,]\s*)([^\s"{}\[\],:]+)\s*:/g, '$1"$2":');
      if (take(JSON.parse(fixed))) return rev;
    } catch (e2) {
      // 继续
    }
  }

  // 3) 宽松正则兜底（支持中文等任意键名，可带引号）
  const blockRe = /(\d+)\s*:\s*\{([^}]*)\}/g;
  const itemRe = /(?:"([^"]+)"|([^:{},\s]+))\s*:\s*(\d+)/g;
  let b;
  while ((b = blockRe.exec(trimmed)) !== null) {
    const ct = Number(b[1]);
    itemRe.lastIndex = 0;
    let it;
    while ((it = itemRe.exec(b[2])) !== null) {
      rev.set(`${ct},${Number(it[3])}`, it[1] !== undefined ? it[1] : it[2]);
    }
  }
  return rev;
}

/** 构造 content 解析函数：(类型序号, id) → 名称。 */
export function makeResolver(contentMap) {
  return function resolve(ct, cid) {
    const key = `${ct},${cid}`;
    if (contentMap.has(key)) return contentMap.get(key);
    const label = CONTENT_TYPE_LABEL[ct] !== undefined ? CONTENT_TYPE_LABEL[ct] : "类型" + ct;
    return `${label}#${cid}`;
  };
}

// -----------------------------------------------------------------------------
// 4b. v0 旧格式 config 映射 + 旧方块名回退（对照 Schematics.java / SaveFileReader）
// -----------------------------------------------------------------------------

export const SCHEMATIC_VERSION = 1;

// 物品 id 顺序（v159.7 Items.java 声明序）
const V0_ITEM_IDS = [
  "copper", "lead", "metaglass", "graphite", "sand", "coal", "titanium", "thorium",
  "scrap", "silicon", "plastanium", "phase-fabric", "surge-alloy", "spore-pod",
  "blast-compound", "pyratite", "beryllium", "tungsten", "oxide", "carbide",
  "fissile-matter", "dormant-cyst",
];
// 液体 id 顺序（v159.7 Liquids.java 声明序）
const V0_LIQUID_IDS = [
  "water", "slag", "oil", "cryofluid", "arkycite", "gallium", "neoplasm",
  "ozone", "hydrogen", "nitrogen", "cyanogen",
];
const V0_ITEM_BLOCKS = new Set(["sorter", "inverted-sorter", "unloader", "item-source"]);
const V0_LIQUID_BLOCKS = new Set(["liquid-source"]);
const V0_BRIDGE_BLOCKS = new Set([
  "mass-driver", "bridge-conveyor", "phase-conveyor", "bridge-conduit", "reinforced-bridge-conduit",
]);
const V0_LIGHT_BLOCKS = new Set(["illuminator"]);

// 旧方块名 → 新名（SaveFileReader.fallback，51 项）
export const FALLBACK_BLOCKS = {
  "dart-mech-pad": "legacy-mech-pad",
  "dart-ship-pad": "legacy-mech-pad",
  "javelin-ship-pad": "legacy-mech-pad",
  "trident-ship-pad": "legacy-mech-pad",
  "glaive-ship-pad": "legacy-mech-pad",
  "alpha-mech-pad": "legacy-mech-pad",
  "tau-mech-pad": "legacy-mech-pad",
  "omega-mech-pad": "legacy-mech-pad",
  "delta-mech-pad": "legacy-mech-pad",
  "draug-factory": "legacy-unit-factory",
  "spirit-factory": "legacy-unit-factory",
  "phantom-factory": "legacy-unit-factory",
  "wraith-factory": "legacy-unit-factory",
  "ghoul-factory": "legacy-unit-factory-air",
  "revenant-factory": "legacy-unit-factory-air",
  "dagger-factory": "legacy-unit-factory",
  "crawler-factory": "legacy-unit-factory",
  "titan-factory": "legacy-unit-factory-ground",
  "fortress-factory": "legacy-unit-factory-ground",
  "mass-conveyor": "payload-conveyor",
  vestige: "scepter",
  "turbine-generator": "steam-generator",
  rocks: "stone-wall",
  sporerocks: "spore-wall",
  icerocks: "ice-wall",
  dunerocks: "dune-wall",
  sandrocks: "sand-wall",
  shalerocks: "shale-wall",
  snowrocks: "snow-wall",
  saltrocks: "salt-wall",
  dirtwall: "dirt-wall",
  ignarock: "basalt",
  holostone: "dacite",
  "holostone-wall": "dacite-wall",
  rock: "boulder",
  snowrock: "snow-boulder",
  cliffs: "stone-wall",
  craters: "crater-stone",
  deepwater: "deep-water",
  water: "shallow-water",
  sand: "sand-floor",
  slag: "molten-slag",
  cryofluidmixer: "cryofluid-mixer",
  "block-forge": "constructor",
  "block-unloader": "payload-unloader",
  "block-loader": "payload-loader",
  "thermal-pump": "impulse-pump",
  "alloy-smelter": "surge-smelter",
  "steam-vent": "rhyolite-vent",
  fabricator: "tank-fabricator",
  "basic-reconstructor": "refabricator",
};

// LegacyBlock → 解析后剔除（不渲染）
export const LEGACY_BLOCKS = new Set([
  "legacy-mech-pad",
  "legacy-unit-factory",
  "legacy-unit-factory-air",
  "legacy-unit-factory-ground",
  "legacy-command-center",
]);

function unpackX(v) {
  let x = (v >> 16) & 0xffff;
  return x >= 0x8000 ? x - 0x10000 : x;
}
function unpackY(v) {
  let y = v & 0xffff;
  return y >= 0x8000 ? y - 0x10000 : y;
}

/** v0 每块 config（裸 int，按方块类型映射）；返回 {type, value}。 */
export function mapV0Config(block, value, positionPacked) {
  if (V0_ITEM_BLOCKS.has(block)) {
    const id = value;
    return { type: "content", value: id >= 0 && id < V0_ITEM_IDS.length ? V0_ITEM_IDS[id] : null };
  }
  if (V0_LIQUID_BLOCKS.has(block)) {
    const id = value;
    return { type: "content", value: id >= 0 && id < V0_LIQUID_IDS.length ? V0_LIQUID_IDS[id] : null };
  }
  if (V0_BRIDGE_BLOCKS.has(block)) {
    return { type: "point2", value: [unpackX(value) - unpackX(positionPacked), unpackY(value) - unpackY(positionPacked)] };
  }
  if (V0_LIGHT_BLOCKS.has(block)) {
    return { type: "int", value };
  }
  return { type: "null", value: null };
}

// -----------------------------------------------------------------------------
// 5. 蓝图容器与主体解析
// -----------------------------------------------------------------------------

const _WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c]);

function stripBytes(buf) {
  let s = 0;
  let e = buf.length;
  while (s < e && _WHITESPACE.has(buf[s])) s++;
  while (e > s && _WHITESPACE.has(buf[e - 1])) e--;
  return buf.subarray(s, e);
}

function removeAllWhitespace(bytes) {
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (!_WHITESPACE.has(bytes[i])) out[n++] = bytes[i];
  }
  return out.subarray(0, n);
}

function bytesStartWith(bytes, str) {
  if (bytes.length < str.length) return false;
  for (let i = 0; i < str.length; i++) {
    if (bytes[i] !== str.charCodeAt(i)) return false;
  }
  return true;
}

function base64ToBytes(text) {
  const cleaned = text.replace(/[^A-Za-z0-9+/=]/g, "");
  if (typeof atob === "function") {
    try {
      const bin = atob(cleaned);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (e) {
      throw new Error("Base64 解码失败：" + e.message);
    }
  }
  // Node 环境兜底
  if (typeof Buffer !== "undefined") {
    try {
      const b = Buffer.from(cleaned, "base64");
      return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    } catch (e) {
      throw new Error("Base64 解码失败：" + e.message);
    }
  }
  throw new Error("当前环境不支持 Base64 解码。");
}

/**
 * 字节 → Base64 文本。浏览器分块 btoa（32KB/块，避免调用栈溢出）；Node 用 Buffer 兜底。
 */
export function bytesToBase64(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof btoa === "function") {
    const CHUNK = 0x8000; // 32KB
    let bin = "";
    for (let i = 0; i < buf.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString("base64");
  }
  throw new Error("当前环境不支持 Base64 编码。");
}

/**
 * 判定是否为「文本型蓝图」：UTF-8 解码后全为可打印 Base64/空白字符，非空，
 * 且 trim 后以 `bXNja` 开头。二进制 .msch 会因 magic 为 "msch" 或含不可打印字节而返回 false。
 */
export function isTextBlueprint(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!buf.length) return false;
  let text;
  try {
    text = _utf8Decoder.decode(buf);
  } catch (e) {
    return false;
  }
  if (!/^[A-Za-z0-9+/=\s]*$/.test(text)) return false;
  return text.trim().startsWith("bXNja");
}

function stringToBytes(str) {
  // 只用于把「以 msch 开头的原始字符串」转字节（正常二进制走 Uint8Array 分支）
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

/**
 * 读取输入（Base64 文本 / 二进制字节 / ArrayBuffer），返回
 * { version, body }。与 msch.py load_container 行为一致。
 */
export async function loadContainer(input) {
  let data;
  if (typeof input === "string") {
    const s = input.trim();
    data = s.startsWith("msch") ? stringToBytes(input) : _textToAscii(s);
  } else if (input instanceof ArrayBuffer) {
    data = new Uint8Array(input);
  } else if (input instanceof Uint8Array) {
    data = input;
  } else {
    throw new Error("无法识别的输入类型（应为文本或二进制）。");
  }

  let raw;
  if (bytesStartWith(stripBytes(data), "msch")) {
    raw = stripBytes(data);
  } else {
    // 去掉全部空白后按 Base64 解码
    let text;
    if (typeof input === "string") {
      text = removeAllWhitespace(_textToAscii(input));
    } else {
      text = removeAllWhitespace(stripBytes(data));
    }
    raw = base64ToBytes(decodeUtf8(text));
    if (!bytesStartWith(raw, "msch")) {
      throw new Error(
        "解码后不是 msch 蓝图（前 4 字节：" +
          JSON.stringify(Array.from(raw.subarray(0, 4))) +
          "）。"
      );
    }
  }

  const version = raw[4];
  const body = await inflate(raw.subarray(5));
  return { version, body };
}

function _textToAscii(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

/**
 * 解析蓝图，返回结构化对象（字段命名与 msch.py build_json 对齐）。
 */
export async function parseSchematic(input) {
  const { version, body } = await loadContainer(input);
  if (version > SCHEMATIC_VERSION) {
    throw new Error(`蓝图来自更新版本的游戏（v${version}），当前最高支持 v1。`);
  }
  const r = new Reader(body);

  const width = r.i16();
  const height = r.i16();

  // ---- 标签 ----
  const tagCount = r.u8();
  const tags = {};
  for (let i = 0; i < tagCount; i++) {
    const key = r.utf();
    const val = r.utf();
    tags[key] = val;
  }

  // ---- 方块字典（旧名 → 新名回退）----
  const dictCount = r.u8();
  const blockDict = [];
  for (let i = 0; i < dictCount; i++) {
    const rawName = r.utf();
    blockDict.push(FALLBACK_BLOCKS[rawName] || rawName);
  }

  // ---- contentMap ----
  const contentMap = parseContentMap(tags["contentMap"] || "");
  const resolve = makeResolver(contentMap);

  // ---- 方块列表 ----
  const total = r.i32();
  const tiles = [];
  for (let i = 0; i < total; i++) {
    const bi = r.u8();
    const packed = r.i32();
    // arc Point2.pack：x 在高 16 位、y 在低 16 位（均为有符号）
    const x = unpackX(packed);
    const y = unpackY(packed);
    // v0：裸 int + 按方块类型映射；v1：TypeIO
    const block = bi < blockDict.length ? blockDict[bi] : "#" + bi;
    const cfg =
      version === 0 ? mapV0Config(block, r.i32(), packed) : readObject(r, resolve);
    const rot = r.i8();
    if (LEGACY_BLOCKS.has(block)) continue; // LegacyBlock → Blocks.air，不渲染
    tiles.push({
      block,
      x,
      y,
      rot,
      config_type: cfg.type,
      config: cfg.value,
    });
  }

  const contentMapObj = {};
  for (const [k, v] of contentMap) {
    const parts = k.split(",");
    contentMapObj[`${Number(parts[0])}:${Number(parts[1])}`] = v;
  }

  return {
    version,
    width,
    height,
    tags,
    content_map: contentMapObj,
    block_dict: blockDict,
    total,
    tiles,
  };
}

// -----------------------------------------------------------------------------
// 6. 逻辑处理器代码提取
// -----------------------------------------------------------------------------

/**
 * 从处理器的 byteArray 配置中解压汇编代码与链接。
 * 结构：zlib( byte version | int32 codeLen | code | int32 linkCount |
 *             linkCount × (UTF name, short x, short y) )
 * 返回 { code, links, version }；解析失败返回 null。
 */
export async function extractLogic(byteArray) {
  if (!(byteArray instanceof Uint8Array) || byteArray.length === 0) return null;
  let inner;
  try {
    inner = await inflate(byteArray);
  } catch (e) {
    return null;
  }
  try {
    const r = new Reader(inner);
    const version = r.u8();
    const codeLen = r.i32();
    const code = decodeUtf8(r.raw(codeLen));
    const linkCount = r.i32();
    const links = [];
    for (let i = 0; i < linkCount; i++) {
      const name = r.utf();
      const lx = r.i16();
      const ly = r.i16();
      links.push({ name, x: lx, y: ly });
    }
    return { code, links, version };
  } catch (e) {
    return null;
  }
}

/** 处理器判定：名称以 processor 结尾。 */
export function isProcessor(blockName) {
  return blockName.endsWith("processor");
}
