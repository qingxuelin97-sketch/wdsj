/**
 * 实体与方块的碰撞求解。
 *
 * 逐轴分离求解，顺序是 **Y → X → Z**，和 MC 的 `Entity.moveEntity` 一致。
 * 顺序不是随便定的：先解 Y 才能在解 X/Z 之前知道自己是不是站在地上，
 * 而"站在地上"决定了能不能自动上台阶。换成 X→Y→Z 的话，
 * 走到半砖前会先被水平挡住，再也上不去。
 */
import { WORLD_HEIGHT } from '../constants.ts';
import { stateId } from '../world/chunk.ts';
import type { BlockView } from '../world/block-view.ts';

/** 碰撞求解需要的方块属性 */
export interface CollisionTables {
  /** 是否有碰撞体积 */
  readonly solid: Uint8Array;
  /**
   * 碰撞盒高度，1 表示整格。
   *
   * 半砖 0.5、雪层 0.125 之类的靠它，而"能不能不跳就走上去"完全由它
   * 与 STEP_HEIGHT(0.6) 的关系决定：半砖走得上去、整格必须跳。
   * M7 的方块模型系统会把这张表接到真正的模型上；现在除了测试用的
   * 合成方块之外一律是 1。
   */
  readonly collisionHeight: Float32Array;
}

/** 一个轴对齐盒，用可变字段而不是 Aabb 对象，避免每 tick 大量短命分配 */
export interface Box {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

export function makeBox(): Box {
  return { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
}

/** 按实体中心与尺寸填一个盒 */
export function setBodyBox(out: Box, x: number, y: number, z: number, width: number, height: number): Box {
  const h = width / 2;
  out.minX = x - h; out.maxX = x + h;
  out.minY = y;     out.maxY = y + height;
  out.minZ = z - h; out.maxZ = z + h;
  return out;
}

function boxOverlapsXZ(a: Box, b: Box): boolean {
  return a.maxX > b.minX && a.minX < b.maxX && a.maxZ > b.minZ && a.minZ < b.maxZ;
}
function boxOverlapsXY(a: Box, b: Box): boolean {
  return a.maxX > b.minX && a.minX < b.maxX && a.maxY > b.minY && a.minY < b.maxY;
}
function boxOverlapsYZ(a: Box, b: Box): boolean {
  return a.maxY > b.minY && a.minY < b.maxY && a.maxZ > b.minZ && a.minZ < b.maxZ;
}

/**
 * 沿 Y 轴推进 dy，返回被方块挡住之后实际能走的距离。
 * 只考虑与移动盒在 XZ 上有重叠的方块。
 */
function clipY(block: Box, body: Box, dy: number): number {
  if (!boxOverlapsXZ(block, body)) return dy;
  if (dy > 0 && body.maxY <= block.minY) {
    const gap = block.minY - body.maxY;
    if (gap < dy) return gap;
  } else if (dy < 0 && body.minY >= block.maxY) {
    const gap = block.maxY - body.minY;
    if (gap > dy) return gap;
  }
  return dy;
}

function clipX(block: Box, body: Box, dx: number): number {
  if (!boxOverlapsYZ(block, body)) return dx;
  if (dx > 0 && body.maxX <= block.minX) {
    const gap = block.minX - body.maxX;
    if (gap < dx) return gap;
  } else if (dx < 0 && body.minX >= block.maxX) {
    const gap = block.maxX - body.minX;
    if (gap > dx) return gap;
  }
  return dx;
}

function clipZ(block: Box, body: Box, dz: number): number {
  if (!boxOverlapsXY(block, body)) return dz;
  if (dz > 0 && body.maxZ <= block.minZ) {
    const gap = block.minZ - body.maxZ;
    if (gap < dz) return gap;
  } else if (dz < 0 && body.minZ >= block.maxZ) {
    const gap = block.maxZ - body.minZ;
    if (gap > dz) return gap;
  }
  return dz;
}

/** 移动结果 */
export interface MoveResult {
  dx: number; dy: number; dz: number;
  /** 各轴是否被挡住（用于把速度清零、判定落地） */
  hitX: boolean; hitY: boolean; hitZ: boolean;
}

const scratchBlock = makeBox();

/**
 * 把一个盒沿 (dx,dy,dz) 推进，遇到实心方块就截断。
 *
 * 未加载的区块**当作实心**处理。让玩家掉进还没到货的地形里，
 * 会一路穿到基岩之下再被弹回来，观感上就是随机的传送。
 */
export function collideMove(
  world: BlockView,
  tables: CollisionTables,
  body: Box,
  dx: number,
  dy: number,
  dz: number,
): MoveResult {
  // 扫掠范围：起点盒与终点盒的并集，向外扩一格保证不漏掉边界上的方块
  const minX = Math.floor(Math.min(body.minX, body.minX + dx) - 1);
  const maxX = Math.floor(Math.max(body.maxX, body.maxX + dx) + 1);
  const minY = Math.floor(Math.min(body.minY, body.minY + dy) - 1);
  const maxY = Math.floor(Math.max(body.maxY, body.maxY + dy) + 1);
  const minZ = Math.floor(Math.min(body.minZ, body.minZ + dz) - 1);
  const maxZ = Math.floor(Math.max(body.maxZ, body.maxZ + dz) + 1);

  const solids: Box[] = [];
  for (let y = minY; y <= maxY; y++) {
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        if (y < 0 || y >= WORLD_HEIGHT) {
          // 世界上下边界之外：底部当实心（防止掉出世界），顶部放行
          if (y >= WORLD_HEIGHT) continue;
        }
        let blocking: boolean;
        if (!world.isLoaded(x, z)) {
          blocking = true;
        } else if (y < 0) {
          blocking = true;
        } else {
          const id = stateId(world.getState(x, y, z));
          blocking = id !== 0 && tables.solid[id] === 1;
        }
        if (!blocking) continue;
        let top = y + 1;
        if (y >= 0 && world.isLoaded(x, z)) {
          const id = stateId(world.getState(x, y, z));
          if (id !== 0) top = y + (tables.collisionHeight[id] ?? 1);
        }
        solids.push({ minX: x, minY: y, minZ: z, maxX: x + 1, maxY: top, maxZ: z + 1 });
      }
    }
  }

