/**
 * 方块实体的索引，按区块分组。
 *
 * 两个访问模式，两套数据结构：
 *   - 按坐标查（右键箱子）：区块内的 Map，键是列内下标
 *   - 每 tick 遍历要动的那些（熔炉）：一个独立的 `ticking` 集合
 *
 * 第二条是计划 §3.2 坑 #9 直接点名的：前作"每 tick 遍历所有已加载列找熔炉"，
 * 视距 12 时就是每秒两万次无谓的遍历。这里只遍历真正需要 tick 的那几个 ——
 * 一个世界里箱子和告示牌可能有几百个，熔炉通常只有个位数。
 */
import { chunkKey, columnIndex } from '../../core/world/chunk.ts';
import { CHUNK_SIZE } from '../../core/constants.ts';
import { BlockEntity, BlockEntityKind } from './block-entity.ts';

/** 列内的三维下标：y * 256 + z * 16 + x */
function localIndex(x: number, y: number, z: number): number {
  return y * (CHUNK_SIZE * CHUNK_SIZE) + columnIndex(x, z);
}

export class BlockEntityStore {
  /** 区块键 -> (列内下标 -> 方块实体) */
  private readonly byChunk = new Map<number, Map<number, BlockEntity>>();
  /** 需要每 tick 处理的那些 */
  private readonly ticking = new Set<BlockEntity>();

  get(x: number, y: number, z: number): BlockEntity | null {
    const chunk = this.byChunk.get(chunkKey(x >> 4, z >> 4));
    if (chunk === undefined) return null;
    return chunk.get(localIndex(x & 15, y, z & 15)) ?? null;
  }

  set(entity: BlockEntity): void {
    const key = chunkKey(entity.x >> 4, entity.z >> 4);
    let chunk = this.byChunk.get(key);
    if (chunk === undefined) {
      chunk = new Map();
      this.byChunk.set(key, chunk);
    }
    const idx = localIndex(entity.x & 15, entity.y, entity.z & 15);
    const old = chunk.get(idx);
    if (old !== undefined) this.ticking.delete(old);
    chunk.set(idx, entity);
    // 只有熔炉需要每 tick 跑。箱子与告示牌是纯存储，进了 ticking 就是白烧 CPU
    if (entity.kind === BlockEntityKind.FURNACE) this.ticking.add(entity);
  }

  remove(x: number, y: number, z: number): BlockEntity | null {
    const key = chunkKey(x >> 4, z >> 4);
    const chunk = this.byChunk.get(key);
    if (chunk === undefined) return null;
    const idx = localIndex(x & 15, y, z & 15);
    const entity = chunk.get(idx);
    if (entity === undefined) return null;
    chunk.delete(idx);
    this.ticking.delete(entity);
    if (chunk.size === 0) this.byChunk.delete(key);
    return entity;
  }

  /** 某个区块里的全部方块实体，存盘用。顺序按列内下标，保证存档确定 */
  inChunk(cx: number, cz: number): BlockEntity[] {
    const chunk = this.byChunk.get(chunkKey(cx, cz));
    if (chunk === undefined) return [];
    return [...chunk.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e);
  }

  /** 卸载一个区块的全部方块实体 */
  dropChunk(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    const chunk = this.byChunk.get(key);
    if (chunk === undefined) return;
    for (const e of chunk.values()) this.ticking.delete(e);
    this.byChunk.delete(key);
  }

  /** 每 tick 要处理的那些 */
  tickingEntities(): Iterable<BlockEntity> {
    return this.ticking;
  }

  get size(): number {
    let n = 0;
    for (const chunk of this.byChunk.values()) n += chunk.size;
    return n;
  }

  get tickingCount(): number {
    return this.ticking.size;
  }

  clear(): void {
    this.byChunk.clear();
    this.ticking.clear();
  }
}
