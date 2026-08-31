/**
 * 传送门的**世界侧**：点火成门、踩进去传送、在对面找门或造门。
 *
 * 几何在 core/world/portal.ts（纯的、可单测），这里只做三件与世界
 * 打交道的事：读写方块、在半径内搜索、把玩家挪到另一个维度。
 *
 * ## 为什么传送要延迟
 *
 * MC 里站进门要等约 4 秒（创造模式 1 秒）才会走。这不是节流，
 * 而是**可逆性**：门是个 2×3 的洞，走路时很容易蹭到边。立刻传送的话
 * 玩家会在自家门口反复被吸进吸出。计时器让"路过"和"要进去"分得开。
 *
 * ## 冷却
 *
 * 传送落地时玩家正站在对面的门里。没有冷却的话下一刻又会被吸回去，
 * 于是在两个维度之间无限弹跳 —— 这是所有传送门实现的第一个 bug。
 */
import type { ServerCore } from '../server-core.ts';
import type { ServerPlayer } from '../player/server-player.ts';
import type { ServerWorld } from './server-world.ts';
import { packState, stateId } from '../../core/world/chunk.ts';
import {
  findPortalShape, buildPortalPlan,
  PORTAL_WIDTH, PORTAL_HEIGHT, type PortalAxis, type PortalProbe,
} from '../../core/world/portal.ts';
import {
  Dimension, convertCoords, PORTAL_SEARCH_RADIUS, type DimensionId,
} from '../../core/world/dimension.ts';
import { Blocks } from '../../content/blocks.ts';
import { WORLD_HEIGHT, TPS } from '../../core/constants.ts';
import { S_ChangeDimension } from '../../core/net/packets.ts';

/** 站在门里多久才走（刻）。MC 生存模式是 80 */
export const PORTAL_DWELL_TICKS = 80;
/** 传送之后多久内不再被门吸走 */
export const PORTAL_COOLDOWN_TICKS = 100;
/** 造新门时在目标点上下找落脚点的范围 */
const PLACEMENT_VERTICAL_RANGE = 24;

/** 一次点火的结果 */
export interface IgniteResult {
  readonly lit: boolean;
  readonly cells: number;
}

/** 这一维度里几个方块状态的缓存。每次点火都查一遍名字太浪费 */
function states(core: ServerCore): { obsidian: number; portal: number; air: number } {
  return {
    obsidian: packState(core.registry.idOf(Blocks.OBSIDIAN)),
    portal: packState(core.registry.idOf(Blocks.NETHER_PORTAL)),
    air: 0,
  };
}

/**
 * 用打火石点一个位置。成门则填上门方块。
 *
 * @returns 是否点成了门。不成门的话调用方应该照常放一团火
 */
export function ignitePortal(
  core: ServerCore, world: ServerWorld, x: number, y: number, z: number,
): IgniteResult {
  const st = states(core);
  const probe: PortalProbe = {
    isFrame: (px, py, pz) => world.getBlock(px, py, pz) === st.obsidian,
    isEmpty: (px, py, pz) => {
      const s = world.getBlock(px, py, pz);
      return s === st.air || s === st.portal;
    },
  };
  const shape = findPortalShape(probe, x, y, z);
  if (shape === null) return { lit: false, cells: 0 };
  // 元数据低位记朝向，渲染时决定薄片朝哪边
  const meta = shape.axis === 'x' ? 0 : 1;
  const state = packState(stateId(st.portal), meta);
  for (const c of shape.cells) world.setBlock(c.x, c.y, c.z, state);
  return { lit: true, cells: shape.cells.length };
}

/**
 * 玩家这一刻在不在门里。用**眼睛所在的格子**判，不用脚下那一格。
 *
 * 用脚的话，站在门的上沿（门顶那一格是框）时脚在门外，
 * 明明整个人都在紫色里却不传送。
 */
export function inPortal(world: ServerWorld, portalState: number, p: ServerPlayer): boolean {
  const bx = Math.floor(p.x);
  const bz = Math.floor(p.z);
  for (const dy of [0, 1]) {
    const s = world.getBlock(bx, Math.floor(p.y) + dy, bz);
    if (stateId(s) === stateId(portalState)) return true;
  }
  return false;
}

