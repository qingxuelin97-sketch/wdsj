/**
 * 红石。
 *
 * **与 MC 的实现有意不同**（记在 docs/DEVIATIONS.md）：MC 1.0 用的是
 * 递归的邻居通知，那套顺序会产生一批著名的"位置相关"行为（BUD、准连接、
 * 同刻更新顺序依赖）。复刻那个顺序需要逐行照抄 Java 的调用栈，而它带来的
 * 是一堆玩家会主动利用、但也公认是 bug 的行为。
 *
 * 这里改成：**把一条线路的连通分量整体重算**。
 *   1. 找出与改动点相连的全部红石线（BFS，含上下台阶）
 *   2. 每根线先取"直接功率"：来自相邻的电源（火把、拉杆、按钮、压板、中继器）
 *   3. 再从高到低传播：每传一格减 1，取最大值
 *
 * 于是可观察行为是对的（信号传 15 格、火把取反、中继器延时、活塞推拉），
 * 而顺序依赖的那部分没有。ROADMAP 用 12 个 ASCII 电路的逐刻输出锁死
 * 这些**可观察行为**，而不是锁死内部顺序。
 */
import type { ServerWorld } from './server-world.ts';
import { packState, stateId, stateMeta } from '../../core/world/chunk.ts';
import { isRedstoneWire, isPiston, REDSTONE_MAX_POWER } from '../../content/blocks-redstone.ts';
import { Facing } from '../../core/block/types.ts';
import { WORLD_HEIGHT } from '../../core/constants.ts';

/** 各元件的方块 id */
export const RS = {
  WIRE: 55,
  TORCH_OFF: 75,
  TORCH_ON: 76,
  LEVER: 69,
  STONE_PLATE: 70,
  WOOD_PLATE: 72,
  BUTTON: 77,
  REPEATER_OFF: 93,
  REPEATER_ON: 94,
  PISTON: 33,
  STICKY_PISTON: 29,
  PISTON_HEAD: 34,
  DOOR_WOOD: 64,
  DOOR_IRON: 71,
  TRAPDOOR: 96,
  DISPENSER: 23,
  NOTE_BLOCK: 25,
  LAMP_OFF: 123,
} as const;

/** 六个方向的偏移，下标与 Facing 一致 */
const DIRS: readonly (readonly [number, number, number])[] = [
  [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0],
];

/** 四个水平方向 */
const HORIZONTAL: readonly Facing[] = [Facing.NORTH, Facing.SOUTH, Facing.WEST, Facing.EAST];

/** 拉杆/按钮/压板的"开"标志位 */
const POWERED_BIT = 8;

/** 中继器的延迟档位（元数据高两位）：1..4 刻 */
export function repeaterDelay(meta: number): number {
  return ((meta >> 2) & 3) + 1;
}
/** 中继器的朝向（元数据低两位） */
export function repeaterFacing(meta: number): Facing {
  return HORIZONTAL[meta & 3] ?? Facing.NORTH;
}

/**
 * 某个方块给某一侧提供多少**强**功率。
 *
 * "强"与"弱"的区别是 MC 红石的核心：强功率能通过实心方块传出去
 * （火把顶上的方块会被充能），弱功率不能（红石线只给自己脚下那格弱充能）。
 * 少了这个区分，"火把顶石头再接线"这个最基本的电路就不成立。
 */
export function strongPowerFrom(world: ServerWorld, x: number, y: number, z: number, side: Facing): number {
  const state = world.getBlock(x, y, z);
  const id = stateId(state);
  const meta = stateMeta(state);

  switch (id) {
    case RS.TORCH_ON:
      // 红石火把往除了"它贴着的那一面"以外的所有方向给强功率；
      // 正上方也给（这就是"火把顶方块"的原理）
      return side === Facing.DOWN ? 0 : REDSTONE_MAX_POWER;
    case RS.LEVER:
    case RS.BUTTON:
      return (meta & POWERED_BIT) !== 0 ? REDSTONE_MAX_POWER : 0;
    case RS.STONE_PLATE:
    case RS.WOOD_PLATE:
      return meta > 0 ? REDSTONE_MAX_POWER : 0;
    case RS.REPEATER_ON:
      // 中继器只朝**它指的那一面**输出
      return repeaterFacing(meta) === side ? REDSTONE_MAX_POWER : 0;
    default:
      return 0;
  }
}

