/**
 * 附魔效果层的测试。
 *
 * 与 enchanting.test.ts 不同，这里**不跑统计**：附魔台是概率的，
 * 而效果层是确定的 —— 给定装备与情境，答案只有一个。所以每条断言都把
 * 期望值**写死**（锋利 V 是 6.25，整套保护 IV 把 10 点压到 6），
 * 而不是把实现里的公式再抄一遍 —— 抄一遍的话，公式抄错时测试会跟着一起错。
 *
 * 要随机数的四条（抢夺、时运、耐久、水下呼吸）都传假的 nextInt：
 * 摇到 0 与摇到上界各断言一次，把两端钉死。真随机在这里毫无价值 ——
 * "耐久 III 大概四次掉一次耐久"这种事只能靠边界证明，不能靠采样。
 *
 * 最要紧的是"没附魔返回中性值"那几条：接线之后，全服绝大多数装备
 * 走的都是这条路，它错了就是每一次攻击、每一次挖掘都错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Enchantment } from '../../src/core/item/enchantment.ts';
import { emptyStack, type ItemStack } from '../../src/core/item/item-def.ts';
import {
  MobKind, DamageSourceKind,
  meleeBonusDamage, knockbackLevels, fireAspectSeconds, extraLootRolls,
  protectionEpf, damageAfterProtection, respirationAirMultiplier, consumesAir, hasAquaAffinity,
  miningSpeedBonus, hasSilkTouch, consumesDurability, consumesArmorDurability, fortuneMultiplier,
  arrowDamageMultiplier, punchLevels, flameArrowSeconds, hasInfinity,
  type Roll,
} from '../../src/core/item/enchant-effects.ts';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 物品 id：钻石剑 276 / 钻石镐 278 / 弓 261 / 钻石头盔 310 / 钻石靴 313。
 *  这一层其实不看 id（只读 enchantments），写真 id 只是为了读起来像回事 */
const SWORD = 276;
const PICKAXE = 278;
const BOW = 261;
const HELMET = 310;
const BOOTS = 313;

/** 一件没附魔的装备 */
function plain(id: number): ItemStack {
  return { id, count: 1, damage: 0 };
}

/** 一件带指定附魔的装备 */
function enchanted(id: number, ...pairs: readonly (readonly [number, number])[]): ItemStack {
  return { id, count: 1, damage: 0, enchantments: pairs.map(([e, level]) => ({ id: e, level })) };
}

/** 永远摇到下界 0 的假 nextInt */
const rollMin: Roll = () => 0;
/** 永远摇到上界 bound−1 的假 nextInt */
const rollMax: Roll = (bound) => bound - 1;
/** 摇到固定值 */
function rollAt(v: number): Roll {
  return () => v;
}
/** 被调用就炸。用来证明"没附魔时一次随机数都不摸"——共用随机源时白摇会让后面全部错位 */
const rollNever: Roll = () => {
  throw new Error('没附魔却摸了随机数');
};
/** 按脚本依次给出结果。给"要摇两次"的盔甲耐久用 */
function scriptedRoll(values: readonly number[]): Roll {
  let i = 0;
  return () => values[i++] ?? 0;
}

// ---------------------------------------------------------------------------
// 中性值 —— 全文件最要紧的一条
// ---------------------------------------------------------------------------

