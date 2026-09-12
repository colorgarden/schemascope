// =============================================================================
// test/parse_test.mjs —— 解析器一致性测试（与 Python 参考 蓝图.json 逐字段比对）
//                      + 渲染器关键算法单测
//
// 运行：node test/parse_test.mjs
// 依赖：Node 18+（DecompressionStream / atob 内置），无需安装任何依赖。
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import { parseSchematic, extractLogic, isProcessor, bytesToBase64, isTextBlueprint, parseContentMap, FALLBACK_BLOCKS, LEGACY_BLOCKS } from "../js/parser.js";
import {
  computeLayout,
  tileFootprint,
  dilateAlpha,
  bridgePairs,
  bridgeWidthOf,
  bridgeRangeOf,
  drawBeam,
  fillRect,
  tileBlit,
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
  setModLayers,
  setModColors,
  setModBlockDefs,
  staticLayerNames,
  isBridgeBlockName,
  nodeLaserOpts,
} from "../js/render.js";
import {
  vanillaRule,
  spriteVariantCandidates,
  configKindOf,
  configSpriteNamesFor,
  isBridgeBlock,
  bridgeRange,
  typeOfBlock,
  sizeOfBlock,
  hasTypeRule,
  blockProps,
  isAutotilerBlock,
  isTurretBlock,
  turretInfo,
  turretFallbackBaseName,
  turretSpriteNames,
  autotilerSpriteNames,
  selectMissingSprites,
} from "../js/render_rules.js";
import { VANILLA_TURRETS } from "../js/vanilla_turrets.js";
import { makeTileWorld, buildBlending, transformCase, mod4, d4x, d4y, relativeTo, getFacingEdge, blends } from "../js/blending.js";
import { VANILLA_BLOCKS } from "../js/vanilla_blocks.js";
import { blockDisplayName, modNameCandidates, spriteDisplayName } from "../js/names.js";
import { LAYERS, OUTLINE_ICON, TILE, CONTENT_CN, CONTENT_COLORS, CONFIG_UNDERLAY, CONFIG_OVERLAY, configSpriteNames, spriteAliasCandidates } from "../js/data.js";
import { setIconIndex, resolveIcon, richText, plainTextWithIcons, itemIconSrc, itemIconPath, iconCacheRelPath, ICON_FONT_LO } from "../js/icons.js";
import { ICON_BY_CODE } from "../js/icons_data.js";
import { simpleHash, createPrefetchManager } from "../js/prefetch.js";
import { computeRequirements, requirementsList } from "../js/requirements.js";
import { BLOCK_REQUIREMENTS } from "../js/requirements_data.js";
import { openZip } from "../js/zip.js";
import { parseMod, modSpriteCandidates, modItemCandidates, drawerStaticLayers, looseJson, parseRequirements, parseHexColor } from "../js/mod.js";
import { CN_BLOCKS } from "../js/cn_data.js";
import {
  HISTORY_KEY,
  HISTORY_MAX_ITEMS,
  HISTORY_MAX_BYTES,
  HISTORY_MAX_INPUT,
  addHistory,
  removeHistory,
  saveHistory,
  loadHistory,
  formatRelativeTime,
} from "../js/history.js";

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

  // richText —— 图标贴图运行时从官方仓库拉取（不再随仓库分发 GPL 资源）
  const CDN = "https://cdn.jsdelivr.net/gh/Anuken/Mindustry@master/";
  const rt = richText(String.fromCharCode(63528));
  check("richText(63528) 用 CDN 原贴图", rt.includes(`${CDN}core/assets-raw/sprites/items/liquid-water.png`), rt);
  check("richText(63528) 含 img 且 data-fb 指原贴图", rt.includes('class="msch-icon"') && rt.includes("liquid-water"), rt);
  check("richText(63528) 含中文 alt 水", rt.includes('alt="水"'), rt);
  check("richText(63465) CDN 图标", richText(String.fromCharCode(63465)).includes("core/assets-raw/"));
  check("richText(63084) CDN 图标", richText(String.fromCharCode(63084)).includes("core/assets-raw/"));

  // 许可证守卫：仓库不得包含 Mindustry 的 GPL 资源（图标/字体随运行时拉取）
  check("仓库不含 assets/icons、assets/fonts（GPL 资源）", !fs.existsSync(path.join(__dirname, "../assets/icons")) && !fs.existsSync(path.join(__dirname, "../assets/fonts")));
  let rawCode = null;
  for (const code of Object.keys(ICON_BY_CODE)) {
    const c = Number(code);
    const ic = resolveIcon(c);
    if (ic && ic.spritePath) {
      rawCode = c;
      break;
    }
  }
  check("存在可解析的 PUA 码点", rawCode !== null, `rawCode=${rawCode}`);
  if (rawCode !== null) {
    const rawHtml = richText(String.fromCharCode(rawCode));
    check(`richText(${rawCode}) 走 CDN 原贴图`, rawHtml.includes("core/assets-raw/") && !rawHtml.includes("assets/icons/"), rawHtml);
  }

  const emoji = String.fromCharCode(59394); // 0xE802
  check("richText(emoji) 保留原字符", richText(emoji) === emoji, richText(emoji));
  check("richText 普通中文不受影响", richText("接收台 ABC 123") === "接收台 ABC 123");
  check("richText 转义 HTML", richText("<b>&\"") === "&lt;b&gt;&amp;&quot;", richText('<b>&"'));

  // plainTextWithIcons
  check("plainTextWithIcons(63528) → [水]", plainTextWithIcons(String.fromCharCode(63528)) === "[水]");
  check("plainTextWithIcons(emoji) → 去掉", plainTextWithIcons("A" + emoji + "B") === "AB");
  check("plainTextWithIcons 普通文本原样", plainTextWithIcons("接收台") === "接收台");

  // 集成：示例信息板原文里的 U+F828 应渲染成 CDN 水图标
  const msg = globalThis.__SCHEM.tiles.find((t) => t.block === "message");
  const hasWaterChar = msg && msg.config && msg.config.includes(String.fromCharCode(63528));
  check("示例信息板含 U+F828(水)", !!hasWaterChar);
  if (hasWaterChar) {
    const html = richText(msg.config);
    check("信息板 richText 含水图标", html.includes("msch-icon") && html.includes("core/assets-raw/sprites/items/liquid-water.png"));
  }

  // 耗材图标：物品名 → 运行时 CDN 原贴图
  check("itemIconSrc(copper) 指向 item-copper", String(itemIconSrc("copper")).includes("sprites/items/item-copper.png"), String(itemIconSrc("copper")));
  check("itemIconSrc(titanium) 指向 item-titanium", String(itemIconSrc("titanium")).includes("sprites/items/item-titanium.png"), String(itemIconSrc("titanium")));
  check("itemIconSrc(surge-alloy) 指向 item-surge-alloy", String(itemIconSrc("surge-alloy")).includes("sprites/items/item-surge-alloy.png"), String(itemIconSrc("surge-alloy")));
  check("itemIconSrc(未知物品) = null", itemIconSrc("not-an-item") === null);
  check("iconCacheRelPath 拼 core/assets-raw/", iconCacheRelPath("sprites/items/item-copper.png") === "core/assets-raw/sprites/items/item-copper.png", String(iconCacheRelPath("sprites/items/item-copper.png")));
  check("itemIconPath(copper) 含 item-copper", String(itemIconPath("copper")).includes("sprites/items/item-copper.png"), String(itemIconPath("copper")));
  check("itemIconPath(未知) = null", itemIconPath("not-an-item") === null);
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
  check("parseHexColor 16进制", (() => {
    const c1 = parseHexColor("00EE00");
    const c2 = parseHexColor("#596ab8");
    return (
      JSON.stringify(c1) === JSON.stringify([0, 238, 0]) &&
      JSON.stringify(c2) === JSON.stringify([89, 106, 184]) &&
      parseHexColor("zzz") === null &&
      parseHexColor(null) === null
    );
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
    check("饱和火力 items 一级协议（名称/颜色）", (() => {
      const it = m.items && (m.items.get("饱和火力-一级协议") || m.items.get("一级协议"));
      return !!it && it.name === "初级协议" && JSON.stringify(it.color) === JSON.stringify([0, 238, 0]);
    })(), m.items ? `items=${m.items.size}` : "no items");
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

    // ---- setModColors：模组物品颜色（配置影响贴图着色）----
    {
      const w2 = TILE;
      const center = { w: 10, h: 10, size: 1, rgba: new Uint8ClampedArray(10 * 10 * 4).fill(255), placeholder: false };
      const body = { w: w2, h: w2, size: 1, rgba: new Uint8ClampedArray(w2 * w2 * 4).fill(80), placeholder: false };
      const sprites2 = { unloader: body, "unloader-center": center };
      const schem2 = { width: 1, height: 1, tiles: [{ block: "unloader", x: 0, y: 0, rot: 0, config_type: "content", config: "一级协议" }] };
      setModColors(new Map([["一级协议", [0, 238, 0]]]));
      const r2 = renderSchematic(schem2, sprites2, { scale: 1, pad: 0, transparent: true, grid: false });
      const p2 = (16 * w2 + 16) * 4;
      check(
        "模组物品色：装卸器中心 = 物品色",
        r2.rgba[p2] === 0 && r2.rgba[p2 + 1] === 238 && r2.rgba[p2 + 2] === 0 && r2.rgba[p2 + 3] === 255,
        [r2.rgba[p2], r2.rgba[p2 + 1], r2.rgba[p2 + 2], r2.rgba[p2 + 3]].join(",")
      );
      setModColors(new Map());
    }

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

  // 原版桥名回归：phase-conveyor / bridge-conveyor 必须在 BRIDGE_BLOCKS 中（曾被遗漏 → 无连接贴图）
  const vb = (block, x, y, dx, dy) => ({ tile: { block, x, y, rot: 0, config_type: "point2", config: [dx, dy] }, size: 1, px: x * TILE, py: y * TILE });
  check("原版 phase-conveyor 配对", bridgePairs([vb("phase-conveyor", 0, 0, 0, 2), vb("phase-conveyor", 0, 2, 0, -2)]).length === 1);
  check("原版 bridge-conveyor 配对", bridgePairs([vb("bridge-conveyor", 0, 0, 0, 3), vb("bridge-conveyor", 0, 3, 0, -3)]).length === 1);
  check("原版 phase-conduit 配对", bridgePairs([vb("phase-conduit", 0, 0, 0, 8), vb("phase-conduit", 0, 8, 0, -8)]).length === 1);
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
// 6d. 贴图名 → 显示名（贴图缺失提示用）
// -----------------------------------------------------------------------------
function testSpriteNames() {
  console.log("== 贴图名 → 显示名测试 ==");
  check("spriteDisplayName 方块本身", spriteDisplayName("silicon-smelter", []) === "硅冶炼厂", spriteDisplayName("silicon-smelter", []));
  check("spriteDisplayName 剥 -top", spriteDisplayName("silicon-smelter-top", []) === "硅冶炼厂", spriteDisplayName("silicon-smelter-top", []));
  check("spriteDisplayName 剥 -rotator", spriteDisplayName("mechanical-drill-rotator", []) === "机械钻头", spriteDisplayName("mechanical-drill-rotator", []));
  check("spriteDisplayName 剥 -center", spriteDisplayName("unloader-center", []) === "装卸器", spriteDisplayName("unloader-center", []));
  check("spriteDisplayName 剥 -bottom", spriteDisplayName("liquid-tank-bottom", []) === "流体储罐", spriteDisplayName("liquid-tank-bottom", []));
  check("spriteDisplayName 剥 -数字", spriteDisplayName("duct-top-2", []) === "物品管道", spriteDisplayName("duct-top-2", []));
  check("spriteDisplayName 未知原样", spriteDisplayName("some-unknown-sprite", []) === "some-unknown-sprite", spriteDisplayName("some-unknown-sprite", []));
  const fakeMod = {
    name: "测试A",
    bundle: new Map([["block.测试A-星河桥.name", "星河大桥"]]),
    blocks: new Map([["测试A-星河桥", { name: "星河大桥" }]]),
  };
  check("spriteDisplayName 模组层剥离", spriteDisplayName("测试A-星河桥-top", [fakeMod]) === "星河大桥", spriteDisplayName("测试A-星河桥-top", [fakeMod]));

  // 模组覆盖原版方块：JSON name 与内部名相同 → 视为未翻译，回退官方中文表（饱和火力实测场景）
  const overrideMod = {
    name: "饱和火力",
    bundle: new Map(),
    blocks: new Map([
      ["silicon-smelter", { name: "silicon-smelter" }],
      ["junction", { name: "junction" }],
      ["饱和火力-裂位传送塔", { name: "裂位传送塔" }],
    ]),
  };
  check("覆盖原版但 name=内部名 → 官方表", blockDisplayName("silicon-smelter", [overrideMod]) === "硅冶炼厂", blockDisplayName("silicon-smelter", [overrideMod]));
  check("覆盖原版 junction → 交叉器", blockDisplayName("junction", [overrideMod]) === "交叉器", blockDisplayName("junction", [overrideMod]));
  check("模组自定义名仍优先", blockDisplayName("饱和火力-裂位传送塔", [overrideMod]) === "裂位传送塔", blockDisplayName("饱和火力-裂位传送塔", [overrideMod]));
}

// -----------------------------------------------------------------------------
// 7. 本地历史记录（纯函数 + mock storage）
// -----------------------------------------------------------------------------
function testHistory() {
  console.log("== 历史记录测试 ==");
  const mk = (i, time, input) => ({
    hash: "h" + i,
    name: "N" + i,
    w: 1,
    h: 1,
    tiles: 1,
    time: time !== undefined ? time : 1000 + i,
    input: input !== undefined ? input : "x",
  });

  let list = [];
  list = addHistory(list, mk(1, 1000, "a"));
  list = addHistory(list, mk(2, 2000, "b"));
  check("add：新条目置顶", list.length === 2 && list[0].hash === "h2", list.map((e) => e.hash).join(","));
  list = addHistory(list, { hash: "h1", name: "N1b", w: 1, h: 1, tiles: 1, time: 3000, input: "a" });
  check(
    "add：同 hash 去重置顶并更新时间",
    list.length === 2 && list[0].hash === "h1" && list[0].time === 3000,
    JSON.stringify(list)
  );
  const after = addHistory(list, mk(9, 1, "x".repeat(HISTORY_MAX_INPUT + 1)));
  check("add：单条 >1MB 跳过", after.length === list.length && !after.some((e) => e.hash === "h9"), `len=${after.length}`);

  let many = [];
  for (let i = 0; i < 17; i++) many = addHistory(many, mk(i, i, "z"));
  check(`淘汰：总条数 ≤${HISTORY_MAX_ITEMS}`, many.length === HISTORY_MAX_ITEMS, `len=${many.length}`);

  let bigs = [];
  for (let i = 0; i < 8; i++) bigs = addHistory(bigs, mk(i, i, "y".repeat(300000)));
  const totalBytes = bigs.reduce((s, e) => s + e.input.length, 0);
  check(
    "淘汰：总字节 ≤2MB（从最旧淘汰）",
    totalBytes <= HISTORY_MAX_BYTES && bigs.length < 8,
    `len=${bigs.length} bytes=${totalBytes}`
  );

  check("remove：删除指定 hash", removeHistory(many, "h3").every((e) => e.hash !== "h3"));

  // 写入失败 → 淘汰一半重试
  const store = {};
  let fail = 0;
  const storage = {
    setItem(k, v) {
      if (fail > 0) {
        fail--;
        throw new Error("quota");
      }
      store[k] = v;
    },
    getItem(k) {
      return k in store ? store[k] : null;
    },
  };
  fail = 1;
  const saved = saveHistory(bigs, storage);
  check(
    "save：首次失败淘汰一半重试成功",
    Array.isArray(saved) && saved.length === Math.max(0, Math.floor(bigs.length / 2)),
    saved && saved.length
  );
  fail = 2;
  const saved2 = saveHistory(bigs, storage);
  check("save：两次失败静默返回 null", saved2 === null);

  fail = 0;
  saveHistory(bigs, storage);
  check("load：读回条数一致", loadHistory(storage).length === bigs.length, loadHistory(storage).length);
  store[HISTORY_KEY] = "{bad";
  check("load：损坏数据返回空数组", loadHistory(storage).length === 0);

  const now = 10_000_000_000;
  check("相对时间：刚刚", formatRelativeTime(now, now) === "刚刚");
  check("相对时间：3 分钟前", formatRelativeTime(now - 3 * 60 * 1000, now) === "3 分钟前");
  check("相对时间：昨天", formatRelativeTime(now - 25 * 3600 * 1000, now) === "昨天");
  check("相对时间：2 天前", formatRelativeTime(now - 2 * 24 * 3600 * 1000, now) === "2 天前");
}

// -----------------------------------------------------------------------------
// 8. 文件输入：bytesToBase64 / isTextBlueprint
// -----------------------------------------------------------------------------
async function testFileInput() {
  console.log("== 文件输入测试 ==");
  for (const n of [0, 1, 32768, 100000]) {
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) a[i] = (i * 31 + 7) & 255;
    const b64 = bytesToBase64(a);
    const back = new Uint8Array(Buffer.from(b64, "base64"));
    let same = back.length === n;
    if (same) for (let i = 0; i < n; i++) if (back[i] !== a[i]) { same = false; break; }
    check(`bytesToBase64 往返 n=${n}`, same, `len=${back.length}`);
  }

  const enc = (s) => new TextEncoder().encode(s);
  check("isTextBlueprint：bXNja 文本", isTextBlueprint(enc("bXNjaAF4nGPg")));
  check("isTextBlueprint：带换行/空白", isTextBlueprint(enc("  bXNjaAF4nGPg\n\t")));
  check("isTextBlueprint：msch 二进制 false", !isTextBlueprint(new Uint8Array([0x6d, 0x73, 0x63, 0x68, 1, 2, 3])));
  check("isTextBlueprint：随机字节 false", !isTextBlueprint(new Uint8Array([0x12, 0x9a, 0xff, 0x00])));
  check("isTextBlueprint：空 false", !isTextBlueprint(new Uint8Array(0)));

  // 回归：构造 v1 容器（msch + version=1 + zlib 体）→ base64 → parseSchematic
  const bodyBytes = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const container = Buffer.concat([Buffer.from([0x6d, 0x73, 0x63, 0x68, 0x01]), zlib.deflateSync(bodyBytes)]);
  const b64 = bytesToBase64(new Uint8Array(container));
  const schem = await parseSchematic(b64);
  check(
    "v1 容器 base64（bytesToBase64）可被 parseSchematic 解析",
    schem.version === 1 && schem.width === 1 && schem.height === 1 && schem.total === 0,
    `v=${schem.version} ${schem.width}x${schem.height} total=${schem.total}`
  );
}

// -----------------------------------------------------------------------------
// 8b. 配置影响贴图（underlay/overlay）渲染
// -----------------------------------------------------------------------------
function testConfigRender() {
  console.log("== 配置贴图渲染测试 ==");

  // configSpriteNames：预加载收集（修复「装卸器没效果」——配置贴图未下载）
  check("configSpriteNames(unloader)", JSON.stringify(configSpriteNames("unloader")) === JSON.stringify(["unloader-center"]), JSON.stringify(configSpriteNames("unloader")));
  check("configSpriteNames(duct-unloader)", JSON.stringify(configSpriteNames("duct-unloader")) === JSON.stringify(["duct-unloader-center"]), JSON.stringify(configSpriteNames("duct-unloader")));
  check("configSpriteNames(sorter)", JSON.stringify(configSpriteNames("sorter")) === JSON.stringify(["cross-full"]), JSON.stringify(configSpriteNames("sorter")));
  check("configSpriteNames(liquid-source)", JSON.stringify(configSpriteNames("liquid-source")) === JSON.stringify(["source-bottom", "fluid"]), JSON.stringify(configSpriteNames("liquid-source")));
  check("configSpriteNames(kiln)=[]", JSON.stringify(configSpriteNames("kiln")) === "[]", JSON.stringify(configSpriteNames("kiln")));
  {
    const idx = JSON.parse(fs.readFileSync(new URL("../sprite_index.json", import.meta.url), "utf8"));
    check("aux 含 unloader-center", !!idx.aux["unloader-center"], idx.aux["unloader-center"]);
    check("duct-unloader-center 路径以 distribution/ducts 结尾", /distribution\/ducts\/duct-unloader-center\.png$/.test(idx.aux["duct-unloader-center"] || ""), idx.aux["duct-unloader-center"]);
    check("aux 含 cross-full/fluid/source-bottom", !!(idx.aux["cross-full"] && idx.aux["fluid"] && idx.aux["source-bottom"]), JSON.stringify({ c: idx.aux["cross-full"], f: idx.aux["fluid"], s: idx.aux["source-bottom"] }));
  }

  // 变体兜底：传送带/导管/管道在上游只有旋转变体、没有本体图
  check(
    "spriteAliasCandidates 顺序",
    JSON.stringify(spriteAliasCandidates("titanium-conveyor")) === JSON.stringify(["titanium-conveyor-0-0", "titanium-conveyor-bottom", "titanium-conveyor-top-0"]),
    JSON.stringify(spriteAliasCandidates("titanium-conveyor"))
  );
  {
    const idx = JSON.parse(fs.readFileSync(new URL("../sprite_index.json", import.meta.url), "utf8"));
    check("索引含变体（传送带 -0-0）", !!idx.blocks["titanium-conveyor-0-0"] && !!idx.blocks["conveyor-0-0"], "titanium-conveyor-0-0");
    check("索引含变体（导管 -bottom / 管道 -top-0）", !!idx.blocks["conduit-bottom"] && !!idx.blocks["armored-duct-top-0"], "conduit-bottom/armored-duct-top-0");
  }
  check(
    "LAYERS：导管/管道双层",
    JSON.stringify(LAYERS["conduit"]) === JSON.stringify(["conduit-bottom", "conduit-top-0"]) &&
      JSON.stringify(LAYERS["duct"]) === JSON.stringify(["duct-bottom", "duct-top-0"]) &&
      JSON.stringify(LAYERS["armored-duct"]) === JSON.stringify(["duct-bottom", "armored-duct-top-0"]),
    JSON.stringify({ c: LAYERS["conduit"], d: LAYERS["duct"], a: LAYERS["armored-duct"] })
  );

  // fillRect
  const fb = new Uint8ClampedArray(4 * 4 * 4);
  fillRect(fb, 4, 4, 1, 1, 2, 2, [10, 20, 30, 255]);
  check(
    "fillRect：填充 2×2、其余透明",
    fb[(1 * 4 + 1) * 4] === 10 && fb[(1 * 4 + 1) * 4 + 2] === 30 && fb[(2 * 4 + 2) * 4 + 3] === 255 && fb[3] === 0,
    `p11=${fb[(1 * 4 + 1) * 4]},${fb[(1 * 4 + 1) * 4 + 2]} p00a=${fb[3]}`
  );

  // tileBlit
  const region = {
    w: 2,
    h: 2,
    rgba: new Uint8ClampedArray([
      255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 255, 255, 0, 255,
    ]),
  };
  const tb = new Uint8ClampedArray(4 * 4 * 4);
  tileBlit(tb, 4, 4, region, 0, 0, 4, 4, region.rgba);
  const at = (x, y) => tb[(y * 4 + x) * 4];
  check(
    "tileBlit：按 region 平铺",
    at(0, 0) === 255 && at(1, 0) === 0 && at(2, 0) === 255 && at(0, 1) === 0 && at(1, 1) === 255,
    `(${at(0, 0)},${at(1, 0)}) (${at(0, 1)},${at(1, 1)})`
  );

  const W = TILE;
  const mk = (r, g, b, a) => {
    const rgba = new Uint8ClampedArray(W * W * 4);
    for (let i = 0; i < W * W; i++) {
      rgba[i * 4] = r;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = b;
      rgba[i * 4 + 3] = a;
    }
    return { w: W, h: W, size: 1, rgba, placeholder: false };
  };
  const clear = () => mk(0, 0, 0, 0);
  const sprites = {
    sorter: clear(),
    "item-source": clear(),
    unloader: clear(),
    "unloader-center": mk(255, 255, 255, 255),
    "liquid-source": clear(),
    "source-bottom": mk(74, 75, 83, 255),
    "cross-full": mk(10, 200, 10, 255),
    cross: mk(200, 10, 10, 255),
    fluid: mk(255, 255, 255, 255),
  };
  const schem = {
    width: 4,
    height: 1,
    tiles: [
      { block: "sorter", x: 0, y: 0, rot: 0, config_type: "content", config: "copper" },
      { block: "item-source", x: 1, y: 0, rot: 0, config_type: "null", config: null },
      { block: "unloader", x: 2, y: 0, rot: 0, config_type: "content", config: "titanium" },
      { block: "liquid-source", x: 3, y: 0, rot: 0, config_type: "content", config: "water" },
    ],
  };
  const res = renderSchematic(schem, sprites, { scale: 1, pad: 0, transparent: true, grid: false });
  const cw = 4 * TILE;
  const px = (x) => (16 * cw + x * TILE + 16) * 4;

  const copper = CONTENT_COLORS.copper;
  const titanium = CONTENT_COLORS.titanium;
  const water = CONTENT_COLORS.water;
  check(
    "sorter(item)：整格填充内容色（copper）",
    res.rgba[px(0)] === copper[0] && res.rgba[px(0) + 1] === copper[1] && res.rgba[px(0) + 2] === copper[2],
    [res.rgba[px(0)], res.rgba[px(0) + 1], res.rgba[px(0) + 2]].join(",")
  );
  check(
    "item-source(null)：出现 cross-full",
    res.rgba[px(1)] === 10 && res.rgba[px(1) + 1] === 200 && res.rgba[px(1) + 2] === 10,
    [res.rgba[px(1)], res.rgba[px(1) + 1], res.rgba[px(1) + 2]].join(",")
  );
  check(
    "unloader(item)：center 乘内容色（titanium）",
    res.rgba[px(2)] === titanium[0] && res.rgba[px(2) + 1] === titanium[1] && res.rgba[px(2) + 2] === titanium[2],
    [res.rgba[px(2)], res.rgba[px(2) + 1], res.rgba[px(2) + 2]].join(",")
  );
  check(
    "liquid-source(water)：fluid 着色铺满（water）",
    res.rgba[px(3)] === water[0] && res.rgba[px(3) + 1] === water[1] && res.rgba[px(3) + 2] === water[2],
    [res.rgba[px(3)], res.rgba[px(3) + 1], res.rgba[px(3) + 2]].join(",")
  );

  // config_icons=false 时两者都跳过
  const res2 = renderSchematic(schem, sprites, { scale: 1, pad: 0, transparent: true, grid: false, config_icons: false });
  check("config_icons=false：不画配置贴图", res2.rgba[px(0) + 3] === 0 && res2.rgba[px(1) + 3] === 0);

  check("CONFIG_UNDERLAY 映射", CONFIG_UNDERLAY.sorter === "item" && CONFIG_UNDERLAY["item-source"] === "item");
  check(
    "CONFIG_OVERLAY 映射",
    CONFIG_OVERLAY.unloader === "centerTint" &&
      CONFIG_OVERLAY["duct-unloader"] === "centerTint" &&
      CONFIG_OVERLAY["liquid-source"] === "liquidSource"
  );

  // LAYERS 修正：sorter/inverted-sorter/liquid-source 不得含 source-bottom
  check("LAYERS.sorter 不含 source-bottom", JSON.stringify(LAYERS.sorter) === JSON.stringify(["sorter"]), JSON.stringify(LAYERS.sorter));
  check("LAYERS.inverted-sorter 不含 source-bottom", JSON.stringify(LAYERS["inverted-sorter"]) === JSON.stringify(["inverted-sorter"]), JSON.stringify(LAYERS["inverted-sorter"]));
  check("LAYERS.liquid-source 不含 source-bottom", JSON.stringify(LAYERS["liquid-source"]) === JSON.stringify(["liquid-source"]), JSON.stringify(LAYERS["liquid-source"]));

  // 双层建筑抽查（保留项）
  check(
    "LAYERS.mechanical-drill 含 rotator+top",
    JSON.stringify(LAYERS["mechanical-drill"]) === JSON.stringify(["mechanical-drill", "mechanical-drill-rotator", "mechanical-drill-top"]),
    JSON.stringify(LAYERS["mechanical-drill"])
  );
  check("LAYERS.thruster = [thruster, -top]", JSON.stringify(LAYERS.thruster) === JSON.stringify(["thruster", "thruster-top"]), JSON.stringify(LAYERS.thruster));
  check("LAYERS.plasma-bore = [base, -top]", JSON.stringify(LAYERS["plasma-bore"]) === JSON.stringify(["plasma-bore", "plasma-bore-top"]), JSON.stringify(LAYERS["plasma-bore"]));
  check("LAYERS.additive-reconstructor 保留 -top", JSON.stringify(LAYERS["additive-reconstructor"]) === JSON.stringify(["additive-reconstructor", "additive-reconstructor-top"]));
  check("LAYERS.payload-loader 保留 -top", JSON.stringify(LAYERS["payload-loader"]) === JSON.stringify(["payload-loader", "payload-loader-top"]));
  check("LAYERS.spore-press 保留 -top", JSON.stringify(LAYERS["spore-press"]) === JSON.stringify(["spore-press", "spore-press-top"]));
  check("LAYERS.cultivator 保留 -top", JSON.stringify(LAYERS["cultivator"]) === JSON.stringify(["cultivator", "cultivator-top"]));
  check("LAYERS.illuminator 保留 -top", JSON.stringify(LAYERS["illuminator"]) === JSON.stringify(["illuminator", "illuminator-top"]));
  check("LAYERS 不含 force-projector", !("force-projector" in LAYERS));
  check("LAYERS 不含 shock-mine", !("shock-mine" in LAYERS));
  check("LAYERS 不含 payload-conveyor", !("payload-conveyor" in LAYERS));
  check("LAYERS 保留 battery（回归）", JSON.stringify(LAYERS.battery) === JSON.stringify(["battery", "battery-top"]));

  // 原版顶盖已恢复（[base, base-top]）
  for (const k of [
    "kiln", "silicon-smelter", "silicon-crucible", "surge-smelter", "plastanium-compressor",
    "slag-incinerator", "combustion-generator", "steam-generator", "differential-generator",
    "rtg-generator", "thorium-reactor", "mender", "mend-projector", "overdrive-projector", "overdrive-dome",
  ]) {
    check(
      `原版顶盖已恢复：${k}`,
      JSON.stringify(LAYERS[k]) === JSON.stringify([k, k + "-top"]),
      LAYERS[k] && JSON.stringify(LAYERS[k])
    );
  }

  // vent-condenser 层序（bottom→rotator→mid→base），turbine base→rotator
  check(
    "LAYERS.vent-condenser 层序",
    JSON.stringify(LAYERS["vent-condenser"]) ===
      JSON.stringify(["vent-condenser-bottom", "vent-condenser-rotator", "vent-condenser-mid", "vent-condenser"]),
    JSON.stringify(LAYERS["vent-condenser"])
  );
  check(
    "LAYERS.turbine-condenser = [base, rotator]",
    JSON.stringify(LAYERS["turbine-condenser"]) === JSON.stringify(["turbine-condenser", "turbine-condenser-rotator"]),
    JSON.stringify(LAYERS["turbine-condenser"])
  );

  // 双层冒烟：plasma-bore 的 -top 第二层被绘制
  const topSprites = { "plasma-bore": clear(), "plasma-bore-top": mk(1, 2, 3, 255) };
  const topSchem = { width: 1, height: 1, tiles: [{ block: "plasma-bore", x: 0, y: 0, rot: 0, config_type: "null", config: null }] };
  const topRes = renderSchematic(topSchem, topSprites, { scale: 1, pad: 0, transparent: true, grid: false });
  check(
    "plasma-bore -top 第二层被绘制",
    topRes.rgba[0] === 1 && topRes.rgba[1] === 2 && topRes.rgba[2] === 3,
    [topRes.rgba[0], topRes.rgba[1], topRes.rgba[2]].join(",")
  );
}

// -----------------------------------------------------------------------------
// 8c. v0 旧格式 / 版本校验 / 旧名回退 / contentMap JSON
// -----------------------------------------------------------------------------
async function testV0() {
  console.log("== v0 旧格式测试 ==");
  const pack = (x, y) => ((x & 0xffff) << 16) | (y & 0xffff);
  const u8 = (n) => Buffer.from([n & 0xff]);
  const i16 = (n) => {
    const b = Buffer.alloc(2);
    b.writeInt16BE(n);
    return b;
  };
  const i32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n);
    return b;
  };
  const utf = (s) => {
    const b = Buffer.from(s, "utf8");
    return Buffer.concat([i16(b.length), b]);
  };

  const dict = [
    "sorter", "unloader", "item-source", "liquid-source",
    "bridge-conduit", "turbine-generator", "legacy-command-center", "illuminator",
  ];
  // tiles: [blockIndex, x, y, config(int), rot]
  const tiles = [
    [0, 0, 0, 4, 1],
    [1, 1, 0, -1, 0],
    [2, 2, 0, 0, 0],
    [3, 3, 0, 3, 0],
    [4, 4, 0, pack(6, 0), 0],
    [5, 5, 0, 999, 0],
    [6, 6, 0, 0, 0],
    [7, 7, 0, 7, 2],
  ];
  const parts = [i16(8), i16(1), u8(0), u8(dict.length)];
  for (const d of dict) parts.push(utf(d));
  parts.push(i32(tiles.length));
  for (const [bi, x, y, cfg, rot] of tiles) {
    parts.push(u8(bi), i32(pack(x, y)), i32(cfg), u8(rot));
  }
  const body = Buffer.concat(parts);
  const container = Buffer.concat([Buffer.from([0x6d, 0x73, 0x63, 0x68, 0x00]), zlib.deflateSync(body)]);
  const schem = await parseSchematic(bytesToBase64(new Uint8Array(container)));

  check("v0：version=0 解析成功", schem.version === 0 && schem.width === 8 && schem.height === 1, `v=${schem.version} ${schem.width}x${schem.height}`);
  check("v0：LegacyBlock 被跳过（8→7）", schem.tiles.length === 7, `len=${schem.tiles.length}`);
  check(
    "v0：sorter item id4=sand",
    schem.tiles[0].block === "sorter" && schem.tiles[0].config_type === "content" && schem.tiles[0].config === "sand" && schem.tiles[0].rot === 1,
    JSON.stringify(schem.tiles[0])
  );
  check("v0：unloader value=-1 → null", schem.tiles[1].config_type === "content" && schem.tiles[1].config === null, JSON.stringify(schem.tiles[1]));
  check("v0：item-source id0=copper", schem.tiles[2].config === "copper", JSON.stringify(schem.tiles[2]));
  check("v0：liquid-source id3=cryofluid", schem.tiles[3].config === "cryofluid", JSON.stringify(schem.tiles[3]));
  check(
    "v0：bridge-conduit packed 相对点 = [2,0]",
    schem.tiles[4].config_type === "point2" && JSON.stringify(schem.tiles[4].config) === JSON.stringify([2, 0]),
    JSON.stringify(schem.tiles[4])
  );
  check("v0：旧名回退 turbine-generator→steam-generator", schem.tiles[5].block === "steam-generator", schem.tiles[5].block);
  check("v0：illuminator 原样 int=7", schem.tiles[6].block === "illuminator" && schem.tiles[6].config_type === "int" && schem.tiles[6].config === 7, JSON.stringify(schem.tiles[6]));
  check("v0：block_dict 已应用回退", schem.block_dict[5] === "steam-generator", schem.block_dict[5]);
  check("FALLBACK_BLOCKS 51 项", Object.keys(FALLBACK_BLOCKS).length === 51, Object.keys(FALLBACK_BLOCKS).length);
  check("LEGACY_BLOCKS 含 legacy-command-center", LEGACY_BLOCKS.has("legacy-command-center"));

  // ver=2 → 抛「更新版本」
  const c2 = Buffer.concat([Buffer.from([0x6d, 0x73, 0x63, 0x68, 0x02]), zlib.deflateSync(Buffer.from([0, 1, 0, 1, 0, 0, 0, 0, 0, 0]))]);
  let verErr = "";
  try {
    await parseSchematic(bytesToBase64(new Uint8Array(c2)));
  } catch (e) {
    verErr = e.message;
  }
  check("ver=2 → 抛「更新版本」", /更新版本/.test(verErr) && /v2/.test(verErr), verErr);

  // contentMap：官方 JSON 形式
  const cm = parseContentMap('{"0":{"copper":0,"sand":4},"4":{"water":0,"cryofluid":3}}');
  check(
    "contentMap JSON：type→name→id",
    cm.get("0,4") === "sand" && cm.get("4,3") === "cryofluid" && cm.get("0,0") === "copper",
    [...cm.entries()].map(([k, v]) => `${k}=${v}`).join(",")
  );
  // 仍兼容非标准旧形式
  const cm2 = parseContentMap("{0:{surge-alloy:12},4:{water:0}}");
  check("contentMap 非标准回退正则", cm2.get("0,12") === "surge-alloy" && cm2.get("4,0") === "water");

  // contentMap 中文键（模组物品场景：官方非严格 JSON，键含中文/模组前缀）
  const cm3 = parseContentMap("{0:{sand:4,一级协议:37}}");
  check("contentMap 中文键（非严格）", cm3.get("0,37") === "一级协议" && cm3.get("0,4") === "sand", JSON.stringify([...cm3]));
  const cm4 = parseContentMap('{"0":{"饱和火力-一级协议":37}}');
  check("contentMap 引号中文键", cm4.get("0,37") === "饱和火力-一级协议", JSON.stringify([...cm4]));
}

