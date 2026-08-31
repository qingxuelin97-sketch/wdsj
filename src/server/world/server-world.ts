/**
 * 服务端世界：区块的生成、加载、卸载与变更广播。
 *
 * 这是世界状态的**唯一**权威。客户端只有镜像，且永不主动创建或销毁区块 ——
 * 见 docs/RULES.md 第 8 条。
 */
import { ChunkStore } from '../../core/world/block-view.ts';
import { Chunk, chunkKey, keyToCx, keyToCz, packState, AIR_STATE, stateId } from '../../core/world/chunk.ts';
import { OverworldGenerator } from './gen/overworld-gen.ts';
import type { WorldGenerator } from './gen/generator.ts';
import {
  Dimension, dimensionOf, type DimensionId, type DimensionDef,
} from '../../core/world/dimension.ts';
import { LightEngine, LightChannel } from '../../core/light/light-engine.ts';
import type { ChunkProvider } from './chunk-provider.ts';
import type { BlockRegistry } from '../../core/registry/block-registry.ts';
import type { BlockTables } from '../../core/registry/block-tables.ts';
import { WORLD_HEIGHT, DAY_LENGTH_TICKS, CHUNK_SIZE, SECTIONS_PER_COLUMN } from '../../core/constants.ts';
import { JavaRandom } from '../../core/rng/java-random.ts';
import { Weather } from '../../core/world/weather.ts';
import { BlockEntityStore } from './block-entity-store.ts';
import { blockEntityKindFor, createBlockEntity, type BlockEntity } from './block-entity.ts';
import { ScheduledTickQueue } from './scheduled-ticks.ts';
import type { ItemEntity } from '../entity/item-entity.ts';
import type { Mob } from '../entity/mob.ts';
import type { ArrowEntity } from '../entity/arrow.ts';
import type { WorldSave } from '../save/world-save.ts';
import { installChunkFromSave, saveChunkToSave } from './world-persistence.ts';
import { onBlockChanged } from './block-ticks.ts';

/** 一次方块变更，供广播使用 */
export interface BlockChange {
  x: number;
  y: number;
  z: number;
  state: number;
}

export class ServerWorld {
  readonly store = new ChunkStore();
  readonly generator: WorldGenerator;
  /** 这是哪个维度。存档目录、传送门换算、有没有天光都看它 */
  readonly dimension: DimensionId;
  /** 维度的固有属性（天光/天花板/坐标比例），见 core/world/dimension.ts */
  readonly dim: DimensionDef;
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
   * 世界的确定性随机源。
   *
   * 掉落物的散开方向、随机刻、怪物生成都走它，**不许有第二个** ——
   * 一旦有代码偷偷用了 Math.random，同一个种子同一串操作就不再复现，
   * 而整套截图回归都建立在"能复现"上。
   */
  readonly random: JavaRandom;
  /** 箱子 / 熔炉 / 告示牌的额外状态 */
  readonly blockEntities = new BlockEntityStore();
  /** 计划刻队列（流体、红石、沙子下落都靠它） */
  readonly scheduled = new ScheduledTickQueue();

  /**
   * 天气。状态机是纯的（core/world/weather.ts），世界后果在
   * world/weather-tick.ts —— 这里只是那份状态住的地方。
   *
   * 放在 world 而不是 core 上：天气要跟着世界一起存读，而且下界与末地
   * 各自有自己的（那两个维度永远不下雨）。
   */
  readonly weather = new Weather();
  /** 世界里的掉落物，按实体 id 索引 */
  readonly items = new Map<number, ItemEntity>();
  /**
   * 存档。为 null 时世界纯在内存里跑（多数单元测试就是这样）。
   *
   * 挂上之后 ensureChunk 会**先查存档再生成** —— 顺序不能反：
   * 反了的话玩家盖的房子会被新生成的地形覆盖掉，而且只在区块被卸载过
   * 又走回去的时候发生，极难复现。
   */
  save: WorldSave | null = null;
  /**
   * 有多少次"存档还没打开就强行生成了区块"。
   *
   * 正常情况下**必须是 0**。不是 0 就意味着有区块的存档内容被新生成的地形
   * 顶掉了，而那种丢失没有任何直接症状 —— 玩家只会发现房子不见了。
   * 测试对它有断言。
   */
  forcedOverPendingSave = 0;
  /**
   * 分配实体 id。ServerCore 会把自己的分配器注进来，保证掉落物与玩家不撞号；
   * 单独用 ServerWorld 的测试则走这个自带的计数器。
   */
  allocEntityId: () => number = (() => {
    let n = 1;
    return () => n++;
  })();

