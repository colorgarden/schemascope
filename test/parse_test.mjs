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
  drawBeam,
  renderSchematic,
  drawGrid,
  makePlaceholder,
} from "../js/render.js";
import { LAYERS, OUTLINE_ICON, TILE, CONTENT_CN } from "../js/data.js";
import { setIconIndex, resolveIcon, richText, plainTextWithIcons, ICON_FONT_LO } from "../js/icons.js";
import { simpleHash, createPrefetchManager } from "../js/prefetch.js";

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

  // (e) 桥配对：示例蓝图应得 (2,5)-(6,5) 与 (2,7)-(6,7)
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
    "桥配对为 (2,5)-(6,5) 与 (2,7)-(6,7)",
    deepEqual(norm, ["2,5-6,5", "2,7-6,7"]),
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
  // mass-driver @4,6 size3 → lx=3, by=5（应落在布局内）
  const md = layout.entries.find((e) => e.tile.block === "mass-driver");
  check("layout mass-driver lx/by", md.lx === 3 && md.by === 5, `${md.lx},${md.by}`);
  check("layout cols", layout.cols === layout.max_right - layout.min_lx);
  check("layout rows", layout.rows === layout.max_top - layout.min_by);

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

  // richText
  const rt = richText(String.fromCharCode(63528));
  check("richText(63528) 含 img 与 liquid-water", rt.includes("msch-icon") && rt.includes("liquid-water"), rt);
  check("richText(63528) 含中文 alt 水", rt.includes('alt="水"'), rt);
  const emoji = String.fromCharCode(59394); // 0xE802
  check("richText(emoji) 保留原字符", richText(emoji) === emoji, richText(emoji));
  check("richText 普通中文不受影响", richText("接收台 ABC 123") === "接收台 ABC 123");
  check("richText 转义 HTML", richText("<b>&\"") === "&lt;b&gt;&amp;&quot;", richText('<b>&"'));

  // plainTextWithIcons
  check("plainTextWithIcons(63528) → [水]", plainTextWithIcons(String.fromCharCode(63528)) === "[水]");
  check("plainTextWithIcons(emoji) → 去掉", plainTextWithIcons("A" + emoji + "B") === "AB");
  check("plainTextWithIcons 普通文本原样", plainTextWithIcons("接收台") === "接收台");

  // 集成：示例信息板原文里的 U+F828 应渲染成水图标
  const msg = globalThis.__SCHEM.tiles.find((t) => t.block === "message");
  const hasWaterChar = msg && msg.config && msg.config.includes(String.fromCharCode(63528));
  check("示例信息板含 U+F828(水)", !!hasWaterChar);
  if (hasWaterChar) {
    const html = richText(msg.config);
    check("信息板 richText 含水图标", html.includes("msch-icon") && html.includes("liquid-water"));
  }
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
  testIcons();
  await testPrefetch();

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