// -----------------------------------------------------------------------------
// 8d. 模组 drawer 静态层解析
// -----------------------------------------------------------------------------
function testDrawerLayers() {
  console.log("== 模组 drawer 静态层测试 ==");

  // 真实例：DrawDefault + DrawFlame → 只画本体
  let L = drawerStaticLayers({ base: "大窑炉", type: "GenericCrafter", drawer: ["DrawDefault", "DrawFlame"] });
  check("drawer：[DrawDefault,DrawFlame] → [base]", JSON.stringify(L) === JSON.stringify(["大窑炉"]), JSON.stringify(L));

  // DrawDefault + DrawCultivator + DrawRegion(-top) → top 常驻
  L = drawerStaticLayers({ base: "重型培养机", type: "GenericCrafter", drawer: ["DrawDefault", "DrawCultivator", { type: "DrawRegion", suffix: "-top" }] });
  check("drawer：培养机 → [base, base-top]", JSON.stringify(L) === JSON.stringify(["重型培养机", "重型培养机-top"]), JSON.stringify(L));

  // bottom + default + flame + -顶
  L = drawerStaticLayers({ base: "复合合金冶炼厂", type: "GenericCrafter", drawer: [{ type: "DrawRegion", suffix: "-bottom" }, "DrawDefault", { type: "DrawFlame" }, { type: "DrawRegion", suffix: "-顶" }] });
  check(
    "drawer：复合合金冶炼厂 → [-bottom, base, -顶]",
    JSON.stringify(L) === JSON.stringify(["复合合金冶炼厂-bottom", "复合合金冶炼厂", "复合合金冶炼厂-顶"]),
    JSON.stringify(L)
  );

  // 偏移项 x=20,y=-20 → dx=80, dy=80
  L = drawerStaticLayers({ base: "任务-油站", type: "GenericCrafter", drawer: [{ type: "DrawRegion", x: 20, y: -20 }] });
  check(
    "drawer：偏移 x20/y-20 → dx80/dy80",
    L.length === 1 && typeof L[0] === "object" && L[0].name === "任务-油站" && L[0].dx === 80 && L[0].dy === 80,
    JSON.stringify(L)
  );

  // 小写 drawRegion 识别
  L = drawerStaticLayers({ base: "相织布热压机", type: "GenericCrafter", drawer: [{ type: "drawRegion", suffix: "-bottom" }, "DrawDefault", { type: "DrawFlame" }] });
  check("drawer：小写 drawRegion 识别", JSON.stringify(L) === JSON.stringify(["相织布热压机-bottom", "相织布热压机"]), JSON.stringify(L));

  // DrawMulti 容器
  L = drawerStaticLayers({ base: "大窑炉", type: "GenericCrafter", drawer: { type: "DrawMulti", drawers: ["DrawDefault", "DrawFlame"] } });
  check("drawer：DrawMulti 递归", JSON.stringify(L) === JSON.stringify(["大窑炉"]), JSON.stringify(L));

  // 未知类型全部跳过（无有效项）→ type 默认
  L = drawerStaticLayers({ base: "X", type: "GenericCrafter", drawer: ["DrawFlame", "DrawGlowRegion", "DrawPistons", "DrawWarmupRegion"] });
  check("drawer：未知/工作态全跳过 → 默认 [base]", JSON.stringify(L) === JSON.stringify(["X"]), JSON.stringify(L));

  // type 默认行为
  check("type 默认 Drill → 三层", JSON.stringify(drawerStaticLayers({ base: "d", type: "Drill" })) === JSON.stringify(["d", "d-rotator", "d-top"]));
  check("type 默认 SolidPump → 三层", JSON.stringify(drawerStaticLayers({ base: "p", type: "SolidPump" })) === JSON.stringify(["p", "p-rotator", "p-top"]));
  check("type 默认 UnitFactory → 两层", JSON.stringify(drawerStaticLayers({ base: "f", type: "UnitFactory" })) === JSON.stringify(["f", "f-top"]));
  for (const t of ["GenericCrafter", "ForceProjector", "MendProjector", "OverdriveProjector", "ImpactReactor"]) {
    check(`type 默认 ${t} → [base]`, JSON.stringify(drawerStaticLayers({ base: "b", type: t })) === JSON.stringify(["b"]), t);
  }

  // MassDriver 无 drawer：-base 垫底（裂位驱动器场景）
  L = drawerStaticLayers({ base: "裂位驱动器", type: "MassDriver" }, (n) => n === "裂位驱动器-base");
  check("type 默认 MassDriver → [base-base, base]", JSON.stringify(L) === JSON.stringify(["裂位驱动器-base", "裂位驱动器"]), JSON.stringify(L));
  L = drawerStaticLayers({ base: "裂位驱动器", type: "MassDriver" }, () => false);
  check("MassDriver 无 -base → [base]", JSON.stringify(L) === JSON.stringify(["裂位驱动器"]), JSON.stringify(L));
  // 无类型信息：按贴图存在性启发式（-base 垫底、-top 置顶）
  L = drawerStaticLayers({ base: "X" }, (n) => n === "X-top");
  check("无类型 + 仅 -top → [base, base-top]", JSON.stringify(L) === JSON.stringify(["X", "X-top"]), JSON.stringify(L));
  L = drawerStaticLayers({ base: "Y" }, (n) => n === "Y-base");
  check("无类型 + 仅 -base → [base-base, base]", JSON.stringify(L) === JSON.stringify(["Y-base", "Y"]), JSON.stringify(L));
  // 其它类型默认
  check("type 默认 UnitAssembler → 两层", JSON.stringify(drawerStaticLayers({ base: "ua", type: "UnitAssembler" })) === JSON.stringify(["ua", "ua-top"]));
  check("type 默认 LiquidTurret → 两层", JSON.stringify(drawerStaticLayers({ base: "lt", type: "LiquidTurret" })) === JSON.stringify(["lt", "lt-top"]));
  check("type 默认 PayloadRouter → 两层", JSON.stringify(drawerStaticLayers({ base: "pr", type: "PayloadRouter" })) === JSON.stringify(["pr", "pr-top"]));
  check("type 默认 PayloadConveyor → [base]", JSON.stringify(drawerStaticLayers({ base: "pc", type: "PayloadConveyor" })) === JSON.stringify(["pc"]));
  check("type 小写 mendProjector → [base]", JSON.stringify(drawerStaticLayers({ base: "m", type: "mendProjector" })) === JSON.stringify(["m"]));
  check("type 默认 Drill 过滤缺失层", JSON.stringify(drawerStaticLayers({ base: "d2", type: "Drill" }, (n) => n === "d2-top")) === JSON.stringify(["d2", "d2-top"]));

  // 去重：DrawDefault 重复
  L = drawerStaticLayers({ base: "z", type: "GenericCrafter", drawer: ["DrawDefault", "DrawDefault"] });
  check("drawer：重复项去重", JSON.stringify(L) === JSON.stringify(["z"]), JSON.stringify(L));

  // 渲染冒烟：对象层带偏移（用 16×16 贴图，偏移 8px 后应落在 16..31）
  const W = 16;
  const small = (r, g, b) => {
    const rgba = new Uint8ClampedArray(W * W * 4);
    for (let i = 0; i < W * W; i++) {
      rgba[i * 4] = r;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = b;
      rgba[i * 4 + 3] = 255;
    }
    return { w: W, h: W, size: 1, rgba, placeholder: false };
  };
  setModLayers({ "任务-油站": [{ name: "任务-油站", dx: 8, dy: 8, rot: 0 }] });
  const schem = { width: 1, height: 1, tiles: [{ block: "任务-油站", x: 0, y: 0, rot: 0, config_type: "null", config: null }] };
  const res = renderSchematic(schem, { "任务-油站": small(1, 2, 3) }, { scale: 1, pad: 0, transparent: true, grid: false });
  const cw = TILE;
  check(
    "对象层偏移绘制：(30,30) 有色、(4,4) 空",
    res.rgba[(30 * cw + 30) * 4] === 1 && res.rgba[(30 * cw + 30) * 4 + 2] === 3 && res.rgba[(4 * cw + 4) * 4 + 3] === 0,
    `off=${res.rgba[(30 * cw + 30) * 4]} cornerA=${res.rgba[(4 * cw + 4) * 4 + 3]}`
  );
  setModLayers({});
}

