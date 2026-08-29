/**
 * 贴图配方表。每张 16×16 原创像素画的画法。
 *
 * 关于染色：草和树叶的贴图画成**接近白的灰度**，最终颜色由 TintKind 在着色器里相乘 ——
 * 这与 MC 的做法一致，也是让不同群系共用同一张贴图的前提。现在就画成灰度，
 * M4 接入群系色表时不必重画。
 */
import { TilePainter, rgb, type Rgb } from './texgen.ts';

type Recipe = (p: TilePainter) => void;

/** 错缝砖格，用于圆石、石砖、红砖 */
function brickGrid(p: TilePainter, base: Rgb, mortar: Rgb, cellW: number, cellH: number, jitter: number): void {
  p.noiseFill(mortar, 8);
  const rows = Math.ceil(16 / cellH);
  for (let row = 0; row < rows; row++) {
    const offset = (row % 2) * Math.floor(cellW / 2);
    for (let col = -1; col < Math.ceil(16 / cellW) + 1; col++) {
      const x0 = col * cellW + offset;
      const d = (p.rand() - 0.5) * jitter;
      p.rect(x0, row * cellH, cellW - 1, cellH - 1, {
        r: base.r + d,
        g: base.g + d,
        b: base.b + d,
      });
    }
  }
}

/** 在透明底上画一株十字植物的正面 */
function plant(p: TilePainter, stem: Rgb, bloom: Rgb | null, height: number): void {
  // 先全透明
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) p.set(x, y, 0, 0, 0, 0);
  const baseY = 15;
  const topY = baseY - height;
  let cx = 8;
  for (let y = baseY; y >= topY; y--) {
    if (p.rand() < 0.25) cx += p.rand() < 0.5 ? -1 : 1;
    cx = Math.max(4, Math.min(11, cx));
    const d = (p.rand() - 0.5) * 20;
    p.set(cx, y, stem.r + d, stem.g + d, stem.b + d);
    // 偶尔长出侧叶
    if (p.rand() < 0.3) p.set(cx + (p.rand() < 0.5 ? -1 : 1), y, stem.r + d, stem.g + d, stem.b + d);
  }
  if (bloom !== null) {
    for (let dy = 0; dy < 3; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.abs(dx) === 2 && dy !== 1) continue;
        const d = (p.rand() - 0.5) * 24;
        p.set(cx + dx, topY - 1 + dy, bloom.r + d, bloom.g + d, bloom.b + d);
      }
    }
  }
}

/** 蘑菇：矮柄 + 伞盖 */
function mushroom(p: TilePainter, cap: Rgb, spots: boolean): void {
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) p.set(x, y, 0, 0, 0, 0);
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

