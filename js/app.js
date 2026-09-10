// =============================================================================
// app.js —— UI 逻辑（输入 → 解析 → 贴图加载 → 渲染 → 交互 → 导出）
// 对照 msch.py 的 build_html / HTML_TEMPLATE（热区、处理器按钮、图例、弹窗）
// =============================================================================

import {
  TILE,
  CONTENT_CN,
  LOCAL_SPRITE_DIR,
  AUX_PATHS,
  LAYERS,
  BRIDGE_BLOCKS,
  DEFAULT_SCALE,
  DEFAULT_PAD,
} from "./data.js";
import { parseSchematic, extractLogic, isProcessor } from "./parser.js";
import { renderSchematic, getSprite, makePlaceholder, setModLayers, setModBridges, setModOutline, setModPowerBlocks, setModPowerNodes, isBridgeType, isMassDriverType, isPowerNodeType } from "./render.js";
import { setIconIndex, richText, plainTextWithIcons, itemIconSrc } from "./icons.js";
import { simpleHash, createPrefetchManager } from "./prefetch.js";
import { fetchCached, fetchMindustryCached, clearPersistentCache, cacheInfo, putMod, listMods, deleteMod, clearMods } from "./cache.js";
import { preferredSource, sourceHost, SOURCE_DEFS, getChoiceKey, setChoiceKey, probeAllSources } from "./sources.js";
import { requirementsList } from "./requirements.js";
import { BLOCK_REQUIREMENTS } from "./requirements_data.js";
import { parseMod, modSpriteCandidates, modItemCandidates } from "./mod.js";
import { blockDisplayName as resolveBlockDisplayName } from "./names.js";
import { loadHistory, saveHistory, addHistory, removeHistory, formatRelativeTime, HISTORY_MAX_INPUT } from "./history.js";

// 版本号：与 index.html 的 ?v= 及页脚 .footer-ver 保持一致（发布时递增）
const APP_VERSION = "20260910b";

// -----------------------------------------------------------------------------
// DOM
// -----------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const els = {
  input: $("input-text"),
  file: $("file-input"),
  parseBtn: $("parse-btn"),
  scale: $("scale"),
  bgMode: $("bg-mode"),
  grid: $("grid"),
  laserRange: $("laser-alpha"),
  laserVal: $("laser-alpha-val"),
  bridgeRange: $("bridge-opacity"),
  bridgeVal: $("bridge-opacity-val"),
  status: $("status"),
  error: $("error"),
  procs: $("procs"),
  procsWrap: $("procs-wrap"),
  stage: $("stage"),
  stageFit: $("stage-fit"),
  canvas: $("canvas"),
  spots: $("spots"),
  legend: $("legend"),
  metaName: $("meta-name"),
  metaAuthor: $("meta-author"),
  metaSize: $("meta-size"),
  metaCount: $("meta-count"),
  metaProc: $("meta-proc"),
  labelsWrap: $("labels-wrap"),
  labels: $("labels"),
  reqWrap: $("req-wrap"),
  requirements: $("requirements"),
  exportBtn: $("export-btn"),
  tip: $("tip"),
  overlay: $("overlay"),
  modalTitle: $("modal-title"),
  modalPre: $("modal-pre"),
  modalX: $("modal-x"),
  copyBtn: $("copy-btn"),
  copyOk: $("copy-ok"),
  clearCache: $("clear-cache"),
  drop: $("drop"),
  modInput: $("mod-input"),
  modDrop: $("mod-drop"),
  modList: $("mod-list"),
  modClear: $("mod-clear"),
  sourceSelect: $("source-select"),
  sourceProbe: $("source-probe"),
  sourceCurrent: $("source-current"),
  sourceBadges: $("source-badges"),
  historyWrap: $("history-wrap"),
  historyList: $("history-list"),
  historyClear: $("history-clear"),
};

// -----------------------------------------------------------------------------
// 全局状态
// -----------------------------------------------------------------------------
let spriteIndex = { sprites_base: "core/assets-raw/", blocks: {}, items: {}, aux: {} };
const spriteCache = new Map(); // name -> sprite | null
let localBaseOk = null; // 推断 assets/sprites/ 是否存在，避免满屏 404
let current = null; // { schem, tiles, layout, name }
let currentText = "";
let renderOpts = { scale: DEFAULT_SCALE, pad: DEFAULT_PAD, transparent: false, grid: false, laserAlpha: 1, bridgeOpacity: 0.5 };

// ---- 模组状态 ----
let mods = []; // 已加载模组（parseMod 结果）
let modNames = []; // 模组内部名（用于去前缀）
let modOverrideIndex = new Map(); // basename -> 提供该贴图的模组（sprites-override）
let modNormalIndex = new Map(); // basename -> 提供该贴图的模组（sprites/）
let modLayersMap = {}; // 方块名 -> [贴图层名, ...]
let modBridgeNames = new Set(); // 模组桥方块名（内部名与 base）
let modBlockSizes = new Map(); // 方块名（内部名/base）-> size
let modRequirementsTable = {}; // 方块名 -> requirements
let modBundle = new Map(); // bundle key -> value（合并所有模组）

// -----------------------------------------------------------------------------
// 贴图加载
// -----------------------------------------------------------------------------

async function loadSpriteIndex() {
  try {
    const res = await fetchCached("sprite_index.json");
    if (res.ok) spriteIndex = await res.json();
  } catch (e) {
    // 使用内置兜底表（data.js 的 AUX_PATHS）
  }
}

/** 对照 msch.py _sprite_rel_path：blocks → items → aux(索引) → aux(兜底表)。 */
function spriteRelPath(name) {
  const tables = [spriteIndex.blocks, spriteIndex.items, spriteIndex.aux, AUX_PATHS];
  for (const table of tables) {
    if (table && Object.prototype.hasOwnProperty.call(table, name)) {
      const val = table[name];
      if (Array.isArray(val)) return { base: val[0], path: val[1] };
      return { base: spriteIndex.sprites_base || "", path: val };
    }
  }
  return null;
}

async function bitmapFromResponse(res) {
  if (!res || !res.ok) throw new Error("HTTP " + (res ? res.status : "0"));
  const blob = await res.blob();
  return await createImageBitmap(blob);
}

/** 同源贴图（本地 assets/sprites、sprite_index.json）。 */
async function fetchBitmapLocal(url) {
  return bitmapFromResponse(await fetchCached(url));
}

let lastSwitchNote = 0;
function noteSourceSwitch(from, to) {
  updateSourceCurrent(to);
  // 并发请求会同时切换，节流提示
  const now = Date.now();
  if (now - lastSwitchNote < 1500) return;
  lastSwitchNote = now;
  setStatus(`下载超时，已切换镜像：${sourceHost(to)}`);
}

/** Mindustry CDN 贴图：超时 + 镜像源自动切换 + 规范化缓存。 */
async function fetchBitmapMindustry(relPath) {
  return bitmapFromResponse(await fetchMindustryCached(relPath, { onSwitch: noteSourceSwitch }));
}

