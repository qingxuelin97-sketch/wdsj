/**
 * 贴图配方表。每张 16×16 原创像素画的画法。
 *
 * 关于染色：草和树叶的贴图画成**接近白的灰度**，最终颜色由 TintKind 在着色器里相乘 ——
 * 这与 MC 的做法一致，也是让不同群系共用同一张贴图的前提。现在就画成灰度，
 * M4 接入群系色表时不必重画。
 */
import { TilePainter, rgb, mulberry32, fnv1a, type Rgb } from './texgen.ts';
import { SKY_RECIPES } from './tile-recipes-sky.ts';

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
  // 底部留一行透明。十字植物的底边与下方草方块的顶面正好共面，
  // 那一行若有不透明像素就会 z-fighting，表现为地面上闪烁的杂色点。
  // MC 的植物贴图同样是不贴底的。
  const baseY = 14;
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

  // --- M7 的非立方体方块贴图 ---
  stone_slab_top: (p) => { p.noiseFill(rgb(0x9a9a9a), 14); p.speckles(rgb(0x848484), 5, 2); },
  stone_slab_side: (p) => {
    // 侧面上下各一道细边，半砖叠起来时能看出接缝
    p.noiseFill(rgb(0x8e8e8e), 14);
    const edge = rgb(0xa8a8a8);
    for (let x = 0; x < 16; x++) { p.set(x, 0, edge.r, edge.g, edge.b); p.set(x, 15, edge.r, edge.g, edge.b); }
  },
  torch: (p) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) p.set(x, y, 0, 0, 0, 0);
    // 木棍
    const stick = rgb(0x8a6a3a);
    for (let y = 6; y < 16; y++) for (let x = 7; x <= 8; x++) p.set(x, y, stick.r, stick.g, stick.b);
    // 火焰头
    for (let y = 2; y < 6; y++) {
      for (let x = 6; x <= 9; x++) {
        const hot = y < 4;
        const c = hot ? rgb(0xfff0a0) : rgb(0xf0a020);
        if (x === 6 || x === 9) { if (y < 3) continue; }
        p.set(x, y, c.r, c.g, c.b);
      }
    }
  },
  ladder: (p) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) p.set(x, y, 0, 0, 0, 0);
    const wood = rgb(0x9a7a44);
    for (let y = 0; y < 16; y++) { for (const x of [2, 3, 12, 13]) p.set(x, y, wood.r, wood.g, wood.b); }
    for (const y of [2, 7, 12]) { for (let x = 3; x < 13; x++) { p.set(x, y, wood.r, wood.g, wood.b); p.set(x, y + 1, wood.r, wood.g, wood.b); } }
  },
  cake_top: (p) => { p.noiseFill(rgb(0xf7f0e0), 8); p.speckles(rgb(0xd04040), 10, 2); },
  cake_bottom: (p) => { p.noiseFill(rgb(0x8a6a45), 10); },
  cake_side: (p) => {
    p.noiseFill(rgb(0xf7f0e0), 8);
    p.rect(0, 0, 16, 3, rgb(0xd04040));
    p.rect(0, 12, 16, 4, rgb(0x8a6a45));
  },
  door_lower: (p) => {
    p.noiseFill(rgb(0x9a7a4a), 12);
    p.rect(1, 1, 14, 6, rgb(0x8a6a3c));
    p.rect(1, 9, 14, 6, rgb(0x8a6a3c));
    p.rect(12, 7, 2, 2, rgb(0xd8d8d8));
  },
  trapdoor: (p) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) p.set(x, y, 0, 0, 0, 0);
    const wood = rgb(0x9a7a44);
    for (const y of [1, 2, 7, 8, 13, 14]) for (let x = 0; x < 16; x++) p.set(x, y, wood.r, wood.g, wood.b);
    for (const x of [1, 2, 13, 14]) for (let y = 0; y < 16; y++) p.set(x, y, wood.r, wood.g, wood.b);
  },
  bed_top: (p) => { p.noiseFill(rgb(0xc03030), 12); p.rect(0, 0, 16, 4, rgb(0xf0f0f0)); },
  bed_side: (p) => { p.noiseFill(rgb(0xc03030), 12); p.rect(0, 11, 16, 5, rgb(0x9a7a44)); },
  rail: (p) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) p.set(x, y, 0, 0, 0, 0);
    const tie = rgb(0x8a6a3a);
    for (let y = 1; y < 16; y += 4) for (let x = 2; x < 14; x++) { p.set(x, y, tie.r, tie.g, tie.b); p.set(x, y + 1, tie.r, tie.g, tie.b); }
    const metal = rgb(0xc0c0c0);
    for (let y = 0; y < 16; y++) { for (const x of [4, 5, 10, 11]) p.set(x, y, metal.r, metal.g, metal.b); }
  },

  // --- M8 批的贴图 ---
  chest_top: (p) => { p.noiseFill(rgb(0x9a6f3f), 10); p.rect(0, 0, 16, 1, rgb(0x6f4f2a)); },
  chest_side: (p) => { p.noiseFill(rgb(0x9a6f3f), 10); p.rect(0, 5, 16, 2, rgb(0x6f4f2a)); },
  chest_front: (p) => {
    p.noiseFill(rgb(0x9a6f3f), 10);
    p.rect(0, 5, 16, 2, rgb(0x6f4f2a));
    p.rect(7, 6, 2, 4, rgb(0xd8c060));   // 锁扣
  },
  tnt_top: (p) => { p.noiseFill(rgb(0xd03028), 12); p.rect(2, 2, 12, 12, rgb(0xa02018)); },
  tnt_bottom: (p) => { p.noiseFill(rgb(0x7a6a5a), 12); },
  tnt_side: (p) => {
    p.noiseFill(rgb(0xd03028), 12);
    p.rect(0, 5, 16, 6, rgb(0xf0f0f0));
    // 中间那圈白带上写点东西的感觉
    for (let x = 2; x < 14; x += 3) p.rect(x, 7, 2, 2, rgb(0x303030));
  },
  jukebox_top: (p) => { p.noiseFill(rgb(0x8a6a45), 12); p.rect(4, 4, 8, 8, rgb(0x303030)); },
  jukebox_side: (p) => { p.noiseFill(rgb(0x8a6a45), 12); p.rect(0, 13, 16, 3, rgb(0x6a4f34)); },
  note_block: (p) => { p.noiseFill(rgb(0x7a5a3a), 12); p.speckles(rgb(0x4a3a2a), 8, 2); },
  dispenser_front: (p) => {
    p.noiseFill(rgb(0x7a7a7a), 14);
    p.rect(4, 4, 8, 8, rgb(0x3a3a3a));
    p.rect(6, 6, 4, 4, rgb(0x1a1a1a));
  },
  lever: (p) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) p.set(x, y, 0, 0, 0, 0);
    const wood = rgb(0x8a6a3a);
    for (let y = 4; y < 16; y++) for (let x = 7; x <= 8; x++) p.set(x, y, wood.r, wood.g, wood.b);
    const knob = rgb(0x9a9a9a);
    for (let y = 2; y < 5; y++) for (let x = 6; x <= 9; x++) p.set(x, y, knob.r, knob.g, knob.b);
  },
  // 红石线：灰度的十字，颜色由 TintKind.REDSTONE 按信号强度决定深浅。
  // 画成十字而不是单条线，是因为线的连接方向是每帧由邻居推出来的，
  // 一张能同时当直线和拐角用的贴图省掉了十六种朝向的图
  redstone_wire: (p) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) p.set(x, y, 0, 0, 0, 0);
    for (let i = 0; i < 16; i++) {
      for (let w = 6; w <= 9; w++) {
        const d = (p.rand() - 0.5) * 24;
        p.set(i, w, 235 + d, 235 + d, 235 + d);
        p.set(w, i, 235 + d, 235 + d, 235 + d);
      }
    }
  },
  piston_side: (p) => {
    p.noiseFill(rgb(0x9a8a6a), 12);
    // 上下各一道深色包边，看着像一截木质的筒身
    p.rect(0, 0, 16, 2, rgb(0x6a5a3a));
    p.rect(0, 14, 16, 2, rgb(0x6a5a3a));
    for (let x = 0; x < 16; x += 5) p.rect(x, 2, 1, 12, rgb(0x7a6a4a));
  },
  piston_top: (p) => {
    p.noiseFill(rgb(0xb8a878), 10);
    p.rect(1, 1, 14, 14, rgb(0x8a7a5a));
    p.rect(3, 3, 10, 10, rgb(0xb0a070));
  },
  piston_top_sticky: (p) => {
    p.noiseFill(rgb(0xb8a878), 10);
    p.rect(1, 1, 14, 14, rgb(0x8a7a5a));
    // 粘性活塞顶上那一圈绿 —— 唯一能一眼分辨两种活塞的地方
    p.rect(3, 3, 10, 10, rgb(0x7aa03a));
    p.speckles(rgb(0x5a8020), 12, 2);
  },
  piston_bottom: (p) => {
    p.noiseFill(rgb(0x8a7a5a), 12);
    p.speckles(rgb(0x6a5a3a), 10, 2);
  },

  // 熄灭的红石火把：与亮着的同形，只是头上那点是暗红的
  redstone_torch_off: (p) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) p.set(x, y, 0, 0, 0, 0);
    for (let y = 6; y < 16; y++) p.rect(7, y, 2, 1, rgb(0x6a4a2a));
    p.rect(6, 4, 4, 3, rgb(0x5a1a1a));
  },
  repeater_block_on: (p) => {
    p.noiseFill(rgb(0xb0a8a0), 8);
    p.rect(2, 6, 12, 4, rgb(0x8a8280));
    // 点亮时那两点火把是红的
    p.rect(3, 3, 2, 2, rgb(0xff4020));
    p.rect(11, 3, 2, 2, rgb(0xff4020));
  },
  redstone_torch: (p) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) p.set(x, y, 0, 0, 0, 0);
    const stick = rgb(0x8a6a3a);
    for (let y = 6; y < 16; y++) for (let x = 7; x <= 8; x++) p.set(x, y, stick.r, stick.g, stick.b);
    const red = rgb(0xd02020);
    for (let y = 3; y < 6; y++) for (let x = 6; x <= 9; x++) p.set(x, y, red.r, red.g, red.b);
  },
  repeater_block: (p) => {
    p.noiseFill(rgb(0xbdbdbd), 8);
    p.rect(6, 3, 4, 3, rgb(0xd02020));
    p.rect(6, 10, 4, 3, rgb(0xd02020));
  },
  iron_door_block: (p) => {
    p.noiseFill(rgb(0xc0c0c0), 8);
    p.rect(1, 1, 14, 6, rgb(0xa8a8a8));
    p.rect(1, 9, 14, 6, rgb(0xa8a8a8));
    p.rect(12, 7, 2, 2, rgb(0x707070));
  },
  iron_bars: (p) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) p.set(x, y, 0, 0, 0, 0);
    const m = rgb(0xb0b0b0);
    for (let y = 0; y < 16; y++) for (const x of [3, 4, 11, 12]) p.set(x, y, m.r, m.g, m.b);
    for (const y of [0, 1, 14, 15]) for (let x = 0; x < 16; x++) p.set(x, y, m.r, m.g, m.b);
  },
  melon_top: (p) => { p.noiseFill(rgb(0x6f9c3a), 14); p.speckles(rgb(0x4f7a28), 8, 2); },
  melon_side: (p) => {
    p.noiseFill(rgb(0x8ab04a), 12);
    // 竖条纹，西瓜的招牌
    for (let x = 1; x < 16; x += 4) p.rect(x, 0, 2, 16, rgb(0x4f7a28));
  },
  pumpkin_top: (p) => { p.noiseFill(rgb(0xc07818), 12); p.rect(6, 6, 4, 4, rgb(0x6f8a30)); },
  pumpkin_side: (p) => {
    p.noiseFill(rgb(0xc07818), 12);
    for (let x = 1; x < 16; x += 5) p.rect(x, 0, 1, 16, rgb(0x9a5a10));
  },
  pumpkin_face: (p) => {
    p.noiseFill(rgb(0xc07818), 12);
    for (let x = 1; x < 16; x += 5) p.rect(x, 0, 1, 16, rgb(0x9a5a10));
    // 两只眼睛一张嘴
    p.rect(3, 4, 3, 3, rgb(0x3a2408));
    p.rect(10, 4, 3, 3, rgb(0x3a2408));
    p.rect(4, 10, 8, 2, rgb(0x3a2408));
  },
  jack_o_lantern_face: (p) => {
    p.noiseFill(rgb(0xc07818), 12);
    p.rect(3, 4, 3, 3, rgb(0xf8e070));
    p.rect(10, 4, 3, 3, rgb(0xf8e070));
    p.rect(4, 10, 8, 2, rgb(0xf8e070));
  },
  brewing_stand: (p) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) p.set(x, y, 0, 0, 0, 0);
    const m = rgb(0x9a9a9a);
    for (let y = 2; y < 16; y++) for (let x = 7; x <= 8; x++) p.set(x, y, m.r, m.g, m.b);
    const base = rgb(0x7a6a5a);
    for (let y = 13; y < 16; y++) for (let x = 2; x < 14; x++) p.set(x, y, base.r, base.g, base.b);
  },
  cauldron_top: (p) => { p.noiseFill(rgb(0x4a4a4a), 10); p.rect(3, 3, 10, 10, rgb(0x1a1a1a)); },
  cauldron_bottom: (p) => { p.noiseFill(rgb(0x3a3a3a), 10); },
  cauldron_side: (p) => { p.noiseFill(rgb(0x4a4a4a), 10); p.rect(0, 0, 16, 2, rgb(0x6a6a6a)); },
  enchanting_table_top: (p) => { p.noiseFill(rgb(0x2a1a3a), 12); p.speckles(rgb(0xc03060), 6, 2); },
  enchanting_table_side: (p) => { p.noiseFill(rgb(0x2a1a3a), 12); p.rect(0, 0, 16, 3, rgb(0x8a2a4a)); },
  sponge: (p) => { p.noiseFill(rgb(0xc6c64a), 20); p.speckles(rgb(0x8a8a2a), 18, 2); },
  nether_brick: (p) => brickGrid(p, rgb(0x44242a), rgb(0x2a1418), 8, 4, 10),
  cactus_top: (p) => { p.noiseFill(rgb(0x5a8a3a), 12); p.speckles(rgb(0x3f6a28), 6, 2); },
  cactus_side: (p) => {
    p.noiseFill(rgb(0x4f7a30), 12);
    for (let y = 0; y < 16; y += 4) for (let x = 2; x < 15; x += 5) p.set(x, y, 0xe0, 0xe0, 0xc0);
  },
  sugar_cane_block: (p) => plant(p, rgb(0x9ac46a), null, 10),
  lily_pad: (p) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) p.set(x, y, 0, 0, 0, 0);
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
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) p.set(x, y, 0, 0, 0, 0);
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
  farmland: (p) => {
    p.noiseFill(rgb(0x6f4a2a), 14);
    for (let y = 2; y < 16; y += 5) p.rect(0, y, 16, 2, rgb(0x4a3018));
  },
  wheat_crop: (p) => plant(p, rgb(0xc8b048), rgb(0xe0c860), 11),
  nether_wart_block: (p) => plant(p, rgb(0x8a1a2a), rgb(0xb02a3a), 10),
  // 经验球：一颗发亮的小球。它不是方块也不是物品，
  // 但走的是同一套图集，所以在这里画
  xp_orb: (p) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) p.set(x, y, 0, 0, 0, 0);
    for (let y = 4; y < 12; y++) {
      for (let x = 4; x < 12; x++) {
        const dx = x - 7.5;
        const dy = y - 7.5;
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r > 3.6) continue;
        // 中心偏黄、边缘偏绿，像 MC 的经验球
        const t = Math.min(1, r / 3.6);
        p.set(x, y, 240 - t * 60, 240 - t * 30, 60 + t * 20);
      }
    }
  },

  // --- 流体与火 ---
  //
  // 水画成**接近白的灰度**，颜色交给 TintKind.WATER 在着色器里相乘 ——
  // 和草叶同一套做法，将来不同群系的水色（沼泽偏绿）不用重画贴图。
  // 岩浆自己发光，直接画成实色。
  water: (p) => {
    p.noiseFill(rgb(0xd8dee8), 6);
    // 几道横向的浅纹，让静水看得出是液面而不是一块白板
    for (let y = 2; y < 16; y += 5) p.rect(0, y, 16, 1, rgb(0xc4ccd8));
  },
  water_flow: (p) => {
    p.noiseFill(rgb(0xd0d8e4), 8);
    // 竖纹：流动的水沿流向拉出条痕
    for (let x = 1; x < 16; x += 3) p.rect(x, 0, 1, 16, rgb(0xbcc6d4));
  },
  lava: (p) => {
    p.noiseFill(rgb(0xd8600c), 26);
    // 暗色的结壳斑块，配上亮橙的裂缝 —— 岩浆表面的辨识度全在这个对比上
    p.speckles(rgb(0x8a2c04), 22, 3);
    p.speckles(rgb(0xffc23a), 10, 1);
  },
  lava_flow: (p) => {
    p.noiseFill(rgb(0xc85408), 24);
    for (let x = 0; x < 16; x += 4) p.rect(x, 0, 2, 16, rgb(0xf08a1a));
    p.speckles(rgb(0x7a2404), 14, 2);
  },
  fire: (p) => {
    // 火是 cutout：底下一片透明，火苗从下往上收窄
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) p.set(x, y, 0, 0, 0, 0);
    for (let y = 15; y >= 2; y--) {
      const t = (15 - y) / 13;
      const halfWidth = Math.max(1, Math.round((1 - t) * 7 + 1));
      const cx = 8 + Math.round(Math.sin(y * 0.9) * 1.5);
      for (let x = cx - halfWidth; x <= cx + halfWidth; x++) {
        if (x < 0 || x > 15) continue;
        // 外焰橙、内焰黄
        const edge = Math.abs(x - cx) >= halfWidth - 1;
        const c = edge ? rgb(0xe05a10) : rgb(0xf8c828);
        const d = (p.rand() - 0.5) * 30;
        p.set(x, y, c.r + d, c.g + d, c.b + d);
      }
    }
  },
  furnace_front_lit: (p) => {
    p.noiseFill(rgb(0x7a7a7a), 14);
    p.rect(3, 7, 10, 6, rgb(0x30240f));
    p.rect(4, 9, 8, 4, rgb(0xf0a020));
  },

  // --- 挖掘裂纹，10 级 ---
  //
  // 白底黑纹，由渲染时的乘法混合把它压到方块表面上（见 overlay-renderer.ts）。
  // 裂纹从中心向外生长：每一级都包含上一级的全部线条，再多几条分叉 ——
  // 关键是**同一格方块的裂纹图案在 10 级之间必须是连续的**，
  // 每级各画各的会让裂纹在挖掘过程中不停跳动，非常廉价。
  ...destroyStages(),
  ...SKY_RECIPES,
};

