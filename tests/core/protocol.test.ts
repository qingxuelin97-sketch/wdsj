/**
 * 协议验证。
 *
 * 核心是**全数据包随机往返属性测试**：对每个已注册的包，用随机值填满全部字段，
 * 编码再解码，逐字段比对。schema 读写同源，所以这个测试真正验的是各字段类型的
 * 编解码实现，以及分帧不会串包。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ByteWriter, ByteReader, BufferOverrunError } from '../../src/core/net/codec.ts';
import { definePacket, encodePacket, decodePacket, PacketRegistry, type FieldType } from '../../src/core/net/schema.ts';
import { C2S, S2C, C_PlayerMove, S_ChunkData, S_Login } from '../../src/core/net/packets.ts';
import { LoopbackTransport, PacketChannel } from '../../src/core/net/transport.ts';
import { JavaRandom } from '../../src/core/rng/java-random.ts';

// ---------------------------------------------------------------------------
// 字节层
// ---------------------------------------------------------------------------

test('ByteWriter / ByteReader 各类型往返', () => {
  const w = new ByteWriter(8);
  w.u8(200); w.i8(-100); w.u16(60000); w.i16(-30000);
  w.u32(4000000000); w.i32(-2000000000);
  w.f32(1.5); w.f64(Math.PI);
  w.i64(-1234567890123456789n);
  w.bool(true); w.bool(false);
  w.varint(0); w.varint(127); w.varint(128); w.varint(300); w.varint(4000000000);
  w.str('你好 world 🌍');
  w.blob(new Uint8Array([1, 2, 3, 250]));

  const r = new ByteReader(w.toUint8Array());
  assert.equal(r.u8(), 200);
  assert.equal(r.i8(), -100);
  assert.equal(r.u16(), 60000);
  assert.equal(r.i16(), -30000);
  assert.equal(r.u32(), 4000000000);
  assert.equal(r.i32(), -2000000000);
  assert.equal(r.f32(), 1.5);
  assert.equal(r.f64(), Math.PI);
  assert.equal(r.i64(), -1234567890123456789n);
  assert.equal(r.bool(), true);
  assert.equal(r.bool(), false);
  assert.equal(r.varint(), 0);
  assert.equal(r.varint(), 127);
  assert.equal(r.varint(), 128);
  assert.equal(r.varint(), 300);
  assert.equal(r.varint(), 4000000000);
  assert.equal(r.str(), '你好 world 🌍');
  assert.deepEqual(Array.from(r.blob()), [1, 2, 3, 250]);
  assert.equal(r.remaining, 0, '应正好读完');
});

test('ByteWriter 自动扩容后内容不丢', () => {
  const w = new ByteWriter(4); // 故意给一个会立刻不够的初始容量
  const expected: number[] = [];
  for (let i = 0; i < 5000; i++) {
    w.u32(i);
    expected.push(i);
  }
  const r = new ByteReader(w.toUint8Array());
  for (const e of expected) assert.equal(r.u32(), e);
  assert.equal(r.remaining, 0);
});

test('读越界抛错而不是返回垃圾', () => {
  const r = new ByteReader(new Uint8Array([1, 2]));
  r.u8();
  r.u8();
  assert.throws(() => r.u8(), BufferOverrunError);
  assert.throws(() => new ByteReader(new Uint8Array(2)).u32(), BufferOverrunError);
});

// ---------------------------------------------------------------------------
// schema 层
// ---------------------------------------------------------------------------

/** 按字段类型生成一个随机但合法的值 */
function randomValue(rng: JavaRandom, type: FieldType): unknown {
  switch (type) {
    case 'u8': return rng.nextInt(256);
    case 'i8': return rng.nextInt(256) - 128;
    case 'u16': return rng.nextInt(65536);
    case 'i16': return rng.nextInt(65536) - 32768;
    case 'u32': return rng.nextInt(2147483647) >>> 0;
    case 'i32': return rng.nextInt(2147483647) - 1073741823;
    // f32 的精度只有约 7 位，随机小数往返会有误差；取能被 f32 精确表示的值
    case 'f32': return (rng.nextInt(20001) - 10000) / 16;
    case 'f64': return (rng.nextDouble() - 0.5) * 1e6;
    case 'i64': return BigInt(rng.nextInt(2147483647)) * 1000000007n - 500n;
    case 'bool': return rng.nextBoolean();
    case 'varint': return rng.nextInt(2147483647) >>> 0;
    case 'str': return `名字${rng.nextInt(10000)}·${'x'.repeat(rng.nextInt(20))}`;
    case 'bytes': {
      const n = rng.nextInt(300);
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i++) b[i] = rng.nextInt(256);
      return b;
    }
  }
}