/** 当前贴图源小字显示（可传入实际使用的 url）。 */
function updateSourceCurrent(url) {
  if (!els.sourceCurrent) return;
  const u = url || preferredSource();
  const d = SOURCE_DEFS.find((x) => x.url === u);
  els.sourceCurrent.textContent = `当前：${d ? d.label : sourceHost(u)}`;
}

/** 填充「贴图源」下拉（自动 + 7 个源），并恢复上次选择。 */
function populateSourceSelect() {
  if (!els.sourceSelect) return;
  const frag = document.createDocumentFragment();
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = "自动（推荐）";
  frag.appendChild(auto);
  for (const d of SOURCE_DEFS) {
    const o = document.createElement("option");
    o.value = d.key;
    o.textContent = d.label;
    frag.appendChild(o);
  }
  els.sourceSelect.replaceChildren(frag);
  const cur = getChoiceKey();
  els.sourceSelect.value = SOURCE_DEFS.some((d) => d.key === cur) ? cur : "";
}

/** 高亮当前选中的徽章（key 为空表示自动）。 */
function markActiveBadge(key) {
  if (!els.sourceBadges) return;
  for (const b of els.sourceBadges.querySelectorAll(".src-badge")) {
    b.classList.toggle("active", b.dataset.key === (key || ""));
  }
}

/** 应用手动源选择：持久化 + 刷新当前渲染。 */
async function applySourceChoice(key) {
  setChoiceKey(key);
  if (els.sourceSelect) els.sourceSelect.value = key;
  markActiveBadge(key);
  updateSourceCurrent();
  await refreshAfterMods();
}

/** 并行探测全部源，结果渲染为可点击徽章。 */
async function runSourceProbe() {
  if (!els.sourceBadges) return;
  els.sourceBadges.replaceChildren();
  setStatus("检测镜像中…");
  try {
    const results = await probeAllSources({ timeoutMs: 4000 });
    const frag = document.createDocumentFragment();
    for (const r of results) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "src-badge " + (r.ok ? "ok" : "bad");
      b.dataset.key = r.key;
      b.title = r.url;
      b.innerHTML =
        esc(r.label) + `<span class="src-ms">${r.ok ? r.ms + "ms ✓" : "超时 ✗"}</span>`;
      frag.appendChild(b);
    }
    els.sourceBadges.replaceChildren(frag);
    markActiveBadge(getChoiceKey());
    setStatus("镜像检测完成（点击徽章可选用该源）。");
  } catch (e) {
    showError("镜像检测失败：" + e.message);
  }
}

function bitmapToSprite(bmp) {
  const w = bmp.width;
  const h = bmp.height;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const cx = c.getContext("2d", { willReadFrequently: true });
  cx.drawImage(bmp, 0, 0);
  const rgba = cx.getImageData(0, 0, w, h).data;
  if (bmp.close) bmp.close();
  return { w, h, size: Math.max(1, Math.floor(w / TILE)), rgba, placeholder: false };
}

// -----------------------------------------------------------------------------
// 模组：派生数据 / 贴图候选
// -----------------------------------------------------------------------------

async function blobToSprite(blob) {
  const bmp = await createImageBitmap(blob);
  return bitmapToSprite(bmp);
}

