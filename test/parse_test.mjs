// =============================================================================
// test/parse_test.mjs —— 解析器一致性测试（与 Python 参考 蓝图.json 逐字段比对）
//                      + 渲染器关键算法单测
//
// 运行：node test/parse_test.mjs
// 依赖：Node 18+（DecompressionStream / atob 内置），无需安装任何依赖。
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseSchematic, extractLogic, isProcessor } from "../js/parser.js";
import {
  computeLayout,
  tileFootprint,
  dilateAlpha,
  bridgePairs,
  bridgeWidthOf,
  bridgeRangeOf,
  drawBeam,
  renderSchematic,
  drawGrid,
  makePlaceholder,
  isBridgeType,
  isMassDriverType,
  isPowerNodeType,
  setModBridges,
  setModOutline,
  setModPowerBlocks,
  setModPowerNodes,
  nodeLaserOpts,
} from "../js/render.js";
import { blockDisplayName, modNameCandidates } from "../js/names.js";
import { LAYERS, OUTLINE_ICON, TILE, CONTENT_CN } from "../js/data.js";
import { setIconIndex, resolveIcon, richText, plainTextWithIcons, itemIconSrc, ICON_FONT_LO } from "../js/icons.js";
import { ICON_BY_CODE, ICON_LOCAL_CODES } from "../js/icons_data.js";
import { simpleHash, createPrefetchManager } from "../js/prefetch.js";
import { computeRequirements, requirementsList } from "../js/requirements.js";
import { BLOCK_REQUIREMENTS } from "../js/requirements_data.js";
import { openZip } from "../js/zip.js";
import { parseMod, modSpriteCandidates, modItemCandidates, looseJson, parseRequirements } from "../js/mod.js";
import { CN_BLOCKS } from "../js/cn_data.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const IN_TXT = "/storage/emulated/0/蓝图.txt";
const IN_JSON = "/storage/emulated/0/蓝图.json";

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(`${name}${detail ? " —— " + detail : ""}`);
    console.error(`  ✗ ${name}${detail ? " —— " + detail : ""}`);
  }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// -----------------------------------------------------------------------------
// 1. 容器 / 头部 / 标签 / 字典
// -----------------------------------------------------------------------------
async function testParse() {
  console.log("== 解析器一致性测试 ==");
  const text = fs.readFileSync(IN_TXT, "utf8");
  const expected = JSON.parse(fs.readFileSync(IN_JSON, "utf8"));
  const schem = await parseSchematic(text);

  check("version", schem.version === expected.version, `${schem.version} vs ${expected.version}`);
  check("width", schem.width === expected.width, `${schem.width} vs ${expected.width}`);
  check("height", schem.height === expected.height, `${schem.height} vs ${expected.height}`);
  check("total", schem.total === expected.total, `${schem.total} vs ${expected.total}`);
  check("block_dict", deepEqual(schem.block_dict, expected.block_dict), JSON.stringify(schem.block_dict));
  check("content_map", deepEqual(schem.content_map, expected.content_map), JSON.stringify(schem.content_map));
  check("tags", deepEqual(schem.tags, expected.tags), JSON.stringify(schem.tags));
  check("大小写 tags.contentMap", schem.tags.contentMap === expected.tags.contentMap);

  check("tile 数量", schem.tiles.length === expected.tiles.length, `${schem.tiles.length} vs ${expected.tiles.length}`);

  let tileOk = 0;
  const n = Math.min(schem.tiles.length, expected.tiles.length);
  for (let i = 0; i < n; i++) {
    const got = schem.tiles[i];
    const exp = expected.tiles[i];
    const base =
      got.block === exp.block &&
      got.x === exp.x &&
      got.y === exp.y &&
      got.rot === exp.rot &&
      got.config_type === exp.config_type;
    if (!base) {
      check(`tile[${i}] 基本字段`, false, `got=${JSON.stringify({ b: got.block, x: got.x, y: got.y, rot: got.rot, ct: got.config_type })} exp=${JSON.stringify({ b: exp.block, x: exp.x, y: exp.y, rot: exp.rot, ct: exp.config_type })}`);
      continue;
    }
    let cfgOk = false;
    if (exp.config_type === "byteArray") {
      cfgOk = got.config instanceof Uint8Array && got.config.length === exp.config._bytes;
      if (!cfgOk) check(`tile[${i}] byteArray 长度`, false, `${got.config && got.config.length} vs ${exp.config._bytes}`);
    } else if (exp.config_type === "point2Array") {
      cfgOk = deepEqual(got.config, exp.config);
      if (!cfgOk) check(`tile[${i}] point2Array`, false, `${JSON.stringify(got.config)} vs ${JSON.stringify(exp.config)}`);
    } else {
      cfgOk = deepEqual(got.config, exp.config);
      if (!cfgOk) check(`tile[${i}] config`, false, `${JSON.stringify(got.config)} vs ${JSON.stringify(exp.config)}`);
    }
    if (base && cfgOk) tileOk++;
  }
  check(`全部 ${n} 个 tile 的 block/x/y/rot/config 比对`, tileOk === n, `通过 ${tileOk}/${n}`);

  // ---- 处理器逻辑提取 ----
  const procExp = expected.tiles.find((t) => isProcessor(t.block));
  const procGot = schem.tiles.find((t) => isProcessor(t.block));
  check("存在处理器", !!procGot && !!procExp);
  if (procGot && procExp) {
    const logic = await extractLogic(procGot.config);
    check("处理器 logic 非空", !!logic);
    if (logic) {
      check("处理器 code", logic.code === procExp.logic.code, `len ${logic.code.length} vs ${procExp.logic.code.length}`);
      check("处理器 links", deepEqual(logic.links, procExp.logic.links), JSON.stringify(logic.links));
      check("处理器 version", logic.version === procExp.logic.version);
    }
  }
}

// -----------------------------------------------------------------------------
// 2. 渲染器关键算法单测
// -----------------------------------------------------------------------------
function spriteFromColor(w, h, r, g, b, a) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = a;
  }
  return { w, h, size: Math.max(1, Math.floor(w / TILE)), rgba, placeholder: false };
}

