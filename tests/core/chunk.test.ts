/**
 * 区块数据结构与编解码验证。
 *
 * 编解码往返用随机内容做模糊测试：它同时是网络协议和存档格式，
 * 一旦有偏差就是"世界莫名其妙缺一块"或"存档读出来不对"，且极难复现。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Chunk, ChunkSection, SECTION_VOLUME, AIR_STATE,
  packState, stateId, stateMeta, withMeta,
  sectionIndex, columnIndex, chunkKey, keyToCx, keyToCz,
  toChunkCoord, toLocalCoord,
} from '../../src/core/world/chunk.ts';
import { encodeChunk, decodeChunk } from '../../src/core/world/chunk-codec.ts';
import { ChunkStore } from '../../src/core/world/block-view.ts';
import { WORLD_HEIGHT, SECTIONS_PER_COLUMN } from '../../src/core/constants.ts';
import { JavaRandom } from '../../src/core/rng/java-random.ts';

test('方块状态打包：id 与 meta 互不干扰', () => {
  for (const id of [0, 1, 122, 1000, 4095]) {
    for (const meta of [0, 1, 7, 15]) {
      const s = packState(id, meta);
      assert.equal(stateId(s), id, `id=${id} meta=${meta}`);
      assert.equal(stateMeta(s), meta, `id=${id} meta=${meta}`);
      assert.ok(s >= 0 && s <= 0xffff, `状态 ${s} 应能装进 u16`);
    }
  }
  // withMeta 只改 meta
  const s = packState(122, 3);
  assert.equal(stateId(withMeta(s, 9)), 122);
  assert.equal(stateMeta(withMeta(s, 9)), 9);
  // 空气恒为 0，这样 new Uint16Array 出来就是全空气
  assert.equal(packState(0, 0), AIR_STATE);
});

test('下标计算无碰撞且覆盖全部格子', () => {
  const seen = new Set<number>();
  for (let y = 0; y < 16; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const i = sectionIndex(x, y, z);
        assert.ok(i >= 0 && i < SECTION_VOLUME, `下标 ${i} 越界`);
        assert.ok(!seen.has(i), `下标 ${i} 重复 (${x},${y},${z})`);
        seen.add(i);
      }
    }
  }
  assert.equal(seen.size, SECTION_VOLUME);

  const seen2 = new Set<number>();
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) seen2.add(columnIndex(x, z));
  assert.equal(seen2.size, 256);
});

test('区块 key 是双射，含负坐标', () => {
  const coords = [0, 1, -1, 15, -15, 1000, -1000, 8388607, -8388608];
  const seen = new Set<number>();
  for (const cx of coords) {
    for (const cz of coords) {
      const k = chunkKey(cx, cz);
      assert.ok(Number.isSafeInteger(k), `key ${k} 不是安全整数`);
      assert.ok(!seen.has(k), `key 冲突 (${cx},${cz})`);
      seen.add(k);
      assert.equal(keyToCx(k), cx, `cx 还原 (${cx},${cz})`);
      assert.equal(keyToCz(k), cz, `cz 还原 (${cx},${cz})`);
    }
  }
});

test('世界坐标到区块/局部坐标的换算，负坐标也对', () => {
  const cases: [number, number, number][] = [
    [0, 0, 0], [15, 0, 15], [16, 1, 0], [31, 1, 15],
    [-1, -1, 15], [-16, -1, 0], [-17, -2, 15], [-32, -2, 0],
  ];
  for (const [world, chunk, local] of cases) {
    assert.equal(toChunkCoord(world), chunk, `toChunkCoord(${world})`);
    assert.equal(toLocalCoord(world), local, `toLocalCoord(${world})`);
    // 换算必须自洽
    assert.equal(chunk * 16 + local, world, `重建 ${world}`);
  }
});

test('ChunkSection 维护 nonAir 计数', () => {
  const s = new ChunkSection();
  assert.equal(s.nonAir, 0);
  assert.ok(s.isEmpty);

  s.set(1, 2, 3, packState(1));
  assert.equal(s.nonAir, 1);
  assert.ok(!s.isEmpty);

  s.set(1, 2, 3, packState(2)); // 换成别的方块，计数不变
  assert.equal(s.nonAir, 1);

  s.set(1, 2, 3, AIR_STATE); // 挖掉
  assert.equal(s.nonAir, 0);
  assert.ok(s.isEmpty);
});

test('ChunkSection 光照的高低半字节互不干扰', () => {
  const s = new ChunkSection();
  s.setSkyLight(4, 5, 6, 15);
  s.setBlockLight(4, 5, 6, 7);
  assert.equal(s.getSkyLight(4, 5, 6), 15);
  assert.equal(s.getBlockLight(4, 5, 6), 7);
  s.setSkyLight(4, 5, 6, 3);
  assert.equal(s.getSkyLight(4, 5, 6), 3);
  assert.equal(s.getBlockLight(4, 5, 6), 7, '改天光不应动方块光');
});

test('空气段不分配子区块', () => {
  const c = new Chunk(0, 0);
  assert.equal(c.getState(0, 50, 0), AIR_STATE);
  assert.equal(c.sections[3], null, '只读不该触发分配');
  c.setState(0, 50, 0, AIR_STATE);
  assert.equal(c.sections[3], null, '往空气段写空气也不该分配');
  c.setState(0, 50, 0, packState(1));
  assert.notEqual(c.sections[3], null, '写实体方块才分配');
});

test('heightmap 增量维护与全量重算一致', () => {
  const c = new Chunk(0, 0);
  const rng = new JavaRandom(4242);
  // 随机堆一些方块
  for (let i = 0; i < 400; i++) {
    const x = rng.nextInt(16);
    const z = rng.nextInt(16);
    const y = rng.nextInt(WORLD_HEIGHT);
    c.setState(x, y, z, packState(1 + rng.nextInt(5)));
  }
  const incremental = Uint8Array.from(c.heightmap);
  c.recomputeHeightmap();
  assert.deepEqual(Array.from(c.heightmap), Array.from(incremental), '放置阶段的增量高度应与重算一致');

  // 再随机挖掉一些，其中包含最高块
  for (let i = 0; i < 300; i++) {
    const x = rng.nextInt(16);
    const z = rng.nextInt(16);
    const h = c.getHeight(x, z);
    if (h === 0) continue;
    c.setState(x, h - 1, z, AIR_STATE); // 专挖最高块，逼出向下扫描分支
  }
  const afterBreak = Uint8Array.from(c.heightmap);
  c.recomputeHeightmap();
  assert.deepEqual(Array.from(c.heightmap), Array.from(afterBreak), '破坏阶段的增量高度应与重算一致');
});

test('越界 y 的读写被安全忽略', () => {
  const c = new Chunk(0, 0);
  assert.equal(c.getState(0, -1, 0), AIR_STATE);
  assert.equal(c.getState(0, WORLD_HEIGHT, 0), AIR_STATE);
  assert.equal(c.setState(0, -1, 0, packState(1)), AIR_STATE);
  assert.equal(c.setState(0, WORLD_HEIGHT + 10, 0, packState(1)), AIR_STATE);
});

test('编解码往返：随机内容逐格一致', () => {
  const rng = new JavaRandom(31337);
  for (let round = 0; round < 5; round++) {
    const c = new Chunk(round * 3 - 4, round * -7 + 2);
    // 造一个有层次的区块：底部实心、中部散点、上部空
    for (let y = 0; y < 40; y++) {
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          const id = y < 20 ? 1 + rng.nextInt(3) : rng.nextInt(10) === 0 ? 1 + rng.nextInt(6) : 0;
          if (id !== 0) c.setState(x, y, z, packState(id, rng.nextInt(16)));
        }
      }
    }
    for (let i = 0; i < 256; i++) c.biomes[i] = rng.nextInt(8);
    // 随机光照
    for (const s of c.sections) {
      if (s == null) continue;
      for (let i = 0; i < SECTION_VOLUME; i++) s.light[i] = rng.nextInt(256);
    }

    const bytes = encodeChunk(c);
    const back = decodeChunk(c.cx, c.cz, bytes);

    assert.equal(back.cx, c.cx);
    assert.equal(back.cz, c.cz);
    assert.deepEqual(Array.from(back.biomes), Array.from(c.biomes), `round ${round} 群系`);
    assert.deepEqual(Array.from(back.heightmap), Array.from(c.heightmap), `round ${round} 高度图`);
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          assert.equal(back.getState(x, y, z), c.getState(x, y, z), `round ${round} 方块 (${x},${y},${z})`);
        }
      }
    }
    for (let sy = 0; sy < SECTIONS_PER_COLUMN; sy++) {
      const a = c.sections[sy];
      const b = back.sections[sy];
      if (a == null || a.isEmpty) continue;
      assert.notEqual(b, null, `round ${round} 段 ${sy} 丢失`);
      assert.deepEqual(Array.from(b!.light), Array.from(a.light), `round ${round} 段 ${sy} 光照`);
    }
  }
});

test('编解码往返：调色板超过 255 项时走原始 u16 分支', () => {
  const c = new Chunk(0, 0);
  // 塞进 300 种不同状态，逼出无调色板分支
  let n = 0;
  for (let y = 0; y < 16 && n < 300; y++) {
    for (let z = 0; z < 16 && n < 300; z++) {
      for (let x = 0; x < 16 && n < 300; x++) {
        c.setState(x, y, z, packState(1 + (n % 200), n % 16));
        n++;
      }
    }
  }
  const back = decodeChunk(0, 0, encodeChunk(c));
  for (let y = 0; y < 16; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        assert.equal(back.getState(x, y, z), c.getState(x, y, z), `(${x},${y},${z})`);
      }
    }
  }
});

test('全空区块编码后很小，且能还原', () => {
  const c = new Chunk(5, -5);
  const bytes = encodeChunk(c);
  // 只有 mask + heightmap + biomes
  assert.equal(bytes.length, 2 + 256 + 256);
  const back = decodeChunk(5, -5, bytes);
  for (const s of back.sections) assert.equal(s, null);
});

test('ChunkStore 跨区块读写与未加载处理', () => {
  const store = new ChunkStore();
  assert.equal(store.getState(0, 64, 0), AIR_STATE, '未加载应返回空气');
  assert.equal(store.setState(0, 64, 0, packState(1)), false, '未加载写入应返回 false');
  assert.equal(store.isLoaded(0, 0), false);

  store.createChunk(0, 0);
  store.createChunk(-1, 0);
  assert.equal(store.setState(5, 64, 5, packState(1)), true);
  assert.equal(store.getState(5, 64, 5), packState(1));

  // 负坐标落到 (-1,0) 区块
  assert.equal(store.setState(-3, 64, 5, packState(2)), true);
  assert.equal(store.getState(-3, 64, 5), packState(2));
  assert.equal(store.getChunk(-1, 0)!.getState(13, 64, 5), packState(2), '应写在 (-1,0) 区块的局部 x=13');

  // 世界之上恒满天光，之下恒无 —— 让光照 BFS 不必特判边界
  assert.equal(store.getSkyLight(5, WORLD_HEIGHT, 5), 15);
  assert.equal(store.getSkyLight(5, -1, 5), 0);
});

test('ChunkStore 的区块缓存在增删后不会返回失效对象', () => {
  const store = new ChunkStore();
  const a = store.createChunk(0, 0);
  assert.equal(store.getChunk(0, 0), a);
  store.removeChunk(0, 0);
  assert.equal(store.getChunk(0, 0), null, '删除后缓存必须失效');
  const b = store.createChunk(0, 0);
  assert.equal(store.getChunk(0, 0), b);
  assert.notEqual(b, a);
});
