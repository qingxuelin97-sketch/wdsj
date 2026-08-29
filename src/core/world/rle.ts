/**
 * 游程编码：存档用的压缩。
 *
 * MC 用 gzip，我们不能 —— 浏览器端要么引第三方库，要么用异步的
 * CompressionStream，后者会把整条存档路径污染成异步（见 core/nbt/nbt.ts 顶部）。
 *
 * 但**不压缩也不行**：一列 8 个子区块 × (4096 个 u16 状态 + 4096 字节光照)
 * ≈ 98 KB，400 个区块就是 39 MB。要在 2 秒内写完得跑到 20 MB/s，
 * 而且 OPFS 里堆几十兆纯属浪费。
 *
 * 游程编码在这里几乎是量身定做的：体素世界的一列里，
 * 大段大段都是同一个值（连续的石头、连续的空气、连续的天光 15）。
 * 实测地表区块能压到 3-5%，比 gzip 差，但**同步、确定性、三十行**。
 *
 * 格式（两种数组各一套，但布局相同）：
 *   [变长游程长度][值] 重复至覆盖整个数组
 * 游程长度用 varint（<128 一字节），值按数组元素宽度写。
 */

/** varint 写入，返回写了几个字节 */
function writeVarint(out: number[], v: number): void {
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}

/** 压缩一个 u16 数组 */
export function rleEncode16(src: Uint16Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < src.length) {
    const v = src[i]!;
    let run = 1;
    while (i + run < src.length && src[i + run] === v) run++;
    writeVarint(out, run);
    out.push(v & 0xff, (v >>> 8) & 0xff);
    i += run;
  }
  return Uint8Array.from(out);
}

/** 压缩一个 u8 数组 */
export function rleEncode8(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < src.length) {
    const v = src[i]!;
    let run = 1;
    while (i + run < src.length && src[i + run] === v) run++;
    writeVarint(out, run);
    out.push(v);
    i += run;
  }
  return Uint8Array.from(out);
}

/**
 * 解压到一个定长数组。
 *
 * 长度由调用方给出而不是存在流里：区块的尺寸是编译期常量，
 * 存进去只会多出一处可以和现实不一致的地方。游程写超了就截断 ——
 * 宁可读到一个不完整的区块，也不要让一个坏字节把整个存档读挂。
 */
export function rleDecode16(src: Uint8Array, length: number): Uint16Array {
  const out = new Uint16Array(length);
  let p = 0;
  let o = 0;
  while (p < src.length && o < length) {
    let run = 0;
    let shift = 0;
    for (;;) {
      const b = src[p++]!;
      run |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    const v = src[p]! | (src[p + 1]! << 8);
    p += 2;
    const end = Math.min(length, o + run);
    out.fill(v, o, end);
    o = end;
  }
  return out;
}

export function rleDecode8(src: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let p = 0;
  let o = 0;
  while (p < src.length && o < length) {
    let run = 0;
    let shift = 0;
    for (;;) {
      const b = src[p++]!;
      run |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    const v = src[p++]!;
    const end = Math.min(length, o + run);
    out.fill(v, o, end);
    o = end;
  }
  return out;
}
