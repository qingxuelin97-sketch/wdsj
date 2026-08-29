/**
 * 二进制读写。区块编解码与网络协议共用。
 *
 * 一律小端序（x86 与 ARM 都是小端，省掉字节序转换）。
 *
 * 关于长度字段：帧长度用 **u32** 而不是 u16。前作用 u16，一个调色板熵较高的区块包
 * 就能超过 65535 字节，长度字段静默截断，整条流从此错位 —— 这类 bug 表现为"偶尔断线"，
 * 极难定位。多两个字节买一个不可能发生的故障。
 */

export class BufferOverrunError extends Error {}

export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  private pos = 0;

  constructor(initialCapacity = 1024) {
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buf.buffer);
  }

  get length(): number {
    return this.pos;
  }

  private ensure(extra: number): void {
    const need = this.pos + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const grown = new Uint8Array(cap);
    grown.set(this.buf.subarray(0, this.pos));
    this.buf = grown;
    this.view = new DataView(grown.buffer);
  }

  u8(v: number): this { this.ensure(1); this.view.setUint8(this.pos, v); this.pos += 1; return this; }
  i8(v: number): this { this.ensure(1); this.view.setInt8(this.pos, v); this.pos += 1; return this; }
  u16(v: number): this { this.ensure(2); this.view.setUint16(this.pos, v, true); this.pos += 2; return this; }
  i16(v: number): this { this.ensure(2); this.view.setInt16(this.pos, v, true); this.pos += 2; return this; }
  u32(v: number): this { this.ensure(4); this.view.setUint32(this.pos, v, true); this.pos += 4; return this; }
  i32(v: number): this { this.ensure(4); this.view.setInt32(this.pos, v, true); this.pos += 4; return this; }
  f32(v: number): this { this.ensure(4); this.view.setFloat32(this.pos, v, true); this.pos += 4; return this; }
  f64(v: number): this { this.ensure(8); this.view.setFloat64(this.pos, v, true); this.pos += 8; return this; }
  i64(v: bigint): this { this.ensure(8); this.view.setBigInt64(this.pos, v, true); this.pos += 8; return this; }
  bool(v: boolean): this { return this.u8(v ? 1 : 0); }

  /** 变长整数，小值省空间。用于计数、id 这类多数时候很小的字段 */
  varint(v: number): this {
    let x = v >>> 0;
    for (;;) {
      if (x < 0x80) return this.u8(x);
      this.u8((x & 0x7f) | 0x80);
      x >>>= 7;
    }
  }

  /** UTF-8 字符串，前置 u16 字节长度 */
  str(v: string): this {
    const bytes = new TextEncoder().encode(v);
    if (bytes.length > 0xffff) throw new RangeError(`字符串过长: ${bytes.length} 字节`);
    this.u16(bytes.length);
    this.bytes(bytes);
    return this;
  }

  bytes(v: Uint8Array): this {
    this.ensure(v.length);
    this.buf.set(v, this.pos);
    this.pos += v.length;
    return this;
  }

  /** 前置 u32 长度的字节块 */
  blob(v: Uint8Array): this {
    this.u32(v.length);
    return this.bytes(v);
  }

  /** 返回写入内容的视图。**与内部缓冲共享内存**，调用方若要留存需自行复制 */
  view_(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }

  /** 复制一份写入内容 */
  toUint8Array(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }

  reset(): void {
    this.pos = 0;
  }
}

export class ByteReader {
  private readonly view: DataView;
  private readonly buf: Uint8Array;
  private pos = 0;

  constructor(data: Uint8Array) {
    this.buf = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get offset(): number { return this.pos; }
  get remaining(): number { return this.buf.length - this.pos; }
  get atEnd(): boolean { return this.pos >= this.buf.length; }

  private check(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new BufferOverrunError(`读越界：需要 ${n} 字节，只剩 ${this.buf.length - this.pos}（偏移 ${this.pos}）`);
    }
  }

  u8(): number { this.check(1); const v = this.view.getUint8(this.pos); this.pos += 1; return v; }
  i8(): number { this.check(1); const v = this.view.getInt8(this.pos); this.pos += 1; return v; }
  u16(): number { this.check(2); const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  i16(): number { this.check(2); const v = this.view.getInt16(this.pos, true); this.pos += 2; return v; }
  u32(): number { this.check(4); const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  i32(): number { this.check(4); const v = this.view.getInt32(this.pos, true); this.pos += 4; return v; }
  f32(): number { this.check(4); const v = this.view.getFloat32(this.pos, true); this.pos += 4; return v; }
  f64(): number { this.check(8); const v = this.view.getFloat64(this.pos, true); this.pos += 8; return v; }
  i64(): bigint { this.check(8); const v = this.view.getBigInt64(this.pos, true); this.pos += 8; return v; }
  bool(): boolean { return this.u8() !== 0; }

  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.u8();
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result >>> 0;
      shift += 7;
      if (shift > 35) throw new BufferOverrunError('varint 过长');
    }
  }

  str(): string {
    const len = this.u16();
    this.check(len);
    const s = new TextDecoder().decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }

  /** 读 n 字节。返回的是**视图**，与源缓冲共享内存 */
  bytes(n: number): Uint8Array {
    this.check(n);
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  blob(): Uint8Array {
    return this.bytes(this.u32());
  }

  skip(n: number): void {
    this.check(n);
    this.pos += n;
  }
}
