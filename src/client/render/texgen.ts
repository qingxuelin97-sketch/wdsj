/**
 * 程序化方块贴图生成。
 *
 * 本项目不使用任何 Mojang 素材，全部贴图都是这里按名字确定性生成的原创像素画。
 *
 * 两条从前作学来的规矩：
 *   1. 按**贴图名字**播种（fnv1a(name) -> mulberry32），不按索引。按索引播种的话，
 *      往中间插一张新贴图会把后面所有贴图重新洗一遍。
 *   2. 直接往 Uint8ClampedArray 写像素，不用 canvas 的 fillRect 逐像素画。
 *      前作两份实现都是每格 256 次 fillRect，一套图集就是七万次 canvas 调用。
 */

const TILE = 16;
const CHANNELS = 4;
export const TILE_SIZE = TILE;
export const TILE_BYTES = TILE * TILE * CHANNELS;

/** FNV-1a，用来把贴图名字变成稳定的 32 位种子 */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32：小巧、质量足够、状态只有一个 uint32 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function rgb(hex: number): Rgb {
  return { r: (hex >> 16) & 255, g: (hex >> 8) & 255, b: hex & 255 };
}

/** 一张 16×16 RGBA 贴图的绘制画布 */
export class TilePainter {
  readonly data = new Uint8ClampedArray(TILE_BYTES);
  readonly rand: () => number;
  readonly name: string;

  constructor(name: string) {
    this.name = name;
    this.rand = mulberry32(fnv1a(name));
  }

  private idx(x: number, y: number): number {
    return (y * TILE + x) * CHANNELS;
  }

  set(x: number, y: number, r: number, g: number, b: number, a = 255): void {
    if (x < 0 || x >= TILE || y < 0 || y >= TILE) return;
    const i = this.idx(x, y);
    this.data[i] = r;
    this.data[i + 1] = g;
    this.data[i + 2] = b;
    this.data[i + 3] = a;
  }

  /** 整块填充 */
  fill(c: Rgb, a = 255): this {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) this.set(x, y, c.r, c.g, c.b, a);
    }
    return this;
  }

  /**
   * 噪声填充：每像素在基色上做 ±variance 的随机扰动。
   * density < 1 时按概率留空（用于树叶这类有孔洞的贴图）。
   */
  noiseFill(c: Rgb, variance: number, density = 1): this {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const d = (this.rand() - 0.5) * 2 * variance;
        // 透明像素的 RGB 也要填上基色，只把 alpha 置 0。
        //
        // 写成 rgb(0,0,0)+alpha(0) 看似无害（反正透明），但 generateMipmap 会把这些
        // 黑色 RGB 平均进相邻的不透明像素，于是树叶在画面上出现一片黑斑 —— 采样到的
        // alpha 过了 0.5 的 discard 阈值，颜色却已经被黑色污染了。这就是所谓的
        // alpha 渗色，任何带 cutout 的贴图都必须这么处理。
        const transparent = density < 1 && this.rand() > density;
        this.set(x, y, c.r + d, c.g + d, c.b + d, transparent ? 0 : 255);
      }
    }
    return this;
  }

  /** 随机斑点，用于矿石、沙砾、基岩 */
  speckles(c: Rgb, count: number, maxSize = 2): this {
    for (let i = 0; i < count; i++) {
      const size = 1 + Math.floor(this.rand() * maxSize);
      const x0 = Math.floor(this.rand() * TILE);
      const y0 = Math.floor(this.rand() * TILE);
      const d = (this.rand() - 0.5) * 24;
      for (let y = y0; y < y0 + size; y++) {
        for (let x = x0; x < x0 + size; x++) this.set(x, y, c.r + d, c.g + d, c.b + d);
      }
    }
    return this;
  }

  rect(x0: number, y0: number, w: number, h: number, c: Rgb, a = 255): this {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) this.set(x, y, c.r, c.g, c.b, a);
    }
    return this;
  }

  hLine(y: number, c: Rgb): this {
    for (let x = 0; x < TILE; x++) this.set(x, y, c.r, c.g, c.b);
    return this;
  }

  vLine(x: number, c: Rgb): this {
    for (let y = 0; y < TILE; y++) this.set(x, y, c.r, c.g, c.b);
    return this;
  }

  /**
   * 边缘渗色：把透明像素的 RGB 填成最近的不透明邻居的颜色。
   *
   * 为什么必须做：generateMipmap 会把透明像素的 RGB 一起平均进去。如果透明处是黑色，
   * 树叶、草、玻璃这类 cutout 贴图在缩小时边缘就会发黑 —— 采样到的 alpha 过了
   * discard 阈值，颜色却已经被污染。填上邻近颜色后，无论 mip 怎么混合都不会引入异色。
   *
   * 迭代 4 轮足够让 16×16 里任何透明区域都被最近的实色覆盖。
   */
  bleedEdges(rounds = 4): this {
    for (let round = 0; round < rounds; round++) {
      const snapshot = this.data.slice();
      let changed = false;
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          const i = this.idx(x, y);
          if (snapshot[i + 3]! > 0) continue; // 已经是实色
          let r = 0, g = 0, b = 0, n = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || nx >= TILE || ny < 0 || ny >= TILE) continue;
              const j = this.idx(nx, ny);
              // 只采样"本来就有颜色"的邻居：alpha>0，或前几轮已经渗过色的
              if (snapshot[j + 3]! === 0 && !(snapshot[j]! | snapshot[j + 1]! | snapshot[j + 2]!)) continue;
              r += snapshot[j]!;
              g += snapshot[j + 1]!;
              b += snapshot[j + 2]!;
              n++;
            }
          }
          if (n === 0) continue;
          this.data[i] = r / n;
          this.data[i + 1] = g / n;
          this.data[i + 2] = b / n;
          // alpha 保持 0 —— 只补颜色，不让它变成可见像素
          changed = true;
        }
      }
      if (!changed) break;
    }
    return this;
  }

  /** 顶部草叶：在纯色底上从顶端长出高度 3-6 的随机草茎 */
  grassOverlay(top: Rgb, height: [number, number] = [3, 6]): this {
    for (let x = 0; x < TILE; x++) {
      const h = height[0] + Math.floor(this.rand() * (height[1] - height[0] + 1));
      for (let y = 0; y < h; y++) {
        const d = (this.rand() - 0.5) * 30;
        this.set(x, y, top.r + d, top.g + d, top.b + d);
      }
    }
    return this;
  }
}
