/**
 * 物品栏相关的服务端动作。
 *
 * 从 server-core 里分出来的（那个文件顶到了 600 行硬上限），
 * 分界线是"和物品栏打交道的一组操作"：掉落归属、塞进背包、
 * 窗口开关与点击、同步给客户端。
 *
 * 写成自由函数而不是类方法，是因为它们只是 ServerCore 状态上的一组变换 ——
 * 拆出来之后依赖关系反而更清楚：每个函数需要什么，签名上写着。
 */
import type { ServerCore } from '../server-core.ts';
import type { ServerPlayer } from './server-player.ts';
import { canHarvest, type HeldTool } from '../../core/block/breaking.ts';
import { isEmpty, cloneStack, makeStack, type ItemStack } from '../../core/item/item-def.ts';
import { Window, ARMOR_SLOTS, MAIN_SLOTS, HOTBAR_SLOTS } from './player-inventory.ts';
import { S_WindowItems, S_OpenWindow, WindowKind } from '../../core/net/packets.ts';

/** [start, start+count) 的下标序列 */
function range(start: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => start + i);
}

const WINDOW_TITLES: Record<number, string> = {
  [WindowKind.INVENTORY]: 'Inventory',
  [WindowKind.CRAFTING]: 'Crafting',
  [WindowKind.FURNACE]: 'Furnace',
  [WindowKind.CHEST]: 'Chest',
};

/** 少数几个"掉的不是自己"的方块 */
const DROP_OVERRIDE: Record<number, number> = {
  1: 4,    // 石头 -> 圆石
  2: 3,    // 草方块 -> 泥土
  16: 263, // 煤矿 -> 煤
  21: 351, // 青金石矿 -> 青金石（染料）
  56: 264, // 钻石矿 -> 钻石
  73: 331, // 红石矿 -> 红石
  110: 3,  // 菌丝 -> 泥土
};

/**
 * 破坏某个方块掉什么。
 *
 * 收不到（工具不对口）就什么都不掉 —— 徒手挖石头一无所获，
 * 这条规则是 MC 前期"必须先做镐"的全部动力来源。
 */
export function dropOf(core: ServerCore, blockId: number, player: ServerPlayer): ItemStack | null {
  const held = player.inventory.held;
  const tool = toolOf(core, held);
  if (!canHarvest(core.world.tables, blockId, tool)) return null;
  const def = core.world.tables.defs[blockId];
  if (def == null) return null;
  // 石头掉圆石、草方块掉泥土 —— 少数几个"掉的不是自己"的方块
  const alt = DROP_OVERRIDE[blockId];
  return makeStack(alt ?? blockId, 1);
}

/** 手上那件物品当工具用时的参数。空手或非工具返回 null */
export function toolOf(core: ServerCore, stack: ItemStack): HeldTool | null {
  if (isEmpty(stack)) return null;
  const def = core.items.get(stack.id);
  if (def === undefined || def.toolKind === null) return null;
  return { kind: def.toolKind, tier: def.toolTier, speed: def.toolSpeed };
}

/** 塞进背包，返回塞不下的数量 */
export function giveToPlayer(core: ServerCore, player: ServerPlayer, stack: ItemStack): number {
  const inv = player.inventory;
  const max = maxStackOf(core, stack.id);
  const work = cloneStack(stack);
  // 先补快捷栏里的同类，再补主存放，最后找空格 —— 与 MC 的拾取顺序一致
  const order = [
    ...range(ARMOR_SLOTS + MAIN_SLOTS, HOTBAR_SLOTS),
    ...range(ARMOR_SLOTS, MAIN_SLOTS),
  ];
  for (const i of order) {
    if (work.count <= 0) break;
    const dst = inv.slots[i]!;
    if (isEmpty(dst) || dst.id !== work.id || dst.damage !== work.damage) continue;
    const room = max - dst.count;
    if (room <= 0) continue;
    const move = Math.min(room, work.count);
    dst.count += move;
    work.count -= move;
  }
  for (const i of order) {
    if (work.count <= 0) break;
    const dst = inv.slots[i]!;
    if (!isEmpty(dst)) continue;
    const move = Math.min(max, work.count);
    dst.id = work.id;
    dst.damage = work.damage;
    dst.count = move;
    work.count -= move;
  }
  return work.count;
}

export function maxStackOf(core: ServerCore, id: number): number {
  return core.items.get(id)?.maxStack ?? 64;
}

/** 把玩家物品栏（或当前窗口）同步给客户端 */
export function syncInventory(core: ServerCore, player: ServerPlayer): void {
  const stacks = player.openWindow !== null
    ? player.openWindow.snapshot()
    : [...player.inventory.slots.map(cloneStack), cloneStack(player.inventory.cursor)];
  const buf = new Int32Array(stacks.length * 3);
  for (let i = 0; i < stacks.length; i++) {
    buf[i * 3] = stacks[i]!.id;
    buf[i * 3 + 1] = stacks[i]!.count;
    buf[i * 3 + 2] = stacks[i]!.damage;
  }
  player.channel.send(S_WindowItems, {
    windowId: player.openWindow === null ? 0 : player.windowId,
    slots: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
  });
}

export function onWindowClick(core: ServerCore, player: ServerPlayer, value: Record<string, unknown>): void {
  const windowId = value['windowId'] as number;
  const slot = value['slot'] as number;
  const button = ((value['button'] as number) === 1 ? 1 : 0) as 0 | 1;
  const shift = value['shift'] as boolean;

  if (player.openWindow === null) {
    // 没开窗口时也允许点：那是背包窗口的隐式形态（快捷栏拖动）
    showWindow(core, player, WindowKind.INVENTORY);
  }
  if (windowId !== player.windowId) return; // 过期的点击，直接丢
  player.openWindow!.click(slot, button, shift);
  syncInventory(core, player);
}

/** 打开一个窗口 */
export function showWindow(core: ServerCore, player: ServerPlayer, kind: WindowKind, external: ItemStack[] | null = null): void {
  closeWindow(core, player);
  player.windowId = (player.windowId % 100) + 1;
  player.openWindow = new Window(
    kind, player.inventory, core.crafting.recipes,
    (id) => maxStackOf(core, id), external,
  );
  player.channel.send(S_OpenWindow, {
    windowId: player.windowId, kind, title: WINDOW_TITLES[kind] ?? '',
  });
  syncInventory(core, player);
}

/** 关掉当前窗口，合成格里的东西还给玩家 */
export function closeWindow(core: ServerCore, player: ServerPlayer): void {
  if (player.openWindow === null) return;
  const dropped = player.openWindow.close();
  player.openWindow = null;
  for (const d of dropped) {
    // 背包也满了，只能丢掉。M9 接上掉落物实体之后改成掉在地上
    void d;
  }
  syncInventory(core, player);
}
