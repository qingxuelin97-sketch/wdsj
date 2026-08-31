/**
 * 存档的调度：什么时候存、存哪些、读档时按什么顺序装回去。
 *
 * 单独一个文件而不是塞进 ServerCore，有一条硬性理由：**存档是异步的，
 * 而 ServerCore.tick() 全程同步**。把 await 放进 ServerCore 会毁掉
 * "node --test 里手动 tick 两万次"这个能力，而那是整个验证体系的地基。
 *
 * 所以分工是：ServerCore 只管把世界推进到某个状态；这里在**两次 tick 之间**
 * 把那个状态搬到盘上。JS 单线程保证了这中间没人能改世界。
 */
import type { ServerCore } from '../server-core.ts';
import type { ServerPlayer } from '../player/server-player.ts';
import { WorldSave, type PlayerSaveData } from './world-save.ts';
import type { SaveStorage } from '../../platform/storage.ts';
import { isDimension } from '../../core/world/dimension.ts';
import { saveAllChunks } from '../world/world-persistence.ts';
import { PERSISTENT_SLOTS } from '../player/player-inventory.ts';
import { copyStack } from '../../core/item/item-def.ts';
import { syncInventory } from '../player/inventory-actions.ts';
import { TPS, MAX_HEALTH } from '../../core/constants.ts';

/** 默认多久自动存一次：30 秒。MC 是 45 秒 */
export const AUTOSAVE_INTERVAL_TICKS = TPS * 30;

export interface SaveReport {
  chunks: number;
  regions: number;
}

export class SaveController {
  readonly save: WorldSave;
  private readonly core: ServerCore;
  /** 上一次存盘时的 tick */
  private lastSaveTick = 0;
  /**
   * loadLevel 时读出来的玩家数据，等玩家登录时套上去。
   *
   * 提前读而不是等登录再读，是为了让 restorePlayer 变成**同步**的：
   * 登录处理是同步的，异步套用会让玩家先在出生点出现、过几帧再被拉到
   * 存档里的位置 —— 那一下位移在客户端看来和被服务端"纠正"没有区别。
   */
  private readonly pendingPlayers = new Map<string, PlayerSaveData>();
  /**
   * 老的单人存档（player.dat）。
   *
   * 名字对不上也认：那个年代根本没记名字。第一个登录的人把它领走，
   * 之后按新格式（players/<名字>.dat）写回去。
   * 不认的话，所有单人老存档一升级就"背包空了、人回出生点了"
   */
  private legacyPlayer: PlayerSaveData | null = null;
  /** 已经有一次存盘在进行中。存档比 tick 慢得多，不能让它们叠起来 */
  private saving = false;
  autosaveInterval = AUTOSAVE_INTERVAL_TICKS;

  /**
   * 每个维度一份 WorldSave，共用同一个 storage。
   *
   * 不能三个维度共用一份：region 的键里带着维度前缀，而内存里的 region
   * 缓存是按键索引的 —— 共用一份只是把三份缓存挤在一个 Map 里，
   * 除了让 flush 变慢没有任何好处，还会让"这份存档管哪个维度"变得不明确。
   */
  private readonly dimSaves = new Map<number, WorldSave>();
  private readonly storage: SaveStorage;

  constructor(core: ServerCore, save: WorldSave, storage?: SaveStorage) {
    this.core = core;
    this.save = save;
    core.world.save = save;
    this.dimSaves.set(core.world.dimension, save);
    // storage 缺省时从主世界那份借 —— 它自己就拿着一个
    this.storage = storage ?? save.storageRef;

    // 下界与末地是玩家跳进传送门的那一刻才存在的，那时候 SaveController
    // 早就构造完了。所以存档要在世界诞生的回调里补挂，而不是在这里遍历。
    //
    // 挂晚一刻的代价是实打实的：世界一旦先跑起来，生成器会把区块填好，
    // 之后到货的存档再也盖不回去（ServerWorld.forcedOverPendingSave 记的就是这个）
    const prev = core.onWorldCreated;
    core.onWorldCreated = (w) => {
      w.save = this.saveFor(w.dimension);
      prev?.(w);
    };
  }

  /** 某个维度的存档，没有就现建 */
  private saveFor(dimension: number): WorldSave {
    const existing = this.dimSaves.get(dimension);
    if (existing !== undefined) return existing;
    const s = new WorldSave(this.storage, dimension);
    this.dimSaves.set(dimension, s);
    return s;
  }

