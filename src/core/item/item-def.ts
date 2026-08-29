/**
 * 物品定义与物品堆。
 *
 * MC 里"方块"和"物品"是两套 id 空间但共享一个手持槽：方块 id 1..122 同时
 * 也是物品 id，真正的物品从 **256** 开始。这个错位是 1.0 的历史包袱，
 * 但必须照搬 —— 合成表、掉落、存档格式全都按这套 id 写死。
 *
 * ItemStack 用**扁平的三个数**而不是对象数组：物品栏每 tick 要被读很多次，
 * 而且要按原样存进 NBT 与网络包。
 */
import type { ToolKind, ToolTier } from '../block/types.ts';

/** 真正的物品（非方块）id 从这里开始 */
export const ITEM_ID_BASE = 256;

/**
 * 经验球的合成物品 id。
 *
 * 经验球复用掉落物那一整套（物理、同步、合并、过期），只有"捡起来加的是
 * 经验而不是物品"这一点不同 —— 用一个 id 区分就够了。
 *
 * 放在 core 而不是服务端：客户端要靠它决定这颗东西画成经验球还是物品图标，
 * 而客户端**不许 import 服务端**（那会把整个服务端拖进浏览器包里）。
 *
 * 值取 2000：物品 id 最大 382、方块 id 最大 122，2000 落在两者之外，
 * 而网络包里的 itemId 是 u16，装得下。
 */
export const XP_ORB_ITEM_ID = 2000;

/** 盔甲槽位 */
export const ArmorSlot = {
  HELMET: 0,
  CHESTPLATE: 1,
  LEGGINGS: 2,
  BOOTS: 3,
} as const;
export type ArmorSlot = (typeof ArmorSlot)[keyof typeof ArmorSlot];

export interface ItemDef {
  readonly id: number;
  readonly name: string;
  /** 一组最多能叠多少。工具与盔甲是 1 */
  readonly maxStack: number;
  /** 耐久上限，0 表示不消耗 */
  readonly maxDurability: number;
  /** 作为工具时的种类与级别 */
  readonly toolKind: ToolKind | null;
  readonly toolTier: ToolTier;
  /** 挖掘速度倍率：木 2 / 石 4 / 铁 6 / 钻 8 / 金 12 */
  readonly toolSpeed: number;
  /** 近战伤害（半心为 1） */
  readonly attackDamage: number;
  /** 吃下去恢复多少饥饿值。0 表示不能吃 */
  readonly foodPoints: number;
  /** 饱和度 */
  readonly saturation: number;
  /** 盔甲槽与护甲点数 */
  readonly armorSlot: ArmorSlot | null;
  readonly armorPoints: number;
  /** 作为燃料能烧多少 tick，0 表示不是燃料 */
  readonly burnTicks: number;
  /** 贴图名 */
  readonly texture: string;
  /** 放置时对应的方块 id。0 表示不是方块物品 */
  readonly placesBlock: number;
}

export type ItemInput =
  Partial<Omit<ItemDef, 'id' | 'name'>> & Pick<ItemDef, 'id' | 'name'>;

export function defineItem(input: ItemInput): ItemDef {
  return {
    id: input.id,
    name: input.name,
    maxStack: input.maxStack ?? 64,
    maxDurability: input.maxDurability ?? 0,
    toolKind: input.toolKind ?? null,
    toolTier: input.toolTier ?? 0,
    toolSpeed: input.toolSpeed ?? 1,
    attackDamage: input.attackDamage ?? 1,
    foodPoints: input.foodPoints ?? 0,
    saturation: input.saturation ?? 0,
    armorSlot: input.armorSlot ?? null,
    armorPoints: input.armorPoints ?? 0,
    burnTicks: input.burnTicks ?? 0,
    texture: input.texture ?? input.name,
    placesBlock: input.placesBlock ?? 0,
  };
}

/**
 * 一格物品。
 *
 * `count === 0` 一律视为空格，此时 id 与 damage 无意义 ——
 * 用一个"空对象"而不是 null 表示空格，是为了让物品栏永远是定长数组，
 * 不必到处判空。
 */
export interface ItemStack {
  id: number;
  count: number;
  /** 工具的已用耐久，或方块的元数据 */
  damage: number;
}

export function emptyStack(): ItemStack {
  return { id: 0, count: 0, damage: 0 };
}

export function makeStack(id: number, count = 1, damage = 0): ItemStack {
  return { id, count, damage };
}

export function isEmpty(s: ItemStack): boolean {
  return s.count <= 0 || s.id === 0;
}

export function clearStack(s: ItemStack): void {
  s.id = 0;
  s.count = 0;
  s.damage = 0;
}

export function copyStack(from: ItemStack, to: ItemStack): void {
  to.id = from.id;
  to.count = from.count;
  to.damage = from.damage;
}

export function cloneStack(s: ItemStack): ItemStack {
  return { id: s.id, count: s.count, damage: s.damage };
}

/**
 * 两堆能不能合并。
 *
 * 必须同 id **且同 damage**：两把用了一半的铁镐不能叠成一格，
 * 而两组不同元数据的羊毛（白/红）也不能。少了 damage 判断的话，
 * 玩家把一把快断的镐和一把新镐放一起会凭空修好一把。
 */
export function canMerge(a: ItemStack, b: ItemStack): boolean {
  if (isEmpty(a) || isEmpty(b)) return true;
  return a.id === b.id && a.damage === b.damage;
}
