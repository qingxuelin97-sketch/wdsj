/**
 * 玩家对方块的三种交互：开始/推进挖掘、放置、右键使用。
 *
 * 从 server-core.ts 里分出来的（那个文件到了 604 行、越过 600 硬上限）。
 * 分界线是"玩家瞄准某个方块之后会发生的事"：触及检查、挖掘进度、
 * 掉落、放置合法性、开容器。
 *
 * 写成自由函数、第一个参数是 ServerCore，与 player/inventory-actions.ts
 * 和 world/world-persistence.ts 同一套做法。
 */
import type { ServerCore } from '../server-core.ts';
import type { ServerPlayer } from './server-player.ts';
import { PlayerActionKind, WindowKind } from '../../core/net/packets.ts';
import { AIR_STATE, packState, stateId } from '../../core/world/chunk.ts';
import { breakProgressPerTick } from '../../core/block/breaking.ts';
import { isEmpty, ITEM_ID_BASE } from '../../core/item/item-def.ts';
import { dropOf, toolOf, showWindow, syncInventory } from './inventory-actions.ts';
import { spawnBlockDrop, scatterContents } from '../entity/item-manager.ts';
import { ChestEntity, FurnaceEntity } from '../world/block-entity.ts';
import { EYE_HEIGHT, PLAYER_WIDTH, PLAYER_HEIGHT, WORLD_HEIGHT, REACH_SURVIVAL } from '../../core/constants.ts';

/**
 * 触及距离的判定上限（平方）。
 *
 * 比 4.5 格的标称值放宽一些：客户端是按自己**预测**的位置发包的，
 * 而服务端手里是稍旧的位置，卡在边界上时两边会差出零点几格。
 * 卡得太死的话，正常游玩时会偶发"点了没反应"。
 */
const REACH_LIMIT_SQ = (REACH_SURVIVAL + 1.5) ** 2;

/** face 编号到法线。与 core/block/types.ts 的 Facing 一致 */
const FACE_NORMALS: readonly (readonly [number, number, number])[] = [
  [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0],
];

/** 右键这些方块是"打开界面"而不是"放方块" */
const OPENS_WINDOW: Record<number, WindowKind> = {
  58: WindowKind.CRAFTING,
  54: WindowKind.CHEST,
  61: WindowKind.FURNACE,
  62: WindowKind.FURNACE,
};

export function onPlayerAction(core: ServerCore, player: ServerPlayer, value: Record<string, unknown>): void {
  const action = value['action'] as number;
  const x = value['x'] as number;
  const y = value['y'] as number;
  const z = value['z'] as number;

  if (action === PlayerActionKind.START_DIG) {
    const state = core.world.getBlock(x, y, z);
    if (!core.world.isBreakable(state)) return;
    // 触及距离多给一点余量：客户端是按自己预测的位置发的，
    // 卡得正好在 4.5 格上时不该被判成作弊
    if (core.reachSq(player, x, y, z) > REACH_LIMIT_SQ) return;
    player.digging = true;
    player.digX = x;
    player.digY = y;
    player.digZ = z;
    player.digProgress = 0;
    // 硬度为 0 的（火把、花）一下就断，不必等下一 tick
    advanceDigging(core, player);
    return;
  }

  if (action === PlayerActionKind.OPEN_INVENTORY) {
    showWindow(core, player, WindowKind.INVENTORY);
    return;
  }

  if (action === PlayerActionKind.CANCEL_DIG || action === PlayerActionKind.FINISH_DIG) {
    // FINISH_DIG 只当作"松手"。破坏与否由服务端自己的进度说了算 ——
    // 信客户端的话，改一行前端就能瞬间挖穿基岩。
    player.digging = false;
    player.digProgress = 0;
  }
}

