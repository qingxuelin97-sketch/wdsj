/**
 * 声明式数据包 schema。
 *
 * 每个包的字段表只写一次，编码器、解码器和 TypeScript 类型全部从它派生。
 *
 * 为什么值得这么做：前作手工维护了两套互为镜像的 switch（写一套、读一套，共 380 行），
 * 任何一处字段顺序写错都是**静默的流损坏** —— 编译器不会报错，只有跑到那个包才炸，
 * 而且症状是"偶尔断线"。这里读写同源，顺序不可能对不上。
 *
 * 复杂结构（区块数据、容器内容、实体元数据）不塞进 schema，而是用一个 `bytes` 字段
 * 装自定义编码的载荷，配套的编解码函数单独写、单独测。这样 schema 保持极简，
 * 不会为了表达嵌套数组而长出一套小型 IDL。
 */
import { ByteWriter, ByteReader } from './codec.ts';

export type FieldType =
  | 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32'
  | 'f32' | 'f64' | 'i64' | 'bool' | 'varint'
  | 'str' | 'bytes';

export type Field = readonly [name: string, type: FieldType];
export type Schema = readonly Field[];

/** 字段类型 -> TS 类型 */
type FieldTs<T extends FieldType> =
  T extends 'str' ? string :
  T extends 'bool' ? boolean :
  T extends 'bytes' ? Uint8Array :
  T extends 'i64' ? bigint :
  number;

/** 由 schema 派生出的载荷类型 */
export type Payload<S extends Schema> = {
  -readonly [F in S[number] as F[0]]: FieldTs<F[1]>;
};

export interface PacketDef<S extends Schema = Schema> {
  readonly id: number;
  readonly name: string;
  readonly schema: S;
  encode(w: ByteWriter, value: Payload<S>): void;
  decode(r: ByteReader): Payload<S>;
}

function writeField(w: ByteWriter, type: FieldType, v: unknown): void {
  switch (type) {
    case 'u8': w.u8(v as number); return;
    case 'i8': w.i8(v as number); return;
    case 'u16': w.u16(v as number); return;
    case 'i16': w.i16(v as number); return;
    case 'u32': w.u32(v as number); return;
    case 'i32': w.i32(v as number); return;
    case 'f32': w.f32(v as number); return;
    case 'f64': w.f64(v as number); return;
    case 'i64': w.i64(v as bigint); return;
    case 'bool': w.bool(v as boolean); return;
    case 'varint': w.varint(v as number); return;
    case 'str': w.str(v as string); return;
    case 'bytes': w.blob(v as Uint8Array); return;
  }
}

function readField(r: ByteReader, type: FieldType): unknown {
  switch (type) {
    case 'u8': return r.u8();
    case 'i8': return r.i8();
    case 'u16': return r.u16();
    case 'i16': return r.i16();
    case 'u32': return r.u32();
    case 'i32': return r.i32();
    case 'f32': return r.f32();
    case 'f64': return r.f64();
    case 'i64': return r.i64();
    case 'bool': return r.bool();
    case 'varint': return r.varint();
    case 'str': return r.str();
    // 复制一份：读到的是共享底层缓冲的视图，缓冲随时会被下一个包覆盖
    case 'bytes': return new Uint8Array(r.blob());
  }
}

/**
 * 定义一个数据包。
 * 用 `const` 类型参数保住字段名与类型的字面量信息，Payload 才能推出精确的对象类型。
 */
export function definePacket<const S extends Schema>(id: number, name: string, schema: S): PacketDef<S> {
  if (id < 0 || id > 0xff) throw new RangeError(`包 id ${id} 越界（${name}）`);
  const seen = new Set<string>();
  for (const [fname] of schema) {
    if (seen.has(fname)) throw new Error(`包 ${name} 的字段名 '${fname}' 重复`);
    seen.add(fname);
  }

  return {
    id,
    name,
    schema,
    encode(w: ByteWriter, value: Payload<S>): void {
      for (const [fname, ftype] of schema) {
        writeField(w, ftype, (value as Record<string, unknown>)[fname]);
      }
    },
    decode(r: ByteReader): Payload<S> {
      const out: Record<string, unknown> = {};
      for (const [fname, ftype] of schema) {
        out[fname] = readField(r, ftype);
      }
      return out as Payload<S>;
    },
  };
}

/**
 * 包注册表：按 id 分发。
 *
 * 两个方向各一个注册表（C2S / S2C），这样同一个 id 在两个方向可以表示不同的包，
 * 也避免了"靠 id 范围判断方向"这种一旦扩容就崩的做法。
 */
export class PacketRegistry {
  private readonly byId = new Map<number, PacketDef>();
  private readonly byName = new Map<string, PacketDef>();

  add<S extends Schema>(def: PacketDef<S>): PacketDef<S> {
    if (this.byId.has(def.id)) {
      throw new Error(`包 id ${def.id} 已被 '${this.byId.get(def.id)!.name}' 占用（试图注册 '${def.name}'）`);
    }
    this.byId.set(def.id, def as unknown as PacketDef);
    this.byName.set(def.name, def as unknown as PacketDef);
    return def;
  }

  get(id: number): PacketDef | undefined {
    return this.byId.get(id);
  }

  getByName(name: string): PacketDef | undefined {
    return this.byName.get(name);
  }

  get size(): number {
    return this.byId.size;
  }

  ids(): number[] {
    return [...this.byId.keys()];
  }
}

/**
 * 编码成一个带帧头的字节块：u8 包 id + 载荷。
 * 外层的传输负责再套一层 u32 长度（见 frameStream）。
 */
export function encodePacket<S extends Schema>(def: PacketDef<S>, value: Payload<S>): Uint8Array {
  const w = new ByteWriter(256);
  w.u8(def.id);
  def.encode(w, value);
  return w.toUint8Array();
}

export interface DecodedPacket {
  readonly def: PacketDef;
  readonly value: Record<string, unknown>;
}

export function decodePacket(registry: PacketRegistry, data: Uint8Array): DecodedPacket {
  const r = new ByteReader(data);
  const id = r.u8();
  const def = registry.get(id);
  if (def === undefined) throw new Error(`未知的包 id ${id}`);
  const value = def.decode(r) as Record<string, unknown>;
  if (r.remaining !== 0) {
    // 多出来的字节说明 schema 与实际写入不一致，这是必须立刻炸的错误 ——
    // 静默忽略会让后续的包一起错位
    throw new Error(`包 ${def.name} 解码后还剩 ${r.remaining} 字节未读`);
  }
  return { def, value };
}
