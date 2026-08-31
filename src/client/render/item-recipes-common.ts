/**
 * 物品图标画法里被多个文件共用的那几件小工具。
 *
 * 单独一个文件，是因为 `item-recipes.ts` 与 `item-recipes-tools.ts` 都要用它们，
 * 而让后者反过来 import 前者会形成循环 —— `toolIcons()` 是在模块顶层求值的，
 * 循环下拿到的会是还没初始化完的 `undefined`，症状是"所有工具图标是空白"。
 */
import { rgb, type Rgb, type TilePainter } from './texgen.ts';

export type Painter = (p: TilePainter) => void;

/** 清空成全透明。cutout 图标的第一句 */
export function clear(p: TilePainter): void {
  p.clear();
}

export function px(p: TilePainter, x: number, y: number, c: Rgb, a = 255): void {
  p.set(x, y, c.r, c.g, c.b, a);
}

export function fillRect(p: TilePainter, x0: number, y0: number, w: number, h: number, c: Rgb): void {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) px(p, x, y, c);
}

/** 按比例加深/提亮 */
export function shade(c: Rgb, f: number): Rgb {
  return {
    r: Math.max(0, Math.min(255, Math.round(c.r * f))),
    g: Math.max(0, Math.min(255, Math.round(c.g * f))),
    b: Math.max(0, Math.min(255, Math.round(c.b * f))),
  };
}

/**
 * 加/减一个**固定**亮度。
 *
 * 深色物件必须用它而不是 `shade`：煤是 0x2a2a2a，乘 1.7 之后是 0x474747，
 * 在量化成 6 色时和本体归进同一簇 —— 结果就是煤炭图标上那点高光整个消失，
 * 只剩一团纯黑的球。乘法对暗色几乎不起作用，加法才拉得开。
 */
export function lift(c: Rgb, d: number): Rgb {
  return {
    r: Math.max(0, Math.min(255, c.r + d)),
    g: Math.max(0, Math.min(255, c.g + d)),
    b: Math.max(0, Math.min(255, c.b + d)),
  };
}

/** 工具材质配色。木/石/铁/金/钻石/皮革 */
export const MATERIAL: Record<string, Rgb> = {
  wooden: rgb(0x9a7a44),
  stone: rgb(0x8a8a8a),
  iron: rgb(0xd8d8d8),
  golden: rgb(0xf0d040),
  diamond: rgb(0x5ce0d8),
  leather: rgb(0xa06840),
};

const WOOD = rgb(0x7a5a30);

/**
 * 木柄：从左下往右上的一条 2px 斜线，带木纹。
 *
 * 两条必须遵守的画法：
 *   1. **横向成对**地画（x, x+1 同一行），不要画成"沿垂直方向加粗的斜线"。
 *      45° 线沿垂直方向加粗出来的像素只在对角相邻，而 `outline()` 只看四邻，
 *      于是描边会从柄的中间穿过去，柄看着像一串没连上的点。
 *   2. 左列亮、右列暗。圆柱柄的受光面在左上，这一条让 2px 宽的柄有圆感；
 *      两列同色的话就是一条平板胶带。
 *
 * @param botX 柄底端所在列，@param botY 柄底端所在行，@param len 长度（格）
 */
export function woodHandle(p: TilePainter, botX: number, botY: number, len: number): void {
  const hi = shade(WOOD, 1.3);
  const mid = shade(WOOD, 1.05);
  const lo = shade(WOOD, 0.72);
  for (let i = 0; i < len; i++) {
    // 每隔三格暗一格：木头的年轮。全亮的话缩到 16px 看是一根塑料管
    px(p, botX + i, botY - i, i % 3 === 2 ? mid : hi);
    px(p, botX + i + 1, botY - i, lo);
  }
}
