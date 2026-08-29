/**
 * 计划刻的分发，以及重力方块、火、TNT 三种按刻演化的行为。
 *
 * 计划刻队列（M9 建的）到这里才第一次真正被用上。分发是一张按方块 id 的
 * switch —— 不做成方块钩子，因为这些行为需要读写**周围一片**世界，
 * 而钩子拿到的是一个刻意做窄的 `MutableBlockView`。
 *
 * 三种行为的共同点是"变化不在当刻发生"：
 *   沙子失去支撑后**下一刻**才开始掉，玩家来得及在下面补一格
 *   火烧掉可燃物要等好几刻，来得及扑
 *   TNT 点着后 80 刻才炸，来得及跑
 * 这些延迟不是实现的副产物，它们就是玩法本身。
 */
import type { ServerWorld } from './server-world.ts';
import { AIR_STATE, packState, stateId, stateMeta } from '../../core/world/chunk.ts';
import { tickFluid, scheduleNeighbors, tickRateOf as fluidTickRate } from './fluid.ts';
import { isFluidId, isLavaId } from '../../content/blocks-fluid.ts';
import { WORLD_HEIGHT } from '../../core/constants.ts';

/** 沙子 / 砾石 */
const SAND_ID = 12;
const GRAVEL_ID = 13;
const FIRE_ID = 51;
const TNT_ID = 46;

/** 重力方块每多少刻掉一格 */
export const FALL_INTERVAL = 1;
/** TNT 的引信长度 */
export const TNT_FUSE_TICKS = 80;
/** TNT 的爆炸威力 */
export const TNT_POWER = 4;
/** 火每隔多少刻演化一次 */
export const FIRE_TICK_RATE = 30;
/** 火烧到第几"岁"就灭 */
const FIRE_MAX_AGE = 15;

export function isFallingBlock(id: number): boolean {
  return id === SAND_ID || id === GRAVEL_ID;
}

/**
 * 一条计划刻到期了。
 *
 * `blockId` 是排队时那一格的方块 id；到期时方块已经变了就直接作废 ——
 * 照抄 MC。少了这条判断，"放一格水又立刻挖掉"会在几刻之后凭空冒出一格水。
 */
export function runScheduledTick(
  world: ServerWorld, x: number, y: number, z: number, blockId: number,
  explode: (x: number, y: number, z: number, power: number) => void,
): void {
  const current = stateId(world.getBlock(x, y, z));
  if (current !== blockId) return;

  if (isFluidId(blockId)) {
    tickFluid(world, x, y, z);
    return;
  }
  if (isFallingBlock(blockId)) {
    tickFallingBlock(world, x, y, z, blockId);
    return;
  }
  if (blockId === FIRE_ID) {
    tickFire(world, x, y, z);
    return;
  }
  if (blockId === TNT_ID) {
    // 引信烧完：先把方块拿掉再炸，否则爆炸会把自己算进去两次
    world.setBlock(x, y, z, AIR_STATE);
    explode(x + 0.5, y + 0.5, z + 0.5, TNT_POWER);
  }
}

// ---------------------------------------------------------------------------
// 重力方块
// ---------------------------------------------------------------------------

/**
 * 沙子/砾石往下掉一格。
 *
 * 与 MC 的偏差（记在 docs/DEVIATIONS.md）：MC 把方块变成一个会加速下落的
 * 实体，这里是**每刻挪一格**。做实体要再加一种实体类型与一条同步通道，
 * 而玩家能观察到的三件事 —— 失去支撑就掉、落在障碍上停住、能砸灭火把 ——
 * 挪格子的版本全都成立。下落速度偏快（20 格/秒对 MC 的加速下落），
 * 留到 M14 表现层再补。
 */
export function tickFallingBlock(world: ServerWorld, x: number, y: number, z: number, id: number): void {
  if (y <= 0) return;
  if (!canFallInto(world, x, y - 1, z)) return;
  world.setBlock(x, y, z, AIR_STATE);
  world.setBlock(x, y - 1, z, packState(id));
  // 还能继续掉就再排一刻；同时通知上面那格（它可能也该掉了）
  world.scheduled.schedule(world.worldAge, x, y - 1, z, id, FALL_INTERVAL);
  notifyFallAbove(world, x, y, z);
}

/** 这一格能不能被落下来的方块占掉 */
function canFallInto(world: ServerWorld, x: number, y: number, z: number): boolean {
  if (y < 0) return false;
  const id = stateId(world.getBlock(x, y, z));
  if (id === 0) return true;
  if (isFluidId(id)) return true; // 沙子会填进水里
  return (world.tables.replaceable[id] ?? 0) !== 0;
}

/** 通知正上方的重力方块"你脚下空了" */
export function notifyFallAbove(world: ServerWorld, x: number, y: number, z: number): void {
  for (let up = y; up < Math.min(WORLD_HEIGHT, y + 3); up++) {
    const id = stateId(world.getBlock(x, up, z));
    if (!isFallingBlock(id)) break;
    world.scheduled.schedule(world.worldAge, x, up, z, id, FALL_INTERVAL);
  }
}

/**
 * 一格方块变了之后，看看有没有东西该掉下来 / 该重新流。
 * 由 ServerWorld.setBlock 在每次变更后调一次。
 */
