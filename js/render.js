// =============================================================================
// render.js —— 渲染器（逐函数对照 msch.py 第 8 节「渲染」）
//
// 与 Python 版本一致：纯字节缓冲 + 最近邻，不依赖浏览器 API，方便在 Node 里
// 用假 ImageData 缓冲做单测。浏览器侧只需把最终 RGBA 放入 ImageData 即可。
//
// sprite 结构：{ w, h, size, rgba: Uint8ClampedArray, placeholder }
// =============================================================================

import {
  TILE,
  LAYERS,
  OUTLINE_ICON,
  CONFIG_UNDERLAY,
  CONFIG_OVERLAY,
  CONTENT_COLORS,
  POWER_BLOCKS,
  POWER_LASER_COLOR,
  POWER_LASER_ALPHA,
  POWER_LASER_SCALE,
  POWER_LASER_WIDTH,
  BRIDGE_BLOCKS,
  BRIDGE_RANGE,
  BRIDGE_WIDTH,
  BRIDGE_OPACITY,
} from "./data.js";

// 模组方块的多层启发式（仅当 vanilla LAYERS 未定义该块时使用）
let MOD_LAYERS = {};

/** 注入模组多层表（app.js 在模组变化时调用；不会覆盖 vanilla 的 LAYERS）。 */
export function setModLayers(map) {
  MOD_LAYERS = map || {};
}

// 模组桥（type 以 "Bridge" 结尾）：name -> { range, width }
let MOD_BRIDGES = new Map();
// 模组描边（MassDriver 类）：name -> [[r,g,b], radius]
let MOD_OUTLINE = new Map();
// 模组电力目标：可作为电力节点连线目标的方块名
let MOD_POWER_BLOCKS = new Set();
// 模组电力节点来源（type 以 "PowerNode" 结尾）：name -> { scale, color1, color2 }
let MOD_POWER_NODES = new Map();

function toMap(v) {
  if (v instanceof Map) return v;
  return new Map(Object.entries(v || {}));
}
function toSet(v) {
  if (v instanceof Set) return v;
  return new Set(v || []);
}

/** 注册模组桥信息：Map(name -> {range?, width?})。 */
export function setModBridges(map) {
  MOD_BRIDGES = toMap(map);
}

/** 注册模组描边信息：Map(name -> [[r,g,b], radius])。 */
export function setModOutline(map) {
  MOD_OUTLINE = toMap(map);
}

/** 注册模组电力方块集合（Set 或数组）。 */
export function setModPowerBlocks(set) {
  MOD_POWER_BLOCKS = toSet(set);
}

/** 注册模组电力节点：Map(name -> { scale?, color1?, color2? })。 */
export function setModPowerNodes(map) {
  MOD_POWER_NODES = toMap(map);
}

/** 电力节点类型判定：type 以 "PowerNode" 结尾（PowerNode / LongPowerNode 等）。 */
export function isPowerNodeType(type) {
  return typeof type === "string" && type.length > 0 && type.endsWith("PowerNode");
}