function testRenderUnits() {
  console.log("== 渲染器算法单测 ==");

  // (a) footprint / 中心坐标
  const [lx, by] = tileFootprint(4, 6, 3);
  check("footprint(size=3 @4,6) = (3,5)", lx === 3 && by === 5, `${lx},${by}`);
  const [lx1, by1] = tileFootprint(8, 0, 1);
  check("footprint(size=1 @8,0) = (8,0)", lx1 === 8 && by1 === 0, `${lx1},${by1}`);
  const [lx4, by4] = tileFootprint(1, 2, 4);
  check("footprint(size=4 @1,2) = (0,1)", lx4 === 0 && by4 === 1, `${lx4},${by4}`);

  // (b) 多层合成：LAYERS 表
  check("LAYERS battery", deepEqual(LAYERS.battery, ["battery", "battery-top"]));
  check("LAYERS mass-driver", deepEqual(LAYERS["mass-driver"], ["mass-driver-base", "mass-driver"]));
  check("LAYERS liquid-tank", deepEqual(LAYERS["liquid-tank"], ["liquid-tank-bottom", "liquid-tank"]));

  // (b2) 多层叠加：底红 + 顶蓝(alpha=128) → 中心 = src-over 混合
  const schemLayer = {
    width: 1,
    height: 1,
    tiles: [{ block: "battery", x: 0, y: 0, rot: 0, config_type: "null", config: null }],
  };
  const bottom = spriteFromColor(TILE, TILE, 200, 0, 0, 255);
  const top = spriteFromColor(TILE, TILE, 0, 0, 200, 128);
  const rLayers = renderSchematic(
    schemLayer,
    { battery: bottom, "battery-top": top },
    { scale: 1, pad: 0, transparent: true, layers: true }
  );
  const c = ((TILE / 2) * rLayers.width + TILE / 2) * 4;
  check(
    "多层叠加 src-over 混合",
    rLayers.rgba[c] === 99 && rLayers.rgba[c + 1] === 0 && rLayers.rgba[c + 2] === 100 && rLayers.rgba[c + 3] === 255,
    `rgba=(${rLayers.rgba[c]},${rLayers.rgba[c + 1]},${rLayers.rgba[c + 2]},${rLayers.rgba[c + 3]})`
  );
  const rSingle = renderSchematic(
    schemLayer,
    { battery: bottom, "battery-top": top },
    { scale: 1, pad: 0, transparent: true, layers: false }
  );
  check(
    "layers=false 时只画底图",
    rSingle.rgba[c] === 200 && rSingle.rgba[c + 2] === 0,
    `rgba=(${rSingle.rgba[c]},${rSingle.rgba[c + 2]})`
  );

  // (c) 描边膨胀：单点 alpha=255，半径 1 → 3×3 全部被覆盖
  const w = 5;
  const h = 5;
  const alpha = new Int32Array(w * h);
  alpha[2 * w + 2] = 255;
  const dil = dilateAlpha(alpha, w, h, 1);
  let expanded = 0;
  for (let i = 0; i < w * h; i++) if (dil[i] > 0) expanded++;
  check("dilate radius1 单点→3×3", expanded === 9, `expanded=${expanded}`);

  // (d) flat-top 光束采样：水平 6px 光束，中心行 alpha=255，最外圈 <255
  const cw = 64;
  const ch = 64;
  const buf = new Uint8ClampedArray(cw * ch * 4);
  // 32×32 不透明青色贴图（横向剖面全不透明，模拟桥贴图）
  const tex = spriteFromColor(32, 32, 255, 255, 255, 255);
  tex.rgba[0 * 32 * 4 + 3] = 255; // ensure
  drawBeam(buf, cw, ch, 8, 32, 56, 32, tex.rgba, tex.w, tex.h, 6, [255, 255, 255], 1.0);
  const centerAlpha = buf[(32 * cw + 32) * 4 + 3];
  check("光束中心 alpha=255", centerAlpha === 255, `a=${centerAlpha}`);
  // y=32±2 仍在 half-0.5=2.5 内 → 不透明；y=32±3 为最外圈渐隐 <255
  const aEdge = buf[((32 + 3) * cw + 32) * 4 + 3];
  check("光束最外圈渐隐(<255)", aEdge > 0 && aEdge < 255, `a=${aEdge}`);
  const aOutside = buf[((32 + 6) * cw + 32) * 4 + 3];
  check("光束外无像素", aOutside === 0, `a=${aOutside}`);

  // (e) 桥配对：示例蓝图应得 (5,2)-(5,6) 与 (7,2)-(7,6)
  //     用 蓝图.json 的 size 构造占位贴图（无需真实 PNG）
  const { bridgeLayouts } = testBridgePairs();
  check("桥配对数 = 2", bridgeLayouts.length === 2, `${bridgeLayouts.length}`);
  const norm = bridgeLayouts
    .map(([a, b]) => {
      const p = [a.tile.x, a.tile.y];
      const q = [b.tile.x, b.tile.y];
      return [p, q].sort((m, n2) => m[0] - n2[0] || m[1] - n2[1]);
    })
    .map((p) => `${p[0][0]},${p[0][1]}-${p[1][0]},${p[1][1]}`)
    .sort();
  check(
    "桥配对为 (5,2)-(5,6) 与 (7,2)-(7,6)",
    deepEqual(norm, ["5,2-5,6", "7,2-7,6"]),
    JSON.stringify(norm)
  );

  // (f) computeLayout：尺寸与中心
  const sizes = {};
  for (const t of globalThis.__EXP_TILES) sizes[t.block] = t.size;
  const sprites = {};
  for (const [name, size] of Object.entries(sizes)) {
    sprites[name] = { w: size * TILE, h: size * TILE, size, rgba: new Uint8ClampedArray(size * TILE * size * TILE * 4), placeholder: false };
  }
  const layout = computeLayout(globalThis.__SCHEM, sprites);
  // mass-driver @6,4 size3 → lx=5, by=3（应落在布局内）
  const md = layout.entries.find((e) => e.tile.block === "mass-driver");
  check("layout mass-driver lx/by", md.lx === 5 && md.by === 3, `${md.lx},${md.by}`);
  check("layout cols", layout.cols === layout.max_right - layout.min_lx);
  check("layout rows", layout.rows === layout.max_top - layout.min_by);

  // (f2) 坐标位序回归：所有方块锚点必须落在声明的宽高范围内。
  // arc Point2.pack 为 x 高 16 位 / y 低 16 位，若位序写反会导致坐标整体越界。
  const oob = globalThis.__SCHEM.tiles.filter(
    (t) => t.x < 0 || t.y < 0 || t.x >= globalThis.__SCHEM.width || t.y >= globalThis.__SCHEM.height
  );
  check(
    "所有方块坐标在声明范围内",
    oob.length === 0,
    oob.slice(0, 5).map((t) => `${t.block}(${t.x},${t.y})`).join(" ")
  );

  // (g) 网格：应该出现淡白线
  const gbuf = new Uint8ClampedArray(64 * 32 * 4);
  drawGrid(gbuf, 64, 32);
  check("网格线 alpha=22", gbuf[3] === 22, `a=${gbuf[3]}`);
  check("网格非第一列普通像素 alpha=0", gbuf[(1 * 64 + 1) * 4 + 3] === 0);

  // (h) 完整渲染不崩溃且尺寸正确
  const res = renderSchematic(globalThis.__SCHEM, sprites, { scale: 2, pad: 16, transparent: false, grid: false });
  check(
    "渲染尺寸 = (cols*32+32)*2",
    res.width === (layout.cols * TILE + 32) * 2 && res.height === (layout.rows * TILE + 32) * 2,
    `${res.width}×${res.height}`
  );
  check("渲染缓冲长度一致", res.rgba.length === res.width * res.height * 4);
}

