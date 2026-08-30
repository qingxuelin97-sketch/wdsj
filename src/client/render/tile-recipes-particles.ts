/**
 * 粒子贴图。
 *
 * 全部画成**近白的灰度**，颜色由 ParticleDef 的 tint 乘上去 ——
 * 和草、树叶的染色是同一个套路。好处是同一张烟可以当灰烟、白烟、
 * 爆炸的烟球用，不必为每种颜色各画一张。
 *
 * 尺寸上都只占 16×16 的中央一小块：粒子在世界里本来就是几厘米大的东西，
 * 画满整格的话放大到方片上是一坨糊，边缘的锯齿反而比形状更显眼。
 */
import { TilePainter, mulberry32, fnv1a } from './texgen.ts';

function clear(p: TilePainter): void {
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) p.set(x, y, 255, 255, 255, 0);
}

/** 一个带柔边的圆点 */
function blob(p: TilePainter, cx: number, cy: number, r: number, g: number, alphaScale = 1): void {
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > r) continue;
      // 边缘按距离平方淡出，比线性更像一团东西而不是一个圆盘
      const t = 1 - (d / r) ** 2;
      const a = Math.round(255 * t * alphaScale);
      if (a < 8) continue;
      p.set(x, y, g, g, g, a);
    }
  }
}

export const PARTICLE_RECIPES: Record<string, (p: TilePainter) => void> = {
  /**
   * 烟：一团柔和的圆云。
   *
   * 第一版画得"讲究"了：一个主圆 + 四个偏移的小团 + 五个抠掉的小孔，
   * 想让每一粒烟形状各异。结果在真实尺寸下（屏幕上几十个像素）那些
   * 凸起和孔洞成了**主要**特征 —— 一团烟看着像一个齿轮。
   *
   * 烟在画面上只占几十个像素，它需要的不是细节而是**柔和的边缘**。
   * 形状的变化交给尺寸与生命周期的随机，那在同一张贴图上照样成立。
   */
  particle_smoke(p: TilePainter): void {
    clear(p);
    const rand = mulberry32(fnv1a('smoke'));
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const d = Math.hypot(x - 7.5, y - 7.5);
        if (d > 7.5) continue;
        // 三次方的衰减：中心实、边缘散得很开，这是"一团气"而不是"一个球"
        const t = Math.max(0, 1 - d / 7.5);
        const a = t * t * t * 255 * (0.85 + rand() * 0.3);
        if (a < 6) continue;
        const g = 226 + Math.floor(rand() * 24);
        p.set(x, y, g, g, g, Math.min(255, Math.round(a)));
      }
    }
  },

  /** 火焰：中间亮、边缘暗的一小簇，上尖下圆 */
  particle_flame(p: TilePainter): void {
    clear(p);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        // 上尖下圆：把 y 方向压扁并往上偏
        const dx = x - 8;
        const dy = (y - 9) * (y < 9 ? 0.75 : 1.25);
        const d = Math.hypot(dx, dy);
        if (d > 6) continue;
        const t = 1 - d / 6;
        // 中心接近纯白（tint 会把它染成橙），边缘暗下去
        const g = Math.round(150 + 105 * t * t);
        p.set(x, y, g, g, g, Math.round(255 * Math.min(1, t * 1.8)));
      }
    }
  },

  /** 水花：三四个小水滴 */
  particle_splash(p: TilePainter): void {
    clear(p);
    const rand = mulberry32(fnv1a('splash'));
    blob(p, 8, 8, 3.5, 250);
    for (let i = 0; i < 3; i++) {
      blob(p, 4 + rand() * 8, 4 + rand() * 8, 1.6, 255, 0.8);
    }
  },

  /** 气泡：一个空心圆环，中间是空的 —— 那是气泡看着像气泡的原因 */
  particle_bubble(p: TilePainter): void {
    clear(p);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const d = Math.hypot(x - 8, y - 8);
        if (d > 5.5 || d < 3.2) continue;
        p.set(x, y, 255, 255, 255, 215);
      }
    }
    // 左上角一点高光，气泡才有体积感
    p.set(6, 5, 255, 255, 255, 255);
    p.set(7, 5, 255, 255, 255, 200);
  },

  /** 暴击：一颗四角星 */
  particle_crit(p: TilePainter): void {
    clear(p);
    for (let i = -5; i <= 5; i++) {
      const a = Math.round(255 * (1 - Math.abs(i) / 6));
      p.set(8 + i, 8, 255, 255, 255, a);
      p.set(8, 8 + i, 255, 255, 255, a);
    }
    blob(p, 8, 8, 2.5, 255);
  },

  /** 红石粉：一个实心小方点。它够小，形状无所谓，颜色才是信息 */
  particle_dust(p: TilePainter): void {
    clear(p);
    for (let y = 6; y < 10; y++) for (let x = 6; x < 10; x++) p.set(x, y, 255, 255, 255, 245);
  },

  /** 音符：一个简笔八分音符 */
  particle_note(p: TilePainter): void {
    clear(p);
    // 符头
    blob(p, 6, 11, 3, 255);
    // 符干
    for (let y = 3; y <= 11; y++) p.set(9, y, 255, 255, 255, 255);
    // 符尾
    for (let i = 0; i < 4; i++) p.set(10 + i, 3 + i, 255, 255, 255, 255);
  },
};
