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
  battery: ["battery", "battery-top"],
  "battery-large": ["battery-large", "battery-large-top"],
  "mass-driver": ["mass-driver-base", "mass-driver"],
  sorter: ["source-bottom", "sorter"],
  "inverted-sorter": ["source-bottom", "inverted-sorter"],
  "liquid-source": ["source-bottom", "liquid-source"],
  "liquid-tank": ["liquid-tank-bottom", "liquid-tank"],
  "reinforced-liquid-tank": [
    "reinforced-liquid-tank-bottom",
    "reinforced-liquid-tank",
  ],
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

// 使用 drawPlanConfigCenter(plan, config, "center", cross=true) 的方块。
// 这些方块在预览时会于中心叠加：config 为空→cross，config 为内容→center(着色)。
export const CENTER_CONFIG_BLOCKS = new Set([
  "sorter",
  "inverted-sorter",
  "liquid-source",
  "item-source",
  "unloader",
]);

// 内容名 → 颜色（物品/液体）。未知内容回退白色。
// 水：#596ab8（Liquids.java 已确认）。
export const CONTENT_COLORS = {
  water: [0x59, 0x6a, 0xb8],
  slag: [0xff, 0xa1, 0x66],
  oil: [0x31, 0x31, 0x31],
  cryofluid: [0x6e, 0xc1, 0xff],
  copper: [0xd9, 0x9d, 0x73],
  lead: [0x8c, 0x7f, 0xa9],
  metaglass: [0xeb, 0xee, 0xf4],
  graphite: [0xb2, 0xc6, 0xd2],
  silicon: [0x53, 0x56, 0x5c],
  titanium: [0x8d, 0xa1, 0xb7],
  thorium: [0xf9, 0xa3, 0xc7],
  plastanium: [0x58, 0xd3, 0xa3],
  "phase-fabric": [0xf4, 0xba, 0x6e],
  "surge-alloy": [0xf3, 0xe9, 0x79],
  "spore-pod": [0x74, 0x57, 0xce],
  "blast-compound": [0xff, 0x79, 0x5e],
  pyratite: [0xff, 0xaa, 0x5f],
  beryllium: [0x8c, 0xa1, 0xa7],
  tungsten: [0x76, 0x8a, 0x94],
  oxide: [0xe0, 0xff, 0xb3],
  carbide: [0x6f, 0x7c, 0x8a],
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
