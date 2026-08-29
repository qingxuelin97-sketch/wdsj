/**
 * 区块 <-> NBT。
 *
 * 字段名沿用 MC 的（`Level`/`Sections`/`HeightMap`/`TileEntities`/`TileTicks`），
 * 理由和照抄方块 id 一样：一旦自成一派，所有对照资料都作废。
 *
 * 与 MC 的两处**有意偏差**（记在 docs/DEVIATIONS.md 里）：
 *   1. 方块数据存成 RLE 压缩的 u16 状态（id 12 位 + 元数据 4 位），而不是
 *      MC 的"字节数组 + nibble 元数据"。我们的世界内存里就是 u16，
 *      存成 nibble 要拆一遍读回来再拼一遍，纯属自找麻烦。
 *   2. 整个文件不 gzip，改在数组层面做 RLE（见 core/world/rle.ts）。
 *
 * 光照**存进去**而不是读档时重算。MC 也这么做。重算 400 个区块的天光
 * 要好几秒，而这正是本里程碑的验收指标之一。
 */
import { Chunk, ChunkSection } from '../../core/world/chunk.ts';
import { rleEncode16, rleEncode8, rleDecode16, rleDecode8 } from '../../core/world/rle.ts';
import {
  nbt, encodeNbt, decodeNbt, getInt, getBytes, getList, getCompound, getString, TagType, type NbtValue,
} from '../../core/nbt/nbt.ts';
import { CHUNK_SIZE, SECTION_VOLUME, SECTIONS_PER_COLUMN } from '../../core/constants.ts';
import { BlockEntity, blockEntityFromNbt } from '../world/block-entity.ts';
import { ItemEntity, itemEntityFromNbt } from '../entity/item-entity.ts';
import { Mob, mobFromNbt } from '../entity/mob.ts';
import { ArrowEntity, arrowFromNbt } from '../entity/arrow.ts';
import { mobDefOf } from '../../content/mobs.ts';
import type { ScheduledTick } from '../world/scheduled-ticks.ts';

/** 一个区块存盘时要带上的一切 */
export interface ChunkSaveData {
  chunk: Chunk;
  blockEntities: readonly BlockEntity[];
  /** 掉落物、生物、箭混装在同一个 Entities 列表里，靠 id 字段分流 */
  items: readonly ItemEntity[];
  mobs: readonly Mob[];
  arrows: readonly ArrowEntity[];
  tileTicks: readonly ScheduledTick[];
}

export interface ChunkLoadResult {
  chunk: Chunk;
  blockEntities: BlockEntity[];
  items: ItemEntity[];
  mobs: Mob[];
  arrows: ArrowEntity[];
  tileTicks: ScheduledTick[];
}

const COLUMN_AREA = CHUNK_SIZE * CHUNK_SIZE;

export function encodeChunkNbt(data: ChunkSaveData, worldAge: number): Uint8Array {
  const { chunk } = data;
  const sections: NbtValue[] = [];
  for (let sy = 0; sy < SECTIONS_PER_COLUMN; sy++) {
    const section = chunk.sections[sy];
    if (section == null) continue;
    sections.push(nbt.compound({
      Y: nbt.byte(sy),
      Blocks: nbt.bytes(rleEncode16(section.states)),
      Light: nbt.bytes(rleEncode8(section.light)),
    }));
  }

  // 计划刻存的是**相对当前世界年龄的剩余刻数**，不是绝对时间。
  // 存绝对时间的话，读档时世界年龄从存档里恢复才对得上；
  // 而一旦哪天允许"把世界搬到另一个存档"，绝对时间就全错了。
  const tileTicks = data.tileTicks.map((t) => nbt.compound({
    x: nbt.int(t.x), y: nbt.int(t.y), z: nbt.int(t.z),
    i: nbt.int(t.blockId),
    t: nbt.int(Math.max(0, t.time - worldAge)),
    p: nbt.int(t.order),
  }));

  // 根标签不取名（MC 里也是空的）
  return encodeNbt('', nbt.compound({
    Level: nbt.compound({
      xPos: nbt.int(chunk.cx),
      zPos: nbt.int(chunk.cz),
      HeightMap: nbt.bytes(chunk.heightmap),
      Biomes: nbt.bytes(chunk.biomes),
      Sections: nbt.list(TagType.COMPOUND, sections),
      TileEntities: nbt.list(TagType.COMPOUND, data.blockEntities.map((e) => e.toNbt())),
      Entities: nbt.list(TagType.COMPOUND, [
        ...data.items.map((e) => e.toNbt()),
        ...data.mobs.map((e) => e.toNbt()),
        ...data.arrows.map((e) => e.toNbt()),
      ]),
      TileTicks: nbt.list(TagType.COMPOUND, tileTicks),
    }),
  }));
}

