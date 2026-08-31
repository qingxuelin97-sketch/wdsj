/**
 * 把 `core/item/enchant-effects.ts` 里的算法接到服务端的具体动作上。
 *
 * 分成两层的理由：那边是纯函数（好测、能在 core 里跑），这边知道
 * ServerCore / Mob / ServerPlayer 长什么样。中间这一层只做三件事 ——
 * 把随机数接过去、把生物翻译成 MobKind、把伤害类型翻译成 DamageSourceKind。
 *
 * 没有这一层的话，那三段翻译会在 combat.ts / block-interaction.ts 里
 * 各写一遍，而"某处忘了算附魔"正是这个项目已经踩过好几次的坑。
 */
import { enchantLevel, type ItemStack } from '../../core/item/item-def.ts';
import { Enchantment } from '../../core/item/enchantment.ts';
import type { ServerWorld } from '../world/server-world.ts';
import type { Mob } from '../entity/mob.ts';
import { MobType } from '../../content/mobs.ts';
import { DamageKind } from './player-vitals.ts';
import {
  MobKind, DamageSourceKind, type Roll,
  meleeBonusDamage, knockbackLevels, fireAspectSeconds,
  damageAfterProtection, consumesDurability, consumesArmorDurability,
} from '../../core/item/enchant-effects.ts';

/** 世界的随机数当 Roll 用。语义与 java.util.Random.nextInt 一致 */
export function rollOf(world: ServerWorld): Roll {
  return (bound: number): number => world.random.nextInt(bound);
}

/**
 * 这只生物算哪一类。
 *
 * 1.0 只有两组特攻：亡灵杀手打亡灵、节肢杀手打节肢。
 *
 * 这个项目目前只有僵尸和骷髅两种亡灵。1.0 的僵尸猪人也算亡灵，
 * 等它做出来时**记得往这里加一行** —— 漏了的话亡灵杀手在下界毫无用处，
 * 而那正是玩家最想用它的地方。
 */
export function mobKindOf(mob: Mob): MobKind {
  switch (mob.def.type) {
    case MobType.ZOMBIE:
    case MobType.SKELETON:
      return MobKind.UNDEAD;
    case MobType.SPIDER:
      return MobKind.ARTHROPOD;
    default:
      return MobKind.NORMAL;
  }
}

/** 服务端的伤害类型 -> 保护系认识的那一套 */
export function sourceKindOf(kind: DamageKind): DamageSourceKind {
  switch (kind) {
    case DamageKind.FIRE:
      return DamageSourceKind.FIRE;
    case DamageKind.FALL:
      return DamageSourceKind.FALL;
    default:
      return DamageSourceKind.GENERIC;
  }
}

/** 近战一下打出多少额外伤害。整数化交给调用方，与 MC 一样在最后一步取整 */
export function meleeBonusAgainst(weapon: ItemStack, mob: Mob): number {
  return meleeBonusDamage(weapon, mobKindOf(mob));
}

/** 击退要额外加几级 */
export { knockbackLevels, fireAspectSeconds };

/** 这件武器身上的抢夺等级。记在生物身上供掉落时用，见 Mob.lootingLevel */
export function lootingLevelOf(weapon: ItemStack): number {
  return enchantLevel(weapon, Enchantment.LOOTING);
}

/**
 * 抢夺让这一条战利品多掉几件。
 *
 * 每一条战利品各摇一次（原版就是在 dropFewItems 里逐条摇的）——
 * 摇一次然后给所有条目用同一个数的话，抢夺会变成"要么全爆要么全不爆"。
 */
export function extraLootFor(level: number, roll: Roll): number {
  if (level <= 0) return 0;
  return roll(level + 1);
}

/**
 * 保护系减伤。
 *
 * 接在**护甲点数减伤之后** —— MC 也是这个顺序（先 armor 再 enchantment）。
 * 顺序反过来的话满钻甲 + 保护 IV 会算出接近零的伤害。
 */
export function afterProtection(
  amount: number, armor: readonly ItemStack[], kind: DamageKind,
): number {
  return damageAfterProtection(amount, armor, sourceKindOf(kind));
}

/**
 * 扣一点耐久，扣光就把这件东西变没。
 *
 * 耐久附魔在这里生效：`consumesDurability` 摇不中就这一次不扣。
 * @returns 这件东西有没有被用坏
 */
export function damageItem(
  stack: ItemStack, maxDurability: number, roll: Roll, armor = false,
): boolean {
  if (maxDurability <= 0) return false;
  const consumes = armor ? consumesArmorDurability(stack, roll) : consumesDurability(stack, roll);
  if (!consumes) return false;
  stack.damage++;
  if (stack.damage < maxDurability) return false;
  stack.id = 0;
  stack.count = 0;
  stack.damage = 0;
  delete stack.enchantments;
  return true;
}