/** 解析颜色：支持 "#rrggbb" / "rrggbb" / [r,g,b] / 数字；失败返回 null。 */
export function parseColor(v) {
  if (v == null) return null;
  if (Array.isArray(v) && v.length >= 3) return [Number(v[0]) & 255, Number(v[1]) & 255, Number(v[2]) & 255];
  if (typeof v === "number") return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  const s = String(v).trim().replace(/^#/, "");
  const m = /^([0-9a-fA-F]{6})$/.exec(s);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 颜色插值 lerp(a,b,t)，t=0.1 → 约接近 a。 */
function lerpColor(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** 桥类型判定：type 以 "Bridge" 结尾（ItemBridge/LiquidBridge/BufferedItemBridge/DirectionalBridge 等）。 */
export function isBridgeType(type) {
  return typeof type === "string" && type.length > 0 && type.endsWith("Bridge");
}

/** 质量驱动器类型判定。 */
export function isMassDriverType(type) {
  return type === "MassDriver" || (typeof type === "string" && type.endsWith("MassDriver"));
}

/** 是否为模组桥（vanilla 集合之外）。 */
export function isModBridge(name) {
  return MOD_BRIDGES.has(name);
}

/** 桥配对范围：模组 range 优先，其次 vanilla BRIDGE_RANGE，最后 4。 */
export function bridgeRangeOf(name) {
  const m = MOD_BRIDGES.get(name);
  if (m && m.range !== undefined && m.range !== null) return m.range;
  return BRIDGE_RANGE[name] !== undefined ? BRIDGE_RANGE[name] : 4;
}

/** 桥带宽度：模组 bridgeWidth 按 24px/6.5 等比，否则全局 24。 */
export function bridgeWidthOf(name) {
  // 所有桥（含模组桥）统一使用与原版一致的桥带宽度（BRIDGE_WIDTH），
  // 不做按 bridgeWidth 字段的等比放宽。
  return BRIDGE_WIDTH;
}

// -----------------------------------------------------------------------------
// 数值辅助（对齐 Python 的 // 与 int()/round() 语义）
// -----------------------------------------------------------------------------
const ifloor = (x) => Math.floor(x);
const trunc = (x) => Math.trunc(x);
// Python round()：四舍六入五成双
function pyRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

// -----------------------------------------------------------------------------
// 2. 贴图占位与加载辅助
// -----------------------------------------------------------------------------

/** 生成半透明灰色占位贴图（对应 _make_placeholder）。 */
export function makePlaceholder(size = 1) {
  const s = size * TILE;
  const rgba = new Uint8ClampedArray(s * s * 4);
  for (let yy = 0; yy < s; yy++) {
    for (let xx = 0; xx < s; xx++) {
      const o = (yy * s + xx) * 4;
      const border = xx === 0 || yy === 0 || xx === s - 1 || yy === s - 1;
      if (border) {
        rgba[o] = 130;
        rgba[o + 1] = 130;
        rgba[o + 2] = 140;
        rgba[o + 3] = 220;
      } else {
        rgba[o] = 95;
        rgba[o + 1] = 95;
        rgba[o + 2] = 105;
        rgba[o + 3] = 120;
      }
    }
  }
  return { w: s, h: s, size, rgba, placeholder: true };
}

/** 取贴图；缺失时底图回退占位块，叠加层返回 null（对应 load_sprite/optional）。 */
export function getSprite(sprites, name, optional = false) {
  const sp = sprites ? sprites[name] : null;
  if (sp) return sp;
  if (optional) return null;
  return makePlaceholder(1);
}

// -----------------------------------------------------------------------------
// 3. 混合 / 着色 / 旋转 / 描边
// -----------------------------------------------------------------------------

/** src-over 混合（对应 _blend）。 */
export function blend(dst, cw, ch, dx, dy, src, sw, sh) {
  for (let yy = 0; yy < sh; yy++) {
    const ty = dy + yy;
    if (ty < 0 || ty >= ch) continue;
    for (let xx = 0; xx < sw; xx++) {
      const tx = dx + xx;
      if (tx < 0 || tx >= cw) continue;
      const so = (yy * sw + xx) * 4;
      const a = src[so + 3];
      if (a === 0) continue;
      const dofs = (ty * cw + tx) * 4;
      if (a === 255) {
        dst[dofs] = src[so];
        dst[dofs + 1] = src[so + 1];
        dst[dofs + 2] = src[so + 2];
        dst[dofs + 3] = 255;
      } else {
        const ia = 255 - a;
        dst[dofs] = ifloor((src[so] * a + dst[dofs] * ia) / 255);
        dst[dofs + 1] = ifloor((src[so + 1] * a + dst[dofs + 1] * ia) / 255);
        dst[dofs + 2] = ifloor((src[so + 2] * a + dst[dofs + 2] * ia) / 255);
        dst[dofs + 3] = Math.min(255, a + ifloor((dst[dofs + 3] * ia) / 255));
      }
    }
  }
}

/** 单像素 src-over 混合（对应 _blend_px）。 */
export function blendPx(dst, off, r, g, b, a) {
  if (a <= 0) return;
  if (a >= 255) {
    dst[off] = r;
    dst[off + 1] = g;
    dst[off + 2] = b;
    dst[off + 3] = 255;
    return;
  }
  const ia = 255 - a;
  dst[off] = ifloor((r * a + dst[off] * ia) / 255);
  dst[off + 1] = ifloor((g * a + dst[off + 1] * ia) / 255);
  dst[off + 2] = ifloor((b * a + dst[off + 2] * ia) / 255);
  dst[off + 3] = Math.min(255, a + ifloor((dst[off + 3] * ia) / 255));
}

/** 用颜色 [r,g,b,a] 填充矩形（对应 Fill.square 的整格填充）。 */
export function fillRect(buf, cw, ch, x, y, w, h, rgba) {
  const [r, g, b, a] = rgba;
  for (let yy = 0; yy < h; yy++) {
    const ty = y + yy;
    if (ty < 0 || ty >= ch) continue;
    for (let xx = 0; xx < w; xx++) {
      const tx = x + xx;
      if (tx < 0 || tx >= cw) continue;
      blendPx(buf, (ty * cw + tx) * 4, r, g, b, a);
    }
  }
}

/** 把 region 贴图平铺填满 w×h（对应 drawTiledFrames 的静态近似）。 */
export function tileBlit(buf, cw, ch, region, x, y, w, h, rgba, alphaScale = 1) {
  const rw = region.w;
  const rh = region.h;
  for (let yy = 0; yy < h; yy++) {
    const ty = y + yy;
    if (ty < 0 || ty >= ch) continue;
    for (let xx = 0; xx < w; xx++) {
      const tx = x + xx;
      if (tx < 0 || tx >= cw) continue;
      const so = ((yy % rh) * rw + (xx % rw)) * 4;
      const a = Math.trunc(rgba[so + 3] * alphaScale);
      if (a === 0) continue;
      blendPx(buf, (ty * cw + tx) * 4, rgba[so], rgba[so + 1], rgba[so + 2], a);
    }
  }
}

/** RGB 乘以颜色（对应 _tint_rgba）。 */
export function tintRgba(rgba, color) {
  const [cr, cg, cb] = color;
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = ifloor((rgba[i] * cr) / 255);
    out[i + 1] = ifloor((rgba[i + 1] * cg) / 255);
    out[i + 2] = ifloor((rgba[i + 2] * cb) / 255);
    out[i + 3] = rgba[i + 3];
  }
  return out;
}

/** alpha 掩码方形窗口最大值膨胀（对应 _dilate_alpha）。 */
export function dilateAlpha(alpha, w, h, radius) {
  const tmp = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    const base = y * w;
    for (let x = 0; x < w; x++) {
      let m = 0;
      const k0 = Math.max(0, x - radius);
      const k1 = Math.min(w, x + radius + 1);
      for (let k = k0; k < k1; k++) {
        const v = alpha[base + k];
        if (v > m) m = v;
      }
      tmp[base + x] = m;
    }
  }
  const out = new Int32Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = 0;
      const k0 = Math.max(0, y - radius);
      const k1 = Math.min(h, y + radius + 1);
      for (let k = k0; k < k1; k++) {
        const v = tmp[k * w + x];
        if (v > m) m = v;
      }
      out[y * w + x] = m;
    }
  }
  return out;
}

