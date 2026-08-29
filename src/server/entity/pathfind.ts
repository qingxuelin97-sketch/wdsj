/**
 * 生物寻路：A*，开表用二叉堆。
 *
 * 计划 §3.2 坑 #9 点名的第一条就是前作"A* 开表线性找最小"——
 * 那在开表几百个节点时每次取最小都要扫一遍，而一只生物每隔几十刻就要重算一次路，
 * 一个世界里可以有七十只。堆把取最小从 O(n) 降到 O(log n)。
 *
 * 节点是**方块坐标**，且坐标压成一个整数当键：
 *   key = (x + 2^21) * 2^42 + (y + 2^21) * 2^21 + (z + 2^21)  —— 超出 2^53
 * 所以改用字符串会很慢。这里用的是"以起点为原点的相对坐标 + 固定半径"，
 * 于是键落在一个小范围里，可以直接用扁平数组索引，连 Map 都不需要。
 *
 * 与 MC 的偏差（记在 docs/DEVIATIONS.md）：不做水路与门的特殊节点代价，
 * 也不做"沿路径平滑"。生物会贴着方块边走而不是抄近道，肉眼几乎看不出来。
 */
import type { BlockView } from '../../core/world/block-view.ts';
import type { CollisionTables } from '../../core/physics/block-collision.ts';
import { stateId } from '../../core/world/chunk.ts';
import { WORLD_HEIGHT } from '../../core/constants.ts';

/** 搜索半径（格）。超过这个距离就不找了 —— 生物的追踪距离本来也就 16-40 格 */
export const PATH_RADIUS = 24;
/** 边长，用于扁平索引 */
const SIDE = PATH_RADIUS * 2 + 1;
const PLANE = SIDE * SIDE;
const VOLUME = PLANE * SIDE;
/** 一次搜索最多展开多少节点。够走 24 格，也挡住了病态地形下的爆炸增长 */
const MAX_EXPANSIONS = 2000;
/** 能跳上去的最大高度 */
const MAX_STEP_UP = 1;
/** 能安全落下的最大高度。再高就摔伤了，生物不该主动跳 */
const MAX_DROP = 3;

export interface PathNode {
  x: number;
  y: number;
  z: number;
}

/** 八个水平方向。对角线要额外检查两侧，不能贴着墙角穿过去 */
const DIRECTIONS: readonly (readonly [number, number])[] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/**
 * 寻路器。
 *
 * 状态数组是**复用**的：一只生物每隔几十刻算一次路，一个世界里有几十只，
 * 每次都新建三个 15625 长的数组就是每秒几百万次分配。用一个"访问代数"
 * 而不是每次清零 —— 清 VOLUME 个 float 比搜索本身还贵。
 */
export class PathFinder {
  private readonly gScore = new Float32Array(VOLUME);
  private readonly fScore = new Float32Array(VOLUME);
  private readonly cameFrom = new Int32Array(VOLUME);
  private readonly visitGen = new Int32Array(VOLUME);
  private readonly closed = new Uint8Array(VOLUME);
  /** 堆里存的是扁平索引 */
  private readonly heap: number[] = [];
  private generation = 0;
  /** 本次搜索的原点（世界坐标） */
  private ox = 0;
  private oy = 0;
  private oz = 0;

  /** 上一次搜索展开了多少节点，性能排查用 */
  lastExpansions = 0;

  private index(x: number, y: number, z: number): number {
    const dx = x - this.ox + PATH_RADIUS;
    const dy = y - this.oy + PATH_RADIUS;
    const dz = z - this.oz + PATH_RADIUS;
    if (dx < 0 || dx >= SIDE || dy < 0 || dy >= SIDE || dz < 0 || dz >= SIDE) return -1;
    return dy * PLANE + dz * SIDE + dx;
  }

