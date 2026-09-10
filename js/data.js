// =============================================================================
// data.js —— 常量与中文名称映射（逐项对照 msch.py 的“常量与中文名称表”）
// 该文件不含任何逻辑，只有纯数据，方便对照核对。
// =============================================================================

// 全量官方中文名（由 bundle_zh_CN.properties 生成）
import { CN_BLOCKS, CN_ITEMS, CN_LIQUIDS } from "./cn_data.js";

// CDN 前缀：只用 jsdelivr 的 @master（始终取最新贴图，允许跨域）
export const CDN_PREFIX = "https://cdn.jsdelivr.net/gh/Anuken/Mindustry@master/";

// 自托管贴图目录（可选：把 sprites/ 一并上传即可离线；缺失时自动回退 CDN）
export const LOCAL_SPRITE_DIR = "assets/sprites/";

// 每个方块占 32 像素
export const TILE = 32;

// 早期手写小表：仅用于补充 CN_BLOCKS 未覆盖的条目（不覆盖官方名）
const LEGACY_BLOCK_CN = {
  "micro-processor": "微型处理器",
  "logic-processor": "逻辑处理器",
  "hyper-processor": "超核处理器",
  "world-processor": "世界处理器",
  message: "信息板",
  "liquid-source": "液体源",
  "landing-pad": "接收台",
  "liquid-junction": "流体交叉器",
  battery: "电池",
  "battery-large": "大型电池",
  "bridge-conduit": "导管桥",
  "mass-driver": "质量驱动器",
  "liquid-tank": "流体储罐",
  "power-node": "电力节点",
  "power-node-large": "大型电力节点",
  sorter: "分类器",
  "inverted-sorter": "反向分类器",
  "reinforced-liquid-tank": "强化流体储罐",
  "reinforced-bridge-conduit": "强化流体带桥",
  router: "路由器",
  conveyor: "传送带",
};

const LEGACY_CONTENT_CN = {
  water: "水",
  "surge-alloy": "巨浪合金",
  copper: "铜",
  lead: "铅",
  metaglass: "钢化玻璃",
  graphite: "石墨",
  silicon: "硅",
  titanium: "钛",
  thorium: "钍",
  plastanium: "塑钢",
  "phase-fabric": "相织物",
  carbide: "碳化物",
  beryllium: "铍",
  tungsten: "钨",
  oxide: "氧化剂",
  oil: "原油",
  slag: "熔渣",
  cryofluid: "冷冻液",
  "blast-compound": "爆炸混合物",
  pyratite: "硫化物",
  "spore-pod": "孢子荚",
};

function extrasOnly(legacy, official) {
  const out = {};
  for (const [k, v] of Object.entries(legacy)) {
    if (!(k in official)) out[k] = v;
  }
  return out;
}

// 方块名 → 中文显示名（全量官方表；旧表仅补缺）
export const BLOCK_CN = { ...CN_BLOCKS, ...extrasOnly(LEGACY_BLOCK_CN, CN_BLOCKS) };

// 物品/液体名 → 中文显示名（全量官方表；旧表仅补缺）
export const CONTENT_CN = {
  ...CN_ITEMS,
  ...CN_LIQUIDS,
  ...extrasOnly(LEGACY_CONTENT_CN, { ...CN_ITEMS, ...CN_LIQUIDS }),
};

// ContentType 序号 → 中文标签（本蓝图中 0=物品，4=流体）
export const CONTENT_TYPE_LABEL = {
  0: "物品",
  1: "方块",
  2: "状态",
  4: "流体",
};

// TypeIO 对象标签名（用于调试/JSON）
export const TYPE_NAMES = {
  0: "null",
  1: "int",
  2: "long",
  3: "float",
  4: "string",
  5: "content",
  6: "intSeq",
  7: "point2",
  8: "point2Array",
  9: "techNode",
  10: "bool",
  11: "double",
  12: "building",
  13: "lAccess",
  14: "byteArray",
  15: "legacy",
  16: "boolArray",
  17: "unit",
  18: "vec2Array",
  19: "vec2",
  20: "team",
  21: "intArray",
  22: "objectArray",
  23: "unitCommand",
};