// -----------------------------------------------------------------------------
// 8e. 类型驱动渲染规则表（render_rules.js）
// -----------------------------------------------------------------------------
function testRenderRules() {
  console.log("== 渲染规则表测试 ==");

  // (a) 每类至少 1 条：用合成 def 覆盖类型表所有键
  const X = { base: "x", type: "" };
  const typeCases = [
    ["Conveyor", ["x-0-0"]],
    ["ArmoredConveyor", ["x-0-0"]],
    ["StackConveyor", ["x"]],
    ["Conduit", ["conduit-bottom", "x-top-0"]],
    ["ArmoredConduit", ["conduit-bottom", "x-top-0"]],
    ["Duct", ["duct-bottom", "x-top-0"]],
    ["MassDriver", ["x-base", "x"]],
    ["Sorter", ["x"]],
    ["Unloader", ["x"]],
    ["DirectionalUnloader", ["x", "x-top"]],
    ["DuctRouter", ["x", "x-top"]],
    ["OverflowDuct", ["x", "x-top"]],
    ["StackRouter", ["x", "x-top"]],
    ["ItemBridge", ["x"]],
    ["BufferedItemBridge", ["x"]],
    ["LiquidBridge", ["x"]],
    ["DirectionLiquidBridge", ["x"]],
    ["DuctBridge", ["x"]],
    ["DirectionBridge", ["x"]],
    ["Drill", ["x", "x-rotator", "x-top"]],
    ["BurstDrill", ["x", "x-top"]],
    ["BeamDrill", ["x", "x-top"]],
    ["WallCrafter", ["x", "x-rotator-bottom", "x-rotator", "x-top"]],
    ["SolidPump", ["x", "x-rotator", "x-top"]],
    ["Fracker", ["x", "x-rotator", "x-top"]],
    ["Pump", ["x"]],
    ["GenericCrafter", null],
    ["AttributeCrafter", null],
    ["HeatCrafter", null],
    ["Separator", ["x"]],
    ["Battery", ["x", "x-top"]],
    ["NuclearReactor", ["x", "x-top"]],
    ["ConsumeGenerator", ["x", "x-top"]],
    ["ThermalGenerator", ["x", "x-rotator"]],
    ["PowerGenerator", ["x"]],
    ["LightBlock", ["x", "x-top"]],
    ["ImpactReactor", null],
    ["VariableReactor", null],
    ["ForceProjector", ["x"]],
    ["MendProjector", ["x", "x-top"]],
    ["OverdriveProjector", ["x", "x-top"]],
    ["RegenProjector", null],
    ["ShieldWall", ["x"]],
    ["BaseShield", ["x"]],
    ["Turret", ["x", "x-top"]],
    ["BaseTurret", ["x", "x-top"]],
    ["ItemTurret", ["x", "x-top"]],
    ["LiquidTurret", ["x", "x-top"]],
    ["PowerTurret", ["x", "x-top"]],
    ["PointDefenseTurret", ["x", "x-top"]],
    ["ContinuousTurret", ["x", "x-top"]],
    ["ContinuousLiquidTurret", ["x", "x-top"]],
    ["LaserTurret", ["x", "x-top"]],
    ["TractorBeamTurret", ["x", "x-top"]],
    ["RepairTurret", ["x", "x-top"]],
    ["UnitFactory", ["x", "x-top"]],
    ["Reconstructor", ["x", "x-top"]],
    ["UnitAssembler", ["x", "x-top"]],
    ["UnitAssemblerModule", ["x", "x-top"]],
    ["LegacyUnitFactory", ["x", "x-top"]],
    ["UnitCargoUnloadPoint", ["x", "x-top"]],
    ["Constructor", ["x", "x-top"]],
    ["PayloadDeconstructor", ["x", "x-top"]],
    ["PayloadRouter", ["x", "x-top"]],
    ["PayloadConveyor", ["x"]],
    ["PayloadLoader", ["x", "x-top"]],
    ["PayloadUnloader", ["x", "x-top"]],
    ["PayloadSource", ["x", "x-top"]],
    ["PayloadVoid", ["x", "x-top"]],
    ["PayloadMassDriver", null],
    ["LiquidRouter", null],
    ["LiquidSource", ["x"]],
    ["ItemSource", ["x"]],
    ["Thruster", ["x", "x-top"]],
    ["Incinerator", ["x", "x-top"]],
    ["ItemIncinerator", ["x", "x-top"]],
  ];
  let typeOk = 0;
  for (const [type, exp] of typeCases) {
    const r = vanillaRule("x", { base: "x", type });
    const got = r.regions ? r.regions(0) : null;
    if (JSON.stringify(got) === JSON.stringify(exp)) typeOk++;
    else check(`类型规则 ${type}`, false, `${JSON.stringify(got)} != ${JSON.stringify(exp)}`);
  }
  check(`类型规则表 ${typeCases.length} 类 regions(0)`, typeOk === typeCases.length, `${typeOk}/${typeCases.length}`);

  // (b) regions(rot)：Conveyor 取 0 号变体（形状），旋转由 render.js 施加
  check("Conveyor regions 与 rot 无关", JSON.stringify(vanillaRule("conveyor").regions(2)) === JSON.stringify(["conveyor-0-0"]));
  // (c) 模组无 drawer 时按 type 套规则（含变体命名）
  check("模组 Conveyor 规则", JSON.stringify(vanillaRule("模组-带子", { base: "模组-带子", type: "Conveyor" }).regions(0)) === JSON.stringify(["模组-带子-0-0"]));
  check("模组 Conduit 规则", JSON.stringify(vanillaRule("m-c", { base: "m-c", type: "Conduit" }).regions(0)) === JSON.stringify(["conduit-bottom", "m-c-top-0"]));

  // (d) 变体兜底命名
  check("变体：titanium-conveyor", JSON.stringify(spriteVariantCandidates("titanium-conveyor")) === JSON.stringify(["titanium-conveyor-0-0"]));
  check("变体：conduit", JSON.stringify(spriteVariantCandidates("conduit")) === JSON.stringify(["conduit-top-0", "conduit-bottom"]));
  check("变体：armored-duct", JSON.stringify(spriteVariantCandidates("armored-duct")) === JSON.stringify(["armored-duct-top-0", "duct-bottom"]));
  check("变体：mechanical-drill 保留旧兜底", JSON.stringify(spriteVariantCandidates("mechanical-drill")) === JSON.stringify(["mechanical-drill-0-0", "mechanical-drill-bottom", "mechanical-drill-top-0"]));

  // (e) 桥：类判定 + range
  check("phase-conveyor 是桥且 range=12", isBridgeBlock("phase-conveyor") && bridgeRange("phase-conveyor") === 12, JSON.stringify(vanillaRule("phase-conveyor").bridge));
  check("bridge-conveyor range=4", vanillaRule("bridge-conveyor").bridge && vanillaRule("bridge-conveyor").bridge.range === 4);
  check("duct-bridge 是桥", isBridgeBlock("duct-bridge"));
  check("reinforced-bridge-conduit 是桥", isBridgeBlock("reinforced-bridge-conduit"));
  check("mass-driver 非桥", !isBridgeBlock("mass-driver"));
  check("isBridgeBlockName 兼容 legacy 名单", isBridgeBlockName("bridge") && isBridgeBlockName("phase-bridge"));

  // (f) 配置种类（两种观感）
  check("configKind Sorter=item", configKindOf("sorter") === "item" && configKindOf("item-source") === "item");
  check("configKind Unloader=centerTint", configKindOf("unloader") === "centerTint" && configKindOf("duct-unloader") === "centerTint");
  check("configKind LiquidSource=liquidSource", configKindOf("liquid-source") === "liquidSource");
  check("configKind 普通方块=null", configKindOf("kiln") === null);
  check("configSpriteNamesFor(unloader)", JSON.stringify(configSpriteNamesFor("unloader")) === JSON.stringify(["unloader-center"]));
  check("configSpriteNamesFor(sorter)", JSON.stringify(configSpriteNamesFor("sorter")) === JSON.stringify(["cross-full"]));
  check("configSpriteNamesFor(liquid-source)", JSON.stringify(configSpriteNamesFor("liquid-source")) === JSON.stringify(["source-bottom", "fluid"]));

  // (g) workingOnly
  check("workingOnly：force-projector", vanillaRule("force-projector").workingOnly === true);
  check("workingOnly：shield-wall/base-shield", vanillaRule("s", { base: "s", type: "ShieldWall" }).workingOnly === true && vanillaRule("s", { base: "s", type: "BaseShield" }).workingOnly === true);
  check("workingOnly：GenericCrafter=false", vanillaRule("kiln").workingOnly === false);

  // (h) vanilla 类型表（gen_vanilla_blocks.py 生成）
  check("VANILLA_BLOCKS conveyor=Conveyor", VANILLA_BLOCKS.conveyor.type === "Conveyor" && VANILLA_BLOCKS.conveyor.size === 1);
  check("VANILLA_BLOCKS mass-driver size3/range440", VANILLA_BLOCKS["mass-driver"].size === 3 && VANILLA_BLOCKS["mass-driver"].range === 440);
  check("VANILLA_BLOCKS 覆盖 >300 方块", Object.keys(VANILLA_BLOCKS).length > 300, Object.keys(VANILLA_BLOCKS).length);
  check("typeOfBlock/sizeOfBlock", typeOfBlock("phase-conduit") === "LiquidBridge" && sizeOfBlock("blast-drill") === 4);
  check("hasTypeRule", hasTypeRule("conveyor") === true && hasTypeRule("x", { type: "NoSuchType" }) === false);

  // (i) 回归：titanium-conveyor 区域 + 规则驱动渲染（缺本体图也能画）
  check("回归：titanium-conveyor regions", JSON.stringify(vanillaRule("titanium-conveyor").regions(0)) === JSON.stringify(["titanium-conveyor-0-0"]));
  {
    const W = TILE;
    const mk = (r, g, b, a) => {
      const rgba = new Uint8ClampedArray(W * W * 4);
      for (let i = 0; i < W * W; i++) {
        rgba[i * 4] = r;
        rgba[i * 4 + 1] = g;
        rgba[i * 4 + 2] = b;
        rgba[i * 4 + 3] = a;
      }
      return { w: W, h: W, size: 1, rgba, placeholder: false };
    };
    const schem = {
      width: 1,
      height: 1,
      tiles: [{ block: "titanium-conveyor", x: 0, y: 0, rot: 1, config_type: "null", config: null }],
    };
    // 只有变体贴图，没有本体图：规则应解析到 titanium-conveyor-0-0
    const res = renderSchematic(schem, { "titanium-conveyor-0-0": mk(7, 8, 9, 255) }, { scale: 1, pad: 0, transparent: true });
    check("回归：titanium-conveyor 规则渲染", res.rgba[0] === 7 && res.rgba[1] === 8 && res.rgba[2] === 9, [res.rgba[0], res.rgba[1], res.rgba[2]].join(","));
  }

  // (j) 回归：conduit/duct 双层 + unloader 中心色（规则路径）
  {
    const W = TILE;
    const mk = (r, g, b, a) => {
      const rgba = new Uint8ClampedArray(W * W * 4);
      for (let i = 0; i < W * W; i++) {
        rgba[i * 4] = r;
        rgba[i * 4 + 1] = g;
        rgba[i * 4 + 2] = b;
        rgba[i * 4 + 3] = a;
      }
      return { w: W, h: W, size: 1, rgba, placeholder: false };
    };
    // 底层 conduit-bottom 红，顶层 conduit-top-0 绿（不透明）→ 顶层覆盖
    const cond = renderSchematic(
      { width: 1, height: 1, tiles: [{ block: "conduit", x: 0, y: 0, rot: 0, config_type: "null", config: null }] },
      { "conduit-bottom": mk(200, 0, 0, 255), "conduit-top-0": mk(0, 200, 0, 255) },
      { scale: 1, pad: 0, transparent: true }
    );
    check("回归：conduit 双层（top 覆盖）", cond.rgba[0] === 0 && cond.rgba[1] === 200 && cond.rgba[2] === 0, [cond.rgba[0], cond.rgba[1], cond.rgba[2]].join(","));
    const duct = renderSchematic(
      { width: 1, height: 1, tiles: [{ block: "duct", x: 0, y: 0, rot: 0, config_type: "null", config: null }] },
      { "duct-bottom": mk(200, 0, 0, 255), "duct-top-0": mk(0, 0, 200, 255) },
      { scale: 1, pad: 0, transparent: true }
    );
    check("回归：duct 双层（top 覆盖）", duct.rgba[0] === 0 && duct.rgba[1] === 0 && duct.rgba[2] === 200, [duct.rgba[0], duct.rgba[1], duct.rgba[2]].join(","));

    const titanium = CONTENT_COLORS.titanium;
    const unl = renderSchematic(
      { width: 1, height: 1, tiles: [{ block: "unloader", x: 0, y: 0, rot: 0, config_type: "content", config: "titanium" }] },
      { unloader: mk(0, 0, 0, 0), "unloader-center": mk(255, 255, 255, 255) },
      { scale: 1, pad: 0, transparent: true }
    );
    check(
      "回归：unloader 中心色（titanium）",
      unl.rgba[0] === titanium[0] && unl.rgba[1] === titanium[1] && unl.rgba[2] === titanium[2],
      [unl.rgba[0], unl.rgba[1], unl.rgba[2]].join(",")
    );
  }

  // (k) staticLayerNames：规则 → vanilla LAYERS → 默认；模组注入优先
  check("staticLayerNames conveyor", JSON.stringify(staticLayerNames("conveyor", 0)) === JSON.stringify(["conveyor-0-0"]));
  check("staticLayerNames liquid-tank 回退 LAYERS", JSON.stringify(staticLayerNames("liquid-tank", 0)) === JSON.stringify(["liquid-tank-bottom", "liquid-tank"]));
  check("staticLayerNames kiln 回退 LAYERS", JSON.stringify(staticLayerNames("kiln", 0)) === JSON.stringify(["kiln", "kiln-top"]));
  setModBlockDefs(new Map([["m-belt", { base: "m-belt", type: "Conveyor" }]]));
  check("staticLayerNames 模组无 drawer 走规则", JSON.stringify(staticLayerNames("m-belt", 0)) === JSON.stringify(["m-belt-0-0"]));
  setModLayers({ "m-belt": ["m-belt", "m-belt-top"] });
  check("staticLayerNames 模组 drawer 优先", JSON.stringify(staticLayerNames("m-belt", 0)) === JSON.stringify(["m-belt", "m-belt-top"]));
  setModLayers({});
  setModBlockDefs(new Map());
}

