/**
 * MC 1.0 的物品表。
 *
 * id 全部照抄 1.0 的原值（256 起）。照抄不是形式主义：合成表、掉落、
 * 存档格式都按这套 id 写，自己重新编号的话，任何一份对照 MC 的资料
 * 都对不上，排查时就没有外部参照了。
 *
 * 版本边界见 docs/RUBRIC.md：最大物品 id 是 **382**（金色闪光西瓜）。
 * 383 是刷怪蛋，属于 1.1，出现在这里就是错的。
 */
import { defineItem, ArmorSlot, type ItemDef } from '../core/item/item-def.ts';
import { ToolKind, ToolTier } from '../core/block/types.ts';
import { TOOL_SPEED, TOOL_DURABILITY, SWORD_DAMAGE, ARMOR_POINTS } from '../core/constants.ts';
import { Blocks } from './blocks.ts';

/** 物品名字表。方块物品直接复用方块名 */
export const Items = {
  // --- 工具 ---
  IRON_SHOVEL: 'iron_shovel',
  IRON_PICKAXE: 'iron_pickaxe',
  IRON_AXE: 'iron_axe',
  FLINT_AND_STEEL: 'flint_and_steel',
  APPLE: 'apple',
  BOW: 'bow',
  ARROW: 'arrow',
  COAL: 'coal',
  CHARCOAL: 'charcoal',
  DIAMOND: 'diamond',
  IRON_INGOT: 'iron_ingot',
  GOLD_INGOT: 'gold_ingot',
  IRON_SWORD: 'iron_sword',
  WOODEN_SWORD: 'wooden_sword',
  WOODEN_SHOVEL: 'wooden_shovel',
  WOODEN_PICKAXE: 'wooden_pickaxe',
  WOODEN_AXE: 'wooden_axe',
  STONE_SWORD: 'stone_sword',
  STONE_SHOVEL: 'stone_shovel',
  STONE_PICKAXE: 'stone_pickaxe',
  STONE_AXE: 'stone_axe',
  DIAMOND_SWORD: 'diamond_sword',
  DIAMOND_SHOVEL: 'diamond_shovel',
  DIAMOND_PICKAXE: 'diamond_pickaxe',
  DIAMOND_AXE: 'diamond_axe',
  STICK: 'stick',
  BOWL: 'bowl',
  MUSHROOM_STEW: 'mushroom_stew',
  GOLDEN_SWORD: 'golden_sword',
  GOLDEN_SHOVEL: 'golden_shovel',
  GOLDEN_PICKAXE: 'golden_pickaxe',
  GOLDEN_AXE: 'golden_axe',
  STRING: 'string',
  FEATHER: 'feather',
  GUNPOWDER: 'gunpowder',
  WOODEN_HOE: 'wooden_hoe',
  STONE_HOE: 'stone_hoe',
  IRON_HOE: 'iron_hoe',
  DIAMOND_HOE: 'diamond_hoe',
  GOLDEN_HOE: 'golden_hoe',
  SEEDS: 'seeds',
  WHEAT: 'wheat',
  BREAD: 'bread',

  // --- 盔甲 ---
  LEATHER_HELMET: 'leather_helmet',
  LEATHER_CHESTPLATE: 'leather_chestplate',
  LEATHER_LEGGINGS: 'leather_leggings',
  LEATHER_BOOTS: 'leather_boots',
  IRON_HELMET: 'iron_helmet',
  IRON_CHESTPLATE: 'iron_chestplate',
  IRON_LEGGINGS: 'iron_leggings',
  IRON_BOOTS: 'iron_boots',
  DIAMOND_HELMET: 'diamond_helmet',
  DIAMOND_CHESTPLATE: 'diamond_chestplate',
  DIAMOND_LEGGINGS: 'diamond_leggings',
  DIAMOND_BOOTS: 'diamond_boots',
  GOLDEN_HELMET: 'golden_helmet',
  GOLDEN_CHESTPLATE: 'golden_chestplate',
  GOLDEN_LEGGINGS: 'golden_leggings',
  GOLDEN_BOOTS: 'golden_boots',

  // --- 材料与杂项 ---
  FLINT: 'flint',
  PORKCHOP: 'porkchop',
  COOKED_PORKCHOP: 'cooked_porkchop',
  PAINTING: 'painting',
  GOLDEN_APPLE: 'golden_apple',
  SIGN: 'sign',
  WOODEN_DOOR_ITEM: 'wooden_door_item',
  BUCKET: 'bucket',
  WATER_BUCKET: 'water_bucket',
  LAVA_BUCKET: 'lava_bucket',
  MINECART: 'minecart',
  SADDLE: 'saddle',
  IRON_DOOR_ITEM: 'iron_door_item',
  REDSTONE: 'redstone',
  SNOWBALL: 'snowball',
  BOAT: 'boat',
  LEATHER: 'leather',
  MILK_BUCKET: 'milk_bucket',
  BRICK: 'brick',
  CLAY_BALL: 'clay_ball',
  SUGAR_CANE: 'sugar_cane',
  PAPER: 'paper',
  BOOK: 'book',
  SLIMEBALL: 'slimeball',
  EGG: 'egg',
  COMPASS: 'compass',
  FISHING_ROD: 'fishing_rod',
  CLOCK: 'clock',
  GLOWSTONE_DUST: 'glowstone_dust',
  RAW_FISH: 'raw_fish',
  COOKED_FISH: 'cooked_fish',
  DYE: 'dye',
  BONE: 'bone',
  SUGAR: 'sugar',
  CAKE_ITEM: 'cake_item',
  BED_ITEM: 'bed_item',
  REPEATER: 'repeater',
  COOKIE: 'cookie',
  SHEARS: 'shears',
  MELON_SLICE: 'melon_slice',
  PUMPKIN_SEEDS: 'pumpkin_seeds',
  MELON_SEEDS: 'melon_seeds',
  RAW_BEEF: 'raw_beef',
  STEAK: 'steak',
  RAW_CHICKEN: 'raw_chicken',
  COOKED_CHICKEN: 'cooked_chicken',
  ROTTEN_FLESH: 'rotten_flesh',
  ENDER_PEARL: 'ender_pearl',
  BLAZE_ROD: 'blaze_rod',
  GHAST_TEAR: 'ghast_tear',
  GOLD_NUGGET: 'gold_nugget',
  NETHER_WART: 'nether_wart',
  POTION: 'potion',
  GLASS_BOTTLE: 'glass_bottle',
  SPIDER_EYE: 'spider_eye',
  FERMENTED_SPIDER_EYE: 'fermented_spider_eye',
  BLAZE_POWDER: 'blaze_powder',
  MAGMA_CREAM: 'magma_cream',
  BREWING_STAND_ITEM: 'brewing_stand_item',
  CAULDRON_ITEM: 'cauldron_item',
  EYE_OF_ENDER: 'eye_of_ender',
  GLISTERING_MELON: 'glistering_melon',
  BONE_MEAL: 'bone_meal',
} as const;

