/**
 * 合成表验收。
 *
 * 核心不是"抽查几条"，而是**把每一条配方都真的合一次**：
 * 按配方自己的形状摆进网格，看能不能合出它自己。这能一次抓住
 * 形状写错、材料写错、结果写错、以及"两条配方互相遮挡"这四类问题。
 *
 * 另外单独验平移与镜像 —— 这两件事漏掉之后表现极像"配方写错了"：
 * 玩家把木镐摆在 3×3 的右下角就合不出来，或者惯用左手的摆法失效。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCraftingData } from '../../src/content/recipes.ts';
import { createBlockRegistry, Blocks } from '../../src/content/blocks.ts';
import { createItemRegistry, Items } from '../../src/content/items.ts';
import { findRecipe, matches, shaped, type CraftGrid, type Recipe } from '../../src/core/craft/recipe.ts';
import { emptyStack, makeStack, type ItemStack } from '../../src/core/item/item-def.ts';

const data = createCraftingData();
const blocks = createBlockRegistry();
const items = createItemRegistry();
const B = (n: string): number => blocks.idOf(n);
const I = (n: string): number => items.idOf(n);

/** 造一个空的 n×n 网格 */
function grid(size: number): { g: CraftGrid; put: (x: number, y: number, id: number) => void } {
  const slots: ItemStack[] = Array.from({ length: size * size }, () => emptyStack());
  return {
    g: { size, slots },
    put: (x, y, id) => { slots[y * size + x] = makeStack(id, 1); },
  };
}

/** 把一条配方按它自己的形状摆进网格，偏移 (ox, oy) */
function layout(recipe: Recipe, size: number, ox = 0, oy = 0): CraftGrid {
  const { g, put } = grid(size);
  if (recipe.kind === 'shaped') {
    for (let y = 0; y < recipe.height; y++) {
      for (let x = 0; x < recipe.width; x++) {
        const id = recipe.pattern[y * recipe.width + x]!;
        if (id !== 0) put(x + ox, y + oy, id);
      }
    }
  } else {
    recipe.ingredients.forEach((id, i) => put((i + ox) % size, Math.floor(i / size) + oy, id));
  }
  return g;
}

test('配方总数达标：≥120 条合成 + 熔炼', () => {
  assert.ok(data.recipes.length >= 120, `只有 ${data.recipes.length} 条合成配方，标准是 ≥120`);
  assert.ok(data.smelting.length >= 10, `只有 ${data.smelting.length} 条熔炼配方`);
});

test('每一条配方都能合出它自己 —— 逐条验证', () => {
  const failed: string[] = [];
  for (const r of data.recipes) {
    // 3×3 放得下全部配方
    const g = layout(r, 3);
    const result = findRecipe(data.recipes, g);
    if (result === null) {
      failed.push(`${describe(r)} 摆出来合不出任何东西`);
    } else if (result.id !== r.resultId || result.count !== r.resultCount) {
      failed.push(
        `${describe(r)} 合出了 ${nameOf(result.id)}×${result.count}，` +
        `期望 ${nameOf(r.resultId)}×${r.resultCount}`,
      );
    }
  }
  assert.deepEqual(failed, [], `${failed.length} 条配方对不上：\n${failed.slice(0, 12).join('\n')}`);
});

test('有形配方在网格里平移之后仍然成立', () => {
  const shapedOnes = data.recipes.filter((r): r is Extract<Recipe, { kind: 'shaped' }> => r.kind === 'shaped');
  let checked = 0;
  const failed: string[] = [];
  for (const r of shapedOnes) {
    // 能往右下角挪多少就挪多少
    const ox = 3 - r.width;
    const oy = 3 - r.height;
    if (ox === 0 && oy === 0) continue;
    const result = findRecipe(data.recipes, layout(r, 3, ox, oy));
    if (result === null || result.id !== r.resultId) {
      failed.push(`${describe(r)} 挪到 (${ox},${oy}) 之后合不出来`);
    }
    checked++;
  }
  assert.deepEqual(failed, [], failed.slice(0, 8).join('\n'));
  assert.ok(checked > 40, `只验了 ${checked} 条平移`);
});

test('允许镜像的配方左右翻转后仍然成立', () => {
  const failed: string[] = [];
  let checked = 0;
  for (const r of data.recipes) {
    if (r.kind !== 'shaped' || !r.mirror) continue;
    // 手工把图样左右翻转再摆进去
    const { g, put } = grid(3);
    for (let y = 0; y < r.height; y++) {
      for (let x = 0; x < r.width; x++) {
        const id = r.pattern[y * r.width + (r.width - 1 - x)]!;
        if (id !== 0) put(x, y, id);
      }
    }
    const result = findRecipe(data.recipes, g);
    if (result === null || result.id !== r.resultId) {
      failed.push(`${describe(r)} 镜像之后合不出来`);
    }
    checked++;
  }
  assert.deepEqual(failed, [], failed.slice(0, 8).join('\n'));
  assert.ok(checked > 50, `只验了 ${checked} 条镜像`);
});

test('2×2 网格只能合小配方 —— 工作台的存在有意义', () => {
  const planks = B(Blocks.PLANKS);
  const { g, put } = grid(2);
  put(0, 0, planks);
  put(1, 0, planks);
  put(0, 1, planks);
  put(1, 1, planks);
  const table = findRecipe(data.recipes, g);
  assert.ok(table !== null && table.id === B(Blocks.CRAFTING_TABLE), '2×2 应能合工作台');

  // 木镐要 3×3，2×2 里无论如何摆不出来
  const pick = data.recipes.find((r) => r.kind === 'shaped' && r.resultId === I(Items.WOODEN_PICKAXE));
  assert.ok(pick !== undefined);
  assert.equal(matches(pick, g), false);
});

