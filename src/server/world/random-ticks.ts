/**
 * 随机刻：作物生长、草蔓延、树苗长树、雪与冰融化。
 *
 * MC 的规则：每 tick，每个**已加载的子区块**随机挑 3 格，
 * 那 3 格上的方块如果注册了随机刻就跑一次。于是一个方块被 tick 到的
 * 概率是 3/4096 —— 换算下来，一株小麦平均要几分钟才长一级。
 *
 * 这个概率不是可调的旋钮，它决定了整个农业的节奏：调快了作物一转眼就熟，
 * 调慢了没人愿意种地。照抄它。
 *
 * 与计划刻的分工：计划刻是"我知道 N 刻之后要做某事"（流体、红石、TNT），
 * 随机刻是"这件事迟早会发生但没人知道什么时候"（生长、蔓延、融化）。
 * 两者用途不同，不该合并。
 */
import type { ServerWorld } from './server-world.ts';
import { packState, stateId, stateMeta, AIR_STATE } from '../../core/world/chunk.ts';
import { CHUNK_SIZE, SECTIONS_PER_COLUMN, WORLD_HEIGHT } from '../../core/constants.ts';
import { isWaterId } from '../../content/blocks-fluid.ts';

/** 每个子区块每 tick 挑几格。MC 是 3 */
export const RANDOM_TICKS_PER_SECTION = 3;

/** 农业相关的方块 id */
const FARMLAND = 60;
const WHEAT = 59;
const DIRT = 3;
const GRASS_BLOCK = 2;
const SUGAR_CANE = 83;
const CACTUS = 81;
const SAPLING = 6;
const SNOW_LAYER = 78;
const ICE = 79;
const TALL_GRASS = 31;

/** 小麦的成熟阶段。0 是刚种下，7 是可以收了 */
export const WHEAT_MAX_AGE = 7;
/** 甘蔗/仙人掌最多长几格高 */
const CANE_MAX_HEIGHT = 3;

/**
 * 跑一轮随机刻。
 *
 * 只扫**玩家附近**的区块：MC 扫的是所有已加载区块，而我们的加载半径
 * 本来就跟着玩家走，两者等价。
 */
export function runRandomTicks(world: ServerWorld): void {
  const rng = world.random;
  for (const chunk of world.store.chunkValues()) {
    for (let sy = 0; sy < SECTIONS_PER_COLUMN; sy++) {
      const section = chunk.sections[sy];
      // 空的子区块跳过：地下与高空占了绝大多数，逐格挑毫无意义
      if (section == null || section.isEmpty) continue;
      for (let i = 0; i < RANDOM_TICKS_PER_SECTION; i++) {
        const r = rng.nextInt(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);
        const lx = r & 15;
        const ly = (r >> 4) & 15;
        const lz = (r >> 8) & 15;
        const id = section.states[(ly * CHUNK_SIZE + lz) * CHUNK_SIZE + lx]! & 0xfff;
        if (id === 0 || (world.tables.randomTick[id] ?? 0) === 0) continue;
        randomTickBlock(
          world, chunk.cx * CHUNK_SIZE + lx, sy * CHUNK_SIZE + ly, chunk.cz * CHUNK_SIZE + lz, id,
        );
      }
    }
  }
}

function randomTickBlock(world: ServerWorld, x: number, y: number, z: number, id: number): void {
  switch (id) {
    case WHEAT: return tickWheat(world, x, y, z);
    case FARMLAND: return tickFarmland(world, x, y, z);
    case GRASS_BLOCK: return tickGrassSpread(world, x, y, z);
    case SUGAR_CANE: return tickCane(world, x, y, z, SUGAR_CANE);
    case CACTUS: return tickCane(world, x, y, z, CACTUS);
    case SAPLING: return tickSapling(world, x, y, z);
    case SNOW_LAYER: case ICE: return tickMelt(world, x, y, z, id);
    default: return;
  }
}

// ---------------------------------------------------------------------------
// 作物
// ---------------------------------------------------------------------------

/**
 * 小麦生长。
 *
 * 速度取决于两件事：脚下的耕地湿不湿、周围有没有别的作物。
 * MC 的原式把两者揉进一个"生长点数"，点数越高越快。这里保留那个结构，
 * 因为"浇了水的田长得快""隔行种比挤在一起快"是玩家真的会去利用的。
 */
