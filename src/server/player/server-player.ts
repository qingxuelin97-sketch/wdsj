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
import { S_ChunkData, S_ChunkUnload } from '../../core/net/packets.ts';
import type { ServerWorld } from '../world/server-world.ts';
import { DEFAULT_RENDER_DISTANCE, SEA_LEVEL } from '../../core/constants.ts';

/** 每 tick 最多推送几个区块，避免一次性把带宽和生成预算打满 */
const CHUNKS_PER_TICK = 3;

export class ServerPlayer {
  readonly entityId: number;
  readonly channel: PacketChannel;
  name = 'player';

  x = 0.5;
  y = SEA_LEVEL + 2;
  z = 0.5;
  yaw = 0;
  pitch = 0;
  onGround = false;
  /** 客户端最后确认的输入序号，用于和解 */
  lastSeq = 0;

  viewDistance = DEFAULT_RENDER_DISTANCE;

  /** 已推送给该玩家的区块 */
  private readonly subscribed = new Set<number>();
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
    const ready: number[] = [];
    while (this.pending.length > 0 && ready.length < CHUNKS_PER_TICK) {
      const key = this.pending.shift()!;
      if (this.subscribed.has(key)) continue;
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
      if (!complete) {
        // 本 tick 的生成配额用完了：把它放回队首，下个 tick 接着来。
        // 不能就这么发出去 —— 邻域没齐的话中心区块的天光还不是最终值。
        this.pending.unshift(key);
        break;
      }
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