// -----------------------------------------------------------------------------
// 透明度参数（电线 laserAlpha / 桥 bridgeOpacity）
// -----------------------------------------------------------------------------
function testOpacity() {
  console.log("== 透明度参数测试 ==");
  const W = TILE;
  const base = new Uint8ClampedArray(W * W * 4).fill(255);
  const mk = () => ({ w: W, h: W, size: 1, rgba: new Uint8ClampedArray(base), placeholder: false });
  const sprites = {
    "power-node": mk(),
    battery: mk(),
    "bridge-conduit": mk(),
    laser: mk(),
    "laser-end": mk(),
    "bridge-conduit-bridge": mk(),
    "bridge-conduit-arrow": mk(),
  };
  const schem = {
    width: 5,
    height: 3,
    tiles: [
      { block: "power-node", x: 0, y: 0, rot: 0, config_type: "point2Array", config: [[2, 0]] },
      { block: "battery", x: 2, y: 0, rot: 0, config_type: "null", config: null },
      { block: "bridge-conduit", x: 0, y: 2, rot: 0, config_type: "null", config: null },
      { block: "bridge-conduit", x: 4, y: 2, rot: 0, config_type: "null", config: null },
    ],
  };
  const opt = (o) => renderSchematic(schem, sprites, Object.assign({ scale: 1, pad: 0, transparent: true, grid: false }, o));
  const cw = 5 * TILE; // 160

  // 电线：power-node(0,0) → battery(2,0)，同 y=0 → 内容 py=64，中心 y=80
  const rL1 = opt({ laserAlpha: 1, bridgeOpacity: 0.5 });
  const rL0 = opt({ laserAlpha: 0, bridgeOpacity: 0.5 });
  const lx = (80 * cw + 48) * 4;
  check(
    "laserAlpha=1 光束可见 / =0 不可见",
    rL1.rgba[lx] > 200 && rL0.rgba[lx + 3] === 0,
    `r1=${rL1.rgba[lx]} a0=${rL0.rgba[lx + 3]}`
  );

  // 桥：bridge-conduit(0,2)-(4,2)，同 y=2 → 内容 py=0，中心 y=16
  const rB1 = opt({ laserAlpha: 1, bridgeOpacity: 1 });
  const rB02 = opt({ laserAlpha: 1, bridgeOpacity: 0.2 });
  const bx = (16 * cw + 80) * 4;
  // 注：内容层最终 alpha 会被 padAndScale 置为 255，透明度体现在 RGB 亮度
  check(
    "bridgeOpacity=1 与 0.2 桥带差异显著",
    rB1.rgba[bx] > 200 && rB02.rgba[bx] > 0 && rB1.rgba[bx] - rB02.rgba[bx] > 100,
    `r1=${rB1.rgba[bx]} r02=${rB02.rgba[bx]}`
  );

  // 回归：不传参 = 显式常量默认值（laserAlpha=1, bridgeOpacity=0.5）
  const rDefault = opt({});
  const rExplicit = opt({ laserAlpha: 1, bridgeOpacity: 0.5 });
  let same = rDefault.rgba.length === rExplicit.rgba.length;
  if (same) {
    for (let i = 0; i < rDefault.rgba.length; i++) {
      if (rDefault.rgba[i] !== rExplicit.rgba[i]) {
        same = false;
        break;
      }
    }
  }
  check("不传参 = 传入常量默认值（回归）", same);
}

function testBridgePairs() {
  const schem = globalThis.__SCHEM;
  // 用 size=1 的占位贴图构造布局，仅验证配对逻辑
  const sprites = {};
  for (const t of schem.tiles) sprites[t.block] = makePlaceholder(1);
  const layout = computeLayout(schem, sprites);
  return { bridgeLayouts: bridgePairs(layout.entries) };
}

// -----------------------------------------------------------------------------
// 3. PUA 图标解析 / richText 单测
// -----------------------------------------------------------------------------
function testIcons() {
  console.log("== PUA 图标测试 ==");
  const index = JSON.parse(fs.readFileSync(path.join(__dirname, "../sprite_index.json"), "utf8"));
  check("sprite_index 含 all 字段", !!index.all && Object.keys(index.all).length > 2000, `all=${index.all ? Object.keys(index.all).length : 0}`);
  check("blocks/items 保留", Object.keys(index.blocks).length > 1000 && Object.keys(index.items).length > 10);
  setIconIndex(index);

  // 解析锚点
  const w = resolveIcon(63528);
  check(
    "resolveIcon(63528) = water/liquid-water",
    !!w && w.name === "water" && w.region === "liquid-water-ui" && w.spritePath === "sprites/items/liquid-water.png",
    JSON.stringify(w)
  );
  const g = resolveIcon(63465);
  check(
    "resolveIcon(63465) = gamma",
    !!g && g.spritePath === "sprites/units/gamma.png",
    JSON.stringify(g)
  );
  const a = resolveIcon(63084);
  check(
    "resolveIcon(63084) = advanced-launch-pad",
    !!a && a.spritePath === "sprites/blocks/campaign/advanced-launch-pad.png",
    JSON.stringify(a)
  );
  check("resolveIcon(999999) = null", resolveIcon(999999) === null);

  // richText —— 本地原版图标优先
  const rt = richText(String.fromCharCode(63528));
  check("richText(63528) 用本地图标", rt.includes('src="assets/icons/63528.png"'), rt);
  check("richText(63528) 含 img 且 data-fb 指原贴图", rt.includes('class="msch-icon"') && rt.includes("liquid-water"), rt);
  check("richText(63528) 含中文 alt 水", rt.includes('alt="水"'), rt);
  check("richText(63465) 本地图标", richText(String.fromCharCode(63465)).includes('src="assets/icons/63465.png"'));
  check("richText(63084) 本地图标", richText(String.fromCharCode(63084)).includes('src="assets/icons/63084.png"'));

  // 非本地码点：走 raw-sprite 逻辑
  check("ICON_LOCAL_CODES 共 530 个", ICON_LOCAL_CODES.size === 530, `size=${ICON_LOCAL_CODES.size}`);
  check("本地图标文件存在", fs.existsSync(path.join(__dirname, "../assets/icons/63528.png")));
  let rawCode = null;
  for (const code of Object.keys(ICON_BY_CODE)) {
    const c = Number(code);
    if (ICON_LOCAL_CODES.has(c)) continue;
    const ic = resolveIcon(c);
    if (ic && ic.spritePath) {
      rawCode = c;
      break;
    }
  }
  check("存在走 raw-sprite 的非本地码点", rawCode !== null, `rawCode=${rawCode}`);
  if (rawCode !== null) {
    const rawHtml = richText(String.fromCharCode(rawCode));
    check(`richText(${rawCode}) 走 raw-sprite`, rawHtml.includes("assets/sprites/") && !rawHtml.includes("assets/icons/"), rawHtml);
  }

  const emoji = String.fromCharCode(59394); // 0xE802
  check("richText(emoji) 保留原字符", richText(emoji) === emoji, richText(emoji));
  check("richText 普通中文不受影响", richText("接收台 ABC 123") === "接收台 ABC 123");
  check("richText 转义 HTML", richText("<b>&\"") === "&lt;b&gt;&amp;&quot;", richText('<b>&"'));

  // plainTextWithIcons
  check("plainTextWithIcons(63528) → [水]", plainTextWithIcons(String.fromCharCode(63528)) === "[水]");
  check("plainTextWithIcons(emoji) → 去掉", plainTextWithIcons("A" + emoji + "B") === "AB");
  check("plainTextWithIcons 普通文本原样", plainTextWithIcons("接收台") === "接收台");

  // 集成：示例信息板原文里的 U+F828 应渲染成本地水图标
  const msg = globalThis.__SCHEM.tiles.find((t) => t.block === "message");
  const hasWaterChar = msg && msg.config && msg.config.includes(String.fromCharCode(63528));
  check("示例信息板含 U+F828(水)", !!hasWaterChar);
  if (hasWaterChar) {
    const html = richText(msg.config);
    check("信息板 richText 含水图标", html.includes("msch-icon") && html.includes("assets/icons/63528.png"));
  }

  // 耗材图标：物品名 → 与文本图标同一套的本地原版图标
  check("itemIconSrc(copper) = assets/icons/63544.png", itemIconSrc("copper") === "assets/icons/63544.png", String(itemIconSrc("copper")));
  check("itemIconSrc(titanium) = assets/icons/63538.png", itemIconSrc("titanium") === "assets/icons/63538.png", String(itemIconSrc("titanium")));
  check("itemIconSrc(surge-alloy) = assets/icons/63532.png", itemIconSrc("surge-alloy") === "assets/icons/63532.png", String(itemIconSrc("surge-alloy")));
  check("itemIconSrc(未知物品) = null", itemIconSrc("not-an-item") === null);
  check("耗材物品全部有原版图标", ["copper","titanium","graphite","lead","metaglass","silicon","thorium"].every((it) => itemIconSrc(it)), "缺: " + ["copper","titanium","graphite","lead","metaglass","silicon","thorium"].filter((it) => !itemIconSrc(it)));
}

