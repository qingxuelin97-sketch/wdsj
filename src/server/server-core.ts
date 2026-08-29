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
  S_WindowItems, S_OpenWindow, S_WindowProgress, S_EntityEvent, S_PlayerHealth, WindowKind,
} from '../core/net/packets.ts';
import { ServerWorld } from './world/server-world.ts';
import { handleCommand } from './commands.ts';
import {
  dropOf, toolOf, giveToPlayer, maxStackOf, syncInventory,
  onWindowClick, showWindow, closeWindow,
} from './player/inventory-actions.ts';
import { ServerPlayer } from './player/server-player.ts';
import type { BlockRegistry } from '../core/registry/block-registry.ts';
import { AIR_STATE, packState, chunkKey, stateId } from '../core/world/chunk.ts';
import { breakProgressPerTick, canHarvest, type HeldTool } from '../core/block/breaking.ts';
import {
  isEmpty, cloneStack, makeStack, ITEM_ID_BASE, type ItemStack,
} from '../core/item/item-def.ts';
import { Window, ARMOR_SLOTS, MAIN_SLOTS, HOTBAR_SLOTS } from './player/player-inventory.ts';
import { createItemRegistry, type ItemRegistry } from '../content/items.ts';
import { createCraftingData, type SmeltingRecipe, type CraftingData } from '../content/recipes.ts';
import { tickBlockEntities } from './world/block-entity-tick.ts';
import { onPlayerAction, onUseBlock, advanceDigging } from './player/block-interaction.ts';
import { onAttackEntity, tickArrows, shootArrow, explodeAt, damagePlayer } from './entity/combat.ts';
import { ChestEntity, FurnaceEntity, type BlockEntity } from './world/block-entity.ts';
import { tickItems, broadcastItems, spawnBlockDrop, scatterContents } from './entity/item-manager.ts';
import { saveAllChunks } from './world/world-persistence.ts';
import { MobManager } from './entity/mob-manager.ts';
import { ArrowEntity, ARROW_SPEED, type ArrowEntity as Arrow } from './entity/arrow.ts';
import { explode } from './entity/explosion.ts';
import type { Mob } from './entity/mob.ts';
import type { TargetRef } from './entity/goal.ts';
import { setBodyBox, makeBox } from './../core/physics/block-collision.ts';
import { TPS, EYE_HEIGHT, PLAYER_WIDTH, PLAYER_HEIGHT, WORLD_HEIGHT, REACH_SURVIVAL } from '../core/constants.ts';

/**
 * 触及距离的判定上限（平方）。
 *
 * 比 4.5 格的标称值放宽一些：客户端是按自己**预测**的位置发包的，
 * 而服务端手里是稍旧的位置，卡在边界上时两边会差出零点几格。
 * 卡得太死的话，正常游玩时会偶发"点了没反应"。
 */
/** 少数几个"掉的不是自己"的方块 */
const DROP_OVERRIDE: Record<number, number> = {
  1: 4,    // 石头 -> 圆石
  2: 3,    // 草方块 -> 泥土
  13: 13,  // 砾石有几率掉燧石，M9 接上随机掉落表后再说
  16: 263, // 煤矿 -> 煤
  21: 351, // 青金石矿 -> 青金石（染料）
  56: 264, // 钻石矿 -> 钻石
  73: 331, // 红石矿 -> 红石
  110: 3,  // 菌丝 -> 泥土
};

/** 右键这些方块是"打开界面"而不是"放方块" */
const OPENS_WINDOW: Record<number, WindowKind> = {
  58: WindowKind.CRAFTING,
  54: WindowKind.CHEST,
  61: WindowKind.FURNACE,
  62: WindowKind.FURNACE,
};

const WINDOW_TITLES: Record<number, string> = {
  [WindowKind.INVENTORY]: 'Inventory',
  [WindowKind.CRAFTING]: 'Crafting',
  [WindowKind.FURNACE]: 'Furnace',
  [WindowKind.CHEST]: 'Chest',
};

/** [start, start+count) 的下标序列 */
function range(start: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => start + i);
}