/** 生成 destroy_stage_0..9。它们共用一套从中心生长的裂纹骨架 */
function destroyStages(): Record<string, (p: TilePainter) => void> {
  const out: Record<string, (p: TilePainter) => void> = {};
  for (let stage = 0; stage < 10; stage++) {
    out[`destroy_stage_${stage}`] = (p): void => {
      // 全透明的白底：alpha 0 的地方在着色器里会被还原成"不压暗"
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) p.set(x, y, 255, 255, 255, 0);

      // 用固定种子生成裂纹骨架，保证 10 级之间图案一致
      const rand = mulberry32(fnv1a('destroy_crack'));
      const branches = 5;
      const grow = (stage + 1) / 10;
      for (let b = 0; b < branches; b++) {
        let x = 8 + Math.floor((rand() - 0.5) * 3);
        let y = 8 + Math.floor((rand() - 0.5) * 3);
        const angle = (b / branches) * Math.PI * 2 + rand() * 0.7;
        let dx = Math.cos(angle);
        let dy = Math.sin(angle);
        const steps = Math.round(11 * grow);
        for (let i = 0; i < steps; i++) {
          // 越往后越暗，中心最黑
          const dark = 40 + Math.floor(80 * (i / 12));
          p.set(Math.round(x), Math.round(y), dark, dark, dark, 255);
          // 偶尔加粗一格，让裂纹不是一条细游标
          if (rand() < 0.35) p.set(Math.round(x) + 1, Math.round(y), dark, dark, dark, 255);
          x += dx;
          y += dy;
          // 走偏一点，直线看着像划痕不像裂纹
          dx += (rand() - 0.5) * 0.55;
          dy += (rand() - 0.5) * 0.55;
          const len = Math.hypot(dx, dy) || 1;
          dx /= len;
          dy /= len;
          if (x < 0 || x > 15 || y < 0 || y > 15) break;
        }
      }
    };
  }
  return out;
}

export const TILE_NAMES: readonly string[] = Object.keys(RECIPES);

/** 10 张挖掘裂纹的贴图名。它们不属于任何方块，要由入口显式塞进图集 */
export const DESTROY_STAGE_NAMES: readonly string[] =
  Array.from({ length: 10 }, (_, i) => `destroy_stage_${i}`);
