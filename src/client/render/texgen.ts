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
        if (density < 1 && this.rand() > density) {
          this.set(x, y, 0, 0, 0, 0);
          continue;
        }
        const d = (this.rand() - 0.5) * 2 * variance;
        this.set(x, y, c.r + d, c.g + d, c.b + d);
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

/** 各贴图的绘制配方 */
const RECIPES: Record<string, (p: TilePainter) => void> = {
  stone: (p) => { p.noiseFill(rgb(0x808080), 20); p.speckles(rgb(0x6f6f6f), 6, 2); },
  dirt: (p) => { p.noiseFill(rgb(0x866043), 22); p.speckles(rgb(0x6f4f38), 5, 2); },
  grass_top: (p) => { p.noiseFill(rgb(0x5a9a3a), 26); },
  grass_side: (p) => { p.noiseFill(rgb(0x866043), 22); p.grassOverlay(rgb(0x5a9a3a)); },
  sand: (p) => { p.noiseFill(rgb(0xe0d8b0), 12); },
  gravel: (p) => { p.noiseFill(rgb(0x8a8a8a), 26); p.speckles(rgb(0x6a6a6a), 10, 2); },
  cobblestone: (p) => {
    p.noiseFill(rgb(0x7a7a7a), 18);
    // 错缝砖格，每格再抖一下
    for (let row = 0; row < 4; row++) {
      const offset = (row % 2) * 2;
      for (let col = 0; col < 4; col++) {
        const x0 = (col * 4 + offset) % TILE;
        const d = (p.rand() - 0.5) * 30;
        p.rect(x0, row * 4, 3, 3, { r: 0x7a + d, g: 0x7a + d, b: 0x7a + d });
      }
    }
  },
  planks: (p) => {
    p.noiseFill(rgb(0xb08a52), 14);
    const seam = rgb(0x8a6a3c);
    p.hLine(0, seam); p.hLine(5, seam); p.hLine(10, seam); p.hLine(15, seam);
  },
  log_side: (p) => {
    p.noiseFill(rgb(0x6b5030), 16);
    for (let x = 0; x < TILE; x += 4) p.vLine(x, rgb(0x54401f));
  },
  log_top: (p) => {
    p.noiseFill(rgb(0x9a7b4f), 14);
    // 同心年轮
    for (const r of [2, 4, 6]) {
      for (let a = 0; a < 64; a++) {
        const t = (a / 64) * Math.PI * 2;
        p.set(Math.round(7.5 + Math.cos(t) * r), Math.round(7.5 + Math.sin(t) * r), 0x6b, 0x50, 0x30);
      }
    }
  },
  leaves: (p) => { p.noiseFill(rgb(0x3f7a2a), 30, 0.86); },
  coal_ore: (p) => { p.noiseFill(rgb(0x808080), 20); p.speckles(rgb(0x1a1a1a), 6, 2); },
  iron_ore: (p) => { p.noiseFill(rgb(0x808080), 20); p.speckles(rgb(0xd8a882), 6, 2); },
  gold_ore: (p) => { p.noiseFill(rgb(0x808080), 20); p.speckles(rgb(0xf0d048), 5, 2); },
  diamond_ore: (p) => { p.noiseFill(rgb(0x808080), 20); p.speckles(rgb(0x5decdc), 5, 2); },
  bedrock: (p) => { p.noiseFill(rgb(0x525252), 30); p.speckles(rgb(0x2a2a2a), 12, 3); },
};

export const TILE_NAMES: readonly string[] = Object.keys(RECIPES);

/** 生成一张贴图的 RGBA 像素数据 */
export function generateTile(name: string): Uint8ClampedArray {
  const recipe = RECIPES[name];
  if (recipe === undefined) throw new Error(`未知贴图: ${name}`);
  const painter = new TilePainter(name);
  recipe(painter);
  return painter.data;
}

/**
 * 生成整套贴图，打包成一个可直接喂给 texSubImage3D 的连续缓冲。
 * 返回的层顺序与 TILE_NAMES 一致。
 */
export function generateTileArray(names: readonly string[] = TILE_NAMES): {
  data: Uint8ClampedArray;
  layers: number;
  index: Map<string, number>;
} {
  const data = new Uint8ClampedArray(TILE_BYTES * names.length);
  const index = new Map<string, number>();
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!;
    data.set(generateTile(name), i * TILE_BYTES);
    index.set(name, i);
  }
  return { data, layers: names.length, index };
}