  /** 把存档整个删掉 */
  async wipe(): Promise<boolean> {
    // 主世界那份的 wipe 会把整个 storage 清空（它是按前缀 '' 列的），
    // 所以其余维度只需要把内存里的 region 缓存丢掉，别再把它们写回去
    await this.save.wipe();
    for (const [dim, s] of this.dimSaves) if (dim !== this.core.world.dimension) s.forget();
    return true;
  }

  /** 该自动存盘了吗。宿主每 tick 问一次 */
  isAutosaveDue(): boolean {
    return !this.saving && this.core.tickNumber - this.lastSaveTick >= this.autosaveInterval;
  }

  /**
   * 存下整个世界：区块 + 玩家 + level.dat，然后落盘。
   *
   * 顺序是"先把内存里的 region 攒齐，最后统一 flush" —— 每个区块各写一次盘的话，
   * 400 个区块就是 400 次 OPFS 往返，那是两秒预算里最贵的一项。
   */
  async saveNow(): Promise<SaveReport> {
    if (this.saving) return { chunks: 0, regions: 0 };
    this.saving = true;
    try {
      // 所有**已经存在**的维度都要存。只存主世界的话，玩家在下界盖的东西
      // 会在下一次读档时被地形生成顶掉 —— 而且悄无声息，因为地形本身
      // 是按同一个种子重新长出来的，看着"还在那儿"，只是房子没了
      let chunks = 0;
      for (const w of this.core.loadedWorlds()) chunks += saveAllChunks(w);
      // 每个在线玩家各写各的。以前这里 break 掉只存第一个 ——
      // 多人时其余玩家的进度全丢，而且更糟：读档时**所有人**都会被套上
      // 那一份数据，等于每来一个人就把同一份背包复制一遍
      for (const player of this.core.eachPlayer()) {
        await this.save.writePlayer(player.name, snapshotPlayer(player));
      }
      await this.save.writeLevel({
        seed: this.core.world.seed,
        worldAge: this.core.world.worldAge,
        timeOfDay: this.core.world.timeOfDay,
        spawnX: Math.floor(this.core.spawnX),
        spawnY: Math.floor(this.core.spawnY),
        spawnZ: Math.floor(this.core.spawnZ),
        raining: this.core.world.weather.raining,
        thundering: this.core.world.weather.thundering,
        rainTime: this.core.world.weather.rainTime,
        thunderTime: this.core.world.weather.thunderTime,
        dragonDefeated: this.core.dragonFight.finished,
      });
      let regions = 0;
      for (const s of this.dimSaves.values()) regions += await s.flush();
      this.lastSaveTick = this.core.tickNumber;
      return { chunks, regions };
    } finally {
      this.saving = false;
    }
  }

  /**
   * 读档时把世界级状态装回去（时间、出生点），并把出生点那一片 region 备好。
   *
   * **这一步必须在放客户端进来之前完成。** 玩家登录时会强制生成出生区块，
   * 而那条路径是同步的、等不了异步的 region —— 于是没预载的话，
   * 出生点周围的存档内容会被新生成的地形永久顶掉，
   * 而症状只是"重进游戏发现出生点旁边盖的东西没了"。
   * ServerWorld.forcedOverPendingSave 会把这种情况记下来。
   *
   * 区块不在这里读 —— 出生点以外的由 ensureChunk 按需从 region 里取。
   * @returns 有没有读到存档
   */
  async loadLevel(): Promise<boolean> {
    const level = await this.save.readLevel();
    if (level === null) return false;
    this.core.world.worldAge = level.worldAge;
    this.core.world.timeOfDay = level.timeOfDay;
    const w = this.core.world.weather;
    w.raining = level.raining;
    w.thundering = level.thundering;
    w.rainTime = level.rainTime;
    w.thunderTime = level.thunderTime;
    // 强度**不**存盘，读档时直接拉到位。存了也没用：它是 raining 的
    // 确定性函数，而"读档时看着雨慢慢淡进来"比直接下着更奇怪 ——
    // 玩家关游戏时正在下大雨，回来该还是大雨
    w.snapStrength();
    // 龙打过了就别再摆一次。不还原的话每次读档龙都原地复活，
    // 而它死一次给一颗龙蛋和 12000 点经验 —— "退出重进再下末地"
    // 就成了一台无限刷经验机
    if (level.dragonDefeated) {
      this.core.dragonFight.finished = true;
      this.core.dragonFight.spawned = true;
    }
    this.core.spawnX = level.spawnX;
    this.core.spawnY = level.spawnY;
    this.core.spawnZ = level.spawnZ;
    this.lastSaveTick = this.core.tickNumber;

    // 出生点周围 3×3 个区块可能跨 region，各预载一次（同一个 region 只会读一遍）
    await this.preloadAround(level.spawnX, level.spawnZ);

    // 玩家数据也在这里读：它决定玩家会出现在哪，那一片同样要先备好。
    //
    // **一次把所有人的都读完**，而不是等谁登录再读谁的 —— restorePlayer
    // 必须是同步的（登录处理是同步的，异步套用会让玩家先在出生点出现、
    // 过几帧再被拽走，看起来和被服务端纠正没区别）
    for (const key of await this.save.listPlayerKeys()) {
      const data = await this.save.readPlayerAt(key, PERSISTENT_SLOTS);
      if (data === null) continue;
      this.pendingPlayers.set(nameFromKey(key), data);
      await this.preloadAround(data.x, data.z);
    }
    this.legacyPlayer = await this.save.readLegacyPlayer(PERSISTENT_SLOTS);
    if (this.legacyPlayer !== null) await this.preloadAround(this.legacyPlayer.x, this.legacyPlayer.z);
    return true;
  }