/**
 * 扩展 id：MC 把一部分物品变种塞进 damage 值里（木炭是"煤 damage=1"，
 * 骨粉是"染料 damage=15"，16 种染料共用 id 351）。
 *
 * 合成表按 id 匹配，让它去认 (id, damage) 二元组会把匹配逻辑复杂化，
 * 而收益只有这几个物品。所以内部给它们各自的 id，从 1000 起 ——
 * 1000 以上不会和 MC 的 0..382 撞车。存档与网络包在 M9 里做映射，
 * 到时候按 MC 的 id+damage 写出去，兼容性不受影响。见 docs/DEVIATIONS.md。
 */
export const EXT = {
  CHARCOAL: 1000,
  BONE_MEAL: 1001,
} as const;

/** 造一套五个材质的工具 */
function toolSet(
  base: number,
  prefix: string,
  tier: ToolTier,
  speed: number,
  durability: number,
  swordDamage: number,
): ItemDef[] {
  // MC 的 id 顺序是 铲/镐/斧/剑（剑单独排在别处），这里按传进来的 base 逐个排
  const mk = (id: number, name: string, kind: ToolKind, dmg: number): ItemDef =>
    defineItem({
      id, name, maxStack: 1, maxDurability: durability,
      toolKind: kind, toolTier: tier, toolSpeed: speed, attackDamage: dmg,
      texture: name,
    });
  return [
    mk(base, `${prefix}_shovel`, ToolKind.SHOVEL, Math.max(1, swordDamage - 3)),
    mk(base + 1, `${prefix}_pickaxe`, ToolKind.PICKAXE, Math.max(1, swordDamage - 2)),
    mk(base + 2, `${prefix}_axe`, ToolKind.AXE, Math.max(1, swordDamage - 1)),
  ];
}

