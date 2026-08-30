/**
 * 贴图配方表。每张 16×16 原创像素画的画法。
 *
 * 关于染色：草和树叶的贴图画成**接近白的灰度**，最终颜色由 TintKind 在着色器里相乘 ——
 * 这与 MC 的做法一致，也是让不同群系共用同一张贴图的前提。现在就画成灰度，
 * M4 接入群系色表时不必重画。
 */
import { TilePainter, rgb, mulberry32, fnv1a, type Rgb } from './texgen.ts';
import { SKY_RECIPES } from './tile-recipes-sky.ts';
import { PARTICLE_RECIPES } from './tile-recipes-particles.ts';
import { stoneBase, woodBase, metalBase, inset } from './tile-materials.ts';
import { TERRAIN_RECIPES } from './tile-recipes-terrain.ts';

type Recipe = (p: TilePainter) => void;

/** 在透明底上画一株十字植物的正面 */
function plant(p: TilePainter, stem: Rgb, bloom: Rgb | null, height: number): void {
  p.clear();
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

export const RECIPES: Record<string, Recipe> = {
  ...TERRAIN_RECIPES,
  // --- 熔炉 ---
  furnace_top: (p) => { stoneBase(p, rgb(0x707070)); p.rect(4, 4, 8, 8, rgb(0x5e5e5e)); inset(p, 4); p.edgeShade(9); },
  furnace_side: (p) => { stoneBase(p, rgb(0x707070)); p.edgeShade(9); },
  furnace_front: (p) => {
    stoneBase(p, rgb(0x707070));
    p.rect(3, 5, 10, 8, rgb(0x2e2e2e));
    p.rect(4, 6, 8, 2, rgb(0x4a4a4a));
    // 炉口内凹：左上压暗、右下提亮，与外凸的机身正好相反
    inset(p, 3, -20, -14);
    p.edgeShade(9);
  },

  // --- 其它 ---
  glass: (p) => {
    p.clear();
    const frame = rgb(0xd0e8f0);
    for (let x = 0; x < 16; x++) { p.set(x, 0, frame.r, frame.g, frame.b); p.set(x, 15, frame.r, frame.g, frame.b); }
    for (let y = 0; y < 16; y++) { p.set(0, y, frame.r, frame.g, frame.b); p.set(15, y, frame.r, frame.g, frame.b); }
    // 一道斜高光，玻璃才像玻璃。原来撒的是五个随机点 —— 那读作"脏"，
    // 不读作"反光"：反光必须是**连续的一道**，眼睛靠它判断这是个平面
    for (let i = 0; i < 7; i++) {
      p.set(3 + i, 11 - i, 0xe8, 0xf4, 0xf8, 150);
      if (i < 4) p.set(4 + i, 11 - i, 0xe8, 0xf4, 0xf8, 90);
    }
  },
  // 羊毛是灰度，颜色由方块的染色决定。织物感靠**细密的短团**，
  // 不是逐像素噪声 —— 后者在 16×16 上就是一张灰纸
  wool: (p) => { p.valueNoise(rgb(0xe4e4e4), 9, 8, 8, 2); p.blobs(rgb(0xd6d6d6), 12, 1.1, 7); p.edgeShade(7); },
  obsidian: (p) => {
    p.valueNoise(rgb(0x171024), 10, 5, 5, 2);
    // 紫色的解理面成团，黑曜石才有"一块玻璃质的石头"的样子
    p.blobs(rgb(0x33254a), 6, 2.1, 10);
    p.blobs(rgb(0x0d0916), 5, 1.6, 6);
    p.edgeShade(8);
  },

  // --- 植物 ---
  tall_grass: (p) => plant(p, rgb(0xc8c8c8), null, 11),
  dead_bush: (p) => plant(p, rgb(0x6f5321), null, 10),
  sapling: (p) => plant(p, rgb(0x4f7f2f), rgb(0x3f7a28), 9),
  dandelion: (p) => plant(p, rgb(0x4f7f2f), rgb(0xf0e050), 10),
  rose: (p) => plant(p, rgb(0x4f7f2f), rgb(0xd02020), 10),
  brown_mushroom: (p) => mushroom(p, rgb(0x9b6b4b), false),
  red_mushroom: (p) => mushroom(p, rgb(0xc23a2a), true),

  // --- M7 的非立方体方块贴图 ---
  stone_slab_top: (p) => { stoneBase(p, rgb(0x9a9a9a)); p.edgeShade(9); },
  stone_slab_side: (p) => {
    // 侧面上下各一道细边，半砖叠起来时能看出接缝
    stoneBase(p, rgb(0x8e8e8e));
    const edge = rgb(0xa8a8a8);
    for (let x = 0; x < 16; x++) { p.set(x, 0, edge.r, edge.g, edge.b); p.set(x, 15, edge.r, edge.g, edge.b); }
  },
  torch: (p) => {
    p.clear();
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
    p.clear();
    const wood = rgb(0x9a7a44);
    for (let y = 0; y < 16; y++) { for (const x of [2, 3, 12, 13]) p.set(x, y, wood.r, wood.g, wood.b); }
    for (const y of [2, 7, 12]) { for (let x = 3; x < 13; x++) { p.set(x, y, wood.r, wood.g, wood.b); p.set(x, y + 1, wood.r, wood.g, wood.b); } }
  },
  cake_top: (p) => { p.valueNoise(rgb(0xf7f0e0), 7, 7, 7, 2); p.blobs(rgb(0xd04040), 9, 1.3, 14); p.edgeShade(7); },
  cake_bottom: (p) => { woodBase(p, rgb(0x8a6a45)); p.edgeShade(8); },
  cake_side: (p) => {
    p.valueNoise(rgb(0xf7f0e0), 7, 7, 7, 2);
    p.rect(0, 0, 16, 3, rgb(0xd04040));
    p.rect(0, 12, 16, 4, rgb(0x8a6a45));
  },
  door_lower: (p) => {
    woodBase(p, rgb(0x9a7a4a), true);
    p.rect(1, 1, 14, 6, rgb(0x8a6a3c));
    p.rect(1, 9, 14, 6, rgb(0x8a6a3c));
    p.rect(12, 7, 2, 2, rgb(0xd8d8d8));
  },
  trapdoor: (p) => {
    p.clear();
    const wood = rgb(0x9a7a44);
    for (const y of [1, 2, 7, 8, 13, 14]) for (let x = 0; x < 16; x++) p.set(x, y, wood.r, wood.g, wood.b);
    for (const x of [1, 2, 13, 14]) for (let y = 0; y < 16; y++) p.set(x, y, wood.r, wood.g, wood.b);
  },
  bed_top: (p) => { p.valueNoise(rgb(0xc03030), 10, 7, 7, 2); p.rect(0, 0, 16, 4, rgb(0xf0f0f0)); p.edgeShade(9); },
  bed_side: (p) => { p.valueNoise(rgb(0xc03030), 10, 7, 7, 2); woodBase(p, rgb(0x9a7a44)); p.rect(0, 0, 16, 11, rgb(0xc03030)); p.valueNoise(rgb(0xc03030), 10, 7, 7, 2); p.edgeShade(9); },
  rail: (p) => {
    p.clear();
    const tie = rgb(0x8a6a3a);
    for (let y = 1; y < 16; y += 4) for (let x = 2; x < 14; x++) { p.set(x, y, tie.r, tie.g, tie.b); p.set(x, y + 1, tie.r, tie.g, tie.b); }
    const metal = rgb(0xc0c0c0);
    for (let y = 0; y < 16; y++) { for (const x of [4, 5, 10, 11]) p.set(x, y, metal.r, metal.g, metal.b); }
  },

  // --- M8 批的贴图 ---
  chest_top: (p) => { woodBase(p, rgb(0x9a6f3f)); p.rect(0, 0, 16, 1, rgb(0x6f4f2a)); inset(p, 1); p.edgeShade(9); },
  chest_side: (p) => { woodBase(p, rgb(0x9a6f3f)); p.rect(0, 5, 16, 2, rgb(0x6f4f2a)); inset(p, 1); p.edgeShade(9); },
  chest_front: (p) => {
    woodBase(p, rgb(0x9a6f3f));
    p.rect(0, 5, 16, 2, rgb(0x6f4f2a));
    p.rect(7, 6, 2, 4, rgb(0xd8c060));   // 锁扣
    p.shade(7, 6, 26);                   // 锁扣顶上一点高光，才像金属
    inset(p, 1);
    p.edgeShade(9);
  },
  tnt_top: (p) => { p.valueNoise(rgb(0xd03028), 10, 7, 7, 2); p.rect(2, 2, 12, 12, rgb(0xa02018)); inset(p, 2); p.edgeShade(9); },
  tnt_bottom: (p) => { p.valueNoise(rgb(0x7a6a5a), 11, 6, 6, 2); p.edgeShade(9); },
  tnt_side: (p) => {
    p.valueNoise(rgb(0xd03028), 10, 7, 7, 2);
    p.rect(0, 5, 16, 6, rgb(0xf0f0f0));
    // 中间那圈白带上写点东西的感觉
    for (let x = 2; x < 14; x += 3) p.rect(x, 7, 2, 2, rgb(0x303030));
  },
  jukebox_top: (p) => { woodBase(p, rgb(0x8a6a45)); p.rect(4, 4, 8, 8, rgb(0x303030)); inset(p, 4, -18, -12); p.edgeShade(9); },
  jukebox_side: (p) => { woodBase(p, rgb(0x8a6a45)); p.rect(0, 13, 16, 3, rgb(0x6a4f34)); p.edgeShade(9); },
  note_block: (p) => { woodBase(p, rgb(0x7a5a3a)); p.blobs(rgb(0x4a3a2a), 7, 1.4, 10); p.edgeShade(9); },
  dispenser_front: (p) => {
    stoneBase(p, rgb(0x7a7a7a));
    p.rect(4, 4, 8, 8, rgb(0x3a3a3a));
    p.rect(6, 6, 4, 4, rgb(0x1a1a1a));
  },
  lever: (p) => {
    p.clear();
    const wood = rgb(0x8a6a3a);
    for (let y = 4; y < 16; y++) for (let x = 7; x <= 8; x++) p.set(x, y, wood.r, wood.g, wood.b);
    const knob = rgb(0x9a9a9a);
    for (let y = 2; y < 5; y++) for (let x = 6; x <= 9; x++) p.set(x, y, knob.r, knob.g, knob.b);
  },
  // 红石线：灰度的十字，颜色由 TintKind.REDSTONE 按信号强度决定深浅。
  // 画成十字而不是单条线，是因为线的连接方向是每帧由邻居推出来的，
  // 一张能同时当直线和拐角用的贴图省掉了十六种朝向的图
  redstone_wire: (p) => {
    p.clear();
    for (let i = 0; i < 16; i++) {
      for (let w = 6; w <= 9; w++) {
        const d = (p.rand() - 0.5) * 24;
        p.set(i, w, 235 + d, 235 + d, 235 + d);
        p.set(w, i, 235 + d, 235 + d, 235 + d);
      }
    }
  },
  piston_side: (p) => {
    woodBase(p, rgb(0x9a8a6a), true);
    // 上下各一道深色包边，看着像一截木质的筒身
    p.rect(0, 0, 16, 2, rgb(0x6a5a3a));
    p.rect(0, 14, 16, 2, rgb(0x6a5a3a));
    for (let x = 0; x < 16; x += 5) p.rect(x, 2, 1, 12, rgb(0x7a6a4a));
  },
  piston_top: (p) => {
    p.valueNoise(rgb(0xb8a878), 9, 6, 6, 2);
    p.rect(1, 1, 14, 14, rgb(0x8a7a5a));
    p.rect(3, 3, 10, 10, rgb(0xb0a070));
    inset(p, 3);
    p.edgeShade(8);
  },
  piston_top_sticky: (p) => {
    p.valueNoise(rgb(0xb8a878), 9, 6, 6, 2);
    p.rect(1, 1, 14, 14, rgb(0x8a7a5a));
    // 粘性活塞顶上那一圈绿 —— 唯一能一眼分辨两种活塞的地方。
    // 斑点必须**只落在那一圈里**：原来的 speckles 撒满整块，
    // 把外框也点绿了，两种活塞反而更难分
    p.rect(3, 3, 10, 10, rgb(0x7aa03a));
    for (let i = 0; i < 14; i++) {
      const x = 3 + Math.floor(p.rand() * 10);
      const y = 3 + Math.floor(p.rand() * 10);
      p.set(x, y, 0x5a, 0x80, 0x20);
    }
    inset(p, 3);
    p.edgeShade(8);
  },
  piston_bottom: (p) => {
    woodBase(p, rgb(0x8a7a5a));
    p.blobs(rgb(0x6a5a3a), 8, 1.5, 10);
    p.edgeShade(9);
  },

  // 熄灭的红石火把：与亮着的同形，只是头上那点是暗红的
  redstone_torch_off: (p) => {
    p.clear();
    for (let y = 6; y < 16; y++) p.rect(7, y, 2, 1, rgb(0x6a4a2a));
    p.rect(6, 4, 4, 3, rgb(0x5a1a1a));
  },
  repeater_block_on: (p) => {
    stoneBase(p, rgb(0xb0a8a0));
    p.rect(2, 6, 12, 4, rgb(0x8a8280));
    // 点亮时那两点火把是红的
    p.rect(3, 3, 2, 2, rgb(0xff4020));
    p.rect(11, 3, 2, 2, rgb(0xff4020));
  },
  redstone_torch: (p) => {
    p.clear();
    const stick = rgb(0x8a6a3a);
    for (let y = 6; y < 16; y++) for (let x = 7; x <= 8; x++) p.set(x, y, stick.r, stick.g, stick.b);
    const red = rgb(0xd02020);
    for (let y = 3; y < 6; y++) for (let x = 6; x <= 9; x++) p.set(x, y, red.r, red.g, red.b);
  },
  repeater_block: (p) => {
    stoneBase(p, rgb(0xbdbdbd));
    p.rect(6, 3, 4, 3, rgb(0xd02020));
    p.rect(6, 10, 4, 3, rgb(0xd02020));
  },
  iron_door_block: (p) => {
    metalBase(p, rgb(0xc0c0c0));
    p.rect(1, 1, 14, 6, rgb(0xa8a8a8));
    p.rect(1, 9, 14, 6, rgb(0xa8a8a8));
    p.rect(12, 7, 2, 2, rgb(0x707070));
  },
  iron_bars: (p) => {
    p.clear();
    const m = rgb(0xb0b0b0);
    for (let y = 0; y < 16; y++) for (const x of [3, 4, 11, 12]) p.set(x, y, m.r, m.g, m.b);
    for (const y of [0, 1, 14, 15]) for (let x = 0; x < 16; x++) p.set(x, y, m.r, m.g, m.b);
    // 每根栏杆左侧提亮、右侧压暗。纯色的栏杆是一条扁带子，
    // 有了这两笔才是圆的
    for (let y = 0; y < 16; y++) { p.shade(3, y, 20); p.shade(4, y, -18); p.shade(11, y, 20); p.shade(12, y, -18); }
    for (let x = 0; x < 16; x++) { p.shade(x, 0, 18); p.shade(x, 1, -16); p.shade(x, 14, 18); p.shade(x, 15, -16); }
  },
  melon_top: (p) => { p.valueNoise(rgb(0x6f9c3a), 12, 6, 6, 2); p.blobs(rgb(0x4f7a28), 7, 1.6, 12); p.edgeShade(9); },
  melon_side: (p) => {
    p.grain(rgb(0x8ab04a), 13, true);
    // 竖条纹，西瓜的招牌
    for (let x = 1; x < 16; x += 4) p.rect(x, 0, 2, 16, rgb(0x4f7a28));
  },
  pumpkin_top: (p) => { p.valueNoise(rgb(0xc07818), 11, 6, 6, 2); p.rect(6, 6, 4, 4, rgb(0x6f8a30)); p.edgeShade(9); },
  pumpkin_side: (p) => {
    p.grain(rgb(0xc07818), 12, true);
    for (let x = 1; x < 16; x += 5) p.rect(x, 0, 1, 16, rgb(0x9a5a10));
  },
  pumpkin_face: (p) => {
    p.grain(rgb(0xc07818), 12, true);
    for (let x = 1; x < 16; x += 5) p.rect(x, 0, 1, 16, rgb(0x9a5a10));
    // 两只眼睛一张嘴
    p.rect(3, 4, 3, 3, rgb(0x3a2408));
    p.rect(10, 4, 3, 3, rgb(0x3a2408));
    p.rect(4, 10, 8, 2, rgb(0x3a2408));
  },
  jack_o_lantern_face: (p) => {
    p.grain(rgb(0xc07818), 12, true);
    p.rect(3, 4, 3, 3, rgb(0xf8e070));
    p.rect(10, 4, 3, 3, rgb(0xf8e070));
    p.rect(4, 10, 8, 2, rgb(0xf8e070));
  },
  brewing_stand: (p) => {
    p.clear();
    const m = rgb(0x9a9a9a);
    for (let y = 2; y < 16; y++) for (let x = 7; x <= 8; x++) p.set(x, y, m.r, m.g, m.b);
    const base = rgb(0x7a6a5a);
    for (let y = 13; y < 16; y++) for (let x = 2; x < 14; x++) p.set(x, y, base.r, base.g, base.b);
  },
  cauldron_top: (p) => { metalBase(p, rgb(0x4a4a4a)); p.rect(3, 3, 10, 10, rgb(0x1a1a1a)); inset(p, 3, -16, -10); p.edgeShade(8); },
  cauldron_bottom: (p) => { metalBase(p, rgb(0x3a3a3a)); p.edgeShade(8); },
  cauldron_side: (p) => { metalBase(p, rgb(0x4a4a4a)); p.rect(0, 0, 16, 2, rgb(0x6a6a6a)); p.edgeShade(8); },
  enchanting_table_top: (p) => { p.valueNoise(rgb(0x2a1a3a), 10, 5, 5, 2); p.oreBlobs(rgb(0xc03060), rgb(0x5a1830), 5, 1.5); p.edgeShade(8); },
  enchanting_table_side: (p) => { p.valueNoise(rgb(0x2a1a3a), 10, 5, 5, 2); p.rect(0, 0, 16, 3, rgb(0x8a2a4a)); p.edgeShade(8); },
  // 海绵的辨识度全在**孔**上。原来撒的是 18 个随机方点，读作"脏"；
  // 成团的暗窝才读作"多孔"
  sponge: (p) => {
    p.valueNoise(rgb(0xc6c64a), 13, 6, 6, 2);
    p.blobs(rgb(0x8a8a2a), 9, 1.8, 14);
    p.blobs(rgb(0x6a6a1a), 6, 1.2, 10);
    p.edgeShade(10);
  },
  cactus_top: (p) => { p.valueNoise(rgb(0x5a8a3a), 11, 6, 6, 2); p.blobs(rgb(0x3f6a28), 6, 1.5, 10); p.edgeShade(9); },
  cactus_side: (p) => {
    p.grain(rgb(0x4f7a30), 12, true);
    for (let y = 0; y < 16; y += 4) for (let x = 2; x < 15; x += 5) p.set(x, y, 0xe0, 0xe0, 0xc0);
  },
  sugar_cane_block: (p) => plant(p, rgb(0x9ac46a), null, 10),
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
    p.valueNoise(rgb(0x6f4a2a), 16, 5, 5, 2);
    p.blobs(rgb(0x59391f), 6, 1.7, 12);
    for (let y = 2; y < 16; y += 5) {
      for (let x = 0; x < 16; x++) {
        const d = (p.rand() - 0.5) * 10;
        p.set(x, y, 0x46 + d, 0x2d + d, 0x16 + d);       // 沟底
        p.set(x, y + 1, 0x54 + d, 0x37 + d, 0x1c + d);
        p.shade(x, y - 1, 12);                            // 沟沿提亮
      }
    }
    p.edgeShade(11);
  },
  wheat_crop: (p) => plant(p, rgb(0xc8b048), rgb(0xe0c860), 11),
  nether_wart_block: (p) => plant(p, rgb(0x8a1a2a), rgb(0xb02a3a), 10),
  // 经验球：一颗发亮的小球。它不是方块也不是物品，
  // 但走的是同一套图集，所以在这里画
  xp_orb: (p) => {
    p.clear();
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
    // 水面覆盖的屏幕面积极大（一片海就是几万像素），所以幅度必须**小** ——
    // 大了整片海会花。要的只是"这是液面不是白板"这一点信息。
    // 用各向异性格点噪声做横向的缓波，比三条等距实线自然得多：
    // 等距实线在一大片水面上会连成可见的横向条带
    p.valueNoise(rgb(0xd8dee8), 7, 2, 5, 2);
    p.blobs(rgb(0xe4e9f0), 5, 2.2, 4);
  },
  water_flow: (p) => {
    // 竖纹：流动的水沿流向拉出条痕。用 grain 而不是等距竖线 ——
    // 等距竖线是一把梳子，粗细一致、间隔一致，水不长那样
    p.grain(rgb(0xd0d8e4), 11, true);
    p.blobs(rgb(0xbcc6d4), 6, 1.4, 6);
  },
  lava: (p) => {
    // 岩浆表面的辨识度全在"暗结壳 + 亮裂缝"的对比上。
    // 结壳要成大团（那是漂在表面的冷却壳），亮色要细而碎（那是壳之间的缝）
    p.valueNoise(rgb(0xd8600c), 18, 4, 4, 2);
    p.blobs(rgb(0x8a2c04), 9, 2.6, 16);
    p.blobs(rgb(0x6a1e02), 5, 1.8, 10);
    p.blobs(rgb(0xffc23a), 8, 1.0, 12);
  },
  lava_flow: (p) => {
    p.grain(rgb(0xc85408), 22, true);
    p.blobs(rgb(0xf08a1a), 7, 1.6, 14);
    p.blobs(rgb(0x7a2404), 7, 1.9, 12);
  },
  fire: (p) => {
    // 火是 cutout：底下一片透明，火苗从下往上收窄
    p.clear();
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
    stoneBase(p, rgb(0x7a7a7a));
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
  ...PARTICLE_RECIPES,
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