// -----------------------------------------------------------------------------
// 4. 预加载管理器（hash 复用 / 竞态保护）单测
// -----------------------------------------------------------------------------
async function testPrefetch() {
  console.log("== 预加载管理器测试 ==");

  // hash 确定性 & 字符串/字节一致
  check("simpleHash 确定性", simpleHash("abc") === simpleHash("abc"));
  check("simpleHash 区分输入", simpleHash("abc") !== simpleHash("abd"));
  check(
    "simpleHash 字符串=同内容字节",
    simpleHash("abc") === simpleHash(new Uint8Array([97, 98, 99]))
  );

  // 复用：同输入只 parse 一次、load 一次
  let parseCount = 0;
  let loadCount = 0;
  const mgr = createPrefetchManager(
    async (i) => {
      parseCount++;
      return { name: i };
    },
    async () => {
      loadCount++;
    }
  );
  const r1 = await mgr.ensure("same");
  await r1.promise;
  const r2 = await mgr.ensure("same");
  await r2.promise;
  check("复用 schem 且只 parse 一次", parseCount === 1, `parseCount=${parseCount}`);
  check("复用 schem 且只 load 一次", loadCount === 1, `loadCount=${loadCount}`);
  check("复用标记 reused=true", r2.reused === true);
  check("复用完成标记 done=true", r2.done === true);
  check("复用返回同一 schem 对象", r2.schem === r1.schem);

  // 竞态：A 尚未解析完就发起 B，A 结果应被丢弃，load 只为 B 调用
  const calls = { load: [] };
  const resolvers = {};
  const mgr2 = createPrefetchManager(
    (input) => new Promise((res) => (resolvers[input] = res)),
    async (schem) => {
      calls.load.push(schem.name);
    }
  );
  const pA = mgr2.ensure("A");
  const pB = mgr2.ensure("B");
  resolvers["A"]({ name: "A" });
  resolvers["B"]({ name: "B" });
  const [rA, rB] = await Promise.all([pA, pB]);
  await rB.promise;
  check("旧输入 A 返回 race=true", rA.race === true && rA.schem === null, JSON.stringify(rA && { race: rA.race }));
  check("新输入 B 正常解析", !!rB.schem && rB.schem.name === "B");
  check("load 只为最新输入 B 调用", calls.load.length === 1 && calls.load[0] === "B", JSON.stringify(calls.load));
  check("current 指向最新 B", mgr2.current.key === simpleHash("B"));
}

// -----------------------------------------------------------------------------
// 5. 蓝图总耗材计算单测
// -----------------------------------------------------------------------------
function testRequirements() {
  console.log("== 耗材计算测试 ==");
  const tiles = globalThis.__SCHEM.tiles;
  const totals = computeRequirements(tiles);
  const expected = {
    copper: 902,
    titanium: 560,
    graphite: 453,
    lead: 207,
    metaglass: 136,
    silicon: 128,
    thorium: 50,
  };
  check(
    "耗材物品种类数",
    totals.size === Object.keys(expected).length,
    `got=${JSON.stringify(Object.fromEntries(totals))}`
  );
  for (const [item, n] of Object.entries(expected)) {
    check(`耗材 ${item} = ${n}`, totals.get(item) === n, `got=${totals.get(item)}`);
  }
  const list = requirementsList(tiles);
  check("耗材按数量降序", list.length > 0 && list.every((e, i) => i === 0 || list[i - 1].count >= e.count), list.map((e) => `${e.item}:${e.count}`).join(","));
  check("耗材中文名（titanium→钛）", list.some((e) => e.item === "titanium" && e.name === "钛"));
  check("无数据方块被跳过", computeRequirements([{ block: "liquid-source" }, { block: "not-a-block" }]).size === 0);
}

// -----------------------------------------------------------------------------
// 6. 模组支持（zip 读取 / 解析 / 需求 / 纯逻辑）
// -----------------------------------------------------------------------------
const MOD_DIR = "/data/data/com.termux/files/usr/tmp/opencode";
const MOD_67 = path.join(MOD_DIR, "mod_67kj.zip");
const MOD_BH = path.join(MOD_DIR, "mod_baohuo.zip");