function roundTripAll(registry: PacketRegistry, label: string): void {
  const rng = new JavaRandom(20260829);
  for (const id of registry.ids()) {
    const def = registry.get(id)!;
    for (let round = 0; round < 30; round++) {
      const value: Record<string, unknown> = {};
      for (const [fname, ftype] of def.schema) value[fname] = randomValue(rng, ftype);

      const bytes = encodePacket(def, value as never);
      const decoded = decodePacket(registry, bytes);
      assert.equal(decoded.def.name, def.name, `${label} ${def.name} 的 id 分发错了`);

      for (const [fname, ftype] of def.schema) {
        const a = value[fname];
        const b = decoded.value[fname];
        if (ftype === 'bytes') {
          assert.deepEqual(Array.from(b as Uint8Array), Array.from(a as Uint8Array), `${label} ${def.name}.${fname}`);
        } else {
          assert.equal(b, a, `${label} ${def.name}.${fname} (round ${round})`);
        }
      }
    }
  }
}

test('全部 C2S 包随机往返', () => {
  assert.ok(C2S.size >= 8, `C2S 只注册了 ${C2S.size} 个包`);
  roundTripAll(C2S, 'C2S');
});

test('全部 S2C 包随机往返', () => {
  assert.ok(S2C.size >= 10, `S2C 只注册了 ${S2C.size} 个包`);
  roundTripAll(S2C, 'S2C');
});

test('包 id 在各自方向内唯一', () => {
  const c2s = new Set(C2S.ids());
  const s2c = new Set(S2C.ids());
  assert.equal(c2s.size, C2S.size);
  assert.equal(s2c.size, S2C.size);
});

test('重复注册 id 或字段名会被拒绝', () => {
  const reg = new PacketRegistry();
  reg.add(definePacket(0x01, 'A', [['x', 'u8']]));
  assert.throws(() => reg.add(definePacket(0x01, 'B', [['y', 'u8']])), /已被/);
  assert.throws(() => definePacket(0x02, 'C', [['x', 'u8'], ['x', 'u16']]), /重复/);
  assert.throws(() => definePacket(999, 'D', []), RangeError);
});

test('解码后有残留字节会报错 —— 这是 schema 与实际写入不一致的信号', () => {
  const reg = new PacketRegistry();
  const def = reg.add(definePacket(0x01, 'Small', [['x', 'u8']]));
  const bytes = encodePacket(def, { x: 7 });
  const padded = new Uint8Array(bytes.length + 3);
  padded.set(bytes);
  assert.throws(() => decodePacket(reg, padded), /还剩 3 字节/);
});

test('未知包 id 报错而不是静默丢弃', () => {
  assert.throws(() => decodePacket(C2S, new Uint8Array([0xfe, 1, 2])), /未知的包 id/);
});

test('bytes 字段返回的是副本，不受后续缓冲复用影响', () => {
  const payload = new Uint8Array([9, 8, 7]);
  const bytes = encodePacket(S_ChunkData, { cx: 1, cz: 2, blob: payload });
  const decoded = decodePacket(S2C, bytes);
  const got = decoded.value['blob'] as Uint8Array;
  // 改动原始编码缓冲，解出来的内容不应跟着变
  bytes.fill(0);
  assert.deepEqual(Array.from(got), [9, 8, 7]);
});

// ---------------------------------------------------------------------------
// 通道层
// ---------------------------------------------------------------------------