/** 解析 "#rrggbb" / "rrggbb" 描边色；失败返回 null。 */
function parseOutlineColor(v) {
  if (!v) return null;
  const s = String(v).trim().replace(/^#/, "");
  const m = /^([0-9a-fA-F]{6})$/.exec(s);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 由 mods 重建所有派生结构（贴图索引、多层表、桥/描边/电力、耗材、bundle）。 */
function rebuildModDerived() {
  modNames = mods.map((m) => m.name);
  modOverrideIndex = new Map();
  modNormalIndex = new Map();
  modBlockSizes = new Map();
  modRequirementsTable = {};
  modBundle = new Map();
  modLayersMap = {};
  modBridgeNames = new Set();
  const bridgeMap = new Map(); // name -> { range, width }
  const outlineMap = new Map(); // name -> [[r,g,b], radius]
  const powerNodesMap = new Map(); // name -> { scale, color1, color2 }
  const powerSet = new Set();

  for (const m of mods) {
    // override 优先；normal 中剔除同名（被 override 覆盖）
    for (const k of m.spritesOverride.keys()) modOverrideIndex.set(k, m);
    for (const k of m.sprites.keys()) {
      if (!m.spritesOverride.has(k)) modNormalIndex.set(k, m);
    }
    // 方块尺寸 + 耗材 + type 分类（内部名与 base 都注册）
    for (const [key, def] of m.blocks) {
      modBlockSizes.set(key, def.size);
      modRequirementsTable[key] = def.requirements;

      // 桥：type 以 Bridge 结尾（ItemBridge/LiquidBridge/…）
      if (isBridgeType(def.type)) {
        const info = { range: def.range }; // 宽度统一用原版 BRIDGE_WIDTH
        bridgeMap.set(key, info);
        if (!bridgeMap.has(def.base)) bridgeMap.set(def.base, info);
        modBridgeNames.add(key);
        modBridgeNames.add(def.base);
      }

      // 质量驱动器：描边 + 电力目标
      if (isMassDriverType(def.type)) {
        if (def.outlineIcon !== false) {
          const color = parseOutlineColor(def.outlineColor) || [0x40, 0x40, 0x49];
          const radius =
            def.outlineRadius !== undefined && def.outlineRadius !== null && !Number.isNaN(def.outlineRadius)
              ? def.outlineRadius
              : 4;
          const info = [color, radius];
          outlineMap.set(key, info);
          if (!outlineMap.has(def.base)) outlineMap.set(def.base, info);
        }
        powerSet.add(key);
        powerSet.add(def.base);
      }

      // 电力目标：hasPower===true 或 consumes.power 存在
      if (def.hasPower === true || def.consumesPower) {
        powerSet.add(key);
        powerSet.add(def.base);
      }

      // 电力节点：type 以 PowerNode 结尾 → 注册激光参数 + 作为可连目标
      if (isPowerNodeType(def.type)) {
        const info = {
          scale: def.laserScale,
          color1: def.laserColor1,
          color2: def.laserColor2,
        };
        powerNodesMap.set(key, info);
        if (!powerNodesMap.has(def.base)) powerNodesMap.set(def.base, info);
        powerSet.add(key);
        powerSet.add(def.base);
      }
    }
    // bundle
    for (const [k, v] of m.bundle) modBundle.set(k, v);
  }

  // 模组多层启发式：<base>-base 先画、<base> 居中、<base>-top 后画
  for (const m of mods) {
    const has = (n) => m.spritesOverride.has(n) || m.sprites.has(n);
    const seen = new Set();
    for (const [, def] of m.blocks) {
      if (seen.has(def.base)) continue;
      seen.add(def.base);
      const base = def.base;
      if (!has(base)) continue;
      const layers = [];
      if (has(base + "-base")) layers.push(base + "-base");
      layers.push(base);
      if (has(base + "-top")) layers.push(base + "-top");
      if (layers.length > 1) {
        modLayersMap[m.name + "-" + base] = layers;
        modLayersMap[base] = layers;
      }
    }
  }
  setModLayers(modLayersMap);
  setModBridges(bridgeMap);
  setModOutline(outlineMap);
  setModPowerBlocks(powerSet);
  setModPowerNodes(powerNodesMap);
}

/** 模组 sprites-override 贴图（懒解压）。 */
async function modOverrideSprite(name) {
  for (const c of modSpriteCandidates(name, modNames)) {
    const owner = modOverrideIndex.get(c);
    if (owner) {
      const blob = await owner.spritesOverride.get(c);
      if (blob) return blob;
    }
  }
  return null;
}

/** 模组 sprites 贴图（懒解压；override 已在前面处理）。 */
async function modNormalSprite(name) {
  for (const c of modSpriteCandidates(name, modNames)) {
    const owner = modNormalIndex.get(c);
    if (owner) {
      const blob = await owner.sprites.get(c);
      if (blob) return blob;
    }
  }
  return null;
}

/** 在模组贴图中按候选名查找（override 优先，再 normal）。 */
async function findModSprite(name) {
  return (await modOverrideSprite(name)) || (await modNormalSprite(name));
}

/** 精确键查找（不做候选/去前缀展开）：override 优先，再 normal。 */
async function findModSpriteExact(key) {
  const ow = modOverrideIndex.get(key);
  if (ow) {
    const b = await ow.spritesOverride.get(key);
    if (b) return b;
  }
  const nw = modNormalIndex.get(key);
  if (nw) {
    const b = await nw.sprites.get(key);
    if (b) return b;
  }
  return null;
}

/** 方块是否有已知定义（vanilla 索引 / sprites / 模组）。 */
function isKnownBlock(name) {
  if (spriteIndex.blocks && spriteIndex.blocks[name]) return true;
  if (spriteIndex.all && spriteIndex.all[name]) return true;
  if (modBlockSizes.has(name)) return true;
  for (const c of modSpriteCandidates(name, modNames)) {
    if (modBlockSizes.has(c) || (spriteIndex.all && spriteIndex.all[c]) || (spriteIndex.blocks && spriteIndex.blocks[c])) {
      return true;
    }
  }
  return false;
}

/** 耗材物品显示名：优先模组 bundle 的 item.<内部名>.name（尝试 <mod>-<ref> 与 <ref>）。 */
function modItemName(ref) {
  for (const m of mods) {
    const k1 = `item.${m.name}-${ref}.name`;
    const k2 = `item.${ref}.name`;
    if (m.bundle.has(k1)) return m.bundle.get(k1);
    if (m.bundle.has(k2)) return m.bundle.get(k2);
  }
  const hit = modBundle.get(`item.${ref}.name`);
  return hit || null;
}

/** 耗材物品图标：优先模组贴图（item-<ref> / <ref> / <ref>1 序号帧兜底，懒解压），返回 Blob 或 null。 */
async function modItemSprite(ref) {
  for (const c of modItemCandidates(ref)) {
    const b = await findModSpriteExact(c);
    if (b) return b;
  }
  return null;
}

/**
 * 加载单个贴图。顺序：内存 → 模组 sprites-override → 本地 assets/sprites →
 * CDN 镜像（超时/切换）→ 模组 sprites → 占位（尺寸优先取模组 JSON size）。
 * required=true 时缺失返回占位块；否则返回 null（叠加层缺失直接跳过）。
 */
async function loadSprite(name, required) {
  if (spriteCache.has(name)) return spriteCache.get(name);
  const cands = modSpriteCandidates(name, modNames);

  // 1. 模组 sprites-override
  {
    const blob = await modOverrideSprite(name);
    if (blob) {
      const sp = await blobToSprite(blob);
      spriteCache.set(name, sp);
      return sp;
    }
  }

  // 2. 本地 assets/sprites（自托管 vanilla）
  if (localBaseOk !== false) {
    for (const c of cands) {
      try {
        const bmp = await fetchBitmapLocal(LOCAL_SPRITE_DIR + c + ".png");
        const sp = bitmapToSprite(bmp);
        spriteCache.set(name, sp);
        localBaseOk = true;
        return sp;
      } catch (e) {
        localBaseOk = false;
        break;
      }
    }
  }

  // 3. CDN（vanilla 索引；镜像源自动切换）
  const rel = spriteRelPath(name);
  if (rel) {
    try {
      const bmp = await fetchBitmapMindustry(rel.base + rel.path);
      const sp = bitmapToSprite(bmp);
      spriteCache.set(name, sp);
      return sp;
    } catch (e) {
      // 继续尝试模组贴图
    }
  }

  // 4. 模组 sprites（普通）
  {
    const blob = await modNormalSprite(name);
    if (blob) {
      const sp = await blobToSprite(blob);
      spriteCache.set(name, sp);
      return sp;
    }
  }

  // 5. 占位（模组方块用 JSON size）
  const size = modBlockSizes.get(name) || 1;
  const sp = required ? makePlaceholder(size) : null;
  spriteCache.set(name, sp);
  return sp;
}

/** 收集本蓝图需要加载的贴图：name -> required。 */
function collectNeeded(schem) {
  const needed = new Map();
  const add = (n, req) => {
    if (!needed.has(n)) needed.set(n, req);
    else if (req) needed.set(n, true);
  };
  for (const t of schem.tiles) {
    add(t.block, true);
    const ls = LAYERS[t.block] || modLayersMap[t.block];
    if (ls) for (const l of ls) add(l, l === t.block);
    if (BRIDGE_BLOCKS.has(t.block) || modBridgeNames.has(t.block)) {
      add(t.block + "-bridge", false);
      add(t.block + "-arrow", false);
    }
  }
  for (const n of ["center", "cross", "laser", "laser-end", "schematic-background"]) add(n, false);
  return needed;
}

async function loadAllSprites(needed, onProgress) {
  const names = [...needed.keys()];
  const total = names.length;
  let done = 0;
  const missing = [];
  const batchSize = 16;
  for (let i = 0; i < names.length; i += batchSize) {
    const batch = names.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (name) => {
        const sp = await loadSprite(name, needed.get(name));
        if (!sp) missing.push(name);
        else if (sp.placeholder) missing.push(name);
        done++;
        if (onProgress) onProgress(done, total, name);
      })
    );
  }
  return { missing, total };
}

// -----------------------------------------------------------------------------
// 配置摘要 / 中文名 / 作者（对照 msch.py config_summary/_find_author/_collect_legend）
// -----------------------------------------------------------------------------

