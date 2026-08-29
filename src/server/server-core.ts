/**
 * 服务端核心。
 *
 * **不含任何 Worker / DOM / 定时器依赖** —— 这是刻意的，也是整个验证体系的地基：
 * `node --test` 可以直接 `new ServerCore(...)`，挂一个 loopback 客户端，
 * 手动 `tick()` 两万次做断言，完全不需要浏览器。据此可覆盖世界生成、光照、
 * 红石、流体、AI、容器、持久化、伤害 —— 约占全游戏逻辑的 80%。
 *
 * tick 的驱动交给宿主：
 *   单人 = server-worker 里的 SAB 时钟（免疫标签页节流）
 *   多人 = node 里的 setInterval
 *   测试 = 直接调 tick()
 */
import { PacketChannel, type Transport } from '../core/net/transport.ts';
import {
  C2S, PROTOCOL_VERSION, PlayerActionKind,
  S_Login, S_TimeUpdate, S_BlockUpdate, S_Disconnect, S_CommandResult, S_Chat, S_ServerStats,
} from '../core/net/packets.ts';
import { ServerWorld } from './world/server-world.ts';
import { ServerPlayer } from './player/server-player.ts';
import type { BlockRegistry } from '../core/registry/block-registry.ts';
import { AIR_STATE, packState, chunkKey, stateId } from '../core/world/chunk.ts';
import { breakProgressPerTick } from '../core/block/breaking.ts';
import { TPS, EYE_HEIGHT, PLAYER_WIDTH, PLAYER_HEIGHT, WORLD_HEIGHT, REACH_SURVIVAL } from '../core/constants.ts';

/**
 * 触及距离的判定上限（平方）。
 *
 * 比 4.5 格的标称值放宽一些：客户端是按自己**预测**的位置发包的，
 * 而服务端手里是稍旧的位置，卡在边界上时两边会差出零点几格。
 * 卡得太死的话，正常游玩时会偶发"点了没反应"。
 */
const REACH_LIMIT_SQ = (REACH_SURVIVAL + 1.5) ** 2;

/** face 编号到法线。与 core/block/types.ts 的 Facing 一致 */
const FACE_NORMALS: readonly (readonly [number, number, number])[] = [
  [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0],
];

/** 每多少 tick 扫描一次并卸载无人问津的区块 */

export interface ServerOptions {
  seed: bigint | number;
  registry: BlockRegistry;
  /** 每多少 tick 广播一次时间。默认 20（每秒一次） */
  timeSyncInterval?: number;
}

export interface ServerStats {
  tick: number;
  players: number;
  loadedChunks: number;
  /** 最近一次 tick 的耗时（毫秒），由宿主填入 */
  lastTickMs: number;
}

export class ServerCore {
  readonly world: ServerWorld;
  readonly registry: BlockRegistry;
  private readonly players = new Map<number, ServerPlayer>();

  /** 测试用：遍历在线玩家。生产代码不要用 */
  playersForTest(): Iterable<ServerPlayer> {
    return this.players.values();
  }
  private nextEntityId = 1;
  /** 已经跑过的 tick 数。宿主要把它写进共享统计槽，所以是公开的 */
  tickCount = 0;
  private readonly timeSyncInterval: number;
  /** 供宿主填写的统计，ServerCore 自己不读挂钟 */
  lastTickMs = 0;

  constructor(opts: ServerOptions) {
    this.registry = opts.registry;
    this.world = new ServerWorld(BigInt(opts.seed), opts.registry);
    this.timeSyncInterval = opts.timeSyncInterval ?? TPS;
  }

  get tickNumber(): number {
    return this.tickCount;
  }

  get playerCount(): number {
    return this.players.size;
  }

  /**
   * 所有玩家的待推送区块总数。
   * 自动化测试用它判断世界是否已经流式加载完毕 —— 只看客户端的网格化队列是不够的，
   * 服务端可能还在一批批地推，那会让截图内容随时间变化。
   */
  pendingChunkCount(): number {
    let n = 0;
    for (const player of this.players.values()) n += player.pendingCount;
    return n;
  }