// -----------------------------------------------------------------------------
// 8.5 邻居拼接（Autotiler）+ 炮塔部件（DrawTurret / RegionPart）
// -----------------------------------------------------------------------------
function testBlending() {
  console.log("== 邻居拼接（Autotiler）测试 ==");
  const C = "titanium-conveyor";
  const P = (x, y, rot = 0) => ({ block: C, x, y, rot });
  const bits = (tiles, tx, ty) => {
    const w = makeTileWorld(tiles, (n) => blockProps(n));
    const t = tiles.find((v) => v.x === tx && v.y === ty);
    return buildBlending(w, { x: t.x, y: t.y, block: t.block, rot: t.rot }, t.rot);
  };
  // 方向助手
  check("mod4", mod4(-1) === 3 && mod4(5) === 1);
  check("d4 方向 0=E 1=N 2=W 3=S", d4x(0) === 1 && d4y(1) === 1 && d4x(2) === -1 && d4y(3) === -1);
  check("relativeTo 指向", relativeTo(0, 1, 0, 0) === 3 && relativeTo(1, 0, 0, 0) === 2 && relativeTo(0, 0, 0, 1) === 1);
  check("getFacingEdge size1", JSON.stringify(getFacingEdge(1, 5, 5, { x: 6, y: 5 })) === JSON.stringify({ x: 5, y: 5 }));
  check("getFacingEdge size3 钳制", JSON.stringify(getFacingEdge(3, 5, 5, { x: 5, y: 9 })) === JSON.stringify({ x: 5, y: 6 }));

  // transformCase 对照官方
  const tc = (n) => { const b = { blendbits: 0, xscl: 1, yscl: 1 }; transformCase(n, b); return [b.blendbits, b.yscl]; };
  check("transformCase 0->3", deepEqual(tc(0), [3, 1]));
  check("transformCase 1->4", deepEqual(tc(1), [4, 1]));
  check("transformCase 2->2", deepEqual(tc(2), [2, 1]));
  check("transformCase 3->2/-1", deepEqual(tc(3), [2, -1]));
  check("transformCase 4->1/-1", deepEqual(tc(4), [1, -1]));
  check("transformCase 5->1", deepEqual(tc(5), [1, 1]));
  check("transformCase -1->0", deepEqual(tc(-1), [0, 1]));

  // 合成场景（方向严格对齐：邻居朝向本方块或本方块朝邻居）
  const S = [
    ["直-横", [P(0, 0), P(1, 0), P(2, 0)], 1, 0],
    ["直-纵", [P(0, 0, 1), P(0, 1, 1), P(0, 2, 1)], 0, 1],
    ["弯 E->N", [P(0, 0), P(1, 0, 1), P(1, 1, 1)], 1, 0],
    ["T E/W/N", [P(0, 0), P(1, 0), P(2, 0), P(1, 1, 3)], 1, 0],
    ["十字", [P(0, 0), P(1, 0), P(2, 0), P(1, 1, 3), P(1, -1, 1)], 1, 0],
    ["无邻居", [P(0, 0)], 0, 0],
  ];
  const expect = { "直-横": [0, 0b0101], "直-纵": [0, 0b0101], "弯 E->N": [1, 0b1001], "T E/W/N": [2, 0b1101], "十字": [3, 0b1111], "无邻居": [0, 0b0000] };
  for (const [name, tiles, tx, ty] of S) {
    const b = bits(tiles, tx, ty);
    check(`拼接 ${name} blendbits`, b.blendbits === expect[name][0], `got ${b.blendbits} exp ${expect[name][0]}`);
    check(`拼接 ${name} blendmask`, b.blendmask === expect[name][1], `got ${b.blendmask.toString(2)} exp ${expect[name][1].toString(2)}`);
  }
  check("拼接 T E/W/N yscl=-1", bits([P(0, 0), P(1, 0), P(2, 0), P(1, 1, 3)], 1, 0).yscl === -1);

  // 旋转不变性：直段旋转 4 个角度形状一致
  for (let rot = 0; rot < 4; rot++) {
    // 沿 rot 方向排三格
    const step = [d4x(rot), d4y(rot)];
    const tiles = [
      { block: C, x: 0 - step[0], y: 0 - step[1], rot },
      { block: C, x: 0, y: 0, rot },
      { block: C, x: 0 + step[0], y: 0 + step[1], rot },
    ];
    const b = bits(tiles, 0, 0);
    check(`直段 rot=${rot} -> blendbits 0`, b.blendbits === 0, `got ${b.blendbits}`);
  }

  // 蓝图外邻居视为无连接
  const alone = makeTileWorld([P(0, 0)], (n) => blockProps(n));
  check("蓝图外无连接", blends(alone, { x: 0, y: 0, block: C, rot: 0 }, 0, 0) === false);

  // 导管只连有液体的邻居；装甲传送带按 outputsItems 连接
  const ductWorld = makeTileWorld([{ block: "plated-conduit", x: 0, y: 0, rot: 0 }, { block: "liquid-router", x: 1, y: 0, rot: 0 }], (n) => blockProps(n));
  check("导管连接液体邻居", blends(ductWorld, { x: 0, y: 0, block: "plated-conduit", rot: 0 }, 0, 0) === true);
  const ductNo = makeTileWorld([{ block: "plated-conduit", x: 0, y: 0, rot: 0 }, { block: "item-source", x: 1, y: 0, rot: 0 }], (n) => blockProps(n));
  check("导管不连物品邻居", blends(ductNo, { x: 0, y: 0, block: "plated-conduit", rot: 0 }, 0, 0) === false);
  const arm = makeTileWorld([{ block: "armored-duct", x: 0, y: 0, rot: 0 }, { block: "item-source", x: 1, y: 0, rot: 0 }], (n) => blockProps(n));
  check("装甲管道连物品源", blends(arm, { x: 0, y: 0, block: "armored-duct", rot: 0 }, 0, 0) === true);
  check("autotilerSpriteNames conveyor 5 变体", autotilerSpriteNames("titanium-conveyor").filter((n) => /-\d-0$/.test(n)).length === 5);
}

