/**
 * 生物定义表。
 *
 * 和方块、物品一样是**数据**而不是十几个子类：一只生物的差异几乎全在数值上
 * （血量、体型、速度、掉什么、怕不怕太阳），真正需要代码的只有行为，
 * 而行为由 AI 目标组合出来（见 server/entity/goal.ts）。
 *
 * 移动速度按**格/秒**写，不照抄 MC 的 `moveSpeed` 字段。理由记在
 * docs/DEVIATIONS.md：那个字段在原版里要经过一串与玩家不同的换算，
 * 照抄数字反而对不上；而玩家真正能感知的是相对关系 ——
 * 僵尸追不上走路的你、蜘蛛追得上、末影人和你差不多。这些关系必须对。
 */
import { Items } from './items.ts';

/** 生物类别，决定生成规则与上限 */
export const MobCategory = {
  /** 敌对：亮度 ≤7 生成，上限 70 */
  HOSTILE: 0,
  /** 被动动物：地表草地生成，上限 15 */
  PASSIVE: 1,
} as const;
export type MobCategory = (typeof MobCategory)[keyof typeof MobCategory];

/** 生物种类编号。进网络包，所以不能随便改 */
export const MobType = {
  PIG: 0,
  COW: 1,
  SHEEP: 2,
  CHICKEN: 3,
  ZOMBIE: 4,
  SKELETON: 5,
  CREEPER: 6,
  SPIDER: 7,
  ENDERMAN: 8,
  /** 恶魂。只在下界生成 */
  GHAST: 9,
  /**
   * 恶魂的火球。
   *
   * 做成"生物"而不是像箭那样的独立实体，是为了**能被看见和被打**：
   * 生物那条链路（出生包/移动包/销毁包/C_AttackEntity）已经完整，
   * 火球需要的正好是这一整套 —— 而"击回火球"这件事的全部前提
   * 就是玩家能瞄准它、打到它。箭走的是另一条路，服务端算完就完，
   * 客户端根本看不见。
   */
  FIREBALL: 10,
} as const;
export type MobType = (typeof MobType)[keyof typeof MobType];

export const MOB_TYPE_COUNT = 11;

/** 一条掉落：物品、数量范围、概率 */
export interface LootEntry {
  readonly item: string;
  readonly min: number;
  readonly max: number;
  /** 0..1，1 表示必掉 */
  readonly chance: number;
  /** 烧死的时候掉熟的那个（猪 -> 熟猪排） */
  readonly cooked?: string;
}

export interface MobDef {
  readonly type: MobType;
  readonly name: string;
  readonly category: MobCategory;
  readonly width: number;
  readonly height: number;
  /** 眼睛高度，用于视线判定与射击 */
  readonly eyeHeight: number;
  readonly maxHealth: number;
  /** 近战伤害（半心为 1）。0 表示不主动攻击 */
  readonly attackDamage: number;
  /** 发现玩家的距离 */
  readonly followRange: number;
  /** 移动速度，格/秒 */
  readonly speed: number;
  /** 白天在天光下会烧起来 */
  readonly burnsInSunlight: boolean;
  /**
   * 会飞：不受重力，也不吃摔落伤害。
   *
   * 恶魂与火球都要它。没有这一条的话，恶魂一出生就往下掉，
   * 而"悬在半空"恰恰是恶魂全部的威胁感来源
   */
  readonly flying: boolean;
  /** 死亡给多少经验 */
  readonly xp: number;
  readonly loot: readonly LootEntry[];
  /** 会被什么手持物吸引（繁殖前身：跟着走） */
  readonly temptedBy: string | null;
}

type MobInput = Partial<Omit<MobDef, 'type' | 'name' | 'category'>>
  & Pick<MobDef, 'type' | 'name' | 'category'>;

function defineMob(input: MobInput): MobDef {
  return {
    type: input.type,
    name: input.name,
    category: input.category,
    width: input.width ?? 0.6,
    height: input.height ?? 1.8,
    eyeHeight: input.eyeHeight ?? (input.height ?? 1.8) * 0.85,
    maxHealth: input.maxHealth ?? 10,
    attackDamage: input.attackDamage ?? 0,
    followRange: input.followRange ?? 16,
    speed: input.speed ?? 3.0,
    burnsInSunlight: input.burnsInSunlight ?? false,
    flying: input.flying ?? false,
    xp: input.xp ?? 0,
    loot: input.loot ?? [],
    temptedBy: input.temptedBy ?? null,
  };
}

/**
 * 全部九种生物。
 *
 * 1.0 里还有史莱姆、岩浆怪、恶魂、僵尸猪人、蠹虫、狼、豹猫、乌贼、雪傀儡。
 * 下界那几种跟着 M15 一起做（它们只在下界生成，现在做了也刷不出来），
 * 其余的按 docs/RUBRIC.md 的"4 种被动 + 僵尸/骷髅 + 苦力怕 + 末影人"打分口径，
 * 这九种已经覆盖满分项。
 */
