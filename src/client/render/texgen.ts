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

  /**
   * 全部清成透明。cutout 贴图（植物、火把、栏杆……）的第一句都是它。
   *
   * 分出来是因为 `for y for x set(x,y,0,0,0,0)` 这个写法在配方表里
   * 原样重复了十几处，每处都占两行，把配方本身淹掉了。
   */
  clear(): this {
    this.data.fill(0);
    return this;
  }

  /**
   * 在现有像素上加减亮度，保留色相与 alpha。
   *
   * 做边框高光/阴影用。直接 `set` 一个算好的颜色也行，但那要求调用方
   * 知道底下是什么色 —— 底一改就得跟着改，而"提亮一点"是与底色无关的意图。
   */
  shade(x: number, y: number, delta: number): this {
    if (x < 0 || x >= TILE || y < 0 || y >= TILE) return this;
    const i = this.idx(x, y);
    if (this.data[i + 3]! === 0) return this;
    this.data[i] = this.data[i]! + delta;
    this.data[i + 1] = this.data[i + 1]! + delta;
    this.data[i + 2] = this.data[i + 2]! + delta;
    return this;
  }

  /** 整块填充 */
  fill(c: Rgb, a = 255): this {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) this.set(x, y, c.r, c.g, c.b, a);
    }
    return this;
  }

  /**
   * 这里原来有 `noiseFill`（逐像素独立的白噪声填充）与 `speckles`
   * （随机方点）。两个都删了，不是清理，是**拆掉一个坑**：
   *
   *   - `noiseFill` 画出来是电视雪花点。相邻像素毫无相关性，退开一步
   *     被眼睛平均成一片均匀的糊。整套贴图的"糊感"根源就是它
   *   - `speckles` 从随机点画 size×size 方块，而 `set()` 越界直接丢弃 ——
   *     靠右靠下的点被切掉一半、靠左靠上永远没有半个点，
   *     于是同一张贴图铺成墙时接缝处一侧密一侧疏
   *
   * 替代品分别是 `valueNoise`（可平铺的格点噪声，明暗成团）
   * 与 `blobs` / `oreBlobs`（环绕的不规则团块）。留着旧的只会让下一个人
   * 顺手再用一次，把问题重新引进来。
   *
   * 透明像素的 RGB 必须填基色、只把 alpha 置 0 —— 见 `bleedEdges` 与
   * `holes` 的注释，那条规矩对任何 cutout 贴图都成立。
   */

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

  /**
   * 环绕写像素。越界的坐标从对边绕回来。
   *
   * `set()` 遇到越界是直接丢弃的，那对"画在中间"的图元没问题，
   * 但对**随机撒在整块上**的图元（斑点、团块）就会出两个毛病：
   *   1. 靠右靠下的图元被切掉一半，靠左靠上永远不会有半个图元
   *      —— 同一张贴图铺成一面墙，接缝处一侧密一侧疏
   *   2. 贴图不再无缝
   * 环绕之后被切掉的那半从对边长回来，两个毛病一起没了。
   *
   * alpha 默认**保持原样**：这样团块画在树叶这类 cutout 贴图上时
   * 不会把孔洞填实。要画出新的不透明像素就显式传 a。
   */
  setWrapped(x: number, y: number, r: number, g: number, b: number, a?: number): void {
    const i = this.idx(((x % TILE) + TILE) % TILE, ((y % TILE) + TILE) % TILE);
    this.data[i] = r;
    this.data[i + 1] = g;
    this.data[i + 2] = b;
    if (a !== undefined) this.data[i + 3] = a;
  }

  /**
   * 可平铺的格点噪声场，返回 16×16 个 [0,1) 的值。
   *
   * 这是本文件里最要紧的一个东西。原来的 `noiseFill` 是**逐像素独立**的
   * 白噪声，16×16 上看就是电视雪花点：单看有变化，退开一步相邻像素
   * 互相平均，整块糊成一片均匀的灰。真正的像素画靠的是**成团的明暗**，
   * 人眼读的是团块不是像素。
   *
   * 做法是经典的 value noise：撒 cellsX×cellsY 个格点，格点之间用
   * smoothstep 做双线性插值，再叠几个倍频。**取模保证平铺** ——
   * x=16 落回格点 0，所以左右边缘天然接得上。
   *
   * cellsX / cellsY 分开给是为了做**方向性**纹理：格点在 x 上少、
   * y 上多，值就沿 x 变得慢、沿 y 变得快，看上去是横向的条纹（木纹）。
   */
  noiseField(cellsX: number, cellsY: number, octaves = 2): Float32Array {
    const out = new Float32Array(TILE * TILE);
    let amp = 1;
    let total = 0;
    for (let o = 0; o < octaves; o++) {
      const nx = cellsX * (1 << o);
      const ny = cellsY * (1 << o);
      const grid = new Float32Array(nx * ny);
      for (let i = 0; i < grid.length; i++) grid[i] = this.rand();
      for (let y = 0; y < TILE; y++) {
        const fy = (y / TILE) * ny;
        const y0 = Math.floor(fy) % ny;
        const y1 = (y0 + 1) % ny;
        const ty = fy - Math.floor(fy);
        const sy = ty * ty * (3 - 2 * ty);
        for (let x = 0; x < TILE; x++) {
          const fx = (x / TILE) * nx;
          const x0 = Math.floor(fx) % nx;
          const x1 = (x0 + 1) % nx;
          const tx = fx - Math.floor(fx);
          const sx = tx * tx * (3 - 2 * tx);
          const a = grid[y0 * nx + x0]! * (1 - sx) + grid[y0 * nx + x1]! * sx;
          const b = grid[y1 * nx + x0]! * (1 - sx) + grid[y1 * nx + x1]! * sx;
          out[y * TILE + x]! += (a * (1 - sy) + b * sy) * amp;
        }
      }
      total += amp;
      amp *= 0.5;
    }
    for (let i = 0; i < out.length; i++) out[i]! /= total;
    return out;
  }

  /**
   * 用可平铺格点噪声填充。`noiseFill` 的替代品 ——
   * 同样是"基色 ± amp"，但明暗是成团的而不是逐像素乱跳。
   */
  valueNoise(c: Rgb, amp: number, cellsX = 4, cellsY = 4, octaves = 2): this {
    const f = this.noiseField(cellsX, cellsY, octaves);
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const d = (f[y * TILE + x]! - 0.5) * 2 * amp;
        this.set(x, y, c.r + d, c.g + d, c.b + d);
      }
    }
    return this;
  }

  /**
   * 方向性纹理：木纹、矿脉层理这类"沿一个方向拉长"的花纹。
   * 本质就是各向异性的格点噪声 —— 顺纹方向格点少（变化慢），
   * 横纹方向格点多（变化快）。
   */
  grain(c: Rgb, amp: number, vertical = false): this {
    return vertical ? this.valueNoise(c, amp, 9, 2, 2) : this.valueNoise(c, amp, 2, 9, 2);
  }

  /**
   * 成团斑块。矿石、沙砾、青苔用这个，替代 `speckles`。
   *
   * 与 `speckles` 的两点不同：形状是**带扰动的圆**而不是正方形，
   * 且用 `setWrapped` 环绕，所以不会在边上被切掉。
   */
  blobs(c: Rgb, count: number, radius = 2, jitter = 18): this {
    for (let i = 0; i < count; i++) {
      const cx = Math.floor(this.rand() * TILE);
      const cy = Math.floor(this.rand() * TILE);
      const r = radius * (0.65 + this.rand() * 0.7);
      const d = (this.rand() - 0.5) * jitter;
      const rr = Math.ceil(r);
      for (let dy = -rr; dy <= rr; dy++) {
        for (let dx = -rr; dx <= rr; dx++) {
          // 半径上加噪声，边界就不是标准圆 —— 标准圆在 16×16 上太规整，
          // 一眼看得出是程序画的
          if (Math.hypot(dx, dy) > r + (this.rand() - 0.5) * 0.9) continue;
          this.setWrapped(cx + dx, cy + dy, c.r + d, c.g + d, c.b + d);
        }
      }
    }
    return this;
  }

  /**
   * MC 风格的矿石团：亮色核心外面套一圈暗边。
   *
   * 直接撒亮点（原来的做法）在石头底上是"洒了一把糖"，糊成一片；
   * 加了暗边之后每一团才有轮廓，退远了也数得清几团。
   */
  oreBlobs(core: Rgb, rim: Rgb, count: number, radius = 2): this {
    for (let i = 0; i < count; i++) {
      const cx = Math.floor(this.rand() * TILE);
      const cy = Math.floor(this.rand() * TILE);
      const r = radius * (0.7 + this.rand() * 0.6);
      const rr = Math.ceil(r) + 1;
      const wobble: number[] = [];
      for (let k = 0; k < (rr * 2 + 1) ** 2; k++) wobble.push((this.rand() - 0.5) * 0.9);
      let k = 0;
      // 先铺暗边（半径 +1），再盖亮核，顺序反了核心会被边吃掉
      for (let dy = -rr; dy <= rr; dy++) {
        for (let dx = -rr; dx <= rr; dx++) {
          if (Math.hypot(dx, dy) <= r + 0.8 + wobble[k++]!) {
            this.setWrapped(cx + dx, cy + dy, rim.r, rim.g, rim.b);
          }
        }
      }
      k = 0;
      for (let dy = -rr; dy <= rr; dy++) {
        for (let dx = -rr; dx <= rr; dx++) {
          const d = (this.rand() - 0.5) * 20;
          if (Math.hypot(dx, dy) <= r + wobble[k++]! * 0.6) {
            this.setWrapped(cx + dx, cy + dy, core.r + d, core.g + d, core.b + d);
          }
        }
      }
    }
    return this;
  }

  /**
   * 边缘暗化：只压**下边和右边**，不是四边。
   *
   * 为什么要有：一整面同材质的墙，如果每格贴图边上没有任何变化，
   * 铺开就是一大块均匀的色 —— 看不出是由方块砌的。
   *
   * 为什么只压两边：四边都压出来的是一圈**边框**，铺开像贴了一墙浴室瓷砖，
   * 一眼假。只压下右两边等于假设光从左上来，相邻两格之间落一道细影，
   * 既能数出格数又读作立体 —— 这也是 MC 的贴图给人的感觉。
   * 第一版做的是四边，在 2×2 平铺图上一看就是网格。
   *
   * 只作用于不透明像素：cutout 贴图（树叶、玻璃）的透明处不能碰，
   * 否则 `bleedEdges` 补的颜色会被这里改掉。
   */
  edgeShade(strength = 14): this {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const depth = Math.min(TILE - 1 - x, TILE - 1 - y);
        if (depth > 1) continue;
        const i = this.idx(x, y);
        if (this.data[i + 3]! === 0) continue;
        const f = depth === 0 ? 1 : 0.35;
        this.data[i] = this.data[i]! - strength * f;
        this.data[i + 1] = this.data[i + 1]! - strength * f;
        this.data[i + 2] = this.data[i + 2]! - strength * f;
      }
    }
    return this;
  }

  /**
   * Bayer 4×4 有序抖动：按 ratio 的比例把 c 点到现有像素上。
   *
   * 用处是在**两个相近的色**之间做过渡而不引入第三个色 —— 16 色以内的
   * 像素画传统做法。4 整除 16，所以天然平铺。
   */
  dither(c: Rgb, ratio: number): this {
    const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const i = this.idx(x, y);
        if (this.data[i + 3]! === 0) continue;
        if ((BAYER[(y % 4) * 4 + (x % 4)]! + 0.5) / 16 >= ratio) continue;
        this.data[i] = c.r;
        this.data[i + 1] = c.g;
        this.data[i + 2] = c.b;
      }
    }
    return this;
  }

  /**
   * 调色板量化：把整块贴图压到 k 种颜色。
   *
   * ## 这是"像素画"与"程序化噪声"之间最大的一道坎
   *
   * 实测本项目量化前每张贴图有 **27–59 种**不同颜色（256 个像素）。
   * 真正的 16×16 手绘像素画通常只有 **4–10 种** —— MC 1.0 的贴图就是
   * 在画图软件里选几个色一格一格点出来的。
   *
   * 颜色一多，相邻像素之间的差就变成连续渐变，观感是"喷枪扫过"；
   * 颜色一少，每一块色都有清楚的边界，观感才是"一格一格点的"。
   * 这与噪声成不成团是**两件事**：`valueNoise` 解决了"明暗成团"，
   * 但每个团内部仍是连续值，退远了看依旧发糊。
   *
   * ## 做法：确定性 k-means
   *
   * 初始质心取**按亮度排序后的等分位点** —— 不是随机撒点。
   * 随机初始化会让同一张贴图两次跑出不同结果，而贴图必须逐字节确定
   * （黄金哈希、`atlas.test.ts` 都盯着这条）。
   *
   * 只统计不透明像素：透明处的 RGB 是 `bleedEdges` 补上去的邻近色，
   * 把它们算进去会把质心往边缘色拖。
   */
  quantize(k = 6, iterations = 8): this {
    const pixels: number[] = [];
    for (let i = 0; i < TILE * TILE; i++) {
      if (this.data[i * 4 + 3]! > 0) pixels.push(i);
    }
    if (pixels.length === 0) return this;

    const lum = (i: number): number =>
      this.data[i * 4]! * 0.299 + this.data[i * 4 + 1]! * 0.587 + this.data[i * 4 + 2]! * 0.114;
    const sorted = [...pixels].sort((a, b) => lum(a) - lum(b));

    // 质心初值取亮度分位点。等分位而不是等间距 —— 贴图的亮度分布通常
    // 集中在中段，等间距会让两端的质心分不到任何像素，白白浪费色号
    const cent: number[][] = [];
    for (let c = 0; c < k; c++) {
      const i = sorted[Math.min(sorted.length - 1, Math.floor(((c + 0.5) / k) * sorted.length))]!;
      cent.push([this.data[i * 4]!, this.data[i * 4 + 1]!, this.data[i * 4 + 2]!]);
    }

    const assign = new Int32Array(TILE * TILE);
    for (let iter = 0; iter < iterations; iter++) {
      for (const i of pixels) {
        let best = 0;
        let bestD = Infinity;
        for (let c = 0; c < k; c++) {
          const dr = this.data[i * 4]! - cent[c]![0]!;
          const dg = this.data[i * 4 + 1]! - cent[c]![1]!;
          const db = this.data[i * 4 + 2]! - cent[c]![2]!;
          const d = dr * dr + dg * dg + db * db;
          if (d < bestD) { bestD = d; best = c; }
        }
        assign[i] = best;
      }
      const sum = Array.from({ length: k }, () => [0, 0, 0, 0]);
      for (const i of pixels) {
        const s = sum[assign[i]!]!;
        s[0]! += this.data[i * 4]!;
        s[1]! += this.data[i * 4 + 1]!;
        s[2]! += this.data[i * 4 + 2]!;
        s[3]! += 1;
      }
      for (let c = 0; c < k; c++) {
        const s = sum[c]!;
        // 空簇保持原位，不重新撒 —— 重撒会引入迭代间的不稳定
        if (s[3]! === 0) continue;
        cent[c] = [Math.round(s[0]! / s[3]!), Math.round(s[1]! / s[3]!), Math.round(s[2]! / s[3]!)];
      }
    }

    for (const i of pixels) {
      const c = cent[assign[i]!]!;
      this.data[i * 4] = c[0]!;
      this.data[i * 4 + 1] = c[1]!;
      this.data[i * 4 + 2] = c[2]!;
    }
    return this;
  }

  /**
   * 沿不透明区域的外缘描一圈深色轮廓。物品图标专用。
   *
   * 为什么必须有：物品图标会画在**任何背景**上 —— 物品栏的浅灰、
   * 快捷栏的半透明黑、掉在草地上时的绿。没有轮廓的图标一旦碰上
   * 明度相近的底就整个糊进去。原来的煤炭（近黑的碎点）压在深色
   * 快捷栏上几乎完全看不见，就是这个毛病。
   *
   * 只写**当前透明**的像素，所以不会吃掉图标本身的形状。
   */
  outline(c: Rgb = { r: 22, g: 20, b: 18 }, alpha = 235): this {
    const snapshot = this.data.slice();
    const solid = (x: number, y: number): boolean =>
      x >= 0 && x < TILE && y >= 0 && y < TILE && snapshot[this.idx(x, y) + 3]! > 40;
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        if (snapshot[this.idx(x, y) + 3]! > 40) continue;
        // 只看四邻，不看对角：看八邻的话轮廓会在斜边上鼓出一圈，
        // 一把剑的斜刃会变成锯齿
        if (!solid(x - 1, y) && !solid(x + 1, y) && !solid(x, y - 1) && !solid(x, y + 1)) continue;
        this.set(x, y, c.r, c.g, c.b, alpha);
      }
    }
    return this;
  }

  /**
   * 给不透明区域做体积感：右下侧邻着透明的像素压暗，左上侧的提亮。
   *
   * 与 `edgeShade` 是两回事 —— 那个按**贴图边框**算，这个按**图形轮廓**算，
   * 所以适用于物品图标这种画在透明底上的东西。
   */
  formShade(strength = 26): this {
    const snapshot = this.data.slice();
    const clear = (x: number, y: number): boolean =>
      x < 0 || x >= TILE || y < 0 || y >= TILE || snapshot[this.idx(x, y) + 3]! <= 40;
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        if (snapshot[this.idx(x, y) + 3]! <= 40) continue;
        if (clear(x + 1, y) || clear(x, y + 1)) this.shade(x, y, -strength);
        else if (clear(x - 1, y) || clear(x, y - 1)) this.shade(x, y, strength * 0.55);
      }
    }
    return this;
  }

  /**
   * 成团挖孔：噪声场超过阈值的地方把 alpha 置 0，**RGB 原样保留**。
   *
   * 保留 RGB 是 cutout 贴图的硬要求（见 `bleedEdges` 的注释）：透明处若是
   * 黑色，mipmap 会把它平均进相邻的不透明像素，树叶缩小后边缘发黑。
   *
   * 为什么要成团：逐像素独立挖孔（`noiseFill` 的 density 参数）出来是一张
   * 均匀的筛子，退开一步就是一层灰雾。真实的枝叶缝隙是几处连片的洞。
   */
  holes(threshold: number, cells = 6): this {
    const f = this.noiseField(cells, cells, 2);
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        if (f[y * TILE + x]! > threshold) this.data[this.idx(x, y) + 3] = 0;
      }
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