function testTurretParts() {
  console.log("== 炮塔部件（DrawTurret/RegionPart）测试 ==");
  check("VANILLA_TURRETS 收录 duo", !!VANILLA_TURRETS.duo);
  check("duo 双炮管", deepEqual(VANILLA_TURRETS.duo.parts.map((p) => p.suffix), ["-barrel-l", "-barrel-r"]));
  check("scatter -mid", VANILLA_TURRETS.scatter.parts.length === 1 && VANILLA_TURRETS.scatter.parts[0].suffix === "-mid");
  check("breach 仅 basePrefix", VANILLA_TURRETS.breach.basePrefix === "reinforced-" && VANILLA_TURRETS.breach.parts.length === 0);
  check("smite blade-bar y 序列", deepEqual(VANILLA_TURRETS.smite.parts.filter((p) => p.suffix === "-blade-bar").map((p) => p.y), [11, 1.5, -8]));
  check("sublimate 部件 x/y", deepEqual(VANILLA_TURRETS.sublimate.parts.map((p) => [p.suffix, p.x, p.y]), [["-back", 5.5, -0.25], ["-front", 5, 4.25], ["-nozzle", 0, 0]]));

  check("isTurretBlock ItemTurret", isTurretBlock("scatter"));
  check("isTurretBlock 非 Turret 子类", !isTurretBlock("build-tower") && !isTurretBlock("repair-turret"));
  check("isAutotilerBlock", isAutotilerBlock("titanium-conveyor") && isAutotilerBlock("armored-duct") && isAutotilerBlock("plated-conduit"));
  check("isAutotilerBlock 桥不算", !isAutotilerBlock("bridge-conveyor"));

  const info = turretInfo("disperse");
  check("disperse basePrefix", info.basePrefix === "reinforced-");
  check("disperse 部件含镜像", info.parts.some((p) => p.mirror));
  check("turretFallbackBaseName breach", turretFallbackBaseName("breach") === "reinforced-block-3");
  check("turretFallbackBaseName foreshadow", turretFallbackBaseName("foreshadow") === "block-4");
  check("turretSpriteNames scatter 含 mid", turretSpriteNames("scatter").includes("scatter-mid"));
  check("turretSpriteNames disperse 含 -r/-l", turretSpriteNames("disperse").includes("disperse-side-r") && turretSpriteNames("disperse").includes("disperse-side-l"));

  // 炮塔渲染：合成贴图验证 base/本体/部件都被画出来（不崩溃且区域非空）
  const B = spriteFromColor(TILE, TILE, 10, 20, 30, 255); // base 蓝灰（整格）
  const body = spriteFromColor(TILE - 8, TILE - 8, 200, 0, 0, 255); // 本体红（略小，露出 base）
  const part = spriteFromColor(8, 8, 0, 200, 0, 255); // 部件绿（中心小块）
  const tiles = [{ block: "scatter", x: 0, y: 0, rot: 1, config_type: "null", config: null }];
  const res = renderSchematic({ width: 4, height: 4, tiles }, { scatter: body, "scatter-mid": part, "block-2": B }, { scale: 1, pad: 0, transparent: true });
  let hasRed = false, hasGreen = false, hasBlue = false;
  for (let i = 0; i < res.rgba.length; i += 4) {
    if (res.rgba[i] > 150 && res.rgba[i + 1] < 80) hasRed = true;
    if (res.rgba[i + 1] > 150 && res.rgba[i] < 80) hasGreen = true;
    if (res.rgba[i + 2] > 20 && res.rgba[i] < 40 && res.rgba[i + 1] < 40) hasBlue = true;
  }
  check("炮塔渲染含 base/本体/部件", hasRed && hasGreen && hasBlue, `red=${hasRed} green=${hasGreen} blue=${hasBlue}`);
}