/** Pixmaps.outline 等价物（对应 _make_outline）。 */
export function makeOutline(rgba, w, h, color, radius) {
  const alpha = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = rgba[i * 4 + 3];
  const dil = dilateAlpha(alpha, w, h, radius);
  const [cr, cg, cb] = color;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (dil[i] <= 0) continue;
    const o = i * 4;
    out[o] = cr;
    out[o + 1] = cg;
    out[o + 2] = cb;
    out[o + 3] = dil[i] >= 128 ? 255 : dil[i];
  }
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const a = rgba[o + 3];
    if (a === 0) continue;
    blendPx(out, o, rgba[o], rgba[o + 1], rgba[o + 2], a);
  }
  return out;
}

/** 贴图逆时针旋转 rot×90°（对应 _rotate_sprite）。 */
export function rotateSprite(rgba, w, h, rot) {
  rot = ((rot % 4) + 4) % 4;
  if (rot === 0) return [w, h, rgba];
  let curW = w;
  let curH = h;
  let cur = rgba;
  for (let r = 0; r < rot; r++) {
    const newW = curH;
    const newH = curW;
    const out = new Uint8ClampedArray(newW * newH * 4);
    for (let ny = 0; ny < newH; ny++) {
      for (let nx = 0; nx < newW; nx++) {
        const ox = newH - 1 - ny;
        const oy = nx;
        const so = (oy * curW + ox) * 4;
        const dofs = (ny * newW + nx) * 4;
        out[dofs] = cur[so];
        out[dofs + 1] = cur[so + 1];
        out[dofs + 2] = cur[so + 2];
        out[dofs + 3] = cur[so + 3];
      }
    }
    curW = newW;
    curH = newH;
    cur = out;
  }
  return [curW, curH, cur];
}

/** 以 (cx,cy) 为中心按角度旋转缩放绘制（对应 _blit_rotated）。 */
export function blitRotated(dst, cw, ch, src, sw, sh, cx, cy, scale, angleDeg, tint, alphaScale = 1.0) {
  const ang = (Math.PI / 180) * -angleDeg; // 图像 y 向下，取反
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const reach = Math.hypot(sw * scale, sh * scale) / 2.0 + 2;
  const x0 = Math.trunc(cx - reach);
  const x1 = Math.trunc(cx + reach);
  const y0 = Math.trunc(cy - reach);
  const y1 = Math.trunc(cy + reach);
  for (let dy = Math.max(0, y0); dy < Math.min(ch, y1 + 1); dy++) {
    const oy = dy - cy;
    for (let dx = Math.max(0, x0); dx < Math.min(cw, x1 + 1); dx++) {
      const ox = dx - cx;
      const rx = ca * ox - sa * oy;
      const ry = sa * ox + ca * oy;
      const sx = Math.trunc(rx / scale + sw / 2.0);
      const sy = Math.trunc(ry / scale + sh / 2.0);
      if (sx >= 0 && sx < sw && sy >= 0 && sy < sh) {
        const so = (sy * sw + sx) * 4;
        const a = Math.trunc(src[so + 3] * alphaScale);
        if (a === 0) continue;
        const r = ifloor((src[so] * tint[0]) / 255);
        const g = ifloor((src[so + 1] * tint[1]) / 255);
        const b = ifloor((src[so + 2] * tint[2]) / 255);
        blendPx(dst, (dy * cw + dx) * 4, r, g, b, a);
      }
    }
  }
}

