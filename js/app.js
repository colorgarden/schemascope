// =============================================================================
// app.js —— UI 逻辑（输入 → 解析 → 贴图加载 → 渲染 → 交互 → 导出）
// 对照 msch.py 的 build_html / HTML_TEMPLATE（热区、处理器按钮、图例、弹窗）
// =============================================================================

import {
  TILE,
  BLOCK_CN,
  CONTENT_CN,
  CDN_PREFIX,
  LOCAL_SPRITE_DIR,
  AUX_PATHS,
  LAYERS,
  BRIDGE_BLOCKS,
  DEFAULT_SCALE,
  DEFAULT_PAD,
} from "./data.js";
import { parseSchematic, extractLogic, isProcessor } from "./parser.js";
import { renderSchematic, getSprite, makePlaceholder } from "./render.js";

// -----------------------------------------------------------------------------
// DOM
// -----------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const els = {
  input: $("input-text"),
  file: $("file-input"),
  parseBtn: $("parse-btn"),
  demoBtn: $("demo-btn"),
  scale: $("scale"),
  bgMode: $("bg-mode"),
  grid: $("grid"),
  status: $("status"),
  error: $("error"),
  procs: $("procs"),
  procsWrap: $("procs-wrap"),
  stage: $("stage"),
  canvas: $("canvas"),
  spots: $("spots"),
  legend: $("legend"),
  metaName: $("meta-name"),
  metaAuthor: $("meta-author"),
  metaSize: $("meta-size"),
  metaCount: $("meta-count"),
  metaProc: $("meta-proc"),
  exportBtn: $("export-btn"),
  tip: $("tip"),
  overlay: $("overlay"),
  modalTitle: $("modal-title"),
  modalPre: $("modal-pre"),
  modalX: $("modal-x"),
  copyBtn: $("copy-btn"),
  copyOk: $("copy-ok"),
  drop: $("drop"),
};

// -----------------------------------------------------------------------------
// 全局状态
// -----------------------------------------------------------------------------
let spriteIndex = { sprites_base: "core/assets-raw/", blocks: {}, items: {}, aux: {} };
const spriteCache = new Map(); // name -> sprite | null
let localBaseOk = null; // 推断 assets/sprites/ 是否存在，避免满屏 404
let current = null; // { schem, tiles, layout, name }
let currentText = "";
let renderOpts = { scale: DEFAULT_SCALE, pad: DEFAULT_PAD, transparent: false, grid: false };

// -----------------------------------------------------------------------------
// 贴图加载
// -----------------------------------------------------------------------------

