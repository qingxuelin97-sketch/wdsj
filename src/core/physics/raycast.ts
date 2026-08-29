/**
 * 方块射线求交（DDA 体素遍历）。
 *
 * 用来回答"准星指着哪一格、指着它的哪一面"。挖掘、放置、方块高亮框
 * 全都靠它，而且**客户端与服务端必须用同一份** —— 否则玩家点的格子
 * 和服务端算出来的不是同一个，表现为"点了没反应"或者"挖掉了旁边那块"。
 *
 * 用 Amanatides-Woo 的网格遍历：每一步只往一个轴跨一格，永远不会漏格，
 * 也不会像"沿射线按固定步长采样"那样在斜着看时跳过薄墙。
 */
import { stateId } from '../world/chunk.ts';
import { WORLD_HEIGHT } from '../constants.ts';
import type { BlockView } from '../world/block-view.ts';

/** 命中结果 */
export interface RayHit {
  /** 命中的方块坐标 */
  x: number;
  y: number;
  z: number;
  /** 命中面的法线，指向射线来的那一侧。放置时新方块就落在这个方向上 */
  nx: number;
  ny: number;
  nz: number;
  /** 命中点到起点的距离 */
  distance: number;
  /** 命中的方块状态 */
  state: number;
}

/** 判断某个方块是否算"可命中"。默认：非空气即命中 */
export type HitTest = (state: number, x: number, y: number, z: number) => boolean;

const DEFAULT_HIT: HitTest = (state) => stateId(state) !== 0;

/**
 * 从 (ox,oy,oz) 沿单位方向 (dx,dy,dz) 投射，最远 maxDistance 格。
 *
 * @returns 命中信息；打空返回 null
 */
export function raycastBlocks(
  world: BlockView,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDistance: number,
  hitTest: HitTest = DEFAULT_HIT,
): RayHit | null {
  let x = Math.floor(ox);
  let y = Math.floor(oy);
  let z = Math.floor(oz);

  // 每一轴的前进方向，以及"跨一格需要走多少 t"
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

  // 方向分量为 0 时给 Infinity，让该轴永远不会被选中推进
  const tDeltaX = stepX === 0 ? Infinity : Math.abs(1 / dx);
  const tDeltaY = stepY === 0 ? Infinity : Math.abs(1 / dy);
  const tDeltaZ = stepZ === 0 ? Infinity : Math.abs(1 / dz);

  /** 到下一条格线的 t */
  const boundary = (origin: number, cell: number, step: number): number =>
    step > 0 ? cell + 1 - origin : origin - cell;
  let tMaxX = stepX === 0 ? Infinity : boundary(ox, x, stepX) * tDeltaX;
  let tMaxY = stepY === 0 ? Infinity : boundary(oy, y, stepY) * tDeltaY;
  let tMaxZ = stepZ === 0 ? Infinity : boundary(oz, z, stepZ) * tDeltaZ;

  let nx = 0;
  let ny = 0;
  let nz = 0;
  let t = 0;

  // 起点所在的格子也要检查：贴着方块站时准星可能就在方块内部
  if (y >= 0 && y < WORLD_HEIGHT && world.isLoaded(x, z)) {
    const state = world.getState(x, y, z);
    if (hitTest(state, x, y, z)) {
      return { x, y, z, nx: -stepX, ny: -stepY, nz: -stepZ, distance: 0, state };
    }
  }

  while (t <= maxDistance) {
    // 选最先到达格线的那一轴推进一格
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX; t = tMaxX; tMaxX += tDeltaX;
      nx = -stepX; ny = 0; nz = 0;
    } else if (tMaxY < tMaxZ) {
      y += stepY; t = tMaxY; tMaxY += tDeltaY;
      nx = 0; ny = -stepY; nz = 0;
    } else {
      z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ;
      nx = 0; ny = 0; nz = -stepZ;
    }
    if (t > maxDistance) return null;
    if (y < 0 || y >= WORLD_HEIGHT) return null;
    // 打进未加载的区块就停下：那里的方块我们其实不知道，
    // 猜一个会让客户端和服务端给出不同答案
    if (!world.isLoaded(x, z)) return null;

    const state = world.getState(x, y, z);
    if (hitTest(state, x, y, z)) {
      return { x, y, z, nx, ny, nz, distance: t, state };
    }
  }
  return null;
}
