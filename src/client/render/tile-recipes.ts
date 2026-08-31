/**
 * 贴图配方表（其余杂项）。地形/木制品/植物各自拆在同名的兄弟文件里。
 *
 * 关于染色：草、树叶、羊毛、红石线画成**接近白的灰度**，最终颜色由 TintKind
 * 在着色器里相乘 —— 与 MC 一致，也是不同群系/不同羊毛色共用一张贴图的前提。
 * 这意味着灰度图的明暗跨度会被**原样放大**到最终颜色上：振幅给小了，
 * 一面羊毛墙远看就是一块塑料板。
 */
import { TilePainter, rgb, mulberry32, fnv1a } from './texgen.ts';
import { SKY_RECIPES } from './tile-recipes-sky.ts';
import { PARTICLE_RECIPES } from './tile-recipes-particles.ts';
import { stoneBase, metalBase, inset } from './tile-materials.ts';
import { TERRAIN_RECIPES } from './tile-recipes-terrain.ts';
import { WOOD_RECIPES } from './tile-recipes-wood.ts';
import { PLANT_RECIPES } from './tile-recipes-plants.ts';

type Recipe = (p: TilePainter) => void;

export const RECIPES: Record<string, Recipe> = {
  ...TERRAIN_RECIPES,
  // 木制品与机器（箱子/梯子/门/铁轨/活塞/床/蛋糕）搬去了 tile-recipes-wood.ts —— 见那个文件的头注释
  ...WOOD_RECIPES,
  // 植物/农作物搬去了 tile-recipes-plants.ts —— 见那个文件的头注释
  ...PLANT_RECIPES,
  // --- 熔炉 ---
  furnace_top: (p) => { stoneBase(p, rgb(0x707070)); p.rect(4, 4, 8, 8, rgb(0x5e5e5e)); inset(p, 4); p.edgeShade(9); },
  furnace_side: (p) => { stoneBase(p, rgb(0x707070)); p.edgeShade(9); },
  furnace_front: (p) => {
    stoneBase(p, rgb(0x707070));
    // 炉膛要有**进深**：外圈是被烟熏黑的炉口石，里圈才是看不见底的黑。
    // 原来是一个纯黑矩形加一条灰杠，读作"墙上贴了张黑纸"
    p.rect(3, 5, 10, 8, rgb(0x3b3733));
    p.rect(4, 7, 8, 5, rgb(0x191715));
    // 炉栅：三根竖条，间距不等
    for (const x of [5, 8, 12]) for (let y = 7; y < 12; y++) p.set(x, y, 0x36, 0x32, 0x2d);
    // 炉口内凹：左上压暗、右下提亮，与外凸的机身正好相反
    inset(p, 3, -20, -14);
    p.edgeShade(9);
  },
  // --- 其它 ---
  /**
   * 玻璃。
   *
   * 三处改动，都针对"一眼看出是程序画的"：
   *   1. 边框不再是四条一模一样的实线 —— 那在 2×2 平铺时相邻两格并成
   *      2px 的粗黑框，一面窗户读作铅条格栅。现在左上两边亮（受光）、
   *      右下两边暗（背光），四角再点一下，框本身就有厚度
   *   2. 高光从"一道孤零零的长斜线"改成**长短不一的三四道**。单独一道
   *      又长又亮的线是典型的"记号"：一平铺整面墙上全是同一条杠
   *   3. 玻璃内部原来是纯透明的空。真玻璃有极淡的反光雾，
   *      补几粒 alpha 很低的点，退远看才是"有东西"而不是"洞"
   */
  glass: (p) => {
    p.clear();
    const lit = rgb(0xdcf0f8);
    const dim = rgb(0x8fb0be);
    for (let i = 0; i < 16; i++) {
      p.set(i, 0, lit.r, lit.g, lit.b);
      p.set(0, i, lit.r, lit.g, lit.b);
      p.set(i, 15, dim.r, dim.g, dim.b);
      p.set(15, i, dim.r, dim.g, dim.b);
    }
    // 边框内侧再补一圈很淡的，玻璃的"厚度"就出来了
    for (let i = 1; i < 15; i++) {
      p.set(i, 1, 0xc4, 0xdc, 0xe6, 70);
      p.set(1, i, 0xc4, 0xdc, 0xe6, 70);
    }
    // 反光：从右下往左上的几道斜线，长度与不透明度都不同
    const streak = (x0: number, y0: number, len: number, a: number): void => {
      for (let i = 0; i < len; i++) p.set(x0 + i, y0 - i, 0xee, 0xf8, 0xfc, a);
    };
    streak(3, 12, 8, 165);
    streak(4, 12, 5, 80);
    streak(9, 13, 4, 120);
    streak(3, 6, 3, 95);
    // 极淡的雾点。透明处的 RGB 要填玻璃色而不是黑，否则 mip 缩小后边缘发黑
    for (let i = 0; i < 10; i++) {
      p.set(2 + Math.floor(p.rand() * 12), 2 + Math.floor(p.rand() * 12), 0xd4, 0xe8, 0xf0, 34);
    }
  },
  /**
   * 羊毛。灰度，颜色由方块的 tint 乘上去 —— 也就是说这张图的明暗跨度
   * 会被**原样放大**到最终颜色上。原来振幅只有 9/255（3.5%），
   * 一面羊毛墙远看是一块塑料板，连"这是布"都读不出来。
   *
   * 布的质感是**两个尺度**：大块的褶皱起伏（低频）+ 密集的绒毛颗粒（高频）。
   * 只有一层的话调小是纸、调大是糊。
   */
  wool: (p) => {
    p.valueNoise(rgb(0xdcdcdc), 17, 8, 8, 3);
    p.noiseOverlay(13, 16, 16, 1);
    p.blobs(rgb(0xc6c6c6), 14, 1.1, 8);
    p.blobs(rgb(0xf0f0f0), 9, 0.9, 7);
    p.edgeShade(8);
  },
  obsidian: (p) => {
    // 黑曜石是**玻璃质**的石头：底要够暗，紫色只在解理面上闪。
    // 高频那层给它"碎裂的光泽"，少了就是一块黑橡皮
    p.valueNoise(rgb(0x171024), 16, 5, 5, 3);
    p.noiseOverlay(9, 13, 13, 1);
    p.blobs(rgb(0x3a2a56), 8, 1.6, 10);
    p.blobs(rgb(0x0b0712), 7, 1.3, 6);
    // 几粒亮紫的高光点：黑曜石在火把下会反出一点光
    p.blobs(rgb(0x6a4f96), 4, 0.8, 6);
    p.edgeShade(8);
  },

  // --- M7 的非立方体方块贴图 ---
  stone_slab_top: (p) => { stoneBase(p, rgb(0x9a9a9a)); p.edgeShade(9); },
  stone_slab_side: (p) => {
    // 侧面上下各一道细边，半砖叠起来时能看出接缝
    stoneBase(p, rgb(0x8e8e8e));
    const edge = rgb(0xa8a8a8);
    for (let x = 0; x < 16; x++) { p.set(x, 0, edge.r, edge.g, edge.b); p.set(x, 15, edge.r, edge.g, edge.b); }
  },
  /**
   * 火把。全游戏出现次数最多的 cutout 贴图之一（地下每隔几格一支）。
   *
   * 原来是"两列同色的棕 + 一块两色的黄"，共四个色 —— 在黑漆漆的矿洞里
   * 那就是一根塑料棒顶着一坨黄。真火把要的是三件事：
   *   1. 木棍是**圆**的：左列受光、右列背光，中间本色
   *   2. 火焰有**层次**：外焰暗橙 -> 内焰橙黄 -> 焰心近白，一层套一层
   *   3. 棍与焰之间有一道**烧焦的暗**，火才像是从棍上烧起来的
   */
  torch: (p) => {
    p.clear();
    for (let y = 8; y < 16; y++) {
      const g = (p.rand() - 0.5) * 12;
      p.set(7, y, 0xa6 + g, 0x82 + g, 0x4a + g);
      p.set(8, y, 0x6a + g, 0x4e + g, 0x2a + g);
    }
    // 烧焦的一截
    p.set(7, 7, 0x5a, 0x3c, 0x1e);
    p.set(8, 7, 0x40, 0x2a, 0x14);
    // 外焰（暗橙）
    for (const [x, y] of [[6, 5], [6, 6], [9, 5], [9, 6], [7, 3], [8, 3], [6, 4], [9, 4]] as const) {
      p.set(x, y, 0xc4, 0x5c, 0x0e);
    }
    // 内焰（橙黄）
    for (const [x, y] of [[7, 4], [8, 4], [7, 6], [8, 6], [7, 2], [8, 2]] as const) {
      p.set(x, y, 0xf2, 0xa8, 0x22);
    }
    // 焰心：最亮的两格，火把在暗处的"点光源"读感全靠它
    p.set(7, 5, 0xff, 0xf0, 0xb4);
    p.set(8, 5, 0xff, 0xe2, 0x8e);
  },
  tnt_top: (p) => { p.valueNoise(rgb(0xd03028), 10, 7, 7, 2); p.rect(2, 2, 12, 12, rgb(0xa02018)); inset(p, 2); p.edgeShade(9); },
  tnt_bottom: (p) => { p.valueNoise(rgb(0x7a6a5a), 11, 6, 6, 2); p.edgeShade(9); },
  /**
   * TNT 侧面。
   *
   * 原来白带上是"每 3 列一个 2×2 黑方块" —— 等距方点读作条形码/尺子，
   * 不读作"箱子上写了字"。这里真的把 TNT 三个字母点出来（3×5 的位图），
   * 红色部分也补上高频噪声（原来只有一层 10 振幅的低频，是一张红纸）。
   */
  tnt_side: (p) => {
    p.valueNoise(rgb(0xc22e24), 20, 5, 5, 3);
    p.noiseOverlay(10, 13, 13, 1);
    p.blobs(rgb(0xa32219), 8, 1.3, 10);
    p.rect(0, 5, 16, 6, rgb(0xe6e4da));
    for (let x = 0; x < 16; x++) {
      for (let y = 5; y < 11; y++) p.shade(x, y, (p.rand() - 0.5) * 14);
      p.shade(x, 5, -22);          // 纸带上下沿各压一道影，纸才贴在桶上
      p.shade(x, 10, -16);
    }
    const GLYPH: readonly (readonly string[])[] = [
      ['###', '.#.', '.#.', '.#.', '.#.'],
      ['#.#', '##.', '###', '.##', '#.#'],
      ['###', '.#.', '.#.', '.#.', '.#.'],
    ];
    GLYPH.forEach((g, gi) => {
      g.forEach((row, ry) => {
        for (let rx = 0; rx < 3; rx++) {
          if (row[rx] !== '#') continue;
          p.set(3 + gi * 4 + rx, 6 + ry, 0x2a, 0x22, 0x1e);
        }
      });
    });
    p.edgeShade(9);
  },
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
  // 红石线画成十字：连接方向每帧由邻居推出来，一张图同时当直线和拐角用，
  // 省掉十六种朝向的贴图
  redstone_wire: (p) => {
    p.clear();
    // 横截面的明度剖面：两侧暗、中间亮。原来四列同亮度（235）+ 逐像素噪声，
    // 出来是一条 4px 宽的白胶带 —— 没有粗细就没有"线"的感觉。
    // 这张图会被 TintKind.REDSTONE 按信号强度整体相乘，所以剖面差会被放大
    const PROFILE = [150, 236, 214, 156] as const;
    for (let i = 0; i < 16; i++) {
      for (let k = 0; k < 4; k++) {
        const v = PROFILE[k]! + (p.rand() - 0.5) * 18;
        p.set(i, 6 + k, v, v, v);
        p.set(6 + k, i, v, v, v);
      }
    }
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
    p.rect(3, 5, 10, 8, rgb(0x3b3733));
    p.rect(4, 7, 8, 5, rgb(0x2a1c0a));
    // 火焰堆在炉膛底部，往上收窄并变暗 —— 一整块橙色矩形不发光，
    // 有梯度的火才发光
    for (let y = 8; y < 12; y++) {
      const inset0 = y === 8 ? 2 : y === 9 ? 1 : 0;
      for (let x = 4 + inset0; x < 12 - inset0; x++) {
        const t = (y - 8) / 3;
        const d = (p.rand() - 0.5) * 30;
        p.set(x, y, 0xc0 + t * 60 + d, 0x60 + t * 70 + d, 0x10 + t * 24 + d);
      }
    }
    inset(p, 3, -20, -14);
    p.edgeShade(9);
  },

  // 挖掘裂纹 10 级：白底黑纹，渲染时乘法压到方块表面（见 overlay-renderer.ts）。
  // 每一级都包含上一级的全部线条 —— 各画各的会让裂纹在挖掘中不停跳动
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
