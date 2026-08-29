/**
 * 世界访问接口。
 *
 * 这是让**一份碰撞、一份射线、一份光照算法同时服务客户端镜像和服务端世界**的接缝。
 * 没有它，两边就会各写一套，然后慢慢漂移 —— 而客户端预测与服务端模拟一旦漂移，
 * 表现出来就是玩家莫名其妙被拉回去，且极难定位。
 *
 * 约定：所有坐标都是**世界坐标**，不是区块局部坐标。实现负责找区块。
 */
import { Chunk, AIR_STATE, chunkKey, toChunkCoord, toLocalCoord, columnIndex } from './chunk.ts';
import { WORLD_HEIGHT, MAX_LIGHT } from '../constants.ts';

/** 只读世界视图 */
export interface BlockView {
  /** 未加载或越界返回 AIR_STATE */
  getState(x: number, y: number, z: number): number;
  getSkyLight(x: number, y: number, z: number): number;
  getBlockLight(x: number, y: number, z: number): number;
  getBiome(x: number, z: number): number;
  /** 该坐标所在区块是否已加载 */
  isLoaded(x: number, z: number): boolean;
  /**
   * 该列最高非空气方块的 y+1。
   *
   * 天光引擎靠它决定"哪些格子直接暴露于天空"：y >= height 的一律满值，
   * 低于它的才需要横向传播。没有这个划分的话，天光的垂直不衰减会破坏
   * BFS 双队列赖以成立的单调性。
   */
  getHeight(x: number, z: number): number;
}

/** 可写世界视图 */
export interface MutableBlockView extends BlockView {
  /**
   * 写方块状态。
   * @returns 是否写成功。区块未加载时返回 false —— 调用方必须处理这种情况，
   *          静默丢弃写操作会导致难以复现的世界不一致。见 docs/RULES.md 第 11 条。
   */
  setState(x: number, y: number, z: number, state: number, flags?: number): boolean;
  setSkyLight(x: number, y: number, z: number, level: number): void;
  setBlockLight(x: number, y: number, z: number, level: number): void;
  /** 标记该坐标所在区块的光照已建立，见 Chunk.lightReady */
  markLightReady(x: number, z: number): void;
}

/** setState 的行为标志，可按位或 */
export const SetFlags = {
  /** 什么都不额外做 */
  NONE: 0,
  /** 通知相邻方块（触发红石、流体、下落方块等） */
  NOTIFY_NEIGHBORS: 1,
  /** 标记需要重新网格化 */
  MARK_RENDER: 2,
  /** 重算光照 */
  UPDATE_LIGHT: 4,
  /** 广播给订阅了该区块的客户端 */
  BROADCAST: 8,
  /** 常规的玩家放置/破坏：以上全做 */
  DEFAULT: 1 | 2 | 4 | 8,
} as const;
export type SetFlags = (typeof SetFlags)[keyof typeof SetFlags];

/**
 * 基于 Map<chunkKey, Chunk> 的世界存储，实现 MutableBlockView。
 *
 * 服务端世界和客户端镜像都用它当底座 —— 区别只在于谁有权调用 setState
 * （客户端永不主动创建或销毁区块，只被 S_ChunkData / S_ChunkUnload 驱动，
 * 见 docs/RULES.md 第 8 条）。
 */
export class ChunkStore implements MutableBlockView {
  private readonly chunks = new Map<number, Chunk>();
  /** 缓存上一次访问的区块，空间局部性极强的场景（mesher、光照 BFS）能省掉大量 Map 查找 */
  private lastKey = Number.NaN;
  private lastChunk: Chunk | null = null;

  get size(): number {
    return this.chunks.size;
  }

  getChunk(cx: number, cz: number): Chunk | null {
    const key = chunkKey(cx, cz);
    if (key === this.lastKey) return this.lastChunk;
    const c = this.chunks.get(key) ?? null;
    this.lastKey = key;
    this.lastChunk = c;
    return c;
  }

  hasChunk(cx: number, cz: number): boolean {
    return this.chunks.has(chunkKey(cx, cz));
  }

  addChunk(chunk: Chunk): void {
    this.chunks.set(chunk.key, chunk);
    this.invalidateCache();
  }

  removeChunk(cx: number, cz: number): boolean {
    const removed = this.chunks.delete(chunkKey(cx, cz));
    this.invalidateCache();
    return removed;
  }