// -----------------------------------------------------------------------------
// 多层贴图合成表（bottom → top，均按方块中心对齐）
//
// 对应 Mindustry 的 Block.createIcons()：icons() 返回的贴图列表自下而上合成
// （第一张为底，后续每张居中叠加），即蓝图预览里的 fullIcon。
// 未列出的方块视为单层贴图（等于方块本体 region）。
// -----------------------------------------------------------------------------
export const LAYERS = {
  // 已有：电池 / 质驱 / 储罐（保持不动）
  battery: ["battery", "battery-top"],
  "battery-large": ["battery-large", "battery-large-top"],
  "mass-driver": ["mass-driver-base", "mass-driver"],
  "liquid-tank": ["liquid-tank-bottom", "liquid-tank"],
  "reinforced-liquid-tank": [
    "reinforced-liquid-tank-bottom",
    "reinforced-liquid-tank",
  ],
  // 配置类：无 source-bottom 层（v159.7）；liquid-source 由覆盖层处理
  sorter: ["sorter"],
  "inverted-sorter": ["inverted-sorter"],
  "liquid-source": ["liquid-source"],

  // 钻头类（base → rotator → top）
  "mechanical-drill": ["mechanical-drill", "mechanical-drill-rotator", "mechanical-drill-top"],
  "pneumatic-drill": ["pneumatic-drill", "pneumatic-drill-rotator", "pneumatic-drill-top"],
  "laser-drill": ["laser-drill", "laser-drill-rotator", "laser-drill-top"],
  "blast-drill": ["blast-drill", "blast-drill-rotator", "blast-drill-top"],
  "water-extractor": ["water-extractor", "water-extractor-rotator", "water-extractor-top"],
  "oil-extractor": ["oil-extractor", "oil-extractor-rotator", "oil-extractor-top"],
  pulverizer: ["pulverizer", "pulverizer-rotator", "pulverizer-top"],
  // 碎石机（额外 rotator-bottom）
  "cliff-crusher": ["cliff-crusher", "cliff-crusher-rotator-bottom", "cliff-crusher-rotator", "cliff-crusher-top"],
  "large-cliff-crusher": ["large-cliff-crusher", "large-cliff-crusher-rotator-bottom", "large-cliff-crusher-rotator", "large-cliff-crusher-top"],
  // 冷凝器（仅 rotator）
  "turbine-condenser": ["turbine-condenser", "turbine-condenser-rotator"],
  "vent-condenser": ["vent-condenser-bottom", "vent-condenser-rotator", "vent-condenser-mid", "vent-condenser"],
  // 仅 top
  "impact-drill": ["impact-drill", "impact-drill-top"],
  "eruption-drill": ["eruption-drill", "eruption-drill-top"],
  "plasma-bore": ["plasma-bore", "plasma-bore-top"],
  "large-plasma-bore": ["large-plasma-bore", "large-plasma-bore-top"],

  // 生产类（base → top）
  "spore-press": ["spore-press", "spore-press-top"],
  cultivator: ["cultivator", "cultivator-top"],

  // 电力类（base → top）
  illuminator: ["illuminator", "illuminator-top"],

  // 防御类（base → top；force-projector / shock-mine 不处理）

  // 单位工厂/重构类（base → top）
  "additive-reconstructor": ["additive-reconstructor", "additive-reconstructor-top"],
  "multiplicative-reconstructor": ["multiplicative-reconstructor", "multiplicative-reconstructor-top"],
  "exponential-reconstructor": ["exponential-reconstructor", "exponential-reconstructor-top"],
  "tetrative-reconstructor": ["tetrative-reconstructor", "tetrative-reconstructor-top"],
  "mech-fabricator": ["mech-fabricator", "mech-fabricator-top"],
  "mech-refabricator": ["mech-refabricator", "mech-refabricator-top"],
  "mech-assembler": ["mech-assembler", "mech-assembler-top"],
  "ship-fabricator": ["ship-fabricator", "ship-fabricator-top"],
  "ship-refabricator": ["ship-refabricator", "ship-refabricator-top"],
  "ship-assembler": ["ship-assembler", "ship-assembler-top"],
  "tank-fabricator": ["tank-fabricator", "tank-fabricator-top"],
  "tank-refabricator": ["tank-refabricator", "tank-refabricator-top"],
  "tank-assembler": ["tank-assembler", "tank-assembler-top"],
  "prime-refabricator": ["prime-refabricator", "prime-refabricator-top"],
  "basic-assembler-module": ["basic-assembler-module", "basic-assembler-module-top"],
  "unit-cargo-unload-point": ["unit-cargo-unload-point", "unit-cargo-unload-point-top"],

  // 载荷类（base → top；payload-conveyor 系列不处理）
  constructor: ["constructor", "constructor-top"],
  "large-constructor": ["large-constructor", "large-constructor-top"],
  deconstructor: ["deconstructor", "deconstructor-top"],
  "small-deconstructor": ["small-deconstructor", "small-deconstructor-top"],
  "payload-loader": ["payload-loader", "payload-loader-top"],
  "payload-unloader": ["payload-unloader", "payload-unloader-top"],
  "payload-router": ["payload-router", "payload-router-top"],
  "payload-source": ["payload-source", "payload-source-top"],
  "payload-void": ["payload-void", "payload-void-top"],
  "payload-mass-driver": ["payload-mass-driver", "payload-mass-driver-top"],
  "large-payload-mass-driver": ["large-payload-mass-driver", "large-payload-mass-driver-top"],
  "reinforced-payload-router": ["reinforced-payload-router", "reinforced-payload-router-top"],

  // 管道类（base → top）
  "duct-router": ["duct-router", "duct-router-top"],
  "duct-unloader": ["duct-unloader", "duct-unloader-top"],
  "overflow-duct": ["overflow-duct", "overflow-duct-top"],
  "underflow-duct": ["underflow-duct", "underflow-duct-top"],
  "surge-router": ["surge-router", "surge-router-top"],

  // 其它
  wave: ["wave", "wave-top"],
  tsunami: ["tsunami", "tsunami-top"],
  sublimate: ["sublimate", "sublimate-top"],
  thruster: ["thruster", "thruster-top"],
  "liquid-overflow-gate": ["liquid-overflow-gate", "liquid-overflow-gate-top"],

  // 原版顶盖（按用户要求恢复；官方为常驻或静态可见的顶层 region）
  kiln: ["kiln", "kiln-top"],
  "silicon-smelter": ["silicon-smelter", "silicon-smelter-top"],
  "silicon-crucible": ["silicon-crucible", "silicon-crucible-top"],
  "surge-smelter": ["surge-smelter", "surge-smelter-top"],
  "plastanium-compressor": ["plastanium-compressor", "plastanium-compressor-top"],
  "slag-incinerator": ["slag-incinerator", "slag-incinerator-top"],
  "combustion-generator": ["combustion-generator", "combustion-generator-top"],
  "steam-generator": ["steam-generator", "steam-generator-top"],
  "differential-generator": ["differential-generator", "differential-generator-top"],
  "rtg-generator": ["rtg-generator", "rtg-generator-top"],
  "thorium-reactor": ["thorium-reactor", "thorium-reactor-top"],
  mender: ["mender", "mender-top"],
  "mend-projector": ["mend-projector", "mend-projector-top"],
  "overdrive-projector": ["overdrive-projector", "overdrive-projector-top"],
  "overdrive-dome": ["overdrive-dome", "overdrive-dome-top"],
};

