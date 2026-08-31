/**
 * 酿造。**纯数据表 + 纯查表函数。**
 *
 * MC 1.0 的酿造是一棵很小的树，但它的形状很讲究：
 *
 *   水瓶 --下界疣--> 粗制的药水（没有任何效果）
 *   粗制的药水 --某种主料--> 一种效果药水
 *   效果药水 --辅料--> 更强 / 更久 / 反转 / 变成投掷型
 *
 * "下界疣是所有药水的第一步"这一条，是把酿造和下界绑死的设计 ——
 * 不去下界就一瓶药也做不出来。所以它属于 M15 而不是某个独立的里程碑。
 *
 * ## 为什么用位掩码表示药水
 *
 * MC 用物品的 damage 值编码药水种类，低 4 位是效果 id，高位是
 * 增强/延长/投掷三个标志。照抄这个编码，"一瓶药水"就还是一个
 * `{id, damage}`，不需要在物品栏里再引入一套 NBT ——
 * 而物品栏的序列化已经在网络协议里定死了。
 */

/** 药水效果 id，沿用 MC 的数值 */
export const Effect = {
  NONE: 0,
  REGENERATION: 1,
  SPEED: 2,
  FIRE_RESISTANCE: 3,
  POISON: 4,
  HEALING: 5,
  NIGHT_VISION: 6,
  WEAKNESS: 8,
  STRENGTH: 9,
  SLOWNESS: 10,
  HARMING: 12,
  WATER_BREATHING: 13,
  INVISIBILITY: 14,
} as const;
export type EffectId = (typeof Effect)[keyof typeof Effect];

/** damage 值里的标志位。低 4 位是效果 id */
export const PotionFlags = {
  EFFECT_MASK: 0x0f,
  /** 增强（II 级） */
  UPGRADED: 0x20,
  /** 延长 */
  EXTENDED: 0x40,
  /** 投掷型 */
  SPLASH: 0x4000,
  /** 已经加过下界疣（"粗制的药水"），但还没加主料 */
  AWKWARD: 0x10,
} as const;

/** 水瓶：damage 为 0 的药水 */
export const WATER_BOTTLE = 0;
/** 粗制的药水 */
export const AWKWARD_POTION = PotionFlags.AWKWARD;

export interface EffectDef {
  readonly id: EffectId;
  readonly name: string;
  /** 有益还是有害。反转（发酵蛛眼）就是在这两边之间跳 */
  readonly harmful: boolean;
  /** 基础时长（刻）。0 表示瞬间生效 */
  readonly durationTicks: number;
  /** 效果强度的基准值，含义随效果而定 */
  readonly amplifierBase: number;
}

export const EFFECTS: Readonly<Record<number, EffectDef>> = {
  [Effect.REGENERATION]: { id: Effect.REGENERATION, name: 'regeneration', harmful: false, durationTicks: 900, amplifierBase: 1 },
  [Effect.SPEED]: { id: Effect.SPEED, name: 'swiftness', harmful: false, durationTicks: 3600, amplifierBase: 1 },
  [Effect.FIRE_RESISTANCE]: { id: Effect.FIRE_RESISTANCE, name: 'fire_resistance', harmful: false, durationTicks: 3600, amplifierBase: 1 },
  [Effect.POISON]: { id: Effect.POISON, name: 'poison', harmful: true, durationTicks: 900, amplifierBase: 1 },
  [Effect.HEALING]: { id: Effect.HEALING, name: 'healing', harmful: false, durationTicks: 0, amplifierBase: 1 },
  [Effect.NIGHT_VISION]: { id: Effect.NIGHT_VISION, name: 'night_vision', harmful: false, durationTicks: 3600, amplifierBase: 1 },
  [Effect.WEAKNESS]: { id: Effect.WEAKNESS, name: 'weakness', harmful: true, durationTicks: 1800, amplifierBase: 1 },
  [Effect.STRENGTH]: { id: Effect.STRENGTH, name: 'strength', harmful: false, durationTicks: 3600, amplifierBase: 1 },
  [Effect.SLOWNESS]: { id: Effect.SLOWNESS, name: 'slowness', harmful: true, durationTicks: 1800, amplifierBase: 1 },
  [Effect.HARMING]: { id: Effect.HARMING, name: 'harming', harmful: true, durationTicks: 0, amplifierBase: 1 },
  [Effect.WATER_BREATHING]: { id: Effect.WATER_BREATHING, name: 'water_breathing', harmful: false, durationTicks: 3600, amplifierBase: 1 },
  [Effect.INVISIBILITY]: { id: Effect.INVISIBILITY, name: 'invisibility', harmful: false, durationTicks: 3600, amplifierBase: 1 },
};

/**
 * 主料表：粗制的药水 + 这个物品 = 这个效果。
 *
 * 键是物品名，不是 id —— id 表在 content 层，而 core 不能依赖 content。
 * 服务端拿名字去问物品注册表，多一次查表换来层次干净。
 */
export const BASE_INGREDIENTS: Readonly<Record<string, EffectId>> = {
  ghast_tear: Effect.REGENERATION,
  sugar: Effect.SPEED,
  magma_cream: Effect.FIRE_RESISTANCE,
  spider_eye: Effect.POISON,
  glistering_melon: Effect.HEALING,
  blaze_powder: Effect.STRENGTH,
  // MC 1.0 里河豚还没有，夜视/水下呼吸要等 1.4；
  // 这里保留效果定义但不给配方 —— 与 1.0 一致
};