  /**
   * 生物与箭的存档钩子。
   *
   * 它们归 ServerCore 的 MobManager 管，而 ServerWorld 不认识 MobManager ——
   * 反过来引用会让"世界"依赖"实体管理器"，而实体管理器本来就要依赖世界。
   * 所以这里留三个函数，由 ServerCore 在构造时接上；不接的话（纯世界测试）
   * 存档里就是没有实体，正是想要的行为。
   */
  mobsInChunk: (cx: number, cz: number) => Iterable<Mob> = () => [];
  arrowsInChunk: (cx: number, cz: number) => Iterable<ArrowEntity> = () => [];
  installLoadedMobs: (mobs: readonly Mob[], arrows: readonly ArrowEntity[]) => void = () => { /* 默认丢弃 */ };
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

  constructor(
    seed: bigint, registry: BlockRegistry,
    generator?: WorldGenerator, dimension: DimensionId = Dimension.OVERWORLD,
  ) {
    this.seed = seed;
    this.tables = registry.getTables();
    // 生成器默认主世界：几百个已有测试写的都是 `new ServerWorld(seed, registry)`，
    // 让它们全部加一个参数只会淹掉真正的改动
    this.generator = generator ?? new OverworldGenerator(seed, registry);
    this.dimension = dimension;
    this.dim = dimensionOf(dimension);
    this.random = new JavaRandom(seed);
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
      // 下单之后、收货之前，存档那边可能已经把同一个区块读出来了。
      // 拿生成的盖掉存档的，等于把玩家盖的房子抹掉
      if (this.save !== null && this.save.isRegionReady(chunk.cx, chunk.cz)
        && installChunkFromSave(this, chunk.cx, chunk.cz) !== null) continue;
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
    // 先查存档。region 还没读进内存时返回 null，下个 tick 再来 ——
    // 绝不能直接往下走去生成，那会把玩家盖的东西盖掉
    if (this.save !== null) {
      if (!this.save.isRegionReady(cx, cz)) {
        this.save.requestRegion(cx, cz);
        return null;
      }
      const loaded = installChunkFromSave(this, cx, cz);
      if (loaded !== null) return loaded;
    }
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
    if (this.save !== null) {
      if (this.save.isRegionReady(cx, cz)) {
        const loaded = installChunkFromSave(this, cx, cz);
        if (loaded !== null) return loaded;
      } else {
        // 存档还没打开就强行生成 —— 这会**永久覆盖**这个区块存过的内容，
        // 因为等 region 到货时这里已经有一个区块了，installFromSave 再也走不到。
        //
        // 这是宿主的调用顺序错了（必须先 openSave 再放客户端进来，
        // 见 save/save-controller.ts）。同步接口没法在这里等，
        // 所以退而求其次：记下来，让它在统计里显形而不是悄悄丢数据
        this.save.requestRegion(cx, cz);
        this.forcedOverPendingSave++;
      }
    }
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

  /**
   * 方块换了之后，方块实体要跟着建/拆。
   *
   * 熔炉点火时 id 从 61 变 62，两者是**同一种**方块实体 ——
   * 这时候必须保住原来那个对象，否则每次点火熄火都会把里面的东西清空，
   * 而且燃烧进度归零。
   */
  private updateBlockEntity(x: number, y: number, z: number, oldId: number, newId: number): void {
    const oldKind = blockEntityKindFor(oldId);
    const newKind = blockEntityKindFor(newId);
    if (oldKind === newKind) return;
    if (oldKind !== null) {
      const removed = this.blockEntities.remove(x, y, z);
      if (removed !== null) this.brokenBlockEntities.push(removed);
    }
    if (newKind !== null) this.blockEntities.set(createBlockEntity(newKind, x, y, z));
  }

  /**
   * 本 tick 被拆掉的方块实体。
   *
   * 里面的东西要掉在地上，但 ServerWorld 不认识掉落物的生成规则
   * （那要用到随机源与实体 id 分配），所以只把它们攒起来交给 ServerCore。
   */
  private readonly brokenBlockEntities: BlockEntity[] = [];

  drainBrokenBlockEntities(): BlockEntity[] {
    if (this.brokenBlockEntities.length === 0) return [];
    return this.brokenBlockEntities.splice(0, this.brokenBlockEntities.length);
  }

  unloadChunk(cx: number, cz: number): void {
    // 先存再扔。少了这一步，走出视距再走回来，盖的东西全没了 ——
    // 而且只在"走得够远"的时候发生，正好是最难注意到的那种
    if (this.save !== null) saveChunkToSave(this, cx, cz);
    this.store.removeChunk(cx, cz);
    this.lightPending.delete(chunkKey(cx, cz));
    this.blockEntities.dropChunk(cx, cz);
    const x0 = cx * CHUNK_SIZE;
    const z0 = cz * CHUNK_SIZE;
    this.scheduled.removeIn(x0, z0, x0 + CHUNK_SIZE - 1, z0 + CHUNK_SIZE - 1);
    for (const [id, item] of this.items) {
      if ((Math.floor(item.x) >> 4) === cx && (Math.floor(item.z) >> 4) === cz) {
        this.items.delete(id);
        this.unloadedItems.push(id);
      }
    }
  }

  /** 因区块卸载而消失的掉落物，要通知客户端销毁 */
  private readonly unloadedItems: number[] = [];

  drainUnloadedItems(): number[] {
    if (this.unloadedItems.length === 0) return [];
    return this.unloadedItems.splice(0, this.unloadedItems.length);
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
    this.updateBlockEntity(x, y, z, stateId(before), stateId(state));
    // 邻域通知：上面的沙子该掉了、旁边的水该重新流了。
    //
    // 放在这里而不是让每个调用方各自记得调 —— 漏掉一处的表现是
    // "某些方式挖掉的方块下面沙子不掉"，而那种不一致极难注意到。
    // 世界生成不经过这里（生成器直接写 Chunk 再 addChunk），所以
    // 不必担心生成几万格时把整片地形排进计划刻队列
    onBlockChanged(this, x, y, z);

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

  /**
   * 变更一个方块，但**不触发邻域通知**。
   *
   * 红石线重算时用：一次重算会改几十格线的功率，每格都走一遍
   * onBlockChanged → scheduleNeighbors → 又触发红石重算，会无限递归。
   * 变更仍然会进 pendingChanges（客户端要看到线变亮），只是不再往外扩散。
   */
  setBlockQuiet(x: number, y: number, z: number, state: number): boolean {
    if (y < 0 || y >= WORLD_HEIGHT) return false;
    const cx = x >> 4;
    const cz = z >> 4;
    if (!this.store.hasChunk(cx, cz)) return false;
    const before = this.store.getState(x, y, z);
    if (before === state) return true;
    if (!this.store.setState(x, y, z, state)) return false;
    this.pendingChanges.push({ x, y, z, state });
    const oldId = stateId(before);
    const newId = stateId(state);
    this.light.onBlockChanged(
      x, y, z,
      oldId === 0 ? 0 : (this.tables.lightEmission[oldId] ?? 0),
      newId === 0 ? 0 : (this.tables.lightEmission[newId] ?? 0),
      oldId === 0 ? 0 : (this.tables.opacity[oldId] ?? 15),
    );
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
      if (this.dim.hasSkyLight) {
        this.light.seedSky(x0, z0, x0 + CHUNK_SIZE - 1, z0 + CHUNK_SIZE - 1, topY, true);
      } else {
        // 没有天光的维度**根本不跑天光播种**。
        //
        // 不只是"省一点"：末地的岛是一块悬在虚空里的薄板，绝大多数列的
        // 地表高度是 0 而邻居高达 120 —— seedSky 的判据（邻居比自己高
        // 就入队）在那里会让几乎每一格都成为传播源，一个区块三万条，
        // 六十个区块就够把服务端卡死几十秒。实测就是这样卡的：
        // "dimension end 指令超时"。
        //
        // 不播的话读到的是隐含值（地表以上 15、以下 0），
        // 那正好就是下界与末地该有的样子：洞里全黑，只有岩浆和萤石照亮。
        this.light.markLightReady(x0, z0, x0 + CHUNK_SIZE - 1, z0 + CHUNK_SIZE - 1);
      }
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

  /**
   * 只涨 worldAge，不动昼夜。下界与末地用它。
   *
   * worldAge 是**计划刻队列的时间轴**，不涨的话那两个维度里的流体、
   * 沙子、红石会永远停在原地 —— 而症状（"下界的岩浆不流"）
   * 很难联想到时间上。
   */
  advanceTimeOnly(): void {
    this.worldAge++;
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