/** 一套四件盔甲 */
function armorSet(base: number, prefix: string, points: readonly number[], durability: number): ItemDef[] {
  const slots: [ArmorSlot, string][] = [
    [ArmorSlot.HELMET, 'helmet'],
    [ArmorSlot.CHESTPLATE, 'chestplate'],
    [ArmorSlot.LEGGINGS, 'leggings'],
    [ArmorSlot.BOOTS, 'boots'],
  ];
  return slots.map(([slot, suffix], i) => defineItem({
    id: base + i,
    name: `${prefix}_${suffix}`,
    maxStack: 1,
    maxDurability: durability,
    armorSlot: slot,
    armorPoints: points[i] ?? 1,
    texture: `${prefix}_${suffix}`,
  }));
}

/** 一件食物 */
function food(id: number, name: string, points: number, saturation: number, maxStack = 64): ItemDef {
  return defineItem({ id, name, foodPoints: points, saturation, maxStack, texture: name });
}

/**
 * 建立物品表。返回按 id 索引的稀疏数组 + 名字索引。
 *
 * 不做成 class 是因为物品表没有"冻结时烘焙"的需求：
 * 热路径（挖掘速度、伤害计算）拿到的是 ItemDef 引用，一次属性访问，
 * 而它每 tick 最多被读几十次 —— 和方块表每秒几百万次完全不是一个量级。
 */
