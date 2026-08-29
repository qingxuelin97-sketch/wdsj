/**
 * 红石元件的行为：火把取反、中继器延时、活塞推拉、门与发射器被驱动。
 *
 * 分工：`redstone.ts` 只回答"某处有多少功率"（纯查询 + 线网重算），
 * 这里负责"功率变了之后谁该动"。分开是因为前者会被后者反复调用，
 * 而且它是可以单独测的纯函数。
 *
 * 所有会"延时"的元件都走计划刻队列（M9 建的）：
 *   红石火把 2 刻、中继器 1..4 刻、活塞立即但推拉本身占一刻。
 * 这些延时不是实现细节，它们就是红石电路能做出时钟与触发器的原因。
 */
import type { ServerWorld } from './server-world.ts';
import { AIR_STATE, packState, stateId, stateMeta } from '../../core/world/chunk.ts';
import { Facing } from '../../core/block/types.ts';
import {
  RS, receivedPower, updateWireNetwork, repeaterDelay, repeaterFacing,
} from './redstone.ts';
import { PISTON_PUSH_LIMIT, PISTON_EXTENDED_BIT, pistonFacing, pistonExtended } from '../../content/blocks-redstone.ts';
import { WORLD_HEIGHT } from '../../core/constants.ts';

/** 红石火把的响应延时 */
export const TORCH_DELAY = 2;
/** 活塞伸缩的延时 */
export const PISTON_DELAY = 1;

const DIRS: readonly (readonly [number, number, number])[] = [
  [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0],
];

/** 这个 id 是不是需要在功率变化时被通知的元件 */
export function isRedstoneComponent(id: number): boolean {
  return id === RS.WIRE || id === RS.TORCH_ON || id === RS.TORCH_OFF
    || id === RS.REPEATER_OFF || id === RS.REPEATER_ON
    || id === RS.PISTON || id === RS.STICKY_PISTON
    || id === RS.DOOR_WOOD || id === RS.DOOR_IRON || id === RS.TRAPDOOR
    || id === RS.DISPENSER || id === RS.NOTE_BLOCK;
}

/**
 * 某一格（或它的邻居）变了，把受影响的红石元件排上计划刻。
 *
 * 半径取 2：红石线自己会整网重算，而元件只看直接相邻 + 隔一格的
 * "被充能的方块"。再大就会在每次挖方块时排一大堆无用的刻。
 */
export function notifyRedstone(world: ServerWorld, x: number, y: number, z: number): void {
  // --- 1. 线网整体重算，立刻生效（线没有延时）---
  //
  // **每一侧的线网都要算**，不能找到第一个就收工：中继器的输入侧与输出侧
  // 是两个互不相连的网络，只算到输入那个的话，输出侧永远不会亮 ——
  // 而这看起来就像"中继器坏了"。重复调用是幂等的，最多多跑几趟 BFS
  const changedWires: [number, number, number][] = [];
  for (const [dx, dy, dz] of [[0, 0, 0], ...DIRS]) {
    const nx = x + dx;
    const ny = y + dy;
    const nz = z + dz;
    if (ny < 0 || ny >= WORLD_HEIGHT) continue;
    if (stateId(world.getBlock(nx, ny, nz)) === RS.WIRE) {
      changedWires.push(...updateWireNetwork(world, nx, ny, nz));
    }
  }

  // --- 2. 元件排计划刻 ---
  //
  // 不只在改动点周围找，**每一根功率变了的线周围也要找**。
  //
  // 线网重算走的是 setBlockQuiet（不触发邻域通知，否则会无限递归），
  // 所以线变亮这件事不会自己往外扩散。少了这一步，一条十五格长的线
  // 尽头那个火把永远收不到消息 —— 拉杆一拉线全亮了，火把纹丝不动，
  // 看起来像非门根本没实现
  notifyAround(world, x, y, z);
  for (const [wx, wy, wz] of changedWires) notifyAround(world, wx, wy, wz);
}

