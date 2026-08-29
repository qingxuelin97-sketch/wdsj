/**
 * 区块数据结构。全项目最热的数据结构，改这里之前先看 docs/RULES.md 第 6、9、10 条。
 *
 * 布局：
 *   世界高 128（MC 1.0 是 McRegion，不是 1.2 之后的 256）
 *   一列 = 8 个 16×16×16 的子区块
 *   方块状态打包成一个 u16：blockId(12 bit) | meta(4 bit)
 *     -> 4096 种方块 × 16 种元数据，1.0 最大方块 ID 是 122，绰绰有余
 *   光照打包成一个 u8：sky(4 bit) | block(4 bit)
 *
 * 内存：12 KB/子区块 × 8 = 96 KB/列。渲染距离 12 约 625 列 ≈ 60 MB。
 * 刻意不做 nibble 打包，也不做内存内调色板压缩 —— 省下的内存用不上，
 * 换来热路径（mesher、光照、碰撞）无位移掩码的直接下标访问。见 docs/DEVIATIONS.md。
 */
import { SECTION_SIZE, SECTIONS_PER_COLUMN, WORLD_HEIGHT, CHUNK_SIZE } from '../constants.ts';

export const SECTION_VOLUME = SECTION_SIZE * SECTION_SIZE * SECTION_SIZE;

/** 空气的方块状态恒为 0，这样 new Uint16Array 出来就是全空气 */
export const AIR_STATE = 0;

// ---------------------------------------------------------------------------
// 方块状态打包
// ---------------------------------------------------------------------------

/** 把方块 id 与元数据打包成一个 u16 */
export function packState(id: number, meta = 0): number {
  return (id & 0xfff) | ((meta & 0xf) << 12);
}

export function stateId(state: number): number {
  return state & 0xfff;
}

export function stateMeta(state: number): number {
  return (state >> 12) & 0xf;
}

/** 只改元数据，保留 id */
export function withMeta(state: number, meta: number): number {
  return (state & 0xfff) | ((meta & 0xf) << 12);
}

// ---------------------------------------------------------------------------
// 下标计算
// ---------------------------------------------------------------------------

/**
 * 子区块内的下标，YZX 顺序（与 MC 一致）。
 * y 最外层让同一水平层在内存里连续，mesher 与光照的主要遍历方向都受益。
 */
export function sectionIndex(x: number, y: number, z: number): number {
  return (y << 8) | (z << 4) | x;
}

/** 列内的水平下标（heightmap / biomes 用） */
export function columnIndex(x: number, z: number): number {
  return (z << 4) | x;
}

/**
 * 区块坐标打包成一个数值 key。
 *
 * 绝不用字符串 key —— 前作在每帧的剔除循环里做 `cx + ',' + cz` 再 `key.split(',')`，
 * 几百个区块就是几百次字符串分配加解析。见 docs/RULES.md 第 10 条。
 *
 * 偏移 2^23 让负坐标也能正确编码，支持 ±8388608 区块（约 ±1.3 亿格），远超需要。
 */
export function chunkKey(cx: number, cz: number): number {
  return (cx + 0x800000) * 0x1000000 + (cz + 0x800000);
}

export function keyToCx(key: number): number {
  return Math.floor(key / 0x1000000) - 0x800000;
}

export function keyToCz(key: number): number {
  return (key % 0x1000000) - 0x800000;
}

/** 世界坐标 -> 区块坐标 */
export function toChunkCoord(worldCoord: number): number {
  return worldCoord >> 4;
}

/** 世界坐标 -> 区块内局部坐标（0..15） */
export function toLocalCoord(worldCoord: number): number {
  return worldCoord & 15;
}

// ---------------------------------------------------------------------------
// 子区块
// ---------------------------------------------------------------------------

export class ChunkSection {
  /** 4096 个方块状态，blockId(12) | meta(4) */
  readonly states: Uint16Array;
  /** 4096 个光照值，sky(4) | block(4) */
  readonly light: Uint8Array;
  /** 非空气方块计数。为 0 时整个子区块可以从渲染与随机刻里跳过 */
  nonAir = 0;

  constructor(states?: Uint16Array, light?: Uint8Array) {
    this.states = states ?? new Uint16Array(SECTION_VOLUME);
    this.light = light ?? new Uint8Array(SECTION_VOLUME);
    if (states !== undefined) this.recountNonAir();
  }

  get(x: number, y: number, z: number): number {
    return this.states[sectionIndex(x, y, z)]!;
  }

  /** 返回旧状态，方便调用方判断是否真的变了 */
  set(x: number, y: number, z: number, state: number): number {
    const i = sectionIndex(x, y, z);
    const old = this.states[i]!;
    if (old === state) return old;
    this.states[i] = state;
    if (old === AIR_STATE && state !== AIR_STATE) this.nonAir++;
    else if (old !== AIR_STATE && state === AIR_STATE) this.nonAir--;
    return old;
  }

  getSkyLight(x: number, y: number, z: number): number {
    return this.light[sectionIndex(x, y, z)]! >> 4;
  }

  getBlockLight(x: number, y: number, z: number): number {
    return this.light[sectionIndex(x, y, z)]! & 0xf;
  }

  setSkyLight(x: number, y: number, z: number, level: number): void {
    const i = sectionIndex(x, y, z);
    this.light[i] = ((level & 0xf) << 4) | (this.light[i]! & 0xf);
  }

