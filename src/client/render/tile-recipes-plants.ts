/**
 * 植物与农作物的贴图配方：草丛、花、树苗、蘑菇、南瓜/西瓜、仙人掌、藤蔓、耕地。
 *
 * 从 `tile-recipes.ts` 拆出来（那个文件已经顶到 600 行硬上限）。这一批的
 * 共同点是**它们的形状本身就是辨识度** —— 石头靠质感，植物靠轮廓。
 * 所以这里的图元不是噪声，而是 `tuft`（扇形草丛）/ `flower`（茎+叶+花冠）
 * 这样的"画法"：原来它们全共用一个"随机游走画一条线"的 `plant()`，
 * 于是高草、树苗、玫瑰、小麦在屏幕上是同一根扭曲的细线，只有颜色不同。
 */
import { TilePainter, rgb, type Rgb } from './texgen.ts';

type Recipe = (p: TilePainter) => void;

/**
 * 一丛从同一根部散开的草叶。高草、枯灌木、甘蔗用它。
 *
 * 原来这里画的是**一根** 1px 宽的随机游走线 —— 一丛草在屏幕上就是
 * 一根挂在空中的细毛，既看不出是草，平铺一片草原时也全是同一根。
 * 真正的草丛是个**扇形**：几片叶子从同一处向外弯，越靠外越矮，
 * 叶片下半段有宽度、尖端收成 1px。
 */
function tuft(p: TilePainter, c: Rgb, blades: number, height: number): void {
  p.clear();
  // 底部留一行透明。十字植物的底边与下方草方块的顶面共面，
  // 那一行若有不透明像素就会 z-fighting，表现为地面上闪烁的杂色点
  const baseY = 14;
  for (let b = 0; b < blades; b++) {
    const half = Math.max(1, (blades - 1) / 2);
    const dir = (b - (blades - 1) / 2) / half;      // -1（最左）..1（最右）
    const h = Math.round(height * (0.55 + p.rand() * 0.45));
    let x = 8 + dir * (1 + p.rand() * 1.6);
    const curve = dir * (0.26 + p.rand() * 0.24);   // 往外弯的速率
    for (let i = 0; i < h; i++) {
      const y = baseY - i;
      const px = Math.round(x);
      if (y < 0 || px < 0 || px > 15) break;
      // 叶尖亮、叶根暗：草丛底部本来就被自己遮着
      const t = i / Math.max(1, h - 1);
      const d = -22 + t * 36 + (p.rand() - 0.5) * 12;
      p.set(px, y, c.r + d, c.g + d, c.b + d);
      // 叶片的背光侧。少了它每片叶子都是 1px 的线，一丛草读作几根铁丝
      if (t < 0.6) {
        const s = dir >= 0 ? 1 : -1;
        p.set(px + s, y, c.r + d - 26, c.g + d - 24, c.b + d - 19);
      }
      x += curve;
    }
  }
}

/**
 * 一朵花：茎 + 两片叶 + 花冠。
 *
 * 花冠不能是一个实心矩形（原来是 5×3 的纯色块，读作"贴了张色纸"）。
 * 五瓣的轮廓 + 深色花蕊 + 左上一点高光，三笔就能让它读作花。
 */
function flower(p: TilePainter, stem: Rgb, bloom: Rgb, height: number): void {
  p.clear();
  const baseY = 14;
  const topY = baseY - height;
  let x = 8;
  for (let y = baseY; y >= topY; y--) {
    if (p.rand() < 0.22) x += p.rand() < 0.5 ? -1 : 1;
    x = Math.max(5, Math.min(10, x));
    const d = (p.rand() - 0.5) * 14;
    p.set(x, y, stem.r + d, stem.g + d, stem.b + d);
    // 茎的背光侧压暗一列 —— 1px 的纯色茎是一根线，两列才是一根杆
    p.set(x + 1, y, stem.r + d - 30, stem.g + d - 26, stem.b + d - 20);
  }
  // 两片叶子，一高一低不对称。对称的两片一眼看出是镜像出来的
  for (const [ly, lx] of [[baseY - 3, x - 2], [baseY - 6, x + 2]] as const) {
    p.set(lx, ly, stem.r - 8, stem.g - 6, stem.b - 6);
    p.set(lx + (lx < x ? 1 : -1), ly, stem.r + 12, stem.g + 14, stem.b + 8);
  }
  // 花冠：中间一圈花瓣，中心花蕊压深，左上角一点高光
  const cy = topY - 1;
  const petals: readonly (readonly [number, number])[] = [
    [-1, -1], [0, -1], [1, -1],
    [-2, 0], [-1, 0], [0, 0], [1, 0], [2, 0],
    [-1, 1], [0, 1], [1, 1],
    [0, 2],
  ];
  for (const [dx, dy] of petals) {
    const d = (p.rand() - 0.5) * 26;
    p.set(x + dx, cy + dy, bloom.r + d, bloom.g + d, bloom.b + d);
  }
  p.set(x, cy, bloom.r - 46, bloom.g - 40, bloom.b - 30);       // 花蕊
  p.set(x - 1, cy - 1, bloom.r + 34, bloom.g + 30, bloom.b + 26); // 高光
}

