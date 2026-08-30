/**
 * 材质底：石、木、金属、砖。
 *
 * 这些"底"被几十张贴图共用（熔炉/发射器/半砖/坩埚都是石头底，
 * 箱子/唱片机/音符盒/床都是木头底）。分出来有两个好处：
 *
 *   1. 同一族的贴图**质感一致** —— 各写各的话，一面墙上熔炉和石头
 *      会是两种灰，看着像两种材料
 *   2. 调一次全族跟着变，不用逐张改
 *
 * 手法与 `tile-recipes-terrain.ts` 一致：可平铺格点噪声打底、
 * 成团斑块加特征、边缘收一道。为什么不是白噪声见那个文件的头注释。
 */
import { rgb, type TilePainter, type Rgb } from './texgen.ts';

/** 石头底。矿石、熔炉、发射器、半砖、坩埚、中继器都用它 */
export function stoneBase(p: TilePainter, tone: Rgb = rgb(0x7e7e7e)): void {
  p.valueNoise(tone, 15, 4, 4, 2);
  p.blobs({ r: tone.r - 16, g: tone.g - 16, b: tone.b - 16 }, 4, 2.0, 8);
}

/**
 * 木头底。箱子、唱片机、音符盒、活塞筒身都用它。
 *
 * `vertical` 决定木纹方向：侧面板通常是横纹，立柱是竖纹。
 * 方向错了看着像把木头拧了 90 度。
 */
export function woodBase(p: TilePainter, tone: Rgb, vertical = false): void {
  p.grain(tone, 16, vertical);
}

/**
 * 金属底。铁门、铁栏杆、铁块类用它。
 *
 * 金属与石头的区别在**噪声幅度**：金属要平（amp 小、格点细），
 * 石头要糙。幅度给大了铁门看着像水泥门。
 */
export function metalBase(p: TilePainter, tone: Rgb): void {
  p.valueNoise(tone, 7, 6, 6, 2);
}

/**
 * 错缝砖格。砖块类（圆石以外）用这个。
 *
 * 砖面本身带格点噪声（不是纯色 + 一个随机偏移），且每块砖**顶边提亮、
 * 底边压暗** —— 砖有了厚度才不像贴在墙上的色块。
 */
export function brickGrid(
  p: TilePainter, base: Rgb, mortar: Rgb, cellW: number, cellH: number, jitter: number,
): void {
  p.valueNoise(mortar, 9, 8, 8, 1);
  const rows = Math.ceil(16 / cellH);
  for (let row = 0; row < rows; row++) {
    const offset = (row % 2) * Math.floor(cellW / 2);
    for (let col = -1; col < Math.ceil(16 / cellW) + 1; col++) {
      const x0 = col * cellW + offset;
      const d = (p.rand() - 0.5) * jitter;
      const r = base.r + d;
      const g = base.g + d;
      const b = base.b + d;
      // 用 setWrapped 而不是 rect：rect 走 set()，越界直接丢弃，
      // 于是错缝行左右两端的半块砖被切掉，贴图接不上
      for (let y = 0; y < cellH - 1; y++) {
        for (let x = 0; x < cellW - 1; x++) {
          const n = (p.rand() - 0.5) * 8;
          const top = y === 0 ? 9 : 0;
          const bottom = y === cellH - 2 ? -11 : 0;
          p.setWrapped(x0 + x, row * cellH + y, r + n + top + bottom, g + n + top + bottom, b + n + top + bottom, 255);
        }
      }
    }
  }
}

/**
 * 在一块已画好的贴图上压一圈内嵌边框，做出"这是一台机器/一个箱子"的感觉。
 *
 * 左上提亮、右下压暗，与界面斜面同一套语言（见 inventory-screen.ts）。
 */
export function inset(p: TilePainter, margin: number, light = 16, dark = 18): void {
  const a = margin;
  const b = 15 - margin;
  for (let i = a; i <= b; i++) {
    p.shade(i, a, light);
    p.shade(a, i, light);
    p.shade(i, b, -dark);
    p.shade(b, i, -dark);
  }
}
