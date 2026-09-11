// =============================================================================
// requirements.js —— 蓝图总耗材计算（纯函数，可在 Node 下单测）
//
// 与游戏 Schematic.requirements() 一致：遍历每个方块，把其 requirements
// 直接累加，无任何倍率；没有数据的方块跳过。
// =============================================================================

import { BLOCK_REQUIREMENTS, ITEM_CN } from "./requirements_data.js";
import { CONTENT_CN } from "./data.js";

/**
 * 累加蓝图总耗材。
 * @param {Array<{block:string}>} tiles 蓝图方块列表
 * @param {Object} table 方块 → [[物品, 数量], ...]
 * @returns {Map<string, number>} 物品 → 总数
 */
export function computeRequirements(tiles, table = BLOCK_REQUIREMENTS) {
  const totals = new Map();
  for (const t of tiles) {
    const req = table[t.block];
    if (!req) continue;
    for (const [item, n] of req) {
      totals.set(item, (totals.get(item) || 0) + n);
    }
  }
  return totals;
}

/**
 * 返回排序后的耗材列表：[{ item, name, count }]，按数量降序，再按名称升序。
 * 名称优先 nameOf(item)（模组 bundle），其次 ITEM_CN，再 CONTENT_CN，最后英文名。
 */
export function requirementsList(tiles, table = BLOCK_REQUIREMENTS, nameOf = null) {
  const totals = computeRequirements(tiles, table);
  return [...totals.entries()]
    .map(([item, count]) => {
      const modName = nameOf ? nameOf(item) : null;
      return { item, name: modName || ITEM_CN[item] || CONTENT_CN[item] || item, count };
    })
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
