/**
 * 药水的两个出口：往玻璃瓶里灌水、把药水喝下去。
 *
 * 酿造整套（配方表、酿造台、400 刻的进度）在 M15 就做完了，唯独**没有出口** ——
 * 玻璃瓶灌不了水，酿出来的药水也喝不下去。于是玩家能酿出一瓶迅捷药水，
 * 然后除了看着它没有任何用处。这个文件补的就是那两步。
 *
 * 和吃东西一样挂在"右键方块"上（block-interaction.ts 的 onUseBlock）：
 * 客户端只在准星指着某个方块时才发 C_UseBlock，所以对着天空喝药是喝不成的。
 * 这一条和吃面包的限制完全一样，要改得先给协议加一个"没瞄准任何东西的右键"，
 * 那是客户端与协议的活，不在这里做。
 */
import type { ServerCore } from '../server-core.ts';
import type { ServerPlayer } from './server-player.ts';
import { Items } from '../../content/items.ts';
import { WATER_BOTTLE } from '../../core/craft/brewing.ts';
import { makeStack } from '../../core/item/item-def.ts';
import { stateId } from '../../core/world/chunk.ts';
import { applyPotion } from './player-effects.ts';
import { giveToPlayer, syncInventory } from './inventory-actions.ts';
import { tossFromPlayer } from '../entity/item-manager.ts';

/**
 * 手上这一堆里用掉一个，换成别的东西。
 *
 * 一堆玻璃瓶（可以叠 64）里灌一瓶水，换出来的那瓶水**不能**直接盖在手上 ——
 * 那会把剩下 63 个瓶子一起变没。所以只有最后一个才就地替换，
 * 否则先减一个、再把新东西塞进背包（塞不下就丢在脚边，与拾取同一套规则）。
 */
function swapOneHeld(core: ServerCore, player: ServerPlayer, id: number, damage: number): void {
  const held = player.inventory.held;
  if (held.count <= 1) {
    held.id = id;
    held.count = 1;
    held.damage = damage;
    delete held.enchantments;
  } else {
    held.count--;
    const leftover = giveToPlayer(core, player, makeStack(id, 1, damage));
    if (leftover > 0) tossFromPlayer(core, player, makeStack(id, leftover, damage));
  }
  syncInventory(core, player);
}

/**
 * 右键水：手上的玻璃瓶变成一瓶水。
 *
 * 水**不消耗**，所以流动的水也认（MC 也是这样）。这一点和空桶正相反 ——
 * 桶要求是水源，因为舀走一格水会真的改变世界；灌瓶子不会，
 * 卡着"必须是水源"只会让人在河边点半天点不着。
 *
 * @returns 是否处理掉了这次右键
 */
function tryFillBottle(
  core: ServerCore, player: ServerPlayer, bx: number, by: number, bz: number,
): boolean {
  const held = player.inventory.held;
  if (held.id !== core.items.idOf(Items.GLASS_BOTTLE)) return false;
  const world = core.worldOf(player.dimension);
  const id = stateId(world.getBlock(bx, by, bz));
  // 点的不是水：这次右键照样算"用过了"。玻璃瓶不是方块，
  // 放行下去只会走到放置逻辑里静默地什么都不做
  if ((world.tables.isWater[id] ?? 0) === 0) return true;
  // 水瓶就是 damage 为 0 的药水 —— 整条酿造链的第一环
  swapOneHeld(core, player, core.items.idOf(Items.POTION), WATER_BOTTLE);
  return true;
}

/**
 * 右键喝药水：加效果，瓶子变回玻璃瓶。
 *
 * 1.0 的喝药是**瞬间**的：没有 1.4 才加的"举着喝 32 刻"动画，
 * 所以这里不需要任何进度状态，右键那一刻就结束了。
 *
 * 水瓶与粗制的药水也喝得下去（applyPotion 返回 false），
 * 换回一个玻璃瓶但什么效果也没有 —— 和 MC 一致。挡住不让喝的话，
 * 玩家会以为是自己点错了地方。
 *
 * @returns 是否处理掉了这次右键
 */
function tryDrinkPotion(core: ServerCore, player: ServerPlayer): boolean {
  const held = player.inventory.held;
  if (held.id !== core.items.idOf(Items.POTION)) return false;
  // 死人不喝药。等重生的那几刻里客户端还能发包，
  // 喝下去的治疗会把血加回去却仍然停在死亡界面上
  if (player.vitals.dead) return true;

  applyPotion(player, held.damage, core.vitalsCtx);
  swapOneHeld(core, player, core.items.idOf(Items.GLASS_BOTTLE), 0);
  // 血条推一次。治疗与伤害那两条路各自已经推过（applyPotion / damagePlayer），
  // 这里管的是**别的**药水：喝下去血量没变，但客户端得知道这一口喝掉了
  core.vitalsCtx.sync(player);
  return true;
}

/**
 * 右键时先问一遍药水这边：这一下是不是"喝药"或"灌水"。
 *
 * 由 block-interaction.ts 的 onUseBlock 在吃东西之后、放方块之前调用。
 * 喝在灌水**前面**：对着水面喝一瓶治疗药水时两条规则都想接管这次右键，
 * 先判喝才不会把手上那瓶药当成"要灌水的空瓶"。
 *
 * @returns 是否处理掉了这次右键
 */
export function usePotionItem(
  core: ServerCore, player: ServerPlayer, bx: number, by: number, bz: number,
): boolean {
  return tryDrinkPotion(core, player) || tryFillBottle(core, player, bx, by, bz);
}
