/**
 * 光照引擎验收。
 *
 * 核心是**增量更新与全量重算逐格比对**：随机造一个世界，随机放置/破坏方块，
 * 每次都用增量更新维护光照，最后与"清空后从头算一遍"的结果逐格对比。
 *
 * 这是验证光照引擎唯一可靠的办法。increase/decrease 双队列的错误几乎都不会
 * 立刻显形 —— 表现是"某个角落偶尔偏暗一格"，肉眼几乎看不出来，等到玩家
 * 报告"我家里莫名其妙刷怪"时已经无从复现。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LightEngine, LightChannel, type LightTables } from '../../src/core/light/light-engine.ts';
import { ChunkStore } from '../../src/core/world/block-view.ts';
import { packState, AIR_STATE, stateId } from '../../src/core/world/chunk.ts';
import { JavaRandom } from '../../src/core/rng/java-random.ts';
import { MAX_LIGHT, WORLD_HEIGHT, CHUNK_SIZE, SECTIONS_PER_COLUMN } from '../../src/core/constants.ts';

// 测试用方块表：
//   1 = 石头（不透光）  2 = 玻璃（全透光）  3 = 树叶（衰减 1）
//   4 = 火把（发光 14，不挡光）  5 = 萤石（发光 15，挡光）
const NUM_IDS = 8;
function makeTables(): LightTables {
  const opacity = new Uint8Array(NUM_IDS);
  const lightEmission = new Uint8Array(NUM_IDS);
  opacity[1] = 15;
  opacity[2] = 0;
  opacity[3] = 1;
  opacity[4] = 0;
  lightEmission[4] = 14;
  opacity[5] = 15;
  lightEmission[5] = 15;
  return { opacity, lightEmission };
}
const TABLES = makeTables();

/** 建一个 n×n 区块的空世界 */
function makeWorld(chunkRadius = 1): ChunkStore {
  const store = new ChunkStore();
  for (let cz = -chunkRadius; cz <= chunkRadius; cz++) {
    for (let cx = -chunkRadius; cx <= chunkRadius; cx++) store.createChunk(cx, cz);
  }
  return store;
}

/**
 * 全量重算：清空所有光照，再从零算一遍。
 * 这是比对基准，实现刻意写得直白，不追求效率。
 */
function fullRecompute(store: ChunkStore): void {
  for (const chunk of store.chunkValues()) {
    for (let sy = 0; sy < SECTIONS_PER_COLUMN; sy++) {
      const section = chunk.sections[sy];
      if (section != null) section.light.fill(0);
    }
  }

  // 光照要开始建立了：此后新分配的子区块按隐含值预置天光。
  // 生成期间不能预置（那时 heightmap 还在变），见 Chunk.createSectionWithSky。
  for (const chunk of store.chunkValues()) chunk.lightReady = true;

  const engine = new LightEngine(store, TABLES);

  // 天光：每列找出最高的挡光方块，它之上的格子直接见天（满值），再横向扩散。
  // 这里刻意不调 engine.seedSky，自己独立算一遍 heightmap —— 基准实现
  // 复用被测代码的话就测不出什么了。
  for (const chunk of store.chunkValues()) {
    const baseX = chunk.cx * CHUNK_SIZE;
    const baseZ = chunk.cz * CHUNK_SIZE;
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        let height = 0;
        for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
          const id = stateId(store.getState(baseX + x, y, baseZ + z));
          const op = id === 0 ? 0 : (TABLES.opacity[id] ?? MAX_LIGHT);
          if (op > 0) { height = y + 1; break; }
        }
        for (let y = height; y < WORLD_HEIGHT; y++) {
          engine.addSource(LightChannel.SKY, baseX + x, y, baseZ + z, MAX_LIGHT);
        }
      }
    }
  }
  engine.propagate(LightChannel.SKY);

  // 方块光：每个发光方块作为源
  for (const chunk of store.chunkValues()) {
    const baseX = chunk.cx * CHUNK_SIZE;
    const baseZ = chunk.cz * CHUNK_SIZE;
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
          const id = stateId(store.getState(baseX + x, y, baseZ + z));
          const emission = id === 0 ? 0 : (TABLES.lightEmission[id] ?? 0);
          if (emission > 0) engine.addSource(LightChannel.BLOCK, baseX + x, y, baseZ + z, emission);
        }
      }
    }
  }
  engine.propagate(LightChannel.BLOCK);
}