/**
 * 树苗：一小截树干顶着一团树冠。
 *
 * 原来用的是"茎 + 一个色块"的花的画法，出来是一根绿豆芽 ——
 * 树苗的辨识度在于它是**一棵小树**：树冠要成团、要有镂空、上亮下暗。
 */
function saplingTile(p: TilePainter): void {
  p.clear();
  for (let y = 9; y < 14; y++) {
    const d = (p.rand() - 0.5) * 12;
    p.set(7, y, 0x6f + d, 0x53 + d, 0x2e + d);
    p.set(8, y, 0x4d + d, 0x39 + d, 0x1f + d);
  }
  for (let y = 1; y < 11; y++) {
    for (let x = 2; x < 14; x++) {
      const dx = (x - 7.6) / 5.2;
      const dy = (y - 5.4) / 4.8;
      if (dx * dx + dy * dy > 1) continue;
      if (p.rand() < 0.17) continue;                 // 枝叶间的缝
      const d = (p.rand() - 0.5) * 40 + (5 - y) * 3; // 上亮下暗
      p.set(x, y, 0x4f + d, 0x84 + d, 0x2f + d);
    }
  }
}

/**
 * 南瓜皮：宽窄不等的竖沟 + 沟旁的亮棱。
 *
 * 原来是每 5 列画一条 1px 的深线 —— 等距细线在 16px 上是尺子刻度，
 * 而南瓜的沟是有**宽度和深浅**的：沟底暗、沟的受光侧亮，两笔缺一不可。
 */
function pumpkinSkin(p: TilePainter): void {
  p.valueNoise(rgb(0xc07818), 18, 3, 6, 2);
  p.noiseOverlay(10, 13, 13, 1);
  let x = 0;
  for (const w of [4, 3, 5, 4] as const) {
    for (let y = 0; y < 16; y++) {
      const d = (p.rand() - 0.5) * 12;
      p.setWrapped(x, y, 0x8c + d, 0x50 + d, 0x0e + d, 255);
      p.setWrapped(x + 1, y, 0xdc + d, 0x93 + d, 0x28 + d, 255);
    }
    x += w;
  }
  // 顶上一道深色：南瓜的蒂在上面，那一圈总是暗的
  for (let i = 0; i < 16; i++) p.shade(i, 0, -20);
  p.edgeShade(10);
}

/**
 * 雕出南瓜脸。`c` 是挖空处的颜色：南瓜是近黑的洞，南瓜灯是烛光。
 *
 * 眼睛画成**三角**而不是方块 —— 方眼睛读作两个窗口。
 * 嘴用锯齿边，那是南瓜灯最有辨识度的一笔。
 */
function carveFace(p: TilePainter, c: Rgb): void {
  const put = (x: number, y: number): void => {
    const d = (p.rand() - 0.5) * 18;
    p.set(x, y, c.r + d, c.g + d, c.b + d);
  };
  for (let i = 0; i < 3; i++) {
    for (let k = 0; k <= i; k++) {
      put(4 + k, 4 + i);       // 左眼：向下张开的三角
      put(11 - k, 4 + i);      // 右眼
    }
  }
  for (let x = 4; x < 12; x++) {
    put(x, 10);
    if (x % 2 === 0) put(x, 11);   // 锯齿的牙
  }
}