/** 辅料：改造已有的药水 */
export const MODIFIERS = {
  GLOWSTONE_DUST: 'glowstone_dust',
  REDSTONE: 'redstone',
  FERMENTED_SPIDER_EYE: 'fermented_spider_eye',
  GUNPOWDER: 'gunpowder',
  NETHER_WART: 'nether_wart',
} as const;

/**
 * 发酵蛛眼的反转表。
 *
 * 这是酿造里最"讲道理"的一步：把一个效果变成它的反面。
 * 治疗↔伤害、迅捷↔缓慢、力量↔虚弱、再生↔毒。
 * 没有反面的（抗火）会变成缓慢 —— MC 的兜底也是这个。
 */
export const CORRUPTION: Readonly<Record<number, EffectId>> = {
  [Effect.HEALING]: Effect.HARMING,
  [Effect.HARMING]: Effect.HEALING,
  [Effect.SPEED]: Effect.SLOWNESS,
  [Effect.SLOWNESS]: Effect.SPEED,
  [Effect.STRENGTH]: Effect.WEAKNESS,
  [Effect.WEAKNESS]: Effect.STRENGTH,
  [Effect.REGENERATION]: Effect.POISON,
  [Effect.POISON]: Effect.REGENERATION,
  [Effect.NIGHT_VISION]: Effect.INVISIBILITY,
};

/** 从 damage 值里解出一瓶药水是什么 */
export interface PotionInfo {
  readonly effect: EffectId;
  readonly upgraded: boolean;
  readonly extended: boolean;
  readonly splash: boolean;
  /** 已经加过下界疣但还没加主料 */
  readonly awkward: boolean;
}

export function readPotion(damage: number): PotionInfo {
  return {
    effect: (damage & PotionFlags.EFFECT_MASK) as EffectId,
    upgraded: (damage & PotionFlags.UPGRADED) !== 0,
    extended: (damage & PotionFlags.EXTENDED) !== 0,
    splash: (damage & PotionFlags.SPLASH) !== 0,
    awkward: (damage & PotionFlags.AWKWARD) !== 0,
  };
}

export function writePotion(p: PotionInfo): number {
  return (p.effect & PotionFlags.EFFECT_MASK)
    | (p.awkward ? PotionFlags.AWKWARD : 0)
    | (p.upgraded ? PotionFlags.UPGRADED : 0)
    | (p.extended ? PotionFlags.EXTENDED : 0)
    | (p.splash ? PotionFlags.SPLASH : 0);
}

/**
 * 酿一次：一瓶药水 + 一份材料 = 什么。
 *
 * @returns 新的 damage 值；这个组合酿不出东西时返回 null
 *          （返回 null 而不是原值：调用方必须能区分"没变化"和
 *          "变成了同一个东西"，否则酿造台会白白消耗材料）
 */
export function brew(potionDamage: number, ingredient: string): number | null {
  const p = readPotion(potionDamage);

  // 下界疣：水瓶 -> 粗制的药水。**只对水瓶有效**
  if (ingredient === MODIFIERS.NETHER_WART) {
    if (potionDamage !== WATER_BOTTLE) return null;
    return AWKWARD_POTION;
  }

  // 主料：只对粗制的药水有效
  const effect = BASE_INGREDIENTS[ingredient];
  if (effect !== undefined) {
    if (!p.awkward || p.effect !== Effect.NONE) return null;
    return writePotion({
      effect, upgraded: false, extended: false, splash: p.splash, awkward: false,
    });
  }

  // 以下辅料都要求已经是一瓶有效果的药水
  if (p.effect === Effect.NONE) return null;

  switch (ingredient) {
    case MODIFIERS.GLOWSTONE_DUST:
      // 增强与延长互斥：加了萤石就不能再延长，反之亦然。
      // 这一条让"要更强还是更久"成为一个真正的取舍
      if (p.upgraded) return null;
      return writePotion({ ...p, upgraded: true, extended: false });
    case MODIFIERS.REDSTONE:
      if (p.extended) return null;
      // 瞬间生效的药水（治疗/伤害）没有时长可延长
      if (EFFECTS[p.effect]?.durationTicks === 0) return null;
      return writePotion({ ...p, extended: true, upgraded: false });
    case MODIFIERS.FERMENTED_SPIDER_EYE: {
      const corrupted = CORRUPTION[p.effect] ?? Effect.SLOWNESS;
      // 反转会**清掉**增强与延长，与 MC 一致 —— 否则可以拿
      // "延长的迅捷"一步换出"延长的缓慢"，那太便宜了
      return writePotion({
        effect: corrupted, upgraded: false, extended: false, splash: p.splash, awkward: false,
      });
    }
    case MODIFIERS.GUNPOWDER:
      if (p.splash) return null;
      return writePotion({ ...p, splash: true });
    default:
      return null;
  }
}

/** 一瓶药水实际的持续时间（刻）与强度 */
export function potionPotency(damage: number): { durationTicks: number; amplifier: number } {
  const p = readPotion(damage);
  const def = EFFECTS[p.effect];
  if (def === undefined) return { durationTicks: 0, amplifier: 0 };
  let duration = def.durationTicks;
  // 增强会**缩短**时长（MC 是减到 1/2），延长则加到 8/3。
  // 增强缩短这一条常被漏掉，漏了的话增强就没有代价了
  if (p.upgraded) duration = Math.floor(duration / 2);
  else if (p.extended) duration = Math.floor((duration * 8) / 3);
  // 投掷型的效果只有直击目标的 3/4
  if (p.splash) duration = Math.floor((duration * 3) / 4);
  return { durationTicks: duration, amplifier: p.upgraded ? 1 : 0 };
}
