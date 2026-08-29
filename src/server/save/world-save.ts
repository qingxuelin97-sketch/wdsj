/**
 * 存档：region 缓存、区块读写、level.dat 与玩家数据。
 *
 * 关键设计：**存储是异步的，但区块的读取路径是同步的。**
 *
 * ServerCore.tick() 全程同步（这是它能被 `node --test` 直接驱动两万次的原因，
 * 见 docs/DESIGN.md），所以不能在 tick 里 await。做法和 gen worker 一样 ——
 * 先"下单"（把整份 region 异步读进内存），货到之前 ensureChunk 返回 null，
 * 到了之后 readChunk 就是纯内存操作。
 *
 * 整份 region 常驻内存是可以接受的：一个 region 覆盖 32×32 个区块，
 * RLE 之后一个地表区块约 3-6 KB，满员也就 5 MB 左右，而同时会被碰到的
 * region 通常只有 1-4 个。
 */
import { RegionFile, regionKeyOf } from './region-file.ts';
import { encodeChunkNbt, decodeChunkNbt, type ChunkSaveData, type ChunkLoadResult } from './chunk-nbt.ts';
import type { SaveStorage } from '../../platform/storage.ts';
import {
  nbt, encodeNbt, decodeNbt, getInt, getLong, getList, getCompound, TagType,
  type NbtValue,
} from '../../core/nbt/nbt.ts';
import { emptyStack, type ItemStack } from '../../core/item/item-def.ts';
import { stacksToNbt, nbtToStacks } from '../world/block-entity.ts';

/** 存档格式版本。布局一改就 +1 */
export const SAVE_VERSION = 1;

export const LEVEL_KEY = 'level.dat';
const PLAYER_KEY = 'player.dat';

/** level.dat 里的东西 */
export interface LevelData {
  seed: bigint;
  worldAge: number;
  timeOfDay: number;
  spawnX: number;
  spawnY: number;
  spawnZ: number;
}

/** player.dat 里的东西 */
export interface PlayerSaveData {
  x: number; y: number; z: number;
  yaw: number; pitch: number;
  selectedHotbar: number;
  slots: ItemStack[];
  /** 生存状态。存下来才能做到"退出重进不回满血" */
  health: number;
  hunger: number;
  saturation: number;
  air: number;
  xpLevel: number;
  xpProgress: number;
  xpTotal: number;
}

export class WorldSave {
  private readonly storage: SaveStorage;
  private readonly regions = new Map<string, RegionFile>();
  /** 正在读的 region，避免同一个 region 被下重复的单 */
  private readonly loading = new Set<string>();
  /** 读盘失败的 region：当作空的，不要每 tick 重试 */
  private readonly failed = new Set<string>();

  constructor(storage: SaveStorage) {
    this.storage = storage;
  }

  // --- region 生命周期 ---

  /** 某个区块所属的 region 已经在内存里了吗 */
  isRegionReady(cx: number, cz: number): boolean {
    const key = regionKeyOf(cx, cz);
    return this.regions.has(key) || this.failed.has(key);
  }

  /**
   * 把某个区块所属的 region 读进内存。已经在读或已经在了就什么都不做。
   * 不返回 Promise —— 调用方在 tick 里，不该 await 任何东西。
   */
  requestRegion(cx: number, cz: number): void {
    const key = regionKeyOf(cx, cz);
    if (this.regions.has(key) || this.loading.has(key) || this.failed.has(key)) return;
    this.loading.add(key);
    void this.storage.read(key).then(
      (bytes) => {
        // 读的过程中可能已经有别的路径建了同一个 region（比如先存后读），
        // 那份是新的，不要覆盖
        if (!this.regions.has(key)) {
          this.regions.set(key, bytes === null ? new RegionFile() : RegionFile.parse(bytes));
        }
        this.loading.delete(key);
      },
      () => {
        this.loading.delete(key);
        this.failed.add(key);
      },
    );
  }

  /**
   * 把某个 region 读进内存并等它到位。
   *
   * 与 requestRegion 的区别只是"能不能 await"。宿主在**放客户端进来之前**
   * 用这个把出生点那一片先备好 —— 见 save-controller.ts 里那条不变式。
   */
  async loadRegion(cx: number, cz: number): Promise<void> {
    if (this.isRegionReady(cx, cz)) return;
    const key = regionKeyOf(cx, cz);
    try {
      const bytes = await this.storage.read(key);
      if (!this.regions.has(key)) {
        this.regions.set(key, bytes === null ? new RegionFile() : RegionFile.parse(bytes));
      }
    } catch {
      this.failed.add(key);
    } finally {
      this.loading.delete(key);
    }
  }

  /** 内存里那份 region，没有就现建一个（写入路径用） */
  private regionFor(cx: number, cz: number): RegionFile {
    const key = regionKeyOf(cx, cz);
    let region = this.regions.get(key);
    if (region === undefined) {
      region = new RegionFile();
      this.regions.set(key, region);
    }
    return region;
  }

  // --- 区块 ---

  /**
   * 从内存里的 region 读一个区块。没存过、或者 region 还没到货，返回 null。
   * 调用方必须先确认 isRegionReady。
   */
  readChunk(cx: number, cz: number, worldAge: number, allocEntityId: () => number): ChunkLoadResult | null {
    const region = this.regions.get(regionKeyOf(cx, cz));
    if (region === undefined) return null;
    const bytes = region.get(cx, cz);
    if (bytes === null) return null;
    return decodeChunkNbt(bytes, worldAge, allocEntityId);
  }

