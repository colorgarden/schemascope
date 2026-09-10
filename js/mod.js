// =============================================================================
// mod.js —— Mindustry 模组 zip 解析（JSON mod 与混合 mod）
//
// 已核实格式（ContentParser.java）：
//   - mod.json：name = 内部模组名；方块内部名 = `<name>-<文件名去.json>`。
//   - content/blocks/**/*.json：size 缺省 1；requirements 支持 "a/5" 与 {item,amount}。
//   - sprites/** 与 sprites-override/**：按文件名（去扩展名）索引，override 覆盖。
//   - bundles/bundle_zh_CN.properties / bundle.properties：block.<内部名>.name 等。
//
// 纯逻辑，可在 Node 下单测。
// =============================================================================

import { openZip } from "./zip.js";

/** 去掉 // 与 /* *\/ 注释（字符串感知），便于宽松解析模组 JSON。 */
export function stripJsonComments(src) {
  let out = "";
  let i = 0;
  let inStr = false;
  let esc = false;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 宽松 JSON 解析：去注释、补缺失逗号、去尾随逗号后重试。 */
export function looseJson(src) {
  const clean = stripJsonComments(String(src));
  const candidates = [clean, fixMissingCommas(clean)];
  candidates.push(clean.replace(/,\s*([}\]])/g, "$1"));
  candidates.push(fixMissingCommas(clean).replace(/,\s*([}\]])/g, "$1"));
  let lastErr = null;
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error("JSON 解析失败：" + (lastErr ? lastErr.message : "未知错误"));
}

/** 在“值 后直接跟下一个 键/字符串”的位置补逗号（非法 JSON 容错）。 */
function fixMissingCommas(src) {
  return src.replace(
    /("(?:[^"\\]|\\.)*"|\}|\]|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?)(\s*)(?=")/g,
    (m, val, ws) => val + "," + ws
  );
}

/** 解析 requirements 数组，兼容 "item/amount" 与 {item,amount}。 */
export function parseRequirements(arr) {
  const out = [];
  if (!Array.isArray(arr)) return out;
  for (const r of arr) {
    if (typeof r === "string") {
      const idx = r.lastIndexOf("/");
      if (idx > 0) out.push([r.slice(0, idx).trim(), Number(r.slice(idx + 1)) || 0]);
    } else if (r && typeof r === "object" && r.item != null) {
      out.push([String(r.item), Number(r.amount) || 0]);
    }
  }
  return out;
}