  stats(): ServerStats {
    return {
      tick: this.tickCount,
      players: this.players.size,
      loadedChunks: this.world.loadedCount,
      lastTickMs: this.lastTickMs,
    };
  }

  /** 接入一个客户端。返回它的玩家对象 */
  addClient(transport: Transport): ServerPlayer {
    const channel = new PacketChannel(transport, C2S);
    const player = new ServerPlayer(this.nextEntityId++, channel);
    this.players.set(player.entityId, player);

    channel.onPacket((name, value) => this.handlePacket(player, name, value));
    channel.onError((err) => {
      channel.send(S_Disconnect, { reason: `协议错误: ${err.message}` });
      channel.flush();
      this.removePlayer(player);
    });
    transport.onClose(() => this.removePlayer(player));
    return player;
  }

  removePlayer(player: ServerPlayer): void {
    this.players.delete(player.entityId);
  }

  /** 推进一个 tick。宿主每 50ms 调一次 */
  tick(): void {
    this.tickCount++;
    this.world.advanceTime();
    this.world.resetGenerationBudget();
    // 先收下 gen worker 这一轮送到的区块，再决定要不要下新单
    this.world.intakeGenerated();

    // 挖掘进度：服务端自己算，每 tick 推进一步。
    //
    // 必须排在下面 drainChanges 之前 —— 否则这一 tick 破坏的方块要等到
    // **下一** tick 才广播出去，玩家会看到挖穿后方块还杵在那里闪一下。
    for (const player of this.players.values()) this.advanceDigging(player);

    // 区块流水线：先生成，再算光照，最后才推送。
    // 顺序不能颠倒 —— 先推送的话客户端拿到的是光照全 0 的区块。
    const prepared: { player: ServerPlayer; keys: number[] }[] = [];
    for (const player of this.players.values()) {
      player.updateSubscriptions(this.world);
      const keys = player.prepareChunks(this.world);
      if (keys.length > 0) prepared.push({ player, keys });
    }

    // 光照重算（M4 会换成局部增量）
    this.world.updateLighting();

    for (const entry of prepared) entry.player.sendPreparedChunks(this.world, entry.keys);

    // 方块变更广播 —— 只发给订阅了对应区块的玩家
    const changes = this.world.drainChanges();
    if (changes.length > 0) {
      for (const player of this.players.values()) {
        for (const c of changes) {
          if (!player.isSubscribed(c.x >> 4, c.z >> 4)) continue;
          player.channel.send(S_BlockUpdate, { x: c.x, y: c.y, z: c.z, state: c.state });
        }
      }
    }

    // 服务端状态：每 tick 都发。它很小（10 字节），但让主线程随时知道
    // 服务端还有多少活没干完 —— 这是 waitForIdle 判定世界安定的必要依据。
    const pending = this.pendingChunkCount();
    const loaded = this.world.loadedCount;
    for (const player of this.players.values()) {
      player.channel.send(S_ServerStats, {
        tick: this.tickCount,
        pendingChunks: Math.min(65535, pending),
        loadedChunks: Math.min(65535, loaded),
        tickMicros: Math.min(65535, Math.round(this.lastTickMs * 100)),
      });
    }

    // 时间同步
    if (this.tickCount % this.timeSyncInterval === 0) {
      for (const player of this.players.values()) {
        player.channel.send(S_TimeUpdate, {
          worldAge: BigInt(this.world.worldAge),
          timeOfDay: BigInt(this.world.timeOfDay),
        });
      }
    }

    // 卸载没人看的区块。
    //
    // 每 tick 都做，不做成"每 100 tick 一次"。原因不是性能而是**确定性**：
    // 周期性任务会让世界在某个 tick 突然少掉一批区块，而截图恰好落在
    // 那一下的前面还是后面，取决于机器快慢 —— 同一份代码截出来的画面
    // 时而多两个区块时而少两个。实测就是这么在 skyline 上飘的：
    // 连拍六张，第五张开始哈希变了。
    //
    // 保留范围本来就取视距 +2，有滞回，每 tick 扫不会造成反复卸载重建；
    // 代价是几百次距离比较，相对生成一个区块的 11.6 ms 可以忽略。
    this.unloadDistantChunks();

    // 每 tick 一次 flush：一个 tick 内产生的所有包合成一条消息发出
    for (const player of this.players.values()) player.channel.flush();
  }