  writeChunk(data: ChunkSaveData, worldAge: number): void {
    this.regionFor(data.chunk.cx, data.chunk.cz)
      .put(data.chunk.cx, data.chunk.cz, encodeChunkNbt(data, worldAge));
  }

  /** 把改过的 region 全部写盘 */
  async flush(): Promise<number> {
    let written = 0;
    for (const [key, region] of this.regions) {
      if (!region.dirty) continue;
      await this.storage.write(key, region.serialize());
      region.dirty = false;
      written++;
    }
    return written;
  }

  /**
   * 把整个存档删掉，用于"重开一个世界"。
   *
   * 内存里的 region 缓存也要一起清 —— 只删盘上的文件而留着缓存的话，
   * 下一次存盘会把缓存原样写回去，看起来像"删除没生效"。
   */
  async wipe(): Promise<void> {
    for (const key of await this.storage.list('')) await this.storage.remove(key);
    this.regions.clear();
    this.loading.clear();
    this.failed.clear();
  }

  /** 内存里的 region 数与其中的区块数，排查与测试用 */
  stats(): { regions: number; chunks: number; loading: number } {
    let chunks = 0;
    for (const r of this.regions.values()) chunks += r.storedCount;
    return { regions: this.regions.size, chunks, loading: this.loading.size };
  }

  /** 丢掉内存里的 region 缓存（已写盘的才可以丢） */
  evictClean(): number {
    let n = 0;
    for (const [key, region] of this.regions) {
      if (region.dirty) continue;
      this.regions.delete(key);
      n++;
    }
    return n;
  }

  // --- level.dat ---

  async readLevel(): Promise<LevelData | null> {
    const bytes = await this.storage.read(LEVEL_KEY);
    if (bytes === null) return null;
    try {
      const root = decodeNbt(bytes).value;
      const data = getCompound(root, 'Data');
      if (data === null) return null;
      return {
        seed: getLong(data, 'RandomSeed'),
        worldAge: Number(getLong(data, 'Time')),
        timeOfDay: getInt(data, 'DayTime'),
        spawnX: getInt(data, 'SpawnX'),
        spawnY: getInt(data, 'SpawnY'),
        spawnZ: getInt(data, 'SpawnZ'),
      };
    } catch {
      return null;
    }
  }

  async writeLevel(level: LevelData): Promise<void> {
    await this.storage.write(LEVEL_KEY, encodeNbt('', nbt.compound({
      Data: nbt.compound({
        RandomSeed: nbt.long(level.seed),
        Time: nbt.long(BigInt(Math.floor(level.worldAge))),
        DayTime: nbt.int(level.timeOfDay),
        SpawnX: nbt.int(level.spawnX),
        SpawnY: nbt.int(level.spawnY),
        SpawnZ: nbt.int(level.spawnZ),
        // 存的是**我们自己的**存档版本号，不是 MC 的。格式一改就 +1，
        // 读到不认识的版本宁可当作没有存档，也不要按错的布局解析
        SaveVersion: nbt.int(SAVE_VERSION),
      }),
    })));
  }

  // --- 玩家 ---

  async readPlayer(slotCount: number): Promise<PlayerSaveData | null> {
    const bytes = await this.storage.read(PLAYER_KEY);
    if (bytes === null) return null;
    try {
      const root = decodeNbt(bytes).value;
      const pos = getList(root, 'Pos');
      const rot = getList(root, 'Rotation');
      const num = (list: NbtValue[], i: number): number => {
        const v = list[i];
        return v !== undefined && (v.type === TagType.DOUBLE || v.type === TagType.FLOAT) ? v.value : 0;
      };
      const slots = Array.from({ length: slotCount }, () => emptyStack());
      nbtToStacks(getList(root, 'Inventory'), slots);
      return {
        x: num(pos, 0), y: num(pos, 1), z: num(pos, 2),
        yaw: num(rot, 0), pitch: num(rot, 1),
        selectedHotbar: getInt(root, 'SelectedItemSlot'),
        slots,
        // 老存档没有这些字段，取默认值 —— 满血满饥饿，与新玩家一致
        health: getInt(root, 'Health', 20),
        hunger: getInt(root, 'foodLevel', 20),
        saturation: getInt(root, 'foodSaturationLevel', 5),
        air: getInt(root, 'Air', 300),
        xpLevel: getInt(root, 'XpLevel'),
        xpProgress: getInt(root, 'XpProgress'),
        xpTotal: getInt(root, 'XpTotal'),
      };
    } catch {
      return null;
    }
  }

  async writePlayer(p: PlayerSaveData): Promise<void> {
    await this.storage.write(PLAYER_KEY, encodeNbt('', nbt.compound({
      Pos: nbt.list(TagType.DOUBLE, [nbt.double(p.x), nbt.double(p.y), nbt.double(p.z)]),
      Rotation: nbt.list(TagType.DOUBLE, [nbt.double(p.yaw), nbt.double(p.pitch)]),
      SelectedItemSlot: nbt.int(p.selectedHotbar),
      Inventory: stacksToNbt(p.slots),
      // 字段名照抄 MC 的 player.dat（Health / foodLevel / foodSaturationLevel）
      Health: nbt.short(Math.round(p.health)),
      foodLevel: nbt.short(Math.round(p.hunger)),
      foodSaturationLevel: nbt.short(Math.round(p.saturation)),
      Air: nbt.short(Math.round(p.air)),
      XpLevel: nbt.int(p.xpLevel),
      XpProgress: nbt.int(p.xpProgress),
      XpTotal: nbt.int(p.xpTotal),
    })));
  }
}
