// =============================================================================
// vanilla_turrets.js —— 由 tools/gen_vanilla_blocks.py 从 Mindustry v159.7
//   Blocks.java 自动生成，请勿手改；复跑：
//   python3 tools/gen_vanilla_blocks.py <Blocks.java>
//
// 仅收录显式声明 `drawer = new DrawTurret(...)` 的炮塔（basePrefix 非空或有部件）。
// 字段：方块内部名 -> { basePrefix: string, parts: [
//   { suffix: string|null, name?: string, x: number, y: number,
//     mirror: boolean, under: boolean } ] }
//   - suffix 为 RegionPart 的后缀；贴图名 = 方块名 + suffix（官方 RegionPart 命名）。
//   - x/y 为 Mindustry 世界单位（×4 = 贴图像素），y 轴向上；渲染时屏幕 y 取反。
//   - mirror=true 时官方使用 <名>-r / <名>-l 两张镜像贴图。
//   - 仅静态几何：heat/glow/ShapePart/HaloPart/setAmmoParts/进度动画均已忽略。
// =============================================================================
export const VANILLA_TURRETS = {
  "afflict": { basePrefix: "reinforced-", parts: [
    { suffix: "-blade", x: 0.0, y: 0.0, mirror: true, under: true },
  ] },
  "breach": { basePrefix: "reinforced-", parts: [
  ] },
  "cyclone": { basePrefix: "", parts: [
    { suffix: "-barrel-3", x: 0.0, y: 0.0, mirror: false, under: true },
    { suffix: "-barrel-2", x: 0.0, y: 0.0, mirror: false, under: true },
    { suffix: "-barrel-1", x: 0.0, y: 0.0, mirror: false, under: true },
  ] },
  "diffuse": { basePrefix: "reinforced-", parts: [
    { suffix: "-front", x: 0.0, y: 0.0, mirror: true, under: false },
  ] },
  "disperse": { basePrefix: "reinforced-", parts: [
    { suffix: "-side", x: 0.0, y: 0.0, mirror: true, under: true },
    { suffix: "-mid", x: 0.0, y: 0.0, mirror: false, under: true },
    { suffix: "-blade", x: 0.0, y: 0.0, mirror: true, under: true },
  ] },
  "duo": { basePrefix: "", parts: [
    { suffix: "-barrel-l", x: 0.0, y: 0.0, mirror: false, under: true },
    { suffix: "-barrel-r", x: 0.0, y: 0.0, mirror: false, under: true },
  ] },
  "lustre": { basePrefix: "reinforced-", parts: [
    { suffix: "-blade", x: 0.0, y: 0.0, mirror: true, under: true },
    { suffix: "-inner", x: 0.0, y: 0.0, mirror: true, under: false },
    { suffix: "-mid", x: 0.0, y: 0.0, mirror: false, under: true },
  ] },
  "malign": { basePrefix: "reinforced-", parts: [
    { suffix: "-mouth", x: 0.0, y: 0.0, mirror: false, under: false },
    { suffix: "-end", x: 0.0, y: 0.0, mirror: false, under: false },
    { suffix: "-front", x: 0.0, y: 0.0, mirror: true, under: false },
    { suffix: "-back", x: 0.0, y: 0.0, mirror: true, under: false },
    { suffix: "-mid", x: 0.0, y: 0.0, mirror: false, under: false },
    { suffix: "-spine", x: 0.0, y: 0.0, mirror: true, under: true },
    { suffix: "-spine", x: 0.0, y: 0.0, mirror: true, under: true },
    { suffix: "-spine", x: 0.0, y: 0.0, mirror: true, under: true },
  ] },
  "salvo": { basePrefix: "", parts: [
    { suffix: "-side", x: 0.0, y: 0.0, mirror: true, under: false },
    { suffix: "-barrel", x: 0.0, y: 0.0, mirror: false, under: false },
  ] },
  "scathe": { basePrefix: "reinforced-", parts: [
    { suffix: "-blade", x: 0.0, y: 0.0, mirror: true, under: false },
    { suffix: "-side", x: 0.0, y: 0.0, mirror: true, under: false },
    { suffix: "-mid", x: 0.0, y: 0.0, mirror: false, under: true },
    { suffix: "-missile", x: 0.0, y: 0.0, mirror: false, under: true },
  ] },
  "scatter": { basePrefix: "", parts: [
    { suffix: "-mid", x: 0.0, y: 0.0, mirror: false, under: false },
  ] },
  "smite": { basePrefix: "reinforced-", parts: [
    { suffix: "-mid", x: 0.0, y: 0.0, mirror: false, under: false },
    { suffix: "-blade", x: 0.0, y: 0.0, mirror: true, under: false },
    { suffix: "-front", x: 0.0, y: 0.0, mirror: true, under: true },
    { suffix: "-back", x: 0.0, y: 0.0, mirror: true, under: true },
    { suffix: "-blade-bar", x: 0.0, y: 11.0, mirror: true, under: true },
    { suffix: "-blade-bar", x: 0.0, y: 1.5, mirror: true, under: true },
    { suffix: "-blade-bar", x: 0.0, y: -8.0, mirror: true, under: true },
    { suffix: "-spine", x: 0.0, y: 0.0, mirror: true, under: true },
    { suffix: "-spine", x: 0.0, y: 0.0, mirror: true, under: true },
    { suffix: "-spine", x: 0.0, y: 0.0, mirror: true, under: true },
    { suffix: "-spine", x: 0.0, y: 0.0, mirror: true, under: true },
  ] },
  "sublimate": { basePrefix: "reinforced-", parts: [
    { suffix: "-back", x: 5.5, y: -0.25, mirror: true, under: true },
    { suffix: "-front", x: 5.0, y: 4.25, mirror: true, under: true },
    { suffix: "-nozzle", x: 0.0, y: 0.0, mirror: true, under: false },
  ] },
  "titan": { basePrefix: "reinforced-", parts: [
    { suffix: "-barrel", x: 0.0, y: 0.0, mirror: false, under: false },
    { suffix: "-side", x: 0.0, y: 0.0, mirror: true, under: true },
  ] },
};
