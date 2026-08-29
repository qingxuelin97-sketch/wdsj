/**
 * 临时测试世界。
 *
 * M2 会被真正的世界生成器（服务端，跑在 gen worker 里）替换。留在这里是为了让 M1 的
 * 网格化管线有内容可渲染、可截图。它刻意做得像模像样（地形起伏、矿脉、树、花草），
 * 这样 mesher 的各条分支 —— 立方体、十字植物、cutout、群系染色、AO —— 都能被看到。
 */
import { ChunkStore } from '../../core/world/block-view.ts';
import { packState } from '../../core/world/chunk.ts';
import { noiseFromSeed } from '../../core/noise/perlin.ts';
import { JavaRandom } from '../../core/rng/java-random.ts';
import { CHUNK_SIZE, WORLD_HEIGHT } from '../../core/constants.ts';
import type { BlockRegistry } from '../../core/registry/block-registry.ts';
import { Blocks } from '../../../src/content/blocks.ts';

export interface TestWorldOptions {
  seed: number;
  /** 生成的区块半径，chunkRadius=2 -> 5×5 个区块 */
  chunkRadius: number;
}

export function buildTestWorld(reg: BlockRegistry, opts: TestWorldOptions): ChunkStore {
  const store = new ChunkStore();
  const id = (name: string): number => reg.idOf(name);

  const B = {
    stone: packState(id(Blocks.STONE)),
    dirt: packState(id(Blocks.DIRT)),
    grass: packState(id(Blocks.GRASS_BLOCK)),
    bedrock: packState(id(Blocks.BEDROCK)),
    sand: packState(id(Blocks.SAND)),
    gravel: packState(id(Blocks.GRAVEL)),
    log: packState(id(Blocks.LOG)),
    leaves: packState(id(Blocks.LEAVES)),
    coal: packState(id(Blocks.COAL_ORE)),
    iron: packState(id(Blocks.IRON_ORE)),
    gold: packState(id(Blocks.GOLD_ORE)),
    diamond: packState(id(Blocks.DIAMOND_ORE)),
    glass: packState(id(Blocks.GLASS)),
    planks: packState(id(Blocks.PLANKS)),
    tallGrass: packState(id(Blocks.TALL_GRASS)),
    dandelion: packState(id(Blocks.DANDELION)),
    rose: packState(id(Blocks.ROSE)),
    brownMushroom: packState(id(Blocks.BROWN_MUSHROOM)),
    redMushroom: packState(id(Blocks.RED_MUSHROOM)),
  };

  const terrain = noiseFromSeed(opts.seed, 0x7e44, 4);
  const detail = noiseFromSeed(opts.seed, 0x1a3f, 2);

  const r = opts.chunkRadius;
  for (let cz = -r; cz <= r; cz++) {
    for (let cx = -r; cx <= r; cx++) {
      store.createChunk(cx, cz);
    }
  }

  // --- 地形 ---
  const minW = -r * CHUNK_SIZE;
  const maxW = (r + 1) * CHUNK_SIZE - 1;
  for (let wz = minW; wz <= maxW; wz++) {
    for (let wx = minW; wx <= maxW; wx++) {
      const base = 34;
      const h = Math.round(
        base +
          terrain.noise2(wx * 0.022, wz * 0.022) * 10 +
          detail.noise2(wx * 0.09, wz * 0.09) * 2.2,
      );
      for (let y = 0; y <= h; y++) {
        let state: number;
        if (y === 0) state = B.bedrock;
        else if (y === h) state = B.grass;
        else if (y > h - 4) state = B.dirt;
        else state = B.stone;
        store.setState(wx, y, wz, state);
      }
    }
  }

  // --- 矿脉：世界固定的 3D 单元格 + 随机游走，与 M2 的正式实现同构 ---
  const veins: [number, number, number, number][] = [
    // [方块状态, 单元格边长, 最高 y, 一条矿脉的方块数]
    [B.coal, 12, 40, 14],
    [B.iron, 12, 30, 8],
    [B.gold, 14, 20, 6],
    [B.diamond, 16, 14, 5],
    [B.gravel, 14, 36, 16],
  ];
  for (const [state, cell, maxY, size] of veins) {
    for (let gz = Math.floor(minW / cell) - 1; gz <= Math.floor(maxW / cell) + 1; gz++) {
      for (let gx = Math.floor(minW / cell) - 1; gx <= Math.floor(maxW / cell) + 1; gx++) {
        for (let gy = 0; gy * cell < maxY; gy++) {
          const rng = new JavaRandom(
            BigInt(opts.seed) ^ (BigInt(gx) * 341873128712n + BigInt(gz) * 132897987541n + BigInt(gy) * 7654321n + BigInt(state)),
          );
          if (rng.nextFloat() > 0.55) continue;
          let x = gx * cell + rng.nextInt(cell);
          let y = gy * cell + rng.nextInt(cell);
          let z = gz * cell + rng.nextInt(cell);
          for (let i = 0; i < size; i++) {
            if (y > 0 && y < maxY && store.getState(x, y, z) === B.stone) store.setState(x, y, z, state);
            x += rng.nextInt(3) - 1;
            y += rng.nextInt(3) - 1;
            z += rng.nextInt(3) - 1;
          }
        }
      }
    }
  }

  // --- 地表装饰：树、花草 ---
  const surfaceY = (wx: number, wz: number): number => {
    for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
      if (store.getState(wx, y, wz) !== 0) return y;
    }
    return -1;
  };

  for (let cz = -r; cz <= r; cz++) {
    for (let cx = -r; cx <= r; cx++) {
      // 每个区块用自己的 RNG，这样加减区块不会影响别处 —— 与正式生成器同一模式
      const rng = new JavaRandom(BigInt(opts.seed) ^ (BigInt(cx) * 4987142n + BigInt(cz) * 5947611n));

      // 树
      const treeCount = rng.nextInt(3);
      for (let t = 0; t < treeCount; t++) {
        const wx = cx * CHUNK_SIZE + 3 + rng.nextInt(10);
        const wz = cz * CHUNK_SIZE + 3 + rng.nextInt(10);
        const gy = surfaceY(wx, wz);
        if (gy < 0 || store.getState(wx, gy, wz) !== B.grass) continue;
        const trunk = 4 + rng.nextInt(2);
        for (let i = 1; i <= trunk; i++) store.setState(wx, gy + i, wz, B.log);
        // 树冠：两层宽、两层窄
        const top = gy + trunk;
        for (let dy = -2; dy <= 1; dy++) {
          const radius = dy <= -1 ? 2 : 1;
          for (let dz = -radius; dz <= radius; dz++) {
            for (let dx = -radius; dx <= radius; dx++) {
              if (dx === 0 && dz === 0 && dy <= 0) continue; // 给树干让位
              // 削掉四角，让树冠是圆的而不是方的
              if (Math.abs(dx) === radius && Math.abs(dz) === radius && rng.nextBoolean()) continue;
              if (store.getState(wx + dx, top + dy, wz + dz) === 0) {
                store.setState(wx + dx, top + dy, wz + dz, B.leaves);
              }
            }
          }
        }
      }

      // 花草
      for (let i = 0; i < 40; i++) {
        const wx = cx * CHUNK_SIZE + rng.nextInt(CHUNK_SIZE);
        const wz = cz * CHUNK_SIZE + rng.nextInt(CHUNK_SIZE);
        const gy = surfaceY(wx, wz);
        if (gy < 0 || store.getState(wx, gy, wz) !== B.grass) continue;
        const roll = rng.nextInt(10);
        const plant =
          roll < 6 ? B.tallGrass : roll < 7 ? B.dandelion : roll < 8 ? B.rose : roll < 9 ? B.brownMushroom : B.redMushroom;
        store.setState(wx, gy + 1, wz, plant);
      }
    }
  }

  // --- 一间小屋，用来看玻璃的 cutout 与同类剔除 ---
  const hx = 4;
  const hz = 4;

  // 先清掉建造区域的植被。
  // surfaceY 返回的是最高**非空气**方块，如果那里正好长了树，它会返回树叶的高度，
  // 小屋就会盖在树里 —— 而木板是不透明的，被它压住的树叶天光归零，画面上表现为
  // 一大片黑斑（一开始很容易误判成 mipmap 或 cutout 的渲染 bug）。
  const isTerrain = (id: number): boolean => {
    const st = packState(id);
    return st === B.grass || st === B.dirt || st === B.stone || st === B.bedrock || st === B.sand || st === B.gravel;
  };
  for (let dz = -1; dz <= 5; dz++) {
    for (let dx = -1; dx <= 5; dx++) {
      for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
        const id = store.getState(hx + dx, y, hz + dz) & 0xfff;
        if (id === 0) continue;
        if (isTerrain(id)) break; // 挖到地形就停
        store.setState(hx + dx, y, hz + dz, 0);
      }
    }
  }

  const hy = surfaceY(hx, hz) + 1;
  if (hy > 0) {
    for (let dz = 0; dz < 5; dz++) {
      for (let dx = 0; dx < 5; dx++) {
        for (let dy = 0; dy < 4; dy++) {
          const edge = dx === 0 || dx === 4 || dz === 0 || dz === 4;
          const roof = dy === 3;
          if (!edge && !roof) continue;
          // 墙上开一圈窗
          const isWindow = edge && dy === 1 && (dx === 2 || dz === 2);
          store.setState(hx + dx, hy + dy, hz + dz, isWindow ? B.glass : B.planks);
        }
      }
    }
    // 留个门洞
    store.setState(hx + 2, hy, hz, 0);
    store.setState(hx + 2, hy + 1, hz, 0);
  }

  // --- 临时天光 ---
  //
  // 完整的光照引擎（含水平泛洪与增量更新）是 M4 的事。这里只做"垂直天光柱"：
  // 从世界顶部往下扫，按方块的 opacity 逐层衰减，不透明方块直接归零。
  //
  // 这已经是真实天光算法的第一步，而且能正确处理树叶（opacity=1，逐层减 1），
  // 于是树冠内部是渐暗而不是纯黑 —— 之前只填 heightmap 以上时，透过树叶孔洞
  // 看到的内层树叶光照为 0，整棵树看着像糊了一层黑斑。
  const tables = reg.getTables();
  for (const chunk of store.chunkValues()) {
    chunk.recomputeHeightmap();
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        let level = 15;
        for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
          const st = chunk.getState(x, y, z);
          const bid = st & 0xfff;
          if (bid !== 0) {
            const opacity = tables.opacity[bid] ?? 15;
            level = Math.max(0, level - Math.max(1, opacity));
          }
          if (level === 0) break; // 下面都是黑的，不用再扫
          const section = chunk.sections[y >> 4];
          if (section != null) section.setSkyLight(x, y & 15, z, level);
        }
      }
    }
  }

  return store;
}
