// =============================================================================
// blending.js —— 邻居拼接（Autotiler）纯函数移植（Mindustry v159.7 官方源码）
//
// 逐条对照：
//   * core/src/mindustry/world/blocks/Autotiler.java
//       - buildBlending / transformCase / blends(默认) / blendsArmored / facing /
//         notLookingAt / lookingAtEither / lookingAt
//   * core/src/mindustry/world/blocks/distribution/Conveyor.java      blends()
//   * core/src/mindustry/world/blocks/distribution/ArmoredConveyor.java blends()/blendsArmored()
//   * core/src/mindustry/world/blocks/distribution/Duct.java          blends()/blendsArmored()
//   * core/src/mindustry/world/blocks/distribution/StackConveyor.java blends()
//   * core/src/mindustry/world/blocks/liquid/Conduit.java             blends()
//   * core/src/mindustry/world/blocks/liquid/ArmoredConduit.java      blends()
//   * core/src/mindustry/world/Edges.java                             getFacingEdge
//   * core/src/mindustry/world/Tile.java                              relativeTo / nearbyBuild
//
// 约定（与官方 Geometry.d4 / Tile.nearbyBuild 一致）：
//   方向索引 0=东(+x) 1=北(+y) 2=西(-x) 3=南(-y)；realDir = mod(rotation - direction, 4)。
//   方块坐标 (x,y) 为蓝图锚点：占格 [x-off, x+size-off)，off = floor((size-1)/2)，
//   与 Tile.getLinkedTiles 的 block.sizeOffset 一致。
//
// 本模块不依赖浏览器 API，可在 Node 下单测。
// =============================================================================

export const D4X = [1, 0, -1, 0];
export const D4Y = [0, 1, 0, -1];

export function mod4(n) {
  return ((n | 0) % 4 + 4) % 4;
}
export function d4x(i) {
  return D4X[mod4(i)];
}
export function d4y(i) {
  return D4Y[mod4(i)];
}