function tickWheat(world: ServerWorld, x: number, y: number, z: number): void {
  const age = stateMeta(world.getBlock(x, y, z));
  if (age >= WHEAT_MAX_AGE) return;
  // 头顶没光就不长
  if (world.store.getSkyLight(x, y, z) < 9 && world.store.getBlockLight(x, y, z) < 9) return;

  const points = growthPoints(world, x, y, z);
  // MC：随机数落在 1/(25/点数 + 1) 之内才长一级
  if (world.random.nextInt(Math.floor(25 / points) + 1) !== 0) return;
  world.setBlock(x, y, z, packState(WHEAT, age + 1));
}

/**
 * MC 的作物生长点数。
 *
 * 基础 1 分；脚下耕地湿的 +3；周围八格里每有一块（湿的）耕地再加分；
 * 前后左右有同种作物时**减半**（挤在一起长得慢）。
 */
function growthPoints(world: ServerWorld, x: number, y: number, z: number): number {
  let points = 1;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const below = world.getBlock(x + dx, y - 1, z + dz);
      if (stateId(below) !== FARMLAND) continue;
      let v = stateMeta(below) > 0 ? 3 : 1;
      if (dx !== 0 || dz !== 0) v /= 4; // 斜着/隔壁的田贡献小
      points += v;
    }
  }
  // 挤在一起要减半
  const north = stateId(world.getBlock(x, y, z - 1)) === WHEAT;
  const south = stateId(world.getBlock(x, y, z + 1)) === WHEAT;
  const west = stateId(world.getBlock(x - 1, y, z)) === WHEAT;
  const east = stateId(world.getBlock(x + 1, y, z)) === WHEAT;
  if ((west || east) && (north || south)) points /= 2;
  return Math.max(1, points);
}

/**
 * 耕地的干湿。
 *
 * 四格之内有水就变湿（元数据 7），没水就慢慢干（元数据递减），
 * 干透了而且上面没作物就退回泥土 —— 这是"田荒了会变回土"的来源。
 */
function tickFarmland(world: ServerWorld, x: number, y: number, z: number): void {
  const meta = stateMeta(world.getBlock(x, y, z));
  const wet = hasWaterNearby(world, x, y, z);
  if (wet) {
    if (meta < 7) world.setBlock(x, y, z, packState(FARMLAND, 7));
    return;
  }
  if (meta > 0) {
    world.setBlock(x, y, z, packState(FARMLAND, meta - 1));
    return;
  }
  // 干透了：上面有作物就撑着，没有就退回泥土
  const above = stateId(world.getBlock(x, y + 1, z));
  if (above === WHEAT) return;
  world.setBlock(x, y, z, packState(DIRT));
}

