/**
 * 光照引擎接进服务端世界之后的验收。
 *
 * 单元测试（tests/core/light.test.ts）验的是算法本身；这里验的是它和
 * 区块存储、编解码、增量更新接在一起之后还成不成立 —— 那正是出过事的地方。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerWorld } from '../../src/server/world/server-world.ts';
import { createBlockRegistry } from '../../src/content/blocks.ts';
import { encodeChunk, decodeChunk } from '../../src/core/world/chunk-codec.ts';
import { packState, AIR_STATE, stateId } from '../../src/core/world/chunk.ts';
import { JavaRandom } from '../../src/core/rng/java-random.ts';
import { MAX_LIGHT, WORLD_HEIGHT, CHUNK_SIZE } from '../../src/core/constants.ts';

const registry = createBlockRegistry();

function makeWorld(radius = 1): ServerWorld {
  const world = new ServerWorld(1234n, registry);
  world.generationQuota = 0;
  for (let cz = -radius; cz <= radius; cz++) {
    for (let cx = -radius; cx <= radius; cx++) world.forceChunk(cx, cz);
  }
  world.updateLighting();
  return world;
}

test('生成出来的世界：地表以上满天光，地底全黑', () => {
  const world = makeWorld();
  let checked = 0;
  for (let z = -8; z <= 8; z += 3) {
    for (let x = -8; x <= 8; x += 3) {
      const h = world.store.getHeight(x, z);
      assert.equal(world.store.getSkyLight(x, h, z), MAX_LIGHT, `(${x},${h},${z}) 地表之上应满天光`);
      assert.equal(world.store.getSkyLight(x, WORLD_HEIGHT - 1, z), MAX_LIGHT, '天顶应满天光');
      assert.equal(world.store.getSkyLight(x, 3, z), 0, `(${x},3,${z}) 基岩附近应全黑`);
      checked++;
    }
  }
  assert.ok(checked >= 36, '抽样点太少');
});

test('区块编解码保住光照 —— 包括没有分配子区块的那些高度', () => {
  // 这条是真出过事的：地表之上的空气段不会被分配，服务端按"隐含满天光"读到 15，
  // 而客户端解出来的区块若不认这条规则就会读到 0。同一格两边不一致，
  // 光照当场分叉，而且只在高空才显形 —— 从画面上几乎看不出来。
  const world = makeWorld();
  const chunk = world.store.getChunk(0, 0)!;
  const decoded = decodeChunk(0, 0, encodeChunk(chunk));

  let mismatches = 0;
  let sampled = 0;
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    for (let z = 0; z < CHUNK_SIZE; z += 5) {
      for (let x = 0; x < CHUNK_SIZE; x += 5) {
        sampled++;
        if (chunk.getSkyLight(x, y, z) !== decoded.getSkyLight(x, y, z)) mismatches++;
        if (chunk.getBlockLight(x, y, z) !== decoded.getBlockLight(x, y, z)) mismatches++;
      }
    }
  }
  assert.equal(mismatches, 0, `往返后有 ${mismatches}/${sampled} 处光照对不上`);
  assert.ok(sampled > 1000, '抽样太少');
});

test('放一个实心方块会挡住它下方整列的天光', () => {
  const world = makeWorld();
  const x = 4;
  const z = 4;
  const h = world.store.getHeight(x, z);
  const y = h + 5; // 悬在地表上方的空中

  assert.equal(world.store.getSkyLight(x, y, z), MAX_LIGHT, '前提：那里本来见天');
  assert.equal(world.store.getSkyLight(x, h, z), MAX_LIGHT, '前提：地表也见天');

  world.setBlock(x, y, z, packState(registry.idOf('stone')));

  assert.equal(world.store.getSkyLight(x, y, z), 0, '方块内部无光');
  // 下方不再直接见天，靠四周渗过来，所以比满值暗
  assert.ok(world.store.getSkyLight(x, h, z) < MAX_LIGHT, '正下方应变暗');
  assert.ok(world.store.getSkyLight(x, h, z) > 0, '只挡一格，四周的光要能补进来');
  // 隔一格的邻居仍然直接见天
  assert.equal(world.store.getSkyLight(x + 2, h, z), MAX_LIGHT, '旁边两格不受影响');
});

test('挖出的竖坑底部仍是满天光，填回去又归零 —— 增量更新可逆', () => {
  const world = makeWorld();
  const x = -3;
  const z = 5;
  const h = world.store.getHeight(x, z);
  const top = world.store.getState(x, h - 1, z);
  const second = world.store.getState(x, h - 2, z);

  // 挖之前这两格是实心的，没有光
  assert.equal(world.store.getSkyLight(x, h - 2, z), 0, '前提：地表以下是实心且无光');

  world.setBlock(x, h - 1, z, AIR_STATE);
  world.setBlock(x, h - 2, z, AIR_STATE);

  // 坑底直接见天，所以是**满值**而不是逐格衰减 ——
  // 这正是 MC 里十格深的竖井底部依然是 15 的原因（heightmap 决定，不是垂直传播）
  assert.equal(world.store.getSkyLight(x, h - 1, z), MAX_LIGHT, '坑口满天光');
  assert.equal(world.store.getSkyLight(x, h - 2, z), MAX_LIGHT, '坑底同样满天光');

  world.setBlock(x, h - 2, z, second);
  world.setBlock(x, h - 1, z, top);
  assert.equal(world.store.getSkyLight(x, h - 2, z), 0, '填回去应完全恢复原值');
  assert.equal(world.store.getHeight(x, z), h, '列高也要恢复');
});

test('发光方块的光照按 MC 曲线向外衰减，且能被移除干净', () => {
  const world = makeWorld();
  const x = 6;
  const z = -6;
  const y = world.store.getHeight(x, z) + 2;
  const before = world.store.getState(x, y, z);

  world.setBlock(x, y, z, packState(registry.idOf('glowstone')));
  assert.equal(world.store.getBlockLight(x, y, z), 15, '萤石自身 15');
  assert.equal(world.store.getBlockLight(x + 1, y, z), 14, '相邻一格 14');
  assert.equal(world.store.getBlockLight(x + 5, y, z), 10, '五格外 10');
  assert.equal(world.store.getBlockLight(x + 15, y, z), 0, '十五格外归零');

  world.setBlock(x, y, z, before);
  assert.equal(world.store.getBlockLight(x, y, z), 0, '拿掉后自身归零');
  assert.equal(world.store.getBlockLight(x + 1, y, z), 0, '周围也要恢复黑暗');
});

/**
 * 取若干次测量里最快的那次。
 *
 * 时间断言在并行跑测的机器上会被别的进程干扰 —— 实测同一段代码
 * 独占时 0.38 ms、和另一套测试抢 CPU 时 4.7 ms，差了十二倍。
 * 取最小值等于"这台机器在最好的情况下能跑多快"，而那正是想测的东西：
 * 算法有没有退化。被别的进程拖慢不是回退。
 */
