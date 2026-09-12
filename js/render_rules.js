// =============================================================================
// render_rules.js —— 类型驱动的渲染规则表（v159.7 官方源码逐类还原）
//
// 背景：旧实现用手写清单（data.js 的 LAYERS / BRIDGE_BLOCKS / BRIDGE_RANGE、
// spriteAliasCandidates、CONFIG_UNDERLAY/OVERLAY、OUTLINE_ICON…）描述每个方块的
// 多层贴图与桥/配置行为，遇到新方块类型就要打补丁。本模块改为「按官方 Java 类
// 名（type）查规则」：
//   1. 模组方块优先用 JSON 的 type/drawer/range（drawer 走 mod.js 的
//      drawerStaticLayers，仍由 setModLayers 注入）；无 drawer 时按同名 type。
//   2. vanilla 方块用 tools/gen_vanilla_blocks.py 从 Blocks.java 生成的
//      vanilla_blocks.js（方块名 → type/size/range），再套本文件的类型规则。
//
// 本模块为纯函数（不依赖浏览器 API），可在 Node 下单测。
//
// 贴图命名事实（v159.7，assets 只有变体、没有本体图）：
//   - 传送带：<name>-<blend 0..4>-<frame 0..3>；静态渲染取 0 号变体 + 方块旋转。
//   - 导管：共享底图 conduit-bottom + <name>-top-<blend 0..4>；取 top-0 + 方块旋转。
//   - 管道：共享底图 duct-bottom + <name>-top-<blend 0..4>；取 top-0 + 方块旋转。
//   - 钻头/泵：<name> + <name>-rotator + <name>-top。
//
// 重要（与任务描述的偏差，已按官方源码核实）：变体的第一个下标是「连接/混合
// 形状」而非旋转角。Conveyor.draw() 用 Draw.rect(regions[blendbits][frame], …,
// rotation * 90)（Conveyor.java），Conduit.drawPlanRegion 也用 plan.rotation*90
// （Conduit.java）。因此本模块 regions() 取 0 号变体，旋转仍由 render.js 施加，
// 从而保持既有校验效果。
// =============================================================================

import { VANILLA_BLOCKS } from "./vanilla_blocks.js?v=20260913j";
import { VANILLA_TURRETS } from "./vanilla_turrets.js?v=20260913j";

