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

  // 2) 模组 JSON name 字段
  for (const m of mods || []) {
    if (!m || !m.blocks) continue;
    for (const c of cands) {
      const def = m.blocks.get(c);
      if (def && def.name) return def.name;
    }
  }

  // 3) 内置中文表
  for (const c of cands) {
    if (BLOCK_CN[c]) return BLOCK_CN[c];
  }

  // 4) 内部名
  return name;
}