export function createItemRegistry(): ItemRegistry {
  const defs: ItemDef[] = [];

  // --- 工具（MC 的 id 排布：256-258 铁，269-271 木，273-275 石，277-279 钻，284-286 金）---
  defs.push(...toolSet(256, 'iron', ToolTier.IRON, TOOL_SPEED.iron, TOOL_DURABILITY.iron, SWORD_DAMAGE.iron));
  defs.push(defineItem({
    id: 259, name: Items.FLINT_AND_STEEL, maxStack: 1, maxDurability: 64, texture: 'flint_and_steel',
  }));
  defs.push(food(260, Items.APPLE, 4, 2.4));
  defs.push(defineItem({ id: 261, name: Items.BOW, maxStack: 1, maxDurability: 384, texture: 'bow' }));
  defs.push(defineItem({ id: 262, name: Items.ARROW, texture: 'arrow' }));
  defs.push(defineItem({ id: 263, name: Items.COAL, burnTicks: 1600, texture: 'coal' }));
  defs.push(defineItem({ id: EXT.CHARCOAL, name: Items.CHARCOAL, burnTicks: 1600, texture: 'charcoal' }));
  defs.push(defineItem({ id: 264, name: Items.DIAMOND, texture: 'diamond' }));
  defs.push(defineItem({ id: 265, name: Items.IRON_INGOT, texture: 'iron_ingot' }));
  defs.push(defineItem({ id: 266, name: Items.GOLD_INGOT, texture: 'gold_ingot' }));

  const sword = (id: number, name: string, tier: ToolTier, dur: number, dmg: number): ItemDef =>
    defineItem({
      id, name, maxStack: 1, maxDurability: dur,
      toolKind: ToolKind.SWORD, toolTier: tier, toolSpeed: 1.5, attackDamage: dmg, texture: name,
    });
  defs.push(sword(267, Items.IRON_SWORD, ToolTier.IRON, TOOL_DURABILITY.iron, SWORD_DAMAGE.iron));
  defs.push(sword(268, Items.WOODEN_SWORD, ToolTier.WOOD, TOOL_DURABILITY.wood, SWORD_DAMAGE.wood));
  defs.push(...toolSet(269, 'wooden', ToolTier.WOOD, TOOL_SPEED.wood, TOOL_DURABILITY.wood, SWORD_DAMAGE.wood));
  defs.push(sword(272, Items.STONE_SWORD, ToolTier.STONE, TOOL_DURABILITY.stone, SWORD_DAMAGE.stone));
  defs.push(...toolSet(273, 'stone', ToolTier.STONE, TOOL_SPEED.stone, TOOL_DURABILITY.stone, SWORD_DAMAGE.stone));
  defs.push(sword(276, Items.DIAMOND_SWORD, ToolTier.DIAMOND, TOOL_DURABILITY.diamond, SWORD_DAMAGE.diamond));
  defs.push(...toolSet(277, 'diamond', ToolTier.DIAMOND, TOOL_SPEED.diamond, TOOL_DURABILITY.diamond, SWORD_DAMAGE.diamond));
  defs.push(defineItem({ id: 280, name: Items.STICK, texture: 'stick', burnTicks: 100 }));
  defs.push(defineItem({ id: 281, name: Items.BOWL, texture: 'bowl', burnTicks: 100 }));
  defs.push(food(282, Items.MUSHROOM_STEW, 8, 7.2, 1));
  defs.push(sword(283, Items.GOLDEN_SWORD, ToolTier.GOLD, TOOL_DURABILITY.gold, SWORD_DAMAGE.gold));
  defs.push(...toolSet(284, 'golden', ToolTier.GOLD, TOOL_SPEED.gold, TOOL_DURABILITY.gold, SWORD_DAMAGE.gold));
  defs.push(defineItem({ id: 287, name: Items.STRING, texture: 'string' }));
  defs.push(defineItem({ id: 288, name: Items.FEATHER, texture: 'feather' }));
  defs.push(defineItem({ id: 289, name: Items.GUNPOWDER, texture: 'gunpowder' }));

  const hoe = (id: number, name: string, tier: ToolTier, dur: number): ItemDef =>
    defineItem({
      id, name, maxStack: 1, maxDurability: dur,
      toolKind: ToolKind.HOE, toolTier: tier, toolSpeed: 1, attackDamage: 1, texture: name,
    });
  defs.push(hoe(290, Items.WOODEN_HOE, ToolTier.WOOD, TOOL_DURABILITY.wood));
  defs.push(hoe(291, Items.STONE_HOE, ToolTier.STONE, TOOL_DURABILITY.stone));
  defs.push(hoe(292, Items.IRON_HOE, ToolTier.IRON, TOOL_DURABILITY.iron));
  defs.push(hoe(293, Items.DIAMOND_HOE, ToolTier.DIAMOND, TOOL_DURABILITY.diamond));
  defs.push(hoe(294, Items.GOLDEN_HOE, ToolTier.GOLD, TOOL_DURABILITY.gold));
  defs.push(defineItem({ id: 295, name: Items.SEEDS, texture: 'seeds' }));
  defs.push(defineItem({ id: 296, name: Items.WHEAT, texture: 'wheat' }));
  defs.push(food(297, Items.BREAD, 5, 6));

  // --- 盔甲 ---
  defs.push(...armorSet(298, 'leather', [1, 3, 2, 1], 55));
  defs.push(...armorSet(306, 'iron', [2, 6, 5, 2], 165));
  defs.push(...armorSet(310, 'diamond', [3, 8, 6, 3], 363));
  defs.push(...armorSet(314, 'golden', [2, 5, 3, 1], 77));

  // --- 材料与杂项 ---
  defs.push(defineItem({ id: 318, name: Items.FLINT, texture: 'flint' }));
  defs.push(food(319, Items.PORKCHOP, 3, 1.8));
  defs.push(food(320, Items.COOKED_PORKCHOP, 8, 12.8));
  defs.push(defineItem({ id: 321, name: Items.PAINTING, texture: 'painting' }));
  defs.push(food(322, Items.GOLDEN_APPLE, 4, 9.6));
  defs.push(defineItem({ id: 323, name: Items.SIGN, maxStack: 16, texture: 'sign' }));
  defs.push(defineItem({ id: 324, name: Items.WOODEN_DOOR_ITEM, maxStack: 1, texture: 'door_item', placesBlock: 64 }));
  defs.push(defineItem({ id: 325, name: Items.BUCKET, maxStack: 1, texture: 'bucket' }));
  defs.push(defineItem({ id: 326, name: Items.WATER_BUCKET, maxStack: 1, texture: 'water_bucket' }));
  defs.push(defineItem({ id: 327, name: Items.LAVA_BUCKET, maxStack: 1, texture: 'lava_bucket', burnTicks: 20000 }));
  defs.push(defineItem({ id: 328, name: Items.MINECART, maxStack: 1, texture: 'minecart' }));
  defs.push(defineItem({ id: 329, name: Items.SADDLE, maxStack: 1, texture: 'saddle' }));
  defs.push(defineItem({ id: 330, name: Items.IRON_DOOR_ITEM, maxStack: 1, texture: 'iron_door_item' }));
  defs.push(defineItem({ id: 331, name: Items.REDSTONE, texture: 'redstone' }));
  defs.push(defineItem({ id: 332, name: Items.SNOWBALL, maxStack: 16, texture: 'snowball' }));
  defs.push(defineItem({ id: 333, name: Items.BOAT, maxStack: 1, texture: 'boat' }));
  defs.push(defineItem({ id: 334, name: Items.LEATHER, texture: 'leather' }));
  defs.push(defineItem({ id: 335, name: Items.MILK_BUCKET, maxStack: 1, texture: 'milk_bucket' }));
  defs.push(defineItem({ id: 336, name: Items.BRICK, texture: 'brick_item' }));
  defs.push(defineItem({ id: 337, name: Items.CLAY_BALL, texture: 'clay_ball' }));
  defs.push(defineItem({ id: 338, name: Items.SUGAR_CANE, texture: 'sugar_cane' }));
  defs.push(defineItem({ id: 339, name: Items.PAPER, texture: 'paper' }));
  defs.push(defineItem({ id: 340, name: Items.BOOK, texture: 'book' }));
  defs.push(defineItem({ id: 341, name: Items.SLIMEBALL, texture: 'slimeball' }));
  defs.push(defineItem({ id: 344, name: Items.EGG, maxStack: 16, texture: 'egg' }));
  defs.push(defineItem({ id: 345, name: Items.COMPASS, maxStack: 1, texture: 'compass' }));
  defs.push(defineItem({ id: 346, name: Items.FISHING_ROD, maxStack: 1, maxDurability: 64, texture: 'fishing_rod' }));
  defs.push(defineItem({ id: 347, name: Items.CLOCK, maxStack: 1, texture: 'clock' }));
  defs.push(defineItem({ id: 348, name: Items.GLOWSTONE_DUST, texture: 'glowstone_dust' }));
  defs.push(food(349, Items.RAW_FISH, 2, 0.4));
  defs.push(food(350, Items.COOKED_FISH, 5, 6));
  defs.push(defineItem({ id: 351, name: Items.DYE, texture: 'dye' }));
  defs.push(defineItem({ id: EXT.BONE_MEAL, name: Items.BONE_MEAL, texture: 'bone_meal' }));
  defs.push(defineItem({ id: 352, name: Items.BONE, texture: 'bone' }));
  defs.push(defineItem({ id: 353, name: Items.SUGAR, texture: 'sugar' }));
  defs.push(defineItem({ id: 354, name: Items.CAKE_ITEM, maxStack: 1, texture: 'cake_item', placesBlock: 92 }));
  defs.push(defineItem({ id: 355, name: Items.BED_ITEM, maxStack: 1, texture: 'bed_item', placesBlock: 26 }));
  defs.push(defineItem({ id: 356, name: Items.REPEATER, texture: 'repeater' }));
  defs.push(food(357, Items.COOKIE, 2, 0.4));
  defs.push(defineItem({ id: 359, name: Items.SHEARS, maxStack: 1, maxDurability: 238, toolKind: ToolKind.SHEARS, texture: 'shears' }));
  defs.push(food(360, Items.MELON_SLICE, 2, 1.2));
  defs.push(defineItem({ id: 361, name: Items.PUMPKIN_SEEDS, texture: 'pumpkin_seeds' }));
  defs.push(defineItem({ id: 362, name: Items.MELON_SEEDS, texture: 'melon_seeds' }));
  defs.push(food(363, Items.RAW_BEEF, 3, 1.8));
  defs.push(food(364, Items.STEAK, 8, 12.8));
  defs.push(food(365, Items.RAW_CHICKEN, 2, 1.2));
  defs.push(food(366, Items.COOKED_CHICKEN, 6, 7.2));
  defs.push(food(367, Items.ROTTEN_FLESH, 4, 0.8));
  defs.push(defineItem({ id: 368, name: Items.ENDER_PEARL, maxStack: 16, texture: 'ender_pearl' }));
  defs.push(defineItem({ id: 369, name: Items.BLAZE_ROD, texture: 'blaze_rod' }));
  defs.push(defineItem({ id: 370, name: Items.GHAST_TEAR, texture: 'ghast_tear' }));
  defs.push(defineItem({ id: 371, name: Items.GOLD_NUGGET, texture: 'gold_nugget' }));
  defs.push(defineItem({ id: 372, name: Items.NETHER_WART, texture: 'nether_wart' }));
  defs.push(defineItem({ id: 373, name: Items.POTION, maxStack: 1, texture: 'potion' }));
  defs.push(defineItem({ id: 374, name: Items.GLASS_BOTTLE, texture: 'glass_bottle' }));
  defs.push(food(375, Items.SPIDER_EYE, 2, 3.2));
  defs.push(defineItem({ id: 376, name: Items.FERMENTED_SPIDER_EYE, texture: 'fermented_spider_eye' }));
  defs.push(defineItem({ id: 377, name: Items.BLAZE_POWDER, texture: 'blaze_powder' }));
  defs.push(defineItem({ id: 378, name: Items.MAGMA_CREAM, texture: 'magma_cream' }));
  defs.push(defineItem({ id: 379, name: Items.BREWING_STAND_ITEM, texture: 'brewing_stand_item' }));
  defs.push(defineItem({ id: 380, name: Items.CAULDRON_ITEM, texture: 'cauldron_item' }));
  defs.push(defineItem({ id: 381, name: Items.EYE_OF_ENDER, texture: 'eye_of_ender' }));
  defs.push(defineItem({ id: 382, name: Items.GLISTERING_MELON, texture: 'glistering_melon' }));

  return new ItemRegistry(defs);
}

/** 物品表。按 id 与按名字两种索引 */
export class ItemRegistry {
  private readonly byId = new Map<number, ItemDef>();
  private readonly byName = new Map<string, ItemDef>();

  constructor(defs: readonly ItemDef[]) {
    for (const d of defs) {
      if (this.byId.has(d.id)) throw new Error(`物品 id 重复：${d.id}（${d.name}）`);
      if (this.byName.has(d.name)) throw new Error(`物品名重复：${d.name}`);
      this.byId.set(d.id, d);
      this.byName.set(d.name, d);
    }
  }

  get size(): number {
    return this.byId.size;
  }

  get(id: number): ItemDef | undefined {
    return this.byId.get(id);
  }

  byNameOrThrow(name: string): ItemDef {
    const d = this.byName.get(name);
    if (d === undefined) throw new Error(`没有这个物品：${name}`);
    return d;
  }

  idOf(name: string): number {
    return this.byNameOrThrow(name).id;
  }

  all(): ItemDef[] {
    return [...this.byId.values()].sort((a, b) => a.id - b.id);
  }
}

/** 方块名 -> 作为物品的 id（就是方块 id 本身） */
export function blockItemId(blockId: number): number {
  return blockId;
}

void Blocks;
void ARMOR_POINTS;