  /**
   * 卸载没有任何玩家需要的区块。
   *
   * 必须有这一步：prepareChunks 会连同 3×3 邻域一起生成（为了让天光收敛），
   * 那些邻域区块从来没被"订阅"过，光靠订阅差集永远清不掉它们 ——
   * 服务端会一直往上堆区块，跑久了就是内存泄漏。
   *
   * 保留范围取视距 +2：比玩家实际能看到的略大一圈，这样在边界来回走动时
   * 不会反复卸载又重新生成（那比多留几个区块贵得多）。
   */
  private unloadDistantChunks(): void {
    const keep = new Set<number>();
    for (const player of this.players.values()) {
      const cx = player.chunkX;
      const cz = player.chunkZ;
      const r = player.viewDistance + 2;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dz * dz > r * r) continue;
          keep.add(chunkKey(cx + dx, cz + dz));
        }
      }
    }
    const doomed: [number, number][] = [];
    for (const chunk of this.world.store.chunkValues()) {
      if (!keep.has(chunk.key)) doomed.push([chunk.cx, chunk.cz]);
    }
    for (const [cx, cz] of doomed) this.world.unloadChunk(cx, cz);
  }

  // -------------------------------------------------------------------------
  // 包处理
  // -------------------------------------------------------------------------

  private handlePacket(player: ServerPlayer, name: string, value: Record<string, unknown>): void {
    switch (name) {
      case 'C_Handshake': return this.onHandshake(player, value);
      case 'C_PlayerMove': return this.onPlayerMove(player, value);
      case 'C_PlayerAction': return this.onPlayerAction(player, value);
      case 'C_UseBlock': return this.onUseBlock(player, value);
      case 'C_SetViewDistance': {
        const d = value['distance'] as number;
        player.viewDistance = Math.max(2, Math.min(16, d));
        player.resetSubscriptions();
        return;
      }
      case 'C_Command': return this.onCommand(player, value);
      case 'C_HeldSlot':
      case 'C_Swing':
      case 'C_KeepAlive':
        return; // M6/M8 接上
      default:
        return;
    }
  }

  private onHandshake(player: ServerPlayer, value: Record<string, unknown>): void {
    const version = value['protocolVersion'] as number;
    if (version !== PROTOCOL_VERSION) {
      player.channel.send(S_Disconnect, { reason: `协议版本不匹配：服务端 ${PROTOCOL_VERSION}，客户端 ${version}` });
      player.channel.flush();
      this.removePlayer(player);
      return;
    }
    player.name = String(value['playerName'] ?? 'player');

    const spawn = this.world.generator.findSpawn();
    // findSpawn 只看得到**装饰前**的地形阶段，所以它可能把人放在一棵树的树干里。
    // 这里用完整生成的区块再校正一次：向上找到第一处有两格空隙的位置。
    this.world.forceChunk(Math.floor(spawn.x) >> 4, Math.floor(spawn.z) >> 4);
    const bx = Math.floor(spawn.x);
    const bz = Math.floor(spawn.z);
    let sy = Math.floor(spawn.y);
    for (let probe = 0; probe < 24; probe++) {
      const feet = this.world.getBlock(bx, sy, bz);
      const head = this.world.getBlock(bx, sy + 1, bz);
      const below = this.world.getBlock(bx, sy - 1, bz);
      if (feet === AIR_STATE && head === AIR_STATE && below !== AIR_STATE) break;
      sy++;
    }
    player.x = spawn.x;
    player.y = sy;
    player.z = spawn.z;

    player.channel.send(S_Login, {
      entityId: player.entityId,
      dimension: 0,
      gameMode: 1,
      seed: this.world.seed,
      spawnX: player.x,
      spawnY: player.y,
      spawnZ: player.z,
    });
    player.channel.send(S_Chat, { text: `欢迎，${player.name}` });
    // 立刻算一次订阅，让第一批区块在本 tick 就开始推送
    player.updateSubscriptions(this.world);
    player.channel.flush();
  }

  private onPlayerMove(player: ServerPlayer, value: Record<string, unknown>): void {
    // M6 会在这里做服务端物理与和解。现在信任客户端，只记录位置。
    player.lastSeq = value['seq'] as number;
    player.x = value['x'] as number;
    player.y = value['y'] as number;
    player.z = value['z'] as number;
    player.yaw = value['yaw'] as number;
    player.pitch = value['pitch'] as number;
    player.onGround = value['onGround'] as boolean;
  }

  /** 玩家眼睛到方块中心的距离平方，用于触及检查 */
  private reachSq(player: ServerPlayer, x: number, y: number, z: number): number {
    const dx = player.x - (x + 0.5);
    const dy = player.y + EYE_HEIGHT - (y + 0.5);
    const dz = player.z - (z + 0.5);
    return dx * dx + dy * dy + dz * dz;
  }

  private onPlayerAction(player: ServerPlayer, value: Record<string, unknown>): void {
    const action = value['action'] as number;
    const x = value['x'] as number;
    const y = value['y'] as number;
    const z = value['z'] as number;

    if (action === PlayerActionKind.START_DIG) {
      const state = this.world.getBlock(x, y, z);
      if (!this.world.isBreakable(state)) return;
      // 触及距离多给一点余量：客户端是按自己预测的位置发的，
      // 卡得正好在 4.5 格上时不该被判成作弊
      if (this.reachSq(player, x, y, z) > REACH_LIMIT_SQ) return;
      player.digging = true;
      player.digX = x;
      player.digY = y;
      player.digZ = z;
      player.digProgress = 0;
      // 硬度为 0 的（火把、花）一下就断，不必等下一 tick
      this.advanceDigging(player);
      return;
    }

    if (action === PlayerActionKind.CANCEL_DIG || action === PlayerActionKind.FINISH_DIG) {
      // FINISH_DIG 只当作"松手"。破坏与否由服务端自己的进度说了算 ——
      // 信客户端的话，改一行前端就能瞬间挖穿基岩。
      player.digging = false;
      player.digProgress = 0;
    }
  }

  /** 推进一个玩家的挖掘进度；够了就破坏 */
  private advanceDigging(player: ServerPlayer): void {
    if (!player.digging) return;
    const { digX: x, digY: y, digZ: z } = player;
    const state = this.world.getBlock(x, y, z);
    const id = stateId(state);
    if (id === 0 || !this.world.isBreakable(state)) {
      player.digging = false;
      return;
    }
    // 挖到一半人走开了就停下
    if (this.reachSq(player, x, y, z) > REACH_LIMIT_SQ) {
      player.digging = false;
      return;
    }

    // M8 之前手上还没有工具，所以是徒手速度。石头 7.5 秒 —— 慢得真实。
    player.digProgress += breakProgressPerTick(this.world.tables, id, null);
    if (player.digProgress < 1) return;

    player.digging = false;
    player.digProgress = 0;
    // 挖到什么就拿着什么。M8 接上背包后换成真正的掉落与拾取
    player.heldBlockId = id;
    this.world.setBlock(x, y, z, AIR_STATE);
  }

  private onUseBlock(player: ServerPlayer, value: Record<string, unknown>): void {
    const x = value['x'] as number;
    const y = value['y'] as number;
    const z = value['z'] as number;
    const face = value['face'] as number;

    if (this.reachSq(player, x, y, z) > REACH_LIMIT_SQ) return;

    // face 是命中面的法线编号，新方块落在那一侧
    const [nx, ny, nz] = FACE_NORMALS[face] ?? [0, 0, 0];
    const px = x + nx;
    const py = y + ny;
    const pz = z + nz;
    if (py < 0 || py >= WORLD_HEIGHT) return;

    // 只能放进空气里
    if (stateId(this.world.getBlock(px, py, pz)) !== 0) return;

    // 不能把自己封在方块里：玩家碰撞盒与目标格重叠时拒绝。
    // 少了这一条，对着脚下点一下就会被卡进方块，然后被挤到旁边去。
    const half = PLAYER_WIDTH / 2;
    const overlapX = player.x + half > px && player.x - half < px + 1;
    const overlapZ = player.z + half > pz && player.z - half < pz + 1;
    const overlapY = player.y + PLAYER_HEIGHT > py && player.y < py + 1;
    if (overlapX && overlapY && overlapZ) return;

    this.world.setBlock(px, py, pz, packState(player.heldBlockId));
  }

  private onCommand(player: ServerPlayer, value: Record<string, unknown>): void {
    const requestId = value['requestId'] as number;
    const text = String(value['text'] ?? '');
    const reply = (ok: boolean, msg: string): void => {
      player.channel.send(S_CommandResult, { requestId, ok, text: msg });
    };

    const parts = text.trim().split(/\s+/);
    const cmd = parts[0] ?? '';
    try {
      switch (cmd) {
        case 'setblock': {
          const [, sx, sy, sz, blockName] = parts;
          const state = packState(this.registry.idOf(String(blockName)));
          const ok = this.world.setBlock(Number(sx), Number(sy), Number(sz), state);
          reply(ok, ok ? 'ok' : '区块未加载');
          return;
        }
        case 'getblock': {
          const [, sx, sy, sz] = parts;
          const state = this.world.getBlock(Number(sx), Number(sy), Number(sz));
          const id = state & 0xfff;
          reply(true, this.registry.get(id)?.name ?? `未知(${id})`);
          return;
        }
        case 'tp': {
          const [, sx, sy, sz] = parts;
          player.x = Number(sx);
          player.y = Number(sy);
          player.z = Number(sz);
          player.resetSubscriptions();
          reply(true, 'ok');
          return;
        }
        case 'time': {
          const [, sub, val] = parts;
          if (sub === 'set') {
            this.world.timeOfDay = ((Number(val) % 24000) + 24000) % 24000;
          } else if (sub === 'hold') {
            this.world.daylightCycle = val !== '1' && val !== 'true';
          }
          // 立刻回传一次，不等下一个同步周期 —— 自动化就是靠这个知道设定生效了
          for (const p of this.players.values()) {
            p.channel.send(S_TimeUpdate, {
              worldAge: BigInt(this.world.worldAge),
              timeOfDay: BigInt(this.world.timeOfDay),
            });
          }
          reply(true, String(this.world.timeOfDay));
          return;
        }
        case 'light': {
          const [, sx, sy, sz] = parts;
          const x = Number(sx), y = Number(sy), z = Number(sz);
          reply(true, `${this.world.store.getSkyLight(x, y, z)}/${this.world.store.getBlockLight(x, y, z)}`);
          return;
        }
        case 'settled': {
          // 自动化用：一次**同步**的服务端状态查询。
          //
          // 不能用 S_ServerStats 代替 —— 那是每隔若干 tick 才发一次的，
          // 相机刚移动完时客户端手里还是移动**之前**的那份统计，
          // 会读到"没有待推送区块"而误判世界已就绪，然后在截图中途
          // 才把新区块补上。指令走的是包队列，服务端处理它时
          // 必定已经处理完了之前的移动包，所以结果一定是新鲜的。
          reply(true, `${player.pendingCount} ${player.subscribedCount} ${this.world.loadedCount}`);
          return;
        }
        case 'height': {
          const [, sx, sz] = parts;
          reply(true, String(this.world.store.getHeight(Number(sx), Number(sz))));
          return;
        }
        case 'stats':
          reply(true, JSON.stringify(this.stats()));
          return;
        default:
          reply(false, `未知指令: ${cmd}`);
      }
    } catch (err) {
      reply(false, err instanceof Error ? err.message : String(err));
    }
  }
}
