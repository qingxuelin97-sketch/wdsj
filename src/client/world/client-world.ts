/**
 * 客户端的世界镜像。
 *
 * 它只是服务端世界的一份**只读副本**，用于网格化、射线与碰撞预测。
 * 客户端**永不**主动创建或销毁区块 —— 只有 S_ChunkData / S_ChunkUnload 能改变
 * 它的区块集合（docs/RULES.md 第 8 条）。方块变更同样只来自服务端。
 *
 * 网格化的脏标记以**子区块**为单位。改一格只重网格化它所在的那一段，
 * 以及被它影响到的相邻段（改边界格会影响邻居的面剔除与 AO）。
 */
import { ChunkStore } from '../../core/world/block-view.ts';
import { decodeChunk } from '../../core/world/chunk-codec.ts';
import { chunkKey, stateId } from '../../core/world/chunk.ts';
import { SECTIONS_PER_COLUMN, SECTION_SIZE, WORLD_HEIGHT } from '../../core/constants.ts';

/** 子区块 key：((cx,cz) 的复合 key) * 8 + cy */
export function sectionKeyOf(cx: number, cy: number, cz: number): number {
  return chunkKey(cx, cz) * 8 + cy;
}

export interface SectionCoord {
  cx: number;
  cy: number;
  cz: number;
}

export class ClientWorld {
  readonly store = new ChunkStore();
  /** 需要重新网格化的子区块 */
  private readonly dirty = new Set<number>();
  /** 网格版本号，每次脏化递增，用于丢弃过期的网格结果 */
  private revCounter = 1;
  private readonly revs = new Map<number, number>();

  /** 统计 */
  chunksReceived = 0;
  chunksUnloaded = 0;
  blockUpdates = 0;

  get chunkCount(): number {
    return this.store.size;
  }

  get dirtyCount(): number {
    return this.dirty.size;
  }

  /** 处理 S_ChunkData */
  onChunkData(cx: number, cz: number, blob: Uint8Array): void {
    const chunk = decodeChunk(cx, cz, blob);
    this.store.addChunk(chunk);
    this.chunksReceived++;
    // 新区块的所有非空段都要网格化，同时邻居的边界段也要重做
    // （之前它们是按"邻居不存在"网格化的，会多出一整面）
    for (let sy = 0; sy < SECTIONS_PER_COLUMN; sy++) {
      if (chunk.sections[sy] != null) this.markDirty(cx, sy, cz);
    }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      if (!this.store.hasChunk(cx + dx, cz + dz)) continue;
      for (let sy = 0; sy < SECTIONS_PER_COLUMN; sy++) this.markDirty(cx + dx, sy, cz + dz);
    }
  }

  /** 处理 S_ChunkUnload */
  onChunkUnload(cx: number, cz: number): void {
    if (!this.store.hasChunk(cx, cz)) return;
    this.store.removeChunk(cx, cz);
    this.chunksUnloaded++;
    for (let sy = 0; sy < SECTIONS_PER_COLUMN; sy++) {
      const key = sectionKeyOf(cx, sy, cz);
      this.dirty.delete(key);
      this.revs.delete(key);
    }
  }

  /** 处理 S_BlockUpdate */
  onBlockUpdate(x: number, y: number, z: number, state: number): void {
    if (!this.store.setState(x, y, z, state)) return;
    this.blockUpdates++;
    this.markDirtyAround(x, y, z);
  }

  /**
   * 标记某个方块所在的子区块及其受影响的邻居为脏。
   * 改到边界格时，邻居段的面剔除与 AO 都会变，必须一起重做。
   */
  markDirtyAround(x: number, y: number, z: number): void {
    const cx = x >> 4;
    const cz = z >> 4;
    const cy = y >> 4;
    this.markDirty(cx, cy, cz);

    const lx = x & 15;
    const ly = y & 15;
    const lz = z & 15;
    if (lx === 0) this.markDirty(cx - 1, cy, cz);
    if (lx === 15) this.markDirty(cx + 1, cy, cz);
    if (lz === 0) this.markDirty(cx, cy, cz - 1);
    if (lz === 15) this.markDirty(cx, cy, cz + 1);
    if (ly === 0 && cy > 0) this.markDirty(cx, cy - 1, cz);
    if (ly === 15 && cy < SECTIONS_PER_COLUMN - 1) this.markDirty(cx, cy + 1, cz);
  }

  markDirty(cx: number, cy: number, cz: number): void {
    if (cy < 0 || cy >= SECTIONS_PER_COLUMN) return;
    if (!this.store.hasChunk(cx, cz)) return;
    const key = sectionKeyOf(cx, cy, cz);
    this.dirty.add(key);
    this.revs.set(key, ++this.revCounter);
  }

  /** 当前的网格版本号，用于比对回来的结果是否过期 */
  revOf(cx: number, cy: number, cz: number): number {
    return this.revs.get(sectionKeyOf(cx, cy, cz)) ?? 0;
  }

  /**
   * 取出最多 n 个待网格化的子区块，按距离玩家由近及远。
   * 近处的先出现，玩家转身时不会盯着一片空洞等半天。
   */
  takeDirty(n: number, px: number, py: number, pz: number, out: SectionCoord[]): number {
    out.length = 0;
    if (this.dirty.size === 0) return 0;

    // 只在待办不多时排序；几千个时排序本身就成了开销
    const candidates: { key: number; dist: number }[] = [];
    for (const key of this.dirty) {
      const cy = key % 8;
      const columnKey = (key - cy) / 8;
      const cx = Math.floor(columnKey / 0x1000000) - 0x800000;
      const cz = (columnKey % 0x1000000) - 0x800000;
      const dx = cx * SECTION_SIZE + 8 - px;
      const dy = cy * SECTION_SIZE + 8 - py;
      const dz = cz * SECTION_SIZE + 8 - pz;
      candidates.push({ key, dist: dx * dx + dy * dy + dz * dz });
    }
    candidates.sort((a, b) => a.dist - b.dist);

    const take = Math.min(n, candidates.length);
    for (let i = 0; i < take; i++) {
      const key = candidates[i]!.key;
      const cy = key % 8;
      const columnKey = (key - cy) / 8;
      const cx = Math.floor(columnKey / 0x1000000) - 0x800000;
      const cz = (columnKey % 0x1000000) - 0x800000;
      this.dirty.delete(key);
      out.push({ cx, cy, cz });
    }
    return out.length;
  }

  /** 该子区块是否有内容值得网格化 */
  hasContent(cx: number, cy: number, cz: number): boolean {
    const chunk = this.store.getChunk(cx, cz);
    if (chunk === null) return false;
    const section = chunk.sections[cy];
    return section != null && !section.isEmpty;
  }

  /** 射线与碰撞用的方块查询 */
  getBlockId(x: number, y: number, z: number): number {
    if (y < 0 || y >= WORLD_HEIGHT) return 0;
    return stateId(this.store.getState(x, y, z));
  }
}