test('没附魔的装备在每一个函数上都返回中性值 —— 接线之后全服的普通装备走的就是这条路', () => {
  const sword = plain(SWORD);
  const tool = plain(PICKAXE);
  const bow = plain(BOW);
  const helmet = plain(HELMET);

  for (const kind of [MobKind.NORMAL, MobKind.UNDEAD, MobKind.ARTHROPOD]) {
    assert.equal(meleeBonusDamage(sword, kind), 0, '普通剑不该有近战加成');
  }
  assert.equal(knockbackLevels(sword), 0);
  assert.equal(fireAspectSeconds(sword), 0);
  assert.equal(extraLootRolls(sword, rollNever), 0);

  for (const kind of Object.values(DamageSourceKind)) {
    assert.equal(protectionEpf(helmet, kind), 0);
    assert.equal(damageAfterProtection(10, [helmet, helmet, helmet, helmet], kind), 10,
      '普通盔甲不该改变伤害');
  }
  assert.equal(respirationAirMultiplier(helmet), 1);
  assert.equal(consumesAir(helmet, rollNever), true, '没有呼吸就每 tick 都扣氧气');
  assert.equal(hasAquaAffinity(helmet), false);

  assert.equal(miningSpeedBonus(tool, true), 0);
  assert.equal(hasSilkTouch(tool), false);
  assert.equal(consumesDurability(tool, rollNever), true, '没有耐久附魔就每次都扣耐久');
  assert.equal(consumesArmorDurability(helmet, rollNever), true);
  assert.equal(fortuneMultiplier(tool, rollNever), 1);

  assert.equal(arrowDamageMultiplier(bow), 1);
  assert.equal(punchLevels(bow), 0);
  assert.equal(flameArrowSeconds(bow), 0);
  assert.equal(hasInfinity(bow), false);
});

test('空手与空格子一律按没附魔算 —— 否则清空的格子会把上一把剑的锋利带给拳头', () => {
  const fist = emptyStack();
  assert.equal(meleeBonusDamage(fist, MobKind.UNDEAD), 0);
  assert.equal(miningSpeedBonus(fist, true), 0);

  // count 为 0 但 enchantments 还挂着 —— clearStack 会删，但读档与网络包
  // 解出来的不一定，这一条就是防它
  const ghost: ItemStack = { id: SWORD, count: 0, damage: 0, enchantments: [{ id: Enchantment.SHARPNESS, level: 5 }] };
  assert.equal(meleeBonusDamage(ghost, MobKind.NORMAL), 0, '空格子带着幽灵附魔');
  assert.equal(hasSilkTouch({ ...ghost, enchantments: [{ id: Enchantment.SILK_TOUCH, level: 1 }] }), false);
});

// ---------------------------------------------------------------------------
// 剑
// ---------------------------------------------------------------------------

test('锋利每级 +1.25 —— 用 1.9 的公式的话锋利 V 只加 3 点，玩家挥一下就知道不对', () => {
  assert.equal(meleeBonusDamage(enchanted(SWORD, [Enchantment.SHARPNESS, 1]), MobKind.NORMAL), 1.25);
  assert.equal(meleeBonusDamage(enchanted(SWORD, [Enchantment.SHARPNESS, 5]), MobKind.NORMAL), 6.25);
  // 锋利是无差别的，对亡灵和节肢一样生效
  const sharp5 = enchanted(SWORD, [Enchantment.SHARPNESS, 5]);
  assert.equal(meleeBonusDamage(sharp5, MobKind.UNDEAD), 6.25);
  assert.equal(meleeBonusDamage(sharp5, MobKind.ARTHROPOD), 6.25);
});

test('亡灵杀手打猪一点加成都没有 —— 打错目标就是白花了三十级', () => {
  const smite5 = enchanted(SWORD, [Enchantment.SMITE, 5]);
  assert.equal(meleeBonusDamage(smite5, MobKind.UNDEAD), 12.5);
  assert.equal(meleeBonusDamage(smite5, MobKind.NORMAL), 0, '亡灵杀手加到猪身上了');
  assert.equal(meleeBonusDamage(smite5, MobKind.ARTHROPOD), 0, '亡灵杀手加到蜘蛛身上了');

  const bane1 = enchanted(SWORD, [Enchantment.BANE_OF_ARTHROPODS, 1]);
  assert.equal(meleeBonusDamage(bane1, MobKind.ARTHROPOD), 2.5);
  assert.equal(meleeBonusDamage(bane1, MobKind.UNDEAD), 0, '节肢杀手加到僵尸身上了');
});

test('击退返回的是级数不是别的口径 —— 缩水了的话击退 II 推不下悬崖', () => {
  assert.equal(knockbackLevels(enchanted(SWORD, [Enchantment.KNOCKBACK, 1])), 1);
  assert.equal(knockbackLevels(enchanted(SWORD, [Enchantment.KNOCKBACK, 2])), 2);
});