function stripTags(text) {
  return String(text == null ? "" : text).replace(/\[[^\]]*\]/g, "");
}

function configSummary(tile) {
  const ct = tile.config_type;
  const val = tile.config;
  if (val === null || val === undefined) return "";
  if (ct === "content") return CONTENT_CN[val] || val;
  if (ct === "string") return stripTags(val).trim().replace(/\n/g, " ").slice(0, 40);
  if (ct === "byteArray") return "逻辑代码 " + (val.length || 0) + " 字节";
  if (ct === "point2") return `链接偏移 (${val[0]},${val[1]})`;
  if (ct === "point2Array") {
    const pts = val.slice(0, 4).map((p) => `(${p[0]},${p[1]})`).join(", ");
    return `配置点 ${val.length} 个：${pts}`;
  }
  if (ct === "bool") return val ? "是" : "否";
  if (ct === "int" || ct === "long" || ct === "float" || ct === "double") {
    return formatNum(val);
  }
  if (ct === "intSeq" || ct === "intArray") return "整数序列 " + JSON.stringify(val.slice(0, 8));
  if (ct === "vec2") return `向量 (${val[0].toFixed(2)}, ${val[1].toFixed(2)})`;
  return String(val).slice(0, 40);
}

function formatNum(v) {
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toFixed(6)));
}

function findAuthor(schem) {
  for (const t of schem.tiles) {
    if (t.block === "message" && t.config_type === "string") {
      const text = stripTags(t.config || "");
      const m = text.match(/\bby\s+([^\n\r]+)/i);
      if (m) return m[1].trim();
    }
  }
  return "未知";
}

/** 方块显示名：模组语言文件 > 模组 JSON name > 内置 BLOCK_CN > 内部名。 */
function blockDisplayName(name) {
  return resolveBlockDisplayName(name, mods);
}

function collectLegend(schem) {
  const counts = new Map();
  for (const t of schem.tiles) counts.set(t.block, (counts.get(t.block) || 0) + 1);
  return [...counts.entries()]
    .map(([b, n]) => [blockDisplayName(b), n, b])
    .sort((e1, e2) => e2[1] - e1[1] || (e1[0] < e2[0] ? -1 : e1[0] > e2[0] ? 1 : 0));
}

/** 逐方块导出前端数据（对照 build_html 中的 tile_data / proc_buttons）。 */
async function buildTileData(schem, layout) {
  const tiles = [];
  const procButtons = [];
  let procCount = 0;
  for (let idx = 0; idx < schem.tiles.length; idx++) {
    const t = schem.tiles[idx];
    const e = layout.entry_by_index.get(idx);
    const cn = blockDisplayName(t.block);
    let kind = "";
    let code = "";
    let msg = "";
    let links = "";

    if (isProcessor(t.block) && t.config_type === "byteArray") {
      const logic = await extractLogic(t.config);
      if (logic && logic.code.trim()) {
        kind = "proc";
        code = logic.code;
        if (logic.links.length) {
          links = logic.links.map((l) => `${l.name}(${l.x},${l.y})`).join("、");
        }
        procCount++;
        procButtons.push({ i: idx, cn, x: t.x, y: t.y });
      }
    } else if (t.block === "message" && t.config_type === "string") {
      kind = "msg";
      msg = stripTags(t.config || "").trim();
    }

    let tip = configSummary(t);
    if (links) tip = tip ? tip + " · 链接：" + links : "链接：" + links;

    e.kind = kind;
    tiles.push({
      b: t.block,
      cn,
      x: t.x,
      y: t.y,
      rot: t.rot,
      size: e.size,
      tip,
      kind,
      code,
      msg,
      links,
    });
  }
  return { tiles, procButtons, procCount };
}

// -----------------------------------------------------------------------------
// 渲染
// -----------------------------------------------------------------------------

function renderToCanvas(schem) {
  const result = renderSchematic(schem, buildSpriteMap(), {
    scale: renderOpts.scale,
    pad: DEFAULT_PAD,
    transparent: renderOpts.transparent,
    grid: renderOpts.grid,
    laserAlpha: renderOpts.laserAlpha,
    bridgeOpacity: renderOpts.bridgeOpacity,
  });
  const canvas = els.canvas;
  canvas.width = result.width;
  canvas.height = result.height;
  const ctx = canvas.getContext("2d");
  ctx.putImageData(new ImageData(result.rgba, result.width, result.height), 0, 0);
  fitStage();
  return result;
}

// -----------------------------------------------------------------------------
// 桌面布局模式：视口 ≥960px（含手机「桌面模式」约 980px 视口）
// 或桌面 UA（Windows/Mac/X11/CrOS，支持仅改 UA 的场景）任一满足即启用；
// 统一切换 html.desktop 类，CSS 与 canvas 适配都以该类为唯一依据。
// -----------------------------------------------------------------------------
const DESKTOP_MQ = window.matchMedia("(min-width: 960px)");

function isDesktopUA() {
  const ua = navigator.userAgent || "";
  return /Windows NT|Macintosh|Mac OS X|X11|CrOS/i.test(ua);
}

function applyLayoutMode() {
  const desktop = DESKTOP_MQ.matches || isDesktopUA();
  document.documentElement.classList.toggle("desktop", desktop);
  fitStage();
}

if (DESKTOP_MQ.addEventListener) {
  DESKTOP_MQ.addEventListener("change", applyLayoutMode);
}

/**
 * 桌面端：按容器宽度与 72vh 高度上限计算 canvas 显示尺寸，
 * 交给 .stage-fit 作为精确尺寸；#spots 以 inset:0 覆盖它，
 * 百分比热区因此与 canvas 缩放严格同步。移动端交给 CSS（width:100%）。
 */
function fitStage() {
  const fit = els.stageFit;
  const canvas = els.canvas;
  if (!fit || !canvas || !canvas.width || !els.stage) return;
  if (!document.documentElement.classList.contains("desktop")) {
    fit.style.width = "";
    fit.style.height = "";
    return;
  }
  const availW = els.stage.clientWidth;
  if (availW <= 0) return;
  const maxH = Math.round(window.innerHeight * 0.72);
  const ratio = canvas.height / canvas.width;
  let w = availW;
  let h = w * ratio;
  if (h > maxH) {
    h = maxH;
    w = h / ratio;
  }
  fit.style.width = Math.max(1, Math.floor(w)) + "px";
  fit.style.height = Math.max(1, Math.floor(h)) + "px";
}

// 窗口尺寸变化 / 旋转屏幕时重新适配（rAF 节流）
let _fitRaf = 0;
window.addEventListener("resize", () => {
  if (_fitRaf) return;
  _fitRaf = requestAnimationFrame(() => {
    _fitRaf = 0;
    fitStage();
  });
});

function buildSpriteMap() {
  // spriteCache 里存的就是 render 需要的结构
  const map = {};
  for (const [k, v] of spriteCache) map[k] = v;
  return map;
}