function eq(x1, y1, x2, y2) {
  return x1 === x2 && y1 === y2;
}
function clampInt(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Tile.relativeTo(x,y,cx,cy)：返回 from (x,y) 指向 (cx,cy) 的方向，不相邻返回 -1。 */
export function relativeTo(x, y, cx, cy) {
  if (x === cx && y === cy - 1) return 1;
  if (x === cx && y === cy + 1) return 3;
  if (x === cx - 1 && y === cy) return 0;
  if (x === cx + 1 && y === cy) return 2;
  return -1;
}

/** Edges.getFacingEdge(block, tilex, tiley, other)：otherblock 朝 other 的贴边格。 */
export function getFacingEdge(size, tilex, tiley, other) {
  if (size <= 1) return { x: tilex, y: tiley };
  const off = (size - 1) >> 1;
  const dx = clampInt(other.x - tilex, -off, size >> 1);
  const dy = clampInt(other.y - tiley, -off, size >> 1);
  return { x: tilex + dx, y: tiley + dy };
}

// -----------------------------------------------------------------------------
// 世界查询：模板化的 schematic tiles + 方块属性查询
// -----------------------------------------------------------------------------

/**
 * 构造拼接用「世界」视图。
 * @param {Array<{x:number,y:number,block:string,rot:number}>} tiles 蓝图方块
 * @param {(blockName:string)=>object} props 方块属性查询（见 render_rules.blockProps）
 */
export function makeTileWorld(tiles, props) {
  const byCell = new Map();
  const anchors = [];
  for (const t of tiles) {
    const size = Math.max(1, (props(t.block) || {}).size || 1);
    const off = (size - 1) >> 1;
    const lx = t.x - off;
    const ly = t.y - off;
    anchors.push({ x: t.x, y: t.y, block: t.block, rot: t.rot | 0, size });
    for (let dx = 0; dx < size; dx++) {
      for (let dy = 0; dy < size; dy++) {
        byCell.set(`${lx + dx},${ly + dy}`, t);
      }
    }
  }
  const world = {
    props,
    anchors,
    /** 覆盖该格的方块锚点 tile（含 multiblock 任意贴格），无则 null。 */
    find(x, y) {
      return byCell.get(`${x},${y}`) || null;
    },
    /** Tile.nearbyBuild(rotation)。 */
    nearbyBuild(x, y, dir) {
      return byCell.get(`${x + d4x(dir)},${y + d4y(dir)}`) || null;
    },
  };
  return world;
}

// -----------------------------------------------------------------------------
// Autotiler 判定助手（Autotiler.java）
// -----------------------------------------------------------------------------

function typeOf(world, block) {
  return (world.props(block) || {}).type || "";
}
function isConveyor(world, block) {
  const t = typeOf(world, block);
  return t === "Conveyor" || t === "ArmoredConveyor";
}
/** Block.rotatedOutput(fromX, fromY, tile)（含各类覆盖，静态近似）。 */
function rotatedOutput(world, block, fromX, fromY) {
  const p = world.props(block) || {};
  const t = p.type;
  // 覆盖为 false 的类型（源码逐一核对）：Turret 及子类 / DuctRouter / OverflowDuct /
  // PayloadUnloader / HeaterGenerator / BeamDrill / WallCrafter；GenericCrafter 的
  // 3 参版本按输出方向判断，静态渲染近似为 false（即允许拼接）。
  if (TURRET_TYPES.has(t) || ROTATED_OUTPUT_FALSE.has(t)) return false;
  if (p.isGenericCrafterLike) return false;
  if (t === "StackConveyor") return p.rotate !== false; // stateUnload 运行时决定，静态近似
  return !!p.rotate;
}

const TURRET_TYPES = new Set([
  "Turret", "ItemTurret", "LiquidTurret", "PowerTurret", "LaserTurret",
  "ContinuousTurret", "ContinuousLiquidTurret",
]);
const ROTATED_OUTPUT_FALSE = new Set([
  "DuctRouter", "OverflowDuct", "PayloadUnloader", "HeaterGenerator",
  "BeamDrill", "WallCrafter", "BuildTurret", "PointDefenseTurret",
  "RepairTurret", "TractorBeamTurret",
]);

/** Autotiler.facing(x,y,rotation,x2,y2)。 */
export function facing(x, y, rotation, x2, y2) {
  return eq(x + d4x(rotation), y + d4y(rotation), x2, y2);
}

/** Autotiler.lookingAt(tile, rotation, otherx, othery, otherblock)。 */
export function lookingAt(world, tile, rotation, otherx, othery, otherblock) {
  const size = (world.props(otherblock) || {}).size || 1;
  const fe = getFacingEdge(size, otherx, othery, tile);
  return fe != null && eq(tile.x + d4x(rotation), tile.y + d4y(rotation), fe.x, fe.y);
}

/** Autotiler.notLookingAt。 */
export function notLookingAt(world, tile, rotation, otherx, othery, otherrot, otherblock) {
  return !(rotatedOutput(world, otherblock, otherx, othery) &&
    eq(otherx + d4x(otherrot), othery + d4y(otherrot), tile.x, tile.y));
}

/** Autotiler.lookingAtEither。 */
export function lookingAtEither(world, tile, rotation, otherx, othery, otherrot, otherblock) {
  return (
    eq(tile.x + d4x(rotation), tile.y + d4y(rotation), otherx, othery) ||
    !rotatedOutput(world, otherblock, otherx, othery) ||
    eq(otherx + d4x(otherrot), othery + d4y(otherrot), tile.x, tile.y)
  );
}

// -----------------------------------------------------------------------------
// blendsArmored 三个变体（Autotiler 默认 / Duct / ArmoredConveyor）
// -----------------------------------------------------------------------------

function blendsArmoredDefault(world, tile, rotation, otherx, othery, otherrot, otherblock) {
  const size = (world.props(otherblock) || {}).size || 1;
  const edge = getFacingEdge(size, otherx, othery, tile);
  if (eq(tile.x + d4x(rotation), tile.y + d4y(rotation), otherx, othery)) return true;
  if (!rotatedOutput(world, otherblock, otherx, othery) && edge != null &&
      relativeTo(edge.x, edge.y, tile.x, tile.y) === rotation) return true;
  if (rotatedOutput(world, otherblock, otherx, othery) &&
      eq(otherx + d4x(otherrot), othery + d4y(otherrot), tile.x, tile.y)) return true;
  return false;
}

function blendsArmoredDuct(world, tile, rotation, otherx, othery, otherrot, otherblock) {
  const size = (world.props(otherblock) || {}).size || 1;
  const edge = getFacingEdge(size, otherx, othery, tile);
  if (eq(tile.x + d4x(rotation), tile.y + d4y(rotation), otherx, othery)) return true;
  if (!rotatedOutput(world, otherblock, otherx, othery) && edge != null &&
      relativeTo(edge.x, edge.y, tile.x, tile.y) === rotation) return true;
  if (rotatedOutput(world, otherblock, otherx, othery) &&
      !!(world.props(otherblock) || {}).isDuct &&
      eq(otherx + d4x(otherrot), othery + d4y(otherrot), tile.x, tile.y)) return true;
  return false;
}

function blendsArmoredConveyor(world, tile, rotation, otherx, othery, otherrot, otherblock) {
  const size = (world.props(otherblock) || {}).size || 1;
  const edge = getFacingEdge(size, otherx, othery, tile);
  if (eq(tile.x + d4x(rotation), tile.y + d4y(rotation), otherx, othery)) return true;
  if (!rotatedOutput(world, otherblock, otherx, othery) && edge != null &&
      relativeTo(edge.x, edge.y, tile.x, tile.y) === rotation) return true;
  if (isConveyor(world, otherblock) && rotatedOutput(world, otherblock, otherx, othery) &&
      eq(otherx + d4x(otherrot), othery + d4y(otherrot), tile.x, tile.y)) return true;
  return false;
}

// -----------------------------------------------------------------------------
// 各 Autotiler 实现类的 blends 重写
// -----------------------------------------------------------------------------

/** 当前 tile 的方块属性。 */
function selfProps(world, tile) {
  return world.props(tile.block) || {};
}

/** 分发：按 tile 方块类型调用对应 blends 重写。 */
export function blendsImpl(world, tile, rotation, otherx, othery, otherrot, otherblock) {
  const op = world.props(otherblock) || {};
  const t = selfProps(world, tile).type;

  if (t === "Conveyor") {
    // Conveyor.java:82
    return (
      (!!op.outputsItems || (lookingAt(world, tile, rotation, otherx, othery, otherblock) && !!op.hasItems)) &&
      lookingAtEither(world, tile, rotation, otherx, othery, otherrot, otherblock)
    );
  }
  if (t === "ArmoredConveyor") {
    // ArmoredConveyor.java:17
    return (
      (!!op.outputsItems && blendsArmoredConveyor(world, tile, rotation, otherx, othery, otherrot, otherblock)) ||
      (lookingAt(world, tile, rotation, otherx, othery, otherblock) && !!op.hasItems)
    );
  }
  if (t === "Duct") {
    // Duct.java:96
    if (!selfProps(world, tile).armored) {
      return (
        (!!op.outputsItems || (lookingAt(world, tile, rotation, otherx, othery, otherblock) && !!op.hasItems)) &&
        lookingAtEither(world, tile, rotation, otherx, othery, otherrot, otherblock)
      );
    }
    return (
      (!!op.outputsItems && blendsArmoredDuct(world, tile, rotation, otherx, othery, otherrot, otherblock)) ||
      (lookingAt(world, tile, rotation, otherx, othery, otherblock) && !!op.hasItems)
    );
  }
  if (t === "Conduit") {
    // Conduit.java:135
    return (
      !!op.hasLiquids &&
      (!!op.outputsLiquid || lookingAt(world, tile, rotation, otherx, othery, otherblock)) &&
      lookingAtEither(world, tile, rotation, otherx, othery, otherrot, otherblock)
    );
  }
  if (t === "ArmoredConduit") {
    // ArmoredConduit.java:15
    return (
      (!!op.outputsLiquid && blendsArmoredDefault(world, tile, rotation, otherx, othery, otherrot, otherblock)) ||
      (lookingAt(world, tile, rotation, otherx, othery, otherblock) && !!op.hasLiquids) ||
      op.type === "LiquidJunction"
    );
  }
  if (t === "StackConveyor") {
    // StackConveyor.java:66（默认 stateMove 分支的静态近似）
    return !!op.outputsItems && blendsArmoredDefault(world, tile, rotation, otherx, othery, otherrot, otherblock) &&
      op.type === "StackConveyor";
  }
  return false;
}

/**
 * Autotiler.blends(tile, rotation, directional, direction, checkWorld) 的世界版：
 * 邻居只在蓝图内查找（蓝图外视为无连接）。
 */
export function blends(world, tile, rotation, direction) {
  const other = world.nearbyBuild(tile.x, tile.y, mod4(rotation - direction));
  if (other == null) return false;
  return blendsImpl(world, tile, rotation, other.x, other.y, other.rot | 0, other.block);
}

/** Autotiler.transformCase。 */
export function transformCase(num, bits) {
  switch (num) {
    case 0: bits.blendbits = 3; break;
    case 1: bits.blendbits = 4; break;
    case 2: bits.blendbits = 2; break;
    case 3: bits.blendbits = 2; bits.yscl = -1; break;
    case 4: bits.blendbits = 1; bits.yscl = -1; break;
    case 5: bits.blendbits = 1; break;
    default: break;
  }
}

/**
 * Autotiler.buildBlending。返回：
 * { blendbits, xscl, yscl, blendmask, nonsquaremask, num }
 */
export function buildBlending(world, tile, rotation) {
  const bits = { blendbits: 0, xscl: 1, yscl: 1, blendmask: 0, nonsquaremask: 0, num: -1 };
  const b = (dir) => blends(world, tile, rotation, dir);

  const num =
    b(2) && b(1) && b(3) ? 0 :
    b(1) && b(3) ? 1 :
    b(1) && b(2) ? 2 :
    b(3) && b(2) ? 3 :
    b(1) ? 4 :
    b(3) ? 5 : -1;
  bits.num = num;
  transformCase(num, bits);

  // 4 位方向 mask
  for (let i = 0; i < 4; i++) {
    if (b(i)) bits.blendmask |= (1 << i);
  }

  // 非方形贴图方向 mask（[4]）
  for (let i = 0; i < 4; i++) {
    const realDir = mod4(rotation - i);
    const nb = world.nearbyBuild(tile.x, tile.y, realDir);
    if (b(i) && nb != null && !(world.props(nb.block) || {}).squareSprite) {
      bits.nonsquaremask |= (1 << i);
    }
  }
  return bits;
}
