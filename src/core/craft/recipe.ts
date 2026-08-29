/**
 * 合成配方的匹配。
 *
 * 两种配方：
 *   **有形**（shaped）  形状要对上，但允许在网格里**平移**，也允许**左右镜像**
 *   **无形**（shapeless）只看материа清单，摆哪儿都行
 *
 * 平移与镜像是最容易漏的两件事，而漏了之后表现极其像"配方写错了"：
 * 玩家把木镐的形状摆在 3×3 的右下角就合不出来，或者惯用左手的摆法失效。
 * MC 两者都支持，这里也必须支持，并且**逐条**用测试锁住。
 *
 * 匹配只认 id，不认 damage —— 1.0 里没有"用不同颜色羊毛合成"的配方，
 * 而工具的耐久显然不该影响它能不能当材料。
 */
import { isEmpty, type ItemStack } from '../item/item-def.ts';

/** 配方网格里的一格：物品 id，0 表示必须为空 */
export type Ingredient = number;

export interface ShapedRecipe {
  readonly kind: 'shaped';
  readonly width: number;
  readonly height: number;
  /** width × height，按行优先。0 = 该格必须空着 */
  readonly pattern: readonly Ingredient[];
  readonly resultId: number;
  readonly resultCount: number;
  readonly resultDamage: number;
  /** 有些配方是对称的，镜像匹配没意义但也无害；显式关掉可省一半比较 */
  readonly mirror: boolean;
}

export interface ShapelessRecipe {
  readonly kind: 'shapeless';
  /** 材料清单，顺序无关 */
  readonly ingredients: readonly Ingredient[];
  readonly resultId: number;
  readonly resultCount: number;
  readonly resultDamage: number;
}

export type Recipe = ShapedRecipe | ShapelessRecipe;

export interface RecipeResult {
  id: number;
  count: number;
  damage: number;
}

/**
 * 一个合成网格。2×2（背包）或 3×3（工作台）。
 * slots 长度必须是 size × size。
 */
export interface CraftGrid {
  readonly size: number;
  readonly slots: readonly ItemStack[];
}

/** 网格里实际有东西的最小包围盒 */
function boundsOf(grid: CraftGrid): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = grid.size;
  let y0 = grid.size;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < grid.size; y++) {
    for (let x = 0; x < grid.size; x++) {
      if (isEmpty(grid.slots[y * grid.size + x]!)) continue;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/**
 * 有形配方匹配。
 *
 * 先把网格里的内容**归一化到左上角**（这就是"平移无关"），再逐格比对；
 * 不匹配就把配方左右翻转再比一次（这就是"镜像无关"）。
 */
function matchShaped(recipe: ShapedRecipe, grid: CraftGrid): boolean {
  const b = boundsOf(grid);
  if (b === null) return false;
  const w = b.x1 - b.x0 + 1;
  const h = b.y1 - b.y0 + 1;
  if (w !== recipe.width || h !== recipe.height) return false;

  const compare = (mirrored: boolean): boolean => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = mirrored ? w - 1 - x : x;
        const want = recipe.pattern[y * recipe.width + px]!;
        const have = grid.slots[(b.y0 + y) * grid.size + (b.x0 + x)]!;
        if (want === 0) {
          if (!isEmpty(have)) return false;
        } else {
          if (isEmpty(have) || have.id !== want) return false;
        }
      }
    }
    return true;
  };

  if (compare(false)) return true;
  return recipe.mirror && compare(true);
}

/** 无形配方匹配：清单相同即可，顺序与位置无关 */
function matchShapeless(recipe: ShapelessRecipe, grid: CraftGrid): boolean {
  const need = [...recipe.ingredients];
  let found = 0;
  for (const slot of grid.slots) {
    if (isEmpty(slot)) continue;
    const i = need.indexOf(slot.id);
    if (i < 0) return false; // 有多余的材料
    need.splice(i, 1);
    found++;
  }
  return need.length === 0 && found === recipe.ingredients.length;
}

export function matches(recipe: Recipe, grid: CraftGrid): boolean {
  return recipe.kind === 'shaped' ? matchShaped(recipe, grid) : matchShapeless(recipe, grid);
}

/**
 * 在配方表里找第一个匹配的。
 *
 * 顺序敏感：更"具体"的配方必须排在更宽松的前面。目前只有一处会撞 ——
 * 无形的"任意木头 -> 木板"和其它单格配方 —— 内容表里已经排好序。
 */
export function findRecipe(recipes: readonly Recipe[], grid: CraftGrid): RecipeResult | null {
  for (const r of recipes) {
    if (!matches(r, grid)) continue;
    return { id: r.resultId, count: r.resultCount, damage: r.resultDamage };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 定义配方时用的小工具
// ---------------------------------------------------------------------------

/**
 * 用字符画定义有形配方。
 *
 * ```
 * shaped(['##', '# ', '# '], { '#': PLANKS }, DOOR, 1)
 * ```
 * 空格表示该格必须空着。行宽必须一致。
 */
export function shaped(
  rows: readonly string[],
  key: Record<string, number>,
  resultId: number,
  resultCount = 1,
  opts: { mirror?: boolean; resultDamage?: number } = {},
): ShapedRecipe {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  for (const r of rows) {
    if (r.length !== width) throw new Error(`配方各行宽度不一致：${JSON.stringify(rows)}`);
  }
  const pattern: number[] = [];
  for (const row of rows) {
    for (const ch of row) {
      if (ch === ' ') { pattern.push(0); continue; }
      const id = key[ch];
      if (id === undefined) throw new Error(`配方里的 '${ch}' 没有在 key 里定义`);
      pattern.push(id);
    }
  }
  return {
    kind: 'shaped', width, height, pattern,
    resultId, resultCount, resultDamage: opts.resultDamage ?? 0,
    mirror: opts.mirror ?? true,
  };
}

export function shapeless(
  ingredients: readonly number[],
  resultId: number,
  resultCount = 1,
  resultDamage = 0,
): ShapelessRecipe {
  return { kind: 'shapeless', ingredients, resultId, resultCount, resultDamage };
}