/** 水平四格、上下一格之内有没有水。MC 的判定范围是 4 格 */
function hasWaterNearby(world: ServerWorld, x: number, y: number, z: number): boolean {
  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      for (let dy = 0; dy <= 1; dy++) {
        if (isWaterId(stateId(world.getBlock(x + dx, y + dy, z + dz)))) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 草、树苗、甘蔗、融化
// ---------------------------------------------------------------------------

/** 草方块往旁边的泥土上蔓延；自己被盖住就退回泥土 */
function tickGrassSpread(world: ServerWorld, x: number, y: number, z: number): void {
  // 头顶不透光就死
  const aboveId = stateId(world.getBlock(x, y + 1, z));
  if (aboveId !== 0 && (world.tables.opacity[aboveId] ?? 0) > 2) {
    world.setBlock(x, y, z, packState(DIRT));
    return;
  }
  if (world.store.getSkyLight(x, y + 1, z) < 9) return;

  const rng = world.random;
  for (let i = 0; i < 4; i++) {
    const tx = x + rng.nextInt(3) - 1;
    const ty = y + rng.nextInt(5) - 3;
    const tz = z + rng.nextInt(3) - 1;
    if (ty < 1 || ty >= WORLD_HEIGHT - 1) continue;
    if (stateId(world.getBlock(tx, ty, tz)) !== DIRT) continue;
    const over = stateId(world.getBlock(tx, ty + 1, tz));
    if (over !== 0 && (world.tables.opacity[over] ?? 0) > 2) continue;
    if (world.store.getSkyLight(tx, ty + 1, tz) < 4) continue;
    world.setBlock(tx, ty, tz, packState(GRASS_BLOCK));
  }
}

/**
 * 甘蔗与仙人掌：往上长，最多三格。
 *
 * 只有最底下那一株会长（往上叠），这是 MC 的做法 ——
 * 否则一片甘蔗会指数增长。
 */
function tickCane(world: ServerWorld, x: number, y: number, z: number, id: number): void {
  // 自己头顶已经是同类就不长（说明自己不是顶端）
  if (stateId(world.getBlock(x, y + 1, z)) === id) return;
  // 数一数自己下面已经堆了几格
  let height = 1;
  while (height < CANE_MAX_HEIGHT && stateId(world.getBlock(x, y - height, z)) === id) height++;
  if (height >= CANE_MAX_HEIGHT) return;
  if (stateId(world.getBlock(x, y + 1, z)) !== 0) return;

  // 元数据是"生长计时"，攒到 15 才长一格
  const age = stateMeta(world.getBlock(x, y, z));
  if (age < 15) {
    world.setBlock(x, y, z, packState(id, age + 1));
    return;
  }
  world.setBlock(x, y, z, packState(id, 0));
  world.setBlock(x, y + 1, z, packState(id, 0));
}

/** 树苗长成树。元数据高位是生长计时 */
function tickSapling(world: ServerWorld, x: number, y: number, z: number): void {
  if (world.store.getSkyLight(x, y + 1, z) < 9) return;
  const meta = stateMeta(world.getBlock(x, y, z));
  if ((meta & 8) === 0) {
    world.setBlock(x, y, z, packState(SAPLING, meta | 8));
    return;
  }
  growTree(world, x, y, z);
}

/**
 * 就地长一棵树。
 *
 * 形状与世界生成用的是同一套参数（4-6 格高的树干 + 半径 2 的树冠），
 * 但这里是**就地**长的，不走区块生成那条路 —— 玩家种的树和世界里的树
 * 长得一样，这一点玩家会注意到。
 */
function growTree(world: ServerWorld, x: number, y: number, z: number): void {
  const rng = world.random;
  const height = 4 + rng.nextInt(3);
  const LOG = 17;
  const LEAVES = 18;
  // 上方要有足够空间
  for (let dy = 0; dy <= height + 1; dy++) {
    if (y + dy >= WORLD_HEIGHT) return;
    const id = stateId(world.getBlock(x, y + dy, z));
    if (dy > 0 && id !== 0 && id !== SAPLING) return;
  }
  for (let dy = 0; dy < height; dy++) world.setBlock(x, y + dy, z, packState(LOG));
  // 树冠：上面两层宽、顶上两层窄
  for (let dy = height - 3; dy <= height; dy++) {
    const radius = dy >= height - 1 ? 1 : 2;
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (dx === 0 && dz === 0 && dy < height) continue;
        // 四角随机缺一块，树冠才不是个方盒子
        if (Math.abs(dx) === radius && Math.abs(dz) === radius && rng.nextInt(2) === 0) continue;
        if (stateId(world.getBlock(x + dx, y + dy, z + dz)) !== 0) continue;
        world.setBlock(x + dx, y + dy, z + dz, packState(LEAVES));
      }
    }
  }
}

/** 雪与冰在够亮的地方融化 */
function tickMelt(world: ServerWorld, x: number, y: number, z: number, id: number): void {
  if (world.store.getBlockLight(x, y, z) <= 11) return;
  world.setBlock(x, y, z, id === ICE ? packState(9) : AIR_STATE);
}

/** 骨粉：直接把作物催熟 */
export function applyBoneMeal(world: ServerWorld, x: number, y: number, z: number): boolean {
  const state = world.getBlock(x, y, z);
  const id = stateId(state);
  if (id === WHEAT) {
    if (stateMeta(state) >= WHEAT_MAX_AGE) return false;
    world.setBlock(x, y, z, packState(WHEAT, WHEAT_MAX_AGE));
    return true;
  }
  if (id === SAPLING) {
    growTree(world, x, y, z);
    return true;
  }
  if (id === TALL_GRASS) return false;
  return false;
}

/** 锄头把泥土/草方块变成耕地 */
export function tillSoil(world: ServerWorld, x: number, y: number, z: number): boolean {
  const id = stateId(world.getBlock(x, y, z));
  if (id !== DIRT && id !== GRASS_BLOCK) return false;
  // 上面得是空的
  if (stateId(world.getBlock(x, y + 1, z)) !== 0) return false;
  world.setBlock(x, y, z, packState(FARMLAND, hasWaterNearby(world, x, y, z) ? 7 : 0));
  return true;
}
