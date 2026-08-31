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
  C2S, PROTOCOL_VERSION, 
  S_Login, S_Disconnect, S_Chat, S_Weather,
  S_WindowProgress,
} from '../core/net/packets.ts';
import { ServerWorld } from './world/server-world.ts';
import { Dimension, type DimensionId } from '../core/world/dimension.ts';
import { NetherGenerator } from './world/gen/nether-gen.ts';
import { EndGenerator } from './world/gen/end-gen.ts';
import { OverworldGenerator } from './world/gen/overworld-gen.ts';
import { handleCommand } from './commands.ts';
import {
  syncInventory,
  onWindowClick, closeWindow,
} from './player/inventory-actions.ts';
import { EnchantingEntity, BrewingEntity } from './world/block-entity-craft.ts';
import { DragonFight } from './entity/dragon.ts';
import { forgetPlayer } from './player/player-sync.ts';
import { refreshOffers, sendOffers, selectEnchantment } from './player/enchant-actions.ts';
import { ServerPlayer } from './player/server-player.ts';
import type { BlockRegistry } from '../core/registry/block-registry.ts';
import { AIR_STATE } from '../core/world/chunk.ts';
import { createItemRegistry, type ItemRegistry } from '../content/items.ts';
import { createCraftingData, type SmeltingRecipe, type CraftingData } from '../content/recipes.ts';
import { runServerTick } from './server-tick.ts';
import { onPlayerAction, onUseBlock } from './player/block-interaction.ts';
import {
  onAttackEntity, shootArrow, explodeAt, damagePlayer,
  armorPointsOf, respawnPlayer,
} from './entity/combat.ts';
import { DamageKind, fallDamage, type VitalsContext } from './player/player-vitals.ts';
import { FurnaceEntity, type BlockEntity } from './world/block-entity.ts';
import { MobManager } from './entity/mob-manager.ts';
import { type ArrowEntity as Arrow } from './entity/arrow.ts';
import type { Mob } from './entity/mob.ts';
import type { TargetRef } from './entity/goal.ts';
import { TPS, EYE_HEIGHT, EXHAUSTION } from '../core/constants.ts';

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
  /**
   * 主世界。**保留这个名字**是刻意的：加维度之前有一百多处写着
   * `core.world`，其中绝大多数（红石、流体、熔炉、合成）在任何维度里
   * 逻辑都一样，改成 `worldOf(player.dimension)` 只会平添噪声。
   *
   * 真正需要区分维度的是"某个玩家/实体所在的那个世界"，那些地方走
   * `player.world` 或 `worldOf()`。
   */
  readonly world: ServerWorld;
  /**
   * 三个维度的世界，按需创建。
   *
   * 懒创建不是为了省内存，是为了**别让四百个单元测试都去搭下界**：
   * 每个 ServerWorld 都要建噪声表和光照引擎，而绝大多数测试根本不去下界。
   */
  private readonly dimWorlds = new Map<DimensionId, ServerWorld>();
  readonly items: ItemRegistry = createItemRegistry();
  readonly crafting: CraftingData = createCraftingData();
  readonly registry: BlockRegistry;
  /** 生物：生成、AI、同步 */
  readonly mobs: MobManager;
  /** 飞在空中的箭 */
  readonly arrows = new Map<number, Arrow>();
  /**
   * 末影龙战的状态。
   *
   * 挂在 core 上而不是龙身上：龙死了之后还要放出口传送门、龙蛋与经验，
   * 那些事发生在"龙已经不存在"之后。而且它要跨存档保留 ——
   * 一个已经通关的世界不该在下次进末地时又长出一条龙。
   */
  readonly dragonFight = new DragonFight();
  private readonly players = new Map<number, ServerPlayer>();

  /**
   * 遍历在线玩家。
   *
   * 只读地暴露 players —— 拿不到 Map 本身，所以外面加不了也删不掉玩家。
   * 玩家的增删只有 onConnect / onDisconnect 两个入口，这是刻意的：
   * tick 中途少一个玩家会让"先算再广播"的两段式代码读到不一致的状态。
   */
  eachPlayer(): Iterable<ServerPlayer> {
    return this.players.values();
  }
  private nextEntityId = 1;
  /** 已经跑过的 tick 数。宿主要把它写进共享统计槽，所以是公开的 */
  tickCount = 0;
  readonly timeSyncInterval: number;
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
   * 随机刻的开关。
   *
   * 截图回归必须关掉。开着的时候世界**永远不会静止**：两百个区块里
   * 总有草在蔓延、树苗在长大，每一次都会把所在的子区块标脏。
   * 于是客户端的网格化队列永远清不空，`waitForIdle` 等到超时也等不到安定 ——
   * 而失败信息只会说"10 段待网格化"，看上去像网格化卡住了。
   *
   * 这不是 bug：真实的 MC 世界也一直在自己变。要的是一个**冻结的**世界
   * 来做逐像素比对，就像 persist=0 与 mobs=0 那样。
   */
  randomTicks = true;

  /**
   * 上一次广播出去的天气，量化到 0..100。
   *
   * 只为了"变了才发"这一个判断而存在。放在 core 上而不是 server-tick 的
   * 模块级变量里：模块级变量会被同进程里的第二个 ServerCore 共用，
   * 而单测经常同时开两个（存档那组测试就是靠两个 core 才能证明
   * 数据真的落盘了）
   */
  lastSentRain = -1;
  lastSentThunder = -1;

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
    this.world = new ServerWorld(BigInt(opts.seed), opts.registry,
      new OverworldGenerator(BigInt(opts.seed), opts.registry), Dimension.OVERWORLD);
    this.dimWorlds.set(Dimension.OVERWORLD, this.world);
    this.mobs = new MobManager(this);
    // vitalsCtx 在字段初始化时建，那时 this.world 还没赋值，所以补一刀
    (this.vitalsCtx as { world: ServerWorld }).world = this.world;
    this.timeSyncInterval = opts.timeSyncInterval ?? TPS;
    // 掉落物与玩家共用一个 id 空间：两边各发一号会让客户端把一个掉落物
    // 当成某个玩家的更新，而那种错乱看起来完全不像同步问题
    this.wireWorld(this.world);
    for (const r of this.crafting.smelting) this.smeltingByInput.set(r.input, r);
  }

  /**
   * 把一个新世界接到 core 上。三个维度共用同一份实体 id 空间与
   * 同一个 MobManager —— 分开的话，一个实体跨维度时 id 会变，
   * 而客户端只按 id 认实体，看起来就是"旧的没消失、新的又出现了"。
   */
  private wireWorld(w: ServerWorld): void {
    // 掉落物与玩家共用一个 id 空间：两边各发一号会让客户端把一个掉落物
    // 当成某个玩家的更新，而那种错乱看起来完全不像同步问题
    w.allocEntityId = () => this.nextEntityId++;
    // 存档要能带上生物与箭。ServerWorld 不认识 MobManager，所以走钩子
    w.mobsInChunk = (cx, cz) => this.mobs.inChunk(cx, cz, w.dimension);
    w.arrowsInChunk = (cx, cz) => {
      const out: Arrow[] = [];
      for (const a of this.arrows.values()) {
        if (a.dimension !== w.dimension) continue;
        if ((Math.floor(a.x) >> 4) === cx && (Math.floor(a.z) >> 4) === cz) out.push(a);
      }
      return out;
    };
    w.installLoadedMobs = (mobs, arrows) => {
      for (const m of mobs) this.mobs.adopt(m);
      for (const a of arrows) this.arrows.set(a.entityId, a);
    };
  }

  /**
   * 取某个维度的世界，没有就现建一个。
   *
   * 建出来的世界**不带存档** —— 存档由 save-controller 在 attach 时统一挂，
   * 这里挂的话会出现"下界先跑起来、存档后到"，中间生成的区块就把
   * 存档里的内容顶掉了（ServerWorld.forcedOverPendingSave 记的就是这种事）。
   */
  worldOf(dimension: DimensionId): ServerWorld {
    const existing = this.dimWorlds.get(dimension);
    if (existing !== undefined) return existing;
    const seed = this.world.seed;
    // 下界与末地用**同一个世界种子**，与 MC 一致 —— 三个维度是一个存档
    const gen = dimension === Dimension.NETHER
      ? new NetherGenerator(seed, this.registry)
      : new EndGenerator(seed, this.registry);
    const w = new ServerWorld(seed, this.registry, gen, dimension);
    this.wireWorld(w);
    this.dimWorlds.set(dimension, w);
    this.onWorldCreated?.(w);
    return w;
  }

  /**
   * 新世界被创建时的回调。宿主（save-controller、gen worker 池）用它
   * 给下界/末地补上存档与区块来源 —— 那两样都是在 ServerCore 之外挂的，
   * 而维度是玩家跳进传送门的那一刻才出现的。
   */
  onWorldCreated: ((w: ServerWorld) => void) | null = null;

  /** 已经存在的所有世界。没去过的维度不在里面 */
  loadedWorlds(): Iterable<ServerWorld> {
    return this.dimWorlds.values();
  }

  get tickNumber(): number {
    return this.tickCount;
  }

  /** 生存循环要用到的回调。建一次复用，别每刻每人各建一个对象 */
  readonly vitalsCtx: VitalsContext = {
    world: null as unknown as ServerWorld,
    armorPoints: (p) => armorPointsOf(this, p),
    hurt: (p, amount, kind) => { damagePlayer(this, p, amount, p.x, p.z, kind); },
  };

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
      } else if (entity instanceof BrewingEntity) {
        // 酿造台借 cookTime 那一格发倒计时。它不烧煤，
        // burnTime/burnTotal 在这个窗口里没有意义，一律 0
        player.channel.send(S_WindowProgress, {
          windowId: player.windowId,
          burnTime: 0, burnTotal: 0, cookTime: entity.brewTime,
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
    // 认识他的人要收到销毁包。不发的话，别人屏幕上会留下一具
    // 站着不动的躯壳，而且永远不会消失
    forgetPlayer(this, player);
  }

  /**
   * 推进一个 tick。宿主每 50ms 调一次。
   *
   * 具体做什么、按什么顺序，在 server/server-tick.ts 里 —— 那个顺序
   * 本身就是一份文档，值得单独一个文件放。
   */
  tick(): void {
    runServerTick(this);
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
      case 'C_WindowClick': {
        onWindowClick(this, player, value);
        // 附魔台上的东西可能被换掉了 —— 换了就要重新报价，
        // 不然玩家会拿旧装备的报价给新装备附魔
        const e = player.openBlockEntity;
        if (e instanceof EnchantingEntity) {
          refreshOffers(this, this.worldOf(player.dimension), e);
          sendOffers(player, e);
        }
        return;
      }
      case 'C_EnchantSelect':
        selectEnchantment(this, player, value['slot'] as number);
        return;
      case 'C_CloseWindow': return closeWindow(this, player);
      case 'C_Respawn': {
        if (player.awaitingRespawn) respawnPlayer(this, player);
        return;
      }
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
    // 天气只在变化时广播，所以新玩家要单独补一份 ——
    // 否则进游戏时正在下的雨，要等到它停了才看得见
    const w = this.world.weather.snapshot();
    player.channel.send(S_Weather, {
      rain: Math.round(w.rainStrength * 100),
      thunder: Math.round(w.thunderStrength * 100),
    });
    // 立刻算一次订阅，让第一批区块在本 tick 就开始推送
    player.updateSubscriptions(this.world);
    player.channel.flush();
  }

  private onPlayerMove(player: ServerPlayer, value: Record<string, unknown>): void {
    // 位置仍然信任客户端（服务端物理与和解在 M17 的多人里才有意义）。
    // 但**摔落伤害由服务端判**：客户端只报"我在哪、我落地了没"，
    // 落差与伤害在这里算 —— 否则改一行前端就能从任意高度跳下来不掉血。
    const prevOnGround = player.onGround;
    player.lastSeq = value['seq'] as number;
    const newY = value['y'] as number;
    player.x = value['x'] as number;
    player.y = newY;
    player.z = value['z'] as number;
    player.yaw = value['yaw'] as number;
    player.pitch = value['pitch'] as number;
    player.onGround = value['onGround'] as boolean;

    if (player.vitals.dead) return;
    if (player.onGround) {
      if (!prevOnGround) {
        const damage = fallDamage(player.peakY - newY);
        if (damage > 0) damagePlayer(this, player, damage, player.x, player.z, DamageKind.FALL);
      }
      player.peakY = newY;
    } else if (newY > player.peakY) {
      player.peakY = newY;
    }

    // 走路与疾跑消耗体力。用**实际位移**而不是"有没有按键"：
    // 撞着墙原地跑不该消耗，而按键状态看不出这一点
    const moved = Math.hypot(player.x - player.lastX, player.z - player.lastZ);
    if (moved > 0 && player.onGround) {
      const sprinting = value['sprinting'] === true;
      player.vitals.addExhaustion(moved * (sprinting ? EXHAUSTION.sprintPerMeter : 0.01));
    }
    player.lastX = player.x;
    player.lastZ = player.z;
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

  /**
   * 发给**所有人**。加入/离开、聊天、龙被击败都走它。
   *
   * 与 sendChat 分开而不是加一个布尔参数：单人时 sendChat 是最常见的
   * 用法（"你死了"只该自己看见），而广播是明确的另一件事 ——
   * 传错布尔值的后果是所有人都看到别人的死亡提示。
   */
  broadcastChat(text: string): void {
    for (const p of this.players.values()) p.channel.send(S_Chat, { text });
  }

  playerById(id: number): ServerPlayer | undefined {
    return this.players.get(id);
  }

  // --- 战斗的薄转发。实现在 entity/combat.ts，这里只是让调用方
  //     （生物 AI、指令、测试）不必认识那个模块 ---

  /** 炸一下。苦力怕与（M11 的）TNT 共用 */
  explode(x: number, y: number, z: number, power: number, sourceId = -1, world = this.world): void {
    explodeAt(this, x, y, z, power, sourceId, world);
  }

  /**
   * 把 vitalsCtx 指向某个世界。
   *
   * vitalsCtx 是**复用**的（每刻每人各建一个对象太浪费），所以它
   * 必须在每个玩家的生存循环之前被指到那个玩家所在的世界。
   * 这是共享可变对象的代价，换来的是每刻少建几十个闭包。
   */
  setVitalsWorld(w: ServerWorld): void {
    (this.vitalsCtx as { world: ServerWorld }).world = w;
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
