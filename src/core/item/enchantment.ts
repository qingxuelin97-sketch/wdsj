/**
 * 附魔表。**纯数据 + 纯算法，不碰世界也不碰物品栏。**
 *
 * MC 1.0 的附魔一共 20 种，id 沿用原版数值（保护 0 … 无限 51）。
 * 那些 id 中间是断开的（0-6 / 16-21 / 32-35 / 48-51），不是随意的：
 * **高 4 位就是装备种类**。照抄这个编号让"这个附魔能上什么装备"
 * 在数据层就是自明的。
 *
 * ## 为什么整套都在 core
 *
 * 附魔的三样东西 —— 花多少级、出什么、几级 —— 都是纯函数，
 * 只要给一个随机源。放在 core 才能在 node 里跑几万次做统计断言，
 * 而"附魔台永远只出保护 I"这类退化，只有统计才看得出来。
 */

/** 附魔 id，沿用 MC 1.0 的真实数值 */
export const Enchantment = {
  PROTECTION: 0,
  FIRE_PROTECTION: 1,
  FEATHER_FALLING: 2,
  BLAST_PROTECTION: 3,
  PROJECTILE_PROTECTION: 4,
  RESPIRATION: 5,
  AQUA_AFFINITY: 6,

  SHARPNESS: 16,
  SMITE: 17,
  BANE_OF_ARTHROPODS: 18,
  KNOCKBACK: 19,
  FIRE_ASPECT: 20,
  LOOTING: 21,

  EFFICIENCY: 32,
  SILK_TOUCH: 33,
  UNBREAKING: 34,
  FORTUNE: 35,

  POWER: 48,
  PUNCH: 49,
  FLAME: 50,
  INFINITY: 51,
} as const;
export type EnchantmentId = (typeof Enchantment)[keyof typeof Enchantment];

/** 附魔能上什么装备 */
export const EnchantTarget = {
  ARMOR: 'armor',
  ARMOR_HEAD: 'armor_head',
  ARMOR_FEET: 'armor_feet',
  SWORD: 'sword',
  DIGGER: 'digger',
  BOW: 'bow',
} as const;
export type EnchantTargetKind = (typeof EnchantTarget)[keyof typeof EnchantTarget];

export interface EnchantmentDef {
  readonly id: EnchantmentId;
  readonly name: string;
  readonly target: EnchantTargetKind;
  readonly maxLevel: number;
  /**
   * 抽取权重。数越大越常见。
   *
   * MC 里它叫 `getWeight`，与稀有度一一对应：
   * 常见 10 / 不常见 5 / 稀有 2 / 极稀有 1。
   * 精准采集和无限是 1 —— 它们是"运气"，不是"预期"。
   */
  readonly weight: number;
  /** 第 n 级的最低经验修正值。MC 的 getMinEnchantability */
  minEnchantability(level: number): number;
  /** 第 n 级的最高经验修正值 */
  maxEnchantability(level: number): number;
}

/** 大多数附魔的修正值是 `base + (level-1)*step`，跨度固定 */
function ramp(base: number, step: number, span: number) {
  return {
    minEnchantability: (l: number): number => base + (l - 1) * step,
    maxEnchantability: (l: number): number => base + (l - 1) * step + span,
  };
}

function def(
  id: EnchantmentId, name: string, target: EnchantTargetKind,
  maxLevel: number, weight: number,
  base: number, step: number, span: number,
): EnchantmentDef {
  return { id, name, target, maxLevel, weight, ...ramp(base, step, span) };
}

/**
 * 全部 20 种附魔。数值照 MC 1.0。
 *
 * 这张表的每一行都是玩家能直接感知的：锋利最高 V、精准采集只有 I、
 * 火焰附加要花很多级。改一个数就会改变一整套刷装备的节奏。
 */
