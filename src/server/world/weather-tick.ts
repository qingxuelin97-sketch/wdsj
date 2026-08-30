/**
 * 天气在世界里的后果：闪电、积雪、结冰。
 *
 * 状态机本身在 core/world/weather.ts（纯的、可单测）。这里只做需要读写
 * 世界才能做的事，分工和 random-ticks.ts 一样。
 *
 * 一条贯穿全文的规则：**降水由群系决定，不由天气决定**。
 * 天气是全局的（整个世界一起下雨），但沙漠永远不湿、雪原永远下雪。
 * 所以每一处"要不要落点什么"都得先问一句这一格是什么群系 ——
 * 少问一次的结果就是沙漠里下雨、雪原上积水。
 */
import type { ServerWorld } from './server-world.ts';
import { packState, stateId } from '../../core/world/chunk.ts';
import { CHUNK_SIZE, WORLD_HEIGHT } from '../../core/constants.ts';
import { precipitationOf, type Precipitation } from '../../content/biomes.ts';
import { igniteAt } from './block-ticks.ts';

const SNOW_LAYER = 78;
const ICE = 79;
const WATER = 9;
const STILL_WATER = 8;

/**
 * 一个区块每刻劈中闪电的概率是 1/100000。
 *
 * 看着小得离谱，但同时加载着两百来个区块，实际是每 500 刻一次 ——
 * 一场十几分钟的雷暴里能劈几十次。MC 就是这个数。
 */
const LIGHTNING_CHANCE = 100000;

/** 每个区块每刻有 1/16 的机会挑一格试着积雪/结冰 */
const SNOW_CHANCE = 16;

/** 闪电点燃的火有多大概率出现（劈中点 + 周围 4 格里随机试） */
const LIGHTNING_FIRE_TRIES = 4;

export interface LightningStrike {
  x: number;
  y: number;
  z: number;
}

/** 这一格头顶在下什么。降水类型本身的定义在 content/biomes.ts */
export function precipitationAt(world: ServerWorld, x: number, z: number): Precipitation {
  return precipitationOf(world.store.getBiome(x, z));
}

/**
 * 推进一刻的天气后果。
 *
 * @returns 这一刻劈下的闪电，交给上层广播
 */
export function runWeatherTick(world: ServerWorld): LightningStrike[] {
  const w = world.weather;
  const strikes: LightningStrike[] = [];
  if (!w.raining) return strikes;

  const rng = world.random;
  const thundering = w.thundering;

  for (const chunk of world.store.chunkValues()) {
    const baseX = chunk.cx * CHUNK_SIZE;
    const baseZ = chunk.cz * CHUNK_SIZE;

    // --- 闪电 ---
    if (thundering && rng.nextInt(LIGHTNING_CHANCE) === 0) {
      const lx = rng.nextInt(CHUNK_SIZE);
      const lz = rng.nextInt(CHUNK_SIZE);
      const x = baseX + lx;
      const z = baseZ + lz;
      const y = world.store.getHeight(x, z);
      // 只劈在露天、且这个群系确实在下雨的地方。雪原不打雷（MC 如此），
      // 沙漠更不会 —— 那里连雨都没有
      if (y > 0 && y < WORLD_HEIGHT && precipitationAt(world, x, z) === 'rain') {
        strikes.push({ x, y, z });
        strikeLightning(world, x, y, z);
      }
    }

    // --- 积雪与结冰 ---
    //
    // 每区块每刻只试一格。看起来慢得可笑，但一场雨十几分钟 =
    // 一万多刻，一个区块会被试到几百次，雪就是这么一层层铺开的。
    if (rng.nextInt(SNOW_CHANCE) === 0) {
      const lx = rng.nextInt(CHUNK_SIZE);
      const lz = rng.nextInt(CHUNK_SIZE);
      accumulate(world, baseX + lx, baseZ + lz);
    }
  }
  return strikes;
}

/**
 * 闪电落地：点几处火。
 *
 * 不直接把落点变成火 —— 落点往往是草地或石头，MC 是在**周围**试着点火，
 * 点得着的才烧起来。所以雷劈树林会着火，劈在草原上大多什么也不留下。
 */
function strikeLightning(world: ServerWorld, x: number, y: number, z: number): void {
  const rng = world.random;
  igniteAt(world, x, y, z);
  for (let i = 0; i < LIGHTNING_FIRE_TRIES; i++) {
    const dx = rng.nextInt(3) - 1;
    const dz = rng.nextInt(3) - 1;
    const dy = rng.nextInt(2);
    igniteAt(world, x + dx, y + dy, z + dz);
  }
}

/**
 * 在一列的顶上积雪，或把露天的水面冻成冰。
 *
 * 冻冰不看天气只看温度：MC 里雪原的湖面在晴天也会结冰。但**积雪要下雪**，
 * 因为雪是从天上落下来的。这个区别是刻意的，不是漏写。
 */
function accumulate(world: ServerWorld, x: number, z: number): void {
  const y = world.store.getHeight(x, z);
  if (y <= 0 || y >= WORLD_HEIGHT) return;
  if (precipitationAt(world, x, z) !== 'snow') return;

  // 水面结冰：顶格之下那一格是静水就冻上
  const belowId = stateId(world.getBlock(x, y - 1, z));
  if (belowId === STILL_WATER || belowId === WATER) {
    world.setBlock(x, y - 1, z, packState(ICE, 0));
    return;
  }

  // 积雪：顶格必须是空的，脚下必须是能站住的实心方块。
  // 少了"实心"这一条，雪会盖在树叶、火把、甚至水面上
  if (stateId(world.getBlock(x, y, z)) !== 0) return;
  if (belowId === 0 || belowId === SNOW_LAYER) return;
  if ((world.tables.solid[belowId] ?? 0) === 0) return;
  world.setBlock(x, y, z, packState(SNOW_LAYER, 0));
}