function fastestOf(times: number, fn: () => number): number {
  let best = Infinity;
  for (let i = 0; i < times; i++) best = Math.min(best, fn());
  return best;
}

test('光照开销：播种与增量更新都在预算内', () => {
  const n = 25;
  // 一个 tick 最多生成 generationQuota(6) 个区块，光照预算 5 ms/tick
  // -> 每区块要低于 0.83 ms。放宽到 3 ms，只拦数量级的回退
  const perChunk = fastestOf(3, () => {
    const world = new ServerWorld(4321n, registry);
    world.generationQuota = 0;
    for (let cz = -2; cz <= 2; cz++) for (let cx = -2; cx <= 2; cx++) world.forceChunk(cx, cz);
    const t0 = performance.now();
    world.updateLighting();
    return (performance.now() - t0) / n;
  });
  assert.ok(perChunk < 3, `播种 ${perChunk.toFixed(2)} ms/区块，超出数量级预算`);

  const stone = packState(registry.idOf('stone'));
  const edits = 200;
  const perEdit = fastestOf(3, () => {
    const world = new ServerWorld(4321n, registry);
    world.generationQuota = 0;
    for (let cz = -2; cz <= 2; cz++) for (let cx = -2; cx <= 2; cx++) world.forceChunk(cx, cz);
    world.updateLighting();
    const rng = new JavaRandom(7);
    const t1 = performance.now();
    for (let i = 0; i < edits; i++) {
      const x = rng.nextInt(60) - 30;
      const z = rng.nextInt(60) - 30;
      const y = 55 + rng.nextInt(20);
      world.setBlock(x, y, z, rng.nextInt(2) === 0 ? AIR_STATE : stone);
    }
    return (performance.now() - t1) / edits;
  });
  assert.ok(perEdit < 1, `增量更新 ${perEdit.toFixed(3)} ms/次，超出数量级预算`);
  void stateId;
});