export const ENCHANTMENTS: readonly EnchantmentDef[] = [
  def(Enchantment.PROTECTION, 'protection', EnchantTarget.ARMOR, 4, 10, 1, 11, 20),
  def(Enchantment.FIRE_PROTECTION, 'fire_protection', EnchantTarget.ARMOR, 4, 5, 10, 8, 12),
  def(Enchantment.FEATHER_FALLING, 'feather_falling', EnchantTarget.ARMOR_FEET, 4, 5, 5, 6, 10),
  def(Enchantment.BLAST_PROTECTION, 'blast_protection', EnchantTarget.ARMOR, 4, 2, 5, 8, 12),
  def(Enchantment.PROJECTILE_PROTECTION, 'projectile_protection', EnchantTarget.ARMOR, 4, 5, 3, 6, 15),
  def(Enchantment.RESPIRATION, 'respiration', EnchantTarget.ARMOR_HEAD, 3, 2, 10, 10, 30),
  def(Enchantment.AQUA_AFFINITY, 'aqua_affinity', EnchantTarget.ARMOR_HEAD, 1, 2, 1, 0, 40),

  def(Enchantment.SHARPNESS, 'sharpness', EnchantTarget.SWORD, 5, 10, 1, 11, 20),
  def(Enchantment.SMITE, 'smite', EnchantTarget.SWORD, 5, 5, 5, 8, 20),
  def(Enchantment.BANE_OF_ARTHROPODS, 'bane_of_arthropods', EnchantTarget.SWORD, 5, 5, 5, 8, 20),
  def(Enchantment.KNOCKBACK, 'knockback', EnchantTarget.SWORD, 2, 5, 5, 20, 50),
  def(Enchantment.FIRE_ASPECT, 'fire_aspect', EnchantTarget.SWORD, 2, 2, 10, 20, 50),
  def(Enchantment.LOOTING, 'looting', EnchantTarget.SWORD, 3, 2, 15, 9, 50),

  def(Enchantment.EFFICIENCY, 'efficiency', EnchantTarget.DIGGER, 5, 10, 1, 10, 50),
  def(Enchantment.SILK_TOUCH, 'silk_touch', EnchantTarget.DIGGER, 1, 1, 15, 0, 50),
  def(Enchantment.UNBREAKING, 'unbreaking', EnchantTarget.DIGGER, 3, 5, 5, 8, 50),
  def(Enchantment.FORTUNE, 'fortune', EnchantTarget.DIGGER, 3, 2, 15, 9, 50),

  def(Enchantment.POWER, 'power', EnchantTarget.BOW, 5, 10, 1, 10, 15),
  def(Enchantment.PUNCH, 'punch', EnchantTarget.BOW, 2, 2, 12, 20, 25),
  def(Enchantment.FLAME, 'flame', EnchantTarget.BOW, 1, 2, 20, 0, 30),
  def(Enchantment.INFINITY, 'infinity', EnchantTarget.BOW, 1, 1, 20, 0, 30),
];

const BY_ID = new Map<number, EnchantmentDef>(ENCHANTMENTS.map((e) => [e.id, e]));

export function enchantmentById(id: number): EnchantmentDef | null {
  return BY_ID.get(id) ?? null;
}

/**
 * 互斥组。同一组里的附魔不能共存于一件装备。
 *
 * MC 是靠 `canApplyTogether` 一条条判的，这里做成组 —— 结果一样，
 * 但"哪些互斥"变成一眼能读完的数据，而不是散在若干 if 里。
 */
export const EXCLUSIVE_GROUPS: readonly (readonly EnchantmentId[])[] = [
  [Enchantment.PROTECTION, Enchantment.FIRE_PROTECTION,
    Enchantment.BLAST_PROTECTION, Enchantment.PROJECTILE_PROTECTION],
  [Enchantment.SHARPNESS, Enchantment.SMITE, Enchantment.BANE_OF_ARTHROPODS],
  [Enchantment.SILK_TOUCH, Enchantment.FORTUNE],
];

/** 两个附魔能不能同时存在 */
export function canApplyTogether(a: EnchantmentId, b: EnchantmentId): boolean {
  if (a === b) return false;
  for (const g of EXCLUSIVE_GROUPS) {
    if (g.includes(a) && g.includes(b)) return false;
  }
  return true;
}

/** 一条附魔：种类 + 等级 */
export interface AppliedEnchantment {
  readonly id: EnchantmentId;
  readonly level: number;
}
