/**
 * 掉落物的生成、tick 与同步。
 *
 * 同步策略：**玩家认识一个掉落物，当且仅当它所在的区块被这个玩家订阅了。**
 *
 * 这条规则一句话讲完，但省掉了一整类 bug：不需要在"区块推送完成"的时候
 * 补发实体、不需要在实体跨区块时判断谁该收到出生包谁该收到销毁包 ——
 * 每 tick 按订阅集重算一次差集，多出来的发出生、少掉的发销毁。
 * 代价是每 tick 一次 O(玩家数 × 掉落物数) 的遍历，几百个实体时可以忽略。
 */
import type { ServerCore } from '../server-core.ts';
import type { ServerPlayer } from '../player/server-player.ts';
import { ItemEntity } from './item-entity.ts';
import {
  S_SpawnItems, S_EntityMoves, S_DestroyEntities,
  ENTITY_POS_SCALE, SPAWN_ITEM_STRIDE, ENTITY_MOVE_STRIDE,
} from '../../core/net/packets.ts';
import { makeStack, XP_ORB_ITEM_ID, type ItemStack } from '../../core/item/item-def.ts';
import { giveToPlayer, maxStackOf, syncInventory } from '../player/inventory-actions.ts';
import { splitIntoOrbs } from '../player/experience.ts';
import { sendVitals } from './combat.ts';

/** 一个世界里最多同时存在多少掉落物。超了就不再生成新的 */
const MAX_ITEMS = 2000;
/** 合并时两个掉落物要有多近 */
const MERGE_RANGE = 0.5;

/**
 * 在某处生成一个掉落物。
 *
 * @param scatter 是否给一个随机的初速度。挖方块掉出来的会"蹦"一下（true），
 *                从背包里丢出来的由调用方自己给朝向（false）。
 */
export function spawnItem(
  core: ServerCore,
  x: number, y: number, z: number,
  stack: ItemStack,
  scatter = true,
): ItemEntity | null {
  if (stack.count <= 0 || stack.id === 0) return null;
  if (core.world.items.size >= MAX_ITEMS) return null;
  const entity = new ItemEntity(core.world.allocEntityId(), x, y, z, stack);
  if (scatter) {
    const rng = core.world.random;
    entity.scatter(rng.nextFloat() - 0.5, rng.nextFloat(), rng.nextFloat() - 0.5);
  }
  core.world.items.set(entity.entityId, entity);
  return entity;
}

/**
 * 撒一把经验球。
 *
 * 按面额从大到小拆，100 点不会变成 100 个球 —— 数量直接决定服务端
 * 要 tick 多少实体。
 */
export function spawnXpOrbs(core: ServerCore, x: number, y: number, z: number, amount: number): void {
  for (const value of splitIntoOrbs(amount)) {
    // count 存的是这颗球值多少经验，最多 255（面额最大 2477 会被截断，
    // 但那只在末影龙那种量级才出现，M16 再说）
    spawnItem(core, x, y, z, makeStack(XP_ORB_ITEM_ID, Math.min(255, value)));
  }
}

/** 破坏一个方块时，掉落物出现在方块中心附近 */
export function spawnBlockDrop(core: ServerCore, x: number, y: number, z: number, stack: ItemStack): void {
  const rng = core.world.random;
  spawnItem(
    core,
    x + 0.25 + rng.nextFloat() * 0.5,
    y + 0.25 + rng.nextFloat() * 0.5,
    z + 0.25 + rng.nextFloat() * 0.5,
    stack,
  );
}

/** 玩家丢东西：从眼睛高度朝着看的方向扔出去 */
export function tossFromPlayer(core: ServerCore, player: ServerPlayer, stack: ItemStack): void {
  const entity = spawnItem(core, player.x, player.y + 1.3, player.z, stack, false);
  if (entity === null) return;
  // MC 的 dropPlayerItem：水平 0.3，向上 0.1，再叠一点随机
  const yaw = player.yaw;
  const pitch = player.pitch;
  entity.vx = -Math.sin(yaw) * Math.cos(pitch) * 0.3;
  entity.vz = Math.cos(yaw) * Math.cos(pitch) * 0.3;
  entity.vy = -Math.sin(pitch) * 0.3 + 0.1;
  // 丢出去的东西要过 40 刻才能捡回来，比默认的 10 长 —— 否则往前走两步就捡回来了
  entity.pickupDelay = 40;
}

/**
 * 推进所有掉落物一刻：物理、合并、拾取、过期。
 *
 * 顺序有讲究：先物理再拾取。反过来的话，掉落物会在**上一刻**的位置上
 * 被判定拾取，玩家看到的是"走过去了才被吸走"。
 */
export function tickItems(core: ServerCore): void {
  const world = core.world;
  if (world.items.size === 0) return;
  const dead: number[] = [];

  for (const item of world.items.values()) {
    item.tick(world.store, world.tables);
    if (item.dead) dead.push(item.entityId);
  }

  mergeNearbyItems(core);

  // 拾取。玩家按 entityId 排序遍历，保证多人时"谁先捡到"是确定的
  const players = [...core.playersForTest()].sort((a, b) => a.entityId - b.entityId);
  for (const item of world.items.values()) {
    if (item.dead) continue;
    for (const player of players) {
      if (player.vitals.dead) continue;
      if (!item.canBePickedUpBy(player.x, player.y, player.z)) continue;

      // 经验球：加经验，不进背包
      if (item.stack.id === XP_ORB_ITEM_ID) {
        player.xp.add(item.stack.count);
        sendVitals(player);
        item.dead = true;
        dead.push(item.entityId);
        break;
      }

      const left = giveToPlayer(core, player, item.stack);
      if (left === item.stack.count) continue; // 背包满了，一个都没进去
      syncInventory(core, player);
      if (left <= 0) {
        item.dead = true;
        dead.push(item.entityId);
      } else {
        item.stack.count = left;
      }
      break;
    }
  }

  for (const id of dead) world.items.delete(id);
}

