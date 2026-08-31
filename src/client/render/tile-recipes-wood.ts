/**
 * 木制品与机器方块的贴图配方：箱子、梯子、活板门、门、铁轨、活塞、唱片机、床、蛋糕。
 *
 * 从 `tile-recipes.ts` 拆出来，一是那个文件已经越过 400 行软上限，
 * 二是这一批有一个**共同的毛病**值得放一处一起治：
 *
 *   原来的梯子/活板门/铁轨/门全都是"一个 rgb() 填一片" —— 整根木条只有
 *   **一种颜色**。16×16 上一根 2px 宽的纯色木条读起来是塑料条，不是木棍。
 *   木棍之所以是圆的，靠的是"左边一列亮、右边一列暗"这两笔；横档之所以
 *   有厚度，靠的是"上沿亮、下沿暗"。这里统一用 `stickV` / `stickH` 来画，
 *   顺带给每根都掺一点纵向的色差（同一堆木料也不会根根同色）。
 */
import { rgb, type TilePainter, type Rgb } from './texgen.ts';
import { woodBase, inset } from './tile-materials.ts';

type Recipe = (p: TilePainter) => void;

/**
 * 一根**竖着**的圆木条：左列受光提亮、右列背光压暗，中间保持本色。
 *
 * 写错会看到什么：不分明暗的话，两三根并排的立柱会连成一片同色的板，
 * 梯子看着像贴在墙上的木门而不是几根木棍。
 */
function stickV(p: TilePainter, x0: number, w: number, c: Rgb, y0 = 0, y1 = 16): void {
  for (let y = y0; y < y1; y++) {
    // 沿长度方向的轻微色差 —— 一根木头从上到下不是同一个色
    const g = (p.rand() - 0.5) * 13;
    for (let k = 0; k < w; k++) {
      const lift = k === 0 ? 24 : k === w - 1 ? -26 : 0;
      p.set(x0 + k, y, c.r + g + lift, c.g + g + lift * 0.92, c.b + g + lift * 0.8);
    }
  }
}

/** 一根**横着**的圆木条：上沿亮、下沿暗 */
function stickH(p: TilePainter, y0: number, h: number, c: Rgb, x0 = 0, x1 = 16): void {
  for (let x = x0; x < x1; x++) {
    const g = (p.rand() - 0.5) * 13;
    for (let k = 0; k < h; k++) {
      const lift = k === 0 ? 24 : k === h - 1 ? -26 : 0;
      p.set(x, y0 + k, c.r + g + lift, c.g + g + lift * 0.92, c.b + g + lift * 0.8);
    }
  }
}

/**
 * 木板面：底噪 + 几道**深浅不一**的木纹丝。
 *
 * `woodBase`（各向异性格点噪声）只给出"沿板长变化慢"的大块明暗，
 * 缺的是木材真正的辨识特征 —— 一道道细长的纹丝。少了它，一扇门就是
 * 一块被 blur 过的棕色，色阶两三级，塑料感的来源。
 */
function woodFibers(p: TilePainter, count: number, vertical: boolean): void {
  for (let i = 0; i < count; i++) {
    const along = Math.floor(p.rand() * 16);
    const dark = p.rand() < 0.62;
    const d = dark ? -(16 + p.rand() * 16) : 12 + p.rand() * 12;
    let off = along;
    for (let t = 0; t < 16; t++) {
      // 纹丝要**歪**：笔直的一条在 16px 上看是尺子画的
      if (p.rand() < 0.16) off += p.rand() < 0.5 ? -1 : 1;
      const x = vertical ? off : t;
      const y = vertical ? t : off;
      p.shade(((x % 16) + 16) % 16, ((y % 16) + 16) % 16, d);
    }
  }
}

