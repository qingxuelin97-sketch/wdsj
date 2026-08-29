/**
 * 游程编码。
 *
 * 除了往返正确，还要盯住**压缩率**：存档路径选 RLE 而不是不压缩，
 * 唯一的理由就是它对体素数据够有效（见 core/world/rle.ts 顶部的算账）。
 * 哪天有人改坏了编码逻辑、让它退化成"每格一条游程"，往返测试照样过，
 * 而 400 区块存读会从几百毫秒变成十几秒。所以这里直接断言压缩率。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rleEncode16, rleEncode8, rleDecode16, rleDecode8 } from '../../src/core/world/rle.ts';
import { JavaRandom } from '../../src/core/rng/java-random.ts';

test('u16 往返：全同、全异、边界值', () => {
  const cases: Uint16Array[] = [
    new Uint16Array(4096),                                     // 全 0
    Uint16Array.from({ length: 4096 }, () => 0xffff),          // 全满
    Uint16Array.from({ length: 4096 }, (_, i) => i & 0xffff),  // 全不同
    Uint16Array.from({ length: 300 }, (_, i) => (i < 150 ? 1 : 2)),
    new Uint16Array(0),
  ];
  for (const src of cases) {
    const back = rleDecode16(rleEncode16(src), src.length);
    assert.deepEqual([...back], [...src], `长度 ${src.length} 的数组往返失败`);
  }
});

test('u8 往返', () => {
  const src = Uint8Array.from({ length: 4096 }, (_, i) => (i >> 6) & 0xff);
  assert.deepEqual([...rleDecode8(rleEncode8(src), src.length)], [...src]);
});

test('超过 127 的游程要用多字节 varint', () => {
  // 4096 个相同值 = 一条长度 4096 的游程，varint 要两个字节
  const src = new Uint16Array(4096).fill(7);
  const encoded = rleEncode16(src);
  assert.equal(encoded.length, 4, '一条游程：2 字节 varint + 2 字节值');
  assert.deepEqual([...rleDecode16(encoded, 4096)], [...src]);
});

test('体素式数据的压缩率要好于 10%', () => {
  // 造一个像样的子区块：下半实心石头，中间一层泥土，上半空气 —— 典型地下剖面
  const states = new Uint16Array(4096);
  for (let i = 0; i < 4096; i++) {
    const y = i >> 8;
    states[i] = y < 8 ? 1 : y < 10 ? 3 : 0;
  }
  const ratio = rleEncode16(states).length / (states.length * 2);
  assert.ok(ratio < 0.1, `压缩率 ${(ratio * 100).toFixed(2)}% 应该远好于 10%`);

  // 光照：天光在上半是 15，下半是 0
  const light = new Uint8Array(4096);
  for (let i = 0; i < 4096; i++) light[i] = (i >> 8) >= 10 ? 0xf0 : 0;
  assert.ok(rleEncode8(light).length / light.length < 0.1);
});

test('模糊往返：带长短游程的随机数据', () => {
  const rng = new JavaRandom(4096);
  for (let round = 0; round < 200; round++) {
    const n = 1 + rng.nextInt(2000);
    const src = new Uint16Array(n);
    let i = 0;
    while (i < n) {
      // 一半的机会来一段长游程，一半的机会来一串各不相同的值 ——
      // 只测随机数据的话，长游程路径（多字节 varint）根本走不到
      const run = rng.nextBoolean() ? 1 + rng.nextInt(3) : 1 + rng.nextInt(400);
      const v = rng.nextInt(65536);
      for (let k = 0; k < run && i < n; k++, i++) src[i] = v;
    }
    const back = rleDecode16(rleEncode16(src), n);
    assert.deepEqual([...back], [...src], `第 ${round} 轮往返不一致（长度 ${n}）`);
  }
});

test('截断的数据不抛异常，只是读到的内容不全', () => {
  // 存档里一个坏字节不该让整个世界读不出来
  const src = Uint16Array.from({ length: 100 }, (_, i) => i);
  const encoded = rleEncode16(src);
  const truncated = encoded.subarray(0, Math.floor(encoded.length / 2));
  const back = rleDecode16(truncated, 100);
  assert.equal(back.length, 100, '长度由调用方决定，不受损坏影响');
});