/**
 * 把挨得很近的同类掉落物并成一堆。
 *
 * 不并的话，砍一棵树留下的五六个木头会各自占一个实体，
 * 而挖矿几分钟后世界里能有上千个实体 —— 每个都要 tick、要同步。
 */
function mergeNearbyItems(core: ServerCore): void {
  const items = [...core.world.items.values()];
  for (const a of items) {
    if (a.dead || !a.shouldTryMerge()) continue;
    const max = maxStackOf(core, a.stack.id);
    for (const b of items) {
      if (b === a || b.dead) continue;
      if (b.stack.id !== a.stack.id || b.stack.damage !== a.stack.damage) continue;
      // 经验球不合并：它的 count 是"值多少经验"而不是"几个"，
      // 合并会让 3+3 变成一颗值 6 的球，看起来像凭空少了一颗
      if (a.stack.id === XP_ORB_ITEM_ID) continue;
      if (a.stack.count + b.stack.count > max) continue;
      if (Math.abs(a.x - b.x) > MERGE_RANGE) continue;
      if (Math.abs(a.y - b.y) > MERGE_RANGE) continue;
      if (Math.abs(a.z - b.z) > MERGE_RANGE) continue;
      a.stack.count += b.stack.count;
      // 合并后拾取延迟取两者中较大的，免得"刚丢出去的"被"地上旧的"带得能立刻捡
      a.pickupDelay = Math.max(a.pickupDelay, b.pickupDelay);
      b.dead = true;
    }
  }
  for (const item of items) {
    if (item.dead) core.world.items.delete(item.entityId);
  }
}

/** 把这一刻的实体增删改同步给每个玩家 */
export function broadcastItems(core: ServerCore, destroyedElsewhere: readonly number[]): void {
  const world = core.world;
  for (const player of core.playersForTest()) {
    const spawns: ItemEntity[] = [];
    const moves: ItemEntity[] = [];
    const seen = new Set<number>();

    for (const item of world.items.values()) {
      if (!player.isSubscribed(Math.floor(item.x) >> 4, Math.floor(item.z) >> 4)) continue;
      seen.add(item.entityId);
      if (player.knownItems.has(item.entityId)) {
        // 位置没变就不发。掉落物落地之后就一动不动，而它们是会堆积的 ——
        // 每 tick 无条件发一遍等于给静止的物品交带宽税
        if (item.vx !== 0 || item.vy !== 0 || item.vz !== 0) moves.push(item);
      } else {
        spawns.push(item);
        player.knownItems.add(item.entityId);
      }
    }

    const destroys: number[] = [];
    for (const id of player.knownItems) {
      if (!seen.has(id)) destroys.push(id);
    }
    for (const id of destroyedElsewhere) {
      if (player.knownItems.has(id) && !destroys.includes(id)) destroys.push(id);
    }
    for (const id of destroys) player.knownItems.delete(id);

    if (spawns.length > 0) {
      const buf = new DataView(new ArrayBuffer(spawns.length * SPAWN_ITEM_STRIDE));
      spawns.forEach((e, i) => {
        const o = i * SPAWN_ITEM_STRIDE;
        buf.setUint32(o, e.entityId, true);
        buf.setInt32(o + 4, Math.round(e.x * ENTITY_POS_SCALE), true);
        buf.setInt32(o + 8, Math.round(e.y * ENTITY_POS_SCALE), true);
        buf.setInt32(o + 12, Math.round(e.z * ENTITY_POS_SCALE), true);
        buf.setUint16(o + 16, e.stack.id, true);
        buf.setUint8(o + 18, Math.min(255, e.stack.count));
        buf.setUint8(o + 19, Math.min(255, e.stack.damage));
      });
      player.channel.send(S_SpawnItems, { entries: new Uint8Array(buf.buffer) });
    }
    if (moves.length > 0) {
      const buf = new DataView(new ArrayBuffer(moves.length * ENTITY_MOVE_STRIDE));
      moves.forEach((e, i) => {
        const o = i * ENTITY_MOVE_STRIDE;
        buf.setUint32(o, e.entityId, true);
        buf.setInt32(o + 4, Math.round(e.x * ENTITY_POS_SCALE), true);
        buf.setInt32(o + 8, Math.round(e.y * ENTITY_POS_SCALE), true);
        buf.setInt32(o + 12, Math.round(e.z * ENTITY_POS_SCALE), true);
      });
      player.channel.send(S_EntityMoves, { entries: new Uint8Array(buf.buffer) });
    }
    if (destroys.length > 0) {
      const buf = new DataView(new ArrayBuffer(destroys.length * 4));
      destroys.forEach((id, i) => buf.setUint32(i * 4, id, true));
      player.channel.send(S_DestroyEntities, { entries: new Uint8Array(buf.buffer) });
    }
  }
}

/** 方块实体被拆掉时，把里面的东西撒在原地 */
export function scatterContents(core: ServerCore, x: number, y: number, z: number, contents: readonly ItemStack[]): void {
  for (const s of contents) {
    spawnBlockDrop(core, x, y, z, makeStack(s.id, s.count, s.damage));
  }
}
