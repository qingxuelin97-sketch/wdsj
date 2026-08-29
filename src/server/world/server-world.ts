/**
 * 服务端世界：区块的生成、加载、卸载与变更广播。
 *
 * 这是世界状态的**唯一**权威。客户端只有镜像，且永不主动创建或销毁区块 ——
 * 见 docs/RULES.md 第 8 条。
 */
import { ChunkStore } from '../../core/world/block-view.ts';
import { Chunk, chunkKey, keyToCx, keyToCz, packState, AIR_STATE, stateId } from '../../core/world/chunk.ts';
import { OverworldGenerator } from './gen/overworld-gen.ts';
import { computeSkyLight } from './sky-light.ts';
import type { BlockRegistry } from '../../core/registry/block-registry.ts';
import type { BlockTables } from '../../core/registry/block-tables.ts';
import { WORLD_HEIGHT, DAY_LENGTH_TICKS } from '../../core/constants.ts';

/** 一次方块变更，供广播使用 */
export interface BlockChange {
  x: number;
  y: number;
  z: number;
  state: number;
}

export class ServerWorld {
  readonly store = new ChunkStore();
  readonly generator: OverworldGenerator;
  readonly tables: BlockTables;
  readonly seed: bigint;

  /** 世界年龄，单调递增 */
  worldAge = 0;
  /** 一天内的时间，0..23999 */
  timeOfDay = 0;

  /** 本 tick 内累积的方块变更，tick 末尾统一广播后清空 */
  private readonly pendingChanges: BlockChange[] = [];
  /** 天光需要重算的区块。M4 会换成局部增量，现在是整块重算 */
  private readonly lightDirty = new Set<number>();

  constructor(seed: bigint, registry: BlockRegistry) {
    this.seed = seed;
    this.tables = registry.getTables();
    this.generator = new OverworldGenerator(seed, registry);
  }

  /** 确保某个区块已加载，必要时生成它 */
  ensureChunk(cx: number, cz: number): Chunk {
    const existing = this.store.getChunk(cx, cz);
    if (existing !== null) return existing;
    const chunk = this.generator.generate(cx, cz);
    this.store.addChunk(chunk);
    this.lightDirty.add(chunkKey(cx, cz));
    return chunk;
  }

  isLoaded(cx: number, cz: number): boolean {
    return this.store.hasChunk(cx, cz);
  }

  unloadChunk(cx: number, cz: number): void {
    this.store.removeChunk(cx, cz);
    this.lightDirty.delete(chunkKey(cx, cz));
  }

  get loadedCount(): number {
    return this.store.size;
  }

  /**
   * 变更一个方块。这是世界的**唯一**写入口。
   * @returns 是否成功（区块未加载时失败）
   */
  setBlock(x: number, y: number, z: number, state: number): boolean {
    if (y < 0 || y >= WORLD_HEIGHT) return false;
    const cx = x >> 4;
    const cz = z >> 4;
    if (!this.store.hasChunk(cx, cz)) return false;
    const before = this.store.getState(x, y, z);
    if (before === state) return true;
    if (!this.store.setState(x, y, z, state)) return false;

    this.pendingChanges.push({ x, y, z, state });
    // 改动会影响光照 —— 标记本区块与相邻区块（光会横向渗过边界）
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (this.store.hasChunk(cx + dx, cz + dz)) this.lightDirty.add(chunkKey(cx + dx, cz + dz));
      }
    }
    return true;
  }

  getBlock(x: number, y: number, z: number): number {
    return this.store.getState(x, y, z);
  }

  /** 取出并清空本 tick 的方块变更 */
  drainChanges(): BlockChange[] {
    if (this.pendingChanges.length === 0) return [];
    return this.pendingChanges.splice(0, this.pendingChanges.length);
  }

  /**
   * 重算脏区块的天光。
   *
   * 只处理被标记为脏的区块，绝不全量重算 —— 全量的代价是"已加载区块数 × 32768 格"，
   * 渲染距离 6 时每 tick 就是 370 万格，主线程会被直接卡死。
   *
   * M4 会把它换成以变更点为中心、半径 15 格的局部增量，届时连"整块重算"都不必。
   */
  updateLighting(): void {
    if (this.lightDirty.size === 0) return;
    const chunks: Chunk[] = [];
    for (const key of this.lightDirty) {
      const chunk = this.store.getChunk(keyToCx(key), keyToCz(key));
      if (chunk !== null) chunks.push(chunk);
    }
    this.lightDirty.clear();
    if (chunks.length === 0) return;
    computeSkyLight(this.store, this.tables.opacity, chunks);
  }

  /** 推进世界时间 */
  advanceTime(): void {
    this.worldAge++;
    this.timeOfDay = (this.timeOfDay + 1) % DAY_LENGTH_TICKS;
  }

  /** 找一个可站立的地面高度，用于放置玩家 */
  groundHeightAt(x: number, z: number): number {
    const cx = x >> 4;
    const cz = z >> 4;
    this.ensureChunk(cx, cz);
    for (let y = WORLD_HEIGHT - 2; y > 0; y--) {
      const here = this.store.getState(x, y, z);
      const above = this.store.getState(x, y + 1, z);
      if (here !== AIR_STATE && above === AIR_STATE) return y + 1;
    }
    return WORLD_HEIGHT / 2;
  }

  /** 该方块能否被玩家挖掉（基岩不行） */
  isBreakable(state: number): boolean {
    const id = stateId(state);
    if (id === 0) return false;
    return this.tables.hardness[id]! >= 0;
  }

  /** 方块名 -> 状态，供指令与测试使用 */
  stateOf(registry: BlockRegistry, name: string, meta = 0): number {
    return packState(registry.idOf(name), meta);
  }
}
