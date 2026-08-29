/**
 * 流体模拟。
 *
 * 照抄 MC 1.0 的 `BlockFlowing.updateTick`，因为水的**流向**是玩家极其熟悉的：
 * 从台子边缘倒一桶水，它会先找最近的洞口流下去而不是均匀铺开。
 * 随便写个"向四周扩散"的版本，水会像糖浆一样漫开，一眼就不对。
 *
 * 算法四步：
 *   1. 按邻居算出自己**应该**是几级：水平相邻同种流体的最小 level + 1；
 *      正上方有同种流体 → 自己是"落下"的满格
 *   2. 无限水源：两个及以上相邻的**源**会让自己也变成源（岩浆没有这条）
 *   3. 先往下流。下面能流就只往下流，不往旁边铺
 *   4. 下面流不动了，再往旁边。方向由 `findFlowDirections` 决定：
 *      往四周各做一次最多 4 格的广度搜索，找"能掉下去的洞"，
 *      只往最近的那些方向流 —— 这就是"水会拐弯找洞"的来源
 *
 * 与 MC 的偏差记在 docs/DEVIATIONS.md：不做"水冲走方块"（那要掉落物 +
 * 逐方块的 blockHardness 判定），也不做无限岩浆源（1.0 本来就没有）。
 */
import type { ServerWorld } from './server-world.ts';
import { AIR_STATE, packState, stateId, stateMeta } from '../../core/world/chunk.ts';
import {
  fluidLevel, isFalling, isWaterId, isLavaId, isFluidId, stillIdOf, flowingIdOf,
  FALLING_BIT, WATER_MAX_LEVEL, LAVA_MAX_LEVEL, WATER_TICK_RATE, LAVA_TICK_RATE,
} from '../../content/blocks-fluid.ts';
import { WORLD_HEIGHT } from '../../core/constants.ts';

/** 四个水平方向 */
const SIDES: readonly (readonly [number, number])[] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
/** 找洞时最多看几格远 */
const FLOW_SEARCH = 4;

/** 某种流体的节奏与最大流距 */
export function tickRateOf(id: number): number {
  return isWaterId(id) ? WATER_TICK_RATE : LAVA_TICK_RATE;
}
export function maxLevelOf(id: number): number {
  return isWaterId(id) ? WATER_MAX_LEVEL : LAVA_MAX_LEVEL;
}

/** 这一格能不能被流体占据（空气、草、火把这类可替换方块） */
function canFlowInto(world: ServerWorld, x: number, y: number, z: number): boolean {
  if (y < 0 || y >= WORLD_HEIGHT) return false;
  const id = stateId(world.getBlock(x, y, z));
  if (id === 0) return true;
  if (isFluidId(id)) return false; // 已经有流体了，交给等级比较处理
  return (world.tables.replaceable[id] ?? 0) !== 0;
}

/** 这一格是不是同种流体 */
function sameFluid(world: ServerWorld, x: number, y: number, z: number, water: boolean): boolean {
  const id = stateId(world.getBlock(x, y, z));
  return water ? isWaterId(id) : isLavaId(id);
}

/**
 * 推进一格流体。由计划刻驱动。
 *
 * @returns 是否需要再排一次计划刻
 */