  const wantY = dy;
  for (const b of solids) dy = clipY(b, body, dy);
  body.minY += dy; body.maxY += dy;

  const wantX = dx;
  for (const b of solids) dx = clipX(b, body, dx);
  body.minX += dx; body.maxX += dx;

  const wantZ = dz;
  for (const b of solids) dz = clipZ(b, body, dz);
  body.minZ += dz; body.maxZ += dz;

  void scratchBlock;
  return {
    dx, dy, dz,
    hitX: dx !== wantX,
    hitY: dy !== wantY,
    hitZ: dz !== wantZ,
  };
}

/** 该盒当前是否与任何实心方块相交（用于卡墙检测与上台阶的可行性判断） */
export function boxIntersectsSolid(world: BlockView, tables: CollisionTables, body: Box): boolean {
  const minX = Math.floor(body.minX);
  const maxX = Math.floor(body.maxX - 1e-7);
  const minY = Math.floor(body.minY);
  const maxY = Math.floor(body.maxY - 1e-7);
  const minZ = Math.floor(body.minZ);
  const maxZ = Math.floor(body.maxZ - 1e-7);
  for (let y = minY; y <= maxY; y++) {
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        if (y >= WORLD_HEIGHT) continue;
        if (y < 0 || !world.isLoaded(x, z)) return true;
        const id = stateId(world.getState(x, y, z));
        if (id !== 0 && tables.solid[id] === 1) return true;
      }
    }
  }
  return false;
}