  setBlockLight(x: number, y: number, z: number, level: number): void {
    const i = sectionIndex(x, y, z);
    this.light[i] = (this.light[i]! & 0xf0) | (level & 0xf);
  }

  get isEmpty(): boolean {
    return this.nonAir === 0;
  }

  recountNonAir(): void {
    let n = 0;
    const s = this.states;
    for (let i = 0; i < SECTION_VOLUME; i++) if (s[i] !== AIR_STATE) n++;
    this.nonAir = n;
  }
}

// ---------------------------------------------------------------------------
// 区块列
// ---------------------------------------------------------------------------

export class Chunk {
  readonly cx: number;
  readonly cz: number;
  /** 8 个子区块，null 表示整段都是空气（不占内存） */
  readonly sections: (ChunkSection | null)[];
  /** 每列最高非空气方块的 y+1，即"天空从这里开始"。0 表示整列空 */
  readonly heightmap: Uint8Array;
  readonly biomes: Uint8Array;
  /** 自上次存盘以来是否被改过 */
  dirty = false;

  constructor(cx: number, cz: number) {
    this.cx = cx;
    this.cz = cz;
    this.sections = new Array<ChunkSection | null>(SECTIONS_PER_COLUMN).fill(null);
    this.heightmap = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
    this.biomes = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
  }

  get key(): number {
    return chunkKey(this.cx, this.cz);
  }

  /** 取子区块；不存在时返回 null（不分配） */
  getSection(sy: number): ChunkSection | null {
    if (sy < 0 || sy >= SECTIONS_PER_COLUMN) return null;
    return this.sections[sy]!;
  }

  /** 取子区块，不存在就建一个 */
  getOrCreateSection(sy: number): ChunkSection {
    const existing = this.sections[sy];
    if (existing != null) return existing;
    const created = new ChunkSection();
    this.sections[sy] = created;
    return created;
  }

  /**
   * 读方块状态。y 越界返回空气。
   * x/z 必须是 0..15 的局部坐标 —— 跨区块读取由上层的 BlockView 负责。
   */
  getState(x: number, y: number, z: number): number {
    if (y < 0 || y >= WORLD_HEIGHT) return AIR_STATE;
    const section = this.sections[y >> 4];
    if (section == null) return AIR_STATE;
    return section.states[sectionIndex(x, y & 15, z)]!;
  }

  /** 写方块状态，返回旧值。会顺带维护 heightmap。 */
  setState(x: number, y: number, z: number, state: number): number {
    if (y < 0 || y >= WORLD_HEIGHT) return AIR_STATE;
    const sy = y >> 4;
    let section = this.sections[sy];
    if (section == null) {
      // 往空气段写空气：什么都不用做，别为此分配一个子区块
      if (state === AIR_STATE) return AIR_STATE;
      section = new ChunkSection();
      this.sections[sy] = section;
    }
    const old = section.set(x, y & 15, z, state);
    if (old !== state) {
      this.dirty = true;
      this.updateHeightAt(x, z, y, state);
    }
    return old;
  }

  getSkyLight(x: number, y: number, z: number): number {
    if (y < 0 || y >= WORLD_HEIGHT) return y >= WORLD_HEIGHT ? 15 : 0;
    const section = this.sections[y >> 4];
    // 空气段没有分配时，光照取决于它在不在地表之上，这里保守返回 0，
    // 由光照引擎在建段时填充。查询热路径请用 BlockView。
    if (section == null) return 0;
    return section.light[sectionIndex(x, y & 15, z)]! >> 4;
  }

  getBlockLight(x: number, y: number, z: number): number {
    if (y < 0 || y >= WORLD_HEIGHT) return 0;
    const section = this.sections[y >> 4];
    if (section == null) return 0;
    return section.light[sectionIndex(x, y & 15, z)]! & 0xf;
  }

  /** 某一列最高非空气方块的 y+1 */
  getHeight(x: number, z: number): number {
    return this.heightmap[columnIndex(x, z)]!;
  }

  /**
   * 增量维护 heightmap。
   * 放置方块时只需比较；破坏方块且它正好是最高块时才需要向下扫。
   */
  private updateHeightAt(x: number, z: number, y: number, newState: number): void {
    const ci = columnIndex(x, z);
    const h = this.heightmap[ci]!;
    if (newState !== AIR_STATE) {
      if (y + 1 > h) this.heightmap[ci] = y + 1;
      return;
    }
    if (y + 1 !== h) return; // 挖掉的不是最高块，高度不变
    let scan = y - 1;
    while (scan >= 0 && this.getState(x, scan, z) === AIR_STATE) scan--;
    this.heightmap[ci] = scan + 1;
  }

  /** 从头重算整张 heightmap，加载区块后调用一次 */
  recomputeHeightmap(): void {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        let y = WORLD_HEIGHT - 1;
        while (y >= 0 && this.getState(x, y, z) === AIR_STATE) y--;
        this.heightmap[columnIndex(x, z)] = y + 1;
      }
    }
  }

  /** 丢掉已经全空的子区块，回收内存 */
  pruneEmptySections(): void {
    for (let sy = 0; sy < SECTIONS_PER_COLUMN; sy++) {
      const s = this.sections[sy];
      if (s != null && s.isEmpty) this.sections[sy] = null;
    }
  }
}