async function testMods() {
  console.log("== 模组测试 ==");
  const has67 = fs.existsSync(MOD_67);
  const hasBH = fs.existsSync(MOD_BH);

  // 纯逻辑部分：即使 zip 缺失也应运行
  check("stripComments/looseJson 宽松解析", (() => {
    const o = looseJson('{\n // 注释\n "name":"x", "size":2 }\n');
    return o.name === "x" && o.size === 2;
  })());
  check("parseRequirements 两种格式", (() => {
    const r = parseRequirements(["copper/5", { item: "lead", amount: 5 }]);
    return r.length === 2 && r[0][0] === "copper" && r[0][1] === 5 && r[1][0] === "lead" && r[1][1] === 5;
  })());
  check(
    "modSpriteCandidates 去模组前缀",
    JSON.stringify(modSpriteCandidates("饱和火力-前沿实验室", ["饱和火力"]).slice(0, 2)) ===
      JSON.stringify(["饱和火力-前沿实验室", "前沿实验室"]),
    JSON.stringify(modSpriteCandidates("饱和火力-前沿实验室", ["饱和火力"]))
  );
  check(
    "computeRequirements 合并模组条目",
    (() => {
      const t = { "饱和火力-拓断": [["copper", 10]] };
      return computeRequirements([{ block: "饱和火力-拓断" }], t).get("copper") === 10;
    })()
  );

  if (!has67 && !hasBH) {
    console.log("  SKIP：未找到模组 zip（" + MOD_DIR + "）");
    return;
  }

  // ---- zip 读取 ----
  if (has67) {
    const z = await openZip(fs.readFileSync(MOD_67));
    check("67科技 zip 条目 >100", z.entries.length > 100, `entries=${z.entries.length}`);
  }
  if (hasBH) {
    const z = await openZip(fs.readFileSync(MOD_BH));
    check("饱和火力 zip 条目 >2500", z.entries.length > 2500, `entries=${z.entries.length}`);
  }

  // ---- 67科技 ----
  if (has67) {
    const m = await parseMod(fs.readFileSync(MOD_67), "mod_67kj.zip");
    check("67科技 name=无限", m.name === "无限", `name=${m.name}`);
    check("67科技 blocks=31", modBlockCount(m) === 31, `blocks=${modBlockCount(m)}`);
    check("67科技 sprites=122", m.sprites.size === 122, `sprites=${m.sprites.size}`);
    check(
      "67科技 无桥（type 无 Bridge）",
      [...m.blocks.values()].every((d) => !isBridgeType(d.type)),
      [...new Set([...m.blocks.values()].map((d) => d.type))].join(",")
    );
    check(
      "67科技 无 PowerNode",
      [...m.blocks.values()].every((d) => !isPowerNodeType(d.type))
    );
    // 懒解压：解析阶段不读贴图字节，首次 get 才解压且缓存
    check("67科技 懒加载：解析后未解压贴图", m.spriteStats.reads === 0, `reads=${m.spriteStats.reads}`);
    const k67 = [...m.sprites.keys()][0];
    const b67a = await m.sprites.get(k67);
    const b67b = await m.sprites.get(k67);
    check(
      "67科技 懒加载：按需解压一次并缓存",
      m.spriteStats.reads === 1 && !!b67a && b67a === b67b,
      `reads=${m.spriteStats.reads}`
    );
    const pump = m.blocks.get("无限-便携式抽水机");
    check("67科技 便携式抽水机存在", !!pump);
    if (pump) {
      check(
        "67科技 便携式抽水机需求 = copper5/lead5/graphite5",
        JSON.stringify(pump.requirements) === JSON.stringify([["copper", 5], ["lead", 5], ["graphite", 5]]),
        JSON.stringify(pump.requirements)
      );
    }
    // 显示名：67科技无 bundle → 回退 JSON name
    check(
      "显示名 67：无 bundle 回退 JSON name",
      blockDisplayName("无限-便携式抽水机", [m]) === "便携式抽水机",
      blockDisplayName("无限-便携式抽水机", [m])
    );
  }

  // ---- 饱和火力 ----
  if (hasBH) {
    const m = await parseMod(fs.readFileSync(MOD_BH), "mod_baohuo.zip");
    check("饱和火力 name=饱和火力", m.name === "饱和火力", `name=${m.name}`);
    check("饱和火力 blocks=303", modBlockCount(m) === 303, `blocks=${modBlockCount(m)}`);
    check("饱和火力 sprites≥2000（含 override）", m.sprites.size >= 2000, `sprites=${m.sprites.size}`);
    check("饱和火力 spritesOverride 条目=12", m.spritesOverride.size === 12, `override=${m.spritesOverride.size}`);
    // 懒解压：解析阶段不读贴图字节
    check("饱和火力 懒加载：解析后未解压贴图", m.spriteStats.reads === 0, `reads=${m.spriteStats.reads}`);
    const kbh = [...m.sprites.keys()][0];
    const bha = await m.sprites.get(kbh);
    const bhb = await m.sprites.get(kbh);
    check(
      "饱和火力 懒加载：按需解压一次并缓存",
      m.spriteStats.reads === 1 && !!bha && bha === bhb,
      `reads=${m.spriteStats.reads}`
    );
    check(
      "饱和火力 bundle 有 block.饱和火力-前沿实验室.name",
      m.bundle.get("block.饱和火力-前沿实验室.name") === "前沿实验室",
      m.bundle.get("block.饱和火力-前沿实验室.name")
    );
    for (const it of ["硅钢", "纳米核", "一级协议"]) {
      check(`饱和火力 bundle item.饱和火力-${it}.name`, !!m.bundle.get(`item.饱和火力-${it}.name`), m.bundle.get(`item.饱和火力-${it}.name`));
    }
    const lab = m.blocks.get("饱和火力-前沿实验室");
    check("饱和火力 前沿实验室存在", !!lab);
    if (lab) {
      check("饱和火力 前沿实验室 size=3", lab.size === 3, `size=${lab.size}`);
      check(
        "饱和火力 前沿实验室需求匹配",
        JSON.stringify(lab.requirements) ===
          JSON.stringify([["lead", 220], ["thorium", 180], ["硅钢", 150], ["纳米核", 80], ["一级协议", 5]]),
        JSON.stringify(lab.requirements)
      );
      // 合并后的总耗材表应包含模组条目
      const merged = Object.assign({}, BLOCK_REQUIREMENTS, { "饱和火力-前沿实验室": lab.requirements });
      const total = computeRequirements([{ block: "饱和火力-前沿实验室" }], merged);
      check("模组耗材合并到总表 lead=220", total.get("lead") === 220, `lead=${total.get("lead")}`);
      check("模组耗材合并到总表 硅钢=150", total.get("硅钢") === 150, `硅钢=${total.get("硅钢")}`);
    }

    // ---- 按 type 分类（桥 / 质驱）----
    const tower = m.blocks.get("饱和火力-裂位传送塔");
    const conduit = m.blocks.get("饱和火力-裂位导管塔");
    const driver = m.blocks.get("饱和火力-裂位驱动器");
    check("裂位传送塔 type=ItemBridge", !!tower && tower.type === "ItemBridge" && isBridgeType(tower.type), tower && tower.type);
    check("裂位传送塔 range=36 / bridgeWidth=8", !!tower && tower.range === 36 && tower.bridgeWidth === 8, tower && `${tower.range}/${tower.bridgeWidth}`);
    check("裂位导管塔 type=LiquidBridge", !!conduit && conduit.type === "LiquidBridge" && isBridgeType(conduit.type), conduit && conduit.type);
    check("裂位驱动器 type=MassDriver / size=4", !!driver && driver.type === "MassDriver" && driver.size === 4 && isMassDriverType(driver.type), driver && `${driver.type}/${driver.size}`);
    check("裂位驱动器 range=800", !!driver && driver.range === 800, driver && driver.range);

    // ---- 运行时注册：桥配对 range 生效 ----
    const mkE = (x, y) => ({
      tile: { block: "饱和火力-裂位传送塔", x, y, rot: 0, config_type: "null", config: null },
      size: 1,
      px: x * TILE,
      py: 0,
    });
    setModBridges(new Map([["饱和火力-裂位传送塔", { range: tower.range, width: tower.bridgeWidth }]]));
    check("注册后：相距 30 格配对成功（range 36）", bridgePairs([mkE(0, 0), mkE(30, 0)]).length === 1, `pairs=${bridgePairs([mkE(0, 0), mkE(30, 0)]).length}`);
    check("注册后：相距 40 格不配对", bridgePairs([mkE(0, 0), mkE(40, 0)]).length === 0, `pairs=${bridgePairs([mkE(0, 0), mkE(40, 0)]).length}`);
    check("模组桥带宽度与原版一致 = 24", bridgeWidthOf("饱和火力-裂位传送塔") === 24, `w=${bridgeWidthOf("饱和火力-裂位传送塔")}`);
    setModBridges(new Map());

    // ---- 运行时注册：模组质驱描边 ----
    const w = TILE;
    const ring = new Uint8ClampedArray(w * w * 4);
    for (let y = 12; y < 20; y++) {
      for (let x = 12; x < 20; x++) {
        const o = (y * w + x) * 4;
        ring[o] = 255;
        ring[o + 1] = 255;
        ring[o + 2] = 255;
        ring[o + 3] = 255;
      }
    }
    const sprites = { "饱和火力-裂位驱动器": { w, h: w, size: 1, rgba: ring, placeholder: false } };
    const schem = {
      width: 1,
      height: 1,
      tiles: [{ block: "饱和火力-裂位驱动器", x: 0, y: 0, rot: 0, config_type: "null", config: null }],
    };
    setModOutline(new Map([["饱和火力-裂位驱动器", [[0x40, 0x40, 0x49], 4]]]));
    const rOut = renderSchematic(schem, sprites, { scale: 1, pad: 0, transparent: true, grid: false });
    setModOutline(new Map());
    const rNo = renderSchematic(schem, sprites, { scale: 1, pad: 0, transparent: true, grid: false });
    const px = (16 * TILE + 8) * 4;
    check(
      "模组质驱套用描边（环上有色、未注册则透明）",
      rOut.rgba[px + 3] > 0 && rNo.rgba[px + 3] === 0,
      `outline=${rOut.rgba[px + 3]} plain=${rNo.rgba[px + 3]}`
    );
    check(
      "描边颜色 ",
      rOut.rgba[px] === 0x40 && rOut.rgba[px + 1] === 0x40 && rOut.rgba[px + 2] === 0x49,
      [rOut.rgba[px], rOut.rgba[px + 1], rOut.rgba[px + 2]].join(",")
    );
    setModOutline(new Map());

    // ---- 模组电力节点（type=PowerNode）----
    const node1 = m.blocks.get("饱和火力-裂位节点");
    const node2 = m.blocks.get("饱和火力-装甲节点");
    const node3 = m.blocks.get("饱和火力-高压电");
    check("裂位节点 type=PowerNode", !!node1 && isPowerNodeType(node1.type), node1 && node1.type);
    check("裂位节点 scale=0.4 / color1=FFF2D6", !!node1 && node1.laserScale === 0.4 && node1.laserColor1 === "FFF2D6", node1 && `${node1.laserScale}/${node1.laserColor1}`);
    check("装甲节点 scale=0.5 / color2=5f6a89", !!node2 && node2.laserScale === 0.5 && node2.laserColor2 === "5f6a89", node2 && `${node2.laserScale}/${node2.laserColor2}`);
    check("高压电 laserRange=80", !!node3 && node3.laserRange === 80, node3 && node3.laserRange);

    const nw = TILE;
    const nbase = new Uint8ClampedArray(nw * nw * 4).fill(255);
    const nsp = () => ({ w: nw, h: nw, size: 1, rgba: new Uint8ClampedArray(nbase), placeholder: false });

    // 两个模组节点（相距 3 格）→ 电线宽度 10、颜色偏暖
    setModPowerNodes(new Map([["饱和火力-裂位节点", { scale: node1.laserScale, color1: node1.laserColor1, color2: node1.laserColor2 }]]));
    const msp = { "饱和火力-裂位节点": nsp(), laser: nsp(), "laser-end": nsp() };
    const mschem = {
      width: 4,
      height: 1,
      tiles: [
        { block: "饱和火力-裂位节点", x: 0, y: 0, rot: 0, config_type: "point2Array", config: [[3, 0]] },
        { block: "饱和火力-裂位节点", x: 3, y: 0, rot: 0, config_type: "point2Array", config: [[-3, 0]] },
      ],
    };
    const mres = renderSchematic(mschem, msp, { scale: 1, pad: 0, transparent: true, grid: false });
    const mcw = 4 * TILE; // 128；节点中心 x16/x112 → 中点 x64，中心 y16
    const mpx = (16 * mcw + 64) * 4;
    check(
      "模组节点电线存在且颜色偏暖（r>b）",
      mres.rgba[mpx] > 0 && mres.rgba[mpx] - mres.rgba[mpx + 2] > 20,
      `r=${mres.rgba[mpx]} b=${mres.rgba[mpx + 2]}`
    );
    check(
      "模组节点电线宽度≈10（y20 有 / y23 无）",
      mres.rgba[(20 * mcw + 64) * 4] > 0 && mres.rgba[(23 * mcw + 64) * 4] === 0,
      `y20=${mres.rgba[(20 * mcw + 64) * 4]} y23=${mres.rgba[(23 * mcw + 64) * 4]}`
    );
    setModPowerNodes(new Map());

    // vanilla 回归：power-node → battery，宽度 6、颜色近白
    const vsp = { "power-node": nsp(), battery: nsp(), laser: nsp(), "laser-end": nsp() };
    const vschem = {
      width: 3,
      height: 1,
      tiles: [
        { block: "power-node", x: 0, y: 0, rot: 0, config_type: "point2Array", config: [[2, 0]] },
        { block: "battery", x: 2, y: 0, rot: 0, config_type: "null", config: null },
      ],
    };
    const vres = renderSchematic(vschem, vsp, { scale: 1, pad: 0, transparent: true, grid: false });
    const vcw = 3 * TILE; // 96；中心 x16/x80 → 中点 x48
    const vpx = (16 * vcw + 48) * 4;
    check(
      "vanilla 节点电线颜色近白（r≈b）",
      vres.rgba[vpx] > 200 && vres.rgba[vpx + 1] > 200 && vres.rgba[vpx + 2] > 200 && Math.abs(vres.rgba[vpx] - vres.rgba[vpx + 2]) < 15,
      `rgb=${vres.rgba[vpx]},${vres.rgba[vpx + 1]},${vres.rgba[vpx + 2]}`
    );
    check(
      "vanilla 节点电线宽度≈6（y18 有 / y20 无）",
      vres.rgba[(18 * vcw + 48) * 4] > 0 && vres.rgba[(20 * vcw + 48) * 4] === 0,
      `y18=${vres.rgba[(18 * vcw + 48) * 4]} y20=${vres.rgba[(20 * vcw + 48) * 4]}`
    );

    setModPowerNodes(new Map());
    setModPowerBlocks(new Set());

    // 显示名：饱和火力 bundle 优先
    check(
      "显示名 饱和火力：bundle 优先（拓断）",
      blockDisplayName("饱和火力-拓断", [m]) === "拓断",
      blockDisplayName("饱和火力-拓断", [m])
    );

    // 序号帧物品图标：裂位能 / 二级协议 需命中 <name>1；硅钢命中 plain
    const resolveItem = (mods, ref) => {
      for (const c of modItemCandidates(ref)) {
        for (const mm of mods) {
          if (mm.spritesOverride.has(c) || mm.sprites.has(c)) return c;
        }
      }
      return null;
    };
    check("物品图标 裂位能 → 裂位能1", resolveItem([m], "裂位能") === "裂位能1", resolveItem([m], "裂位能"));
    check("物品图标 二级协议 → 二级协议1", resolveItem([m], "二级协议") === "二级协议1", resolveItem([m], "二级协议"));
    check("物品图标 硅钢 → plain 硅钢", resolveItem([m], "硅钢") === "硅钢", resolveItem([m], "硅钢"));
    const frameBlob = await m.sprites.get("裂位能1");
    check("裂位能1 可懒解压为 Blob", !!frameBlob && frameBlob.size > 0, frameBlob && frameBlob.size);
  }
}