/**
 * 每刻推进一个玩家的传送门状态。
 *
 * 三个计数器共同决定行为：
 *   portalCooldown  刚传送完的免疫期
 *   portalTicks     已经在门里待了多久
 * 离开门就把 portalTicks 清零 —— 不清的话，反复蹭门也能攒够时间。
 */
export function tickPortal(core: ServerCore, player: ServerPlayer): void {
  const world = core.worldOf(player.dimension);
  const st = states(core);
  if (player.portalCooldown > 0) {
    player.portalCooldown--;
    // 冷却期间仍然要看是不是还站在门里：一直站着就一直续着冷却，
    // 直到走出去。否则冷却一到就又被吸走
    if (inPortal(world, st.portal, player)) player.portalCooldown = 1;
    return;
  }
  if (!inPortal(world, st.portal, player)) {
    player.portalTicks = 0;
    return;
  }
  player.portalTicks++;
  if (player.portalTicks < PORTAL_DWELL_TICKS) return;
  player.portalTicks = 0;
  const to = player.dimension === Dimension.NETHER ? Dimension.OVERWORLD : Dimension.NETHER;
  travelThroughPortal(core, player, to);
}

/**
 * 真正把玩家送过去：算落点、找门或造门、换维度。
 */
export function travelThroughPortal(
  core: ServerCore, player: ServerPlayer, to: DimensionId,
): void {
  const from = player.dimension;
  const target = convertCoords(from, to, player.x, player.z);
  const dest = core.worldOf(to);
  // 落点周围的区块必须**先生成**，否则搜索会在一片未加载的空气里
  // 找不到任何东西，然后在虚空里造一座门
  forceArea(dest, target.x, target.z, 1);

  const existing = findExistingPortal(core, dest, target.x, player.y, target.z);
  const spot = existing ?? createPortal(core, dest, target.x, player.y, target.z);
  placeInDimension(core, player, to, spot);
}

/** 把一片区块强行同步生成出来 */
function forceArea(world: ServerWorld, x: number, z: number, radius: number): void {
  const cx = x >> 4;
  const cz = z >> 4;
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) world.forceChunk(cx + dx, cz + dz);
  }
}

/** 一个可以站上去的落点 */
export interface PortalSpot {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly axis: PortalAxis;
}

/**
 * 在目标点半径内找一座现成的门。
 *
 * 按**距离由近及远**扫，不是按坐标顺序 —— 按坐标扫的话，
 * 玩家会被送到西北角那一座而不是最近的那一座，而两座门之间可能隔着
 * 半个下界。
 */
export function findExistingPortal(
  core: ServerCore, world: ServerWorld, x: number, y: number, z: number,
): PortalSpot | null {
  const st = states(core);
  let best: PortalSpot | null = null;
  let bestDist = Infinity;
  const r = Math.min(PORTAL_SEARCH_RADIUS, 64);
  // 只在已加载的区块里找。半径 128 格 = 17×17 个区块，
  // 全部强制生成要几秒钟，那会让服务端在传送的那一刻整个卡住
  for (let dx = -r; dx <= r; dx += 1) {
    for (let dz = -r; dz <= r; dz += 1) {
      const px = x + dx;
      const pz = z + dz;
      if (!world.store.isLoaded(px, pz)) continue;
      const d2 = dx * dx + dz * dz;
      if (d2 >= bestDist) continue;
      for (let py = 1; py < WORLD_HEIGHT - PORTAL_HEIGHT - 1; py++) {
        if (stateId(world.getBlock(px, py, pz)) !== stateId(st.portal)) continue;
        const found = portalAt(world, st, px, py, pz);
        if (found === null) continue;
        best = found;
        bestDist = d2;
        break;
      }
    }
  }
  return best;
}

/** 从门里的任意一格反推出这座门的落脚点 */
function portalAt(
  world: ServerWorld, st: { obsidian: number; portal: number; air: number },
  x: number, y: number, z: number,
): PortalSpot | null {
  const probe: PortalProbe = {
    isFrame: (px, py, pz) => world.getBlock(px, py, pz) === st.obsidian,
    isEmpty: (px, py, pz) => {
      const s = world.getBlock(px, py, pz);
      return s === st.air || stateId(s) === stateId(st.portal);
    },
  };
  const shape = findPortalShape(probe, x, y, z);
  if (shape === null) return null;
  return { x: shape.x, y: shape.y, z: shape.z, axis: shape.axis };
}

