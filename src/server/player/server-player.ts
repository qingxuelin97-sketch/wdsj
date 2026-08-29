/**
 * 服务端的玩家状态与区块订阅。
 *
 * 区块推送用"订阅集合求差"：每次玩家跨越区块边界时，算出新的可见集合，
 * 与旧集合求差 —— 新增的排队生成并推送，移除的发卸载包。
 * 这比"每 tick 扫描全部已加载区块"便宜得多，也不会在玩家静止时做无用功。
 */
import { PacketChannel } from '../../core/net/transport.ts';
import { chunkKey, keyToCx, keyToCz } from '../../core/world/chunk.ts';
import { encodeChunk } from '../../core/world/chunk-codec.ts';
import { PlayerInventory, type Window } from './player-inventory.ts';
import { S_ChunkData, S_ChunkUnload } from '../../core/net/packets.ts';
import type { ServerWorld } from '../world/server-world.ts';
import { DEFAULT_RENDER_DISTANCE, SEA_LEVEL, MAX_HEALTH } from '../../core/constants.ts';
import type { BlockEntity } from '../world/block-entity.ts';
import { PlayerVitals } from './player-vitals.ts';
import { Experience } from './experience.ts';

/** 每 tick 最多推送几个区块，避免一次性把带宽和生成预算打满 */
const CHUNKS_PER_TICK = 8;

/**
 * 每 tick 往前预取多少个区块的邻域。
 *
 * 要大到能让 gen worker 一直有活干：两个 worker、每个区块 9.6 ms，
 * 一个 50 ms 的 tick 里能做掉约 10 个，所以预取窗口不能比这个小。
 */
const PREFETCH_AHEAD = 24;

export class ServerPlayer {
  readonly entityId: number;
  readonly channel: PacketChannel;
  name = 'player';

  x = 0.5;
  y = SEA_LEVEL + 2;
  z = 0.5;
  yaw = 0;
  pitch = 0;

  /**
   * 生存状态：血量、饥饿、饱和、消耗、氧气、着火、各种伤害计时。
   *
   * 血量本身在 M10 就打通了（生物要能打到人），M12 把整套循环接上。
   */
  readonly vitals = new PlayerVitals();
  /** 经验等级与进度 */
  readonly xp = new Experience();
  /** 上一次报上来的位置里，下落的最高点。摔落伤害按它算 */
  peakY = 0;
  /** 上一刻是不是在地上，用来判定"刚落地" */
  wasOnGround = true;
  /** 上一次报位置时的水平坐标，用来算走了多远（体力消耗按位移算） */
  lastX = 0;
  lastZ = 0;
  /** 死亡之后等待客户端请求重生 */
  awaitingRespawn = false;

  get health(): number {
    return this.vitals.health;
  }

  get maxHealth(): number {
    return MAX_HEALTH;
  }

  // --- 挖掘状态 ---
  //
  // 服务端自己算进度，**不信客户端的"我挖完了"**。
  // 客户端只报"开始挖这一格"和"松手了"；破坏的时刻由服务端用同一份
  // core/block/breaking.ts 的公式判定。否则改一行客户端就能瞬间挖穿基岩。
  /** 正在挖的方块；digging 为 false 时无意义 */
  digging = false;
  digX = 0;
  digY = 0;
  digZ = 0;
  /** 已累积的进度，0..1 */
  digProgress = 0;

  /** 玩家的物品栏。跨窗口常驻 */
  readonly inventory = new PlayerInventory();
  /** 当前打开的窗口。null 表示只有快捷栏可见 */
  /**
   * 当前打开的容器界面。null 表示只有快捷栏可见。
   *
   * 名字里带 open 不是啰嗦：叫 `window` 会被 lint-layers 当成 DOM 全局拦下来，
   * 而那条规则正是用来保证 server 层能在 node 里跑的。
   */
  openWindow: Window | null = null;
  /** 窗口 id，每次开新窗口自增，用来丢弃过期的点击包 */
  windowId = 0;
  onGround = false;
  /** 客户端最后确认的输入序号，用于和解 */
  lastSeq = 0;

  viewDistance = DEFAULT_RENDER_DISTANCE;

  /** 已推送给该玩家的区块 */
  private readonly subscribed = new Set<number>();
  /**
   * 这个玩家已经收到过出生包的实体，**按种类分开**。
   *
   * 与订阅集一起构成同步的全部依据：在订阅区块里但不在集合里 = 该发出生包，
   * 在集合里但不在订阅区块里 = 该发销毁包。
   *
   * 两个集合而不是一个：掉落物与生物由各自的管理器广播，各算各的差集。
   * 共用一个集合的话，后跑的那个会把前一个刚加进去的 id 全判成"不在我的
   * seen 里"，于是每刻发一遍销毁 —— 表现是服务端明明有十几只怪，
   * 客户端一只都看不到，而且完全不报错。
   */
  readonly knownItems = new Set<number>();
  readonly knownMobs = new Set<number>();
  /**
   * 当前窗口背后的方块实体（箱子/熔炉），没有则为 null。
   * 熔炉进度要靠它判断"这个玩家是不是正看着这个熔炉"。
   */
  openBlockEntity: BlockEntity | null = null;
  /** 待推送队列，按距离排序 */
  private pending: number[] = [];
  /** 上次重算订阅时玩家所在的区块，用于判断是否跨块 */
  private lastCx = Number.NaN;
  private lastCz = Number.NaN;