// -----------------------------------------------------------------------------
// 8.6 原版贴图请求 / 识别审查（误报「贴图缺失 / 未识别」全量排查）
// -----------------------------------------------------------------------------
function testSpriteAudit() {
  console.log("== 原版贴图请求/识别审查测试 ==");
  const idx = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "sprite_index.json"), "utf8"));
  const exists = (n) => !!(idx.blocks[n] || idx.all[n]);
  // 与 loadSprite 一致的「可解析」：本体 / 类型变体 / 序号帧
  const resolvable = (n) => {
    if (exists(n)) return true;
    for (const c of spriteVariantCandidates(n)) if (exists(c)) return true;
    if (exists(n + "1")) return true;
    return false;
  };
  // 环境/装饰与旧版块不参与蓝图渲染，缺图可接受
  const ENV_TYPES = new Set([
    "Floor", "StaticWall", "StaticProp", "Prop", "StaticTree", "TreeBlock", "SeaBush", "Seaweed",
    "ShallowLiquid", "OverlayFloor", "Cliff", "TallBlock", "CharacterOverlay", "RuneOverlay",
    "ColoredFloor", "ColoredWall", "SteamVent", "AirBlock", "SpawnBlock", "RemoveOre", "RemoveWall",
    "LegacyCommandCenter", "LegacyMechPad", "LegacyUnitFactory",
  ]);
  const isEnv = (b) => ENV_TYPES.has(typeOfBlock(b)) || b.startsWith("legacy-");

  // 复刻 main.js collectNeeded 的请求逻辑（含「可选层只在索引存在时请求」）
  const neededFor = (b) => {
    const needed = new Map();
    const add = (n, req) => { if (!n) return; if (!needed.has(n)) needed.set(n, req); else if (req) needed.set(n, true); };
    const addOpt = (n) => { if (exists(n)) add(n, false); };
    if (isTurretBlock(b)) {
      for (const n of turretSpriteNames(b)) addOpt(n);
    } else if (isAutotilerBlock(b)) {
      const names = autotilerSpriteNames(b);
      if (names.length) add(names[0], true);
      for (const n of names) addOpt(n);
    } else {
      add(b, true);
      for (const l of staticLayerNames(b, 0)) {
        const lname = typeof l === "string" ? l : l && l.name;
        if (!lname) continue;
        if (lname === b) add(lname, true);
        else addOpt(lname);
      }
    }
    if (isBridgeBlockName(b)) { addOpt(b + "-bridge"); addOpt(b + "-arrow"); }
    for (const n of configSpriteNamesFor(b)) addOpt(n);
    return needed;
  };
  const isKnown = (b) => {
    if (exists(b)) return true;
    for (const c of spriteVariantCandidates(b)) if (exists(c)) return true;
    if (exists(b + "1")) return true;
    return !!typeOfBlock(b);
  };

  const blocks = Object.keys(VANILLA_BLOCKS);
  const requiredMissing = [];
  const unknown = [];
  let optRequested = 0;
  let optMissingRequested = 0;
  for (const b of blocks) {
    const needed = neededFor(b);
    for (const [n, req] of needed) {
      if (req) { if (!resolvable(n) && !isEnv(b)) requiredMissing.push(`${b} -> ${n}`); }
      else {
        optRequested++;
        if (!exists(n)) optMissingRequested++;
      }
    }
    if (!isKnown(b) && !isEnv(b)) unknown.push(`${b}(${typeOfBlock(b)})`);
  }
  check(`原版方块 ${blocks.length} 个`, blocks.length >= 400, `${blocks.length}`);
  check("无「必需贴图缺失」误报（环境/旧版除外）", requiredMissing.length === 0, requiredMissing.slice(0, 12).join(", "));
  check("无「未识别方块」误报", unknown.length === 0, unknown.slice(0, 12).join(", "));
  check("可选层请求全部命中索引（无无谓 404）", optMissingRequested === 0, `missing optional=${optMissingRequested}/${optRequested}`);

  // air-factory：有本体、不请求不存在的 air-factory-top
  const af = neededFor("air-factory");
  check("air-factory 本体必需", af.get("air-factory") === true);
  check("air-factory 不请求不存在的 -top", !af.has("air-factory-top"));
  check("air-factory 被视为已知方块", isKnown("air-factory"));

  // 警告策略：只有 required 缺失才进 missing
  const fake = (name, required, sprite) => ({ name, required, sprite });
  check("selectMissingSprites 忽略可选缺失",
    deepEqual(selectMissingSprites([fake("air-factory", true, { placeholder: false }), fake("air-factory-top", false, null)]), []));
  check("selectMissingSprites 报告必需缺失",
    deepEqual(selectMissingSprites([fake("air-factory", true, null), fake("x-top", false, { placeholder: true })]), ["air-factory"]));

  // 原型键撞名回归：constructor 方块必须得到数组层名、请求不崩
  const cLayers = staticLayerNames("constructor", 0);
  check("constructor 层名为数组", Array.isArray(cLayers) && cLayers.length > 0, JSON.stringify(cLayers));
  let threw = false;
  try { neededFor("constructor"); } catch (e) { threw = true; }
  check("constructor 收集需求不抛错", !threw);
}

// -----------------------------------------------------------------------------
// 9. 镜像源切换 / 超时 / 缓存（注入 mock fetch 与 mock Cache Storage）
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
  testSpriteNames();
  testHistory();
  await testFileInput();
  testConfigRender();
  testDrawerLayers();
  testRenderRules();
  testBlending();
  testTurretParts();
  testSpriteAudit();
  await testV0();
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