/** 某个方块给某一侧提供多少弱功率（红石线用它决定自己有多亮） */
export function weakPowerFrom(world: ServerWorld, x: number, y: number, z: number, side: Facing): number {
  const state = world.getBlock(x, y, z);
  const id = stateId(state);
  if (id === RS.WIRE) return stateMeta(state);
  return strongPowerFrom(world, x, y, z, side);
}

/**
 * 一格实心方块被充能了吗。
 *
 * 实心方块自己不导电，但**被强功率充能之后**会把功率转给贴着它的红石线 ——
 * 这是"火把顶一块石头，石头旁边的线亮起来"的原理。
 */
export function isBlockPowered(world: ServerWorld, x: number, y: number, z: number): boolean {
  for (let f = 0; f < DIRS.length; f++) {
    const [dx, dy, dz] = DIRS[f]!;
    // 从邻居看过来，它朝向我这一面的反面
    const opposite = (f % 2 === 0 ? f + 1 : f - 1) as Facing;
    if (strongPowerFrom(world, x + dx, y + dy, z + dz, opposite) > 0) return true;
  }
  return false;
}

/** 某一格是不是能挡住红石线连接的实心方块 */
function isSolidForWire(world: ServerWorld, x: number, y: number, z: number): boolean {
  const id = stateId(world.getBlock(x, y, z));
  if (id === 0) return false;
  return (world.tables.fullCube[id] ?? 0) !== 0;
}

/**
 * 一根红石线连到哪几个邻居。
 *
 * 连接规则（照抄 MC 的可观察行为）：
 *   同高度的相邻红石线 —— 总是连
 *   高一格的红石线 —— 只有当**自己头顶不是实心方块**时才连（爬坡）
 *   低一格的红石线 —— 只有当**中间那格不是实心方块**时才连（下坡）
 */
function wireNeighbors(world: ServerWorld, x: number, y: number, z: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  const topClear = !isSolidForWire(world, x, y + 1, z);
  for (const f of HORIZONTAL) {
    const [dx, , dz] = DIRS[f]!;
    const nx = x + dx;
    const nz = z + dz;
    if (isRedstoneWire(stateId(world.getBlock(nx, y, nz)))) {
      out.push([nx, y, nz]);
      continue;
    }
    // 爬坡
    if (topClear && isRedstoneWire(stateId(world.getBlock(nx, y + 1, nz)))) {
      out.push([nx, y + 1, nz]);
    }
    // 下坡
    if (!isSolidForWire(world, nx, y, nz) && isRedstoneWire(stateId(world.getBlock(nx, y - 1, nz)))) {
      out.push([nx, y - 1, nz]);
    }
  }
  return out;
}