test('火焰附加的单位是秒不是 tick —— 抄成 tick 的话被点着的猪会烧 80 秒烧到死', () => {
  assert.equal(fireAspectSeconds(enchanted(SWORD, [Enchantment.FIRE_ASPECT, 1])), 4);
  assert.equal(fireAspectSeconds(enchanted(SWORD, [Enchantment.FIRE_ASPECT, 2])), 8);
});

test('抢夺 III 给 0..3 件额外掉落，最差的一次一件都不多给', () => {
  const loot3 = enchanted(SWORD, [Enchantment.LOOTING, 3]);
  assert.equal(extraLootRolls(loot3, rollMin), 0, '抢夺不该保底 +1，刷怪塔产出会直接翻番');
  assert.equal(extraLootRolls(loot3, rollMax), 3);
  assert.equal(extraLootRolls(enchanted(SWORD, [Enchantment.LOOTING, 1]), rollMax), 1);
});

// ---------------------------------------------------------------------------
// 盔甲
// ---------------------------------------------------------------------------

test('单件 EPF 逐条向下取整：保护 IV 是 5 不是 5.5 —— 先加后取整会多出两点', () => {
  assert.equal(protectionEpf(enchanted(HELMET, [Enchantment.PROTECTION, 1]), DamageSourceKind.GENERIC), 1);
  assert.equal(protectionEpf(enchanted(HELMET, [Enchantment.PROTECTION, 4]), DamageSourceKind.GENERIC), 5);
  assert.equal(protectionEpf(enchanted(HELMET, [Enchantment.FIRE_PROTECTION, 4]), DamageSourceKind.FIRE), 9);
  assert.equal(protectionEpf(enchanted(HELMET, [Enchantment.BLAST_PROTECTION, 4]), DamageSourceKind.EXPLOSION), 11);
  assert.equal(
    protectionEpf(enchanted(HELMET, [Enchantment.PROJECTILE_PROTECTION, 4]), DamageSourceKind.PROJECTILE), 11);
  assert.equal(protectionEpf(enchanted(BOOTS, [Enchantment.FEATHER_FALLING, 4]), DamageSourceKind.FALL), 18);
  assert.equal(protectionEpf(enchanted(BOOTS, [Enchantment.FEATHER_FALLING, 1]), DamageSourceKind.FALL), 5);
});

test('每一系保护只吃自己那种伤害，而"保护"是无差别的 —— 认错伤害类型等于附魔白附', () => {
  const fire4 = enchanted(HELMET, [Enchantment.FIRE_PROTECTION, 4]);
  assert.equal(protectionEpf(fire4, DamageSourceKind.GENERIC), 0, '防火挡住了近战');
  assert.equal(protectionEpf(fire4, DamageSourceKind.EXPLOSION), 0);
  const blast4 = enchanted(HELMET, [Enchantment.BLAST_PROTECTION, 4]);
  assert.equal(protectionEpf(blast4, DamageSourceKind.FIRE), 0, '爆炸保护挡住了火');
  assert.equal(protectionEpf(blast4, DamageSourceKind.PROJECTILE), 0, '爆炸保护挡住了箭');
  const ff4 = enchanted(BOOTS, [Enchantment.FEATHER_FALLING, 4]);
  assert.equal(protectionEpf(ff4, DamageSourceKind.GENERIC), 0, '摔落缓冲挡住了近战');

  // 保护对每一种伤害都有效，包括摔落 —— 这一条最容易漏
  const prot4 = enchanted(HELMET, [Enchantment.PROTECTION, 4]);
  for (const kind of Object.values(DamageSourceKind)) {
    assert.equal(protectionEpf(prot4, kind), 5, `保护对 ${kind} 号伤害失效了`);
  }

  // 一件上可以同时有两条，EPF 相加
  const both = enchanted(BOOTS, [Enchantment.PROTECTION, 4], [Enchantment.FEATHER_FALLING, 4]);
  assert.equal(protectionEpf(both, DamageSourceKind.FALL), 23);
  assert.equal(protectionEpf(both, DamageSourceKind.GENERIC), 5);
});

