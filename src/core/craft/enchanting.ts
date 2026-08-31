/**
 * 附魔台的算法。**纯函数**：给一个随机源和书架数，算出三个选项。
 *
 * MC 1.0 的附魔分三步，每一步都有它存在的理由：
 *
 *   1. **报价**（三个槽各花多少级）—— 由书架数决定上限。
 *      这一步是玩家唯一看得见的信息，也是"要不要再搭几个书架"
 *      这个决策的全部依据。
 *   2. **修正**（把报价换算成一个内部的"附魔力"）—— 掺进物品的
 *      附魔性（金 22、钻石 10、木 15…）和两次三角分布的抖动。
 *      三角分布是关键：它让极端结果**罕见但可能**，而均匀分布
 *      会让每次附魔都很平庸。
 *   3. **抽取** —— 按权重挑一条，再按"附魔力还剩多少"反复尝试追加
 *      第二条、第三条，每追加一次附魔力减半。
 *
 * 只做第 1、3 步的话（很多复刻是这样），表现是"附魔台只出一条附魔"，
 * 而玩家立刻会发现不对。
 */
import {
  ENCHANTMENTS, canApplyTogether, enchantmentById,
  type AppliedEnchantment, type EnchantmentDef, type EnchantTargetKind,
} from '../item/enchantment.ts';

/** 附魔台最多认几个书架。MC 是 15 */
export const MAX_BOOKSHELVES = 15;

/**
 * 三个槽各要花多少级。
 *
 * MC 的公式：
 *   base = rand(1..8) + floor(shelves/2) + rand(0..shelves)
 *   slot0 = max(base/3, 1)
 *   slot1 = base*2/3 + 1
 *   slot2 = max(base, shelves*2)
 *
 * 第三槽的 `max(base, shelves*2)` 是整套设计的核心：书架搭满时它
 * **保底 30 级**，于是"搭满 15 个书架"成了一个明确的目标。
 * 少了这一项，书架就只是让报价的方差变大而已。
 */
export function enchantmentCosts(rand: () => number, bookshelves: number): [number, number, number] {
  const shelves = Math.max(0, Math.min(MAX_BOOKSHELVES, Math.floor(bookshelves)));
  const base = 1 + Math.floor(rand() * 8) + Math.floor(shelves / 2) + Math.floor(rand() * (shelves + 1));
  return [
    Math.max(Math.floor(base / 3), 1),
    Math.floor((base * 2) / 3) + 1,
    Math.max(base, shelves * 2),
  ];
}

/**
 * 三角分布的抖动：两次独立取样求和，再居中。
 *
 * MC 写作 `rand.nextFloat() + rand.nextFloat()`，等价于本函数。
 * 单独一次取样是均匀分布，两次相加是三角分布 —— 中间厚、两头薄，
 * 于是"运气特别好"和"运气特别差"都罕见，而这恰恰是赌博机制
 * 让人上瘾的形状。
 */
function triangular(rand: () => number): number {
  return rand() + rand();
}

/**
 * 把报价换算成实际的附魔力。
 *
 * @param enchantability 物品的附魔性：木 15 / 石 5 / 铁 14 / 钻石 10 / 金 22。
 *                       金最高是 MC 的一个著名反直觉设定 —— 金装很脆，
 *                       但附魔起来最好，于是"金镐挖两下就坏但带着精准采集"
 *                       是真实存在的玩法。
 */
export function enchantmentPower(rand: () => number, cost: number, enchantability: number): number {
  const e = Math.max(1, enchantability);
  // MC 是 `1 + nextInt((j>>1)+1) + nextInt((j>>1)+1)`，注意是**除二**不是除四。
  // 写成除四的话钻石装 30 级最高只到 40 附魔力，而锋利 V 要 45 ——
  // 症状是"三十级附魔永远出不了锋利 V"，而玩家对这件事极其敏感
  const half = Math.floor(e / 2) + 1;
  const bonus = 1 + Math.floor(rand() * half) + Math.floor(rand() * half);
  let power = cost + bonus;
  // ±15% 的三角抖动
  const factor = 1 + (triangular(rand) - 1) * 0.15;
  power = Math.round(power * factor);
  return Math.max(1, power);
}

/** 在给定附魔力下，某个附魔可以出到几级；出不了返回 0 */
export function levelFor(def: EnchantmentDef, power: number): number {
  for (let l = def.maxLevel; l >= 1; l--) {
    if (power >= def.minEnchantability(l) && power <= def.maxEnchantability(l)) return l;
  }
  return 0;
}

/** 这个附魔力下，某类装备有哪些候选 */
export function candidatesFor(target: EnchantTargetKind, power: number): AppliedEnchantment[] {
  const out: AppliedEnchantment[] = [];
  for (const def of ENCHANTMENTS) {
    if (!targetMatches(def.target, target)) continue;
    const level = levelFor(def, power);
    if (level > 0) out.push({ id: def.id, level });
  }
  return out;
}

/**
 * 装备种类的包含关系：头盔既是 ARMOR_HEAD 也是 ARMOR。
 *
 * 反过来不成立 —— 靴子不能附呼吸。写成一个函数而不是把头盔的
 * target 列成数组，是因为"附魔说自己上什么"和"装备说自己是什么"
 * 是两个方向，混在一起会很快分不清谁在匹配谁。
 */
function targetMatches(enchantTarget: EnchantTargetKind, itemTarget: EnchantTargetKind): boolean {
  if (enchantTarget === itemTarget) return true;
  if (enchantTarget === 'armor') {
    return itemTarget === 'armor' || itemTarget === 'armor_head' || itemTarget === 'armor_feet';
  }
  return false;
}

/** 按权重抽一条 */
function pickWeighted(rand: () => number, pool: AppliedEnchantment[]): AppliedEnchantment | null {
  if (pool.length === 0) return null;
  let total = 0;
  for (const c of pool) total += enchantmentById(c.id)?.weight ?? 0;
  if (total <= 0) return null;
  let roll = rand() * total;
  for (const c of pool) {
    roll -= enchantmentById(c.id)?.weight ?? 0;
    if (roll < 0) return c;
  }
  return pool[pool.length - 1]!;
}

/**
 * 抽一整套附魔。
 *
 * @param cost   玩家点的那个槽花的级数
 * @param target 装备种类
 * @param enchantability 物品材质的附魔性
 */
export function rollEnchantments(
  rand: () => number, cost: number, target: EnchantTargetKind, enchantability: number,
): AppliedEnchantment[] {
  let power = enchantmentPower(rand, cost, enchantability);
  const pool = candidatesFor(target, power);
  const first = pickWeighted(rand, pool);
  if (first === null) return [];
  const out: AppliedEnchantment[] = [first];

  // 追加：每次把附魔力减半，再按 (power+1)/50 的概率决定要不要继续。
  //
  // 减半这一步让"一件装备上三条附魔"变得很难而不是不可能，
  // 而那正是高级附魔值得追求的原因。不减半的话，30 级附魔
  // 会稳定给出四五条，附魔立刻就不稀奇了
  for (;;) {
    power = Math.floor(power / 2);
    if (rand() >= (power + 1) / 50) break;
    const rest = candidatesFor(target, power)
      .filter((c) => out.every((o) => canApplyTogether(o.id, c.id)));
    const next = pickWeighted(rand, rest);
    if (next === null) break;
    out.push(next);
  }
  return out;
}
