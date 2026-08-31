/**
 * 附魔与酿造的表和算法。
 *
 * 这两样都是**统计性**的：单跑一次什么都证明不了（"这次出了锋利 I"
 * 既可能是对的也可能是坏了）。所以这里跑几万次看分布 ——
 * "附魔台永远只出保护 I"这类退化只有统计看得出来。
 *
 * 随机源用固定种子的 mulberry32，不用 Math.random：跑出来的分布
 * 必须每次一样，否则测试会时红时绿，而那比没有测试更糟。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '../../src/core/rng/mulberry.ts';
import {
  Enchantment, ENCHANTMENTS, EXCLUSIVE_GROUPS, canApplyTogether, enchantmentById,
} from '../../src/core/item/enchantment.ts';
import {
  enchantmentCosts, rollEnchantments, candidatesFor, levelFor,
  enchantmentPower, MAX_BOOKSHELVES,
} from '../../src/core/craft/enchanting.ts';
import {
  Effect, EFFECTS, brew, readPotion, writePotion, potionPotency,
  BASE_INGREDIENTS, MODIFIERS, CORRUPTION,
  WATER_BOTTLE, AWKWARD_POTION, PotionFlags,
} from '../../src/core/craft/brewing.ts';

// ---------------------------------------------------------------------------
// 附魔表
// ---------------------------------------------------------------------------

test('20 种附魔，id 与 MC 1.0 一致，且不重复', () => {
  assert.equal(ENCHANTMENTS.length, 21, '1.0 一共 21 种（含水下速掘）');
  const ids = ENCHANTMENTS.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'id 有重复');
  // 高 4 位就是装备种类，这是 MC 编号的规律
  assert.equal(Enchantment.PROTECTION, 0);
  assert.equal(Enchantment.SHARPNESS, 16);
  assert.equal(Enchantment.EFFICIENCY, 32);
  assert.equal(Enchantment.POWER, 48);
});

test('最高等级与 MC 一致 —— 玩家对这些数是有记忆的', () => {
  const max = (id: number): number => enchantmentById(id)!.maxLevel;
  assert.equal(max(Enchantment.SHARPNESS), 5);
  assert.equal(max(Enchantment.PROTECTION), 4);
  assert.equal(max(Enchantment.EFFICIENCY), 5);
  assert.equal(max(Enchantment.POWER), 5);
  assert.equal(max(Enchantment.SILK_TOUCH), 1, '精准采集只有 I');
  assert.equal(max(Enchantment.INFINITY), 1, '无限只有 I');
  assert.equal(max(Enchantment.KNOCKBACK), 2);
  assert.equal(max(Enchantment.FIRE_ASPECT), 2);
});

test('稀有的附魔权重更低', () => {
  const w = (id: number): number => enchantmentById(id)!.weight;
  assert.ok(w(Enchantment.SHARPNESS) > w(Enchantment.FIRE_ASPECT), '锋利该比火焰附加常见');
  assert.ok(w(Enchantment.FIRE_ASPECT) > w(Enchantment.SILK_TOUCH), '精准采集该是最稀有的一档');
  assert.equal(w(Enchantment.SILK_TOUCH), 1);
  assert.equal(w(Enchantment.INFINITY), 1);
});

test('互斥关系成立且对称', () => {
  assert.equal(canApplyTogether(Enchantment.SHARPNESS, Enchantment.SMITE), false);
  assert.equal(canApplyTogether(Enchantment.SILK_TOUCH, Enchantment.FORTUNE), false);
  assert.equal(canApplyTogether(Enchantment.PROTECTION, Enchantment.BLAST_PROTECTION), false);
  // 不同类的可以共存
  assert.equal(canApplyTogether(Enchantment.SHARPNESS, Enchantment.KNOCKBACK), true);
  assert.equal(canApplyTogether(Enchantment.EFFICIENCY, Enchantment.UNBREAKING), true);
  // 自己和自己不算"可以同时存在"
  assert.equal(canApplyTogether(Enchantment.SHARPNESS, Enchantment.SHARPNESS), false);
  for (const g of EXCLUSIVE_GROUPS) {
    for (const a of g) {
      for (const b of g) {
        assert.equal(canApplyTogether(a, b), canApplyTogether(b, a), '互斥必须对称');
      }
    }
  }
});

test('附魔性修正值单调不减 —— 高级附魔必须更难出', () => {
  for (const e of ENCHANTMENTS) {
    for (let l = 2; l <= e.maxLevel; l++) {
      assert.ok(e.minEnchantability(l) >= e.minEnchantability(l - 1),
        `${e.name} 的 ${l} 级门槛比 ${l - 1} 级还低`);
    }
  }
});

// ---------------------------------------------------------------------------
// 附魔台
// ---------------------------------------------------------------------------

test('三个槽的报价递增，且第一槽至少 1 级', () => {
  const rand = mulberry32(9);
  for (let i = 0; i < 2000; i++) {
    const shelves = i % (MAX_BOOKSHELVES + 1);
    const [a, b, c] = enchantmentCosts(rand, shelves);
    assert.ok(a >= 1, `第一槽给了 ${a} 级`);
    assert.ok(a <= b && b <= c, `报价没递增：${a}/${b}/${c}`);
  }
});

test('书架搭满时第三槽保底 30 级 —— 这是搭满书架的全部意义', () => {
  const rand = mulberry32(11);
  let min = Infinity;
  for (let i = 0; i < 5000; i++) {
    min = Math.min(min, enchantmentCosts(rand, MAX_BOOKSHELVES)[2]);
  }
  assert.equal(min, 30, `搭满书架时第三槽最低只有 ${min} 级`);
});

test('书架越多报价越高', () => {
  const avg = (shelves: number): number => {
    const rand = mulberry32(13);
    let sum = 0;
    for (let i = 0; i < 5000; i++) sum += enchantmentCosts(rand, shelves)[2];
    return sum / 5000;
  };
  const a = avg(0);
  const b = avg(7);
  const c = avg(15);
  assert.ok(a < b && b < c, `报价没随书架涨：${a.toFixed(1)}/${b.toFixed(1)}/${c.toFixed(1)}`);
});

test('超出 0..15 的书架数被夹住 —— 摆 100 个书架不该出天价', () => {
  const rand = mulberry32(17);
  for (let i = 0; i < 500; i++) {
    assert.ok(enchantmentCosts(rand, 100)[2] <= 60);
    assert.ok(enchantmentCosts(rand, -5)[0] >= 1);
  }
});

test('30 级能出到锋利 V，1 级出不了', () => {
  const rand = mulberry32(19);
  let sawV = false;
  for (let i = 0; i < 4000 && !sawV; i++) {
    for (const e of rollEnchantments(rand, 30, 'sword', 10)) {
      if (e.id === Enchantment.SHARPNESS && e.level === 5) sawV = true;
    }
  }
  assert.ok(sawV, '30 级附魔四千次都没出过锋利 V');

  const low = mulberry32(23);
  for (let i = 0; i < 2000; i++) {
    for (const e of rollEnchantments(low, 1, 'sword', 10)) {
      assert.ok(e.level <= 2, `1 级附魔出了 ${e.level} 级的东西`);
    }
  }
});

test('高级附魔常常给出多条，低级几乎总是一条', () => {
  // 只出一条是很多复刻的通病：抽取写了，"追加"那一步漏了
  const count = (cost: number, seed: number): number[] => {
    const rand = mulberry32(seed);
    const hist = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 4000; i++) {
      const n = Math.min(5, rollEnchantments(rand, cost, 'sword', 10).length);
      hist[n]!++;
    }
    return hist;
  };
  const high = count(30, 29);
  const low = count(2, 31);
  const multiHigh = high.slice(2).reduce((a, b) => a + b, 0) / 4000;
  const multiLow = low.slice(2).reduce((a, b) => a + b, 0) / 4000;
  assert.ok(multiHigh > 0.25, `30 级只有 ${(multiHigh * 100).toFixed(1)}% 出多条`);
  assert.ok(multiLow < 0.05, `2 级居然有 ${(multiLow * 100).toFixed(1)}% 出多条`);
});

test('一套附魔里没有互斥的两条', () => {
  const rand = mulberry32(37);
  for (let i = 0; i < 5000; i++) {
    const set = rollEnchantments(rand, 25, 'sword', 22);
    for (let a = 0; a < set.length; a++) {
      for (let b = a + 1; b < set.length; b++) {
        assert.ok(canApplyTogether(set[a]!.id, set[b]!.id),
          `同时出了互斥的 ${set[a]!.id} 与 ${set[b]!.id}`);
      }
    }
  }
});

test('装备种类决定候选：剑不会附上效率，靴子不会附上呼吸', () => {
  for (const power of [5, 15, 30, 50]) {
    for (const c of candidatesFor('sword', power)) {
      assert.ok(c.id >= 16 && c.id <= 21, `剑上出现了 ${c.id}`);
    }
    for (const c of candidatesFor('bow', power)) {
      assert.ok(c.id >= 48, `弓上出现了 ${c.id}`);
    }
    // 头盔既能附护甲通用的，也能附呼吸；靴子不能附呼吸
    const head = candidatesFor('armor_head', power).map((c) => c.id);
    const feet = candidatesFor('armor_feet', power).map((c) => c.id);
    assert.ok(!feet.includes(Enchantment.RESPIRATION), '靴子附上了呼吸');
    assert.ok(!head.includes(Enchantment.FEATHER_FALLING), '头盔附上了摔落缓冲');
  }
});

test('金的附魔性最高，出的东西更好 —— MC 著名的反直觉设定', () => {
  const avgLevel = (ench: number): number => {
    const rand = mulberry32(41);
    let sum = 0;
    for (let i = 0; i < 4000; i++) sum += enchantmentPower(rand, 15, ench);
    return sum / 4000;
  };
  assert.ok(avgLevel(22) > avgLevel(10), '金(22)该比钻石(10)出得好');
  assert.ok(avgLevel(10) > avgLevel(5), '钻石(10)该比石头(5)出得好');
});

test('levelFor 在区间外返回 0', () => {
  const sharp = enchantmentById(Enchantment.SHARPNESS)!;
  assert.equal(levelFor(sharp, 0), 0);
  assert.ok(levelFor(sharp, 20) >= 1);
});

// ---------------------------------------------------------------------------
// 酿造
// ---------------------------------------------------------------------------

test('下界疣是所有药水的第一步，且只对水瓶有效', () => {
  assert.equal(brew(WATER_BOTTLE, MODIFIERS.NETHER_WART), AWKWARD_POTION);
  // 已经是粗制的药水了，再加一次没用
  assert.equal(brew(AWKWARD_POTION, MODIFIERS.NETHER_WART), null);
  // 主料必须在下界疣之后
  for (const ing of Object.keys(BASE_INGREDIENTS)) {
    assert.equal(brew(WATER_BOTTLE, ing), null, `${ing} 直接加进水瓶居然成了`);
  }
});

test('六种主料各出一种效果', () => {
  const got = new Map<number, string>();
  for (const [ing, effect] of Object.entries(BASE_INGREDIENTS)) {
    const d = brew(AWKWARD_POTION, ing);
    assert.notEqual(d, null, `${ing} 酿不出东西`);
    const p = readPotion(d!);
    assert.equal(p.effect, effect, `${ing} 出的效果不对`);
    assert.equal(p.awkward, false, '出了效果之后不该还带着粗制标志');
    assert.ok(!got.has(effect), `${ing} 和 ${got.get(effect)} 出了同一种效果`);
    got.set(effect, ing);
  }
  assert.equal(got.size, 6, '1.0 应该有六种基础药水');
});

test('萤石增强、红石延长，两者互斥', () => {
  const speed = brew(AWKWARD_POTION, 'sugar')!;
  const up = brew(speed, MODIFIERS.GLOWSTONE_DUST)!;
  assert.equal(readPotion(up).upgraded, true);
  assert.equal(readPotion(up).extended, false);
  // 已经增强了就不能再增强
  assert.equal(brew(up, MODIFIERS.GLOWSTONE_DUST), null);
  // 增强的再加红石会**换成**延长，不是叠加
  const ext = brew(up, MODIFIERS.REDSTONE)!;
  assert.equal(readPotion(ext).extended, true);
  assert.equal(readPotion(ext).upgraded, false, '增强和延长同时成立了');
});

test('瞬间药水不能延长', () => {
  const healing = brew(AWKWARD_POTION, 'glistering_melon')!;
  assert.equal(EFFECTS[Effect.HEALING]!.durationTicks, 0);
  assert.equal(brew(healing, MODIFIERS.REDSTONE), null, '治疗药水居然能延长');
  // 但可以增强
  assert.notEqual(brew(healing, MODIFIERS.GLOWSTONE_DUST), null);
});

test('发酵蛛眼反转效果，并清掉增强与延长', () => {
  const speed = brew(AWKWARD_POTION, 'sugar')!;
  const fast = brew(speed, MODIFIERS.GLOWSTONE_DUST)!;
  const slow = brew(fast, MODIFIERS.FERMENTED_SPIDER_EYE)!;
  const p = readPotion(slow);
  assert.equal(p.effect, Effect.SLOWNESS);
  assert.equal(p.upgraded, false, '反转之后还留着增强 —— 那太便宜了');
  assert.equal(p.extended, false);
});

test('反转表是对合的（转两次回到原点）', () => {
  for (const [from, to] of Object.entries(CORRUPTION)) {
    const back = CORRUPTION[to];
    if (back === undefined) continue;
    assert.equal(back, Number(from), `${from} -> ${to} -> ${back}，转两次没回来`);
  }
});

test('火药变投掷型，且只能变一次', () => {
  const poison = brew(AWKWARD_POTION, 'spider_eye')!;
  const splash = brew(poison, MODIFIERS.GUNPOWDER)!;
  assert.equal(readPotion(splash).splash, true);
  assert.equal(readPotion(splash).effect, Effect.POISON, '变投掷型不该改效果');
  assert.equal(brew(splash, MODIFIERS.GUNPOWDER), null);
});

test('水瓶加辅料什么都酿不出来', () => {
  for (const m of Object.values(MODIFIERS)) {
    if (m === MODIFIERS.NETHER_WART) continue;
    assert.equal(brew(WATER_BOTTLE, m), null, `水瓶 + ${m} 居然成了`);
  }
});

test('damage 编码来回一致', () => {
  for (const effect of Object.values(Effect)) {
    for (const upgraded of [false, true]) {
      for (const extended of [false, true]) {
        for (const splash of [false, true]) {
          const p = { effect, upgraded, extended, splash, awkward: false };
          assert.deepEqual(readPotion(writePotion(p)), p);
        }
      }
    }
  }
  // 效果 id 必须放得进低 4 位，否则编码会串
  for (const e of Object.values(Effect)) {
    assert.ok(e <= PotionFlags.EFFECT_MASK, `效果 id ${e} 放不进 4 位`);
  }
});

test('增强会缩短时长，延长会加长，投掷型打折', () => {
  const speed = brew(AWKWARD_POTION, 'sugar')!;
  const base = potionPotency(speed).durationTicks;
  const up = potionPotency(brew(speed, MODIFIERS.GLOWSTONE_DUST)!);
  const ext = potionPotency(brew(speed, MODIFIERS.REDSTONE)!);
  assert.ok(up.durationTicks < base, '增强没有代价，那增强就是白拿的');
  assert.equal(up.amplifier, 1, '增强了强度却没涨');
  assert.ok(ext.durationTicks > base);
  const splash = potionPotency(brew(speed, MODIFIERS.GUNPOWDER)!);
  assert.ok(splash.durationTicks < base, '投掷型该打折');
});

test('每种效果都标了有益/有害，且有害的都能被反转到有益', () => {
  for (const def of Object.values(EFFECTS)) {
    assert.equal(typeof def.harmful, 'boolean');
    assert.ok(def.durationTicks >= 0);
  }
  assert.equal(EFFECTS[Effect.POISON]!.harmful, true);
  assert.equal(EFFECTS[Effect.HEALING]!.harmful, false);
});