test('PacketChannel 批量收发：一条消息里多个包不串位', async () => {
  const [a, b] = LoopbackTransport.createPair();
  const client = new PacketChannel(a, S2C);
  const server = new PacketChannel(b, C2S);

  const received: { name: string; value: Record<string, unknown> }[] = [];
  client.onPacket((name, value) => received.push({ name, value }));

  // 一个 tick 内攒多个包，flush 一次
  server.send(S_Login, {
    entityId: 42, dimension: 0, gameMode: 1, seed: 1234n,
    spawnX: 8.5, spawnY: 64, spawnZ: -8.5,
  });
  server.send(S_ChunkData, { cx: -3, cz: 5, blob: new Uint8Array([1, 2, 3]) });
  server.send(S_ChunkData, { cx: -3, cz: 6, blob: new Uint8Array(1000).fill(7) });
  server.flush();

  await new Promise((r) => setTimeout(r, 5));

  assert.equal(received.length, 3, '三个包都应到达');
  assert.equal(received[0]!.name, 'S_Login');
  assert.equal(received[0]!.value['entityId'], 42);
  assert.equal(received[1]!.name, 'S_ChunkData');
  assert.equal(received[1]!.value['cz'], 5);
  assert.equal(received[2]!.value['cz'], 6);
  assert.equal((received[2]!.value['blob'] as Uint8Array).length, 1000);
  assert.equal(server.packetsSent, 3);
  assert.equal(client.packetsReceived, 3);
});

test('PacketChannel 处理超过 u16 上限的大包 —— 前作正是栽在这里', async () => {
  const [a, b] = LoopbackTransport.createPair();
  const client = new PacketChannel(a, S2C);
  const server = new PacketChannel(b, C2S);
  const got: Uint8Array[] = [];
  client.onPacket((name, value) => {
    if (name === 'S_ChunkData') got.push(value['blob'] as Uint8Array);
  });

  // 100 KB，远超 u16 的 65535
  const big = new Uint8Array(100000);
  for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
  server.send(S_ChunkData, { cx: 0, cz: 0, blob: big });
  // 后面再跟一个小包，验证大包没把流冲错位
  server.send(S_ChunkData, { cx: 1, cz: 1, blob: new Uint8Array([0xaa]) });
  server.flush();
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(got.length, 2);
  assert.equal(got[0]!.length, 100000);
  assert.equal(got[0]![99999], 99999 & 0xff);
  assert.deepEqual(Array.from(got[1]!), [0xaa]);
});

test('LoopbackTransport 关闭后不再投递，且双向关闭', async () => {
  const [a, b] = LoopbackTransport.createPair();
  const client = new PacketChannel(a, S2C);
  const server = new PacketChannel(b, C2S);
  let closed = false;
  b.onClose(() => { closed = true; });

  let count = 0;
  client.onPacket(() => count++);
  server.send(S_Chat_stub(), { text: 'hi' });
  server.flush();
  await new Promise((r) => setTimeout(r, 5));
  const before = count;

  a.close();
  assert.equal(closed, true, '关闭一端应传播到另一端');
  server.send(S_Chat_stub(), { text: 'after close' });
  server.flush();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(count, before, '关闭后不应再收到包');
});

/** 取聊天包定义，单独抽出来避免上面的 import 列表过长 */
function S_Chat_stub(): typeof import('../../src/core/net/packets.ts').S_Chat {
  // 通过注册表按名字取，等价于直接 import S_Chat
  return S2C.getByName('S_Chat') as typeof import('../../src/core/net/packets.ts').S_Chat;
}

test('C_PlayerMove 的浮点字段精度符合预期', () => {
  // 位置用 f64（世界坐标可以很大且需要亚格精度），朝向用 f32 足够
  const value = { seq: 12345, x: -1234567.891, y: 63.5625, z: 987654.321, yaw: 1.5, pitch: -0.25, onGround: true, sneaking: false, sprinting: true };
  const decoded = decodePacket(C2S, encodePacket(C_PlayerMove, value)).value;
  assert.equal(decoded['x'], value.x, 'f64 位置必须精确往返');
  assert.equal(decoded['z'], value.z);
  assert.equal(decoded['yaw'], value.yaw);
  assert.equal(decoded['sprinting'], true);
});
