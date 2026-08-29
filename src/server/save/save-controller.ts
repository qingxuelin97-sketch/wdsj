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
  private pendingPlayer: PlayerSaveData | null = null;
  /** 已经有一次存盘在进行中。存档比 tick 慢得多，不能让它们叠起来 */
  private saving = false;
  autosaveInterval = AUTOSAVE_INTERVAL_TICKS;

  constructor(core: ServerCore, save: WorldSave) {
    this.core = core;
    this.save = save;
    core.world.save = save;
  }

  /** 把存档整个删掉 */
  async wipe(): Promise<boolean> {
    await this.save.wipe();
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
      const chunks = saveAllChunks(this.core.world);
      for (const player of this.core.eachPlayer()) {
        await this.save.writePlayer(snapshotPlayer(player));
        break; // 单人：只有一个玩家。多人存档在 M17
      }
      await this.save.writeLevel({
        seed: this.core.world.seed,
        worldAge: this.core.world.worldAge,
        timeOfDay: this.core.world.timeOfDay,
        spawnX: Math.floor(this.core.spawnX),
        spawnY: Math.floor(this.core.spawnY),
        spawnZ: Math.floor(this.core.spawnZ),
      });
      const regions = await this.save.flush();
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
    this.core.spawnX = level.spawnX;
    this.core.spawnY = level.spawnY;
    this.core.spawnZ = level.spawnZ;
    this.lastSaveTick = this.core.tickNumber;

    // 出生点周围 3×3 个区块可能跨 region，各预载一次（同一个 region 只会读一遍）
    await this.preloadAround(level.spawnX, level.spawnZ);

    // 玩家数据也在这里读：它决定玩家会出现在哪，那一片同样要先备好
    this.pendingPlayer = await this.save.readPlayer(PERSISTENT_SLOTS);
    if (this.pendingPlayer !== null) {
      await this.preloadAround(this.pendingPlayer.x, this.pendingPlayer.z);
    }
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
    const data = this.pendingPlayer;
    if (data === null) return false;
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

function snapshotPlayer(player: ServerPlayer): PlayerSaveData {
  return {
    x: player.x, y: player.y, z: player.z,
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