  /** 把某个坐标周围 3×3 区块所属的 region 都读进内存 */
  private async preloadAround(x: number, z: number): Promise<void> {
    const cx = Math.floor(x) >> 4;
    const cz = Math.floor(z) >> 4;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) await this.save.loadRegion(cx + dx, cz + dz);
    }
  }

  /**
   * 把存档里的玩家数据套到刚登录的玩家身上。没存过返回 false。
   *
   * 同步，因为数据在 loadLevel 里就已经读好了（连同它所在的 region）。
   * 这让它可以直接挂在登录处理里，玩家一次到位地出现在存档里的位置。
   */
  restorePlayer(player: ServerPlayer): boolean {
    // 先按名字找；找不到再看有没有一份没人领的老单人存档
    let data = this.pendingPlayers.get(player.name) ?? null;
    if (data === null && this.legacyPlayer !== null) {
      data = this.legacyPlayer;
      this.legacyPlayer = null; // 只给第一个人
    }
    if (data === null) return false;
    // 维度要**先于**坐标设好：worldOf 会把那个维度的世界建出来（连同存档），
    // 而下面的 resetSubscriptions 是按玩家所在的世界算的。
    //
    // isDimension 这一道不是形式主义：读的是盘上的字节，
    // 一个改坏的 Dimension 会让 worldOf 拿到 undefined 的定义并当场炸掉登录
    if (isDimension(data.dimension)) {
      player.dimension = data.dimension;
      if (data.dimension !== this.core.world.dimension) this.core.worldOf(data.dimension);
    }
    player.x = data.x;
    player.y = data.y;
    player.z = data.z;
    player.yaw = data.yaw;
    player.pitch = data.pitch;
    player.inventory.selectedHotbar = Math.max(0, Math.min(8, data.selectedHotbar));
    for (let i = 0; i < PERSISTENT_SLOTS; i++) {
      copyStack(data.slots[i]!, player.inventory.slots[i]!);
    }
    // 生存状态：血量为 0 的存档（存盘时正好死着）按满血读回，
    // 否则玩家一进游戏就卡在死亡界面里
    player.vitals.health = data.health > 0 ? data.health : MAX_HEALTH;
    player.vitals.hunger = data.hunger;
    player.vitals.saturation = data.saturation;
    player.vitals.air = data.air;
    player.xp.level = data.xpLevel;
    player.xp.progress = data.xpProgress;
    player.xp.total = data.xpTotal;
    // 订阅集是按坐标算的，位置换了就得重算，否则会先推一批出生点附近的区块
    player.resetSubscriptions();
    syncInventory(this.core, player);
    return true;
  }
}

/** players/<转义过的名字>.dat -> 名字 */
function nameFromKey(key: string): string {
  const base = key.slice(key.lastIndexOf('/') + 1).replace(/\.dat$/, '');
  try {
    return decodeURIComponent(base);
  } catch {
    // 名字里有裸的 % 时 decodeURIComponent 会抛。原样用，
    // 大不了这个人这次读不到自己的档，总好过整个 loadLevel 挂掉
    return base;
  }
}

function snapshotPlayer(player: ServerPlayer): PlayerSaveData {
  return {
    x: player.x, y: player.y, z: player.z,
    dimension: player.dimension,
    yaw: player.yaw, pitch: player.pitch,
    selectedHotbar: player.inventory.selectedHotbar,
    slots: player.inventory.slots,
    health: player.vitals.health,
    hunger: player.vitals.hunger,
    saturation: player.vitals.saturation,
    air: player.vitals.air,
    xpLevel: player.xp.level,
    xpProgress: player.xp.progress,
    xpTotal: player.xp.total,
  };
}
