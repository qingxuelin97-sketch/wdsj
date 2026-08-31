/**
 * 附魔台的交互：开界面、报价、下单。
 *
 * 算法在 core/craft/enchanting.ts（纯的），这里只做三件事：
 * 数书架、把报价发给客户端、玩家点下去时扣级并把附魔写到物品上。
 *
 * ## 附魔写在哪
 *
 * 写在物品的 `enchantments` 数组里。**不复用 damage** —— damage 是
 * 耐久，一把附了魔的剑砍两下就会把附魔"砍掉"。药水那边能复用是因为
 * 药水没有耐久。
 */
import type { ServerCore } from '../server-core.ts';
import type { ServerPlayer } from './server-player.ts';
import type { ServerWorld } from '../world/server-world.ts';
import { EnchantingEntity } from '../world/block-entity-craft.ts';
import {
  enchantmentCosts, rollEnchantments, MAX_BOOKSHELVES,
} from '../../core/craft/enchanting.ts';
import { EnchantTarget, type EnchantTargetKind } from '../../core/item/enchantment.ts';
import { mulberry32 } from '../../core/rng/mulberry.ts';
import { isEmpty } from '../../core/item/item-def.ts';
import { stateId } from '../../core/world/chunk.ts';
import { S_EnchantOffers } from '../../core/net/packets.ts';
import { syncInventory } from './inventory-actions.ts';
import { sendVitals } from '../entity/combat.ts';

/**
 * 数附魔台周围的书架。
 *
 * MC 的规则很具体：以台子为中心的 5×5×3 范围里，**只有满足
 * "台子与书架之间那一格是空气"的书架才算数**。这条规则的后果是
 * 玩家必须留出一圈过道 —— 而"附魔室长什么样"这个视觉印象，
 * 完全是这条规则塑造的。漏掉它的话，把台子埋进一堆书架里就能满级。
 */
export function countBookshelves(world: ServerWorld, x: number, y: number, z: number): number {
  const bookshelf = BOOKSHELF_ID;
  let n = 0;
  for (let dy = 0; dy <= 1; dy++) {
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        // 只看外圈那一环（曼哈顿意义上距离 2 的那些）
        if (Math.abs(dx) !== 2 && Math.abs(dz) !== 2) continue;
        if (stateId(world.getBlock(x + dx, y + dy, z + dz)) !== bookshelf) continue;
        // 台子与书架之间那一格必须是空气
        const mx = x + Math.sign(dx);
        const mz = z + Math.sign(dz);
        if (stateId(world.getBlock(mx, y + dy, mz)) !== 0) continue;
        n++;
        if (n >= MAX_BOOKSHELVES) return MAX_BOOKSHELVES;
      }
    }
  }
  return n;
}

/** 书架的方块 id。用常量兜底，注册表里查不到时不至于把整台附魔台弄坏 */
const BOOKSHELF_ID = 47;

/**
 * 台子上放的东西变了：重新报价。
 *
 * 种子取"世界年龄 + 台子坐标"而不是 Math.random：同一个存档里
 * 同一台附魔台在同一刻放上同一件装备，报价必须一样 ——
 * 否则玩家反复拿起放下就能刷报价。
 */
export function refreshOffers(
  core: ServerCore, world: ServerWorld, entity: EnchantingEntity,
): void {
  const item = entity.slots[0]!;
  if (isEmpty(item) || targetOf(core, item.id) === null) {
    entity.clearOffers();
    return;
  }
  entity.bookshelves = countBookshelves(world, entity.x, entity.y, entity.z);
  entity.seed = (world.worldAge * 31 + entity.x * 7919 + entity.z * 104729) >>> 0;
  const rand = mulberry32(entity.seed);
  entity.offers = enchantmentCosts(rand, entity.bookshelves);
}

/** 把报价发给正在看这台附魔台的玩家 */
export function sendOffers(player: ServerPlayer, entity: EnchantingEntity): void {
  player.channel.send(S_EnchantOffers, {
    windowId: player.windowId,
    a: Math.min(255, entity.offers[0]),
    b: Math.min(255, entity.offers[1]),
    c: Math.min(255, entity.offers[2]),
  });
}

/**
 * 玩家点了第 slot 个报价。
 *
 * 失败时**什么都不做**（不扣级、不改物品）—— 半成功是最糟的结果：
 * 玩家会看到等级掉了而装备没变，而那看起来像被服务端吞了经验。
 */
