/**
 * 轴对齐包围盒。
 *
 * 方块形状是静态的（定义时构造一次），所以用不可变对象没有性能问题。
 * 实体的扫掠碰撞在热路径上，那里一律用 6 个裸 number 传参，不构造对象 ——
 * 见 core/physics 与 docs/RULES.md 第 9 条。
 */

export interface Aabb {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

export function aabb(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): Aabb {
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

/** 用 1/16 格为单位构造，方便直接抄方块模型的数值 */
export function aabb16(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): Aabb {
  return {
    minX: minX / 16,
    minY: minY / 16,
    minZ: minZ / 16,
    maxX: maxX / 16,
    maxY: maxY / 16,
    maxZ: maxZ / 16,
  };
}

/** 满格方块 */
export const FULL_BLOCK: Aabb = aabb(0, 0, 0, 1, 1, 1);
/** 空碰撞（花、草、火把之类） */
export const NO_COLLISION: readonly Aabb[] = [];
/** 单个满格方块的形状列表，绝大多数方块共用这一个实例 */
export const FULL_BLOCK_SHAPE: readonly Aabb[] = [FULL_BLOCK];

export function aabbIntersects(a: Aabb, b: Aabb): boolean {
  return (
    a.minX < b.maxX && a.maxX > b.minX &&
    a.minY < b.maxY && a.maxY > b.minY &&
    a.minZ < b.maxZ && a.maxZ > b.minZ
  );
}

export function aabbContainsPoint(a: Aabb, x: number, y: number, z: number): boolean {
  return x >= a.minX && x <= a.maxX && y >= a.minY && y <= a.maxY && z >= a.minZ && z <= a.maxZ;
}

/** 平移一个包围盒（返回新对象，不要在热路径里用） */
export function aabbOffset(a: Aabb, dx: number, dy: number, dz: number): Aabb {
  return {
    minX: a.minX + dx,
    minY: a.minY + dy,
    minZ: a.minZ + dz,
    maxX: a.maxX + dx,
    maxY: a.maxY + dy,
    maxZ: a.maxZ + dz,
  };
}

/** 各方向扩张（负值收缩） */
export function aabbExpand(a: Aabb, d: number): Aabb {
  return {
    minX: a.minX - d,
    minY: a.minY - d,
    minZ: a.minZ - d,
    maxX: a.maxX + d,
    maxY: a.maxY + d,
    maxZ: a.maxZ + d,
  };
}

/** 沿运动方向拉伸，得到扫掠体的粗包围盒 */
export function aabbStretch(a: Aabb, dx: number, dy: number, dz: number): Aabb {
  return {
    minX: dx < 0 ? a.minX + dx : a.minX,
    minY: dy < 0 ? a.minY + dy : a.minY,
    minZ: dz < 0 ? a.minZ + dz : a.minZ,
    maxX: dx > 0 ? a.maxX + dx : a.maxX,
    maxY: dy > 0 ? a.maxY + dy : a.maxY,
    maxZ: dz > 0 ? a.maxZ + dz : a.maxZ,
  };
}

/** 以 (x,y,z) 为底面中心，构造宽 w 高 h 的实体碰撞盒 */
export function entityAabb(x: number, y: number, z: number, width: number, height: number): Aabb {
  const half = width / 2;
  return {
    minX: x - half,
    minY: y,
    minZ: z - half,
    maxX: x + half,
    maxY: y + height,
    maxZ: z + half,
  };
}