test('整套保护 IV 把 10 点伤害压到 6 —— 这是玩家对"满附魔钻甲"的全部预期', () => {
  const prot4 = enchanted(HELMET, [Enchantment.PROTECTION, 4]);
  // 四件各 5 点 EPF，总 20，折半得 10，减伤 40%
  assert.equal(damageAfterProtection(10, [prot4, prot4, prot4, prot4], DamageSourceKind.GENERIC), 6);
  // 只穿一件：EPF 5，折半得 3，减伤 12%
  assert.equal(damageAfterProtection(10, [prot4], DamageSourceKind.GENERIC), 8.8);
  // 一件不穿
  assert.equal(damageAfterProtection(10, [], DamageSourceKind.GENERIC), 10);
});

test('EPF 先夹到 25：整套防火 IV 的减伤停在 52%，不会因为堆到 36 就接近免疫', () => {
  const fire4 = enchanted(HELMET, [Enchantment.FIRE_PROTECTION, 4]);
  // 四件各 9 = 36，夹到 25，(25+1)>>1 = 13，减伤 13/25 = 52%
  assert.equal(damageAfterProtection(10, [fire4, fire4, fire4, fire4], DamageSourceKind.FIRE), 4.8);
  // 换成火之外的伤害就一点都不减
  assert.equal(damageAfterProtection(10, [fire4, fire4, fire4, fire4], DamageSourceKind.GENERIC), 10);
});

test('摔落缓冲对摔落有效，而护甲点数对摔落无效 —— 这是摔落缓冲唯一的价值', () => {
  const ff4 = enchanted(BOOTS, [Enchantment.FEATHER_FALLING, 4]);
  // 一只靴子就有 18 点 EPF，(18+1)>>1 = 9，减伤 36%
  assert.equal(damageAfterProtection(10, [ff4], DamageSourceKind.FALL), 6.4);
  assert.equal(damageAfterProtection(10, [ff4], DamageSourceKind.GENERIC), 10);
});

test('呼吸 III 把憋气时间拉到四倍 —— 少算一倍玩家会在水下猝死', () => {
  assert.equal(respirationAirMultiplier(enchanted(HELMET, [Enchantment.RESPIRATION, 1])), 2);
  assert.equal(respirationAirMultiplier(enchanted(HELMET, [Enchantment.RESPIRATION, 3])), 4);
});

test('呼吸的判断方向不能反：摇到 0 才扣氧气，摇到非 0 这一 tick 白赚', () => {
  const resp3 = enchanted(HELMET, [Enchantment.RESPIRATION, 3]);
  assert.equal(consumesAir(resp3, rollMin), true, '摇到 0 应该照扣');
  assert.equal(consumesAir(resp3, rollMax), false, '摇到 3 这一 tick 不该扣 —— 反了就是戴上反而淹得更快');
  assert.equal(consumesAir(enchanted(HELMET, [Enchantment.RESPIRATION, 1]), rollAt(1)), false);
});

test('水下速掘是个开关 —— 调用方靠它决定水下那个 /5 要不要生效', () => {
  assert.equal(hasAquaAffinity(enchanted(HELMET, [Enchantment.AQUA_AFFINITY, 1])), true);
  assert.equal(hasAquaAffinity(enchanted(HELMET, [Enchantment.RESPIRATION, 3])), false);
});

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

test('效率是加法：效率 V 加 26，写成乘 26 的话钻石镐一秒挖穿一条矿道', () => {
  assert.equal(miningSpeedBonus(enchanted(PICKAXE, [Enchantment.EFFICIENCY, 1]), true), 2);
  assert.equal(miningSpeedBonus(enchanted(PICKAXE, [Enchantment.EFFICIENCY, 5]), true), 26);
});

test('效率只在工具对口时生效 —— 否则附了效率的镐挖泥土也飞快', () => {
  assert.equal(miningSpeedBonus(enchanted(PICKAXE, [Enchantment.EFFICIENCY, 5]), false), 0);
});