/** 逐格比对两份光照快照 */
function snapshot(store: ChunkStore, minY: number, maxY: number): string[] {
  const out: string[] = [];
  for (const chunk of store.chunkValues()) {
    const baseX = chunk.cx * CHUNK_SIZE;
    const baseZ = chunk.cz * CHUNK_SIZE;
    for (let y = minY; y <= maxY; y++) {
      for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
          const wx = baseX + x;
          const wz = baseZ + z;
          out.push(`${wx},${y},${wz}=${store.getSkyLight(wx, y, wz)}/${store.getBlockLight(wx, y, wz)}`);
        }
      }
    }
  }
  return out;
}

function assertSameLight(a: string[], b: string[], label: string): void {
  assert.equal(a.length, b.length, `${label} 快照长度不同`);
  const diffs: string[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) diffs.push(`增量=${a[i]} 全量=${b[i]}`);
    if (diffs.length > 8) break;
  }
  assert.equal(diffs.length, 0, `${label}：${diffs.length} 处光照不一致\n${diffs.join('\n')}`);
}

// ---------------------------------------------------------------------------

test('见天的格子直接满天光；被不透光方块盖住则归零', () => {
  const store = makeWorld(0);
  // 在 y=70 铺一层石头
  for (let z = 0; z < CHUNK_SIZE; z++) {
    for (let x = 0; x < CHUNK_SIZE; x++) store.setState(x, 70, z, packState(1));
  }
  fullRecompute(store);

  assert.equal(store.getSkyLight(8, 71, 8), MAX_LIGHT, '石板上方应为满天光');
  assert.equal(store.getSkyLight(8, 100, 8), MAX_LIGHT, '高空应为满天光');
  // 注意这不是"垂直传播不衰减"的结果，而是这些格子在 heightmap 之上、直接见天。
  // 竖井底部之所以也是满天光，是同一个原因。
  assert.equal(store.getSkyLight(8, 70, 8), 0, '石头内部无光');
  // 正下方被完全遮挡，且四周也是石头，所以应为 0
  assert.equal(store.getSkyLight(8, 69, 8), 0, '石板正下方中心应全黑');
});

test('天光能从缺口横向渗进屋檐下', () => {
  const store = makeWorld(0);
  // 铺一层石头，但在 x=0 那一列留空（相当于屋檐边缘）
  for (let z = 0; z < CHUNK_SIZE; z++) {
    for (let x = 1; x < CHUNK_SIZE; x++) store.setState(x, 70, z, packState(1));
  }
  fullRecompute(store);

  // x=0 是敞开的，满天光
  assert.equal(store.getSkyLight(0, 69, 8), MAX_LIGHT);
  // 往里逐格衰减
  assert.equal(store.getSkyLight(1, 69, 8), MAX_LIGHT - 1);
  assert.equal(store.getSkyLight(2, 69, 8), MAX_LIGHT - 2);
  // 深处应该完全黑
  assert.equal(store.getSkyLight(15, 69, 8), 0, '深处应无天光');
});

test('玻璃不挡天光；树叶之下按 MC 规则逐格变暗', () => {
  const store = makeWorld(0);
  for (let z = 0; z < CHUNK_SIZE; z++) {
    for (let x = 0; x < CHUNK_SIZE; x++) {
      store.setState(x, 70, z, packState(2)); // 玻璃
      store.setState(x, 60, z, packState(3)); // 树叶
    }
  }
  fullRecompute(store);

  // 玻璃遮光度 0，不进 heightmap，所以它和它上下都还是"直接见天"
  assert.equal(store.getSkyLight(8, 70, 8), MAX_LIGHT, '玻璃自身满天光');
  assert.equal(store.getSkyLight(8, 69, 8), MAX_LIGHT, '玻璃下方仍是满天光');
  assert.equal(store.getSkyLight(8, 61, 8), MAX_LIGHT, '一直到树叶上方都还见天');

  // 树叶遮光度 1，进 heightmap，它之下不再见天，于是每格衰减 1。
  // 这正是 MC 里大树底下会变暗、甚至能刷怪的原因 ——
  // 天光在 heightmap 以下没有任何"垂直不衰减"的优待。
  assert.equal(store.getSkyLight(8, 60, 8), MAX_LIGHT - 1, '树叶层自身衰减 1');
  assert.equal(store.getSkyLight(8, 59, 8), MAX_LIGHT - 2, '树叶下一格再减 1');
  assert.equal(store.getSkyLight(8, 58, 8), MAX_LIGHT - 3);
  assert.equal(store.getSkyLight(8, 46, 8), 0, '往下 14 格就全黑了');
});