test('多余的材料会让配方不成立 —— 不能"顺手多放一块"', () => {
  const planks = B(Blocks.PLANKS);
  const { g, put } = grid(3);
  put(0, 0, planks);
  put(1, 0, planks);
  put(0, 1, planks);
  put(1, 1, planks);
  assert.ok(findRecipe(data.recipes, g) !== null, '正常的 2×2 木板应能合工作台');
  put(2, 2, planks); // 角落多放一块
  const r = findRecipe(data.recipes, g);
  assert.ok(r === null || r.id !== B(Blocks.CRAFTING_TABLE), '多一块木板不该还能合工作台');
});

test('无形配方不看位置', () => {
  const log = B(Blocks.LOG);
  for (const [x, y] of [[0, 0], [2, 2], [1, 0], [0, 2]] as const) {
    const { g, put } = grid(3);
    put(x, y, log);
    const r = findRecipe(data.recipes, g);
    assert.ok(r !== null && r.id === B(Blocks.PLANKS) && r.count === 4,
      `原木放在 (${x},${y}) 应该都能合出 4 块木板`);
  }
});

test('工具与盔甲齐全：5 套工具 × 5 件 + 4 套盔甲 × 4 件', () => {
  for (const mat of ['wooden', 'stone', 'iron', 'golden', 'diamond']) {
    for (const kind of ['sword', 'pickaxe', 'axe', 'shovel', 'hoe']) {
      const id = I(`${mat}_${kind}`);
      const found = data.recipes.some((r) => r.resultId === id);
      assert.ok(found, `缺少 ${mat}_${kind} 的配方`);
    }
  }
  for (const mat of ['leather', 'iron', 'golden', 'diamond']) {
    for (const piece of ['helmet', 'chestplate', 'leggings', 'boots']) {
      const id = I(`${mat}_${piece}`);
      assert.ok(data.recipes.some((r) => r.resultId === id), `缺少 ${mat}_${piece} 的配方`);
    }
  }
});

test('几条招牌配方的形状与 MC 一致', () => {
  const check = (rows: string[], key: Record<string, number>, expectId: number, expectCount = 1): void => {
    const probe = shaped(rows, key, expectId, expectCount);
    const r = findRecipe(data.recipes, layout(probe, 3));
    assert.ok(r !== null, `${nameOf(expectId)} 的形状 ${JSON.stringify(rows)} 合不出来`);
    assert.equal(r.id, expectId, `${JSON.stringify(rows)} 合出了 ${nameOf(r.id)}`);
    assert.equal(r.count, expectCount, `${nameOf(expectId)} 的产量`);
  };
  const P = B(Blocks.PLANKS);
  const S = I(Items.STICK);
  const C = B(Blocks.COBBLESTONE);
  const G = I(Items.GUNPOWDER);
  const SAND = B(Blocks.SAND);

  check(['P', 'P'], { P }, S, 4);
  check(['PP', 'PP'], { P }, B(Blocks.CRAFTING_TABLE));
  check(['CCC', ' S ', ' S '], { C, S }, I(Items.STONE_PICKAXE));
  check(['CCC', 'C C', 'CCC'], { C }, B(Blocks.FURNACE));
  check(['PPP', 'P P', 'PPP'], { P }, B(Blocks.CHEST));
  // TNT 是火药与沙**交错**，不是八块火药围一块沙
  check(['GSG', 'SGS', 'GSG'], { G, S: SAND }, B(Blocks.TNT));
  check(['S S', 'SSS', 'S S'], { S }, B(Blocks.LADDER), 3);
});

test('熔炼表覆盖冶炼与烹饪', () => {
  const inputs = new Set(data.smelting.map((s) => s.input));
  assert.ok(inputs.has(B(Blocks.IRON_ORE)), '铁矿');
  assert.ok(inputs.has(B(Blocks.GOLD_ORE)), '金矿');
  assert.ok(inputs.has(B(Blocks.SAND)), '沙 -> 玻璃');
  assert.ok(inputs.has(B(Blocks.COBBLESTONE)), '圆石 -> 石头');
  assert.ok(inputs.has(B(Blocks.LOG)), '原木 -> 木炭');
  assert.ok(inputs.has(I(Items.PORKCHOP)), '生猪排');
  // 熔炼产物不能指向不存在的东西
  for (const s of data.smelting) {
    assert.ok(nameOf(s.outputId) !== '?', `熔炼产物 ${s.outputId} 不认识`);
  }
});

test('没有两条配方产出同一个东西却形状相同', () => {
  // 形状完全相同的两条配方意味着后一条永远匹配不到，是纯粹的死配方
  const seen = new Map<string, number>();
  const dup: string[] = [];
  for (const r of data.recipes) {
    const key = r.kind === 'shaped'
      ? `s|${r.width}x${r.height}|${r.pattern.join(',')}`
      : `l|${[...r.ingredients].sort((a, b) => a - b).join(',')}`;
    const prev = seen.get(key);
    if (prev !== undefined) dup.push(`${nameOf(prev)} 与 ${nameOf(r.resultId)} 形状完全相同`);
    seen.set(key, r.resultId);
  }
  assert.deepEqual(dup, [], dup.join('\n'));
});

function nameOf(id: number): string {
  return blocks.get(id)?.name ?? items.get(id)?.name ?? '?';
}

function describe(r: Recipe): string {
  return `[${nameOf(r.resultId)}]`;
}