/** 沿 p1→p2 绘制光束（对应 _draw_beam / Drawf.laser + Lines.line）。 */
export function drawBeam(dst, cw, ch, x1, y1, x2, y2, tex, tw, th, thickness, tint, alphaScale = 1.0) {
  const length = Math.hypot(x2 - x1, y2 - y1);
  if (length < 1.0 || th < 1) return;
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const half = thickness / 2.0;
  // 颜色剖面只取贴图的“不透明段”
  let r0 = 0;
  let r1 = th - 1;
  const midx = tw >> 1;
  while (r0 < th && tex[(r0 * tw + midx) * 4 + 3] < 250) r0++;
  while (r1 > 0 && tex[(r1 * tw + midx) * 4 + 3] < 250) r1--;
  if (r1 <= r0) {
    r0 = 0;
    r1 = th - 1;
  }
  const bx0 = Math.trunc(Math.min(x1, x2) - Math.abs(sa) * (half + 1) - 1);
  const bx1 = Math.trunc(Math.max(x1, x2) + Math.abs(sa) * (half + 1) + 2);
  const by0 = Math.trunc(Math.min(y1, y2) - Math.abs(ca) * (half + 1) - 1);
  const by1 = Math.trunc(Math.max(y1, y2) + Math.abs(ca) * (half + 1) + 2);
  for (let py = Math.max(0, by0); py < Math.min(ch, by1); py++) {
    for (let px = Math.max(0, bx0); px < Math.min(cw, bx1); px++) {
      const rx = px - x1;
      const ry = py - y1;
      const along = rx * ca + ry * sa;
      const across = -rx * sa + ry * ca;
      if (along < 0 || along > length || Math.abs(across) > half + 0.5) continue;
      const v = across / thickness + 0.5;
      const row = Math.trunc(Math.min(r1, Math.max(r0, pyRound(r0 + v * (r1 - r0)))));
      const o = row * tw * 4;
      const r = ifloor((tex[o] * tint[0]) / 255);
      const g = ifloor((tex[o + 1] * tint[1]) / 255);
      const b = ifloor((tex[o + 2] * tint[2]) / 255);
      const fade =
        Math.abs(across) <= half - 0.5 ? 1.0 : Math.max(0.0, half + 0.5 - Math.abs(across));
      const a = Math.trunc(255 * alphaScale * fade);
      if (a === 0) continue;
      blendPx(dst, (py * cw + px) * 4, r, g, b, a);
    }
  }
}

// -----------------------------------------------------------------------------
// 4. 布局计算
// -----------------------------------------------------------------------------

/** 方块占位左下角格坐标（对应 _tile_footprint）。 */
export function tileFootprint(x, y, size) {
  const off = (size - 1) >> 1;
  return [x - off, y - off];
}

/** 计算所有方块占位信息（对应 compute_layout）。 */
export function computeLayout(schem, sprites) {
  const raw = [];
  for (let ti = 0; ti < schem.tiles.length; ti++) {
    const t = schem.tiles[ti];
    const sp = sprites[t.block] || makePlaceholder(1);
    const size = sp.size;
    const [lx, by] = tileFootprint(t.x, t.y, size);
    raw.push({ ti, tile: t, size, lx, by, sprite: sp });
  }

  let minLx;
  let minBy;
  let maxRight;
  let maxTop;
  if (raw.length) {
    minLx = Math.min(...raw.map((e) => e.lx));
    minBy = Math.min(...raw.map((e) => e.by));
    maxRight = Math.max(...raw.map((e) => e.lx + e.size));
    maxTop = Math.max(...raw.map((e) => e.by + e.size));
  } else {
    minLx = 0;
    minBy = 0;
    maxRight = schem.width;
    maxTop = schem.height;
  }

  for (const e of raw) {
    e.px = (e.lx - minLx) * TILE;
    e.py = (maxTop - e.by - e.size) * TILE;
  }

  // 画家算法：先画靠下(by 小)的，再画靠上的；同层按左到右
  raw.sort((a, b) => a.by - b.by || a.lx - b.lx);

  const entryByIndex = new Map();
  for (const e of raw) entryByIndex.set(e.ti, e);

  return {
    min_lx: minLx,
    min_by: minBy,
    max_right: maxRight,
    max_top: maxTop,
    cols: maxRight - minLx,
    rows: maxTop - minBy,
    entries: raw,
    entry_by_index: entryByIndex,
  };
}