test('方块光从火把向外每格衰减 1', () => {
  const store = makeWorld(0);
  // 造一个封闭石室，中心放火把
  for (let y = 60; y <= 70; y++) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) store.setState(x, y, z, packState(1));
    }
  }
  for (let y = 62; y <= 68; y++) {
    for (let z = 2; z <= 13; z++) {
      for (let x = 2; x <= 13; x++) store.setState(x, y, z, AIR_STATE);
    }
  }
  store.setState(8, 65, 8, packState(4)); // 火把
  fullRecompute(store);

  assert.equal(store.getBlockLight(8, 65, 8), 14, '火把自身');
  assert.equal(store.getBlockLight(9, 65, 8), 13, '相邻一格');
  assert.equal(store.getBlockLight(10, 65, 8), 12);
  assert.equal(store.getBlockLight(11, 65, 8), 11);
  // 曼哈顿距离 4
  assert.equal(store.getBlockLight(10, 65, 10), 10, '对角方向按曼哈顿距离');
  assert.equal(store.getSkyLight(8, 65, 8), 0, '封闭石室内没有天光');
});

test('移除光源后周围恢复黑暗 —— 只做增加传播的引擎会在这里失败', () => {
  const store = makeWorld(0);
  for (let y = 60; y <= 70; y++) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) store.setState(x, y, z, packState(1));
    }
  }
  for (let y = 62; y <= 68; y++) {
    for (let z = 2; z <= 13; z++) {
      for (let x = 2; x <= 13; x++) store.setState(x, y, z, AIR_STATE);
    }
  }
  store.setState(8, 65, 8, packState(4));
  fullRecompute(store);
  assert.equal(store.getBlockLight(10, 65, 8), 12, '前提：火把点亮了周围');

  // 拿走火把
  const engine = new LightEngine(store, TABLES);
  store.setState(8, 65, 8, AIR_STATE);
  engine.onBlockChanged(8, 65, 8, 14, 0, 0);

  assert.equal(store.getBlockLight(8, 65, 8), 0, '火把位置应变黑');
  assert.equal(store.getBlockLight(10, 65, 8), 0, '周围也应变黑');
  assert.equal(store.getBlockLight(13, 65, 13), 0, '整个石室都应变黑');
});

test('放置不透光方块会让下方变暗 —— 天光的"移除传播"', () => {
  const store = makeWorld(0);
  fullRecompute(store);
  assert.equal(store.getSkyLight(8, 50, 8), MAX_LIGHT, '前提：空世界处处满天光');

  const engine = new LightEngine(store, TABLES);
  // 在 y=70 放一大片石头（单独一块的话光会从旁边绕过来）
  for (let z = 0; z < CHUNK_SIZE; z++) {
    for (let x = 0; x < CHUNK_SIZE; x++) {
      store.setState(x, 70, z, packState(1));
      engine.onBlockChanged(x, 70, z, 0, 0, 0);
    }
  }

  assert.equal(store.getSkyLight(8, 70, 8), 0, '石头内部');
  assert.equal(store.getSkyLight(8, 69, 8), 0, '正下方中心应变黑');
  assert.equal(store.getSkyLight(8, 71, 8), MAX_LIGHT, '上方不受影响');
});