function modBlockCount(m) {
  let n = 0;
  const p = m.name + "-";
  for (const k of m.blocks.keys()) if (k.startsWith(p)) n++;
  return n;
}

// -----------------------------------------------------------------------------
// 6b. 通用适配性（合成模组，证明不硬编码任何真实模组）
// -----------------------------------------------------------------------------
function testGeneric() {
  console.log("== 通用适配性测试（合成模组）==");

  const bridge = { base: "星河桥", name: "星河桥", type: "ItemBridge", range: 8, bridgeWidth: 8 };
  const node = { base: "聚能节点", name: "聚能节点", type: "PowerNode", laserScale: 0.4, laserColor1: "FFF2D6", laserColor2: "F19583" };
  const driver = { base: "陨星驱", name: "陨星驱", type: "MassDriver", size: 2 };
  const fakeMod = {
    name: "测试A",
    bundle: new Map([["block.测试A-星河桥.name", "星河大桥"]]),
    blocks: new Map([
      ["测试A-星河桥", bridge],
      ["星河桥", bridge],
      ["测试A-聚能节点", node],
      ["聚能节点", node],
      ["测试A-陨星驱", driver],
      ["陨星驱", driver],
    ]),
  };

  check("合成：桥类型判定", isBridgeType(bridge.type));
  check("合成：电力节点类型判定", isPowerNodeType(node.type));
  check("合成：质量驱动器类型判定", isMassDriverType(driver.type));
  check(
    "合成：modNameCandidates 去前缀",
    JSON.stringify(modNameCandidates("测试A-星河桥", [fakeMod])) === JSON.stringify(["测试A-星河桥", "星河桥"]),
    JSON.stringify(modNameCandidates("测试A-星河桥", [fakeMod]))
  );

  // 显示名优先级
  check("合成：bundle 优先", blockDisplayName("测试A-星河桥", [fakeMod]) === "星河大桥", blockDisplayName("测试A-星河桥", [fakeMod]));
  check("合成：无 bundle 回退 JSON name", blockDisplayName("测试A-聚能节点", [fakeMod]) === "聚能节点", blockDisplayName("测试A-聚能节点", [fakeMod]));
  check("合成：vanilla 走 BLOCK_CN", blockDisplayName("mass-driver", []) === "质量驱动器", blockDisplayName("mass-driver", []));

  // 注册后范围/配对生效
  setModBridges(new Map([["测试A-星河桥", { range: bridge.range, width: bridge.bridgeWidth }], ["星河桥", { range: bridge.range, width: bridge.bridgeWidth }]]));
  check("合成：bridgeRangeOf 生效", bridgeRangeOf("测试A-星河桥") === 8, `rng=${bridgeRangeOf("测试A-星河桥")}`);
  check("合成：bridgeWidthOf = 24", bridgeWidthOf("星河桥") === 24, `w=${bridgeWidthOf("星河桥")}`);
  const be = (x, y) => ({ tile: { block: "测试A-星河桥", x, y, rot: 0, config_type: "null", config: null }, size: 1, px: x * TILE, py: 0 });
  check("合成：range 内两桥配对", bridgePairs([be(0, 0), be(6, 0)]).length === 1, `pairs=${bridgePairs([be(0, 0), be(6, 0)]).length}`);
  check("合成：range 外不配对", bridgePairs([be(0, 0), be(10, 0)]).length === 0, `pairs=${bridgePairs([be(0, 0), be(10, 0)]).length}`);
  setModBridges(new Map());

  // 注册节点参数
  const nodeInfo = { scale: node.laserScale, color1: node.laserColor1, color2: node.laserColor2 };
  setModPowerNodes(new Map([["测试A-聚能节点", nodeInfo], ["聚能节点", nodeInfo]]));
  const opts = nodeLaserOpts("测试A-聚能节点");
  check("合成：nodeLaserOpts 宽度=10 / 端帽=0.4", opts.width === 10 && opts.capScale === 0.4, JSON.stringify(opts));
  check("合成：nodeLaserOpts 颜色偏暖", opts.color[0] > opts.color[2], JSON.stringify(opts.color));

  const W = TILE;
  const base = new Uint8ClampedArray(W * W * 4).fill(255);
  const sp = () => ({ w: W, h: W, size: 1, rgba: new Uint8ClampedArray(base), placeholder: false });
  const sprites = { "测试A-聚能节点": sp(), laser: sp(), "laser-end": sp() };
  const schem = {
    width: 4,
    height: 1,
    tiles: [
      { block: "测试A-聚能节点", x: 0, y: 0, rot: 0, config_type: "point2Array", config: [[3, 0]] },
      { block: "测试A-聚能节点", x: 3, y: 0, rot: 0, config_type: "point2Array", config: [[-3, 0]] },
    ],
  };
  const res = renderSchematic(schem, sprites, { scale: 1, pad: 0, transparent: true, grid: false });
  const cw = 4 * TILE;
  const mid = (16 * cw + 64) * 4;
  check(
    "合成：两节点之间能画线（暖色）",
    res.rgba[mid] > 0 && res.rgba[mid] - res.rgba[mid + 2] > 20,
    `r=${res.rgba[mid]} b=${res.rgba[mid + 2]}`
  );
  setModPowerNodes(new Map());
}