/** 推进一个玩家的挖掘进度；够了就破坏 */
export function advanceDigging(core: ServerCore, player: ServerPlayer): void {
  if (!player.digging) return;
  const { digX: x, digY: y, digZ: z } = player;
  const state = core.world.getBlock(x, y, z);
  const id = stateId(state);
  if (id === 0 || !core.world.isBreakable(state)) {
    player.digging = false;
    return;
  }
  // 挖到一半人走开了就停下
  if (core.reachSq(player, x, y, z) > REACH_LIMIT_SQ) {
    player.digging = false;
    return;
  }

  player.digProgress += breakProgressPerTick(
    core.world.tables, id, toolOf(core, player.inventory.held),
  );
  if (player.digProgress < 1) return;

  player.digging = false;
  player.digProgress = 0;
  // 掉落物在方块变成空气**之前**先算出来：dropOf 要查这个方块的定义，
  // 而 setBlock 之后那里已经是空气了
  const drop = dropOf(core, id, player);
  core.world.setBlock(x, y, z, AIR_STATE);

  // 箱子/熔炉被拆掉时，里面的东西撒一地。setBlock 会把方块实体摘下来
  // 放进 brokenBlockEntities，这里取出来处理
  for (const broken of core.world.drainBrokenBlockEntities()) {
    scatterContents(core, broken.x, broken.y, broken.z, broken.contents());
  }

  if (drop !== null) spawnBlockDrop(core, x, y, z, drop);
}

export function onUseBlock(core: ServerCore, player: ServerPlayer, value: Record<string, unknown>): void {
  const x = value['x'] as number;
  const y = value['y'] as number;
  const z = value['z'] as number;
  const face = value['face'] as number;

  if (core.reachSq(player, x, y, z) > REACH_LIMIT_SQ) return;

  // face 是命中面的法线编号，新方块落在那一侧
  const [nx, ny, nz] = FACE_NORMALS[face] ?? [0, 0, 0];
  const px = x + nx;
  const py = y + ny;
  const pz = z + nz;
  if (py < 0 || py >= WORLD_HEIGHT) return;

  // 右键工作台/箱子/熔炉是"打开"，不是"放置"
  const targetId = stateId(core.world.getBlock(x, y, z));
  const opens = OPENS_WINDOW[targetId];
  if (opens !== undefined) {
    // 箱子与熔炉的内容在方块实体里。把它的 slots 数组**直接**交给窗口当
    // external —— 窗口是视图不是副本（见 player-inventory.ts 顶部），
    // 于是玩家的点击会就地改到方块实体上，不需要任何回写步骤
    const entity = core.world.blockEntities.get(x, y, z);
    const external = entity instanceof ChestEntity || entity instanceof FurnaceEntity
      ? entity.slots : null;
    showWindow(core, player, opens, external);
    player.openBlockEntity = entity;
    return;
  }

  // 手上得有东西，而且得是能放的方块
  const held = player.inventory.held;
  if (isEmpty(held)) return;
  const def = core.items.get(held.id);
  const blockId = def?.placesBlock !== undefined && def.placesBlock !== 0
    ? def.placesBlock
    : (held.id < ITEM_ID_BASE ? held.id : 0);
  if (blockId === 0 || core.world.tables.defs[blockId] == null) return;

  // 只能放进空气里
  if (stateId(core.world.getBlock(px, py, pz)) !== 0) return;

  // 不能把自己封在方块里：玩家碰撞盒与目标格重叠时拒绝。
  // 少了这一条，对着脚下点一下就会被卡进方块，然后被挤到旁边去。
  const half = PLAYER_WIDTH / 2;
  const overlapX = player.x + half > px && player.x - half < px + 1;
  const overlapZ = player.z + half > pz && player.z - half < pz + 1;
  const overlapY = player.y + PLAYER_HEIGHT > py && player.y < py + 1;
  if (overlapX && overlapY && overlapZ) return;

  if (!core.world.setBlock(px, py, pz, packState(blockId, held.damage & 15))) return;
  held.count--;
  if (held.count <= 0) {
    held.id = 0;
    held.damage = 0;
  }
  syncInventory(core, player);
}
