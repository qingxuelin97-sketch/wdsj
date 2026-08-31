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
 * 发酵蛛眼的腐化规则。
 *
 * **它不是"取反"，而是一条位运算。** 1.0 的 `PotionHelper` 给发酵蛛眼配的串是
 * `-0+3-4+13`：清掉 damage 的 bit0、置上 bit3、清掉 bit4（粗制标记）、
 * 置上 bit13（"这是一瓶真药水"）。落到低 4 位的效果 id 上就是这一个式子。
 *
 * **这条我采信的是这个位运算式，理由是它一次推出了全部有据可查的官方组合**：
 * 水瓶→虚弱、迅捷→缓慢、抗火→缓慢、治疗→伤害、剧毒→伤害、力量→虚弱、
 * 夜视→隐身。手写的"互换表"推不出"抗火→缓慢"这种不对称的条目，
 * 也推不出"缓慢再腐化还是缓慢"这种不动点 —— 那两类恰恰是它对不对的试金石。
 */
export function corruptEffect(effect: number): EffectId {
  return ((((effect & ~0x01) | 0x08)) & PotionFlags.EFFECT_MASK) as EffectId;
}

/**
 * 上面那个式子对 1.0 有定义的每一种效果算出来的结果，摊开写一遍。
 *
 * 摊开是为了能一眼核对，而不是为了省一次计算 —— `corruptEffect` 才是真相，
 * 测试会逐条比对两者。
 *
 * 原来这里写的是一张**对称的互换表**（治疗↔伤害、迅捷↔缓慢、再生↔剧毒……），
 * 那是照直觉编的，有四条与 1.0 不符：
 *
 *   - 剧毒 + 发酵蛛眼给的是**伤害**，不是再生 —— 出再生的话，玩家用一只蜘蛛眼
 *     加一份发酵蛛眼就能刷出再生药水，而 1.0 里再生只能靠恶魂之泪，
 *     等于凭空多了一条绕过下界的经济
 *   - 缓慢 / 伤害 / 虚弱 + 发酵蛛眼在 1.0 里**原地不动**（酿造台根本不开工），
 *     互换表却会把它们变回迅捷 / 治疗 / 力量 —— 一份发酵蛛眼就能反悔，
 *     "腐化是单向的"这个代价整个消失了
 *   - 再生 + 发酵蛛眼给的是虚弱，不是剧毒
 */
export const CORRUPTION: Readonly<Record<number, EffectId>> = {
  // 水瓶与粗制的药水（都还没有效果）→ 虚弱。1.0 里唯一不需要下界疣的一条路
  [Effect.NONE]: Effect.WEAKNESS,
  [Effect.REGENERATION]: Effect.WEAKNESS,
  [Effect.SPEED]: Effect.SLOWNESS,
  [Effect.FIRE_RESISTANCE]: Effect.SLOWNESS,
  [Effect.POISON]: Effect.HARMING,
  [Effect.HEALING]: Effect.HARMING,
  [Effect.NIGHT_VISION]: Effect.INVISIBILITY,
  [Effect.STRENGTH]: Effect.WEAKNESS,
  [Effect.WATER_BREATHING]: Effect.HARMING,
  // 下面四条是**不动点**：已经腐化过的东西再腐化一次还是它自己。
  // brew() 会原样返回，酿造台看到"结果和原来一模一样"就不开工（1.0 的
  // TileEntityBrewingStand.canBrew 里那句 `j != k`），材料不会被白吃掉
  [Effect.WEAKNESS]: Effect.WEAKNESS,
  [Effect.SLOWNESS]: Effect.SLOWNESS,
  [Effect.HARMING]: Effect.HARMING,
  [Effect.INVISIBILITY]: Effect.INVISIBILITY,
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

  // 发酵蛛眼要挡在"必须已经是一瓶有效果的药水"这道闸门**前面**。
  //
  // 水瓶 / 粗制的药水 + 发酵蛛眼 = 虚弱药水，这是 1.0 里**唯一不需要下界疣**的
  // 一条路（配方串里那个 `+3` 对水瓶的 0 也照样成立），也是绝大多数玩家
  // 酿出来的第一瓶药。挡在闸门后面的话，没去过下界的玩家在酿造台上
  // 怎么试都是空的 —— 而游戏不会给任何提示，只是不开工
  if (ingredient === MODIFIERS.FERMENTED_SPIDER_EYE) {
    const corrupted = CORRUPTION[p.effect] ?? corruptEffect(p.effect);
    // 增强与延长**保留**：1.0 的配方串只动 bit0 / 3 / 4 / 13，碰不到
    // bit5（增强）与 bit6（延长）。所以治疗 II 腐化成的是伤害 II，
    // 延长的迅捷腐化成的是延长的缓慢 —— 缓慢 4:00 就是这么来的。
    // 反过来，如果在这里把两个标志清掉，"伤害 II + 发酵蛛眼"会
    // 悄悄降级成伤害 I，还白吃一份材料：玩家看到的是药水变弱了
    return writePotion({ ...p, effect: corrupted, awkward: false });
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
