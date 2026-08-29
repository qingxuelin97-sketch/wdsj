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
import {
  LightEngine, unpackLightX, unpackLightY, unpackLightZ,
} from '../../core/light/light-engine.ts';
import type { BlockTables } from '../../core/registry/block-tables.ts';
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
  /**
   * 镜像自己的光照引擎。
   *
   * 服务端不会为一次方块变更下发光照数据 —— 那要么发一整块（几十 KB），
   * 要么发一堆散格。客户端拿同一份 core 算法在自己的副本上重算一遍即可：
   * 世界状态相同、算法相同，结果就相同。这正是把光照放进 core 的目的。
   */
  private readonly light: LightEngine;
  /** 需要重新网格化的子区块 */
  private readonly dirty = new Set<number>();
  /** 网格版本号，每次脏化递增，用于丢弃过期的网格结果 */
  private revCounter = 1;
  private readonly revs = new Map<number, number>();

  /** 统计 */
  chunksReceived = 0;
  chunksUnloaded = 0;
  blockUpdates = 0;
  /** 累计脏化过多少个子区块。改一格若让它涨很多，说明脏化范围失控了 */
  remeshCount = 0;

  constructor(tables: BlockTables) {
    this.tables = tables;
    this.light = new LightEngine(this.store, tables, true);
  }

  private readonly tables: BlockTables;

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
    // 八个邻居都要重做，**斜角也算**。
    //
    // mesher 拿的是 18³ 的邻域快照，四个斜角格子也在里面 —— 它们参与
    // 边界处的 AO 与光照插值。只重做上下左右的话，斜角邻居后到的那些段
    // 会一直保留"斜角还不存在"时算出来的网格，而且再也不会被重做：
    // 表现是区块角上有一道对不齐的明暗，且**取决于区块到达顺序** ——
    // 同一个种子跑两遍，收敛后的画面可以差几千个面。
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        if (!this.store.hasChunk(cx + dx, cz + dz)) continue;
        for (let sy = 0; sy < SECTIONS_PER_COLUMN; sy++) this.markDirty(cx + dx, sy, cz + dz);
      }
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
    const before = this.store.getState(x, y, z);
    if (before === state) return;
    if (!this.store.setState(x, y, z, state)) return;
    this.blockUpdates++;
    this.markDirtyAround(x, y, z);

    // 光照增量重算。查表必须用**变更前**的 id —— 方块已经写进去了。
    const oldId = stateId(before);
    const oldEmission = oldId === 0 ? 0 : (this.tables.lightEmission[oldId] ?? 0);
    const oldOpacity = oldId === 0 ? 0 : (this.tables.opacity[oldId] ?? 15);
    const newId = stateId(state);
    const newEmission = newId === 0 ? 0 : (this.tables.lightEmission[newId] ?? 0);
    this.light.onBlockChanged(x, y, z, oldEmission, newEmission, oldOpacity);

    // 光变了的格子所在的段都要重做网格。挖一格火把周围会亮/暗一大片，
    // 只重做变更点那一段的话，边上几段会留着旧亮度，接缝非常明显。
    for (const pos of this.light.drainTouched()) {
      this.markDirtyAround(unpackLightX(pos), unpackLightY(pos), unpackLightZ(pos));
    }
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
    if (!this.dirty.has(key)) this.remeshCount++;
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