export function tickFluid(world: ServerWorld, x: number, y: number, z: number): void {
  const state = world.getBlock(x, y, z);
  const id = stateId(state);
  if (!isFluidId(id)) return;
  const water = isWaterId(id);
  const meta = stateMeta(state);
  const level = fluidLevel(meta);
  const maxLevel = maxLevelOf(id);
  const rate = tickRateOf(id);

  // --- 1. 按邻居重算自己该是几级 ---
  let newMeta = meta;
  if (level > 0 || isFalling(meta)) {
    // 源（level 0 且非 falling）永远不变，其余的要看邻居
    let smallest = maxLevel + 1;
    let sourceCount = 0;
    for (const [dx, dz] of SIDES) {
      if (!sameFluid(world, x + dx, y, z + dz, water)) continue;
      const m = stateMeta(world.getBlock(x + dx, y, z + dz));
      // 落下来的水（falling）对邻居**按满格算**，照抄 MC 的
      // `getSmallestFlowDecay`：`if (i1 >= 8) i1 = 0`。
      //
      // 一开始我写成"跳过 falling 的邻居"，结果瀑布底下的水算出"我没有邻居"
      // 就把自己删了，下一刻又被瀑布重新灌满 —— 一个永不收敛的来回，
      // 表现是计划刻队列永远清不空、水面一直在闪。
      //
      // 但它**不算无限水源里的那个"源"**（MC 在转换之前就统计完了），
      // 所以瀑布底下不会凭空长出无限水源。
      const falling = isFalling(m);
      const l = falling ? 0 : fluidLevel(m);
      if (!falling && l === 0) sourceCount++;
      if (l < smallest) smallest = l;
    }
    newMeta = smallest >= maxLevel ? maxLevel + 1 : smallest + 1;

    // 上面有同种流体：自己是"落下"的满格
    if (sameFluid(world, x, y + 1, z, water)) newMeta = FALLING_BIT;

    // --- 2. 无限水源 ---
    // 两个及以上相邻的源 + 脚下是实心或水 = 自己也变成源。
    // 这是"挖两格灌水就能无限打水"的全部依据。岩浆没有这条
    if (water && sourceCount >= 2) {
      const below = stateId(world.getBlock(x, y - 1, z));
      if (below !== 0 && (!isFluidId(below) || fluidLevel(stateMeta(world.getBlock(x, y - 1, z))) === 0)) {
        newMeta = 0;
      }
    }
  }

  if (newMeta !== meta) {
    if (newMeta > maxLevel && !isFalling(newMeta)) {
      // 断了源，这一格干掉
      world.setBlock(x, y, z, AIR_STATE);
      scheduleNeighbors(world, x, y, z);
      return;
    }
    world.setBlock(x, y, z, packState(flowingIdOf(id), newMeta));
    world.scheduled.schedule(world.worldAge, x, y, z, flowingIdOf(id), rate);
    scheduleNeighbors(world, x, y, z);
    return;
  }

  // 稳定了就变成"静止"形态，省掉后续的计划刻
  if (stateId(world.getBlock(x, y, z)) !== stillIdOf(id) && newMeta === meta) {
    world.setBlock(x, y, z, packState(stillIdOf(id), meta));
  }

  // --- 3. 往下流 ---
  const belowY = y - 1;
  if (canFlowInto(world, x, belowY, z)) {
    placeFlow(world, x, belowY, z, id, FALLING_BIT);
    return;
  }
  if (sameFluid(world, x, belowY, z, water)) {
    const belowMeta = stateMeta(world.getBlock(x, belowY, z));
    if (!isFalling(belowMeta) && fluidLevel(belowMeta) !== 0) {
      // 下面已经有同种流体但不是满的：把它变成落下的满格
      placeFlow(world, x, belowY, z, id, FALLING_BIT);
    }
    return; // 下面通了就不往旁边铺
  }
  // 下面是可穿过但不可替换的（比如另一种流体）：也不往旁边铺
  if (!isSolidFloor(world, x, belowY, z)) return;

  // --- 4. 往旁边流 ---
  const nextLevel = fluidLevel(newMeta) + 1;
  if (nextLevel > maxLevel) return;
  const dirs = findFlowDirections(world, x, y, z, water);
  for (const [dx, dz] of dirs) {
    tryFlowSide(world, x + dx, y, z + dz, id, nextLevel);
  }
}

/** 脚下算不算"托得住流体"的地面 */
function isSolidFloor(world: ServerWorld, x: number, y: number, z: number): boolean {
  if (y < 0) return true;
  const id = stateId(world.getBlock(x, y, z));
  if (id === 0) return false;
  if (isFluidId(id)) return true;
  return (world.tables.replaceable[id] ?? 0) === 0;
}

/** 往旁边流一格。碰到另一种流体会起反应 */
function tryFlowSide(world: ServerWorld, x: number, y: number, z: number, id: number, level: number): void {
  const targetId = stateId(world.getBlock(x, y, z));
  if (isFluidId(targetId)) {
    if (reactWith(world, x, y, z, id, targetId)) return;
    // 同种流体：只有比它更满时才覆盖
    const m = stateMeta(world.getBlock(x, y, z));
    if (!isFalling(m) && fluidLevel(m) > level) placeFlow(world, x, y, z, id, level);
    return;
  }
  if (!canFlowInto(world, x, y, z)) return;
  placeFlow(world, x, y, z, id, level);
}

/** 放一格流动的流体并排上它的计划刻 */
function placeFlow(world: ServerWorld, x: number, y: number, z: number, id: number, meta: number): void {
  const flowing = flowingIdOf(id);
  const existingId = stateId(world.getBlock(x, y, z));
  if (isFluidId(existingId) && reactWith(world, x, y, z, id, existingId)) return;
  world.setBlock(x, y, z, packState(flowing, meta));
  world.scheduled.schedule(world.worldAge, x, y, z, flowing, tickRateOf(id));
}

/**
 * 水与岩浆相遇。
 *
 * MC 1.0 的三条规则，全部是玩家会主动利用的：
 *   水碰到**岩浆源** → 黑曜石（这是拿到黑曜石的唯一途径）
 *   水碰到**流动岩浆** → 圆石
 *   岩浆碰到水 → 石头
 *
 * @returns 是否发生了反应（发生了就不要再放流体了）
 */