  /** 新建一个空区块并注册 */
  createChunk(cx: number, cz: number): Chunk {
    const c = new Chunk(cx, cz);
    this.addChunk(c);
    return c;
  }

  chunkValues(): IterableIterator<Chunk> {
    return this.chunks.values();
  }

  clear(): void {
    this.chunks.clear();
    this.invalidateCache();
  }

  private invalidateCache(): void {
    this.lastKey = Number.NaN;
    this.lastChunk = null;
  }

  // --- BlockView ---

  getState(x: number, y: number, z: number): number {
    if (y < 0 || y >= WORLD_HEIGHT) return AIR_STATE;
    const c = this.getChunk(toChunkCoord(x), toChunkCoord(z));
    if (c === null) return AIR_STATE;
    return c.getState(toLocalCoord(x), y, toLocalCoord(z));
  }

  getSkyLight(x: number, y: number, z: number): number {
    // 世界之上一律满天光，之下一律无 —— 这让光照 BFS 不必对边界做特判
    if (y >= WORLD_HEIGHT) return MAX_LIGHT;
    if (y < 0) return 0;
    const c = this.getChunk(toChunkCoord(x), toChunkCoord(z));
    if (c === null) return 0;
    return c.getSkyLight(toLocalCoord(x), y, toLocalCoord(z));
  }

  getBlockLight(x: number, y: number, z: number): number {
    if (y < 0 || y >= WORLD_HEIGHT) return 0;
    const c = this.getChunk(toChunkCoord(x), toChunkCoord(z));
    if (c === null) return 0;
    return c.getBlockLight(toLocalCoord(x), y, toLocalCoord(z));
  }

  getBiome(x: number, z: number): number {
    const c = this.getChunk(toChunkCoord(x), toChunkCoord(z));
    if (c === null) return 0;
    return c.biomes[columnIndex(toLocalCoord(x), toLocalCoord(z))]!;
  }

  isLoaded(x: number, z: number): boolean {
    return this.hasChunk(toChunkCoord(x), toChunkCoord(z));
  }

  /** 某一列最高非空气方块的 y+1；区块未加载返回 0 */
  getHeight(x: number, z: number): number {
    const c = this.getChunk(toChunkCoord(x), toChunkCoord(z));
    if (c === null) return 0;
    return c.getHeight(toLocalCoord(x), toLocalCoord(z));
  }

  // --- MutableBlockView ---

  setState(x: number, y: number, z: number, state: number): boolean {
    if (y < 0 || y >= WORLD_HEIGHT) return false;
    const c = this.getChunk(toChunkCoord(x), toChunkCoord(z));
    if (c === null) return false;
    c.setState(toLocalCoord(x), y, toLocalCoord(z), state);
    return true;
  }

  markLightReady(x: number, z: number): void {
    const c = this.getChunk(toChunkCoord(x), toChunkCoord(z));
    if (c !== null) c.lightReady = true;
  }

  setSkyLight(x: number, y: number, z: number, level: number): void {
    if (y < 0 || y >= WORLD_HEIGHT) return;
    const c = this.getChunk(toChunkCoord(x), toChunkCoord(z));
    if (c === null) return;
    const lx = toLocalCoord(x);
    const lz = toLocalCoord(z);
    const sy = y >> 4;
    const section = c.sections[sy];
    if (section == null) {
      // 和隐含值一致就什么都不做 —— 地表之上整片的满天光正是靠这一条
      // 免掉了每列三四个段的分配（见 Chunk.implicitSkyLight）
      if (level === c.implicitSkyLight(lx, y, lz)) return;
      c.createSectionWithSky(sy).setSkyLight(lx, y & 15, lz, level);
      return;
    }
    section.setSkyLight(lx, y & 15, lz, level);
  }

  setBlockLight(x: number, y: number, z: number, level: number): void {
    if (y < 0 || y >= WORLD_HEIGHT) return;
    const c = this.getChunk(toChunkCoord(x), toChunkCoord(z));
    if (c === null) return;
    const sy = y >> 4;
    const section = c.sections[sy];
    if (section == null) {
      if (level === 0) return;
      c.getOrCreateSection(sy).setBlockLight(toLocalCoord(x), y & 15, toLocalCoord(z), level);
      return;
    }
    section.setBlockLight(toLocalCoord(x), y & 15, toLocalCoord(z), level);
  }
}
