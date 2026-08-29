/**
 * 区块的存档读写。
 *
 * 从 server-world.ts 里分出来的（那个文件到了 424 行、越过软上限），
 * 分界线是"和存档打交道的那组操作"：装载、落盘、批量存。
 *
 * 写成自由函数而不是方法，与 player/inventory-actions.ts 同一套理由 ——
 * 它们只是 ServerWorld 状态上的一组变换，拆出来之后依赖关系写在签名上。
 */
import type { ServerWorld } from './server-world.ts';
import type { Chunk } from '../../core/world/chunk.ts';
import type { ItemEntity } from '../entity/item-entity.ts';
import type { Mob } from '../entity/mob.ts';
import type { ArrowEntity } from '../entity/arrow.ts';
import { CHUNK_SIZE } from '../../core/constants.ts';

/**
 * 从存档里把一个区块装进世界。没存过返回 null。
 *
 * 光照是连着存的，所以**不进** lightPending —— 存档里那份就是当时算好的，
 * 再播种一遍纯属浪费，还会让读档后的第一帧比正常慢一大截。
 */
export function installChunkFromSave(world: ServerWorld, cx: number, cz: number): Chunk | null {
  const save = world.save;
  if (save === null) return null;
  const loaded = save.readChunk(cx, cz, world.worldAge, world.allocEntityId);
  if (loaded === null) return null;
  world.store.addChunk(loaded.chunk);
  for (const e of loaded.blockEntities) world.blockEntities.set(e);
  for (const e of loaded.items) world.items.set(e.entityId, e);
  world.installLoadedMobs(loaded.mobs, loaded.arrows);
  for (const t of loaded.tileTicks) world.scheduled.restore(t);
  return loaded.chunk;
}

/**
 * 把一个区块连同它的方块实体、掉落物、计划刻写进存档。
 * 区块不在内存里就什么都不做。
 */
export function saveChunkToSave(world: ServerWorld, cx: number, cz: number): boolean {
  const save = world.save;
  if (save === null) return false;
  const chunk = world.store.getChunk(cx, cz);
  if (chunk === null) return false;
  const x0 = cx * CHUNK_SIZE;
  const z0 = cz * CHUNK_SIZE;
  /** 某个实体在不在这个区块里 */
  const inChunk = (ex: number, ez: number): boolean =>
    (Math.floor(ex) >> 4) === cx && (Math.floor(ez) >> 4) === cz;

  const items: ItemEntity[] = [];
  for (const item of world.items.values()) {
    if (inChunk(item.x, item.z)) items.push(item);
  }
  const mobs: Mob[] = [];
  for (const mob of world.mobsInChunk(cx, cz)) mobs.push(mob);
  const arrows: ArrowEntity[] = [];
  for (const arrow of world.arrowsInChunk(cx, cz)) arrows.push(arrow);

  // 实体一律按 id 排序：Map 的遍历顺序取决于插入历史，
  // 而存档必须只取决于世界状态，否则同一个世界存两次字节不一样
  items.sort((a, b) => a.entityId - b.entityId);
  mobs.sort((a, b) => a.entityId - b.entityId);
  arrows.sort((a, b) => a.entityId - b.entityId);

  save.writeChunk({
    chunk,
    blockEntities: world.blockEntities.inChunk(cx, cz),
    items,
    mobs,
    arrows,
    tileTicks: world.scheduled.entriesIn(x0, z0, x0 + CHUNK_SIZE - 1, z0 + CHUNK_SIZE - 1),
  }, world.worldAge);
  chunk.dirty = false;
  return true;
}

/** 存下所有在内存里的区块。返回存了几个 */
export function saveAllChunks(world: ServerWorld): number {
  if (world.save === null) return 0;
  let n = 0;
  for (const chunk of world.store.chunkValues()) {
    if (saveChunkToSave(world, chunk.cx, chunk.cz)) n++;
  }
  return n;
}
