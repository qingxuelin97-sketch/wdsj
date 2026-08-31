/**
 * 末地传送门：找要塞、装眼、激活、进末地。
 *
 * 这是整条主线的最后一段接缝。它跨的系统比下界传送门还多
 * （物品 → 结构 → 方块元数据 → 维度），但每一步都很短 ——
 * 长的是把它们连起来时那些"差一格"的地方，所以下面每一条
 * 都写了为什么是这个数。
 */
import type { ServerCore } from '../server-core.ts';
import type { ServerPlayer } from '../player/server-player.ts';
import type { ServerWorld } from './server-world.ts';
import { packState, stateId, stateMeta } from '../../core/world/chunk.ts';
import { Blocks } from '../../content/blocks.ts';
import { MobType, mobDefOf } from '../../content/mobs.ts';
import { nearestStronghold, portalFrameCells, PORTAL_ROOM_Y } from './gen/stronghold.ts';
import { Dimension } from '../../core/world/dimension.ts';
import { placeInDimension } from './portal-manager.ts';
import { END_ARRIVAL } from './gen/end-gen.ts';
import { beginDragonFight } from '../entity/dragon.ts';
import { WORLD_HEIGHT } from '../../core/constants.ts';

/** 框架元数据里"嵌了眼"的位 */
export const FRAME_HAS_EYE = 4;
/** 一个完整的末地传送门要几个框架 */
export const FRAMES_NEEDED = 12;
/** 扔出去的眼飞多快（格/刻） */
const EYE_SPEED = 0.9;
/** 眼最多飞多久就消失 */
const EYE_LIFETIME = 80;

/**
 * 扔一颗末影之眼：它朝最近的要塞飞一段然后消失。
 *
 * 飞**一段**而不是一路飞到要塞：要塞可能在 1000 格外，
 * 全程飞过去要一分钟，而且沿途会把几百个区块加载出来。
 * MC 也是飞十几格就停 —— 玩家看的是方向，不是终点。
 */
export function throwEnderEye(core: ServerCore, player: ServerPlayer): boolean {
  if (player.dimension !== Dimension.OVERWORLD) return false;
  const def = mobDefOf(MobType.ENDER_EYE);
  if (def === null) return false;
  const site = nearestStronghold(core.world.seed, player.x, player.z);
  const dx = site.x - player.x;
  const dz = site.z - player.z;
  const len = Math.hypot(dx, dz) || 1;
  const eye = core.mobs.spawn(def, player.x, player.y + 1.6, player.z, player.dimension);
  eye.body.vx = (dx / len) * EYE_SPEED;
  eye.body.vz = (dz / len) * EYE_SPEED;
  // 先上后下的抛物感：给一点初速，tick 里再慢慢压下去
  eye.body.vy = 0.12;
  eye.body.yaw = Math.atan2(dx, dz);
  eye.headYaw = eye.body.yaw;
  // targetId 借来存"谁扔的"，与火球同一套约定
  eye.targetId = player.entityId;
  return true;
}

/**
 * 眼的一刻。
 *
 * @returns 是不是该把它从世界里拿掉
 */
export function tickEnderEye(mob: { age: number; body: { vy: number } }): boolean {
  mob.body.vy -= 0.004;
  return mob.age > EYE_LIFETIME;
}

/**
 * 右键一块框架，把眼嵌进去。
 *
 * @returns 是否嵌上了。已经有眼、或者那不是框架，都返回 false
 *          （返回 false 让调用方不要消耗物品 —— 白吃一颗眼
 *          在 MC 里是要骂人的）
 */
export function insertEye(
  core: ServerCore, world: ServerWorld, x: number, y: number, z: number,
): boolean {
  const frameId = core.registry.idOf(Blocks.END_PORTAL_FRAME);
  const state = world.getBlock(x, y, z);
  if (stateId(state) !== frameId) return false;
  const meta = stateMeta(state);
  if ((meta & FRAME_HAS_EYE) !== 0) return false;
  world.setBlock(x, y, z, packState(frameId, meta | FRAME_HAS_EYE));
  return true;
}

/**
 * 十二块都嵌上了吗；是的话把传送门点亮。
 *
 * 判定不靠"数一数附近有几块带眼的框架"，而是**从要塞的定义位置
 * 反推那十二格该在哪**。数数的做法会被玩家自己摆的框架骗到，
 * 而且在两座要塞挨得近时会串。
 *
 * @returns 这一次是不是刚好点亮了
 */