export const RECIPES: Record<string, Recipe> = {
  // --- 地形 ---
  stone: (p) => { p.noiseFill(rgb(0x808080), 20); p.speckles(rgb(0x6f6f6f), 6, 2); },
  dirt: (p) => { p.noiseFill(rgb(0x866043), 22); p.speckles(rgb(0x6f4f38), 5, 2); },
  // grass_top 是灰度，颜色由群系 tint 乘上去
  grass_top: (p) => { p.noiseFill(rgb(0xd8d8d8), 22); },
  // grass_side **不染色**（方块定义里 tintFaces 只勾了 UP 面），所以这里必须画成彩色：
  // 下半是泥土本色，顶部长出一圈绿色草边。整块染色会把泥土也染绿。
  grass_side: (p) => { p.noiseFill(rgb(0x866043), 22); p.grassOverlay(rgb(0x6aa03c), [2, 5]); },
  sand: (p) => { p.noiseFill(rgb(0xe0d8b0), 12); },
  gravel: (p) => { p.noiseFill(rgb(0x8a8a8a), 26); p.speckles(rgb(0x6a6a6a), 10, 2); },
  clay: (p) => { p.noiseFill(rgb(0xa4a8b8), 12); },
  bedrock: (p) => { p.noiseFill(rgb(0x525252), 30); p.speckles(rgb(0x2a2a2a), 12, 3); },
  snow: (p) => { p.noiseFill(rgb(0xf0f5f5), 8); },
  ice: (p) => { p.noiseFill(rgb(0x9ec4f0), 14); p.speckles(rgb(0xbcd8f8), 5, 3); },
  mycelium_top: (p) => { p.noiseFill(rgb(0x6f6167), 20); p.speckles(rgb(0x8b7b86), 12, 2); },
  mycelium_side: (p) => { p.noiseFill(rgb(0x866043), 22); p.grassOverlay(rgb(0x6f6167)); },
  end_stone: (p) => { p.noiseFill(rgb(0xdcdca8), 14); p.speckles(rgb(0xc4c48c), 6, 2); },
  netherrack: (p) => { p.noiseFill(rgb(0x703434), 26); p.speckles(rgb(0x5a2828), 8, 2); },
  soul_sand: (p) => { p.noiseFill(rgb(0x53403a), 18); p.speckles(rgb(0x3a2b26), 6, 3); },
  glowstone: (p) => { p.noiseFill(rgb(0xceac6b), 18); p.speckles(rgb(0xf8e8a8), 10, 2); },

  // --- 砖块类 ---
  cobblestone: (p) => brickGrid(p, rgb(0x7f7f7f), rgb(0x5c5c5c), 4, 4, 34),
  mossy_cobblestone: (p) => { brickGrid(p, rgb(0x6f7d64), rgb(0x4e5a48), 4, 4, 30); p.speckles(rgb(0x5d7a4a), 8, 2); },
  stone_bricks: (p) => brickGrid(p, rgb(0x7a7a7a), rgb(0x5f5f5f), 8, 4, 16),
  bricks: (p) => brickGrid(p, rgb(0x96604c), rgb(0xb0b0b0), 8, 4, 14),
  sandstone: (p) => { p.noiseFill(rgb(0xd8ce9e), 10); p.hLine(0, rgb(0xc0b684)); p.hLine(4, rgb(0xc8be8e)); p.hLine(12, rgb(0xc8be8e)); },

  // --- 矿石：石头底 + 矿物斑点 ---
  coal_ore: (p) => { p.noiseFill(rgb(0x808080), 20); p.speckles(rgb(0x1a1a1a), 6, 2); },
  iron_ore: (p) => { p.noiseFill(rgb(0x808080), 20); p.speckles(rgb(0xd8a882), 6, 2); },
  gold_ore: (p) => { p.noiseFill(rgb(0x808080), 20); p.speckles(rgb(0xf0d048), 5, 2); },
  diamond_ore: (p) => { p.noiseFill(rgb(0x808080), 20); p.speckles(rgb(0x5decdc), 5, 2); },
  lapis_ore: (p) => { p.noiseFill(rgb(0x808080), 20); p.speckles(rgb(0x2b4bab), 6, 2); },
  redstone_ore: (p) => { p.noiseFill(rgb(0x808080), 20); p.speckles(rgb(0xd02020), 6, 2); },

  // --- 金属与宝石方块 ---
  gold_block: (p) => { p.noiseFill(rgb(0xf2d33c), 10); p.rect(1, 1, 14, 14, rgb(0xfae05c)); p.noiseFill(rgb(0xf2d33c), 6); },
  iron_block: (p) => { p.noiseFill(rgb(0xdbdbdb), 8); },
  diamond_block: (p) => { p.noiseFill(rgb(0x64e6dc), 12); p.speckles(rgb(0x9ff2ea), 6, 2); },
  lapis_block: (p) => { p.noiseFill(rgb(0x2b4bab), 18); p.speckles(rgb(0x3f63c8), 8, 2); },

  // --- 木材 ---
  planks: (p) => {
    p.noiseFill(rgb(0xb08a52), 14);
    const seam = rgb(0x8a6a3c);
    p.hLine(0, seam); p.hLine(5, seam); p.hLine(10, seam); p.hLine(15, seam);
  },
  log_side: (p) => {
    p.noiseFill(rgb(0x6b5030), 16);
    for (let x = 0; x < 16; x += 4) p.vLine(x, rgb(0x54401f));
  },
  log_top: (p) => {
    p.noiseFill(rgb(0x9a7b4f), 14);
    for (const r of [2, 4, 6]) {
      for (let a = 0; a < 72; a++) {
        const t = (a / 72) * Math.PI * 2;
        p.set(Math.round(7.5 + Math.cos(t) * r), Math.round(7.5 + Math.sin(t) * r), 0x6b, 0x50, 0x30);
      }
    }
  },
  // 灰度：由 FOLIAGE tint 染色
  leaves: (p) => { p.noiseFill(rgb(0xcfcfcf), 34, 0.86); },
  bookshelf: (p) => {
    p.noiseFill(rgb(0xb08a52), 12);
    for (const rowY of [1, 9]) {
      for (let x = 0; x < 16; x += 3) {
        const hue = [0x8b3a3a, 0x3a5f8b, 0x4f8b3a, 0x8b7a3a][Math.floor(p.rand() * 4)] ?? 0x8b3a3a;
        p.rect(x, rowY, 2, 6, rgb(hue));
      }
    }
  },
  crafting_table_top: (p) => {
    p.noiseFill(rgb(0xa5763f), 12);
    for (let i = 1; i < 3; i++) { p.hLine(i * 5, rgb(0x6b4a24)); p.vLine(i * 5, rgb(0x6b4a24)); }
  },
  crafting_table_side: (p) => {
    p.noiseFill(rgb(0xb08a52), 12);
    p.rect(0, 0, 16, 4, rgb(0x8a6a3c));
    p.rect(2, 6, 5, 4, rgb(0x7a5a2c));
    p.rect(9, 6, 5, 4, rgb(0x7a5a2c));
  },

  // --- 熔炉 ---
  furnace_top: (p) => { p.noiseFill(rgb(0x707070), 16); p.rect(4, 4, 8, 8, rgb(0x5e5e5e)); },
  furnace_side: (p) => { p.noiseFill(rgb(0x707070), 16); },
  furnace_front: (p) => {
    p.noiseFill(rgb(0x707070), 16);
    p.rect(3, 5, 10, 8, rgb(0x2e2e2e));
    p.rect(4, 6, 8, 2, rgb(0x4a4a4a));
  },

  // --- 其它 ---
  glass: (p) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) p.set(x, y, 0, 0, 0, 0);
    const frame = rgb(0xd0e8f0);
    for (let x = 0; x < 16; x++) { p.set(x, 0, frame.r, frame.g, frame.b); p.set(x, 15, frame.r, frame.g, frame.b); }
    for (let y = 0; y < 16; y++) { p.set(0, y, frame.r, frame.g, frame.b); p.set(15, y, frame.r, frame.g, frame.b); }
    // 几笔高光，让玻璃不至于是个纯空框
    for (let i = 0; i < 5; i++) {
      const x = 2 + Math.floor(p.rand() * 12);
      const y = 2 + Math.floor(p.rand() * 12);
      p.set(x, y, 0xe8, 0xf4, 0xf8, 140);
    }
  },
  wool: (p) => { p.noiseFill(rgb(0xe6e6e6), 10); },
  obsidian: (p) => { p.noiseFill(rgb(0x160f22), 14); p.speckles(rgb(0x2f2340), 8, 2); },

  // --- 植物 ---
  tall_grass: (p) => plant(p, rgb(0xc8c8c8), null, 11),
  dead_bush: (p) => plant(p, rgb(0x6f5321), null, 10),
  sapling: (p) => plant(p, rgb(0x4f7f2f), rgb(0x3f7a28), 9),
  dandelion: (p) => plant(p, rgb(0x4f7f2f), rgb(0xf0e050), 10),
  rose: (p) => plant(p, rgb(0x4f7f2f), rgb(0xd02020), 10),
  brown_mushroom: (p) => mushroom(p, rgb(0x9b6b4b), false),
  red_mushroom: (p) => mushroom(p, rgb(0xc23a2a), true),
};

export const TILE_NAMES: readonly string[] = Object.keys(RECIPES);