function buildHotspots(schem, layout, tiles) {
  const totalW = layout.content_w + 2 * layout.pad;
  const totalH = layout.content_h + 2 * layout.pad;
  const frag = document.createDocumentFragment();
  for (let idx = 0; idx < schem.tiles.length; idx++) {
    const e = layout.entry_by_index.get(idx);
    const size = e.size;
    const left = ((layout.pad + e.px) / totalW) * 100;
    const top = ((layout.pad + e.py) / totalH) * 100;
    const wid = ((size * TILE) / totalW) * 100;
    const hei = ((size * TILE) / totalH) * 100;
    const div = document.createElement("div");
    div.className = "hotspot" + (tiles[idx].kind ? " has" : "");
    div.dataset.i = String(idx);
    // 原生 title 无法放 HTML：图标用 [中文名] 文本降级
    const tt = tiles[idx];
    div.title = `${tt.cn} (${tt.x},${tt.y}) 旋转${tt.rot}` + (tt.tip ? " — " + plainTextWithIcons(tt.tip) : "");
    div.style.left = left.toFixed(4) + "%";
    div.style.top = top.toFixed(4) + "%";
    div.style.width = wid.toFixed(4) + "%";
    div.style.height = hei.toFixed(4) + "%";
    frag.appendChild(div);
  }
  els.spots.replaceChildren(frag);
}

// -----------------------------------------------------------------------------
// tooltip / 弹窗
// -----------------------------------------------------------------------------

function showTip(i, ev) {
  const t = current.tiles[i];
  const html =
    `<span class="k">${esc(t.cn)}</span> (${t.x},${t.y}) 旋转${t.rot}` +
    (t.tip ? "<br>" + richText(t.tip) : "");
  els.tip.innerHTML = html;
  els.tip.style.display = "block";
  moveTip(ev);
}

function moveTip(ev) {
  if (els.tip.style.display !== "block" || !ev) return;
  const pad = 12;
  let x = (ev.clientX || 0) + pad;
  let y = (ev.clientY || 0) + pad;
  const r = els.tip.getBoundingClientRect();
  if (x + r.width > window.innerWidth - 6) x = window.innerWidth - r.width - 6;
  if (y + r.height > window.innerHeight - 6) y = (ev.clientY || 0) - r.height - pad;
  els.tip.style.left = Math.max(6, x) + "px";
  els.tip.style.top = Math.max(6, y) + "px";
}

function hideTip() {
  els.tip.style.display = "none";
}

function openModal(i) {
  const t = current.tiles[i];
  if (!t || !t.kind) return;
  currentText = t.kind === "proc" ? t.code || "" : t.msg || "";
  els.modalTitle.textContent = `${t.cn} (${t.x},${t.y})`;
  // 正文走 richText：内容图标 → <img>，UI emoji → 字体，其余转义。
  // currentText 保留原文，供「复制」使用。
  els.modalPre.innerHTML = richText(currentText);
  els.copyOk.classList.remove("show");
  els.overlay.classList.add("show");
  hideTip();
}

function closeModal() {
  els.overlay.classList.remove("show");
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// -----------------------------------------------------------------------------
// 主流程
// -----------------------------------------------------------------------------

function setStatus(text) {
  els.status.textContent = text || "";
  els.status.style.display = text ? "block" : "none";
}

function showError(msg) {
  els.error.textContent = msg;
  els.error.style.display = "block";
  setStatus("");
}

function clearError() {
  els.error.style.display = "none";
  els.error.textContent = "";
}

function setMeta(schem, procCount) {
  els.metaName.textContent = schem.tags.name || "未命名蓝图";
  els.metaAuthor.textContent = findAuthor(schem);
  els.metaSize.textContent = `${schem.width}×${schem.height}`;
  els.metaCount.textContent = String(schem.tiles.length);
  els.metaProc.textContent = String(procCount);
}

function buildProcButtons(procButtons) {
  els.procs.replaceChildren();
  if (!procButtons.length) {
    els.procsWrap.style.display = "none";
    return;
  }
  els.procsWrap.style.display = "block";
  const frag = document.createDocumentFragment();
  for (const p of procButtons) {
    const btn = document.createElement("button");
    btn.className = "proc-btn";
    btn.dataset.i = String(p.i);
    btn.innerHTML = `<span class="dot"></span>${esc(p.cn)} (${p.x},${p.y})`;
    btn.addEventListener("click", () => openModal(p.i));
    frag.appendChild(btn);
  }
  els.procs.appendChild(frag);
}

/** 解析 tags.labels：优先 JSON 数组，兜底去括号后按逗号分割。 */
function parseLabels(raw) {
  if (!raw) return [];
  const s = String(raw).trim();
  if (!s) return [];
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) return arr.map((x) => String(x)).filter(Boolean);
  } catch (e) {
    // 非标准 JSON，走兜底
  }
  return s
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function buildLabels(schem) {
  const labels = parseLabels(schem.tags.labels);
  if (!labels.length) {
    els.labelsWrap.style.display = "none";
    els.labels.replaceChildren();
    return;
  }
  els.labelsWrap.style.display = "flex";
  const frag = document.createDocumentFragment();
  for (const label of labels) {
    const span = document.createElement("span");
    span.className = "label-chip";
    // 标签同样是游戏原文，走 richText
    span.innerHTML = richText(label);
    frag.appendChild(span);
  }
  els.labels.replaceChildren(frag);
}

function buildLegend(schem) {
  const legend = collectLegend(schem);
  const frag = document.createDocumentFragment();
  for (const [name, count] of legend) {
    const span = document.createElement("span");
    span.className = "item";
    const b = document.createElement("b");
    b.textContent = name;
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = "×" + count;
    span.append(b, n);
    frag.appendChild(span);
  }
  els.legend.replaceChildren(frag);
}

/** 总耗材面板（vanilla + 模组合并累加；无数据不显示）。 */
async function buildRequirements(schem) {
  const table = Object.assign({}, BLOCK_REQUIREMENTS, modRequirementsTable);
  const list = requirementsList(schem.tiles, table, modItemName);
  if (!list.length) {
    els.reqWrap.style.display = "none";
    els.requirements.replaceChildren();
    return;
  }
  els.reqWrap.style.display = "block";
  const frag = document.createDocumentFragment();
  for (const { item, name, count } of list) {
    const div = document.createElement("div");
    div.className = "req-item";
    const img = document.createElement("img");
    img.className = "req-icon";
    img.alt = name;
    img.loading = "lazy";
    const blob = await modItemSprite(item);
    if (blob) {
      // 模组物品图标（Blob → object URL，加载后释放）
      const url = URL.createObjectURL(blob);
      img.src = url;
      img.addEventListener("load", () => URL.revokeObjectURL(url), { once: true });
    } else {
      // 原逻辑：assets/icons 码点图标 → item-<name> 贴图（本地 → 当前镜像源）
      const spriteName = "item-" + item;
      const rel = spriteRelPath(spriteName);
      img.src = itemIconSrc(item) || LOCAL_SPRITE_DIR + spriteName + ".png";
      if (rel) {
        const cdn = preferredSource() + rel.base + rel.path;
        img.addEventListener(
          "error",
          () => {
            img.onerror = null;
            img.src = cdn;
          },
          { once: true }
        );
      }
    }
    const nameEl = document.createElement("span");
    nameEl.className = "req-name";
    nameEl.textContent = name;
    const countEl = document.createElement("span");
    countEl.className = "req-count";
    countEl.textContent = "×" + count;
    div.append(img, nameEl, countEl);
    frag.appendChild(div);
  }
  els.requirements.replaceChildren(frag);
}