/**
 * 读回一个区块。格式对不上返回 null —— 让调用方当作"没存过"重新生成，
 * 而不是抛一个异常把整个世界的加载打断。
 */
export function decodeChunkNbt(
  bytes: Uint8Array,
  worldAge: number,
  allocEntityId: () => number,
): ChunkLoadResult | null {
  let root: NbtValue;
  try {
    root = decodeNbt(bytes).value;
  } catch {
    return null;
  }
  const level = getCompound(root, 'Level');
  if (level === null) return null;

  const chunk = new Chunk(getInt(level, 'xPos'), getInt(level, 'zPos'));
  const heightmap = getBytes(level, 'HeightMap');
  if (heightmap === null || heightmap.length !== COLUMN_AREA) return null;
  chunk.heightmap.set(heightmap);
  const biomes = getBytes(level, 'Biomes');
  if (biomes !== null && biomes.length === COLUMN_AREA) chunk.biomes.set(biomes);

  for (const s of getList(level, 'Sections')) {
    const sy = getInt(s, 'Y');
    if (sy < 0 || sy >= SECTIONS_PER_COLUMN) continue;
    const blocks = getBytes(s, 'Blocks');
    const light = getBytes(s, 'Light');
    if (blocks === null) continue;
    const states = rleDecode16(blocks, SECTION_VOLUME);
    const lightData = light === null
      ? new Uint8Array(SECTION_VOLUME)
      : rleDecode8(light, SECTION_VOLUME);
    chunk.sections[sy] = new ChunkSection(states, lightData);
  }
  // 光照是从存档里原样读回来的，不需要再播种一次
  chunk.lightReady = true;

  const blockEntities: BlockEntity[] = [];
  for (const t of getList(level, 'TileEntities')) {
    const e = blockEntityFromNbt(t);
    if (e !== null) blockEntities.push(e);
  }

  const items: ItemEntity[] = [];
  const mobs: Mob[] = [];
  const arrows: ArrowEntity[] = [];
  for (const t of getList(level, 'Entities')) {
    switch (getString(t, 'id')) {
      case 'Mob': {
        const m = mobFromNbt(allocEntityId(), t, mobDefOf);
        if (m !== null) mobs.push(m);
        break;
      }
      case 'Arrow': {
        const a = arrowFromNbt(allocEntityId(), t);
        if (a !== null) arrows.push(a);
        break;
      }
      default: {
        // 没有 id 字段的按掉落物处理：那是 M9 存下来的老格式
        const e = itemEntityFromNbt(allocEntityId(), t);
        if (e !== null) items.push(e);
        break;
      }
    }
  }

  const tileTicks: ScheduledTick[] = [];
  for (const t of getList(level, 'TileTicks')) {
    tileTicks.push({
      x: getInt(t, 'x'), y: getInt(t, 'y'), z: getInt(t, 'z'),
      blockId: getInt(t, 'i'),
      time: worldAge + getInt(t, 't'),
      order: getInt(t, 'p'),
    });
  }

  return { chunk, blockEntities, items, mobs, arrows, tileTicks };
}