  private worldOf(index: number): PathNode {
    const dy = Math.floor(index / PLANE);
    const rest = index - dy * PLANE;
    const dz = Math.floor(rest / SIDE);
    const dx = rest - dz * SIDE;
    return {
      x: dx - PATH_RADIUS + this.ox,
      y: dy - PATH_RADIUS + this.oy,
      z: dz - PATH_RADIUS + this.oz,
    };
  }

  /**
   * 找一条从 (sx,sy,sz) 到 (tx,ty,tz) 的路。
   *
   * @param width 生物宽度，决定要检查几列
   * @param height 生物高度，决定头顶要空几格
   * @returns 路径点（不含起点），找不到返回空数组
   */
  find(
    world: BlockView, tables: CollisionTables,
    sx: number, sy: number, sz: number,
    tx: number, ty: number, tz: number,
    width: number, height: number,
  ): PathNode[] {
    this.generation++;
    this.ox = sx;
    this.oy = sy;
    this.oz = sz;
    this.heap.length = 0;
    this.lastExpansions = 0;

    const start = this.index(sx, sy, sz);
    const goal = this.index(tx, ty, tz);
    if (start < 0 || goal < 0) return [];

    // 目标本身站不住时，退而求其次：走到它旁边就算到了
    const goalReachable = this.standable(world, tables, tx, ty, tz, width, height);

    this.gScore[start] = 0;
    this.fScore[start] = heuristic(sx, sy, sz, tx, ty, tz);
    this.cameFrom[start] = -1;
    this.visitGen[start] = this.generation;
    this.closed[start] = 0;
    this.push(start);

    let best = start;
    let bestH = this.fScore[start]!;

    while (this.heap.length > 0 && this.lastExpansions < MAX_EXPANSIONS) {
      const current = this.pop();
      if (this.closed[current] === 1) continue;
      this.closed[current] = 1;
      this.lastExpansions++;

      const node = this.worldOf(current);
      const h = heuristic(node.x, node.y, node.z, tx, ty, tz);
      if (h < bestH) {
        bestH = h;
        best = current;
      }
      // 到了：目标可站就要求精确到达，否则挨着就行
      if (current === goal || (!goalReachable && h <= 1.5)) return this.reconstruct(current);

      this.expand(world, tables, current, node, tx, ty, tz, width, height);
    }

    // 没走到但离得更近了：把这条半程的路交出去。
    // 返回空数组的话，生物会在原地发呆直到下一次重算 —— 而"卡住不动"
    // 比"走错方向"看起来更像坏了
    return best === start ? [] : this.reconstruct(best);
  }

  private expand(
    world: BlockView, tables: CollisionTables,
    currentIndex: number, node: PathNode,
    tx: number, ty: number, tz: number,
    width: number, height: number,
  ): void {
    const g = this.gScore[currentIndex]!;
    for (const [dx, dz] of DIRECTIONS) {
      const diagonal = dx !== 0 && dz !== 0;
      // 对角线要求两个正交方向都通，否则生物会从墙角的缝里穿过去
      if (diagonal) {
        if (!this.passableColumn(world, tables, node.x + dx, node.y, node.z, width, height)
          && !this.passableColumn(world, tables, node.x, node.y, node.z + dz, width, height)) continue;
      }

      // 找落脚点：先看平地，再看上一格（跳），再看往下最多 3 格（落）
      let landing = -1;
      for (let dy = MAX_STEP_UP; dy >= -MAX_DROP; dy--) {
        const ny = node.y + dy;
        if (ny < 1 || ny >= WORLD_HEIGHT) continue;
        if (!this.standable(world, tables, node.x + dx, ny, node.z + dz, width, height)) continue;
        // 往上跳时头顶要留出空间
        if (dy > 0 && !this.passableColumn(world, tables, node.x, node.y + dy, node.z, width, height)) continue;
        landing = ny;
        break;
      }
      if (landing < 0) continue;

      const next = this.index(node.x + dx, landing, node.z + dz);
      if (next < 0) continue;
      if (this.visitGen[next] === this.generation && this.closed[next] === 1) continue;

      // 代价：对角线 √2，上下各加一点，让生物优先走平路
      const step = (diagonal ? 1.4142135 : 1) + Math.abs(landing - node.y) * 0.5;
      const tentative = g + step;
      if (this.visitGen[next] === this.generation && tentative >= this.gScore[next]!) continue;

      this.visitGen[next] = this.generation;
      this.closed[next] = 0;
      this.gScore[next] = tentative;
      this.fScore[next] = tentative + heuristic(node.x + dx, landing, node.z + dz, tx, ty, tz);
      this.cameFrom[next] = currentIndex;
      this.push(next);
    }
  }