export function tryActivateEndPortal(
  core: ServerCore, world: ServerWorld, nearX: number, nearZ: number,
): boolean {
  const site = nearestStronghold(world.seed, nearX, nearZ);
  // 离得太远就不是这座要塞的事
  if (Math.hypot(site.x - nearX, site.z - nearZ) > 32) return false;
  const frameId = core.registry.idOf(Blocks.END_PORTAL_FRAME);
  for (const f of portalFrameCells(site)) {
    const s = world.getBlock(f.x, PORTAL_ROOM_Y, f.z);
    if (stateId(s) !== frameId) return false;
    if ((stateMeta(s) & FRAME_HAS_EYE) === 0) return false;
  }
  // 已经点亮过就不再重复（会白白广播 9 次方块变更）
  const portalId = core.registry.idOf(Blocks.END_PORTAL);
  if (stateId(world.getBlock(site.x, PORTAL_ROOM_Y, site.z)) === portalId) return false;
  const portal = packState(portalId);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      world.setBlock(site.x + dx, PORTAL_ROOM_Y, site.z + dz, portal);
    }
  }
  return true;
}

/**
 * 玩家踩进末地传送门了吗；是的话送过去。
 *
 * 与下界门不同，末地门**立刻**生效，没有 4 秒等待 ——
 * 它躺在地上，不可能"路过"，等待只会让人以为门坏了。
 */
export function tickEndPortal(core: ServerCore, player: ServerPlayer): void {
  if (player.portalCooldown > 0) return;
  const world = core.worldOf(player.dimension);
  const portalId = core.registry.idOf(Blocks.END_PORTAL);
  const bx = Math.floor(player.x);
  const by = Math.floor(player.y);
  const bz = Math.floor(player.z);
  let inside = false;
  for (const dy of [0, -1]) {
    if (stateId(world.getBlock(bx, by + dy, bz)) === portalId) inside = true;
  }
  if (!inside) return;

  if (player.dimension === Dimension.END) {
    // 从末地出去：回主世界的出生点
    goToOverworldSpawn(core, player);
    return;
  }
  enterTheEnd(core, player);
}

/** 送进末地。落点固定在原点上方，与 MC 一致 */
export function enterTheEnd(core: ServerCore, player: ServerPlayer): boolean {
  const end = core.worldOf(Dimension.END);
  // 与下界同理：存档没读进来就先别送，下一刻再来。
  // 强行 force 出来的末地会把上次打龙时炸出来的地形永久顶掉
  if (!end.areaReadyForForce(0, 0, 1)) return false;
  // 2×2 个区块，不是一个。平台跨 x=-2..2 / z=-2..2，
  // 而原点那一格在区块 (0,0) 的角上 —— 只 force (0,0) 的话
  // 平台有一半落在没加载的区块里，setBlock 静默失败，
  // 铺出来是个缺角的台子
  for (let cx = -1; cx <= 0; cx++) {
    for (let cz = -1; cz <= 0; cz++) end.forceChunk(cx, cz);
  }
  // 落点下面铺一小块黑曜石平台。MC 也铺 —— 不铺的话第一次进末地
  // 有相当概率直接掉进虚空，而那看起来像传送坏了
  const obsidian = packState(core.registry.idOf(Blocks.OBSIDIAN));
  const y = Math.min(WORLD_HEIGHT - 4, END_ARRIVAL.y);
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      end.setBlock(dx, y - 1, dz, obsidian);
      for (let h = 0; h < 3; h++) end.setBlock(dx, y + h, dz, 0);
    }
  }
  placeInDimension(core, player, Dimension.END, {
    x: Math.floor(END_ARRIVAL.x), y, z: Math.floor(END_ARRIVAL.z), axis: 'x',
  });
  // 人到了才摆龙和水晶。提前摆的话，一个从没去过末地的世界
  // 也会有一条龙在那里绕圈，白烧 CPU 且把区块一直钉在内存里
  beginDragonFight(core);
  return true;
}

/** 从末地回主世界的出生点 */
export function goToOverworldSpawn(core: ServerCore, player: ServerPlayer): void {
  placeInDimension(core, player, Dimension.OVERWORLD, {
    x: Math.floor(core.spawnX), y: Math.floor(core.spawnY), z: Math.floor(core.spawnZ), axis: 'x',
  });
}
