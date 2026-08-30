/**
 * 天空贴图：太阳、8 个月相、云、雨、雪。
 *
 * 它们不属于任何方块，由入口显式塞进图集（和 destroy_stage 一样）。
 *
 * 全部画成**带 alpha 的**：日月是天球上的一个四边形，四角必须透明，
 * 否则天上会挂着一个方块。云同理 —— 云贴图的孔洞就是天空。
 */
import { TilePainter, mulberry32, fnv1a } from './texgen.ts';

/** 把整张图刷成透明。注意 RGB 也要给值，不能留 0 —— 见 texgen 里 alpha 渗色那段 */
function clear(p: TilePainter): void {
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) p.set(x, y, 255, 255, 255, 0);
}

/**
 * 月相的明暗界线。
 *
 * 8 张图不能各画各的 —— 相位之间必须连续，否则月亮在跨天那一刻会跳一下形状。
 * 所以 8 张共用同一条参数化的界线：
 *
 *   被照亮的比例 f：满月 1 -> 新月 0 -> 满月 1
 *   k = 1 - 2f，于是 k = -1 全亮、k = 0 半亮、k = +1 全暗
 *   在高度 dy 处，圆盘的半弦长 w = √(R² - dy²)，界线落在 x = k·w
 *
 * 验算：k=-1 时界线在 -w（圆盘最左），右边全亮 = 满月；
 * k=0 时界线在中轴，右半亮 = 半月；k=+1 时界线在 +w，几乎全暗 = 新月。
 */
function litFraction(phase: number): number {
  return phase <= 4 ? 1 - phase / 4 : (phase - 4) / 4;
}

const RADIUS = 7.2;

export const SKY_RECIPES: Record<string, (p: TilePainter) => void> = {
  // 太阳：暖白圆盘，边缘偏橙。不画光晕 —— MC 的光晕是天空色本身在
  // 日出日落时变暖，不是贴在太阳上的一圈
  sun(p: TilePainter): void {
    clear(p);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const d = Math.hypot(x - 7.5, y - 7.5);
        if (d > 7.4) continue;
        const t = Math.min(1, d / 7.4);
        p.set(x, y, 255, 255 - Math.round(70 * t * t), 200 - Math.round(150 * t * t), 255);
      }
    }
  },

  // 云：白色团块 + 透明孔洞。用对 16 取模的噪声格生成，所以左右上下
  // 天然接得上，可以直接 REPEAT 平铺
  clouds(p: TilePainter): void {
    clear(p);
    const rand = mulberry32(fnv1a('clouds'));
    const grid: number[] = [];
    for (let i = 0; i < 256; i++) grid.push(rand());
    const at = (x: number, y: number): number => grid[(y & 15) * 16 + (x & 15)]!;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        // 3×3 平滑，让云成团而不是椒盐噪声
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += at(x + dx, y + dy);
        const v = sum / 9;
        if (v < 0.47) continue;
        const g = 236 + Math.round((v - 0.47) * 40);
        p.set(x, y, g, g, g, 210);
      }
    }
  },

  // 雨：竖直细线。贴图里只放几条，拉长交给粒子
  rain(p: TilePainter): void {
    clear(p);
    const rand = mulberry32(fnv1a('rain'));
    for (let i = 0; i < 5; i++) {
      const x = Math.floor(rand() * 16);
      const y0 = Math.floor(rand() * 8);
      const y1 = Math.min(16, y0 + 8 + Math.floor(rand() * 6));
      for (let y = y0; y < y1; y++) p.set(x, y, 150, 175, 235, 190);
    }
  },

  // 雪：散开的小方点，比雨慢也比雨软
  snow(p: TilePainter): void {
    clear(p);
    const rand = mulberry32(fnv1a('snowflake'));
    for (let i = 0; i < 14; i++) {
      const x = Math.floor(rand() * 15);
      const y = Math.floor(rand() * 15);
      p.set(x, y, 250, 250, 255, 225);
      if (rand() < 0.5) p.set(x + 1, y, 250, 250, 255, 200);
    }
  },

  ...moonPhases(),
};

function moonPhases(): Record<string, (p: TilePainter) => void> {
  const out: Record<string, (p: TilePainter) => void> = {};
  for (let phase = 0; phase < 8; phase++) {
    const k = 1 - 2 * litFraction(phase);
    // 0..4 是亏（亮的一侧在左），5..7 是盈（亮的一侧在右）。
    // 两者只差一个左右镜像，所以用一个符号位而不是两套分支
    const flip = phase <= 4 ? -1 : 1;
    out[`moon_phase_${phase}`] = (p: TilePainter): void => {
      clear(p);
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const dx = (x - 7.5) * flip;
          const dy = y - 7.5;
          if (Math.hypot(dx, dy) > RADIUS) continue;
          const w = Math.sqrt(Math.max(0, RADIUS * RADIUS - dy * dy));
          if (dx < k * w) continue;
          const g = 220 + Math.round(p.rand() * 30);
          p.set(x, y, g, g, Math.min(255, g + 10), 255);
        }
      }
    };
  }
  return out;
}

/** 天空相关的贴图名。同样不属于任何方块，要由入口显式塞进图集 */
export const SKY_TILE_NAMES: readonly string[] = Object.keys(SKY_RECIPES);
