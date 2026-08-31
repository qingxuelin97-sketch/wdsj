/**
 * 界面控件：调色板、斜面面板、按钮、居中文字。
 *
 * 从 `inventory-screen.ts` 抽出来的 —— 菜单和容器界面必须共用**同一套
 * 视觉语言**，各画各的话，同一个游戏里会出现两种按钮、两种灰。
 *
 * 配色照抄 MC，不自己估（与 `docs/RULES.md` 第 6 条同一条道理）。
 */
import { UiRenderer, UI_WIDTH } from './ui-renderer.ts';
import { GLYPH_ADVANCE, GLYPH_H } from './font.ts';

/** MC 的界面配色 */
export const C = {
  white: 1,
  panel: 198 / 255, // #C6C6C6 面板底
  slot: 139 / 255, // #8B8B8B 槽位底
  shadow: 85 / 255, // #555555 面板右下阴影
  slotDark: 55 / 255, // #373737 槽位左上暗边
  /** 按钮底。MC 的按钮比面板深一档，才在面板上分得出来 */
  button: 108 / 255,
  /** 悬停时的按钮底。MC 是整块提亮并把字描成黄的 */
  buttonHover: 141 / 255,
  /** 禁用的按钮 */
  buttonOff: 78 / 255,
};

/** 外凸面板：黑外框 + 左上白高光 + 右下深灰阴影 + 面板底 */
export function panelRaised(ui: UiRenderer, x: number, y: number, w: number, h: number): void {
  ui.rect(x, y, w, h, 0, 0, 0, 1);
  ui.rect(x + 1, y + 1, w - 2, h - 2, C.shadow, C.shadow, C.shadow, 1);
  // 高光只铺左上两条，右下留着露出上一层的深灰
  ui.rect(x + 1, y + 1, w - 3, h - 3, C.white, C.white, C.white, 1);
  ui.rect(x + 2, y + 2, w - 4, h - 4, C.panel, C.panel, C.panel, 1);
}

/** 内凹的槽位/凹槽 */
export function inset(
  ui: UiRenderer, x: number, y: number, w: number, h: number, fill = C.slot,
): void {
  ui.rect(x, y, w, h, C.slotDark, C.slotDark, C.slotDark, 1);
  ui.rect(x + 1, y + 1, w - 1, h - 1, C.white, C.white, C.white, 1);
  ui.rect(x + 1, y + 1, w - 2, h - 2, fill, fill, fill, 1);
}

/** 一个按钮的位置与文字 */
export interface Button {
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly enabled?: boolean;
}

export const BUTTON_W = 176;
export const BUTTON_H = 18;

/** 在设计分辨率里横向居中排一列按钮 */
export function column(
  items: readonly { id: string; label: string; enabled?: boolean }[],
  topY: number,
  gap = 4,
  w = BUTTON_W,
): Button[] {
  const x = Math.round((UI_WIDTH - w) / 2);
  return items.map((it, i) => ({
    ...it, x, y: topY + i * (BUTTON_H + gap), w, h: BUTTON_H,
  }));
}

/** 鼠标落在哪个按钮上。没有就返回 null */
export function buttonAt(buttons: readonly Button[], mx: number, my: number): Button | null {
  for (const b of buttons) {
    if (b.enabled === false) continue;
    if (mx >= b.x && mx < b.x + b.w && my >= b.y && my < b.y + b.h) return b;
  }
  return null;
}

/**
 * 画一个按钮。
 *
 * 斜面方向与面板一致（外凸：左上亮、右下暗），这样按钮看上去是"从面板上
 * 鼓出来"的。悬停时整块提亮并把字描成黄色 —— MC 就是这么做的，
 * 只改边框的话在 320×240 上根本看不出来。
 */
export function drawButton(ui: UiRenderer, b: Button, hovered: boolean): void {
  const off = b.enabled === false;
  const fill = off ? C.buttonOff : hovered ? C.buttonHover : C.button;
  ui.rect(b.x, b.y, b.w, b.h, 0, 0, 0, 1);
  ui.rect(b.x + 1, b.y + 1, b.w - 2, b.h - 2, 0.16, 0.16, 0.16, 1);
  ui.rect(b.x + 1, b.y + 1, b.w - 3, b.h - 3, 0.86, 0.86, 0.86, 1);
  ui.rect(b.x + 2, b.y + 2, b.w - 4, b.h - 4, fill, fill, fill, 1);
  const tint: [number, number, number] = off ? [0.62, 0.62, 0.62]
    : hovered ? [1, 1, 0.62] : [0.88, 0.88, 0.88];
  centeredText(ui, b.label, b.y + Math.round((b.h - GLYPH_H) / 2), 1, ...tint);
}

/** 按设计分辨率把一行字居中。字宽 = 字数 × 步进 − 末尾那一格间隙 */
export function centeredText(
  ui: UiRenderer, str: string, y: number, scale: number, r: number, g: number, b: number,
): void {
  const w = str.length * GLYPH_ADVANCE * scale - scale;
  ui.text(str, Math.round((UI_WIDTH - w) / 2), y, scale, r, g, b);
}

/** 一行字有多宽（虚拟像素） */
export function textWidth(str: string, scale = 1): number {
  return str.length * GLYPH_ADVANCE * scale - scale;
}