test('增量更新与全量重算逐格一致 —— 随机世界 + 随机操作', () => {
  // 换三个种子跑，因为这类 bug 高度依赖地形形状：
  // 之前那版引擎在种子 A 上前 36 次操作都对，第 37 次才冒出 47 处偏差。
  for (const seed of [20260829, 1234, 987654321]) {
    const rng = new JavaRandom(seed);
    const store = makeWorld(1);

    // 造一个有起伏和洞的随机地形
    for (let cz = -1; cz <= 1; cz++) {
      for (let cx = -1; cx <= 1; cx++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
          for (let x = 0; x < CHUNK_SIZE; x++) {
            const wx = cx * CHUNK_SIZE + x;
            const wz = cz * CHUNK_SIZE + z;
            const h = 62 + rng.nextInt(6);
            for (let y = 55; y <= h; y++) {
              // 留出一些空洞，让光照有横向传播的机会
              if (rng.nextInt(9) === 0) continue;
              store.setState(wx, y, wz, packState(1 + rng.nextInt(3)));
            }
          }
        }
      }
    }
    fullRecompute(store);

    // 一连串随机操作，每次都走增量更新
    const engine = new LightEngine(store, TABLES);
    for (let i = 0; i < 300; i++) {
      const wx = rng.nextInt(48) - 24;
      const wz = rng.nextInt(48) - 24;
      const wy = 56 + rng.nextInt(12);
      const before = stateId(store.getState(wx, wy, wz));
      const oldEmission = before === 0 ? 0 : (TABLES.lightEmission[before] ?? 0);

      // 一半放方块（含光源），一半挖掉
      const roll = rng.nextInt(10);
      const after = roll < 3 ? 0 : roll < 5 ? 4 : roll < 6 ? 5 : 1 + rng.nextInt(3);
      const newEmission = after === 0 ? 0 : (TABLES.lightEmission[after] ?? 0);

      const oldOpacity = before === 0 ? 0 : (TABLES.opacity[before] ?? MAX_LIGHT);
      store.setState(wx, wy, wz, after === 0 ? AIR_STATE : packState(after));
      engine.onBlockChanged(wx, wy, wz, oldEmission, newEmission, oldOpacity);
    }

    // 比对范围要盖住光能到达的全部高度：地形顶 67 往上、以及往下 15 格衰减到 0 之处
    const incremental = snapshot(store, 38, 90);
    fullRecompute(store);
    const full = snapshot(store, 38, 90);
    assertSameLight(incremental, full, `种子 ${seed}：300 次随机操作后`);
  }
});

test('光照能跨区块边界传播', () => {
  const store = makeWorld(1);
  // 在 y=65 铺满石头，只在 (0,65,0) 附近开一个洞
  for (let cz = -1; cz <= 1; cz++) {
    for (let cx = -1; cx <= 1; cx++) {
      for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
          store.setState(cx * CHUNK_SIZE + x, 65, cz * CHUNK_SIZE + z, packState(1));
        }
      }
    }
  }
  // 在区块边界上放一支火把（x=15 属于区块 0，x=16 属于区块 1）
  store.setState(15, 64, 8, packState(4));
  fullRecompute(store);

  assert.equal(store.getBlockLight(15, 64, 8), 14);
  assert.equal(store.getBlockLight(16, 64, 8), 13, '光应跨过区块边界');
  assert.equal(store.getBlockLight(18, 64, 8), 11, '继续在邻居区块内衰减');
});

test('两个光源相遇时取较亮的一个', () => {
  const store = makeWorld(0);
  store.setState(2, 64, 8, packState(4)); // 火把 14
  store.setState(12, 64, 8, packState(5)); // 萤石 15
  fullRecompute(store);

  assert.equal(store.getBlockLight(2, 64, 8), 14);
  assert.equal(store.getBlockLight(12, 64, 8), 15);
  // 中点 x=7：距火把 5 -> 9；距萤石 5 -> 10。应取 10
  assert.equal(store.getBlockLight(7, 64, 8), 10, '两个光源重叠处取较亮者');
});

test('触碰位置被记录，供调用方决定重网格化范围', () => {
  const store = makeWorld(0);
  fullRecompute(store);
  const engine = new LightEngine(store, TABLES);
  engine.drainTouched();

  store.setState(8, 64, 8, packState(4));
  engine.onBlockChanged(8, 64, 8, 0, 14, 0);
  const touched = engine.drainTouched();

  assert.ok(touched.length > 100, `火把应触碰到大片区域，实得 ${touched.length} 格`);
  assert.equal(engine.touchedCount, 0, 'drain 之后应清空');
});