/** 蘑菇：矮柄 + 伞盖 */
function mushroom(p: TilePainter, cap: Rgb, spots: boolean): void {
  p.clear();
  const stem = rgb(0xd6cfc0);
  for (let y = 9; y < 14; y++) for (let x = 7; x <= 8; x++) p.set(x, y, stem.r, stem.g, stem.b);
  for (let y = 5; y < 10; y++) {
    const half = y < 7 ? 3 : 4;
    for (let x = 8 - half; x <= 7 + half; x++) {
      const d = (p.rand() - 0.5) * 16;
      p.set(x, y, cap.r + d, cap.g + d, cap.b + d);
    }
  }
  if (spots) {
    for (let i = 0; i < 4; i++) {
      p.set(5 + Math.floor(p.rand() * 6), 6 + Math.floor(p.rand() * 3), 235, 235, 228);
    }
  }
}

export const PLANT_RECIPES: Record<string, Recipe> = {
  // --- 植物 ---
  // 高草是灰度（由 FOLIAGE tint 染色），所以基色近白
  tall_grass: (p) => tuft(p, rgb(0xcccccc), 5, 12),
  dead_bush: (p) => tuft(p, rgb(0x7a5a24), 4, 10),
  sapling: (p) => saplingTile(p),
  dandelion: (p) => flower(p, rgb(0x4f7f2f), rgb(0xf0d840), 10),
  rose: (p) => flower(p, rgb(0x4f7f2f), rgb(0xd02424), 10),
  brown_mushroom: (p) => mushroom(p, rgb(0x9b6b4b), false),
  red_mushroom: (p) => mushroom(p, rgb(0xc23a2a), true),
  melon_top: (p) => { p.valueNoise(rgb(0x6f9c3a), 12, 6, 6, 2); p.blobs(rgb(0x4f7a28), 7, 1.6, 12); p.edgeShade(9); },
  melon_side: (p) => {
    // 条纹宽度取自一个**和为 16 的不等序列**：既保证左右无缝，
    // 又不会像原来那样每 4 列一条 —— 等距条纹在 16px 上读作瓦楞板
    p.valueNoise(rgb(0x82a842), 16, 3, 7, 2);
    p.noiseOverlay(10, 14, 14, 1);
    let x = 0;
    for (const w of [3, 2, 4, 2, 3, 2] as const) {
      for (let y = 0; y < 16; y++) {
        const d = (p.rand() - 0.5) * 14;
        p.setWrapped(x, y, 0x46 + d, 0x6e + d, 0x24 + d, 255);
        if (w > 2) p.setWrapped(x + 1, y, 0x52 + d, 0x7e + d, 0x2c + d, 255);
      }
      x += w;
    }
    p.blobs(rgb(0x9cc258), 8, 1.0, 10);
    p.edgeShade(9);
  },
  pumpkin_top: (p) => { p.valueNoise(rgb(0xc07818), 11, 6, 6, 2); p.rect(6, 6, 4, 4, rgb(0x6f8a30)); p.edgeShade(9); },
  pumpkin_side: (p) => pumpkinSkin(p),
  pumpkin_face: (p) => {
    pumpkinSkin(p);
    carveFace(p, rgb(0x30200a));
  },
  jack_o_lantern_face: (p) => {
    pumpkinSkin(p);
    carveFace(p, rgb(0xf8e070));
  },
  cactus_top: (p) => { p.valueNoise(rgb(0x5a8a3a), 11, 6, 6, 2); p.blobs(rgb(0x3f6a28), 6, 1.5, 10); p.edgeShade(9); },
  /**
   * 仙人掌侧面。
   *
   * 原来是"竖纹 + 每 4 行每 5 列一个白点" —— **等距点阵**，
   * 一眼就是程序画的（判断标准里"规则网格/等距排列"说的就是这个）。
   * 改成：几道深浅不等的竖棱（仙人掌截面是星形，侧面本来就有棱），
   * 刺随机撒且每根刺下面跟一格暗影，才读得出是扎出来的而不是画上去的。
   */
  cactus_side: (p) => {
    p.valueNoise(rgb(0x4f7a30), 15, 3, 7, 2);
    p.noiseOverlay(9, 13, 13, 1);
    // 棱：宽度 2/3 交替，位置不均。等宽等距的竖条是瓦楞板
    let x = 1;
    for (const w of [2, 3, 2, 3] as const) {
      for (let y = 0; y < 16; y++) {
        p.setWrapped(x, y, 0x35, 0x59, 0x20, 255);          // 沟
        p.setWrapped(x + 1, y, 0x67, 0x94, 0x40, 255);      // 沟旁的亮棱
      }
      x += w + 2;
    }
    for (let i = 0; i < 13; i++) {
      const sx = Math.floor(p.rand() * 16);
      const sy = Math.floor(p.rand() * 16);
      p.setWrapped(sx, sy, 0xdc, 0xdc, 0xb4, 255);
      p.setWrapped(sx, sy + 1, 0x2a, 0x40, 0x1a, 255);
    }
    p.edgeShade(9);
  },
  sugar_cane_block: (p) => tuft(p, rgb(0x9ac46a), 4, 13),
  lily_pad: (p) => {
    p.clear();
    const c = rgb(0xd0d0d0);
    for (let y = 1; y < 15; y++) {
      for (let x = 1; x < 15; x++) {
        const dx = x - 7.5;
        const dy = y - 7.5;
        if (dx * dx + dy * dy > 49) continue;
        // 缺一个口，像睡莲叶
        if (dx > 0 && Math.abs(dy) < 2) continue;
        p.set(x, y, c.r, c.g, c.b);
      }
    }
  },
  vines: (p) => {
    p.clear();
    const c = rgb(0xd8d8d8);
    for (let i = 0; i < 5; i++) {
      let x = 1 + Math.floor(p.rand() * 14);
      for (let y = 0; y < 16; y++) {
        p.set(x, y, c.r, c.g, c.b);
        if (p.rand() < 0.25) x += p.rand() < 0.5 ? -1 : 1;
        x = Math.max(0, Math.min(15, x));
      }
    }
  },
  // 耕地：翻过的土，一道道垄沟。
  // 原来是"泥土色 + 三条深线"，读起来像深色木板 —— 因为线是**纯色实线**，
  // 而垄沟是有深浅的凹槽。沟底压暗、沟沿提亮才立得起来
  farmland: (p) => {
    p.valueNoise(rgb(0x6f4a2a), 22, 5, 5, 3);
    p.noiseOverlay(11, 13, 13, 1);
    p.blobs(rgb(0x55361d), 10, 1.4, 12);
    p.blobs(rgb(0x8b6039), 7, 1.1, 10);
    // 垄沟。原来是三条**等宽的整行实线**，在棕底上读作深色木板缝 ——
    // 板缝笔直等宽，而犁出来的沟是歪的、深浅不匀的。
    // 沟位沿 x 用一维噪声上下摆一格，沟底的暗度也跟着摆
    const f = p.noiseField(5, 1, 2);
    for (const y0 of [2, 7, 12]) {
      for (let x = 0; x < 16; x++) {
        const v = f[x]!;
        const wob = v > 0.62 ? 1 : v < 0.34 ? -1 : 0;
        const deep = 24 + v * 22;
        p.shade(x, y0 + wob, -deep);
        p.shade(x, y0 + wob + 1, -deep * 0.45);
        p.shade(x, y0 + wob - 1, 14);          // 沟沿受光
      }
    }
    p.edgeShade(11);
  },
  /**
   * 小麦。四根竖秆 + 麦穗。
   *
   * 原来复用的是"随机游走一条线"的画法 —— 一片麦田看着像地上插了一堆
   * 歪扭的黄线。麦子是**直立**的，辨识度在秆顶那一串鼓出来的麦粒。
   * 秆的间距要不等：等距四根是一把梳子。
   */
  wheat_crop: (p) => {
    p.clear();
    let x = 1 + Math.floor(p.rand() * 2);
    while (x < 15) {
      const top = 2 + Math.floor(p.rand() * 3);
      for (let y = 15; y >= top; y--) {
        const d = (p.rand() - 0.5) * 16;
        p.set(x, y, 0xb8 + d, 0x9e + d, 0x3c + d);
        // 麦穗：上半段两侧鼓出麦粒，交错着长
        if (y < top + 6 && (y + x) % 2 === 0) {
          const s = (y % 4 < 2) ? 1 : -1;
          p.set(x + s, y, 0xe2 + d, 0xc8 + d, 0x54 + d);
        }
      }
      x += 3 + Math.floor(p.rand() * 2);
    }
  },
  nether_wart_block: (p) => tuft(p, rgb(0x8f1f2e), 4, 9),
  // 海绵的辨识度全在**孔**上。原来撒的是 18 个随机方点，读作"脏"；
  // 成团的暗窝才读作"多孔"
  sponge: (p) => {
    p.valueNoise(rgb(0xc6c64a), 13, 6, 6, 2);
    p.blobs(rgb(0x8a8a2a), 9, 1.8, 14);
    p.blobs(rgb(0x6a6a1a), 6, 1.2, 10);
    p.edgeShade(10);
  },
};
