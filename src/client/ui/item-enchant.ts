/**
 * 附魔在客户端的**表现层数据**：摘要怎么解、叫什么名字、写成哪几行字。
 *
 * 和画法分开（画在 `item-glint.ts` 与 `item-tooltip.ts`）：这里全是纯函数，
 * 能在 node 里直接断言。"紫色够不够紫"测不了也不该测，但"锋利 V 有没有
 * 写成 Sharpness V"、"三条附魔会不会被编成三个名字"是能测的。
 *
 * ## 服务端只发摘要，这不是 bug
 *
 * `server/player/inventory-actions.ts` 的 `syncInventory` 每格只发一个 int32：
 *
 *     低 8 位  = 一共几条
 *     次 8 位  = **第一条**的附魔 id
 *     再 8 位  = **第一条**的等级
 *
 * 所以客户端**永远不知道**第二条及以后是什么 —— 协议里就没发。界面上只能写
 * "一共几条"，不能编出名字来。下一个人：别把这当成没实现完的功能去"补"，
 * 那边的注释解释了为什么只发摘要（槽位定长、每次同步都要发）。
 *
 * ## 名字为什么是英文
 *
 * 游戏内 UI 一律英文（docs/DEVIATIONS.md），而且 `font.ts` 的点阵字模只有
 * ASCII —— 塞中文进去画出来是一串 `?`。名字直接取 core 那张附魔表里的
 * `name`（`sharpness`）再转成标题式（`Sharpness`），不另抄一张表：
 * 抄一张就会有两份真相，而它们迟早不一样。
 */
import { enchantmentById } from '../../core/item/enchantment.ts';
import type { ItemStack } from '../../core/item/item-def.ts';
import { createItemRegistry } from '../../content/items.ts';

/** 一格物品身上那点附魔信息 —— 服务端发得出来的全部 */
export interface EnchantSummary {
  /** 一共几条。除此之外，其余各条是什么**客户端不知道** */
  readonly total: number;
  /** 第一条的附魔 id */
  readonly id: number;
  /** 第一条的等级 */
  readonly level: number;
}

/**
 * 解开一格的附魔摘要。没附魔（服务端发 0）返回 null。
 *
 * 用 `>>>` 而不是 `>>`：摘要最高只用到第 23 位，两者结果一样，
 * 但无符号右移在"万一某天有人往高位塞东西"时不会突然变成负数。
 */
export function decodeEnchantSummary(word: number): EnchantSummary | null {
  if (word === 0) return null;
  const total = word & 0xff;
  // 条数是 0 却又非 0 的摘要是不该出现的组合，当成没附魔处理 ——
  // 与其画一个"零条附魔"的光效，不如什么都不画
  if (total === 0) return null;
  return { total, id: (word >>> 8) & 0xff, level: (word >>> 16) & 0xff };
}

/**
 * 槽位对象 -> 附魔摘要的旁挂表。
 *
 * 为什么不塞进 `ItemStack`：`ItemStack.enchantments` 是 core 的类型，一条只有
 * `{ id, level }`，装不下"一共几条"这个数；而把数组补足到 total 条假条目，
 * 会让"第二条是什么"看起来有答案 —— 协议里根本没发过。
 *
 * 键就是 `decodeSlots` 造出来的那些对象本身。每次同步换一整批新对象，
 * 旧的没人引用了就被回收，不需要任何清理逻辑。
 */
const SUMMARIES = new WeakMap<ItemStack, EnchantSummary>();

export function rememberEnchantSummary(stack: ItemStack, summary: EnchantSummary): void {
  SUMMARIES.set(stack, summary);
}

/** 这一格附过魔吗。没有返回 null —— 光效与提示条都从这里出发 */
export function enchantSummaryOf(stack: ItemStack): EnchantSummary | null {
  return SUMMARIES.get(stack) ?? null;
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V'];

/**
 * 附魔等级的罗马数字。
 *
 * 只做 I..V：1.0 的附魔等级上限就是 V（锋利/效率/力量），再往上没有。
 * 越界时退回十进制 —— 与其画一个错的罗马数字，不如显示一个能和数据对上的数。
 */
export function romanLevel(level: number): string {
  return ROMAN[level - 1] ?? String(level);
}

/** 这些词在标题式里保持小写。MC 写的是 "Bane of Arthropods"，不是 "Bane Of" */
const LOWER_WORDS = new Set(['of', 'and', 'the']);

/** `bane_of_arthropods` -> `Bane of Arthropods` */
export function titleCase(name: string): string {
  return name.split('_').map((w, i) => (
    i > 0 && LOWER_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)
  )).join(' ');
}

/** 附魔的显示名。id 不认识时退回 `Enchantment <id>`，好歹能对着排查 */
export function enchantDisplayName(id: number): string {
  const def = enchantmentById(id);
  return def === null ? `Enchantment ${id}` : titleCase(def.name);
}

/**
 * 物品名表，第一次要用时才建。
 *
 * 客户端本来就有一份物品表，但它在 `entry/client-main.ts` 里，而递给界面的
 * `DrawContext` 只有 `iconLayer` 与 `maxStack`，没有名字。往 DrawContext 里加
 * 一项要动 entry，不在这次的范围内，所以这里自己建一份 —— 只在玩家第一次
 * 把鼠标停在附了魔的东西上时建一次，之后一直复用。
 *
 * 只查物品表不查方块表：能附魔的只有剑、工具、弓、盔甲，全是 id ≥ 256 的
 * 真物品，方块永远进不了这个函数。
 */
let names: Map<number, string> | null = null;

export function itemDisplayName(id: number): string {
  if (names === null) {
    names = new Map<number, string>();
    for (const def of createItemRegistry().all()) names.set(def.id, titleCase(def.name));
  }
  return names.get(id) ?? `#${id}`;
}

/** 提示条的文字：一行标题 + 若干行说明 */
export interface TooltipText {
  readonly title: string;
  readonly lines: readonly string[];
}

/**
 * 附了魔的物品悬停时显示什么。没附魔返回 null（不画提示条）。
 *
 * 多于一条时只报**总数**，不写第二条叫什么 —— 服务端没发（见文件顶部）。
 * 写成 "3 Enchantments" 而不是列三行，正是为了让玩家一眼看出
 * "还有别的，只是这儿显示不了"，而不是以为这件东西只有一条。
 */
export function enchantTooltipFor(stack: ItemStack): TooltipText | null {
  const s = enchantSummaryOf(stack);
  if (s === null) return null;
  const lines = [`${enchantDisplayName(s.id)} ${romanLevel(s.level)}`];
  if (s.total > 1) lines.push(`${s.total} Enchantments`);
  return { title: itemDisplayName(stack.id), lines };
}