// -----------------------------------------------------------------------------
// 输入即解析 + 后台预加载（防抖）
// -----------------------------------------------------------------------------

const AUTO_PARSE_DELAY = 350;

let parsedCount = 0;
let lastMissing = [];
function loadSpritesFor(schem, onProgress) {
  parsedCount = schem.tiles.length;
  return loadAllSprites(collectNeeded(schem), onProgress).then((res) => {
    lastMissing = res.missing;
    return res;
  });
}
const onSpriteProgress = (done, total) =>
  setStatus(`已解析：${parsedCount} 个方块，预加载贴图 ${done}/${total}…`);

const prefetch = createPrefetchManager(parseSchematic, loadSpritesFor);

// ---- 本地历史记录 ----
let history = [];

function renderHistory() {
  if (!els.historyWrap) return;
  els.historyWrap.style.display = "block";
  if (!history.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "暂无历史记录，解析蓝图后自动保存到本地";
    els.historyList.replaceChildren(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const e of history) {
    const item = document.createElement("div");
    item.className = "history-item";
    const main = document.createElement("div");
    main.className = "history-main";
    main.dataset.hash = e.hash;
    main.title = "点击载入此蓝图";
    const nm = document.createElement("div");
    nm.className = "history-name";
    nm.textContent = e.name || "未命名";
    const meta = document.createElement("div");
    meta.className = "history-meta";
    meta.textContent = `${e.w}×${e.h} · ${e.tiles} 方块 · ${formatRelativeTime(e.time)}`;
    main.append(nm, meta);
    const rm = document.createElement("button");
    rm.className = "history-remove";
    rm.textContent = "×";
    rm.dataset.hash = e.hash;
    rm.title = "删除";
    item.append(main, rm);
    frag.appendChild(item);
  }
  els.historyList.replaceChildren(frag);
}

function persistHistory(next) {
  const saved = saveHistory(next);
  if (saved) history = saved;
  renderHistory();
}

/** 解析+渲染成功后写入/更新历史（同 hash 去重并置顶）。 */
function recordHistory(schem, input) {
  if (typeof input !== "string" || !input) return;
  if (input.length > HISTORY_MAX_INPUT) {
    setStatus("蓝图过大（>1MB），未记录到历史。");
    return;
  }
  const entry = {
    hash: simpleHash(input),
    name: (schem.tags && schem.tags.name) || "未命名",
    w: schem.width,
    h: schem.height,
    tiles: schem.tiles.length,
    time: Date.now(),
    input,
  };
  persistHistory(addHistory(history, entry));
}

/** 载入历史条目：填入输入框并触发解析渲染（成功后自动置顶刷新时间）。 */
function loadHistoryEntry(hash) {
  const e = history.find((x) => x.hash === hash);
  if (!e) return;
  els.input.value = e.input || "";
  run(e.input);
}

let autoParseTimer = null;
/** 防抖：输入停止约 350ms 后自动解析 + 后台预加载（不自动渲染）。 */
function scheduleAutoParse(input) {
  clearTimeout(autoParseTimer);
  autoParseTimer = setTimeout(() => autoParse(input), AUTO_PARSE_DELAY);
}

async function autoParse(input) {
  const key = simpleHash(input);
  const cur = prefetch.current;
  if (cur && cur.key === key && cur.schem) return; // 同一份输入已解析
  try {
    const r = await prefetch.ensure(input, onSpriteProgress);
    if (!r || r.race || !r.schem) return;
    await r.promise;
    const now = prefetch.current;
    if (now && now.key === key) {
      setStatus(`已解析：${r.schem.tiles.length} 个方块，贴图已预加载。`);
    }
  } catch (e) {
    // 可能还没输完，静默失败；点击按钮时再报错
  }
}

async function run(input) {
  try {
    clearError();
    setStatus("正在解析蓝图…");
    els.exportBtn.disabled = true;

    const r = await prefetch.ensure(input, onSpriteProgress);
    if (!r || r.race || !r.schem) {
      showError("解析失败：输入可能不是有效的蓝图。");
      els.exportBtn.disabled = false;
      return;
    }
    const schem = r.schem;
    setStatus(
      `已解析：${schem.tiles.length} 个方块${r.reused ? "（复用预加载）" : ""}，准备贴图…`
    );

    await r.promise;

    // 竞态保护：等待期间输入若已改变，放弃本次渲染
    if (!prefetch.current || prefetch.current.key !== r.key) return;

    await renderCurrent(schem);
    recordHistory(schem, input);
  } catch (err) {
    console.error(err);
    showError("解析或渲染失败：" + (err && err.message ? err.message : err));
    els.exportBtn.disabled = false;
  }
}

/** 渲染指定蓝图并重建全部 UI（run 与模组刷新共用）。 */
async function renderCurrent(schem) {
  setStatus("正在渲染…");
  const result = renderToCanvas(schem);
  const layout = result.layout;

  const { tiles, procButtons, procCount } = await buildTileData(schem, layout);

  current = { schem, tiles, layout, name: schem.tags.name || "蓝图" };
  setMeta(schem, procCount);
  buildLabels(schem);
  buildProcButtons(procButtons);
  buildHotspots(schem, layout, tiles);
  buildLegend(schem);
  await buildRequirements(schem);
  els.exportBtn.disabled = false;
  updateSourceCurrent();

  const missing = lastMissing;
  const cacheNote = cacheInfo.hits > 0 ? `（缓存命中 ${cacheInfo.hits} 张）` : "";
  const unknown = [];
  const seen = new Set();
  for (const t of schem.tiles) {
    if (!seen.has(t.block) && !isKnownBlock(t.block)) {
      seen.add(t.block);
      unknown.push(t.block);
    }
  }
  const warns = [];
  if (missing.length) {
    warns.push(`贴图缺失：${missing.slice(0, 6).join("、")}${missing.length > 6 ? "…" : ""}`);
  }
  if (unknown.length) {
    warns.push(`未识别方块（可能缺少模组）：${unknown.slice(0, 6).join("、")}${unknown.length > 6 ? "…" : ""}`);
  }
  setStatus(warns.length ? `渲染完成${cacheNote}（${warns.join("；")}）` : `渲染完成${cacheNote}。`);
}

/** 模组变化后：清内存贴图缓存并重渲染当前蓝图。 */
async function refreshAfterMods() {
  prefetch.invalidate();
  if (!current || !current.schem) return;
  const schem = current.schem;
  setStatus("正在重新加载贴图…");
  spriteCache.clear();
  try {
    lastMissing = (await loadAllSprites(collectNeeded(schem), onSpriteProgress)).missing;
    await renderCurrent(schem);
  } catch (e) {
    showError("模组更新后重渲染失败：" + e.message);
  }
}

// -----------------------------------------------------------------------------
// 模组 UI
// -----------------------------------------------------------------------------

const MOD_EXT = /\.(zip|jar)$/i;

function modBlockCount(m) {
  let n = 0;
  const p = m.name + "-";
  for (const k of m.blocks.keys()) if (k.startsWith(p)) n++;
  return n;
}

function renderModList() {
  if (!els.modList) return;
  els.modList.replaceChildren();
  if (!mods.length) return;
  const frag = document.createDocumentFragment();
  for (const m of mods) {
    const row = document.createElement("div");
    row.className = "mod-item";
    const info = document.createElement("div");
    info.className = "mod-info";
    const title = document.createElement("div");
    title.className = "mod-name";
    title.textContent = `${m.displayName || m.name}（${m.name}）`;
    const sub = document.createElement("div");
    sub.className = "mod-sub";
    sub.textContent = `${modBlockCount(m)} 方块 · 贴图 ${m.sprites.size}（按需加载） · ${m.fileName}`;
    info.append(title, sub);
    const rm = document.createElement("button");
    rm.className = "mod-remove";
    rm.textContent = "移除";
    rm.dataset.file = m.fileName;
    row.append(info, rm);
    frag.appendChild(row);
  }
  els.modList.appendChild(frag);
}

async function addModFiles(files) {
  clearError();
  const arr = [...files].filter((f) => MOD_EXT.test(f.name));
  if (!arr.length) {
    showError("请选择 .zip 或 .jar 格式的模组文件。");
    return;
  }
  const names = [];
  let fail = 0;
  for (const file of arr) {
    try {
      setStatus(`正在解析模组：${file.name}…`);
      const buf = new Uint8Array(await file.arrayBuffer());
      const m = await parseMod(buf, file.name);
      mods = mods.filter((x) => x.fileName !== file.name);
      mods.push(m);
      await putMod(file.name, new Blob([buf]));
      names.push(`${m.displayName || m.name}（${modBlockCount(m)} 方块 / 贴图 ${m.sprites.size}）`);
    } catch (e) {
      fail++;
      console.error(e);
      showError(`模组 ${file.name} 加载失败：${e.message}`);
    }
  }
  rebuildModDerived();
  renderModList();
  await refreshAfterMods();
  if (names.length) setStatus(`模组已加载：${names.join("、")}${fail ? `（${fail} 个失败）` : ""}`);
}

async function removeMod(fileName) {
  mods = mods.filter((m) => m.fileName !== fileName);
  await deleteMod(fileName);
  rebuildModDerived();
  renderModList();
  await refreshAfterMods();
  setStatus("模组已移除。");
}

async function clearAllMods() {
  mods = [];
  await clearMods();
  rebuildModDerived();
  renderModList();
  await refreshAfterMods();
  setStatus("已清除全部模组。");
}

/** 启动时从 Cache Storage 重新加载模组。 */
async function loadCachedMods() {
  try {
    const cached = await listMods();
    if (!cached.length) return;
    let n = 0;
    for (const { fileName, blob } of cached) {
      try {
        const m = await parseMod(blob, fileName);
        mods = mods.filter((x) => x.fileName !== fileName);
        mods.push(m);
        n++;
      } catch (e) {
        console.warn("模组缓存加载失败：", fileName, e);
      }
    }
    rebuildModDerived();
    renderModList();
    if (n) setStatus(`已从缓存加载 ${n} 个模组。`);
  } catch (e) {
    // 缓存不可用：忽略
  }
}

// -----------------------------------------------------------------------------
// 事件绑定
// -----------------------------------------------------------------------------

els.parseBtn.addEventListener("click", () => {
  const text = els.input.value.trim();
  if (!text) {
    showError("请先粘贴蓝图 Base64 文本，或选择一个 .txt / .msch 文件。");
    return;
  }
  run(text);
});

// 输入即解析：停止输入约 350ms 后自动解析并在后台预加载贴图（不自动渲染）
els.input.addEventListener("input", () => {
  clearError();
  scheduleAutoParse(els.input.value);
});

els.file.addEventListener("change", async () => {
  const file = els.file.files && els.file.files[0];
  if (!file) return;
  clearError();
  try {
    setStatus("正在读取文件…");
    const buf = new Uint8Array(await file.arrayBuffer());
    els.input.value = file.name.replace(/\.[^.]+$/, "") + "（已选择文件：" + file.name + "）";
    scheduleAutoParse(buf); // 后台预加载
    await run(buf); // 文件选择后照旧直接渲染
  } catch (e) {
    showError("读取文件失败：" + e.message);
  }
});

// 拖拽
["dragenter", "dragover"].forEach((ev) =>
  els.drop.addEventListener(ev, (e) => {
    e.preventDefault();
    els.drop.classList.add("over");
  })
);
["dragleave", "drop"].forEach((ev) =>
  els.drop.addEventListener(ev, (e) => {
    e.preventDefault();
    els.drop.classList.remove("over");
  })
);
els.drop.addEventListener("drop", async (e) => {
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  clearError();
  try {
    setStatus("正在读取拖入文件…");
    const buf = new Uint8Array(await file.arrayBuffer());
    els.input.value = file.name.replace(/\.[^.]+$/, "") + "（已拖入文件：" + file.name + "）";
    scheduleAutoParse(buf); // 后台预加载
    await run(buf);
  } catch (err) {
    showError("读取拖入文件失败：" + err.message);
  }
});

// 模组：选择文件 / 拖拽 / 移除 / 清除全部
if (els.modInput) {
  els.modInput.addEventListener("change", async () => {
    if (els.modInput.files && els.modInput.files.length) await addModFiles(els.modInput.files);
    els.modInput.value = "";
  });
}
if (els.modClear) els.modClear.addEventListener("click", clearAllMods);
if (els.modList) {
  els.modList.addEventListener("click", (e) => {
    const btn = e.target.closest(".mod-remove");
    if (btn) removeMod(btn.dataset.file);
  });
}
if (els.modDrop) {
  ["dragenter", "dragover"].forEach((ev) =>
    els.modDrop.addEventListener(ev, (e) => {
      e.preventDefault();
      els.modDrop.classList.add("over");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    els.modDrop.addEventListener(ev, (e) => {
      e.preventDefault();
      els.modDrop.classList.remove("over");
    })
  );
  els.modDrop.addEventListener("drop", async (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) await addModFiles(files);
  });
}

// 贴图源：手动选择 / 检测镜像 / 徽章点击
if (els.sourceSelect) {
  els.sourceSelect.addEventListener("change", () => applySourceChoice(els.sourceSelect.value));
}
if (els.sourceProbe) els.sourceProbe.addEventListener("click", runSourceProbe);
if (els.sourceBadges) {
  els.sourceBadges.addEventListener("click", (e) => {
    const b = e.target.closest(".src-badge");
    if (b) applySourceChoice(b.dataset.key);
  });
}

// 历史记录：点击载入 / 删除 / 清空
if (els.historyList) {
  els.historyList.addEventListener("click", (e) => {
    const rm = e.target.closest(".history-remove");
    if (rm) {
      persistHistory(removeHistory(history, rm.dataset.hash));
      setStatus("已删除该历史记录。");
      return;
    }
    const main = e.target.closest(".history-main");
    if (main) loadHistoryEntry(main.dataset.hash);
  });
}
if (els.historyClear) {
  els.historyClear.addEventListener("click", () => {
    persistHistory([]);
    setStatus("历史记录已清空。");
  });
}

// 渲染选项
const OPACITY_KEYS = { laser: "msch-laser-alpha", bridge: "msch-bridge-opacity" };

function readOpacityOpts() {
  const la = Math.max(0, Math.min(100, parseInt(els.laserRange.value, 10)));
  const bo = Math.max(0, Math.min(100, parseInt(els.bridgeRange.value, 10)));
  const lv = Number.isFinite(la) ? la : 100;
  const bv = Number.isFinite(bo) ? bo : 50;
  renderOpts.laserAlpha = lv / 100;
  renderOpts.bridgeOpacity = bv / 100;
  els.laserVal.textContent = lv + "%";
  els.bridgeVal.textContent = bv + "%";
}

function saveOpacityOpts() {
  try {
    localStorage.setItem(OPACITY_KEYS.laser, String(Math.round(renderOpts.laserAlpha * 100)));
    localStorage.setItem(OPACITY_KEYS.bridge, String(Math.round(renderOpts.bridgeOpacity * 100)));
  } catch (e) {
    // localStorage 不可用：忽略
  }
}

function loadOpacityOpts() {
  let la = 100;
  let bo = 50;
  try {
    const s1 = localStorage.getItem(OPACITY_KEYS.laser);
    const s2 = localStorage.getItem(OPACITY_KEYS.bridge);
    if (s1 !== null) la = Math.max(0, Math.min(100, parseInt(s1, 10) || 0));
    if (s2 !== null) bo = Math.max(0, Math.min(100, parseInt(s2, 10) || 0));
  } catch (e) {
    // 忽略
  }
  els.laserRange.value = String(la);
  els.bridgeRange.value = String(bo);
  readOpacityOpts();
}

function readOpts() {
  renderOpts.scale = Math.max(1, Math.min(4, parseInt(els.scale.value, 10) || DEFAULT_SCALE));
  renderOpts.transparent = els.bgMode.value === "transparent";
  renderOpts.grid = els.grid.checked;
  readOpacityOpts();
}

/** 用当前选项重绘已渲染的蓝图（热区按百分比，尺寸不变）。 */
function quickRerender() {
  if (!current) return;
  try {
    const result = renderToCanvas(current.schem);
    current.layout = result.layout;
    buildHotspots(current.schem, result.layout, current.tiles);
  } catch (e) {
    showError("重新渲染失败：" + e.message);
  }
}

[els.scale, els.bgMode, els.grid].forEach((el) =>
  el.addEventListener("change", () => {
    readOpts();
    quickRerender();
  })
);

// 透明度滑杆：250ms 防抖实时重渲染 + 持久化
let opacityTimer = null;
function onOpacityInput() {
  readOpacityOpts();
  saveOpacityOpts();
  clearTimeout(opacityTimer);
  opacityTimer = setTimeout(quickRerender, 250);
}
[els.laserRange, els.bridgeRange].forEach((el) => {
  if (el) el.addEventListener("input", onOpacityInput);
});

// 弹窗与复制
els.modalX.addEventListener("click", closeModal);
els.overlay.addEventListener("click", (e) => {
  if (e.target === els.overlay) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeModal();
    return;
  }
  // 快捷触发「解析并渲染」
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    els.parseBtn.click();
  }
});
els.copyBtn.addEventListener("click", () => {
  const done = () => {
    els.copyOk.classList.add("show");
    setTimeout(() => els.copyOk.classList.remove("show"), 1400);
  };
  const fallback = () => {
    const ta = document.createElement("textarea");
    ta.value = currentText;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand("copy");
    } catch (e) {}
    document.body.removeChild(ta);
    done();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(currentText).then(done, fallback);
  } else {
    fallback();
  }
});