// -----------------------------------------------------------------------------
// 6c. 全量中文名 + 序号帧物品图标候选
// -----------------------------------------------------------------------------
function testCnAndFrames() {
  console.log("== 中文名 / 序号帧兜底测试 ==");
  check("中文名 overflow-gate = 溢流门", blockDisplayName("overflow-gate", []) === "溢流门", blockDisplayName("overflow-gate", []));
  check("中文名 underflow-gate = 反向溢流门", blockDisplayName("underflow-gate", []) === "反向溢流门", blockDisplayName("underflow-gate", []));
  check("中文名 mass-driver = 质量驱动器", blockDisplayName("mass-driver", []) === "质量驱动器", blockDisplayName("mass-driver", []));
  check(
    "中文名 duct = 官方（cn_data）",
    !!CN_BLOCKS["duct"] && blockDisplayName("duct", []) === CN_BLOCKS["duct"],
    `${blockDisplayName("duct", [])} / ${CN_BLOCKS["duct"]}`
  );

  const c1 = modItemCandidates("裂位能");
  check(
    "物品候选顺序 item-<name>/<name>/<name>1/item-<name>1",
    JSON.stringify(c1) === JSON.stringify(["item-裂位能", "裂位能", "裂位能1", "item-裂位能1"]),
    JSON.stringify(c1)
  );
  check("物品候选含 二级协议1", modItemCandidates("二级协议").includes("二级协议1"));
  const c3 = modItemCandidates("硅钢");
  check("plain 候选在序号帧之前（硅钢）", c3.indexOf("硅钢") < c3.indexOf("硅钢1"), JSON.stringify(c3));

  const sc = modSpriteCandidates("测试A-星河桥", ["测试A"]);
  check("方块候选追加 <name>1", sc.includes("测试A-星河桥1") && sc.includes("星河桥1"), JSON.stringify(sc));
  check("方块 plain 候选在前", sc.indexOf("星河桥") < sc.indexOf("星河桥1"), JSON.stringify(sc));
}

