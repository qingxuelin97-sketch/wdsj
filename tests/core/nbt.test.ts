/**
 * NBT 编解码。
 *
 * 重点是**模糊往返**：随机造出深度嵌套的结构，编码再解码，逐字段比对。
 * 存档格式的 bug 通常不在常见路径上，而在负数、空列表、空字符串、
 * 深嵌套这些角落 —— 而它们出问题的时候，表现是"读存档时世界少了一块"，
 * 追起来极难。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nbt, encodeNbt, decodeNbt, TagType,
  getInt, getDouble, getLong, getString, getBytes, getList, getCompound,
  type NbtValue,
} from '../../src/core/nbt/nbt.ts';
import { JavaRandom } from '../../src/core/rng/java-random.ts';

test('各种标量往返', () => {
  const root = nbt.compound({
    b: nbt.byte(-5),
    s: nbt.short(-30000),
    i: nbt.int(-123456),
    l: nbt.long(-9007199254740993n),
    f: nbt.float(0.5),
    d: nbt.double(-1234.5678),
    str: nbt.string('你好，世界'),
  });
  const { name, value } = decodeNbt(encodeNbt('root', root));
  assert.equal(name, 'root');
  assert.equal(getInt(value, 'b'), -5, '负数字节必须还原成负数');
  assert.equal(getInt(value, 's'), -30000);
  assert.equal(getInt(value, 'i'), -123456);
  assert.equal(getLong(value, 'l'), -9007199254740993n, '超出 double 精度的整数要用 bigint');
  assert.equal(getDouble(value, 'f'), 0.5);
  assert.equal(getDouble(value, 'd'), -1234.5678);
  assert.equal(getString(value, 'str'), '你好，世界', '非 ASCII 字符串要能往返');
});

test('字节数组与整型数组往返', () => {
  const bytes = new Uint8Array([0, 1, 127, 128, 255]);
  const ints = Int32Array.from([0, -1, 2147483647, -2147483648]);
  const root = nbt.compound({ b: nbt.bytes(bytes), i: nbt.ints(ints) });
  const { value } = decodeNbt(encodeNbt('', root));
  assert.deepEqual([...getBytes(value, 'b')!], [...bytes]);
  const back = getCompound(value, 'nope');
  assert.equal(back, null, '取不存在的键应返回 null 而不是抛错');
  const iv = (value.type === TagType.COMPOUND ? value.value.get('i') : null)!;
  assert.equal(iv.type, TagType.INT_ARRAY);
  assert.deepEqual([...(iv.value as Int32Array)], [...ints]);
});

test('空列表、空字符串、空复合都要能往返', () => {
  const root = nbt.compound({
    emptyList: nbt.list(TagType.INT, []),
    emptyStr: nbt.string(''),
    emptyCompound: nbt.compound({}),
    emptyBytes: nbt.bytes(new Uint8Array(0)),
  });
  const { value } = decodeNbt(encodeNbt('', root));
  assert.equal(getList(value, 'emptyList').length, 0);
  assert.equal(getString(value, 'emptyStr'), '');
  assert.equal(getBytes(value, 'emptyBytes')!.length, 0);
  const c = getCompound(value, 'emptyCompound');
  assert.ok(c !== null && c.type === TagType.COMPOUND && c.value.size === 0);
});

test('嵌套列表与复合', () => {
  const root = nbt.compound({
    items: nbt.list(TagType.COMPOUND, [
      nbt.compound({ id: nbt.int(1), count: nbt.byte(64) }),
      nbt.compound({ id: nbt.int(264), count: nbt.byte(1) }),
    ]),
    nested: nbt.compound({
      inner: nbt.compound({ deep: nbt.list(TagType.STRING, [nbt.string('a'), nbt.string('b')]) }),
    }),
  });
  const { value } = decodeNbt(encodeNbt('', root));
  const items = getList(value, 'items');
  assert.equal(items.length, 2);
  assert.equal(getInt(items[1]!, 'id'), 264);
  assert.equal(getInt(items[0]!, 'count'), 64);
  const deep = getList(getCompound(getCompound(value, 'nested')!, 'inner')!, 'deep');
  assert.deepEqual(deep.map((d) => (d.type === TagType.STRING ? d.value : '')), ['a', 'b']);
});

test('模糊往返：随机深嵌套结构逐字段相等', () => {
  const rng = new JavaRandom(20260829);

  function randomValue(depth: number): NbtValue {
    const kinds = depth > 3 ? 7 : 10;
    switch (rng.nextInt(kinds)) {
      case 0: return nbt.byte(rng.nextInt(256) - 128);
      case 1: return nbt.short(rng.nextInt(65536) - 32768);
      case 2: return nbt.int(rng.nextInt(2000000) - 1000000);
      case 3: return nbt.long(BigInt(rng.nextInt(1000000)) * 1000000n - 500000000000n);
      case 4: return nbt.double(rng.nextInt(1000000) / 1000 - 500);
      case 5: return nbt.string(randomString());
      case 6: {
        const n = rng.nextInt(8);
        const arr = new Uint8Array(n);
        for (let i = 0; i < n; i++) arr[i] = rng.nextInt(256);
        return nbt.bytes(arr);
      }
      case 7: {
        const n = rng.nextInt(4);
        const items: NbtValue[] = [];
        for (let i = 0; i < n; i++) items.push(nbt.int(rng.nextInt(1000)));
        return nbt.list(TagType.INT, items);
      }
      case 8: {
        const n = rng.nextInt(3);
        const arr = new Int32Array(n);
        for (let i = 0; i < n; i++) arr[i] = rng.nextInt(100000) - 50000;
        return nbt.ints(arr);
      }
      default: {
        const entries: Record<string, NbtValue> = {};
        const n = rng.nextInt(4);
        for (let i = 0; i < n; i++) entries[`k${i}`] = randomValue(depth + 1);
        return nbt.compound(entries);
      }
    }
  }
  function randomString(): string {
    const n = rng.nextInt(10);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(0x4e00 + rng.nextInt(200));
    return s;
  }

  for (let round = 0; round < 200; round++) {
    const root = randomValue(0);
    const encoded = encodeNbt('t', root);
    const decoded = decodeNbt(encoded).value;
    assert.equal(describe(decoded), describe(root), `第 ${round} 轮往返不一致`);
    // 再编码一次必须逐字节相同 —— 这条比结构相等更严，能抓住"读时补了默认值"
    const again = encodeNbt('t', decoded);
    assert.deepEqual([...again], [...encoded], `第 ${round} 轮二次编码不一致`);
  }
});

/** 把一个标签变成可比较的字符串 */
function describe(v: NbtValue): string {
  switch (v.type) {
    case TagType.BYTE_ARRAY: return `ba[${[...v.value].join(',')}]`;
    case TagType.INT_ARRAY: return `ia[${[...v.value].join(',')}]`;
    case TagType.LIST: return `l${v.elementType}[${v.value.map(describe).join(',')}]`;
    case TagType.COMPOUND:
      return `c{${[...v.value].map(([k, x]) => `${k}=${describe(x)}`).sort().join(',')}}`;
    case TagType.LONG: return `L${v.value}`;
    default: return `${v.type}:${String(v.value)}`;
  }
}
