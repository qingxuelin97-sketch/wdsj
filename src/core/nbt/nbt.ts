/**
 * NBT：MC 的存档数据格式。
 *
 * 复刻它而不是自己发明一个 JSON，理由和照抄方块 id 一样 ——
 * 存档格式一旦自成一派，任何对照 MC 的资料都用不上，
 * 而且以后想读真存档或者被别的工具读都不可能了。
 *
 * 格式：大端序，每个标签是 `类型(1) + 名字长度(2) + 名字 + 载荷`。
 * 复合标签以 END(0) 收尾。列表标签只写一次元素类型，然后是长度与紧密排列的载荷。
 *
 * 这里**不做压缩**。MC 用 gzip，但浏览器端要么引第三方库、要么用
 * CompressionStream（异步，会把整条存档路径污染成异步）。存档本来就要落盘，
 * 多占的空间由 OPFS 承担，换来的是一条纯同步、可在 node 里逐字节比对的代码路径。
 */

export const TagType = {
  END: 0,
  BYTE: 1,
  SHORT: 2,
  INT: 3,
  LONG: 4,
  FLOAT: 5,
  DOUBLE: 6,
  BYTE_ARRAY: 7,
  STRING: 8,
  LIST: 9,
  COMPOUND: 10,
  INT_ARRAY: 11,
} as const;
export type TagType = (typeof TagType)[keyof typeof TagType];

export type NbtValue =
  | { type: typeof TagType.BYTE; value: number }
  | { type: typeof TagType.SHORT; value: number }
  | { type: typeof TagType.INT; value: number }
  | { type: typeof TagType.LONG; value: bigint }
  | { type: typeof TagType.FLOAT; value: number }
  | { type: typeof TagType.DOUBLE; value: number }
  | { type: typeof TagType.BYTE_ARRAY; value: Uint8Array }
  | { type: typeof TagType.STRING; value: string }
  | { type: typeof TagType.LIST; elementType: TagType; value: NbtValue[] }
  | { type: typeof TagType.COMPOUND; value: Map<string, NbtValue> }
  | { type: typeof TagType.INT_ARRAY; value: Int32Array };

// --- 构造用的小工具，让调用处读起来像数据而不是像代码 ---
export const nbt = {
  byte: (v: number): NbtValue => ({ type: TagType.BYTE, value: v | 0 }),
  short: (v: number): NbtValue => ({ type: TagType.SHORT, value: v | 0 }),
  int: (v: number): NbtValue => ({ type: TagType.INT, value: v | 0 }),
  long: (v: bigint): NbtValue => ({ type: TagType.LONG, value: v }),
  float: (v: number): NbtValue => ({ type: TagType.FLOAT, value: v }),
  double: (v: number): NbtValue => ({ type: TagType.DOUBLE, value: v }),
  bytes: (v: Uint8Array): NbtValue => ({ type: TagType.BYTE_ARRAY, value: v }),
  string: (v: string): NbtValue => ({ type: TagType.STRING, value: v }),
  ints: (v: Int32Array): NbtValue => ({ type: TagType.INT_ARRAY, value: v }),
  list: (elementType: TagType, v: NbtValue[]): NbtValue => ({ type: TagType.LIST, elementType, value: v }),
  compound: (entries: Record<string, NbtValue>): NbtValue => ({
    type: TagType.COMPOUND,
    value: new Map(Object.entries(entries)),
  }),
};

/** 从复合标签里取值，类型不符或不存在时返回默认值 */
export function getInt(c: NbtValue, key: string, fallback = 0): number {
  const v = pick(c, key);
  return v !== null && (v.type === TagType.INT || v.type === TagType.SHORT || v.type === TagType.BYTE)
    ? v.value : fallback;
}
export function getDouble(c: NbtValue, key: string, fallback = 0): number {
  const v = pick(c, key);
  if (v === null) return fallback;
  if (v.type === TagType.DOUBLE || v.type === TagType.FLOAT) return v.value;
  if (v.type === TagType.INT) return v.value;
  return fallback;
}
export function getLong(c: NbtValue, key: string, fallback = 0n): bigint {
  const v = pick(c, key);
  return v !== null && v.type === TagType.LONG ? v.value : fallback;
}
export function getString(c: NbtValue, key: string, fallback = ''): string {
  const v = pick(c, key);
  return v !== null && v.type === TagType.STRING ? v.value : fallback;
}
export function getBytes(c: NbtValue, key: string): Uint8Array | null {
  const v = pick(c, key);
  return v !== null && v.type === TagType.BYTE_ARRAY ? v.value : null;
}
export function getList(c: NbtValue, key: string): NbtValue[] {
  const v = pick(c, key);
  return v !== null && v.type === TagType.LIST ? v.value : [];
}
export function getCompound(c: NbtValue, key: string): NbtValue | null {
  const v = pick(c, key);
  return v !== null && v.type === TagType.COMPOUND ? v : null;
}

function pick(c: NbtValue, key: string): NbtValue | null {
  if (c.type !== TagType.COMPOUND) return null;
  return c.value.get(key) ?? null;
}

// ---------------------------------------------------------------------------
// 写
// ---------------------------------------------------------------------------

