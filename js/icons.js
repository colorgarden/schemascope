// =============================================================================
// icons.js —— Mindustry 私用区(PUA)图标字符解析与富文本渲染
//
// 游戏里消息/标签文本中的 PUA 字符（U+E000–U+F8FF）分两类：
//   1. 内容图标：由 icons/icons.properties 定义（code=名称|图集区域名），
//      游戏启动时把区域注册为字体字形；前端改为查贴图并用 <img> 呈现。
//   2. UI emoji（如左右箭头）：在静态字体 icon.ttf 里（U+E800–U+F308），
//      由 CSS @font-face 的 "MindustryIcons" 渲染。
//
// 本模块可在 Node 下单测：通过 setIconIndex() 注入 sprite_index.json。
// =============================================================================

import { CDN_PREFIX, LOCAL_SPRITE_DIR, BLOCK_CN, CONTENT_CN } from "./data.js";
import { ICON_BY_CODE } from "./icons_data.js";

// sprite_index.json 中贴图相对路径的基准前缀
const SPRITE_BASE = "core/assets-raw/";
// icon.ttf 覆盖的 UI emoji 码点范围
export const ICON_FONT_LO = 0xe800;
export const ICON_FONT_HI = 0xf308;

let INDEX = { all: {}, blocks: {}, items: {} };

/** 注入贴图索引（app.js 加载 sprite_index.json 后调用；测试直接传入对象）。 */
export function setIconIndex(index) {
  INDEX = {
    all: (index && index.all) || {},
    blocks: (index && index.blocks) || {},
    items: (index && index.items) || {},
  };
}

function lookupPath(name) {
  for (const tbl of [INDEX.all, INDEX.blocks, INDEX.items]) {
    if (tbl && Object.prototype.hasOwnProperty.call(tbl, name)) return tbl[name] || null;
  }
  return null;
}

const STRIP_PREFIXES = ["block-", "unit-", "item-", "status-", "team-"];

/**
 * 解析 PUA 码点为内容图标信息。
 * @returns {{name:string, region:string, spritePath:string|null}|null}
 *   code 不在 ICON_BY_CODE → null；在表中但找不到贴图 → spritePath 为 null。
 */
export function resolveIcon(code) {
  const ent = ICON_BY_CODE[code];
  if (!ent) return null;
  const name = ent[0];
  const region = ent[1];
  // region 结尾的 -ui 是后缀，去掉得到 base
  const base = region.endsWith("-ui") ? region.slice(0, -3) : region;
  if (!base) return { name, region, spritePath: null };

  const candidates = [base];
  for (const p of STRIP_PREFIXES) {
    if (base.startsWith(p)) {
      const stripped = base.slice(p.length);
      if (stripped) candidates.push(stripped);
    }
  }
  for (const c of candidates) {
    const path = lookupPath(c);
    if (path) return { name, region, spritePath: path };
  }
  return { name, region, spritePath: null };
}

/** 图标显示名：优先官方中文名，其次英文名。 */
export function iconDisplayName(icon) {
  return BLOCK_CN[icon.name] || CONTENT_CN[icon.name] || icon.name;
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function iconImg(icon) {
  const fileName = icon.spritePath.split("/").pop();
  // 与贴图加载一致的 URL 解析：优先本地 assets/sprites/，否则 jsDelivr CDN
  const local = LOCAL_SPRITE_DIR + fileName;
  const cdn = CDN_PREFIX + SPRITE_BASE + icon.spritePath;
  const label = escapeHtml(iconDisplayName(icon));
  return (
    `<img class="msch-icon" src="${escapeHtml(local)}" data-fb="${escapeHtml(cdn)}"` +
    ` alt="${label}" title="${label}" loading="lazy"` +
    ` onerror="this.onerror=null;this.src=this.dataset.fb">`
  );
}

/**
 * 把文本中的 PUA 内容图标替换为 <img class="msch-icon" src="…">。
 * 查不到映射的 PUA 字符保留原样（交给 MindustryIcons 字体）；其余文本做 HTML 转义。
 */
export function richText(text) {
  const s = String(text == null ? "" : text);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xe000 && code <= 0xf8ff) {
      const icon = resolveIcon(code);
      if (icon && icon.spritePath) {
        out += iconImg(icon);
        continue;
      }
    }
    out += escapeHtml(s[i]);
  }
  return out;
}

/**
 * 纯文本降级：内容图标 → [官方中文名]，UI emoji → 去掉，其余原样。
 * 用于 title 属性等无法放 HTML 的上下文。
 */
export function plainTextWithIcons(text) {
  const s = String(text == null ? "" : text);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xe000 && code <= 0xf8ff) {
      const icon = resolveIcon(code);
      if (icon) {
        out += "[" + iconDisplayName(icon) + "]";
        continue;
      }
      if (code >= ICON_FONT_LO && code <= ICON_FONT_HI) continue; // emoji 去掉
    }
    out += s[i];
  }
  return out;
}