/** 坐标打包成字符串键。红石网络一般只有几十格，不值得为它做定点编码 */
function key(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

/** 一个红石网络最多多少格。超了就放弃重算 —— 那多半是有人在造一台巨型机器 */
const MAX_NETWORK = 4096;

/**
 * 重算包含 (x,y,z) 的整个红石线网络。
 *
 * @returns 功率真的变了的那些格子，调用方拿去做邻居通知
 */
export function updateWireNetwork(
  world: ServerWorld, x: number, y: number, z: number,
): [number, number, number][] {
  if (!isRedstoneWire(stateId(world.getBlock(x, y, z)))) return [];

  // --- 1. 收集连通分量 ---
  const nodes: [number, number, number][] = [];
  const index = new Map<string, number>();
  const stack: [number, number, number][] = [[x, y, z]];
  index.set(key(x, y, z), 0);
  nodes.push([x, y, z]);
  while (stack.length > 0 && nodes.length < MAX_NETWORK) {
    const [cx, cy, cz] = stack.pop()!;
    for (const n of wireNeighbors(world, cx, cy, cz)) {
      const k = key(n[0], n[1], n[2]);
      if (index.has(k)) continue;
      index.set(k, nodes.length);
      nodes.push(n);
      stack.push(n);
    }
  }

  // --- 2. 每根线的直接功率 ---
  const power = new Int32Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const [nx, ny, nz] = nodes[i]!;
    let best = 0;
    for (let f = 0; f < DIRS.length; f++) {
      const [dx, dy, dz] = DIRS[f]!;
      const opposite = (f % 2 === 0 ? f + 1 : f - 1) as Facing;
      const bx = nx + dx;
      const by = ny + dy;
      const bz = nz + dz;
      if (by < 0 || by >= WORLD_HEIGHT) continue;
      // 直接相邻的电源
      const direct = strongPowerFrom(world, bx, by, bz, opposite);
      if (direct > best) best = direct;
      // 被充能的实心方块也会把功率转过来
      if (direct === 0 && isSolidForWire(world, bx, by, bz) && isBlockPowered(world, bx, by, bz)) {
        if (REDSTONE_MAX_POWER > best) best = REDSTONE_MAX_POWER;
      }
    }
    power[i] = best;
  }

  // --- 3. 传播：从高到低，每格减 1 ---
  //
  // 用"按功率分桶"的方式做，等价于 Dijkstra 但不需要堆：
  // 功率只有 0..15 十六档，从高往低扫一遍就能保证每格拿到最大值
  const buckets: number[][] = Array.from({ length: REDSTONE_MAX_POWER + 1 }, () => []);
  for (let i = 0; i < nodes.length; i++) {
    if (power[i]! > 0) buckets[power[i]!]!.push(i);
  }
  for (let p = REDSTONE_MAX_POWER; p > 1; p--) {
    for (const i of buckets[p]!) {
      if (power[i]! !== p) continue; // 后来被更高的覆盖了
      const [nx, ny, nz] = nodes[i]!;
      for (const n of wireNeighbors(world, nx, ny, nz)) {
        const j = index.get(key(n[0], n[1], n[2]));
        if (j === undefined) continue;
        if (power[j]! >= p - 1) continue;
        power[j] = p - 1;
        buckets[p - 1]!.push(j);
      }
    }
  }

  // --- 4. 写回，收集变了的 ---
  const changed: [number, number, number][] = [];
  for (let i = 0; i < nodes.length; i++) {
    const [nx, ny, nz] = nodes[i]!;
    const old = stateMeta(world.getBlock(nx, ny, nz));
    if (old === power[i]) continue;
    world.setBlockQuiet(nx, ny, nz, packState(RS.WIRE, power[i]!));
    changed.push([nx, ny, nz]);
  }
  return changed;
}

/**
 * 某一格收到的红石功率（含线、直接电源、被充能的方块）。
 *
 * 活塞、门、发射器这些"被驱动"的元件用它判断自己该不该动。
 */
export function receivedPower(world: ServerWorld, x: number, y: number, z: number): number {
  let best = 0;
  for (let f = 0; f < DIRS.length; f++) {
    const [dx, dy, dz] = DIRS[f]!;
    const bx = x + dx;
    const by = y + dy;
    const bz = z + dz;
    if (by < 0 || by >= WORLD_HEIGHT) continue;
    const opposite = (f % 2 === 0 ? f + 1 : f - 1) as Facing;
    const id = stateId(world.getBlock(bx, by, bz));

    if (id === RS.WIRE) {
      // 红石线只给**它脚下**和它连着的方向弱充能，不给正上方
      if (dy === 1) continue;
      const p = stateMeta(world.getBlock(bx, by, bz));
      if (p > best) best = p;
      continue;
    }
    const direct = strongPowerFrom(world, bx, by, bz, opposite);
    if (direct > best) best = direct;
    // 被强功率充能的实心方块
    if (direct === 0 && isSolidForWire(world, bx, by, bz) && isBlockPowered(world, bx, by, bz)) {
      best = REDSTONE_MAX_POWER;
    }
  }
  void isPiston;
  return best;
}