// 辅助贴图相对 core/assets-raw/ 的路径兜底表（sprite_index.json 未索引时使用）。
// 值为字符串时用 index.sprites_base；值为 [base, path] 时用自定义 base。
export const AUX_PATHS = {
  // 中心配置图标（Block.drawPlanConfigCenter）
  center: "sprites/blocks/distribution/center.png",
  cross: "sprites/blocks/distribution/cross.png",
  "cross-full": "sprites/blocks/distribution/cross-full.png",
  // 多层底图
  "source-bottom": "sprites/blocks/sandbox/source-bottom.png",
  "battery-top": "sprites/blocks/power/battery-top.png",
  "mass-driver-base": "sprites/blocks/distribution/mass-driver-base.png",
  "liquid-tank-bottom": "sprites/blocks/liquid/liquid-tank-bottom.png",
  // 配置影响贴图（v159.7）
  "unloader-center": "sprites/blocks/storage/unloader-center.png",
  "duct-unloader-center": "sprites/blocks/ducts/duct-unloader-center.png",
  fluid: "sprites/blocks/liquid/fluid.png",
  // 电力节点激光（effects 贴图）
  laser: "sprites/effects/laser.png",
  "laser-end": "sprites/effects/laser-end.png",
  // 导管桥（ItemBridge.drawPlanConfigTop 备用）
  "bridge-conduit-arrow": "sprites/blocks/liquid/bridge-conduit-arrow.png",
  "bridge-conduit-bridge": "sprites/blocks/liquid/bridge-conduit-bridge.png",
  "bridge-conduit-end": "sprites/blocks/liquid/bridge-conduit-end.png",
  // 原版蓝图卡片背景（SchematicsDialog.SchematicImage 使用；
  // 该贴图在 core/assets/ 而不是 assets-raw，故用 [base, path]）
  "schematic-background": ["core/assets/", "sprites/schematic-background.png"],
};

// 配置影响贴图：sprite 层「之前」绘制的底层（v159.7 源码）
//   sorter/inverted-sorter/item-source：null → cross-full；有内容 → 整格填充内容色
export const CONFIG_UNDERLAY = {
  sorter: "item",
  "inverted-sorter": "item",
  "item-source": "item",
};

