/**
 * 鼠标停在物品上时弹出的提示条。
 *
 * 眼下只有附了魔的物品会弹（见 `inventory-screen.ts` 里的调用点）——
 * 那是这次要解决的问题：附过魔的剑和刚做的剑在界面上长得一模一样。
 * 给**所有**物品都加提示是另一件事：那会改掉每一张已有的界面截图，
 * 该单独做、单独重录黄金哈希。
 *
 * 配色照抄 MC 的提示条：底是近乎黑的深紫 `#100010`，边是
 * `#5000FF -> #28007F` 的渐变。渐变在这里退化成两档（左上亮、右下暗）——
 * 正好就是面板与按钮那套斜面语言，看着是一路货色，而不是另起了一套。
 */
import type { UiRenderer } from './ui-renderer.ts';
import { UI_WIDTH, UI_HEIGHT } from './ui-renderer.ts';
import { textWidth } from './ui-widgets.ts';
import { GLYPH_H } from './font.ts';
import type { TooltipText } from './item-enchant.ts';

/** 文字到边框的留白 */
const PAD = 4;
/** 行与行之间空几像素。名字和附魔挤在一起会读成一行 */
const GAP = 3;
/** 提示条跟着鼠标的偏移：右下方一点，别压在指针底下挡住格子 */
const OFF_X = 8;
const OFF_Y = -10;

/**
 * 画一条提示。位置跟着鼠标走，但会被夹在屏幕内 ——
 * 悬停最右一列格子时不夹的话，字会有一半在画面外。
 */
export function drawItemTooltip(
  ui: UiRenderer, text: TooltipText, mouseX: number, mouseY: number,
): void {
  let inner = textWidth(text.title);
  for (const line of text.lines) inner = Math.max(inner, textWidth(line));
  const rows = 1 + text.lines.length;
  const w = inner + PAD * 2;
  const h = rows * GLYPH_H + (rows - 1) * GAP + PAD * 2;

  const x = clamp(Math.round(mouseX) + OFF_X, 2, UI_WIDTH - w - 2);
  const y = clamp(Math.round(mouseY) + OFF_Y, 2, UI_HEIGHT - h - 2);

  ui.rect(x, y, w, h, 0.06, 0, 0.06, 0.94);
  // 亮的两条边在左上、暗的在右下 —— 与 panelRaised 同向，提示条于是看着
  // 也是"鼓出来"的
  ui.rect(x, y, w, 1, 0.31, 0, 1, 0.8);
  ui.rect(x, y, 1, h, 0.31, 0, 1, 0.8);
  ui.rect(x, y + h - 1, w, 1, 0.16, 0, 0.5, 0.8);
  ui.rect(x + w - 1, y, 1, h, 0.16, 0, 0.5, 0.8);

  // 物品名用白色，附魔用淡紫 —— 与图标上那层光效同一个色系，
  // 玩家不用读完字就知道这两行说的是同一件事
  ui.text(text.title, x + PAD, y + PAD, 1, 1, 1, 1);
  let ty = y + PAD + GLYPH_H + GAP;
  for (const line of text.lines) {
    ui.text(line, x + PAD, ty, 1, 0.72, 0.55, 0.96);
    ty += GLYPH_H + GAP;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