/** 箭命中判定复用的盒子。每刻可能有几十支箭，别每支都新建 */
const arrowScratch = makeBox();

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
  readonly items: ItemRegistry = createItemRegistry();
  readonly crafting: CraftingData = createCraftingData();
  readonly registry: BlockRegistry;
  /** 生物：生成、AI、同步 */
  readonly mobs: MobManager;
  /** 飞在空中的箭 */
  readonly arrows = new Map<number, Arrow>();
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
  /**
   * 世界出生点。−1 表示还没定，登录时现算一次。
   *
   * 存进 level.dat 而不是每次重算：findSpawn 只看得到装饰前的地形阶段，
   * 重算出来的点会随着世界生成代码的任何改动而漂移，
   * 而"重进游戏发现自己出生点变了"是最没道理的一种退步。
   */
  spawnX = 0;
  spawnY = -1;
  spawnZ = 0;
  /**
   * 玩家握手完成、位置已定，但**登录包还没发出去**时的回调。
   *
   * 宿主用它把存档里的位置与物品栏套上去。时机很讲究：早于 S_Login 才能
   * 让玩家一次到位地出现在存档里的位置；晚一点的话客户端会先在出生点
   * 出现一下再被拉走，而那一下和"被服务端判定作弊后纠正"长得一模一样。
   */
  onPlayerReady: ((player: ServerPlayer) => void) | null = null;

  constructor(opts: ServerOptions) {
    this.registry = opts.registry;
    this.world = new ServerWorld(BigInt(opts.seed), opts.registry);
    this.mobs = new MobManager(this);
    this.timeSyncInterval = opts.timeSyncInterval ?? TPS;
    // 掉落物与玩家共用一个 id 空间：两边各发一号会让客户端把一个掉落物
    // 当成某个玩家的更新，而那种错乱看起来完全不像同步问题
    this.world.allocEntityId = () => this.nextEntityId++;
    for (const r of this.crafting.smelting) this.smeltingByInput.set(r.input, r);
    // 存档要能带上生物与箭。ServerWorld 不认识 MobManager，所以走钩子
    this.world.mobsInChunk = (cx, cz) => this.mobs.inChunk(cx, cz);
    this.world.arrowsInChunk = (cx, cz) => {
      const out: Arrow[] = [];
      for (const a of this.arrows.values()) {
        if ((Math.floor(a.x) >> 4) === cx && (Math.floor(a.z) >> 4) === cz) out.push(a);
      }
      return out;
    };
    this.world.installLoadedMobs = (mobs, arrows) => {
      for (const m of mobs) this.mobs.adopt(m);
      for (const a of arrows) this.arrows.set(a.entityId, a);
    };
  }

  get tickNumber(): number {
    return this.tickCount;
  }

  /**
   * 熔炼配方按输入物品建的索引。
   *
   * 建成 Map 而不是每次线性扫 12 条：每个熔炉每刻都要问一次
   * "手上这个能烧吗"，而世界里的熔炉数量没有上限。
   */
  private readonly smeltingByInput = new Map<number, SmeltingRecipe>();

  smeltingOf(id: number): SmeltingRecipe | null {
    return this.smeltingByInput.get(id) ?? null;
  }

  /**
   * 某个方块实体的内容变了：正开着它的玩家要收到新内容。
   *
   * 熔炉每刻都会动（燃烧时间在减），所以这个函数每刻都会被调 ——
   * 但只有真的开着那个熔炉的玩家才会收到包，没人看的熔炉一个字节都不发。
   */
  markBlockEntityDirty(entity: BlockEntity): void {
    const furnace = entity instanceof FurnaceEntity ? entity : null;
    for (const player of this.players.values()) {
      if (player.openBlockEntity !== entity || player.openWindow === null) continue;
      // 只有格子里的东西真的动了才重发整份内容。烧着的熔炉每刻都在变，
      // 但变的多半只是计时器，那由下面那个 6 字节的小包负责
      if (furnace === null || furnace.contentsChanged) {
        player.openWindow.pullFromPlayer();
        syncInventory(this, player);
      }
      if (furnace !== null) {
        player.channel.send(S_WindowProgress, {
          windowId: player.windowId,
          burnTime: furnace.burnTime,
          burnTotal: furnace.burnTotal,
          cookTime: furnace.cookTime,
        });
      }
    }
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
    for (const player of this.players.values()) advanceDigging(this, player);

    // 区块流水线：先生成，再算光照，最后才推送。
    // 顺序不能颠倒 —— 先推送的话客户端拿到的是光照全 0 的区块。
    const prepared: { player: ServerPlayer; keys: number[] }[] = [];
    for (const player of this.players.values()) {
      player.updateSubscriptions(this.world);
      const keys = player.prepareChunks(this.world);
      if (keys.length > 0) prepared.push({ player, keys });
    }

    // 方块实体（熔炉）。排在挖掘之后、光照之前：熔炉点火会换方块 id，
    // 那是一次真正的方块变更，得赶上这一刻的光照与广播
    tickBlockEntities(this);

    // 掉落物：物理、合并、拾取
    tickItems(this);

    // 生物：AI、物理、生成、同步
    this.mobs.tick();
    tickArrows(this);

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

    // 掉落物的出生 / 移动 / 销毁
    broadcastItems(this, this.world.drainUnloadedItems());

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
      case 'C_PlayerAction': return onPlayerAction(this, player, value);
      case 'C_UseBlock': return onUseBlock(this, player, value);
      case 'C_AttackEntity': return onAttackEntity(this, player, value);
      case 'C_WindowClick': return onWindowClick(this, player, value);
      case 'C_CloseWindow': return closeWindow(this, player);
      case 'C_HeldSlot': {
        player.inventory.selectedHotbar = Math.max(0, Math.min(8, value['slot'] as number));
        return;
      }
      case 'C_SetViewDistance': {
        const d = value['distance'] as number;
        player.viewDistance = Math.max(2, Math.min(16, d));
        player.resetSubscriptions();
        return;
      }
      case 'C_Command': return handleCommand(this, player, value);
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

    if (this.spawnY < 0) this.computeSpawn();
    player.x = this.spawnX;
    player.y = this.spawnY;
    player.z = this.spawnZ;
    // 存档里有这个玩家的话，位置与物品栏在这里被覆盖掉
    this.onPlayerReady?.(player);

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
  reachSq(player: ServerPlayer, x: number, y: number, z: number): number {
    const dx = player.x - (x + 0.5);
    const dy = player.y + EYE_HEIGHT - (y + 0.5);
    const dz = player.z - (z + 0.5);
    return dx * dx + dy * dy + dz * dz;
  }

  /**
   * 定出生点。
   *
   * findSpawn 只看得到**装饰前**的地形阶段，所以它可能把人放在一棵树的树干里。
   * 这里用完整生成的区块再校正一次：向上找到第一处有两格空隙的位置。
   */
  private computeSpawn(): void {
    const spawn = this.world.generator.findSpawn();
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
    this.spawnX = spawn.x;
    this.spawnY = sy;
    this.spawnZ = spawn.z;
  }

  sendChat(player: ServerPlayer, text: string): void {
    player.channel.send(S_Chat, { text });
  }

  playerById(id: number): ServerPlayer | undefined {
    return this.players.get(id);
  }

  // --- 战斗的薄转发。实现在 entity/combat.ts，这里只是让调用方
  //     （生物 AI、指令、测试）不必认识那个模块 ---

  /** 炸一下。苦力怕与（M11 的）TNT 共用 */
  explode(x: number, y: number, z: number, power: number, sourceId = -1): void {
    explodeAt(this, x, y, z, power, sourceId);
  }

  /** 骷髅放箭 */
  shootArrow(mob: Mob, target: TargetRef): void {
    shootArrow(this, mob, target);
  }

  /** 玩家掉血 */
  damagePlayer(player: ServerPlayer, amount: number, fromX: number, fromZ: number): void {
    damagePlayer(this, player, amount, fromX, fromZ);
  }

}