// 配置影响贴图：sprite 层「之后」绘制的覆盖层
//   unloader/duct-unloader：centerTint（有内容 → <block>-center 乘内容色）
//   liquid-source：source-bottom → (null?cross:fluid 着色铺满) → 重画 sprite
export const CONFIG_OVERLAY = {
  unloader: "centerTint",
  "duct-unloader": "centerTint",
  "liquid-source": "liquidSource",
};

// 内容名 → 颜色（物品/液体，取自 Mindustry v159.7 Items.java / Liquids.java）。未知内容回退白色。
export const CONTENT_COLORS = {
  // 物品
  copper: [0xd9, 0x9d, 0x73],
  lead: [0x8c, 0x7f, 0xa9],
  metaglass: [0xeb, 0xee, 0xf5],
  graphite: [0xb2, 0xc6, 0xd2],
  sand: [0xf7, 0xcb, 0xa4],
  coal: [0x27, 0x27, 0x27],
  titanium: [0x8d, 0xa1, 0xe3],
  thorium: [0xf9, 0xa3, 0xc7],
  scrap: [0x77, 0x77, 0x77],
  silicon: [0x53, 0x56, 0x5c],
  plastanium: [0xcb, 0xd9, 0x7f],
  "phase-fabric": [0xf4, 0xba, 0x6e],
  "surge-alloy": [0xf3, 0xe9, 0x79],
  "spore-pod": [0x74, 0x57, 0xce],
  "blast-compound": [0xff, 0x79, 0x5e],
  pyratite: [0xff, 0xaa, 0x5f],
  beryllium: [0x3a, 0x8f, 0x64],
  tungsten: [0x76, 0x8a, 0x9a],
  oxide: [0xe4, 0xff, 0xd6],
  carbide: [0x89, 0x76, 0x9a],
  "fissile-matter": [0x5e, 0x98, 0x8d],
  "dormant-cyst": [0xdf, 0x82, 0x4d],
  // 液体
  water: [0x59, 0x6a, 0xb8],
  slag: [0xff, 0xa1, 0x66],
  oil: [0x31, 0x31, 0x31],
  cryofluid: [0x6e, 0xcd, 0xec],
  neoplasm: [0xc3, 0x3e, 0x2b],
  arkycite: [0x84, 0xa9, 0x4b],
  gallium: [0x9a, 0x9d, 0xbf],
  ozone: [0xfc, 0x81, 0xdd],
  hydrogen: [0x9e, 0xab, 0xf7],
  nitrogen: [0xef, 0xe3, 0xff],
  cyanogen: [0x89, 0xe8, 0xb6],
};

// 视为电力方块、可作为电力节点连线目标的方块
export const POWER_BLOCKS = new Set([
  "mass-driver",
  "battery",
  "battery-large",
  "power-node",
  "power-node-large",
  "surge-tower",
  "diode",
  "power-source",
  "power-void",
  "thermal-generator",
  "combustion-generator",
  "steam-generator",
  "differential-generator",
  "impact-reactor",
  "thorium-reactor",
  "rtg-generator",
  "solar-panel",
  "solar-panel-large",
]);

// 电力节点激光颜色：setupColor(1) = lerp(white, #d9f7b2, absin(3f,0.1f)) ≈ 近白
export const POWER_LASER_COLOR = [251, 251, 247];
// 激光透明度：源码 Renderer.laserOpacity 默认 0.5，用户要求改为不透明
export const POWER_LASER_ALPHA = 1.0;
export const POWER_LASER_SCALE = 0.25;
// 光束（矩形段）总宽度（游戏像素）
export const POWER_LASER_WIDTH = 6;

// 桥连接
export const BRIDGE_BLOCKS = new Set([
  "bridge",
  "bridge-conduit",
  "phase-conduit",
  "phase-bridge",
  "reinforced-bridge",
  "reinforced-bridge-conduit",
]);
export const BRIDGE_RANGE = { "phase-conduit": 12, "phase-bridge": 12 };
// 连接带宽 = 24px（用户指定）
export const BRIDGE_WIDTH = 24;
// 桥连接透明度（用户要求降低不透明度 = 更透）
export const BRIDGE_OPACITY = 0.5;

// 图标描边（Block.createIcons：outlineIcon=true 的方块）
// 格式：方块名 -> [描边色, 半径]
export const OUTLINE_ICON = {
  "mass-driver": [[0x40, 0x40, 0x49], 4],
};

// 默认渲染参数
export const DEFAULT_SCALE = 2;
export const DEFAULT_PAD = 16;