/** 把 (x,y,z) 周围半径 2 内的红石元件排上计划刻 */
function notifyAround(world: ServerWorld, x: number, y: number, z: number): void {
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dz = -2; dz <= 2; dz++) {
        const nx = x + dx;
        const ny = y + dy;
        const nz = z + dz;
        if (ny < 0 || ny >= WORLD_HEIGHT) continue;
        const id = stateId(world.getBlock(nx, ny, nz));
        if (!isRedstoneComponent(id) || id === RS.WIRE) continue;
        const delay = id === RS.TORCH_ON || id === RS.TORCH_OFF
          ? TORCH_DELAY
          : (id === RS.REPEATER_OFF || id === RS.REPEATER_ON
            ? repeaterDelay(stateMeta(world.getBlock(nx, ny, nz)))
            : PISTON_DELAY);
        world.scheduled.schedule(world.worldAge, nx, ny, nz, id, delay);
      }
    }
  }
}

/**
 * 一个红石元件的计划刻到期了。
 *
 * @returns 是否真的改变了什么（调用方据此决定要不要再通知一圈）
 */
export function tickRedstoneComponent(world: ServerWorld, x: number, y: number, z: number, id: number): boolean {
  switch (id) {
    case RS.TORCH_ON:
    case RS.TORCH_OFF:
      return tickTorch(world, x, y, z, id === RS.TORCH_ON);
    case RS.REPEATER_OFF:
    case RS.REPEATER_ON:
      return tickRepeater(world, x, y, z, id === RS.REPEATER_ON);
    case RS.PISTON:
    case RS.STICKY_PISTON:
      return tickPiston(world, x, y, z, id);
    case RS.DOOR_WOOD:
    case RS.DOOR_IRON:
    case RS.TRAPDOOR:
      return tickDoor(world, x, y, z, id);
    default:
      return false;
  }
}

/**
 * 红石火把：**取反**它所依附的那个方块。
 *
 * 依附的方块被充能 -> 火把灭；没被充能 -> 火把亮。
 * 一个逻辑非门，而整套红石逻辑（与、或、异或、触发器）都是用它搭出来的。
 *
 * 元数据低 3 位是它贴在哪一面（照抄普通火把）。
 */
function tickTorch(world: ServerWorld, x: number, y: number, z: number, wasOn: boolean): boolean {
  const meta = stateMeta(world.getBlock(x, y, z));
  const attached = torchSupportPos(x, y, z, meta);
  const supportPowered = receivedPower(world, attached[0], attached[1], attached[2]) > 0;
  const shouldBeOn = !supportPowered;
  if (shouldBeOn === wasOn) return false;
  world.setBlock(x, y, z, packState(shouldBeOn ? RS.TORCH_ON : RS.TORCH_OFF, meta));
  return true;
}

/** 火把贴在哪一格上。meta 与普通火把一致：0=立地，1..4 贴四面 */
function torchSupportPos(x: number, y: number, z: number, meta: number): [number, number, number] {
  switch (meta & 7) {
    case 1: return [x - 1, y, z];
    case 2: return [x + 1, y, z];
    case 3: return [x, y, z - 1];
    case 4: return [x, y, z + 1];
    default: return [x, y - 1, z];
  }
}

/**
 * 中继器：延时 + 单向 + 整形。
 *
 * 输入来自它**背后**那一面，输出到它指的那一面，而且不管输入多弱，
 * 输出永远是满 15 —— 这就是"中继器能把衰减到 1 的信号救回来"的原理。
 */
function tickRepeater(world: ServerWorld, x: number, y: number, z: number, wasOn: boolean): boolean {
  const meta = stateMeta(world.getBlock(x, y, z));
  const facing = repeaterFacing(meta);
  const back = oppositeOf(facing);
  const [dx, dy, dz] = DIRS[back]!;
  const shouldBeOn = receivedPower(world, x + dx, y + dy, z + dz) > 0;
  if (shouldBeOn === wasOn) return false;
  world.setBlock(x, y, z, packState(shouldBeOn ? RS.REPEATER_ON : RS.REPEATER_OFF, meta));
  return true;
}

function oppositeOf(f: Facing): Facing {
  return (f % 2 === 0 ? f + 1 : f - 1) as Facing;
}