class Writer {
  private buf = new Uint8Array(4096);
  private view = new DataView(this.buf.buffer);
  private pos = 0;

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): void { this.ensure(1); this.view.setUint8(this.pos, v); this.pos += 1; }
  i16(v: number): void { this.ensure(2); this.view.setInt16(this.pos, v, false); this.pos += 2; }
  i32(v: number): void { this.ensure(4); this.view.setInt32(this.pos, v, false); this.pos += 4; }
  i64(v: bigint): void { this.ensure(8); this.view.setBigInt64(this.pos, v, false); this.pos += 8; }
  f32(v: number): void { this.ensure(4); this.view.setFloat32(this.pos, v, false); this.pos += 4; }
  f64(v: number): void { this.ensure(8); this.view.setFloat64(this.pos, v, false); this.pos += 8; }

  raw(v: Uint8Array): void {
    this.ensure(v.length);
    this.buf.set(v, this.pos);
    this.pos += v.length;
  }

  /** NBT 的字符串是 modified UTF-8；这里只支持 BMP 之内，足够存名字与标识符 */
  str(v: string): void {
    const bytes = new TextEncoder().encode(v);
    this.i16(bytes.length);
    this.raw(bytes);
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

/** 写一个具名的根标签 */
export function encodeNbt(rootName: string, root: NbtValue): Uint8Array {
  const w = new Writer();
  w.u8(root.type);
  w.str(rootName);
  writePayload(w, root);
  return w.finish();
}

function writePayload(w: Writer, v: NbtValue): void {
  switch (v.type) {
    case TagType.BYTE: w.u8(v.value & 0xff); break;
    case TagType.SHORT: w.i16(v.value); break;
    case TagType.INT: w.i32(v.value); break;
    case TagType.LONG: w.i64(v.value); break;
    case TagType.FLOAT: w.f32(v.value); break;
    case TagType.DOUBLE: w.f64(v.value); break;
    case TagType.BYTE_ARRAY: w.i32(v.value.length); w.raw(v.value); break;
    case TagType.STRING: w.str(v.value); break;
    case TagType.LIST:
      w.u8(v.elementType);
      w.i32(v.value.length);
      for (const item of v.value) writePayload(w, item);
      break;
    case TagType.COMPOUND:
      for (const [name, item] of v.value) {
        w.u8(item.type);
        w.str(name);
        writePayload(w, item);
      }
      w.u8(TagType.END);
      break;
    case TagType.INT_ARRAY:
      w.i32(v.value.length);
      for (const n of v.value) w.i32(n);
      break;
  }
}

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

class Reader {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private pos = 0;

  constructor(data: Uint8Array) {
    this.bytes = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get done(): boolean {
    return this.pos >= this.bytes.length;
  }

  u8(): number { const v = this.view.getUint8(this.pos); this.pos += 1; return v; }
  i16(): number { const v = this.view.getInt16(this.pos, false); this.pos += 2; return v; }
  i32(): number { const v = this.view.getInt32(this.pos, false); this.pos += 4; return v; }
  i64(): bigint { const v = this.view.getBigInt64(this.pos, false); this.pos += 8; return v; }
  f32(): number { const v = this.view.getFloat32(this.pos, false); this.pos += 4; return v; }
  f64(): number { const v = this.view.getFloat64(this.pos, false); this.pos += 8; return v; }

  raw(n: number): Uint8Array {
    const out = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  str(): string {
    const n = this.i16();
    return new TextDecoder().decode(this.raw(n));
  }
}

/** 解一个具名的根标签 */
export function decodeNbt(data: Uint8Array): { name: string; value: NbtValue } {
  const r = new Reader(data);
  const type = r.u8() as TagType;
  const name = r.str();
  return { name, value: readPayload(r, type) };
}

function readPayload(r: Reader, type: TagType): NbtValue {
  switch (type) {
    case TagType.BYTE: {
      // 存进去是无符号字节，读出来要还原成有符号 —— 少了这一步，
      // 存 −1 会读成 255，而这类错误只在负数上显形
      const v = r.u8();
      return { type, value: v > 127 ? v - 256 : v };
    }
    case TagType.SHORT: return { type, value: r.i16() };
    case TagType.INT: return { type, value: r.i32() };
    case TagType.LONG: return { type, value: r.i64() };
    case TagType.FLOAT: return { type, value: r.f32() };
    case TagType.DOUBLE: return { type, value: r.f64() };
    case TagType.BYTE_ARRAY: return { type, value: r.raw(r.i32()) };
    case TagType.STRING: return { type, value: r.str() };
    case TagType.LIST: {
      const elementType = r.u8() as TagType;
      const n = r.i32();
      const items: NbtValue[] = [];
      for (let i = 0; i < n; i++) items.push(readPayload(r, elementType));
      return { type, elementType, value: items };
    }
    case TagType.COMPOUND: {
      const map = new Map<string, NbtValue>();
      for (;;) {
        const t = r.u8() as TagType;
        if (t === TagType.END) break;
        const name = r.str();
        map.set(name, readPayload(r, t));
      }
      return { type, value: map };
    }
    case TagType.INT_ARRAY: {
      const n = r.i32();
      const arr = new Int32Array(n);
      for (let i = 0; i < n; i++) arr[i] = r.i32();
      return { type, value: arr };
    }
    default:
      throw new Error(`未知的 NBT 标签类型: ${type}`);
  }
}