// 热区事件（事件委托）
els.spots.addEventListener("mouseover", (e) => {
  const el = e.target.closest(".hotspot");
  if (!el) return;
  showTip(parseInt(el.dataset.i, 10), e);
});
els.spots.addEventListener("mousemove", (e) => {
  if (e.target.closest(".hotspot")) moveTip(e);
});
els.spots.addEventListener("mouseout", (e) => {
  if (e.target.closest(".hotspot")) hideTip();
});
els.spots.addEventListener("click", (e) => {
  const el = e.target.closest(".hotspot");
  if (!el) return;
  e.stopPropagation();
  const i = parseInt(el.dataset.i, 10);
  if (current.tiles[i] && current.tiles[i].kind) openModal(i);
  else showTip(i, e);
});

// 导出 PNG
els.exportBtn.addEventListener("click", () => {
  if (!current) return;
  const name = (current.name || "蓝图").replace(/[\\/:*?"<>|]/g, "_");
  els.canvas.toBlob((blob) => {
    if (!blob) {
      showError("导出 PNG 失败：无法生成图片数据。");
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name + ".png";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, "image/png");
});

// 清除持久化缓存
if (els.clearCache) {
  els.clearCache.addEventListener("click", async (e) => {
    e.preventDefault();
    await clearPersistentCache();
    setStatus("缓存已清除。");
    setTimeout(() => {
      if (els.status.textContent === "缓存已清除。") setStatus("");
    }, 2000);
  });
}

// 初始化
(async function init() {
  console.info("SchemaScope v" + APP_VERSION);
  applyLayoutMode();
  await loadSpriteIndex();
  setIconIndex(spriteIndex);
  populateSourceSelect();
  markActiveBadge(getChoiceKey());
  updateSourceCurrent();
  loadOpacityOpts();
  await loadCachedMods();
  // 一次性迁移：清理旧的「蓝图本体」自动缓存键（本工具不再回填蓝图）
  try {
    localStorage.removeItem("msch-last-input");
  } catch (e) {
    // 忽略
  }
  history = loadHistory();
  renderHistory();
  setStatus("");
})();
