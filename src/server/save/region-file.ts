/**
 * region 文件：把 32×32 个区块打包进一个文件。
 *
 * 为什么不一个区块一个文件：视距 12 的世界有六百多个区块，OPFS 里
 * 六百多个小文件的打开开销比读的内容本身还贵，node 那边同理。
 * MC 在 1.2 之前用的就是这套 McRegion 布局，理由完全一样。
 *
 * 布局（与 MC 的**有意偏差**，记在 docs/DEVIATIONS.md）：
 *   [0, 8192)   1024 项 × { u32 起始偏移, u32 字节数 }，偏移 0 表示这一格没存过
 *   [8192, ..)  各区块的数据，紧密排列
 *
 * MC 把数据按 4 KiB 扇区对齐，那是为了能就地改写单个区块而不动其余部分。
 * 我们整份 region 常驻内存、整份重写，扇区对齐只会白白浪费空间与代码。
 */

/** 一个 region 覆盖多少区块（每边） */
export const REGION_SIZE = 32;
const SLOTS = REGION_SIZE * REGION_SIZE;
const HEADER_BYTES = SLOTS * 8;

/** 世界区块坐标 -> region 坐标 */
export function regionX(cx: number): number {
  return cx >> 5;
}
export function regionZ(cz: number): number {
  return cz >> 5;
}
/**
 * 区块 -> 存储键。**维度必须进键里。**
 *
 * 目录名照抄 MC：主世界直接是 region/，下界是 DIM-1/region/，末地是 DIM1/region/。
 * 少了这一层的话，下界的 (0,0) 和主世界的 (0,0) 会写到同一个键上 ——
 * 表现是"在出生点盖了房子，去下界转一圈回来，房子变成了地狱岩"。
 */
export function regionKeyOf(cx: number, cz: number, dimension = 0): string {
  const dir = dimension === 0 ? '' : `DIM${dimension}/`;
  return `${dir}region/r.${regionX(cx)}.${regionZ(cz)}`;
}
/** 区块在 region 内的槽位。负数坐标也要落在 0..1023，所以用掩码而不是取模 */
function slotOf(cx: number, cz: number): number {
  return ((cz & (REGION_SIZE - 1)) * REGION_SIZE) + (cx & (REGION_SIZE - 1));
}

export class RegionFile {
  private readonly slots = new Array<Uint8Array | null>(SLOTS).fill(null);
  /** 自上次写盘以来是否改过 */
  dirty = false;

  static parse(bytes: Uint8Array): RegionFile {
    const region = new RegionFile();
    if (bytes.length < HEADER_BYTES) return region;
    const header = new DataView(bytes.buffer, bytes.byteOffset, HEADER_BYTES);
    for (let i = 0; i < SLOTS; i++) {
      const offset = header.getUint32(i * 8, false);
      const length = header.getUint32(i * 8 + 4, false);
      if (offset === 0 || length === 0) continue;
      // 越界的表项直接跳过。宁可少读一个区块（会被重新生成），
      // 也不要让一个坏字节把整个 region 变成异常
      if (offset + length > bytes.length) continue;
      region.slots[i] = bytes.subarray(offset, offset + length);
    }
    return region;
  }

  get(cx: number, cz: number): Uint8Array | null {
    return this.slots[slotOf(cx, cz)] ?? null;
  }

  put(cx: number, cz: number, data: Uint8Array): void {
    this.slots[slotOf(cx, cz)] = data;
    this.dirty = true;
  }

  remove(cx: number, cz: number): void {
    const i = slotOf(cx, cz);
    if (this.slots[i] === null) return;
    this.slots[i] = null;
    this.dirty = true;
  }

  get storedCount(): number {
    let n = 0;
    for (const s of this.slots) if (s !== null) n++;
    return n;
  }

  serialize(): Uint8Array {
    let total = HEADER_BYTES;
    for (const s of this.slots) if (s !== null) total += s.length;
    const out = new Uint8Array(total);
    const header = new DataView(out.buffer, 0, HEADER_BYTES);
    let offset = HEADER_BYTES;
    for (let i = 0; i < SLOTS; i++) {
      const s = this.slots[i];
      if (s == null) continue;
      header.setUint32(i * 8, offset, false);
      header.setUint32(i * 8 + 4, s.length, false);
      out.set(s, offset);
      offset += s.length;
    }
    return out;
  }
}