/** 仅取自有属性，避免方块名（如 "constructor"）撞上 Object.prototype 上的同名属性。 */
function own(obj, key) {
  return obj != null && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

// -----------------------------------------------------------------------------
// 基础解析：方块名 + 可选模组 def → type / size / range
// -----------------------------------------------------------------------------

/** 方块内部名（模组 def.base 优先）。 */
export function baseOf(blockName, def) {
  if (def && def.base) return String(def.base);
  return String(blockName == null ? "" : blockName);
}

/** 解析方块类型（官方 Java 类名）：模组 def.type 优先，其次内置 vanilla 表。 */
export function typeOfBlock(blockName, def) {
  if (def && def.type) return String(def.type);
  const v = own(VANILLA_BLOCKS, blockName);
  return v ? String(v.type) : "";
}

/** 解析占地尺寸：def.size 优先，其次 vanilla 表，默认 1。 */
export function sizeOfBlock(blockName, def) {
  if (def && Number(def.size) > 0) return Number(def.size);
  const v = own(VANILLA_BLOCKS, blockName);
  if (v && Number(v.size) > 0) return Number(v.size);
  return 1;
}

/** 解析声明范围：def.range 优先，其次 vanilla 表。 */
export function rangeOfBlock(blockName, def) {
  if (def && def.range !== undefined && def.range !== null && !Number.isNaN(Number(def.range))) {
    return Number(def.range);
  }
  const v = own(VANILLA_BLOCKS, blockName);
  if (v && v.range !== undefined) return Number(v.range);
  return undefined;
}

/** 桥类型判定：官方类名以 Bridge 结尾（ItemBridge/LiquidBridge/DuctBridge/…）。 */
export function isBridgeType(type) {
  return typeof type === "string" && type.length > 0 && type.endsWith("Bridge");
}

/** 质量驱动器类：MassDriver（含模组同后缀）。 */
export function isMassDriverType(type) {
  return type === "MassDriver" || (typeof type === "string" && type.endsWith("MassDriver"));
}

/** 电力节点类：PowerNode / LongPowerNode 等。 */
export function isPowerNodeType(type) {
  return typeof type === "string" && type.length > 0 && type.endsWith("PowerNode");
}

// -----------------------------------------------------------------------------
// 区域列表构造器
// -----------------------------------------------------------------------------
const drillRegions = (n) => [n, n + "-rotator", n + "-top"];
const topRegions = (n) => [n, n + "-top"];
const conveyorRegions = (n) => [n + "-0-0"];
const conduitRegions = (n) => ["conduit-bottom", n + "-top-0"];
const ductRegions = (n) => ["duct-bottom", n + "-top-0"];
const wallCrafterRegions = (n) => [n, n + "-rotator-bottom", n + "-rotator", n + "-top"];
const massDriverRegions = (n) => [n + "-base", n];
const thermalRegions = (n) => [n, n + "-rotator"];
const singleRegion = (n) => [n];

// -----------------------------------------------------------------------------
// 类型规则表：键为小写官方类名
//
// 每条注释标注来源类/方法。`regions` 为 null 表示该类的图层由各方块自定义
// drawer（vanilla 落在 data.js 的 LAYERS；模组落在 drawerStaticLayers）决定，
// 规则表不覆盖——避免误伤 kiln/pulverizer/vent-condenser/liquid-tank 等特例。
// -----------------------------------------------------------------------------
const TYPE_RULES = {
  // --- 传输（distribution） ---
  // Conveyor.java：icons() = regions[0][0]；draw() 取 regions[blendbits][frame] + rotation*90
  conveyor: { regions: conveyorRegions },
  // ArmoredConveyor extends Conveyor
  armoredconveyor: { regions: conveyorRegions },
  // StackConveyor.java：drawPlanRegion 用 regions[0] + rotation*90
  stackconveyor: { regions: singleRegion },
  // Conduit.java：icons() = [conduit-bottom, topRegions[0]]；drawPlanRegion 两段均 rotation*90
  conduit: { regions: conduitRegions },
  // ArmoredConduit extends Conduit（仅多 cap，静止不画）
  armoredconduit: { regions: conduitRegions },
  // Duct.java：icons() = [duct-bottom, topRegions[0]]（botRegions fallback=duct-bottom-#）
  duct: { regions: ductRegions },
  // MassDriver.java：icons() = [baseRegion, region]
  massdriver: { regions: massDriverRegions, outline: [[0x40, 0x40, 0x49], 4] },
  // Sorter.java：图标 [source-bottom, region]；配置影响贴图走 underlay（见 configKind）
  sorter: { regions: singleRegion, configKind: "item" },
  // Unloader.java：centerRegion（@-center，fallback unloader-center）为覆盖层
  unloader: { regions: singleRegion, configKind: "centerTint" },
  // DirectionalUnloader.java：icons() = [region, topRegion, arrowRegion]；arrow 动态不画
  directionalunloader: { regions: topRegions, configKind: "centerTint" },
  // DuctRouter.java：icons() = [region, topRegion]
  ductrouter: { regions: topRegions },
  // OverflowDuct.java：icons() = [region, topRegion]
  overflowduct: { regions: topRegions },
  // StackRouter.java：本体 + top
  stackrouter: { regions: topRegions },

  // --- 桥（ItemBridge 家族 + DirectionBridge 家族） ---
  // ItemBridge.java / LiquidBridge.java / DirectionBridge.java：第二遍绘制 -bridge/-arrow
  itembridge: { regions: singleRegion, bridge: true },
  buffereditembridge: { regions: singleRegion, bridge: true },
  liquidbridge: { regions: singleRegion, bridge: true },
  directionliquidbridge: { regions: singleRegion, bridge: true },
  ductbridge: { regions: singleRegion, bridge: true },
  directionbridge: { regions: singleRegion, bridge: true },

  // --- 生产（production） ---
  // Drill.java：icons() = [region, rotatorRegion, topRegion]
  drill: { regions: drillRegions },
  // BurstDrill.java：icons() = [region, topRegion]
  burstdrill: { regions: topRegions },
  // BeamDrill.java：icons() = [region, topRegion]
  beamdrill: { regions: topRegions },
  // WallCrafter.java：draw() 常驻 region + topRegion + rotatorBottom/rotator
  wallcrafter: { regions: wallCrafterRegions },
  // SolidPump.java：icons() = [region, rotatorRegion, topRegion]
  solidpump: { regions: drillRegions },
  // Fracker extends SolidPump（油井）
  fracker: { regions: drillRegions },
  // Pump.java：默认 drawer DrawMulti(DrawDefault, DrawPumpLiquid) → [region]
  pump: { regions: singleRegion },
  // GenericCrafter.java：drawer 字段（默认 DrawDefault），各方块自定义 → 交给 LAYERS
  genericcrafter: { regions: null },
  // AttributeCrafter extends GenericCrafter
  attributecrafter: { regions: null },
  // HeatCrafter extends GenericCrafter
  heatcrafter: { regions: null },
  // Separator.java：本体 + 工作态 → 仅本体
  separator: { regions: singleRegion },

  // --- 电力（power） ---
  // Battery.java：checkDrawDefault → DrawMulti(DrawDefault, DrawPower, DrawRegion(-top))
  battery: { regions: topRegions },
  // NuclearReactor.java：常驻 topRegion；lightsRegion 仅在过热时 → 不画 lights
  nuclearreactor: { regions: topRegions, workingOnly: true },
  // ConsumeGenerator.java：本体 + top
  consumegenerator: { regions: topRegions },
  // ThermalGenerator.java：本体 + rotator（turbine-condenser）
  thermalgenerator: { regions: thermalRegions },
  // PowerGenerator.java：drawer = DrawDefault → [region]
  powergenerator: { regions: singleRegion },
  // LightBlock.java：本体 + top
  lightblock: { regions: topRegions },
  // ImpactReactor：drawer DrawMulti(DrawRegion(-bottom), DrawPlasma, DrawDefault) → -bottom 属绘制层
  impactreactor: { regions: null },
  // VariableReactor：drawer 自定义
  variablereactor: { regions: null },

  // --- 防御 / 投影仪（defense） ---
  // ForceProjector.java：topRegion 仅在 buildup>0（护盾工作态）时画 → 不画
  forceprojector: { regions: singleRegion, workingOnly: true },
  // MendProjector.java：常驻 topRegion
  mendprojector: { regions: topRegions },
  // OverdriveProjector.java：常驻 topRegion
  overdriveprojector: { regions: topRegions },
  // RegenProjector：本体 + bottom/mid/glow（工作态）→ 交给 LAYERS/默认
  regenprojector: { regions: null },
  // ShieldWall.java：glow 工作态 → 仅本体
  shieldwall: { regions: singleRegion, workingOnly: true },
  // BaseShield：护盾（工作态）→ 仅本体
  baseshield: { regions: singleRegion, workingOnly: true },

  // --- 炮塔（defense.turrets） ---
  // Turret.java：drawer = DrawTurret（炮管为动态部件）；本体 + top 常驻
  turret: { regions: topRegions },
  baseturret: { regions: topRegions },
  itemturret: { regions: topRegions },
  liquidturret: { regions: topRegions },
  powerturret: { regions: topRegions },
  pointdefenseturret: { regions: topRegions },
  continuousturret: { regions: topRegions },
  continuousliquidturret: { regions: topRegions },
  laserturret: { regions: topRegions },
  tractorbeamturret: { regions: topRegions },
  repairturret: { regions: topRegions },

  // --- 单位工厂 / 重建（units） ---
  // UnitFactory.java：icons() = [region, outRegion, topRegion]（out 缺图则略）
  unitfactory: { regions: topRegions },
  // Reconstructor.java：icons() = [region, inRegion, outRegion, topRegion]（in/out 缺图则略）
  reconstructor: { regions: topRegions },
  // UnitAssembler.java：icons() = [region, side1, topRegion]（side 缺图则略）
  unitassembler: { regions: topRegions },
  // UnitAssemblerModule.java：icons() = [region, topRegion]
  unitassemblermodule: { regions: topRegions },
  // LegacyUnitFactory（旧工厂）：本体 + top
  legacyunitfactory: { regions: topRegions },
  // UnitCargoUnloadPoint：本体 + top
  unitcargounloadpoint: { regions: topRegions },

  // --- 载荷（payloads） ---
  // Constructor.java（BlockProducer）：本体 + top
  constructor: { regions: topRegions },
  // PayloadDeconstructor.java：icons() = [region, topRegion]
  payloaddeconstructor: { regions: topRegions },
  // PayloadRouter.java：本体 + top（动态光带不画）
  payloadrouter: { regions: topRegions },
  // PayloadConveyor.java：icons() = [name + "-icon"]；渲染用本体（动态光带不画）
  payloadconveyor: { regions: singleRegion },
  // PayloadLoader/PayloadUnloader/PayloadSource/PayloadVoid：本体 + top
  payloadloader: { regions: topRegions },
  payloadunloader: { regions: topRegions },
  payloadsource: { regions: topRegions },
  payloadvoid: { regions: topRegions },
  // PayloadMassDriver.java：icons() = [baseRegion, outRegion, region]；由 LAYERS 保持既有观感
  payloadmassdriver: { regions: null },

  // --- 液体（liquid） ---
  // LiquidRouter.java：liquid-tank 等由 drawer/LAYERS 定义 → 交给 LAYERS
  liquidrouter: { regions: null },
  // LiquidSource.java：icons() = [bottomRegion, region]；覆盖层重画本体
  liquidsource: { regions: singleRegion, configKind: "liquidSource" },

  // --- 物流 / 沙盒（sandbox） ---
  // ItemSource.java：icons() = [source-bottom, region]；配置 underlay 重现 cross-full/item 色
  itemsource: { regions: singleRegion, configKind: "item" },

  // --- 墙体 / 推进器 ---
  // Thruster.java：icons() = [region, topRegion]
  thruster: { regions: topRegions },

  // --- 焚化炉 ---
  // Incinerator.java（slag-incinerator）：本体 + top
  incinerator: { regions: topRegions },
  itemincinerator: { regions: topRegions },
};

// 类型表中未显式列出、但属于桥的兜底：由 typeOfBlock 的 Bridge 后缀判定。

// 工作态专用的 drawer（不参与静止渲染）。drawerStaticLayers 已统一跳过；
// 此处仅导出，便于规则表/测试引用与文档化。
export const WORKING_ONLY_DRAWERS = new Set([
  "DrawFlame",
  "DrawFade",
  "DrawWarmupRegion",
  "DrawCrucibleFlame",
  "DrawGlowRegion",
  "DrawHeatInput",
  "DrawHeatRegion",
  "DrawPlasma",
  "DrawParticles",
  "DrawSoftCircle",
  "DrawPumpLiquid",
  "DrawCultivator",
  "DrawPistons",
  "DrawBlurSpin",
  "DrawPower",
  "DrawLiquidRegion",
  "DrawLiquidTile",
  "DrawTurret",
]);

// -----------------------------------------------------------------------------
// 规则查询
// -----------------------------------------------------------------------------
const ruleCache = new Map();

/**
 * 返回某方块（vanilla 或模组）的类型规则。
 * @param {string} blockName 方块内部名
 * @param {object} [def] 模组方块定义（含 type/base/size/range/drawer）；vanilla 可省略
 * @returns {{type,size,range,regions,bridge,configKind,workingOnly,outline}}
 */
export function vanillaRule(blockName, def) {
  const type = typeOfBlock(blockName, def);
  const key = type.toLowerCase();
  const cacheKey = key + "|" + baseOf(blockName, def);
  if (ruleCache.has(cacheKey)) return ruleCache.get(cacheKey);

  const spec = own(TYPE_RULES, key) || {};
  const n = baseOf(blockName, def);
  const bridgeInfo = isBridgeType(type) ? { range: bridgeRange(blockName, def) } : null;

  const rule = {
    type,
    size: sizeOfBlock(blockName, def),
    range: rangeOfBlock(blockName, def),
    regions:
      spec.regions === null
        ? null
        : typeof spec.regions === "function"
        ? (rot) => spec.regions(n, rot)
        : (rot) => [n],
    bridge: bridgeInfo,
    configKind: spec.configKind || null,
    workingOnly: !!spec.workingOnly,
    outline: spec.outline || null,
  };
  ruleCache.set(cacheKey, rule);
  return rule;
}

/** 桥连接范围：def.range → vanilla range → 4。 */
export function bridgeRange(blockName, def) {
  const r = rangeOfBlock(blockName, def);
  return r !== undefined ? r : 4;
}

/** 该方块是否参与桥连接（含模组；legacyBridgeNames 由调用方补充）。 */
export function isBridgeBlock(blockName, def) {
  return !!vanillaRule(blockName, def).bridge;
}

/** 配置影响贴图种类（保留两种观感）。 */
export function configKindOf(blockName, def) {
  return vanillaRule(blockName, def).configKind;
}

/** 方块主体贴图的变体兜底候选（无本体图时用；按类型精确化）。 */
export function spriteVariantCandidates(blockName, def) {
  const n = baseOf(blockName, def);
  const key = typeOfBlock(blockName, def).toLowerCase();
  if (key === "conveyor" || key === "armoredconveyor") return [n + "-0-0"];
  if (key === "stackconveyor") return [n + "-0"];
  if (key === "conduit" || key === "armoredconduit") return [n + "-top-0", "conduit-bottom"];
  if (key === "duct") return [n + "-top-0", "duct-bottom"];
  if (key === "massdriver") return [n + "-base"];
  // 通用变体兜底（与旧 spriteAliasCandidates 一致）
  return [n + "-0-0", n + "-bottom", n + "-top-0"];
}

/**
 * 预加载所需的配置贴图名（与 data.js 的 configSpriteNames 对已覆盖方块保持一致，
 * 并可按规则扩展到新类型）。
 */
export function configSpriteNamesFor(blockName, def) {
  const out = [];
  const kind = configKindOf(blockName, def);
  if (kind === "item") out.push("cross-full");
  else if (kind === "centerTint") out.push(baseOf(blockName, def) + "-center");
  else if (kind === "liquidSource") out.push("source-bottom", "fluid");
  return out;
}

/** 该类型是否有显式规则（用于测试/文档），未知类型返回 false。 */
export function hasTypeRule(blockName, def) {
  const key = typeOfBlock(blockName, def).toLowerCase();
  return Object.prototype.hasOwnProperty.call(TYPE_RULES, key);
}

// -----------------------------------------------------------------------------
// 拼接（Autotiler）/ 炮塔（DrawTurret）类型判定与属性查询
//
// 这些函数是 js/blending.js 与 js/render.js 共用的事实来源：
//   - AUTOTILER_TYPES：官方 implements Autotiler 的类（Conveyor/Duct/Conduit/StackConveyor）
//   - TURRET_TYPES   ：官方 drawer = DrawTurret 的类（Turret 及其子类，不含 BaseTurret）
//   - VANILLA_TURRETS：tools/gen_vanilla_blocks.py 生成的炮塔部件静态几何
// -----------------------------------------------------------------------------

export const AUTOTILER_TYPES = new Set([
  "Conveyor", "ArmoredConveyor", "Duct", "Conduit", "ArmoredConduit",
  // 注：StackConveyor 也 implements Autotiler，但官方 drawPlanRegion 用 regions[0] +
  // edgeRegion 的「各方向缺边」机制，而非 regions[blendbits] 变体，故不纳入本渲染路径。
  // （blending.js 仍保留其 blends 分支以备后续；此处按 TODO 处理。）
]);

export const TURRET_TYPES = new Set([
  "Turret", "ItemTurret", "LiquidTurret", "PowerTurret", "LaserTurret",
  "ContinuousTurret", "ContinuousLiquidTurret",
]);

const GENERIC_CRAFTER_TYPES = new Set(["GenericCrafter", "AttributeCrafter", "HeatCrafter"]);

/** 该方块是否走邻居拼接（含模组同名类型）。 */
export function isAutotilerBlock(blockName, def) {
  return AUTOTILER_TYPES.has(typeOfBlock(blockName, def));
}

/** 该方块是否为 DrawTurret 炮塔（含模组同名类型）。 */
export function isTurretBlock(blockName, def) {
  return TURRET_TYPES.has(typeOfBlock(blockName, def));
}

// 单位工厂/载荷工厂（PayloadBlock 家族）：本体不旋转，开口/箭头 outRegion 随旋转绘制。
// 官方来源：PayloadBlock.load()（findFactoryRegion：`<name>-out` → `factory-out-<size>`）；
// UnitFactory.draw()：region 不转、outRegion 转 rotdeg()、topRegion 最后。
export const FACTORY_TYPES = new Set(["UnitFactory", "PayloadCrafter", "PayloadFactory"]);

/** 该方块是否为工厂类（UnitFactory/PayloadBlock 家族）。 */
export function isFactoryBlock(blockName, def) {
  return FACTORY_TYPES.has(typeOfBlock(blockName, def));
}

/** 工厂类需绘制的贴图名（按官方 findFactoryRegion 顺序：per-block → 共享 factory-*-size）。 */
export function factorySpriteNames(blockName, size) {
  const s = Number(size) > 0 ? Number(size) : 3;
  return [blockName, blockName + "-out", "factory-out-" + s, blockName + "-top", "factory-top-" + s];
}

// 单位重构工厂（Reconstructor）：本体不转 + 输入/输出两个开口 + top。
// 官方来源：Reconstructor.draw()（region 不转 → inRegion@rotation*90（fallback）→ outRegion@rotdeg() → topRegion）。
export const RECONSTRUCTOR_TYPES = new Set(["Reconstructor"]);

/** 该方块是否为重构工厂类。 */
export function isReconstructorBlock(blockName, def) {
  return RECONSTRUCTOR_TYPES.has(typeOfBlock(blockName, def));
}

/** 重构工厂类需绘制的贴图名（in/out 均支持 per-block → 共享 factory-*-size）。 */
export function reconstructorSpriteNames(blockName, size) {
  const s = Number(size) > 0 ? Number(size) : 3;
  return [
    blockName,
    blockName + "-in",
    "factory-in-" + s,
    blockName + "-out",
    "factory-out-" + s,
    blockName + "-top",
    "factory-top-" + s,
  ];
}

// 从 VANILLA_BLOCKS 归纳「类名 -> 代表属性」，供模组方块（无内置 flags）按类型回退。
let _typeFlagDefaults = null;
function typeFlagDefaults(type) {
  if (_typeFlagDefaults === null) {
    _typeFlagDefaults = new Map();
    for (const n of Object.keys(VANILLA_BLOCKS)) {
      const v = own(VANILLA_BLOCKS, n);
      if (!v || !v.type) continue;
      if (!_typeFlagDefaults.has(v.type)) _typeFlagDefaults.set(v.type, v.flags || {});
    }
  }
  return _typeFlagDefaults.get(type) || {};
}

/**
 * 方块拼接属性查询（blending.js 的世界 props）。
 * 顺序：类名代表属性 → 方块显式 flags → 模组 def.flags（后者覆盖）。
 */
export function blockProps(blockName, def) {
  const type = typeOfBlock(blockName, def);
  const v = own(VANILLA_BLOCKS, blockName);
  const explicit = (v && v.flags) || {};
  const modFlags = (def && def.flags) || {};
  const f = Object.assign({}, typeFlagDefaults(type), explicit, modFlags);
  const hasItems = !!f.hasItems;
  return {
    type,
    size: sizeOfBlock(blockName, def),
    hasItems,
    hasLiquids: !!f.hasLiquids,
    outputsLiquid: !!f.outputsLiquid,
    outputsItems: f.outputsItems !== undefined ? !!f.outputsItems : hasItems,
    squareSprite: f.squareSprite !== false,
    rotate: !!f.rotate,
    rotateDraw: f.rotateDraw !== false,
    isDuct: !!f.isDuct,
    armored: !!f.armored,
    // 近似标记：GenericCrafter 家族的 rotatedOutput 依赖输出方向，静态渲染按 false 处理
    isGenericCrafterLike: GENERIC_CRAFTER_TYPES.has(type),
  };
}

/**
 * 通用静态绘制是否应把蓝图 rot 施加到方块贴图上。
 *
 * 官方依据（v159.7）：
 *   Block.drawDefaultPlanRegion()：
 *     Draw.rect(reg, x, y, !rotate || !rotateDraw ? 0 : plan.rotation * 90)
 *   即只有 `rotate && rotateDraw` 才旋转；否则恒 0°。
 *   rotate 默认 false、rotateDraw 默认 true（Block.java:122）。
 *
 * vanilla 直接查 js/vanilla_blocks.js 的 flags（rotate/rotateDraw 按类自身声明，
 * 仅记录与类默认不同的值），避免用「同类首个方块」的默认值污染具体方块；
 * 模组按 type 找同类默认，再叠加 def.flags，找不到默认 false。
 */
export function isRotatableBlock(blockName, def) {
  const v = own(VANILLA_BLOCKS, blockName);
  if (v) {
    const f = v.flags || {};
    return !!f.rotate && f.rotateDraw !== false;
  }
  const modFlags = (def && def.flags) || {};
  const f = Object.assign({}, typeFlagDefaults(typeOfBlock(blockName, def)), modFlags);
  return !!f.rotate && f.rotateDraw !== false;
}

// -----------------------------------------------------------------------------
// 炮塔贴图/部件查询
// -----------------------------------------------------------------------------

/** 炮塔 DrawTurret 信息：basePrefix 与 RegionPart 静态几何（vanilla 内置表 / 模组 def）。 */
export function turretInfo(blockName, def) {
  const n = baseOf(blockName, def);
  const v = own(VANILLA_TURRETS, blockName);
  const m = def && def.turret;
  const basePrefix = (v && v.basePrefix) || (m && m.basePrefix) || (def && def.basePrefix) || "";
  let parts = (v && v.parts) || (m && m.parts) || (def && def.parts) || [];
  // 部件名为方块名（base）拼接；若内置表 key 与 base 不同则仍以 base 为准。
  parts = parts.map((p) => ({
    suffix: p.suffix === undefined ? null : p.suffix,
    name: p.name || (p.suffix === null ? null : n + p.suffix),
    x: Number(p.x) || 0,
    y: Number(p.y) || 0,
    mirror: !!p.mirror,
    under: !!p.under,
  }));
  return { basePrefix, parts };
}

/** 炮塔本体：<base>-base（无则 <basePrefix>block-<size>）。 */
export function turretBaseName(blockName, def) {
  const n = baseOf(blockName, def);
  return n + "-base";
}
export function turretFallbackBaseName(blockName, def) {
  const info = turretInfo(blockName, def);
  return (info.basePrefix || "") + "block-" + sizeOfBlock(blockName, def);
}

/** 预加载所需贴图名（base/body/top/部件；base 的名称由调用方按存在性选择）。 */
export function turretSpriteNames(blockName, def) {
  const n = baseOf(blockName, def);
  const info = turretInfo(blockName, def);
  const size = sizeOfBlock(blockName, def);
  const out = [n + "-base", (info.basePrefix || "") + "block-" + size, n, n + "-top"];
  for (const p of info.parts) {
    const real = p.name || (n + (p.suffix || ""));
    if (p.mirror) out.push(real + "-r", real + "-l");
    else out.push(real);
  }
  return out;
}

/** 拼接系列预加载贴图名（0..4 号连接变体）。 */
export function autotilerSpriteNames(blockName, def) {
  const n = baseOf(blockName, def);
  const key = typeOfBlock(blockName, def).toLowerCase();
  const out = [];
  if (key === "conveyor" || key === "armoredconveyor" || key === "stackconveyor") {
    for (let b = 0; b < 5; b++) out.push(n + "-" + b + "-0");
  } else if (key === "conduit" || key === "armoredconduit") {
    for (let b = 0; b < 5; b++) {
      out.push(n + "-top-" + b, n + "-bottom-" + b, "conduit-bottom-" + b);
    }
  } else if (key === "duct") {
    for (let b = 0; b < 5; b++) {
      out.push(n + "-top-" + b, n + "-bottom-" + b, "duct-bottom-" + b);
    }
  }
  return out;
}

/**
 * 从「贴图加载结果」中筛出应报告的缺失项：**只有 required 缺失才报**。
 * 可选层（炮塔 -top/-base、工厂 -top、桥 -bridge/-arrow 等）缺失属正常，不应进警告。
 * @param {Array<{name:string, required:boolean, sprite:object|null}>} results
 * @returns {string[]}
 */
export function selectMissingSprites(results) {
  const missing = [];
  for (const r of results) {
    if (!r || !r.required) continue;
    if (!r.sprite || r.sprite.placeholder) missing.push(r.name);
  }
  return missing;
}