export function selectEnchantment(
  core: ServerCore, player: ServerPlayer, slot: number,
): boolean {
  const entity = player.openBlockEntity;
  if (!(entity instanceof EnchantingEntity)) return false;
  if (slot < 0 || slot > 2) return false;
  const cost = entity.offers[slot] ?? 0;
  if (cost <= 0) return false;
  // 等级不够就什么都不做。spendLevels 自己也会判，但提前挡住
  // 是为了不在后面抽了半天才失败
  if (player.xp.level < cost) return false;
  const item = entity.slots[0]!;
  if (isEmpty(item)) return false;
  const target = targetOf(core, item.id);
  if (target === null) return false;
  if (item.enchantments !== undefined && item.enchantments.length > 0) return false;

  // 抽取用**另一个**种子：报价那一步已经把 entity.seed 消耗过一轮，
  // 复用的话三个槽会抽出高度相关的结果
  const rand = mulberry32((entity.seed ^ (0x9e3779b9 * (slot + 1))) >>> 0);
  const rolled = rollEnchantments(rand, cost, target, enchantabilityOf(core, item.id));
  if (rolled.length === 0) return false;

  if (!player.xp.spendLevels(cost)) return false;
  item.enchantments = rolled.map((e) => ({ id: e.id, level: e.level }));
  entity.clearOffers();
  // 附魔写在**方块实体**上，而窗口里是打开那一刻抄下来的一份副本。
  // 不刷新的话，发给客户端的还是那份没附魔的副本（紫光不出现），
  // 而且同时开着这台附魔台的其他玩家也看不到。
  // markBlockEntityDirty 会给每个正看着它的人重抄一遍并重发
  core.markBlockEntityDirty(entity);
  syncInventory(core, player);
  // 等级刚被扣掉，得把新的发过去。不发的话 HUD 上还是旧数字，
  // 而附魔台会照着旧等级把下一轮报价画成"买得起"——
  // 玩家点下去才发现不够，看着像服务端赖账
  sendVitals(player);
  sendOffers(player, entity);
  return true;
}

/**
 * 一件物品算哪一类装备。返回 null 表示附不了魔。
 *
 * 按物品定义里的 tool / armorSlot 判，不按名字前缀 —— 名字判法
 * 在"金锄"这类词上会失手，而失手的表现是"这件装备放上去没有报价"，
 * 玩家只会以为附魔台坏了。
 */
export function targetOf(core: ServerCore, itemId: number): EnchantTargetKind | null {
  const def = core.items.get(itemId);
  if (def === undefined) return null;
  if (def.name === 'bow') return EnchantTarget.BOW;
  // 注意是 !== null 不是 !== undefined：defineItem 用 `?? null` 归一化过，
  // 判 undefined 的话每一件物品都会被当成盔甲（剑也会返回 'armor'）
  if (def.armorSlot !== null) {
    if (def.armorSlot === 0) return EnchantTarget.ARMOR_HEAD;
    if (def.armorSlot === 3) return EnchantTarget.ARMOR_FEET;
    return EnchantTarget.ARMOR;
  }
  if (def.toolKind === null) return null;
  // 剑单独一类，其余工具都是 DIGGER
  return def.name.endsWith('_sword') ? EnchantTarget.SWORD : EnchantTarget.DIGGER;
}

/**
 * 物品材质的附魔性。
 *
 * **工具和盔甲是两套数，不能共用一张表。** 1.0 里它们分别写在
 * `EnumToolMaterial` 与 `EnumArmorMaterial` 两个枚举的最后一个字段上：
 *
 *   工具：木 15 / 石 5 / 铁 14 / 金 22 / 钻石 10
 *   盔甲：皮革 15 / 锁链 12 / 铁 9 / 金 25 / 钻石 10
 *
 * 有两处对不上，原来这里两处都套了工具的数：
 *
 *   - **铁甲是 9，不是 14。** 套成 14 的话铁甲比原版好附一大截，
 *     "铁甲将就着用、要附魔得攒钻石"这个前中期的动力就没了
 *   - **金甲是 25，不是 22。** 25 是全表最高 —— "金装很脆但附魔起来最好"
 *     这个著名的反直觉设定，在金**甲**身上恰恰是最极端的一处，
 *     套成工具的 22 就把它抹平了
 *
 * 木和石只有工具、锁链只有盔甲，各自那一档没有歧义。钻石两边都是 10。
 *
 * 按 `armorSlot` 判而不是看名字里有没有 helmet / chestplate：与 targetOf 用的是
 * 同一个字段，两处保持一致；名字判法在这个文件里已经失手过一次（见 targetOf）。
 *
 * 兜底的 1 主要是给弓的（1.0 的 `ItemBow.getItemEnchantability` 返回 1）。
 */
export function enchantabilityOf(core: ServerCore, itemId: number): number {
  const def = core.items.get(itemId);
  const name = def?.name ?? '';
  // 注意是 !== null 不是 !== undefined，理由同 targetOf
  const armor = def !== undefined && def.armorSlot !== null;
  if (name.startsWith('golden_')) return armor ? 25 : 22;
  if (name.startsWith('wooden_')) return 15;
  if (name.startsWith('leather_')) return 15;
  if (name.startsWith('stone_')) return 5;
  if (name.startsWith('chainmail_')) return 12;
  if (name.startsWith('iron_')) return armor ? 9 : 14;
  if (name.startsWith('diamond_')) return 10;
  return 1;
}