// -----------------------------------------------------------------------------
// 7. 镜像源切换 / 超时 / 缓存（注入 mock fetch 与 mock Cache Storage）
// -----------------------------------------------------------------------------
async function testNet() {
  console.log("== 镜像源 / 缓存测试 ==");

  function setGlobal(name, value) {
    const d = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    return d;
  }
  function restoreGlobal(name, d) {
    try {
      if (d) Object.defineProperty(globalThis, name, d);
      else delete globalThis[name];
    } catch (e) {
      // ignore
    }
  }

  const lsStore = {};
  const dLS = setGlobal("localStorage", {
    getItem: (k) => (k in lsStore ? lsStore[k] : null),
    setItem: (k, v) => {
      lsStore[k] = String(v);
    },
    removeItem: (k) => {
      delete lsStore[k];
    },
  });
  const dLoc = setGlobal("location", { origin: "https://example.test" });

  const cacheStore = new Map();
  const cacheMock = {
    async match(k) {
      const key = typeof k === "string" ? k : k.url;
      return cacheStore.get(key) || undefined;
    },
    async put(k, resp) {
      const key = typeof k === "string" ? k : k.url;
      cacheStore.set(key, resp);
    },
    async keys() {
      return [...cacheStore.keys()].map((u) => new Request(u));
    },
    async delete(k) {
      const key = typeof k === "string" ? k : k.url;
      return cacheStore.delete(key);
    },
  };
  const dCaches = setGlobal("caches", {
    async open() {
      return cacheMock;
    },
    async delete() {
      return true;
    },
    async keys() {
      return [];
    },
  });

  try {
    const { fetchMindustry, resetProbe, SOURCES, DEFAULT_SOURCES, SOURCE_DEFS, getSourceOrder, setChoiceKey, probeAllSources } = await import("../js/sources.js");
    const { fetchMindustryCached, spriteCacheKey, resetCacheInfo } = await import("../js/cache.js");
    const A = SOURCES[0];
    const B = SOURCES[1];
    const C = SOURCES[2];
    const D = SOURCES[3];

    // ---- getSourceOrder：自动 / 手动 / last-good ----
    localStorage.removeItem("msch-source");
    localStorage.removeItem("msch-source-choice");
    resetProbe();
    check(
      "getSourceOrder 自动（无记录）= 默认顺序",
      JSON.stringify(getSourceOrder()) === JSON.stringify(DEFAULT_SOURCES),
      getSourceOrder().join(",")
    );
    setChoiceKey("gcore");
    const gcoreUrl = SOURCE_DEFS.find((d) => d.key === "gcore").url;
    const ordManual = getSourceOrder();
    check(
      "getSourceOrder 手动选择在最前且不重复",
      ordManual[0] === gcoreUrl &&
        ordManual.filter((u) => u === gcoreUrl).length === 1 &&
        ordManual.length === DEFAULT_SOURCES.length,
      ordManual.map((u) => u.slice(0, 24)).join(" | ")
    );
    setChoiceKey("");
    localStorage.setItem("msch-source", SOURCE_DEFS[2].url);
    const ordLast = getSourceOrder();
    check(
      "getSourceOrder 自动含 last-good 提前",
      ordLast[0] === SOURCE_DEFS[2].url && ordLast.length === DEFAULT_SOURCES.length,
      ordLast[0]
    );
    localStorage.removeItem("msch-source");

    // ---- probeAllSources：并行探测标注 ok/超时 ----
    const probeFetch = (url, opts) => {
      if (url.startsWith(SOURCE_DEFS[0].url)) {
        return new Promise((_, rej) => {
          opts.signal.addEventListener("abort", () => rej(new Error("aborted")));
        });
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    };
    const pr = await probeAllSources({ defs: SOURCE_DEFS.slice(0, 2), timeoutMs: 30, fetchImpl: probeFetch });
    check(
      "probeAllSources 正确标注 超时/成功 与耗时",
      pr.length === 2 &&
        pr[0].ok === false &&
        pr[1].ok === true &&
        typeof pr[0].ms === "number" &&
        typeof pr[1].ms === "number",
      JSON.stringify(pr.map((r) => [r.key, r.ok, r.ms]))
    );

    // ---- 源切换顺序 + last-good 记忆 ----
    resetProbe();
    const seen = [];
    const switchFetch = (url) => {
      seen.push(url);
      if (url.startsWith(A)) return Promise.reject(new Error("boom"));
      return Promise.resolve(new Response("ok", { status: 200 }));
    };
    let switched = null;
    const r1 = await fetchMindustry("x.png", {
      sources: [A, B, C],
      fetchImpl: switchFetch,
      timeoutMs: 100,
      probe: false,
      onSwitch: (f, t) => {
        switched = [f, t];
      },
    });
    check(
      "源切换：首个失败自动切到下一个成功",
      r1.ok && seen[0].startsWith(A) && seen[1].startsWith(B) && !!switched && switched[1] === B,
      JSON.stringify(seen.map((u) => u.slice(0, 24)))
    );
    check("last-good 记忆 = 第二个源", localStorage.getItem("msch-source") === B, localStorage.getItem("msch-source"));

    seen.length = 0;
    switched = null;
    const r2 = await fetchMindustry("y.png", {
      sources: [A, B, C],
      fetchImpl: switchFetch,
      timeoutMs: 100,
      probe: false,
      onSwitch: (f, t) => {
        switched = [f, t];
      },
    });
    check(
      "后续请求优先使用最近可用源",
      r2.ok && seen.length === 1 && seen[0].startsWith(B) && !switched,
      JSON.stringify(seen.map((u) => u.slice(0, 24)))
    );

    // ---- 超时（abort）→ 切到下一个源 ----
    const timeoutFetch = (url, opts) => {
      if (url.startsWith(A)) {
        return new Promise((_, rej) => {
          opts.signal.addEventListener("abort", () => rej(new Error("aborted")));
        });
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    };
    localStorage.removeItem("msch-source");
    resetProbe();
    const r3 = await fetchMindustry("z.png", {
      sources: [A, D],
      fetchImpl: timeoutFetch,
      timeoutMs: 30,
      probe: false,
    });
    check("超时(abort)后切换到下一个源成功", r3.ok, "status=" + r3.status);
    check("超时切换后 last-good = 下一个源", localStorage.getItem("msch-source") === D, localStorage.getItem("msch-source"));

    // ---- 缓存命中 / 规范化键 / 失败不缓存 ----
    cacheStore.clear();
    resetCacheInfo();
    localStorage.removeItem("msch-source");
    let fetchCount = 0;
    const okFetch = () => {
      fetchCount++;
      return Promise.resolve(new Response("PNGDATA", { status: 200 }));
    };
    const rel = "core/assets-raw/sprites/foo.png";
    const c1 = await fetchMindustryCached(rel, { sources: [A], fetchImpl: okFetch, timeoutMs: 100, probe: false });
    const c1t = await c1.text();
    const afterFirst = fetchCount;
    const c2 = await fetchMindustryCached(rel, { sources: [A], fetchImpl: okFetch, timeoutMs: 100, probe: false });
    const c2t = await c2.text();
    check("缓存键为规范化相对路径", cacheStore.has(spriteCacheKey(rel)), [...cacheStore.keys()].join(","));
    check("首次请求成功并写入缓存", afterFirst === 1 && c1t === "PNGDATA", `fetchCount=${afterFirst}`);
    check("缓存命中不再发起请求", fetchCount === 1 && c2t === "PNGDATA", `fetchCount=${fetchCount}`);

    cacheStore.clear();
    const failFetch = () => Promise.reject(new Error("net down"));
    let threw = false;
    try {
      await fetchMindustryCached("core/assets-raw/sprites/bar.png", {
        sources: [A],
        fetchImpl: failFetch,
        timeoutMs: 40,
        probe: false,
      });
    } catch (e) {
      threw = true;
    }
    check("所有源失败时抛错", threw);
    check("失败不写入缓存", cacheStore.size === 0, `size=${cacheStore.size}`);
  } finally {
    restoreGlobal("localStorage", dLS);
    restoreGlobal("location", dLoc);
    restoreGlobal("caches", dCaches);
  }
}

// -----------------------------------------------------------------------------
// 入口
// -----------------------------------------------------------------------------
async function main() {
  if (!fs.existsSync(IN_TXT) || !fs.existsSync(IN_JSON)) {
    console.error(`找不到测试输入：${IN_TXT} / ${IN_JSON}`);
    process.exit(2);
  }
  await testParse();

  globalThis.__EXP_TILES = JSON.parse(fs.readFileSync(IN_JSON, "utf8")).tiles;
  globalThis.__SCHEM = await parseSchematic(fs.readFileSync(IN_TXT, "utf8"));
  testRenderUnits();
  testOpacity();
  testIcons();
  await testPrefetch();
  testRequirements();
  await testMods();
  testGeneric();
  testCnAndFrames();
  await testNet();

  console.log("");
  console.log(`结果：PASS ${pass}，FAIL ${fail}`);
  if (fail > 0) {
    console.log("差异明细：");
    for (const f of failures) console.log("  - " + f);
    process.exit(1);
  }
  console.log("全部通过 ✅");
}

main().catch((e) => {
  console.error("测试异常：", e);
  process.exit(3);
});