// -----------------------------------------------------------------------------
// 5. 背景 / 网格 / 放大
// -----------------------------------------------------------------------------

/** 每格 1px 淡网格线（对应 _draw_grid）。 */
export function drawGrid(buf, cw, ch) {
  const line = [255, 255, 255, 22];
  const xs = new Set();
  const ys = new Set();
  for (let x = 0; x < cw; x += TILE) xs.add(x);
  for (let y = 0; y < ch; y += TILE) ys.add(y);
  for (let yy = 0; yy < ch; yy++) {
    const base = yy * cw * 4;
    for (let xx = 0; xx < cw; xx++) {
      if (ys.has(yy) || xs.has(xx)) {
        const o = base + xx * 4;
        buf[o] = line[0];
        buf[o + 1] = line[1];
        buf[o + 2] = line[2];
        buf[o + 3] = line[3];
      }
    }
  }
}

/** 按原生分辨率平铺贴图（对应 _tile_background）。 */
export function tileBackground(buf, w, h, tex) {
  const tw = tex.w;
  const th = tex.h;
  const rgba = tex.rgba;
  for (let y = 0; y < h; y++) {
    const ty = (y % th) * tw * 4;
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      const o = ty + (x % tw) * 4;
      const d = row + x * 4;
      buf[d] = rgba[o];
      buf[d + 1] = rgba[o + 1];
      buf[d + 2] = rgba[o + 2];
      buf[d + 3] = rgba[o + 3];
    }
  }
}

/** 加边距并做最近邻整数放大（对应 _pad_and_scale）。返回 [W,H,Uint8ClampedArray]。 */
export function padAndScale(buf, cw, ch, scale, pad, transparent, bgtex) {
  const W = cw + 2 * pad;
  const H = ch + 2 * pad;
  const canvas = new Uint8ClampedArray(W * H * 4);
  if (!transparent) {
    for (let i = 0; i < W * H; i++) {
      const o = i * 4;
      canvas[o] = 16;
      canvas[o + 1] = 19;
      canvas[o + 2] = 25;
      canvas[o + 3] = 255;
    }
    if (bgtex) tileBackground(canvas, W, H, bgtex);
  }
  // 内容层带 alpha 叠加到背景上
  for (let yy = 0; yy < ch; yy++) {
    const s = yy * cw * 4;
    const d0 = ((yy + pad) * W + pad) * 4;
    for (let xx = 0; xx < cw; xx++) {
      const so = s + xx * 4;
      const a = buf[so + 3];
      if (a === 0) continue;
      const dofs = d0 + xx * 4;
      if (a === 255) {
        canvas[dofs] = buf[so];
        canvas[dofs + 1] = buf[so + 1];
        canvas[dofs + 2] = buf[so + 2];
        canvas[dofs + 3] = 255;
      } else {
        const ia = 255 - a;
        canvas[dofs] = ifloor((buf[so] * a + canvas[dofs] * ia) / 255);
        canvas[dofs + 1] = ifloor((buf[so + 1] * a + canvas[dofs + 1] * ia) / 255);
        canvas[dofs + 2] = ifloor((buf[so + 2] * a + canvas[dofs + 2] * ia) / 255);
        canvas[dofs + 3] = 255;
      }
    }
  }

  if (scale <= 1) return [W, H, canvas];

  const SW = W * scale;
  const out = new Uint8ClampedArray(SW * H * scale * 4);
  for (let yy = 0; yy < H; yy++) {
    const row = yy * W * 4;
    for (let sx = 0; sx < scale; sx++) {
      const destRow = (yy * scale + sx) * SW * 4;
      for (let xx = 0; xx < W; xx++) {
        const so = row + xx * 4;
        const r = canvas[so];
        const g = canvas[so + 1];
        const b = canvas[so + 2];
        const a = canvas[so + 3];
        for (let sxx = 0; sxx < scale; sxx++) {
          const d = destRow + (xx * scale + sxx) * 4;
          out[d] = r;
          out[d + 1] = g;
          out[d + 2] = b;
          out[d + 3] = a;
        }
      }
    }
  }
  return [SW, H * scale, out];
}

// -----------------------------------------------------------------------------
// 6. 中心配置图标 / 电力激光 / 桥
// -----------------------------------------------------------------------------