  constructor(entityId: number, channel: PacketChannel) {
    this.entityId = entityId;
    this.channel = channel;
  }

  get chunkX(): number {
    return Math.floor(this.x) >> 4;
  }

  get chunkZ(): number {
    return Math.floor(this.z) >> 4;
  }

  /** 该区块是否已经推送给这个玩家 —— 决定要不要给他发方块变更 */
  isSubscribed(cx: number, cz: number): boolean {
    return this.subscribed.has(chunkKey(cx, cz));
  }

  /**
   * 重算可见区块集合。只在玩家跨越区块边界时做实际工作。
   * @returns 是否发生了重算
   */
  updateSubscriptions(world: ServerWorld): boolean {
    const cx = this.chunkX;
    const cz = this.chunkZ;
    if (cx === this.lastCx && cz === this.lastCz) return false;
    this.lastCx = cx;
    this.lastCz = cz;

    const r = this.viewDistance;
    const wanted = new Set<number>();
    const queue: { key: number; dist: number }[] = [];
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        // 圆形而不是方形，边角的区块看不见却要生成，纯浪费
        const dist = dx * dx + dz * dz;
        if (dist > r * r) continue;
        const key = chunkKey(cx + dx, cz + dz);
        wanted.add(key);
        if (!this.subscribed.has(key)) queue.push({ key, dist });
      }
    }

    // 离开视野的区块：通知客户端卸载
    for (const key of this.subscribed) {
      if (wanted.has(key)) continue;
      this.subscribed.delete(key);
      this.channel.send(S_ChunkUnload, { cx: keyToCx(key), cz: keyToCz(key) });
    }

    // 由近及远推送，玩家脚下的先到
    queue.sort((a, b) => a.dist - b.dist);
    this.pending = queue.map((q) => q.key);
    void world;
    return true;
  }

  /**
   * 取出本 tick 要推送的区块并**确保它们已生成**，但先不发。
   *
   * 生成与推送必须分开：区块的光照是在生成之后、由 world.updateLighting() 算的，
   * 若在同一步里生成完就立刻编码发出，客户端收到的是一份光照全为 0 的区块，
   * 表现为新加载的地形一片漆黑，等下一次变更才亮起来。
   */
  prepareChunks(world: ServerWorld): number[] {
    // 第 1 步：**预取**。沿着待办队列往前走一大段，把它们的 3×3 邻域都下单。
    //
    // 这一步和"这个 tick 要发哪几个"是分开的，故意的。生成搬进 worker 之后，
    // ensureChunk 不再当场返回区块而是下个单，于是"发不出去就停下"会把整条流水线
    // 卡成串行：下单 -> 等一个 tick -> 收货 -> 发一个 -> 再下单。
    // 实测那样 RD 8 要 330 个 tick（16.5 秒），而真正的生成工作只有约 1.2 秒。
    // 预取让 gen worker 始终有活干。
    for (let i = 0; i < Math.min(this.pending.length, PREFETCH_AHEAD); i++) {
      const key = this.pending[i]!;
      const cx = keyToCx(key);
      const cz = keyToCz(key);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) world.ensureChunk(cx + dx, cz + dz);
      }
    }

    // 第 2 步：挑出邻域已经齐全的，本 tick 发它们。
    const ready: number[] = [];
    let scanned = 0;
    while (scanned < this.pending.length && ready.length < CHUNKS_PER_TICK && scanned < PREFETCH_AHEAD) {
      const key = this.pending[scanned]!;
      scanned++;
      if (this.subscribed.has(key)) {
        this.pending.splice(scanned - 1, 1);
        scanned--;
        continue;
      }
      const cx = keyToCx(key);
      const cz = keyToCz(key);
      // 连同 3×3 邻域一起生成，中心区块的天光才是**最终值**。
      //
      // 只生成中心的话会这样：A 推送出去之后邻居 B 才加载，B 的泛洪会把光传进 A，
      // 但 A 的快照早发走了 —— 客户端手里的 A 永远停在"没有 B 时"的光照上。
      // 于是画面取决于区块到达的先后，同一个种子每次跑出来都不一样，
      // 截图回归直接失效。
      //
      // 天光传播最远 15 格，而区块宽 16 格，所以 3×3 邻域足以定死中心的光照。
      let complete = true;
      for (let dz = -1; dz <= 1 && complete; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (world.ensureChunk(cx + dx, cz + dz) === null) { complete = false; break; }
        }
      }
      // 邻域还没齐就跳过它去看下一个 —— 但**不**从队列里拿走，下个 tick 还要来。
      // 早先这里是 break，于是队首一个没好就整条队列停摆。
      if (!complete) continue;

      this.pending.splice(scanned - 1, 1);
      scanned--;
      ready.push(key);
    }
    return ready;
  }

  /** 光照算完之后再把准备好的区块发出去 */
  sendPreparedChunks(world: ServerWorld, keys: readonly number[]): void {
    for (const key of keys) {
      const cx = keyToCx(key);
      const cz = keyToCz(key);
      const chunk = world.store.getChunk(cx, cz);
      if (chunk === null) continue;
      this.channel.send(S_ChunkData, { cx, cz, blob: encodeChunk(chunk) });
      this.subscribed.add(key);
    }
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get subscribedCount(): number {
    return this.subscribed.size;
  }

  /** 强制重新推送全部区块（传送、维度切换后使用） */
  resetSubscriptions(): void {
    this.subscribed.clear();
    this.pending = [];
    this.lastCx = Number.NaN;
    this.lastCz = Number.NaN;
  }
}
