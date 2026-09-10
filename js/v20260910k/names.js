// =============================================================================
// names.js —— 方块显示名解析（纯函数，可在 Node 下单测）
//
// 优先级：模组语言文件(bundle) → 模组 JSON `name` 字段 → 内置 BLOCK_CN → 内部名
// bundle 键尝试：block.<内部名>.name；若名字带 `<mod>-` 前缀再尝试 block.<base>.name。
// =============================================================================

import { BLOCK_CN } from "./data.js";

/** 生成候选名：原内部名；若带某模组 `<name>-` 前缀，再补去前缀的 base。 */
export function modNameCandidates(name, mods) {
  const cands = [name];
  for (const m of mods || []) {
    const modName = m && m.name ? String(m.name) : "";
    if (!modName) continue;
    const p = modName + "-";
    if (name.startsWith(p)) {
      const base = name.slice(p.length);
      if (base && !cands.includes(base)) cands.push(base);
    }
  }
  return cands;
}

/**
 * 方块显示名。
 * @param {string} name 内部名（如 "测试A-星河桥" 或 "mass-driver"）
 * @param {Array} mods 已加载模组数组（含 name/bundle/blocks）
 */
export function blockDisplayName(name, mods) {
  const cands = modNameCandidates(name, mods);

  // 1) 模组语言文件
  for (const m of mods || []) {
    if (!m || !m.bundle) continue;
    for (const c of cands) {
      const v = m.bundle.get(`block.${c}.name`);
      if (v) return v;
    }
  }

  // 2) 模组 JSON name 字段（与内部名相同 → 视为未翻译，继续往下走官方表）
  for (const m of mods || []) {
    if (!m || !m.blocks) continue;
    for (const c of cands) {
      const def = m.blocks.get(c);
      if (def && def.name && def.name !== c && def.name !== name) return def.name;
    }
  }

  // 3) 内置中文表
  for (const c of cands) {
    if (BLOCK_CN[c]) return BLOCK_CN[c];
  }

  // 4) 内部名
  return name;
}

// 贴图层后缀（长后缀优先，避免 -rotator 抢先于 -rotator-bottom）
const LAYER_SUFFIXES = [
  "-rotator-bottom", "-heat-top", "-spinner", "-preview", "-liquid", "-center",
  "-bridge", "-arrow", "-bottom", "-glass", "-light", "-glow", "-heat", "-rotator",
  "-base", "-part", "-out", "-mid", "-end", "-dir", "-rim", "-top",
];

/**
 * 贴图名 → 显示名（用于「贴图缺失」等提示）：
 * 若本身是已知方块（内置表或模组）→ blockDisplayName；
 * 否则循环剥离已知层后缀 / 末尾 `-数字`，每剥一次查方块表；命中即返回其显示名；都不命中返回原名。
 */
export function spriteDisplayName(name, mods) {
  if (!name) return name;
  const isBlock = (n) =>
    !!n && (Object.prototype.hasOwnProperty.call(BLOCK_CN, n) || (mods || []).some((m) => m && m.blocks && m.blocks.has(n)));
  if (isBlock(name)) return blockDisplayName(name, mods);

  let cur = name;
  for (;;) {
    let next = null;
    const m = /^(.*)-\d+$/.exec(cur);
    if (m && m[1]) next = m[1];
    if (!next) {
      for (const suf of LAYER_SUFFIXES) {
        if (cur.length > suf.length && cur.endsWith(suf)) {
          next = cur.slice(0, -suf.length);
          break;
        }
      }
    }
    if (!next) break;
    cur = next;
    if (isBlock(cur)) return blockDisplayName(cur, mods);
  }
  return name;
}