/** 绘制方块 sprite 层（多层/描边/旋转），供 underlay/overlay 复用。 */
function drawBlockSpriteLayers(buf, cw, ch, t, e, sprites, layers) {
  const cx = e.px + Math.floor((e.size * TILE) / 2);
  const cy = e.py + Math.floor((e.size * TILE) / 2);
  const names = layers ? LAYERS[t.block] || MOD_LAYERS[t.block] || [t.block] : [t.block];
  for (let li = 0; li < names.length; li++) {
    const lname = names[li];
    const optional = lname !== t.block;
    const sp = getSprite(sprites, lname, optional);
    if (!sp) continue;
    const sw = sp.w;
    const sh = sp.h;
    let rgba = sp.rgba;
    // outlineIcon 方块的顶层图标贴图先加描边（vanilla ∪ 模组）
    const outline = OUTLINE_ICON[t.block] || MOD_OUTLINE.get(t.block);
    if (li === names.length - 1 && outline) {
      const [ocol, orad] = outline;
      rgba = makeOutline(rgba, sw, sh, ocol, orad);
    }
    const [rw, rh, rrgba] = rotateSprite(rgba, sw, sh, t.rot);
    blend(buf, cw, ch, cx - Math.floor(rw / 2), cy - Math.floor(rh / 2), rrgba, rw, rh);
  }
}

/** 配置底层（在 sprite 层之前）。kind="item"：null → cross-full；有内容 → 整格内容色填充。 */
function drawConfigUnderlay(buf, cw, ch, t, e, sprites) {
  const cfg = t.config;
  const px = e.size * TILE;
  if (cfg === null) {
    const sp = getSprite(sprites, "cross-full", true) || getSprite(sprites, "cross", true);
    if (!sp) return;
    blend(buf, cw, ch, e.px + Math.floor((px - sp.w) / 2), e.py + Math.floor((px - sp.h) / 2), sp.rgba, sp.w, sp.h);
  } else {
    const color = CONTENT_COLORS[cfg] || [255, 255, 255];
    fillRect(buf, cw, ch, e.px, e.py, px, px, [color[0], color[1], color[2], 255]);
  }
}

/** 配置覆盖层（在 sprite 层之后）。
 *  centerTint：有内容 → `<block>-center` 乘内容色。
 *  liquidSource：source-bottom → (null?cross:fluid 着色铺满) → 重画该方块 sprite（最上层）。 */
function drawConfigOverlay(buf, cw, ch, t, e, sprites, layers) {
  const kind = CONFIG_OVERLAY[t.block];
  const px = e.size * TILE;
  const cfg = t.config;
  if (kind === "centerTint") {
    if (cfg === null) return;
    const sp = getSprite(sprites, t.block + "-center", true);
    if (!sp) return;
    const color = CONTENT_COLORS[cfg] || [255, 255, 255];
    blend(buf, cw, ch, e.px + Math.floor((px - sp.w) / 2), e.py + Math.floor((px - sp.h) / 2), tintRgba(sp.rgba, color), sp.w, sp.h);
  } else if (kind === "liquidSource") {
    const bottom = getSprite(sprites, "source-bottom", true);
    if (bottom) {
      blend(buf, cw, ch, e.px + Math.floor((px - bottom.w) / 2), e.py + Math.floor((px - bottom.h) / 2), bottom.rgba, bottom.w, bottom.h);
    }
    if (cfg === null) {
      const cross = getSprite(sprites, "cross", true);
      if (cross) {
        blend(buf, cw, ch, e.px + Math.floor((px - cross.w) / 2), e.py + Math.floor((px - cross.h) / 2), cross.rgba, cross.w, cross.h);
      }
    } else {
      const fluid = getSprite(sprites, "fluid", true);
      if (fluid) {
        const color = CONTENT_COLORS[cfg] || [255, 255, 255];
        tileBlit(buf, cw, ch, fluid, e.px, e.py, px, px, tintRgba(fluid.rgba, color));
      }
    }
    // 液体源：sprite 重画到最上层
    drawBlockSpriteLayers(buf, cw, ch, t, e, sprites, layers);
  }
}

/** 一根电力节点激光（对应 _draw_node_laser）。
 * alphaScale 覆盖默认透明度；opts 可覆盖 { width, capScale, color }（缺省用现有常量）。 */
export function drawNodeLaser(buf, cw, ch, x1, y1, size1, x2, y2, size2, sprites, alphaScale = POWER_LASER_ALPHA, opts = {}) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  if (length < 1e-3) return;
  const ux = dx / length;
  const uy = dy / length;
  const len1 = (size1 * TILE) / 2.0 - 1.5;
  const len2 = (size2 * TILE) / 2.0 - 1.5;
  const e1x = x1 + ux * len1;
  const e1y = y1 + uy * len1;
  const e2x = x2 - ux * len2;
  const e2y = y2 - uy * len2;
  const l1x = x1 + ux * (len1 + 2);
  const l1y = y1 + uy * (len1 + 2);
  const l2x = x2 - ux * (len2 + 2);
  const l2y = y2 - uy * (len2 + 2);
  const width = opts.width !== undefined ? opts.width : POWER_LASER_WIDTH;
  const capScale = opts.capScale !== undefined ? opts.capScale : POWER_LASER_SCALE;
  const color = opts.color || POWER_LASER_COLOR;
  const ang = (180 / Math.PI) * Math.atan2(dy, dx);

  const beam = getSprite(sprites, "laser", true);
  if (beam) {
    drawBeam(buf, cw, ch, l1x, l1y, l2x, l2y, beam.rgba, beam.w, beam.h, width, color, alphaScale);
  }
  const end = getSprite(sprites, "laser-end", true);
  if (end) {
    blitRotated(buf, cw, ch, end.rgba, end.w, end.h, e1x, e1y, capScale, ang + 180, color, alphaScale);
    blitRotated(buf, cw, ch, end.rgba, end.w, end.h, e2x, e2y, capScale, ang, color, alphaScale);
  }
}