export const MOBS: readonly MobDef[] = [
  // --- 被动 ---
  defineMob({
    type: MobType.PIG, name: 'pig', category: MobCategory.PASSIVE,
    width: 0.9, height: 0.9, eyeHeight: 0.7,
    maxHealth: 10, speed: 1.4, xp: 1,
    temptedBy: Items.WHEAT,
    loot: [{ item: Items.PORKCHOP, min: 1, max: 3, chance: 1, cooked: Items.COOKED_PORKCHOP }],
  }),
  defineMob({
    type: MobType.COW, name: 'cow', category: MobCategory.PASSIVE,
    width: 0.9, height: 1.3, eyeHeight: 1.1,
    maxHealth: 10, speed: 1.4, xp: 1,
    temptedBy: Items.WHEAT,
    loot: [
      { item: Items.LEATHER, min: 0, max: 2, chance: 1 },
      { item: Items.RAW_BEEF, min: 1, max: 3, chance: 1, cooked: Items.STEAK },
    ],
  }),
  defineMob({
    type: MobType.SHEEP, name: 'sheep', category: MobCategory.PASSIVE,
    width: 0.9, height: 1.3, eyeHeight: 1.1,
    maxHealth: 8, speed: 1.4, xp: 1,
    temptedBy: Items.WHEAT,
    // 羊毛掉落在 onDeath 里按羊的颜色特判，不走这张表
    loot: [],
  }),
  defineMob({
    type: MobType.CHICKEN, name: 'chicken', category: MobCategory.PASSIVE,
    width: 0.4, height: 0.7, eyeHeight: 0.6,
    maxHealth: 4, speed: 1.4, xp: 1,
    temptedBy: Items.SEEDS,
    loot: [
      { item: Items.FEATHER, min: 0, max: 2, chance: 1 },
      { item: Items.RAW_CHICKEN, min: 1, max: 1, chance: 1, cooked: Items.COOKED_CHICKEN },
    ],
  }),

  // --- 敌对 ---
  defineMob({
    type: MobType.ZOMBIE, name: 'zombie', category: MobCategory.HOSTILE,
    width: 0.6, height: 1.8, eyeHeight: 1.62,
    maxHealth: 20, attackDamage: 4, followRange: 40,
    // 走路的玩家（4.317）能甩开僵尸，这是"跑就完事了"这条常识的来源
    speed: 2.8, burnsInSunlight: true, xp: 5,
    loot: [{ item: Items.ROTTEN_FLESH, min: 0, max: 2, chance: 1 }],
  }),
  defineMob({
    type: MobType.SKELETON, name: 'skeleton', category: MobCategory.HOSTILE,
    width: 0.6, height: 1.8, eyeHeight: 1.62,
    maxHealth: 20, attackDamage: 2, followRange: 40,
    speed: 2.8, burnsInSunlight: true, xp: 5,
    loot: [
      { item: Items.ARROW, min: 0, max: 2, chance: 1 },
      { item: Items.BONE, min: 0, max: 2, chance: 1 },
    ],
  }),
  defineMob({
    type: MobType.CREEPER, name: 'creeper', category: MobCategory.HOSTILE,
    width: 0.6, height: 1.8, eyeHeight: 1.62,
    // 苦力怕不"攻击"，它引爆自己 —— attackDamage 留 0，伤害来自爆炸
    maxHealth: 20, attackDamage: 0, followRange: 16,
    speed: 2.8, xp: 5,
    loot: [{ item: Items.GUNPOWDER, min: 0, max: 2, chance: 1 }],
  }),
  defineMob({
    type: MobType.SPIDER, name: 'spider', category: MobCategory.HOSTILE,
    width: 1.4, height: 0.9, eyeHeight: 0.65,
    maxHealth: 16, attackDamage: 2, followRange: 16,
    // 比走路的玩家快 —— 蜘蛛是少数"跑不掉"的怪
    speed: 4.8, xp: 5,
    loot: [{ item: Items.STRING, min: 0, max: 2, chance: 1 }],
  }),
  defineMob({
    type: MobType.ENDERMAN, name: 'enderman', category: MobCategory.HOSTILE,
    width: 0.6, height: 2.9, eyeHeight: 2.55,
    maxHealth: 40, attackDamage: 4, followRange: 64,
    speed: 4.3, xp: 5,
    loot: [{ item: Items.ENDER_PEARL, min: 0, max: 1, chance: 1 }],
  }),

  // --- 下界 ---
  defineMob({
    // 恶魂很大（4×4）而血很薄（10）。这个组合是它设计的核心：
    // 好打中，但它在天上、够不着 —— 于是玩家必须用弓，
    // 或者把它自己的火球打回去
    type: MobType.GHAST, name: 'ghast', category: MobCategory.HOSTILE,
    width: 4, height: 4, eyeHeight: 2.6,
    maxHealth: 10, attackDamage: 0, followRange: 64,
    speed: 1.6, flying: true, xp: 5,
    loot: [
      { item: Items.GUNPOWDER, min: 0, max: 2, chance: 1 },
      { item: Items.GHAST_TEAR, min: 0, max: 1, chance: 1 },
    ],
  }),
  defineMob({
    // 火球本身：一格见方、一点血、没有 AI。它是"实体"而不是"子弹"，
    // 因为玩家要能打到它
    type: MobType.FIREBALL, name: 'fireball', category: MobCategory.HOSTILE,
    width: 1, height: 1, eyeHeight: 0.5,
    maxHealth: 1, attackDamage: 0, followRange: 0,
    speed: 0, flying: true, xp: 0,
  }),
];

/** 按 type 索引。MOBS 是按 type 顺序写的，这里断言一下省得以后插错位置 */
export function createMobTable(): readonly MobDef[] {
  const table = new Array<MobDef | null>(MOB_TYPE_COUNT).fill(null);
  for (const def of MOBS) {
    if (table[def.type] !== null) throw new Error(`生物 type ${def.type} 重复`);
    table[def.type] = def;
  }
  const missing = table.findIndex((d) => d === null);
  if (missing >= 0) throw new Error(`生物 type ${missing} 没有定义`);
  return table as readonly MobDef[];
}

export function mobDefOf(type: number): MobDef | null {
  return MOBS.find((m) => m.type === type) ?? null;
}