/**
 * 在目标点附近凭空造一座门。
 *
 * 先找一个"脚下实心、上面有 4 格空"的位置；找不到就在原地把地面
 * 铲平再造。**一定要造出一座门来** —— 造不出的话玩家会掉进
 * 目标维度的随机位置，而在下界那基本等于掉进岩浆。
 */
export function createPortal(
  core: ServerCore, world: ServerWorld, x: number, y: number, z: number,
): PortalSpot {
  const st = states(core);
  const axis: PortalAxis = 'x';
  const spot = findPlacement(world, x, y, z) ?? { x, y: Math.max(4, Math.min(y, WORLD_HEIGHT - 8)), z };

  const plan = buildPortalPlan(axis, spot.x, spot.y, spot.z);
  for (const c of plan.frame) world.setBlock(c.x, c.y, c.z, st.obsidian);
  const portalState = packState(stateId(st.portal), 0);
  for (const c of plan.interior) world.setBlock(c.x, c.y, c.z, portalState);
  // 门前铺一小块地板。不铺的话玩家一出门就掉下去，
  // 而"传送之后立刻摔死"会被当成传送本身的 bug
  for (let w = -1; w <= PORTAL_WIDTH; w++) {
    for (let d = -1; d <= 1; d++) {
      world.setBlock(spot.x + w, spot.y - 1, spot.z + d, st.obsidian);
    }
  }
  return { ...spot, axis };
}

/** 找一个能放门的地方：脚下实心，上面 PORTAL_HEIGHT+1 格是空的 */
function findPlacement(
  world: ServerWorld, x: number, y: number, z: number,
): { x: number; y: number; z: number } | null {
  const y0 = Math.max(4, Math.min(y, WORLD_HEIGHT - 10));
  for (let r = 0; r <= 6; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        // 只走"这一圈"，里面的圈上一轮已经看过了
        if (r > 0 && Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
        const px = x + dx;
        const pz = z + dz;
        if (!world.store.isLoaded(px, pz)) continue;
        for (let dy = 0; dy <= PLACEMENT_VERTICAL_RANGE; dy++) {
          for (const py of dy === 0 ? [y0] : [y0 + dy, y0 - dy]) {
            if (py < 4 || py > WORLD_HEIGHT - 8) continue;
            if (world.getBlock(px, py - 1, pz) === 0) continue;
            let clear = true;
            for (let h = 0; h < PORTAL_HEIGHT + 1 && clear; h++) {
              for (let w = 0; w < PORTAL_WIDTH && clear; w++) {
                if (world.getBlock(px + w, py + h, pz) !== 0) clear = false;
              }
            }
            if (clear) return { x: px, y: py, z: pz };
          }
        }
      }
    }
  }
  return null;
}

/** 换维度并把玩家放到落点上，通知客户端重建镜像 */
export function placeInDimension(
  core: ServerCore, player: ServerPlayer, to: DimensionId, spot: PortalSpot,
): void {
  player.dimension = to;
  // 落在门的**中间**，不是角上：站在角上有一半身子在框里，
  // 下一刻会被碰撞推出去，看起来像被门弹开
  player.x = spot.x + (spot.axis === 'x' ? PORTAL_WIDTH / 2 : 0.5);
  player.y = spot.y;
  player.z = spot.z + (spot.axis === 'z' ? PORTAL_WIDTH / 2 : 0.5);
  player.peakY = player.y;
  player.portalCooldown = PORTAL_COOLDOWN_TICKS;
  player.portalTicks = 0;
  player.resetSubscriptions();
  player.channel.send(S_ChangeDimension, {
    dimension: to, x: player.x, y: player.y, z: player.z, yaw: player.yaw,
  });
}

/** 一秒有多少刻，供上面几个常量对照 */
export const PORTAL_DWELL_SECONDS = PORTAL_DWELL_TICKS / TPS;
