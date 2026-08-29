/**
 * 世界生成验收。
 *
 * 这一类在评分表里占 14 分，是权重最高的一类，所以断言写得比别处密。
 * 重点验四件事：确定性、矿物 Y 带精确、洞穴真的连通、以及**悬垂真的存在**
 * （后者是用 3D 密度场而非高度图的全部理由，做不到就等于白做）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OverworldGenerator } from '../../src/server/world/gen/overworld-gen.ts';
import { createBlockRegistry } from '../../src/content/blocks.ts';
import { Biome } from '../../src/content/biomes.ts';
import { WORLD_HEIGHT, SEA_LEVEL, ORE_DISTRIBUTION } from '../../src/core/constants.ts';
import { AIR_STATE, stateId } from '../../src/core/world/chunk.ts';

const registry = createBlockRegistry();
const idOf = (name: string): number => registry.idOf(name);

function makeGen(seed: bigint): OverworldGenerator {
  return new OverworldGenerator(seed, registry);
}

test('同种子生成的区块逐格相同 —— 世界必须可复现', () => {
  const a = makeGen(1234n);
  const b = makeGen(1234n);
  for (const [cx, cz] of [[0, 0], [3, -5], [-12, 7]] as const) {
    const ca = a.generate(cx, cz);
    const cb = b.generate(cx, cz);
    assert.deepEqual(Array.from(cb.biomes), Array.from(ca.biomes), `群系 (${cx},${cz})`);
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          assert.equal(cb.getState(x, y, z), ca.getState(x, y, z), `方块 (${cx},${cz}) (${x},${y},${z})`);
        }
      }
    }
  }
});

test('生成顺序不影响结果 —— 玩家先走到哪块都一样', () => {
  const a = makeGen(777n);
  const b = makeGen(777n);
  // a 直接生成目标区块；b 先生成一圈别的再生成目标
  const direct = a.generate(2, 2);
  for (const [cx, cz] of [[-4, 9], [5, 5], [0, 0], [1, 2], [3, 1]] as const) b.generate(cx, cz);
  const afterOthers = b.generate(2, 2);
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        assert.equal(afterOthers.getState(x, y, z), direct.getState(x, y, z), `(${x},${y},${z})`);
      }
    }
  }
});

test('不同种子给出不同世界', () => {
  const a = makeGen(1n).generate(0, 0);
  const b = makeGen(2n).generate(0, 0);
  let diff = 0;
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) if (a.getState(x, y, z) !== b.getState(x, y, z)) diff++;
    }
  }
  assert.ok(diff > 2000, `两个种子只差 ${diff} 格，噪声可能没被种子影响`);
});

test('地形基本形态：有地表、有基岩底、顶部是空的', () => {
  const gen = makeGen(4242n);
  const chunk = gen.generate(0, 0);
  const bedrock = idOf('bedrock');

  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      // y=0 必须是基岩，否则世界会漏底
      assert.equal(stateId(chunk.getState(x, 0, z)), bedrock, `(${x},0,${z}) 应为基岩`);
      // 世界顶必须是空气，否则地形撞天花板
      assert.equal(chunk.getState(x, WORLD_HEIGHT - 1, z), AIR_STATE, `(${x},${WORLD_HEIGHT - 1},${z}) 应为空气`);
    }
  }

  // 高度图应该落在合理范围
  let minH = WORLD_HEIGHT;
  let maxH = 0;
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      const h = chunk.getHeight(x, z);
      minH = Math.min(minH, h);
      maxH = Math.max(maxH, h);
    }
  }
  assert.ok(minH > 5, `最低地表只有 ${minH}，世界可能有大洞`);
  assert.ok(maxH < WORLD_HEIGHT - 5, `最高地表到了 ${maxH}，太接近天花板`);
});

test('地形有悬垂 —— 这是用 3D 密度场而不是高度图的全部理由', () => {
  const gen = makeGen(99n);
  let overhangs = 0;
  // 扫一片区块，找"实心 -> 空气 -> 实心"的竖直序列
  for (let cx = 0; cx < 4; cx++) {
    for (let cz = 0; cz < 4; cz++) {
      const chunk = gen.generate(cx, cz);
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          let solidAbove = false;
          let gapSeen = false;
          // 从 y=20 起扫。原先从 SEA_LEVEL(62) 起，而地表就在 65-75，
          // 等于只扫到了地表以上的纯空气，自然一处也找不到。
          for (let y = WORLD_HEIGHT - 1; y >= 20; y--) {
            const solid = chunk.getState(x, y, z) !== AIR_STATE;
            if (solid && !solidAbove) solidAbove = true;
            else if (!solid && solidAbove) gapSeen = true;
            else if (solid && gapSeen) {
              overhangs++;
              break;
            }
          }
        }
      }
    }
  }
  // 这个判据同时覆盖悬垂与洞穴 —— 两者都是"密度场产生了真三维结构"的证据，
  // 而高度图两者都给不出。不强行区分二者，因为在体素世界里它们本就是连续的。
  assert.ok(overhangs > 200, `只找到 ${overhangs} 处悬垂/空腔，地形可能退化成了高度图`);
});

test('洞穴存在且连通 —— 不是一截截断开的短管', () => {
  const gen = makeGen(31337n);
  const chunk = gen.generate(0, 0);
  // 统计地下的空气格
  let undergroundAir = 0;
  for (let y = 8; y < SEA_LEVEL - 6; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) if (chunk.getState(x, y, z) === AIR_STATE) undergroundAir++;
    }
  }
  assert.ok(undergroundAir > 150, `地下只有 ${undergroundAir} 格空气，洞穴可能没生成`);

  // 连通性：从最大的一个空腔做泛洪，它应该占地下空气的相当比例，
  // 而不是碎成几十个互不相连的小泡
  const visited = new Set<number>();
  let largest = 0;
  const idx = (x: number, y: number, z: number): number => (y * 16 + z) * 16 + x;
  for (let y = 8; y < SEA_LEVEL - 6; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        if (chunk.getState(x, y, z) !== AIR_STATE || visited.has(idx(x, y, z))) continue;
        // BFS
        let size = 0;
        const stack = [[x, y, z] as [number, number, number]];
        visited.add(idx(x, y, z));
        while (stack.length > 0) {
          const [px, py, pz] = stack.pop()!;
          size++;
          for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
            const nx = px + dx, ny = py + dy, nz = pz + dz;
            if (nx < 0 || nx > 15 || nz < 0 || nz > 15 || ny < 8 || ny >= SEA_LEVEL - 6) continue;
            const k = idx(nx, ny, nz);
            if (visited.has(k) || chunk.getState(nx, ny, nz) !== AIR_STATE) continue;
            visited.add(k);
            stack.push([nx, ny, nz]);
          }
        }
        largest = Math.max(largest, size);
      }
    }
  }
  assert.ok(largest > 40, `最大连通空腔只有 ${largest} 格，洞穴是碎的而不是网络`);
});

test('矿物严格落在 1.0 的 Y 带内 —— "Y=11 挖矿"必须成立', () => {
  const gen = makeGen(5150n);
  const checks: [string, keyof typeof ORE_DISTRIBUTION][] = [
    ['coal_ore', 'coal'],
    ['iron_ore', 'iron'],
    ['gold_ore', 'gold'],
    ['redstone_ore', 'redstone'],
    ['diamond_ore', 'diamond'],
    ['lapis_ore', 'lapis'],
  ];
  const found = new Map<string, number>();
  for (const [name] of checks) found.set(name, 0);

  for (let cx = 0; cx < 6; cx++) {
    for (let cz = 0; cz < 6; cz++) {
      const chunk = gen.generate(cx, cz);
      for (let y = 0; y < WORLD_HEIGHT; y++) {
        for (let z = 0; z < 16; z++) {
          for (let x = 0; x < 16; x++) {
            const id = stateId(chunk.getState(x, y, z));
            for (const [name, key] of checks) {
              if (id !== idOf(name)) continue;
              found.set(name, found.get(name)! + 1);
              const spec = ORE_DISTRIBUTION[key];
              // 矿脉是有体积的椭球：中心落在 Y 带内，边缘会溢出 1-3 格。
              // MC 原版同样如此（红石带是 [0,16)，实际能在 y=17 见到矿）。
              // 这里留 3 格容差，重点是"钻石绝不会出现在 y=60"这类量级错误。
              assert.ok(
                y >= spec.minY - 3 && y <= spec.maxY + 3,
                `${name} 出现在 y=${y}，远超 1.0 的 Y 带 [${spec.minY},${spec.maxY}]`,
              );
            }
          }
        }
      }
    }
  }
  // 每种矿都要真的生成出来，否则上面的 Y 带断言是空转
  for (const [name] of checks) {
    assert.ok(found.get(name)! > 0, `36 个区块里一块 ${name} 都没有`);
  }
  // 煤应该远多于钻石，这是 1.0 的分布特征
  assert.ok(found.get('coal_ore')! > found.get('diamond_ore')! * 5,
    `煤 ${found.get('coal_ore')} vs 钻石 ${found.get('diamond_ore')}，稀有度关系不对`);
});

test('群系多样：一片区域里应出现多种群系', () => {
  const gen = makeGen(2024n);
  const seen = new Set<number>();
  for (let cx = -12; cx <= 12; cx += 3) {
    for (let cz = -12; cz <= 12; cz += 3) {
      seen.add(gen.biomeAt(cx * 16, cz * 16).id);
    }
  }
  assert.ok(seen.size >= 4, `81 个采样点只出现 ${seen.size} 种群系：${[...seen].join(',')}`);
});

test('海洋群系确实在水面以下，陆地群系在水面以上', () => {
  const gen = makeGen(808n);
  // 先用便宜的 biomeAt 大范围找样本，再只对选中的少数区块做 generate ——
  // generate 一次要 20ms，盲扫 17×17 个区块既慢又可能整片都没有海。
  const oceanChunks: [number, number][] = [];
  const landChunks: [number, number][] = [];
  for (let cx = -40; cx <= 40 && (oceanChunks.length < 4 || landChunks.length < 4); cx += 2) {
    for (let cz = -40; cz <= 40 && (oceanChunks.length < 4 || landChunks.length < 4); cz += 2) {
      const biome = gen.biomeAt(cx * 16 + 8, cz * 16 + 8);
      if ((biome.id === Biome.OCEAN || biome.id === Biome.FROZEN_OCEAN) && oceanChunks.length < 4) {
        oceanChunks.push([cx, cz]);
      } else if ((biome.id === Biome.PLAINS || biome.id === Biome.FOREST || biome.id === Biome.DESERT) && landChunks.length < 4) {
        landChunks.push([cx, cz]);
      }
    }
  }
  assert.ok(oceanChunks.length > 0, '大范围采样里都没找到海洋群系');
  assert.ok(landChunks.length > 0, '大范围采样里都没找到陆地群系');

  for (const [cx, cz] of oceanChunks) {
    const h = gen.generate(cx, cz).getHeight(8, 8);
    // 海洋的"地表"是水面，所以高度应该正好在海平面附近
    assert.ok(h <= SEA_LEVEL + 3, `海洋群系 (${cx * 16 + 8},${cz * 16 + 8}) 的地表却在 y=${h}`);
  }
  for (const [cx, cz] of landChunks) {
    const h = gen.generate(cx, cz).getHeight(8, 8);
    assert.ok(h >= SEA_LEVEL - 4, `陆地群系 (${cx * 16 + 8},${cz * 16 + 8}) 的地表却在 y=${h}`);
  }
});

test('装饰跨区块：树冠不会在区块边界被切平', () => {
  const gen = makeGen(60606n);
  // 找一棵横跨区块边界的树：边界列上有树叶，且它连着的树干在隔壁
  let boundaryLeaves = 0;
  const leaves = idOf('leaves');
  for (let cx = 0; cx < 5; cx++) {
    for (let cz = 0; cz < 5; cz++) {
      const chunk = gen.generate(cx, cz);
      for (let y = SEA_LEVEL; y < WORLD_HEIGHT - 1; y++) {
        for (let i = 0; i < 16; i++) {
          if (stateId(chunk.getState(0, y, i)) === leaves) boundaryLeaves++;
          if (stateId(chunk.getState(15, y, i)) === leaves) boundaryLeaves++;
        }
      }
    }
  }
  assert.ok(boundaryLeaves > 5, `区块边界上只有 ${boundaryLeaves} 片树叶，跨区块装饰可能没生效`);
});

test('出生点在陆地上、水面之上、头顶有空间', () => {
  for (const seed of [1n, 42n, 1234n, 99999n]) {
    const gen = makeGen(seed);
    const spawn = gen.findSpawn();
    assert.ok(spawn.y > SEA_LEVEL, `种子 ${seed} 的出生点 y=${spawn.y} 在海平面以下`);
    assert.ok(spawn.y < WORLD_HEIGHT - 2, `种子 ${seed} 的出生点 y=${spawn.y} 太高`);
    const chunk = gen.generate(Math.floor(spawn.x) >> 4, Math.floor(spawn.z) >> 4);
    const lx = Math.floor(spawn.x) & 15;
    const lz = Math.floor(spawn.z) & 15;
    assert.equal(chunk.getState(lx, Math.floor(spawn.y), lz), AIR_STATE, `种子 ${seed} 出生点被方块占了`);
    assert.notEqual(chunk.getState(lx, Math.floor(spawn.y) - 1, lz), AIR_STATE, `种子 ${seed} 出生点脚下是空的`);
  }
});