/** 解析 .properties 文本（bundle）。 */
export function parseProperties(text) {
  const map = new Map();
  for (let line of String(text).split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    map.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return map;
}

function basename(path) {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * 模组方块贴图候选名：给定名；若以某个已加载模组名 + "-" 开头，再去前缀尝试。
 * 模组名长者优先（更具体的前缀先剥）。最后追加各候选名的 `<c>1` 变体，
 * 作为动画/序号帧贴图（如 `裂位能1.png`）的兜底。
 */
export function modSpriteCandidates(name, modNames) {
  const out = [name];
  const sorted = [...(modNames || [])].sort((a, b) => b.length - a.length);
  for (const m of sorted) {
    const p = m + "-";
    if (name.startsWith(p)) {
      const s = name.slice(p.length);
      if (s && !out.includes(s)) out.push(s);
    }
  }
  // 序号帧兜底：保持 plain 候选在前，单帧结果不受影响
  for (const c of out.slice()) {
    const f = c + "1";
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

/**
 * 模组物品图标候选名（按序）：`item-<name>` → `<name>` → `<name>1` → `item-<name>1`。
 * 后两者为序号帧贴图兜底（如 `裂位能1.png`、`二级协议1.png`）。
 */
export function modItemCandidates(name) {
  return [`item-${name}`, name, `${name}1`, `item-${name}1`];
}

/**
 * 构造懒解压贴图表：`size`/`has`/`keys` 基于中央目录条目（不解压），
 * `get(name)` 首次调用时才解压该条目并缓存为 Blob。
 * @param {object} zip openZip 结果
 * @param {Map<string,object>} entriesMap basename → zip entry（优先表）
 * @param {object} stats 解压计数 { reads }
 * @param {Map<string,object>[]} fallbackMaps 次级表（合并 keys；get 时兜底）
 */
function makeLazySpriteMap(zip, entriesMap, stats, fallbackMaps = []) {
  const keys = new Set(entriesMap.keys());
  for (const m of fallbackMaps) for (const k of m.keys()) keys.add(k);
  const cache = new Map();
  return {
    size: keys.size,
    has: (name) => keys.has(name),
    keys: () => keys.keys(),
    async get(name) {
      if (cache.has(name)) return cache.get(name);
      let entry = entriesMap.get(name);
      if (!entry) {
        for (const m of fallbackMaps) {
          if (m.has(name)) {
            entry = m.get(name);
            break;
          }
        }
      }
      if (!entry) {
        cache.set(name, null);
        return null;
      }
      stats.reads++;
      const bytes = await zip.read(entry);
      if (!bytes) {
        cache.set(name, null);
        return null;
      }
      const blob = new Blob([bytes]);
      cache.set(name, blob);
      return blob;
    },
  };
}

/**
 * 解析模组 zip。
 * @param {Uint8Array|ArrayBuffer|Blob} input
 * @param {string} fileName
 * @returns {Promise<{name,displayName,blocks:Map,sprites,spritesOverride,bundle:Map,fileName,spriteStats}>}
 *   blocks: Map(内部名/base → {base,size,name,requirements,type,range,bridgeWidth,
 *            hasPower,outlineIcon,outlineColor,outlineRadius,rotate,consumesPower,
 *            laserRange,laserScale,laserColor1,laserColor2,maxNodes})
 *   sprites: 懒解压贴图表（basename 索引，sprites-override 已覆盖）；
 *            `size`/`has`/`keys` 为条目数，`get(name)` 按需解压返回 Blob
 *   spritesOverride: 懒解压表（仅 sprites-override/**）
 *   spriteStats: { reads } 实际解压次数（测试/调试用）
 *   bundle: Map(key → value)
 */
export async function parseMod(input, fileName = "mod.zip") {
  const zip = await openZip(input);

  let name = String(fileName).replace(/\.(zip|jar)$/i, "");
  let displayName = name;
  const modEntry = zip.entries.find((e) => !e.isDir && /(^|\/)mod\.json$/i.test(e.name));
  if (modEntry) {
    try {
      const obj = looseJson(await zip.readText(modEntry));
      if (obj && obj.name) name = String(obj.name);
      displayName = obj && obj.displayName ? String(obj.displayName) : name;
    } catch (e) {
      // mod.json 损坏则用文件名
    }
  }

  // ---- 方块 ----
  const blocks = new Map();
  const blockEntries = zip.entries.filter(
    (e) => !e.isDir && /^content\/blocks\/.*\.json$/i.test(e.name)
  );
  for (const e of blockEntries) {
    let obj;
    try {
      obj = looseJson(await zip.readText(e));
    } catch (err) {
      continue;
    }
    const base = basename(e.name).replace(/\.json$/i, "");
    const def = {
      base,
      size: Number(obj.size) > 0 ? Number(obj.size) : 1,
      name: obj.name ? String(obj.name) : base,
      requirements: parseRequirements(obj.requirements),
      // 供桥/激光/描边分类使用的原字段（缺失记 undefined，不臆造）
      type: obj.type ? String(obj.type) : "Block",
      range: obj.range !== undefined ? Number(obj.range) : undefined,
      bridgeWidth: obj.bridgeWidth !== undefined ? Number(obj.bridgeWidth) : undefined,
      hasPower: obj.hasPower !== undefined ? !!obj.hasPower : undefined,
      outlineIcon: obj.outlineIcon !== undefined ? !!obj.outlineIcon : undefined,
      outlineColor: obj.outlineColor !== undefined ? String(obj.outlineColor) : undefined,
      outlineRadius: obj.outlineRadius !== undefined ? Number(obj.outlineRadius) : undefined,
      rotate: obj.rotate !== undefined ? !!obj.rotate : undefined,
      consumesPower: !!(obj.consumes && obj.consumes.power !== undefined),
      // 电力节点激光参数（缺失记 undefined）
      laserRange: obj.laserRange !== undefined ? Number(obj.laserRange) : undefined,
      laserScale: obj.laserScale !== undefined ? Number(obj.laserScale) : undefined,
      laserColor1: obj.laserColor1 !== undefined ? String(obj.laserColor1) : undefined,
      laserColor2: obj.laserColor2 !== undefined ? String(obj.laserColor2) : undefined,
      maxNodes: obj.maxNodes !== undefined ? Number(obj.maxNodes) : undefined,
    };
    const internal = name + "-" + base;
    blocks.set(internal, def);
    if (!blocks.has(base)) blocks.set(base, def);
  }

  // ---- 贴图：只登记中央目录条目，字节按需解压 ----
  const normalEntries = new Map();
  const overrideEntries = new Map();
  for (const e of zip.entries) {
    if (e.isDir || !/\.png$/i.test(e.name)) continue;
    const key = basename(e.name).replace(/\.png$/i, "");
    if (e.name.startsWith("sprites-override/")) overrideEntries.set(key, e);
    else if (e.name.startsWith("sprites/")) normalEntries.set(key, e);
  }
  const spriteStats = { reads: 0 };
  const spritesOverride = makeLazySpriteMap(zip, overrideEntries, spriteStats);
  // 合并视图：override 覆盖 normal
  const sprites = makeLazySpriteMap(zip, overrideEntries, spriteStats, [normalEntries]);

  // ---- bundle（zh_CN 最后读入以覆盖默认）----
  const bundle = new Map();
  const bundleEntries = zip.entries
    .filter((e) => !e.isDir && /^bundles\/.*\.properties$/i.test(e.name))
    .sort((a, b) => (a.name.includes("zh_CN") ? 1 : 0) - (b.name.includes("zh_CN") ? 1 : 0));
  for (const e of bundleEntries) {
    try {
      const text = await zip.readText(e);
      if (!text) continue;
      for (const [k, v] of parseProperties(text)) bundle.set(k, v);
    } catch (err) {
      // 忽略损坏的 bundle
    }
  }

  return { name, displayName, blocks, sprites, spritesOverride, bundle, fileName, spriteStats };
}
