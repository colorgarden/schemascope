// =============================================================================
// requirements.js —— 蓝图总耗材计算（纯函数，可在 Node 下单测）
//
// 与游戏 Schematic.requirements() 一致：遍历每个方块，把其 requirements
// 直接累加，无任何倍率；没有数据的方块跳过。
// =============================================================================

import { BLOCK_REQUIREMENTS, ITEM_CN } from "./requirements_data.js?v=20260920j";
import { CONTENT_CN } from "./data.js?v=20260920j";
import { VANILLA_BLOCKS } from "./vanilla_blocks.js?v=20260920j";

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
/**
 * 官方 arc.util.Strings.autoFixed(x, decimalPlaces)：保留至多 decimalPlaces 位小数，
 * 去掉尾随 0 与小数点（如 30 → "30"、7.2 → "7.2"、108 → "108"）。
 */
export function autoFixed(value, decimalPlaces = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  let s = n.toFixed(decimalPlaces);
  if (s.indexOf(".") >= 0) s = s.replace(/\.?0+$/, "");
  return s === "" || s === "-0" ? "0" : s;
}

/**
 * 蓝图电力收支（每刻），照官方 Schematic.powerProduction()/powerConsumption()：
 *   production  = Σ (block instanceof PowerGenerator ? getDisplayedPowerProduction() : 0)
 *   consumption = Σ (block.consPower != null ? block.consPower.usage : 0)
 * 生成的表中 powerProduction 已是 getDisplayedPowerProduction() 的值（ThermalGenerator
 * 已按 displayEfficiencyScale 折算），powerUsage 即 consPower.usage（缺省 0）。
 * @param {Array<{block:string}>} tiles 蓝图方块列表
 * @param {Object} blockTable 方块 → { powerProduction?, powerUsage? }（vanilla 或含模组）
 * @returns {{production:number, consumption:number}}
 */
export function computePower(tiles, blockTable = VANILLA_BLOCKS) {
  let production = 0;
  let consumption = 0;
  for (const t of tiles) {
    const def = blockTable[t.block];
    if (!def) continue;
    production += Number(def.powerProduction) || 0;
    consumption += Number(def.powerUsage) || 0;
  }
  return { production, consumption };
}

/** 四舍五入保留 2 位小数。 */
function round2(x) {
  return Math.round((Number(x) || 0) * 100) / 100;
}

/**
 * 蓝图运行时物品速率（每秒），照官方「每周期量 × 60 / 周期 ticks」：
 *   - crafter（GenericCrafter 等）：周期 = craftTime（缺省类默认 80）
 *   - 发电机（ConsumeGenerator/NuclearReactor/ImpactReactor）：周期 = itemDuration
 *   - 单位工厂（Reconstructor）：周期 = constructTime
 *   - 无任何周期字段时视为每刻（amount * 60）
 * 汇总后四舍五入保留 2 位小数。
 * @param {Array<{block:string}>} tiles
 * @param {Object} blockTable 方块 → { outputItems?, consumeItems?, craftTime?, itemDuration?,
 *   constructTime?, ammoItems?, fuelItems? }
 * @returns {{produce:Object, consume:Object, ammo:Set<string>, fuels:Object}}
 *   produce/consume: { 物品: 速率/秒 }；ammo: 弹药物品集合；
 *   fuels: { flammable:Set, explosive:Set, radioactive:Set }
 */
export function computeItemRates(tiles, blockTable = VANILLA_BLOCKS) {
  const produceRaw = {};
  const consumeRaw = {};
  const ammo = new Set();
  const fuels = { flammable: new Set(), explosive: new Set(), radioactive: new Set() };

  for (const t of tiles) {
    const def = blockTable[t.block];
    if (!def) continue;
    const cycle =
      (Number(def.craftTime) || 0) ||
      (Number(def.itemDuration) || 0) ||
      (Number(def.constructTime) || 0);
    const rate = (amount) => (cycle > 0 ? (amount * 60) / cycle : amount * 60);
    const add = (map, pairs) => {
      for (const [item, amount] of pairs || []) {
        map[item] = (map[item] || 0) + rate(amount);
      }
    };
    add(produceRaw, def.outputItems);
    add(consumeRaw, def.consumeItems);
    for (const item of def.ammoItems || []) ammo.add(item);
    if (def.fuelItems) {
      for (const cat of Object.keys(def.fuelItems)) {
        if (!fuels[cat]) fuels[cat] = new Set();
        for (const item of def.fuelItems[cat]) fuels[cat].add(item);
      }
    }
  }

  const finish = (m) => {
    const out = {};
    for (const k of Object.keys(m)) out[k] = round2(m[k]);
    return out;
  };
  return { produce: finish(produceRaw), consume: finish(consumeRaw), ammo, fuels };
}

export function requirementsList(tiles, table = BLOCK_REQUIREMENTS, nameOf = null) {
  const totals = computeRequirements(tiles, table);
  return [...totals.entries()]
    .map(([item, count]) => {
      const modName = nameOf ? nameOf(item) : null;
      return { item, name: modName || ITEM_CN[item] || CONTENT_CN[item] || item, count };
    })
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