function reactWith(
  world: ServerWorld, x: number, y: number, z: number,
  incomingId: number, existingId: number,
): boolean {
  const incomingWater = isWaterId(incomingId);
  const existingWater = isWaterId(existingId);
  if (incomingWater === existingWater) return false;

  const lavaIsExisting = !existingWater;
  if (incomingWater && lavaIsExisting) {
    // 水流进岩浆：岩浆源变黑曜石，流动岩浆变圆石
    const lavaMeta = stateMeta(world.getBlock(x, y, z));
    const isSource = fluidLevel(lavaMeta) === 0 && !isFalling(lavaMeta);
    world.setBlock(x, y, z, packState(isSource ? OBSIDIAN_ID : COBBLESTONE_ID));
    return true;
  }
  // 岩浆流进水：变石头
  world.setBlock(x, y, z, packState(STONE_ID));
  return true;
}

const OBSIDIAN_ID = 49;
const COBBLESTONE_ID = 4;
const STONE_ID = 1;

/**
 * 该往哪几个方向流。
 *
 * 对四个方向各做一次最多 4 格的搜索，看那条路上有没有"能掉下去的洞"。
 * 有洞的方向里取最近的那些；一个洞都没有就四个方向都流（水会铺开）。
 *
 * 这一步是"水会拐弯找洞"的全部来源，也是这套模拟里最贵的部分 ——
 * 所以搜索深度写死 4，与 MC 一致。
 */
function findFlowDirections(
  world: ServerWorld, x: number, y: number, z: number, water: boolean,
): (readonly [number, number])[] {
  let best = FLOW_SEARCH + 1;
  const costs: number[] = [];
  for (let i = 0; i < SIDES.length; i++) {
    const [dx, dz] = SIDES[i]!;
    let cost = FLOW_SEARCH + 1;
    if (canFlowInto(world, x + dx, y, z + dz) || sameFluid(world, x + dx, y, z + dz, water)) {
      cost = holeDistance(world, x + dx, y, z + dz, 1, -dx, -dz, water);
    }
    costs.push(cost);
    if (cost < best) best = cost;
  }
  const out: (readonly [number, number])[] = [];
  for (let i = 0; i < SIDES.length; i++) {
    if (costs[i] === best) out.push(SIDES[i]!);
  }
  return out;
}

/**
 * 从某格出发找最近的洞，返回距离。找不到返回 FLOW_SEARCH+1。
 *
 * `fromDx/fromDz` 是"来的方向"，用来避免立刻走回头路 —— 少了它，
 * 搜索会在两格之间来回弹，深度 4 变成 2。
 */
function holeDistance(
  world: ServerWorld, x: number, y: number, z: number, depth: number,
  fromDx: number, fromDz: number, water: boolean,
): number {
  if (canFlowInto(world, x, y - 1, z)) return depth;
  if (depth >= FLOW_SEARCH) return FLOW_SEARCH + 1;

  let best = FLOW_SEARCH + 1;
  for (const [dx, dz] of SIDES) {
    if (dx === fromDx && dz === fromDz) continue;
    if (!canFlowInto(world, x + dx, y, z + dz) && !sameFluid(world, x + dx, y, z + dz, water)) continue;
    const d = holeDistance(world, x + dx, y, z + dz, depth + 1, -dx, -dz, water);
    if (d < best) best = d;
  }
  return best;
}

/**
 * 给六个邻居各排一次计划刻，让它们重新算自己的等级。
 *
 * 排队时用的 id 必须是**那一格现在实际是什么**，不能一律写成"流动"形态。
 * 计划刻到期时会拿排队时的 id 和现在的比，对不上就作废（照抄 MC，
 * 用来处理"排了队又被挖掉"）—— 而静止水的 id 是 9、流动水是 8，
 * 拿 8 去排一格 9，到期时必然作废，那一格水就永远不会流。
 */
export function scheduleNeighbors(world: ServerWorld, x: number, y: number, z: number): void {
  const around: readonly (readonly [number, number, number])[] = [
    [0, -1, 0], [0, 1, 0], [-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1],
  ];
  for (const [dx, dy, dz] of around) {
    const nx = x + dx;
    const ny = y + dy;
    const nz = z + dz;
    const id = stateId(world.getBlock(nx, ny, nz));
    if (!isFluidId(id)) continue;
    world.scheduled.schedule(world.worldAge, nx, ny, nz, id, tickRateOf(id));
  }
}

/** 放下一格流体（水桶、世界生成、指令），并让它开始流 */
export function placeFluid(world: ServerWorld, x: number, y: number, z: number, id: number, meta = 0): void {
  world.setBlock(x, y, z, packState(id, meta));
  world.scheduled.schedule(world.worldAge, x, y, z, id, tickRateOf(id));
  scheduleNeighbors(world, x, y, z);
}
