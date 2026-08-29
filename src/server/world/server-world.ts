/**
 * 服务端世界：区块的生成、加载、卸载与变更广播。
 *
 * 这是世界状态的**唯一**权威。客户端只有镜像，且永不主动创建或销毁区块 ——
 * 见 docs/RULES.md 第 8 条。
 */
import { ChunkStore } from '../../core/world/block-view.ts';
import { Chunk, chunkKey, keyToCx, keyToCz, packState, AIR_STATE, stateId } from '../../core/world/chunk.ts';
import { OverworldGenerator } from './gen/overworld-gen.ts';
import { LightEngine, LightChannel } from '../../core/light/light-engine.ts';
import type { ChunkProvider } from './chunk-provider.ts';
import type { BlockRegistry } from '../../core/registry/block-registry.ts';
import type { BlockTables } from '../../core/registry/block-tables.ts';
import { WORLD_HEIGHT, DAY_LENGTH_TICKS, CHUNK_SIZE, SECTIONS_PER_COLUMN } from '../../core/constants.ts';

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
  /**
   * 昼夜是否推进（对应 MC 的 doDaylightCycle 游戏规则）。
   * 截图回归必须能把时间钉死 —— 否则"设成正午"之后世界还在往前走，
   * 截到第几 tick 取决于机器快慢，哈希每次都不一样。
   */
  daylightCycle = true;

  /** 本 tick 内累积的方块变更，tick 末尾统一广播后清空 */
  private readonly pendingChanges: BlockChange[] = [];
  /**
   * 刚生成、还没播过光照的区块。
   *
   * 只有**新加载**的区块要走这条全量播种路径；方块变更走增量，
   * 在 setBlock 里当场算完，不进这个集合。
   */
  private readonly lightPending = new Set<number>();
  readonly light: LightEngine;
  /**
   * 异步区块来源。挂上之后 ensureChunk 不再当场生成，而是下单等收货。
   * 为空时（测试、node 服务器）走同线程生成。
   */
  private provider: ChunkProvider | null = null;

  /**
   * 本 tick 还能生成几个新区块。
   *
   * 用**区块数**而不是耗时做配额，是为了保住确定性：以耗时为准的话，
   * "跑 N 个 tick"的结果会随机器快慢变化，测试就没法逐格比对了。
   *
   * 生成一个区块约 22 ms，而一个 tick 只有 50 ms。不设配额的话，
   * prepareChunks 一次要 3 个区块 × 3×3 邻域 = 最多 27 个新区块，
   * 单个 tick 就要花掉近 600 ms —— 实测服务端 8 秒只推进了 20 tick。
   */
  private generationBudget = 0;
  /**
   * 每 tick 允许生成的新区块数。0 表示不限（测试里用）。
   *
   * 生成一个区块约 11.6 ms，一个 tick 是 50 ms。
   *
   * 配额不改变总工作量，只决定它怎么摊：配额大则单个 tick 久、tick 数少，
   * 配额小则反之，总耗时一样。所以选它的依据是**尖峰**而不是吞吐 ——
   * 实测配额 12 时跨区块边界的 p90 达到 117 ms、最大 283 ms，
   * 服务端会有肉眼可见的停摆；降到 6 之后尖峰减半。
   *
   * 稳态移动时每 tick 通常只需生成 1-3 个（邻域大多已存在），配额根本用不满 ——
   * 实测稳态平均 27 ms/tick，等效 36.9 TPS，超过 20 的目标。
   */
  generationQuota = 6;

  constructor(seed: bigint, registry: BlockRegistry) {
    this.seed = seed;
    this.tables = registry.getTables();
    this.generator = new OverworldGenerator(seed, registry);
    // 服务端按区块快照下发光照，不需要 touched 追踪
    this.light = new LightEngine(this.store, this.tables, false);
  }

  /** 换一个区块来源。传 null 恢复同线程生成 */
  setProvider(provider: ChunkProvider | null): void {
    this.provider = provider;
  }

  /**
   * 收下异步来源已经生成好的区块。每 tick 开头调一次。
   * @returns 收了几个
   */
  intakeGenerated(): number {
    if (this.provider === null) return 0;
    const arrived = this.provider.drain();
    for (const chunk of arrived) {
      // 期间可能已经由 forceChunk 同步生成过了；重复收货直接丢弃，
      // 否则会把一个已经算好光照的区块换成一个没算过的
      if (this.store.hasChunk(chunk.cx, chunk.cz)) continue;
      this.store.addChunk(chunk);
      this.lightPending.add(chunkKey(chunk.cx, chunk.cz));
    }
    return arrived.length;
  }

  /**
   * 确保某个区块已加载。
   *
   * 有异步来源时**不会当场生成**：下个单就返回 null，货到了下个 tick 再说。
   * 调用方（prepareChunks）本来就要处理"还没好"这种情况。
   */
  ensureChunk(cx: number, cz: number): Chunk | null {
    const existing = this.store.getChunk(cx, cz);
    if (existing !== null) return existing;
    if (this.provider !== null) {
      this.provider.request(cx, cz);
      return null;
    }
    if (this.generationQuota > 0 && this.generationBudget <= 0) return null;
    this.generationBudget--;
    const chunk = this.generator.generate(cx, cz);
    this.store.addChunk(chunk);
    this.lightPending.add(chunkKey(cx, cz));
    return chunk;
  }

  /** 无视配额强制生成，用于出生点这类必须立刻就绪的场合 */
  forceChunk(cx: number, cz: number): Chunk {
    const existing = this.store.getChunk(cx, cz);
    if (existing !== null) return existing;
    const chunk = this.generator.generate(cx, cz);
    this.store.addChunk(chunk);
    this.lightPending.add(chunkKey(cx, cz));
    return chunk;
  }

  /** 每 tick 开头重置配额 */
  resetGenerationBudget(): void {
    this.generationBudget = this.generationQuota;
  }

  isLoaded(cx: number, cz: number): boolean {
    return this.store.hasChunk(cx, cz);
  }

  unloadChunk(cx: number, cz: number): void {
    this.store.removeChunk(cx, cz);
    this.lightPending.delete(chunkKey(cx, cz));
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

    // 光照就地增量更新。
    //
    // 这里**必须**用变更前的 id 去查表：方块已经写进世界了，
    // 再查一次拿到的是新值，移除传播就会以为"本来就没光"而什么都不做。
    const oldId = stateId(before);
    const oldEmission = oldId === 0 ? 0 : (this.tables.lightEmission[oldId] ?? 0);
    const oldOpacity = oldId === 0 ? 0 : (this.tables.opacity[oldId] ?? 15);
    const newId = stateId(state);
    const newEmission = newId === 0 ? 0 : (this.tables.lightEmission[newId] ?? 0);
    this.light.onBlockChanged(x, y, z, oldEmission, newEmission, oldOpacity);
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
   * 给新加载的区块播种光照。
   *
   * 方块变更不走这里 —— 它在 setBlock 里已经增量算完了。这里只处理
   * "一个此前不存在的区块出现了"，那确实需要把它的天光柱和发光方块从头播一遍。
   *
   * 播种只会让世界**变亮**（新区块的光向外渗），所以不需要移除传播；
   * 而邻居原本按"这一侧不存在"算出的光会被新来的光覆盖掉，自动收敛。
   */
  updateLighting(): void {
    if (this.lightPending.size === 0) return;
    for (const key of this.lightPending) {
      const cx = keyToCx(key);
      const cz = keyToCz(key);
      if (!this.store.hasChunk(cx, cz)) continue;
      const chunk = this.store.getChunk(cx, cz)!;
      const x0 = cx * CHUNK_SIZE;
      const z0 = cz * CHUNK_SIZE;
      // 最高的已分配子区块之上什么都没存，天光按隐含值读就是对的，
      // 不必逐格写一遍 —— 128 层里通常有一半是空的
      let topSection = -1;
      for (let sy = SECTIONS_PER_COLUMN - 1; sy >= 0; sy--) {
        if (chunk.sections[sy] != null) { topSection = sy; break; }
      }
      const topY = (topSection + 1) * CHUNK_SIZE;
      this.light.seedSky(x0, z0, x0 + CHUNK_SIZE - 1, z0 + CHUNK_SIZE - 1, topY, true);
      this.light.seedBlockLight(
        x0, 0, z0, x0 + CHUNK_SIZE - 1, Math.max(0, topY - 1), z0 + CHUNK_SIZE - 1, true,
      );
    }
    this.lightPending.clear();

    // 全部播完再统一扩散一次。一个 tick 里到货的新区块常常是连成一片的，
    // 逐块扩散会让相邻区块反复互相灌光 —— 同一批格子走好几遍 BFS。
    this.light.propagate(LightChannel.SKY);
    this.light.propagate(LightChannel.BLOCK);
  }

  /** 还有多少区块在等待播种光照 */
  get lightPendingCount(): number {
    return this.lightPending.size;
  }

  /** 推进世界时间 */
  advanceTime(): void {
    this.worldAge++;
    if (this.daylightCycle) this.timeOfDay = (this.timeOfDay + 1) % DAY_LENGTH_TICKS;
  }

  /** 找一个可站立的地面高度，用于放置玩家 */
  groundHeightAt(x: number, z: number): number {
    const cx = x >> 4;
    const cz = z >> 4;
    this.forceChunk(cx, cz);
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