  /** 这一格能不能站住：脚下实心、身体所占的格子都是空的 */
  private standable(
    world: BlockView, tables: CollisionTables,
    x: number, y: number, z: number, width: number, height: number,
  ): boolean {
    if (y < 1) return false;
    if (!this.solidColumn(world, tables, x, y - 1, z, width)) return false;
    return this.passableColumn(world, tables, x, y, z, width, height);
  }

  /** 身体占的那几格都能穿过吗 */
  private passableColumn(
    world: BlockView, tables: CollisionTables,
    x: number, y: number, z: number, width: number, height: number,
  ): boolean {
    const r = Math.max(0, Math.ceil(width / 2 - 0.5));
    const top = Math.ceil(height);
    for (let ox = -r; ox <= r; ox++) {
      for (let oz = -r; oz <= r; oz++) {
        for (let oy = 0; oy < top; oy++) {
          if (y + oy >= WORLD_HEIGHT) return false;
          if (this.isSolid(world, tables, x + ox, y + oy, z + oz)) return false;
        }
      }
    }
    return true;
  }

  /** 脚下那一层至少中心是实心的 */
  private solidColumn(
    world: BlockView, tables: CollisionTables,
    x: number, y: number, z: number, width: number,
  ): boolean {
    void width;
    return this.isSolid(world, tables, x, y, z);
  }

  private isSolid(world: BlockView, tables: CollisionTables, x: number, y: number, z: number): boolean {
    const id = stateId(world.getState(x, y, z));
    if (id === 0) return false;
    return (tables.solid[id] ?? 0) !== 0;
  }

  private reconstruct(endIndex: number): PathNode[] {
    const out: PathNode[] = [];
    let i = endIndex;
    // 上限保护：cameFrom 理论上不会成环，但真成了环就会在这里死循环，
    // 而那表现为整个服务端卡死 —— 宁可返回一条断路
    for (let guard = 0; guard < VOLUME && i >= 0; guard++) {
      out.push(this.worldOf(i));
      i = this.cameFrom[i]!;
    }
    out.pop(); // 去掉起点
    out.reverse();
    return out;
  }

  // --- 二叉堆，按 fScore 排 ---

  private push(index: number): void {
    const h = this.heap;
    h.push(index);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.fScore[h[i]!]! >= this.fScore[h[parent]!]!) break;
      [h[i], h[parent]] = [h[parent]!, h[i]!];
      i = parent;
    }
  }

  private pop(): number {
    const h = this.heap;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let best = i;
        if (l < h.length && this.fScore[h[l]!]! < this.fScore[h[best]!]!) best = l;
        if (r < h.length && this.fScore[h[r]!]! < this.fScore[h[best]!]!) best = r;
        if (best === i) break;
        [h[i], h[best]] = [h[best]!, h[i]!];
        i = best;
      }
    }
    return top;
  }
}

/** 八方向网格上的对角距离。比欧氏距离更贴合实际能走的步数 */
function heuristic(x: number, y: number, z: number, tx: number, ty: number, tz: number): number {
  const dx = Math.abs(x - tx);
  const dy = Math.abs(y - ty);
  const dz = Math.abs(z - tz);
  const min = Math.min(dx, dz);
  return (dx + dz) - min * (2 - 1.4142135) + dy * 0.5;
}
