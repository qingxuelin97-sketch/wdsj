/**
 * 附了魔的物品图标上那层"紫色流光"。
 *
 * MC 用的是一张滚动的 glint 贴图叠加（还是加法混合）。这个项目的贴图全是
 * 程序化生成的，而 `UiRenderer` 只有"纯色矩形"和"采样某一层"两种画法、
 * 混合方式固定是普通的 alpha —— 所以这里做的是一个**程序化的等价物**：
 * 两条斜向流光扫过图标，外加一圈会呼吸的紫色描边。
 *
 * 斜线是用**阶梯**画的：每两像素高一级、逐级横移两像素，在 320×240 的
 * 虚拟像素上看就是一条 45° 的带子。为几个物品去烘一张贴图不划算，
 * 而且纯色块在任何缩放下都清晰（与心形、火焰、箭头同一条理由）。
 *
 * ## 两条约束，缺一不可
 *
 * 1. **不许糊住图标**。玩家得认得出那是把剑。所以流光很窄（4 像素）、
 *    很淡（alpha 0.3 以下），描边只占最外一圈的 1 像素。
 * 2. **相位只能来自渲染帧号**，不许读挂钟（规约第 4 条）。帧号从哪来
 *    见 `render/render-frame.ts`。
 */
import type { UiRenderer } from './ui-renderer.ts';

/** 流光的紫。MC 的 glint 大致在 #A020F0 ~ #C050FF 这一带，不是品红 */
const GLINT_R = 0xc0 / 255;
const GLINT_G = 0x50 / 255;
const GLINT_B = 0xff / 255;

/** 描边用更深一档的紫，和流光拉开层次 */
const RIM_R = 0xa0 / 255;
const RIM_G = 0x20 / 255;
const RIM_B = 0xf0 / 255;

/**
 * 两条流光各自走完一趟要多少帧。
 *
 * 取两个互质的数：合起来的图案要过 96×61 帧才重复一次，看着才像"表面在流"。
 * 取成倍数的话两条永远同步，读出来就是一根变宽了的柱子。
 * 96 帧在 60 fps 下约 1.6 秒 —— 再快就成了闪烁，很吵。
 */
const SWEEP_PERIOD = 96;
const SWEEP2_PERIOD = 61;
/** 第二条的起跑点错开一段，否则两条在第 0 帧是重合的 */
const SWEEP2_OFFSET = 23;
/** 描边亮度呼吸一次的帧数 */
const RIM_PERIOD = 72;

/** 阶梯每级多高（像素）。2 像素在 16×16 的图标上正好八级 */
const STEP = 2;
/** 流光带多宽。再宽就开始盖住图标了 */
const BAND = 4;

/**
 * 画一格的附魔光效。(x, y) 是图标左上角，`size` 是图标边长（物品栏里是 16）。
 *
 * @param frame 渲染帧号（`clock.renderTick`），**不是**挂钟毫秒
 */
export function drawEnchantGlint(
  ui: UiRenderer, x: number, y: number, size: number, frame: number,
): void {
  sweep(ui, x, y, size, phase(frame, SWEEP_PERIOD), 0.30);
  sweep(ui, x, y, size, phase(frame + SWEEP2_OFFSET, SWEEP2_PERIOD), 0.18);
  // 呼吸幅度压得很小（0.34 ~ 0.50）：描边是"这件东西附过魔"的常驻信号，
  // 让它明灭得太狠反而会把视线一直拽过去
  rim(ui, x, y, size, 0.34 + 0.16 * (0.5 - 0.5 * Math.cos(2 * Math.PI * phase(frame, RIM_PERIOD))));
}

/** 帧号 -> [0,1) 的相位。取模两次是为了万一帧号是负的也不会跳 */
function phase(frame: number, period: number): number {
  return (((frame % period) + period) % period) / period;
}

/**
 * 一条斜向流光。
 *
 * 自己做裁剪（算和图标框的交集）而不是指望 GL —— `UiRenderer` 就是一堆
 * 矩形，没有裁剪矩形这回事。漏出去的话流光会画到相邻格子上，
 * 表现为"隔壁那把没附魔的剑也在闪"。
 */
function sweep(
  ui: UiRenderer, x: number, y: number, size: number, p: number, alpha: number,
): void {
  const rows = Math.max(1, Math.floor(size / STEP));
  /** 斜带首尾的水平错位。它决定了带子有多斜 */
  const lean = (rows - 1) * STEP;
  /** 从完全在左边到完全在右边要走的距离 */
  const travel = size + BAND + lean;
  const head = -BAND - lean + p * travel;
  for (let r = 0; r < rows; r++) {
    // 越靠下越靠左 —— 一条从左下指向右上的带子，与 MC 的流光同向
    const bx = x + head + (rows - 1 - r) * STEP;
    const left = Math.max(x, bx);
    const right = Math.min(x + size, bx + BAND);
    // 这一级还没进画面、或者已经走出去了
    if (right <= left) continue;
    ui.rect(left, y + r * STEP, right - left, STEP, GLINT_R, GLINT_G, GLINT_B, alpha);
  }
}

/** 一圈 1 像素的紫色描边。四条边分开画，中间不填 —— 填了就把图标压暗了 */
function rim(ui: UiRenderer, x: number, y: number, size: number, alpha: number): void {
  ui.rect(x, y, size, 1, RIM_R, RIM_G, RIM_B, alpha);
  ui.rect(x, y + size - 1, size, 1, RIM_R, RIM_G, RIM_B, alpha);
  ui.rect(x, y + 1, 1, size - 2, RIM_R, RIM_G, RIM_B, alpha);
  ui.rect(x + size - 1, y + 1, 1, size - 2, RIM_R, RIM_G, RIM_B, alpha);
}