export const WOOD_RECIPES: Record<string, Recipe> = {
  // --- 箱子 ---
  // 箱子的辨识度是"盖 / 身两截 + 中间一道金属扣"。原来三张都只是
  // 木底加一条深色带，盖和身分不开；这里给盖底压一道暗缝、身上再补纹丝
  chest_top: (p) => {
    woodBase(p, rgb(0x9a6f3f));
    woodFibers(p, 6, false);
    p.rect(0, 0, 16, 1, rgb(0x6f4f2a));
    inset(p, 1);
    p.edgeShade(9);
  },
  chest_side: (p) => {
    woodBase(p, rgb(0x9a6f3f));
    woodFibers(p, 6, false);
    // 盖与身之间的那道缝：上面一行暗（缝底），下面一行亮（身的顶沿受光）
    p.rect(0, 5, 16, 2, rgb(0x5d4123));
    for (let x = 0; x < 16; x++) p.shade(x, 7, 18);
    inset(p, 1);
    p.edgeShade(9);
  },
  chest_front: (p) => {
    woodBase(p, rgb(0x9a6f3f));
    woodFibers(p, 6, false);
    p.rect(0, 5, 16, 2, rgb(0x5d4123));
    for (let x = 0; x < 16; x++) p.shade(x, 7, 18);
    // 锁扣：黄铜色的一小块 + 深色描边 + 左上一点高光。
    // 没有描边的话它就是一块贴上去的黄色，读不出是金属件
    p.rect(6, 5, 4, 5, rgb(0x2f2413));
    p.rect(7, 6, 2, 3, rgb(0xd8c060));
    p.shade(7, 6, 30);
    p.shade(8, 8, -34);
    inset(p, 1);
    p.edgeShade(9);
  },

  // --- 梯子 / 活板门 / 门：木条件 ---
  ladder: (p) => {
    p.clear();
    const wood = rgb(0x9a7a44);
    // 先画横档再画立柱：立柱在前，横档才像是"钉在柱子后面"
    for (const y of [1, 6, 11]) stickH(p, y, 2, { r: 0x8a, g: 0x6c, b: 0x3c }, 3, 13);
    stickV(p, 2, 2, wood);
    stickV(p, 12, 2, wood);
  },
  trapdoor: (p) => {
    p.clear();
    const wood = rgb(0x96763f);
    for (const y of [0, 7, 13]) stickH(p, y, 3, wood);
    for (const x of [0, 13]) stickV(p, x, 3, { r: 0x8c, g: 0x6d, b: 0x39 });
  },
  door_lower: (p) => {
    woodBase(p, rgb(0x8f7040), true);
    woodFibers(p, 10, true);
    // 两块下沉的门板。凹陷靠 inset 的反向光照（左上暗、右下亮）来读，
    // 单画一个深色矩形只是"贴了块深色布"
    for (const [y0, h] of [[1, 6], [9, 6]] as const) {
      // 用 shade 整体压暗，**不能用 rect** —— rect 是覆盖写，会把刚画好的
      // 木纹在面板范围内整片抹掉，剩下一块纯色。原来那扇门平得像纸板
      // 就是这一句造成的
      for (let y = y0; y < y0 + h; y++) for (let x = 1; x < 15; x++) p.shade(x, y, -16);
      for (let i = 1; i < 15; i++) { p.shade(i, y0, -30); p.shade(i, y0 + h - 1, 24); }
      for (let i = y0; i < y0 + h; i++) { p.shade(1, i, -30); p.shade(14, i, 24); }
    }
    // 门把手：铁的小圆钮，带暗边才不像一颗白牙
    p.rect(11, 7, 3, 2, rgb(0x4a4a4a));
    p.rect(12, 7, 2, 1, rgb(0xcfcfcf));
    p.edgeShade(9);
  },

  // --- 铁轨 ---
  rail: (p) => {
    p.clear();
    // 枕木：横着的木条，上沿亮下沿暗
    for (let y = 1; y < 16; y += 4) stickH(p, y, 2, { r: 0x8a, g: 0x6a, b: 0x3a }, 1, 15);
    // 钢轨：亮面 + 暗面两列，中间那条高光才读得出是圆头钢轨
    for (const x of [4, 10]) {
      for (let y = 0; y < 16; y++) {
        const g = (p.rand() - 0.5) * 16;
        p.set(x, y, 0x60 + g, 0x60 + g, 0x66 + g);
        p.set(x + 1, y, 0xd2 + g, 0xd4 + g, 0xd8 + g);
      }
    }
  },

  // --- 唱片机 / 音符盒 ---
  jukebox_top: (p) => {
    woodBase(p, rgb(0x8a6a45));
    woodFibers(p, 6, false);
    p.rect(4, 4, 8, 8, rgb(0x2a2a2a));
    // 唱片：黑盘中间一点红标，比一个纯黑方块像唱片得多
    p.rect(6, 6, 4, 4, rgb(0x1a1a1a));
    p.rect(7, 7, 2, 2, rgb(0x9a3030));
    inset(p, 4, -18, -12);
    p.edgeShade(9);
  },
  jukebox_side: (p) => {
    woodBase(p, rgb(0x8a6a45));
    woodFibers(p, 7, false);
    p.rect(0, 13, 16, 3, rgb(0x6a4f34));
    for (let x = 0; x < 16; x++) p.shade(x, 13, 16);
    p.edgeShade(9);
  },
  note_block: (p) => {
    woodBase(p, rgb(0x7a5a3a));
    woodFibers(p, 8, false);
    p.blobs(rgb(0x4a3a2a), 9, 1.2, 10);
    p.blobs(rgb(0x9a7a55), 6, 1.0, 8);
    p.edgeShade(9);
  },

  // --- 活塞 ---
  piston_side: (p) => {
    woodBase(p, rgb(0x9a8a6a), true);
    woodFibers(p, 6, true);
    p.rect(0, 0, 16, 2, rgb(0x6a5a3a));
    p.rect(0, 14, 16, 2, rgb(0x6a5a3a));
    for (let x = 0; x < 16; x += 5) p.rect(x, 2, 1, 12, rgb(0x7a6a4a));
  },
  piston_top: (p) => {
    p.valueNoise(rgb(0xb8a878), 12, 6, 6, 2);
    p.rect(1, 1, 14, 14, rgb(0x8a7a5a));
    p.rect(3, 3, 10, 10, rgb(0xb0a070));
    p.noiseOverlay(9, 12, 12, 1);
    inset(p, 3);
    p.edgeShade(8);
  },
  piston_top_sticky: (p) => {
    p.valueNoise(rgb(0xb8a878), 12, 6, 6, 2);
    p.rect(1, 1, 14, 14, rgb(0x8a7a5a));
    // 粘性活塞顶上那一圈绿 —— 唯一能一眼分辨两种活塞的地方。
    // 斑点必须**只落在那一圈里**：撒满整块会把外框也点绿，两种活塞反而更难分
    p.rect(3, 3, 10, 10, rgb(0x7aa03a));
    for (let i = 0; i < 20; i++) {
      const x = 3 + Math.floor(p.rand() * 10);
      const y = 3 + Math.floor(p.rand() * 10);
      p.shade(x, y, p.rand() < 0.5 ? -26 : 22);
    }
    inset(p, 3);
    p.edgeShade(8);
  },
  piston_bottom: (p) => {
    woodBase(p, rgb(0x8a7a5a));
    woodFibers(p, 7, false);
    p.blobs(rgb(0x6a5a3a), 9, 1.3, 10);
    p.edgeShade(9);
  },

  // --- 床 / 蛋糕 ---
  cake_top: (p) => {
    p.valueNoise(rgb(0xf2ead6), 10, 7, 7, 2);
    p.noiseOverlay(8, 14, 14, 1);
    // 顶上那层糖霜：小而多的红点，不是一整片红
    p.blobs(rgb(0xd04040), 11, 1.1, 12);
    p.blobs(rgb(0xffffff), 6, 0.9, 6);
    p.edgeShade(8);
  },
  cake_bottom: (p) => { woodBase(p, rgb(0x8a6a45)); woodFibers(p, 6, false); p.edgeShade(8); },
  cake_side: (p) => {
    p.valueNoise(rgb(0xf2ead6), 10, 7, 7, 2);
    p.noiseOverlay(8, 14, 14, 1);
    p.rect(0, 0, 16, 3, rgb(0xd04040));
    p.noiseOverlay(9, 8, 4, 1);
    p.rect(0, 12, 16, 4, rgb(0x8a6a45));
    for (let x = 0; x < 16; x++) p.shade(x, 12, 16);
    p.edgeShade(8);
  },
  bed_top: (p) => {
    p.valueNoise(rgb(0xbe3030), 16, 6, 6, 2);
    p.noiseOverlay(9, 13, 13, 1);
    p.rect(0, 0, 16, 4, rgb(0xeeeeee));
    p.noiseOverlay(8, 9, 5, 1);
    // 枕头与被子的分界压一道影，两块布才分得开
    for (let x = 0; x < 16; x++) p.shade(x, 4, -24);
    p.edgeShade(9);
  },
  bed_side: (p) => {
    p.valueNoise(rgb(0xbe3030), 16, 6, 6, 2);
    p.noiseOverlay(9, 13, 13, 1);
    // 下面四行是床架的木头，被子搭在上面
    p.rect(0, 11, 16, 5, rgb(0x8a6a44));
    p.noiseOverlay(10, 5, 10, 1);
    for (let x = 0; x < 16; x++) p.shade(x, 11, -26);
    p.edgeShade(9);
  },
};