test('精准采集是个开关，别的附魔不能把它顶出来', () => {
  assert.equal(hasSilkTouch(enchanted(PICKAXE, [Enchantment.SILK_TOUCH, 1])), true);
  assert.equal(hasSilkTouch(enchanted(PICKAXE, [Enchantment.FORTUNE, 3])), false);
});

test('耐久 III 只有四分之一的机会扣耐久 —— 判反了的话附魔反而更费工具', () => {
  const unb3 = enchanted(PICKAXE, [Enchantment.UNBREAKING, 3]);
  assert.equal(consumesDurability(unb3, rollMin), true, '摇到 0 才是那四分之一，该扣');
  assert.equal(consumesDurability(unb3, rollAt(3)), false, '摇到 3 该被抵消');
  const unb1 = enchanted(PICKAXE, [Enchantment.UNBREAKING, 1]);
  assert.equal(consumesDurability(unb1, rollMin), true);
  assert.equal(consumesDurability(unb1, rollAt(1)), false);
});

test('盔甲的耐久多一道六成闸门 —— 拿工具那条去套盔甲会让钻甲耐用一倍', () => {
  const unb3 = enchanted(HELMET, [Enchantment.UNBREAKING, 3]);
  // 闸门摇 0（< 3）：六成的情况下附魔根本不生效，直接扣
  assert.equal(consumesArmorDurability(unb3, rollMin), true);
  // 闸门摇 4（≥ 3）过关，再摇 nextInt(4) = 3 → 抵消
  assert.equal(consumesArmorDurability(unb3, rollMax), false);
  // 闸门摇 3 刚好过关，第二次摇 0 → 照扣
  assert.equal(consumesArmorDurability(unb3, scriptedRoll([3, 0])), true);
});

test('时运 III 最多四倍，且五分之一的概率白附 —— 保底 +1 会让钻石产量失真', () => {
  const fort3 = enchanted(PICKAXE, [Enchantment.FORTUNE, 3]);
  assert.equal(fortuneMultiplier(fort3, rollMin), 1, '摇到 0 应该是原样一倍');
  assert.equal(fortuneMultiplier(fort3, rollAt(1)), 1, '摇到 1 也还是一倍');
  assert.equal(fortuneMultiplier(fort3, rollMax), 4, '时运 III 的上限是四倍');
  const fort1 = enchanted(PICKAXE, [Enchantment.FORTUNE, 1]);
  assert.equal(fortuneMultiplier(fort1, rollMin), 1);
  assert.equal(fortuneMultiplier(fort1, rollMax), 2);
});

// ---------------------------------------------------------------------------
// 弓
// ---------------------------------------------------------------------------

test('力量 V 是 1.75 倍 —— 用 1.9 的系数会变成 2.5 倍，弓直接一箭一个', () => {
  assert.equal(arrowDamageMultiplier(enchanted(BOW, [Enchantment.POWER, 1])), 1.25);
  assert.equal(arrowDamageMultiplier(enchanted(BOW, [Enchantment.POWER, 3])), 1.5);
  assert.equal(arrowDamageMultiplier(enchanted(BOW, [Enchantment.POWER, 5])), 1.75);
});

test('冲击返回级数，与近战击退同一套口径', () => {
  assert.equal(punchLevels(enchanted(BOW, [Enchantment.PUNCH, 1])), 1);
  assert.equal(punchLevels(enchanted(BOW, [Enchantment.PUNCH, 2])), 2);
});

test('火矢烧的是 5 秒不是 100 秒 —— 100 是箭自己带火的时间，抄错了羊会烧到死透', () => {
  assert.equal(flameArrowSeconds(enchanted(BOW, [Enchantment.FLAME, 1])), 5);
});

test('无限返回的是"有没有"，普通弓是 false —— 调用方据此决定扣不扣箭', () => {
  assert.equal(hasInfinity(enchanted(BOW, [Enchantment.INFINITY, 1])), true);
  assert.equal(hasInfinity(enchanted(BOW, [Enchantment.POWER, 5])), false);
});
