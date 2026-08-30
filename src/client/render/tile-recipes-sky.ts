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

  /**
   * 雨：一根根**短促的**竖直雨丝。
   *
   * 关键是**留白**。第一版把每条线从上画到下、铺满 11 个列，
   * 渲染出来是一整幅半透明的帘子 —— 均匀、静止、毫无下落感，
   * 因为一块处处相同的东西往下滚是看不出来在动的。
   *
   * 真正让人看出"在下雨"的是**间隙**：一段雨丝、一段空、再一段雨丝，
   * 滚动时眼睛跟着那些间隙走，才读得出下落。
   *
   * 竖向被截断不要紧：这张图是纵向平铺的，被切断的雨丝会在下一块里
   * 接着长出来，正好是连续的。
   */
  rain(p: TilePainter): void {
    clear(p);
    const rand = mulberry32(fnv1a('raindrops'));
    for (let i = 0; i < 22; i++) {
      const x = Math.floor(rand() * 16);
      const y0 = Math.floor(rand() * 16);
      const len = 3 + Math.floor(rand() * 4);
      // 每条自己的亮度与浓度，让雨有远近层次而不是一堵均匀的墙
      const bright = 0.65 + rand() * 0.35;
      const r = Math.round(160 * bright);
      const g = Math.round(185 * bright);
      const b = Math.round(245 * bright);
      // 单条雨丝要**很淡**。视野里同时有上百条雨带互相叠着，
      // 每条都画得清清楚楚的话叠出来是一堵白墙，世界整个看不见了。
      // 雨的密度感来自"很多条很淡的"，不是"几条很浓的"
      const alpha = 55 + Math.floor(rand() * 55);
      for (let k = 0; k < len; k++) {
        // 对 16 取模：跨过下边界的部分从上边接回来，平铺时是连续的
        const y = (y0 + k) % 16;
        // 头尾淡一点，雨丝才有"速度"而不是一根火柴棍
        const t = k === 0 || k === len - 1 ? 0.45 : 1;
        p.set(x, y, r, g, b, Math.round(alpha * t));
      }
    }
  },

  /**
   * 雪花**粒子**（不是雪方块的贴图）。散开的小方块，比雨慢也比雨软。
   *
   * 名字必须是 snowflake 而不是 snow：`RECIPES` 是一个对象字面量，
   * `...SKY_RECIPES` 展开在地形那批**后面**，同名键后者胜。
   * 原来这里叫 snow，于是雪方块（id 80）和雪层拿到的是这张
   * 半透明的粒子图 —— 世界里的雪是"能看穿、上面浮着几点白"的。
   *
   * 和雨相反，雪要的就是稀疏 —— 一片片分得开的雪花，慢慢飘。
   * 画成 2×2 而不是单像素：单像素在远处会被 alpha 测试整个丢掉，
   * 表现是"雪只在眼前有，稍远一点就没了"。
   */
  snowflake(p: TilePainter): void {
    clear(p);
    const rand = mulberry32(fnv1a('snowflake'));
    for (let i = 0; i < 16; i++) {
      const x = Math.floor(rand() * 15);
      const y = Math.floor(rand() * 15);
      const a = 190 + Math.floor(rand() * 65);
      p.set(x, y, 252, 252, 255, a);
      p.set(x + 1, y, 252, 252, 255, Math.round(a * 0.8));
      p.set(x, y + 1, 252, 252, 255, Math.round(a * 0.8));
      p.set(x + 1, y + 1, 252, 252, 255, Math.round(a * 0.6));
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