export function onBlockChanged(world: ServerWorld, x: number, y: number, z: number): void {
  // 正上方的重力方块
  notifyFallAbove(world, x, y + 1, z);
  // 自己也可能是刚放下的重力方块
  const id = stateId(world.getBlock(x, y, z));
  if (isFallingBlock(id) && canFallInto(world, x, y - 1, z)) {
    world.scheduled.schedule(world.worldAge, x, y, z, id, FALL_INTERVAL);
  }
  // 周围的流体要重新算
  scheduleNeighbors(world, x, y, z);
  // 自己要是刚被放下的流体，也得排上 —— scheduleNeighbors 只管**邻居**。
  // 少了这一条，`setblock x y z water` 会放下一格永远不流的水，
  // 而它看起来和一个正常的水源一模一样
  if (isFluidId(id)) {
    world.scheduled.schedule(world.worldAge, x, y, z, id, fluidTickRate(id));
  }
}

// ---------------------------------------------------------------------------
// 火
// ---------------------------------------------------------------------------

/**
 * 火的一刻：变老、烧掉脚下的可燃物、点着邻居、没柴就灭。
 *
 * 元数据是火的"年龄" 0..15。年龄越大越容易熄灭，这让火看起来是会自己
 * 烧完的而不是永久的 —— 除非底下是萤石/下界岩那种"永久火"的支撑。
 */
export function tickFire(world: ServerWorld, x: number, y: number, z: number): void {
  const age = stateMeta(world.getBlock(x, y, z));
  const rng = world.random;

  // 脚下与四周都不可燃 -> 灭
  if (!hasFuelAround(world, x, y, z)) {
    world.setBlock(x, y, z, AIR_STATE);
    return;
  }

  // 变老。老到头就灭
  const nextAge = Math.min(FIRE_MAX_AGE, age + rng.nextInt(3) / 2 | 0);
  if (age === FIRE_MAX_AGE && rng.nextInt(4) === 0) {
    world.setBlock(x, y, z, AIR_STATE);
    return;
  }
  if (nextAge !== age) world.setBlock(x, y, z, packState(FIRE_ID, nextAge));

  // 烧掉脚下的可燃物
  const belowId = stateId(world.getBlock(x, y - 1, z));
  const belowFlammability = world.tables.flammability[belowId] ?? 0;
  if (belowFlammability > 0 && rng.nextInt(100) < belowFlammability) {
    world.setBlock(x, y - 1, z, AIR_STATE);
  }

  // 点着邻居：六个方向各试一次
  const around: readonly (readonly [number, number, number])[] = [
    [-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1],
  ];
  for (const [dx, dy, dz] of around) {
    const nx = x + dx;
    const ny = y + dy;
    const nz = z + dz;
    if (ny < 0 || ny >= WORLD_HEIGHT) continue;
    const id = stateId(world.getBlock(nx, ny, nz));
    const flam = world.tables.flammability[id] ?? 0;
    if (flam <= 0) continue;
    // 越可燃越容易被点着；年龄越大点着的机会越小
    if (rng.nextInt(FIRE_MAX_AGE + 10) > flam / 3) continue;
    world.setBlock(nx, ny, nz, packState(FIRE_ID, Math.min(FIRE_MAX_AGE, nextAge + rng.nextInt(5) / 4 | 0)));
    world.scheduled.schedule(world.worldAge, nx, ny, nz, FIRE_ID, FIRE_TICK_RATE + rng.nextInt(10));
  }

  world.scheduled.schedule(world.worldAge, x, y, z, FIRE_ID, FIRE_TICK_RATE + rng.nextInt(10));
}

/** 火脚下或四周有没有可烧的 */
function hasFuelAround(world: ServerWorld, x: number, y: number, z: number): boolean {
  const around: readonly (readonly [number, number, number])[] = [
    [0, -1, 0], [-1, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1],
  ];
  for (const [dx, dy, dz] of around) {
    const id = stateId(world.getBlock(x + dx, y + dy, z + dz));
    if ((world.tables.flammability[id] ?? 0) > 0) return true;
    // 岩浆上方的火不用柴
    if (isLavaId(id) && dy === -1) return true;
  }
  return false;
}

/** 点一把火。放不下（那一格不是空气）就什么都不做 */
export function igniteAt(world: ServerWorld, x: number, y: number, z: number): boolean {
  if (stateId(world.getBlock(x, y, z)) !== 0) return false;
  if (!hasFuelAround(world, x, y, z)) return false;
  world.setBlock(x, y, z, packState(FIRE_ID, 0));
  world.scheduled.schedule(world.worldAge, x, y, z, FIRE_ID, FIRE_TICK_RATE + world.random.nextInt(10));
  return true;
}

/** 点着一块 TNT：方块留着（客户端要画它在闪），80 刻后炸 */
export function primeTnt(world: ServerWorld, x: number, y: number, z: number): boolean {
  if (stateId(world.getBlock(x, y, z)) !== TNT_ID) return false;
  world.scheduled.schedule(world.worldAge, x, y, z, TNT_ID, TNT_FUSE_TICKS);
  return true;
}