async function loadSpriteIndex() {
  try {
    const res = await fetch("sprite_index.json", { cache: "force-cache" });
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

async function fetchBitmap(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const blob = await res.blob();
  return await createImageBitmap(blob);
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

/**
 * 加载单个贴图。顺序：内存缓存 → assets/sprites/<name>.png → jsDelivr CDN。
 * required=true 时缺失返回占位块；否则返回 null（叠加层缺失直接跳过）。
 */
async function loadSprite(name, required) {
  if (spriteCache.has(name)) return spriteCache.get(name);

  const rel = spriteRelPath(name);
  const urls = [];
  if (localBaseOk !== false) urls.push(LOCAL_SPRITE_DIR + name + ".png");
  if (rel) urls.push(CDN_PREFIX + rel.base + rel.path);

  for (const url of urls) {
    try {
      const bmp = await fetchBitmap(url);
      const sp = bitmapToSprite(bmp);
      spriteCache.set(name, sp);
      if (url.startsWith(LOCAL_SPRITE_DIR)) localBaseOk = true;
      return sp;
    } catch (e) {
      if (url.startsWith(LOCAL_SPRITE_DIR)) localBaseOk = false;
      // 继续尝试下一个来源
    }
  }

  const sp = required ? makePlaceholder(1) : null;
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
    const ls = LAYERS[t.block];
    if (ls) for (const l of ls) add(l, l === t.block);
    if (BRIDGE_BLOCKS.has(t.block)) {
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
  const batchSize = 8;
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

function collectLegend(schem) {
  const counts = new Map();
  for (const t of schem.tiles) counts.set(t.block, (counts.get(t.block) || 0) + 1);
  return [...counts.entries()]
    .map(([b, n]) => [BLOCK_CN[b] || b, n, b])
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
    const cn = BLOCK_CN[t.block] || t.block;
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
  });
  const canvas = els.canvas;
  canvas.width = result.width;
  canvas.height = result.height;
  const ctx = canvas.getContext("2d");
  ctx.putImageData(new ImageData(result.rgba, result.width, result.height), 0, 0);
  return result;
}

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
  const html = `<span class="k">${esc(t.cn)}</span> (${t.x},${t.y}) 旋转${t.rot}` + (t.tip ? "<br>" + esc(t.tip) : "");
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
  els.modalPre.textContent = currentText;
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

async function run(input) {
  try {
    clearError();
    setStatus("正在解析蓝图…");
    els.exportBtn.disabled = true;

    const schem = await parseSchematic(input);

    const needed = collectNeeded(schem);
    setStatus(`正在加载贴图… 0/${needed.size}`);
    const { missing } = await loadAllSprites(needed, (done, total) => {
      setStatus(`正在加载贴图… ${done}/${total}`);
    });

    setStatus("正在渲染…");
    const result = renderToCanvas(schem);
    const layout = result.layout;

    const { tiles, procButtons, procCount } = await buildTileData(schem, layout);

    current = { schem, tiles, layout, name: schem.tags.name || "蓝图" };
    setMeta(schem, procCount);
    buildProcButtons(procButtons);
    buildHotspots(schem, layout, tiles);
    buildLegend(schem);
    els.exportBtn.disabled = false;

    if (missing.length) {
      setStatus(`渲染完成（${missing.length} 个贴图缺失，已用占位/跳过）：${missing.slice(0, 6).join("、")}${missing.length > 6 ? "…" : ""}`);
    } else {
      setStatus("渲染完成。");
    }
  } catch (err) {
    console.error(err);
    showError("解析或渲染失败：" + (err && err.message ? err.message : err));
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

els.demoBtn.addEventListener("click", () => {
  const demo = window.DEMO_SCHEMATIC || "";
  if (!demo) {
    showError("示例蓝图未加载（js/demo.js 缺失）。");
    return;
  }
  els.input.value = demo;
  run(demo);
});

els.file.addEventListener("change", async () => {
  const file = els.file.files && els.file.files[0];
  if (!file) return;
  clearError();
  try {
    setStatus("正在读取文件…");
    const buf = new Uint8Array(await file.arrayBuffer());
    els.input.value = file.name.replace(/\.[^.]+$/, "") + "（已选择文件：" + file.name + "）";
    await run(buf);
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
    await run(buf);
  } catch (err) {
    showError("读取拖入文件失败：" + err.message);
  }
});

// 渲染选项
function readOpts() {
  renderOpts.scale = Math.max(1, Math.min(4, parseInt(els.scale.value, 10) || DEFAULT_SCALE));
  renderOpts.transparent = els.bgMode.value === "transparent";
  renderOpts.grid = els.grid.checked;
}
[els.scale, els.bgMode, els.grid].forEach((el) =>
  el.addEventListener("change", () => {
    readOpts();
    if (current) {
      try {
        const result = renderToCanvas(current.schem);
        current.layout = result.layout;
        // 热区基于百分比定位，尺寸不变；仍重建以保持 kind 状态
        buildHotspots(current.schem, result.layout, current.tiles);
      } catch (e) {
        showError("重新渲染失败：" + e.message);
      }
    }
  })
);

// 弹窗与复制
els.modalX.addEventListener("click", closeModal);
els.overlay.addEventListener("click", (e) => {
  if (e.target === els.overlay) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
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

// 初始化
(async function init() {
  await loadSpriteIndex();
  setStatus("");
})();