/** 由模组节点参数（scale/color1/color2）计算 drawNodeLaser 的 opts。 */
export function nodeLaserOpts(name) {
  const ni = MOD_POWER_NODES.get(name);
  if (!ni) return {}; // vanilla：沿用现有常量
  const scale = ni.scale !== undefined && ni.scale !== null ? ni.scale : 0.25;
  const c1 = parseColor(ni.color1) || [255, 255, 255];
  const c2 = parseColor(ni.color2) || [217, 247, 178];
  return {
    width: Math.round((POWER_LASER_WIDTH * scale) / 0.25),
    capScale: scale,
    color: lerpColor(c1, c2, 0.1),
  };
}

/** 第二遍：所有电力节点连线激光（对应 _draw_power_lasers）。laserAlpha 可覆盖默认透明度。 */
export function drawPowerLasers(buf, cw, ch, layout, sprites, laserAlpha = POWER_LASER_ALPHA) {
  const lookup = new Map();
  for (const e of layout.entries) lookup.set(`${e.tile.x},${e.tile.y}`, e);

  const isNode = (b) =>
    b === "power-node" || b === "power-node-large" || b === "surge-tower" || MOD_POWER_NODES.has(b);

  for (const e of layout.entries) {
    const t = e.tile;
    if (!isNode(t.block)) continue;
    if (t.config_type !== "point2Array" || !t.config) continue;
    const sx = e.px + (e.size * TILE) / 2.0;
    const sy = e.py + (e.size * TILE) / 2.0;
    const opts = nodeLaserOpts(t.block);
    for (const off of t.config) {
      const [ox, oy] = off;
      const te = lookup.get(`${t.x + ox},${t.y + oy}`);
      if (!te) continue;
      const tb = te.tile.block;
      if (!(POWER_BLOCKS.has(tb) || MOD_POWER_BLOCKS.has(tb) || MOD_POWER_NODES.has(tb))) continue;
      const tx = te.px + (te.size * TILE) / 2.0;
      const ty = te.py + (te.size * TILE) / 2.0;
      drawNodeLaser(buf, cw, ch, sx, sy, e.size, tx, ty, te.size, sprites, laserAlpha, opts);
    }
  }
}

/** 计算桥连接对（对应 _bridge_pairs）。返回 [[e, te], ...]。 */
export function bridgePairs(entries) {
  const key = (e) => `${e.tile.x},${e.tile.y}`;
  const isBridge = (b) => BRIDGE_BLOCKS.has(b) || MOD_BRIDGES.has(b);
  const bridges = entries.filter((e) => isBridge(e.tile.block));
  const lookup = new Map();
  for (const e of bridges) lookup.set(key(e), e);
  const claimed = new Set();
  const pairs = [];

  const rotations = (dx, dy) => [
    [dx, dy],
    [-dy, dx],
    [-dx, -dy],
    [dy, -dx],
  ];

  for (const e of bridges) {
    const t = e.tile;
    const rng = bridgeRangeOf(t.block);
    const cfg = t.config;
    if (t.config_type !== "point2" || !cfg) continue;
    const [dx, dy] = cfg;
    for (const [rx, ry] of rotations(dx, dy)) {
      if (Math.abs(rx) <= rng && Math.abs(ry) <= rng && (rx === 0 || ry === 0)) {
        const te = lookup.get(`${t.x + rx},${t.y + ry}`);
        if (
          te &&
          te.tile.block === t.block &&
          key(te) !== key(e) &&
          !claimed.has(key(e)) &&
          !claimed.has(key(te))
        ) {
          claimed.add(key(e));
          claimed.add(key(te));
          pairs.push([e, te]);
          break;
        }
      }
    }
  }

  for (const e of bridges) {
    if (claimed.has(key(e))) continue;
    const t = e.tile;
    const rng = bridgeRangeOf(t.block);
    let best = null;
    let bestd = 1 << 30;
    for (const o of bridges) {
      if (o === e || claimed.has(key(o))) continue;
      const ot = o.tile;
      const ddx = ot.x - t.x;
      const ddy = ot.y - t.y;
      if (ddx === 0 && ddy === 0) continue;
      if (ddx === 0 || ddy === 0) {
        const d = Math.abs(ddx) + Math.abs(ddy);
        if (d <= rng && d < bestd) {
          best = o;
          bestd = d;
        }
      }
    }
    if (best !== null) {
      claimed.add(key(e));
      claimed.add(key(best));
      pairs.push([e, best]);
    }
  }

  return pairs;
}