/**
 * 活塞：通电伸出、断电缩回。
 *
 * 伸出时把前方最多 12 个方块整体往前推一格；粘性活塞缩回时把紧贴着
 * 活塞头的那一格拉回来。推不动（碰到基岩、超过 12 格、前面是空气之外的
 * 不可推方块）就不动。
 */
function tickPiston(world: ServerWorld, x: number, y: number, z: number, id: number): boolean {
  const state = world.getBlock(x, y, z);
  const meta = stateMeta(state);
  const facing = pistonFacing(meta);
  const extended = pistonExtended(meta);
  const powered = receivedPower(world, x, y, z) > 0;
  if (powered === extended) return false;

  const [dx, dy, dz] = DIRS[facing]!;
  if (powered) {
    if (!pushBlocks(world, x + dx, y + dy, z + dz, dx, dy, dz)) return false;
    world.setBlock(x, y, z, packState(id, (meta & 7) | PISTON_EXTENDED_BIT));
    world.setBlock(x + dx, y + dy, z + dz, packState(RS.PISTON_HEAD, facing));
    return true;
  }

  // 缩回：先把活塞头拿掉
  if (stateId(world.getBlock(x + dx, y + dy, z + dz)) === RS.PISTON_HEAD) {
    world.setBlock(x + dx, y + dy, z + dz, AIR_STATE);
  }
  world.setBlock(x, y, z, packState(id, meta & 7));
  // 粘性活塞把前面那一格拉回来
  if (id === RS.STICKY_PISTON) {
    const px = x + dx * 2;
    const py = y + dy * 2;
    const pz = z + dz * 2;
    const pulled = world.getBlock(px, py, pz);
    if (isPushable(world, stateId(pulled))) {
      world.setBlock(px, py, pz, AIR_STATE);
      world.setBlock(x + dx, y + dy, z + dz, pulled);
    }
  }
  return true;
}

/** 这个方块推得动吗 */
function isPushable(world: ServerWorld, id: number): boolean {
  if (id === 0) return false;
  // 不可破坏的（基岩）推不动；方块实体（箱子、熔炉）在 1.0 里也推不动
  if ((world.tables.hardness[id] ?? 0) < 0) return false;
  if (id === 54 || id === 61 || id === 62 || id === 23) return false;
  if (id === RS.PISTON_HEAD) return false;
  return true;
}

/**
 * 把从 (x,y,z) 开始的一串方块往 (dx,dy,dz) 推一格。
 * 推不动返回 false，什么都不改。
 */
function pushBlocks(world: ServerWorld, x: number, y: number, z: number, dx: number, dy: number, dz: number): boolean {
  const chain: number[] = [];
  let cx = x;
  let cy = y;
  let cz = z;
  for (let i = 0; i <= PISTON_PUSH_LIMIT; i++) {
    if (cy < 0 || cy >= WORLD_HEIGHT) return false;
    const state = world.getBlock(cx, cy, cz);
    const id = stateId(state);
    // 空气或可替换方块：链子到头了，可以推
    if (id === 0 || (world.tables.replaceable[id] ?? 0) !== 0) break;
    if (!isPushable(world, id)) return false;
    if (chain.length >= PISTON_PUSH_LIMIT) return false;
    chain.push(state);
    cx += dx;
    cy += dy;
    cz += dz;
  }

  // 从最远的开始往前搬，否则会自己覆盖自己
  for (let i = chain.length - 1; i >= 0; i--) {
    const fromX = x + dx * i;
    const fromY = y + dy * i;
    const fromZ = z + dz * i;
    world.setBlock(fromX + dx, fromY + dy, fromZ + dz, chain[i]!);
  }
  if (chain.length > 0) world.setBlock(x, y, z, AIR_STATE);
  return true;
}

/** 门 / 活板门：通电就开。元数据第 4 位（4）是"开着" */
function tickDoor(world: ServerWorld, x: number, y: number, z: number, id: number): boolean {
  const meta = stateMeta(world.getBlock(x, y, z));
  const open = (meta & 4) !== 0;
  const powered = receivedPower(world, x, y, z) > 0;
  if (powered === open) return false;
  world.setBlock(x, y, z, packState(id, powered ? (meta | 4) : (meta & ~4)));
  return true;
}