/** 第二遍：桥连接（对应 _draw_bridges）。bridgeOpacity 可覆盖默认透明度。 */
export function drawBridges(buf, cw, ch, layout, sprites, bridgeOpacity = BRIDGE_OPACITY) {
  for (const [e, te] of bridgePairs(layout.entries)) {
    const sorted = [e, te].sort((p, q) => p.tile.x - q.tile.x || p.tile.y - q.tile.y);
    const a = sorted[0];
    const b = sorted[1];
    const ax = a.px + (a.size * TILE) / 2.0;
    const ay = a.py + (a.size * TILE) / 2.0;
    const bx = b.px + (b.size * TILE) / 2.0;
    const by = b.py + (b.size * TILE) / 2.0;
    const dx = bx - ax;
    const dy = by - ay;
    const dist = Math.hypot(dx, dy);
    if (dist < 1.0) continue;
    const ux = dx / dist;
    const uy = dy / dist;
    const l1x = ax + (ux * TILE) / 2.0;
    const l1y = ay + (uy * TILE) / 2.0;
    const l2x = bx - (ux * TILE) / 2.0;
    const l2y = by - (uy * TILE) / 2.0;

    const body = getSprite(sprites, a.tile.block + "-bridge", true);
    if (body) {
      drawBeam(buf, cw, ch, l1x, l1y, l2x, l2y, body.rgba, body.w, body.h, bridgeWidthOf(a.tile.block), [255, 255, 255], bridgeOpacity);
    }
    const arrow = getSprite(sprites, a.tile.block + "-arrow", true);
    if (arrow) {
      const ang = (180 / Math.PI) * Math.atan2(dy, dx);
      blitRotated(buf, cw, ch, arrow.rgba, arrow.w, arrow.h, (ax + bx) / 2.0, (ay + by) / 2.0, 1.0, ang, [255, 255, 255], bridgeOpacity);
    }
  }
}

// -----------------------------------------------------------------------------
// 7. 渲染主入口
// -----------------------------------------------------------------------------

/**
 * 渲染蓝图，返回 { width, height, rgba, layout }（对应 render_schematic）。
 * opts: { scale=2, pad=16, transparent=false, grid=false,
 *         layers=true, config_icons=true, lasers=true,
 *         laserAlpha=POWER_LASER_ALPHA, bridgeOpacity=BRIDGE_OPACITY }
 */
export function renderSchematic(schem, sprites, opts = {}) {
  const scale = opts.scale !== undefined ? opts.scale : 2;
  const pad = opts.pad !== undefined ? opts.pad : 16;
  const transparent = !!opts.transparent;
  const grid = !!opts.grid;
  const layers = opts.layers !== undefined ? opts.layers : true;
  const configIcons = opts.config_icons !== undefined ? opts.config_icons : true;
  const lasers = opts.lasers !== undefined ? opts.lasers : true;
  const laserAlpha = opts.laserAlpha !== undefined ? opts.laserAlpha : POWER_LASER_ALPHA;
  const bridgeOpacity = opts.bridgeOpacity !== undefined ? opts.bridgeOpacity : BRIDGE_OPACITY;

  const layout = computeLayout(schem, sprites);
  const cw = layout.cols * TILE;
  const ch = layout.rows * TILE;

  const buf = new Uint8ClampedArray(cw * ch * 4);

  if (grid) drawGrid(buf, cw, ch);

  // ---- 第一遍：配置底层 → 方块图标（多层，按中心对齐） → 配置覆盖层 ----
  for (const e of layout.entries) {
    const t = e.tile;
    if (configIcons && CONFIG_UNDERLAY[t.block]) {
      drawConfigUnderlay(buf, cw, ch, t, e, sprites);
    }
    drawBlockSpriteLayers(buf, cw, ch, t, e, sprites, layers);
    if (configIcons && CONFIG_OVERLAY[t.block]) {
      drawConfigOverlay(buf, cw, ch, t, e, sprites, layers);
    }
  }

  // ---- 第二遍：桥连接 + 电力节点激光 ----
  if (lasers) {
    drawBridges(buf, cw, ch, layout, sprites, bridgeOpacity);
    drawPowerLasers(buf, cw, ch, layout, sprites, laserAlpha);
  }

  const bgtex = transparent ? null : getSprite(sprites, "schematic-background", true);
  const [W, H, final] = padAndScale(buf, cw, ch, scale, pad, transparent, bgtex);
  layout.content_w = cw;
  layout.content_h = ch;
  layout.pad = pad;
  layout.full_w = W;
  layout.full_h = H;
  return { width: W, height: H, rgba: final, layout };
}
