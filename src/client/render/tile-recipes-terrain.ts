/**
 * 地形 / 砖石 / 矿石 / 木材 的贴图配方。
 *
 * 从 `tile-recipes.ts` 拆出来的原因有两个：那个文件顶到了 600 行硬上限；
 * 而这一批正好是**画面占比最大**的一组 —— 一屏里九成以上的像素来自
 * 石头、泥土、草、木头这几张，值得单独放一处按同一套手法调。
 *
 * ## 这一批为什么重画
 *
 * 原来清一色是 `noiseFill`，即**逐像素独立**的白噪声。16×16 上它的观感
 * 是电视雪花点：单个像素在变，但相邻像素毫无相关性，退开一步就被眼睛
 * 平均成一片均匀的糊。像素画的明暗必须**成团** —— 人眼读的是团块的
 * 形状，不是单个点。
 *
 * 所以这里统一换成三段式：
 *
 *   1. `valueNoise` 打底 —— 可平铺的格点噪声，明暗是成片的
 *   2. `blobs` / `oreBlobs` 加特征 —— 环绕的不规则团块，不会在边上被切掉
 *   3. `edgeShade` 收边 —— 靠边一圈压暗，铺成墙面时能一眼数出几格
 *
 * 详见 `docs/ART-PLAN.md`。
 */
import { rgb, type TilePainter } from './texgen.ts';
import { stoneBase, brickGrid, stoneCluster, barkRidges } from './tile-materials.ts';

type Recipe = (p: TilePainter) => void;

export const TERRAIN_RECIPES: Record<string, Recipe> = {
  // --- 地形 ---
  /**
   * 石头。**整个地下都是它**，所以它的对比度决定了"地下看不看得清"。
   *
   * 原来是 `valueNoise(…, 11, …)` —— 11/255 只有 4% 的明暗跨度，
   * 放大看勉强有层次，铺满一整个矿洞就是一面死灰的水泥墙，
   * 玩家分不出哪里是墙哪里是地板。MC 的石头跨度接近 20%，
   * 那是它在一支火把下仍然读得出结构的原因。
   *
   * 三层叠加而不是一层：低频（7×7）给大块明暗，高频（14×14）给颗粒，
   * 再点几粒亮暗斑。只有一层的话不管振幅调多大都是"糊"而不是"花"。
   */
  stone: (p) => {
    p.valueNoise(rgb(0x7e7e7e), 24, 7, 7, 3);
    p.noiseOverlay(10, 14, 14, 1);
    p.blobs(rgb(0x646464), 8, 1.5, 10);
    p.blobs(rgb(0x969696), 5, 1.2, 8);
    p.edgeShade(9);
  },
  /**
   * 泥土。
   *
   * 原来是"少数几颗又大又亮的石子撒在很平的棕色上"—— 那几颗亮点成了
   * 一眼认得出的记号，一平铺开来整片地就是同一个图案在重复。
   * 改法是**把特征变多变小变淡**：颗粒感来自密集的中频噪声，
   * 而不是几颗显眼的亮斑。
   */
  dirt: (p) => {
    p.valueNoise(rgb(0x866043), 22, 5, 5, 3);
    p.noiseOverlay(12, 12, 12, 1);
    p.blobs(rgb(0x6d4e37), 11, 1.3, 12);
    p.blobs(rgb(0x9a7150), 8, 1.0, 10);
    p.edgeShade(12);
  },
  // grass_top 是灰度，颜色由群系 tint 乘上去
  // 主世界抬头低头看得最多的一张。灰度，颜色由群系 tint 乘上去 ——
  // 也就是说**这张图的明暗跨度会被原样放大到最终颜色上**，
  // 振幅 10 意味着整片草地几乎是一个纯色，远看是一块绿塑料板
  grass_top: (p) => {
    // 底色压到 0xc0 而不是 0xd4。0xd4 已经很接近白，往上加的振幅
    // 会直接撞到 255 被截掉 —— 结果是"只能变暗不能变亮"的单边噪声，
    // 看起来就是一片发白的糊。压低底色才有上下两边的余量。
    //
    // 这张是灰度、由群系色乘上去的，所以最终的绿会比这里深一档 ——
    // 那正是原版草地的样子（MC 的草顶灰度图本身也不亮）
    p.valueNoise(rgb(0xc0c0c0), 26, 6, 6, 3);
    p.noiseOverlay(14, 16, 16, 1);
    p.blobs(rgb(0x9c9c9c), 12, 1.3, 12);
    p.blobs(rgb(0xdcdcdc), 8, 1.1, 9);
    p.edgeShade(7);
  },
  // grass_side **不染色**（方块定义里 tintFaces 只勾了 UP 面），所以这里必须画成彩色：
  // 下半是泥土本色，顶部长出一圈绿色草边。整块染色会把泥土也染绿。
  grass_side: (p) => {
    p.valueNoise(rgb(0x866043), 20, 4, 4, 2);
    p.blobs(rgb(0x6d4e37), 5, 1.7, 14);
    // 草边高度取自**一维噪声场**而不是逐列独立随机：相邻列相关，
    // 边缘才是起伏的草地，逐列独立出来的是锯齿状的梳子
    const f = p.noiseField(5, 1, 2);
    for (let x = 0; x < 16; x++) {
      const h = 2 + Math.round(f[x]! * 3.4);
      for (let y = 0; y < h; y++) {
        // 顶亮根暗：草根处压深，与泥土衔接才不突兀
        const d = -12 * (y / Math.max(1, h - 1)) + (p.rand() - 0.5) * 22;
        p.set(x, y, 0x6a + d, 0xa2 + d, 0x3c + d);
      }
      // 边界下面再点几粒孤立的草尖。没有它，草与土之间是一条直边，
      // 一眼看得出是"填了个矩形"
      if (p.rand() < 0.45) {
        const d = (p.rand() - 0.5) * 18;
        p.set(x, h, 0x5e + d, 0x92 + d, 0x36 + d);
      }
    }
    p.edgeShade(10);
  },
  // 沙、雪、黏土这类**光滑**材质：只要极轻的格点噪声，不要 blobs。
  // 量化会把小团变成边界清楚的斑，在均匀底上读作"脏"而不是"有颗粒"
  // 沙子是**颗粒**，所以主要靠高频那一层。低频只给一点起伏（沙丘的影子），
  // 全靠低频的话是一块奶油色的板子
  sand: (p) => {
    p.valueNoise(rgb(0xded5a8), 12, 4, 4, 2);
    p.noiseOverlay(14, 16, 16, 1);
    p.blobs(rgb(0xcabf92), 9, 1.0, 8);
    p.edgeShade(7);
  },
  gravel: (p) => {
    // 4×4 = 十六块约 4px 的碎石，比圆石小一号、明度差更大
    stoneCluster(p, 4, rgb(0x8a8a8a), rgb(0x5a5a5a), 40);
    p.edgeShade(10);
  },
  clay: (p) => {
    p.valueNoise(rgb(0xa4a8b8), 18, 5, 5, 3);
    p.noiseOverlay(7, 13, 13, 1);
    p.blobs(rgb(0x8e92a2), 8, 1.3, 9);
    p.edgeShade(8);
  },
  bedrock: (p) => {
    p.valueNoise(rgb(0x525252), 22, 3, 3, 2);
    p.blobs(rgb(0x2c2c2c), 9, 2.4, 16);
    p.blobs(rgb(0x6e6e6e), 5, 1.6, 12);
    p.edgeShade(14);
  },
  // 雪的振幅要克制：它本来就该是近乎纯白的。但"近乎"不等于"完全"——
  // 一点点起伏才看得出这是一层积雪而不是一张白纸
  snow: (p) => {
    p.valueNoise(rgb(0xf1f6f6), 11, 5, 5, 2);
    p.noiseOverlay(6, 14, 14, 1);
    p.edgeShade(6);
  },
  // 冰。这一张要的**不是**颗粒感 —— 冰是通透的，颗粒会让它变成磨砂玻璃。
  // 要的是大块的、边界柔和的明暗（冰层里的裂纹与气泡），
  // 所以低频振幅给足、高频只给一点点
  ice: (p) => {
    p.valueNoise(rgb(0x9ec4f0), 18, 5, 5, 3);
    p.noiseOverlay(5, 12, 12, 1);
    p.blobs(rgb(0xd2e6fa), 7, 1.6, 9);
    p.blobs(rgb(0x7c9ecc), 6, 1.3, 9);
    p.edgeShade(7);
  },
  mycelium_top: (p) => { p.valueNoise(rgb(0x6f6167), 16, 5, 5, 2); p.blobs(rgb(0x8b7b86), 9, 1.6, 14); p.edgeShade(10); },
  mycelium_side: (p) => {
    p.valueNoise(rgb(0x866043), 20, 4, 4, 2);
    p.blobs(rgb(0x6d4e37), 5, 1.7, 14);
    p.grassOverlay(rgb(0x6f6167));
    p.edgeShade(10);
  },
  end_stone: (p) => {
    p.valueNoise(rgb(0xdcdca8), 20, 5, 5, 3);
    p.noiseOverlay(9, 14, 14, 1);
    p.blobs(rgb(0xbcbc82), 10, 1.3, 11);
    p.blobs(rgb(0xeeeebe), 5, 1.0, 8);
    p.edgeShade(9);
  },
  // 地狱岩。原版是**纤维状**的 —— 密密麻麻的深色短纹，不是几团大暗斑。
  // 大暗斑的问题在 2×2 平铺时看得最清楚：它们会在贴图边界处连成十字。
  // 低频格点从 4 提到 7 也是同一个理由：4×4 的格点周期太长，
  // 一块贴图里只有四个起伏，平铺起来就是规则的波浪
  netherrack: (p) => {
    p.valueNoise(rgb(0x703434), 20, 7, 7, 3);
    p.noiseOverlay(14, 16, 16, 1);
    p.blobs(rgb(0x582626), 14, 1.1, 12);
    p.blobs(rgb(0x8a4444), 9, 0.9, 10);
    p.edgeShade(12);
  },
  // 灵魂沙：深棕底 + 几处明显的凹陷（原版那几张"脸"的抽象）。
  // 凹陷要**深**，浅了就只是脏泥土
  soul_sand: (p) => {
    p.valueNoise(rgb(0x53403a), 22, 4, 4, 3);
    p.noiseOverlay(10, 12, 12, 1);
    p.blobs(rgb(0x2e211d), 7, 2.0, 10);
    p.blobs(rgb(0x6b544a), 5, 1.2, 8);
    p.edgeShade(11);
  },
  glowstone: (p) => {
    p.valueNoise(rgb(0xb99a5e), 14, 4, 4, 2);
    // 亮团带暗边，萤石才有"一颗颗发光结晶"的样子，而不是一张亮黄的纸
    p.oreBlobs(rgb(0xf6e6a4), rgb(0x8f7440), 7, 2.0);
    p.edgeShade(10);
  },

  // --- 砖块类 ---
  // 圆石不用错缝格：MC 的圆石是大小不一的乱石，规则网格一眼看得出是程序画的
  cobblestone: (p) => {
    // 3×3 的抖动网格 = 九块约 5px 的石头，中间留缝。
    // MC 的圆石辨识度在于"能一块块数出来"，随机撒团给不了这个
    stoneCluster(p, 3, rgb(0x848484), rgb(0x4e4e4e), 30);
    p.edgeShade(11);
  },
  mossy_cobblestone: (p) => {
    stoneCluster(p, 3, rgb(0x77836d), rgb(0x424b3d), 28);
    // 青苔长在缝里，所以补在石子**之后**，团要小、要贴着缝
    p.blobs(rgb(0x5d7a4a), 7, 1.3, 16);
    p.edgeShade(11);
  },
  stone_bricks: (p) => brickGrid(p, rgb(0x7a7a7a), rgb(0x5c5c5c), 8, 4, 16),
  nether_brick: (p) => brickGrid(p, rgb(0x44242a), rgb(0x2a1418), 8, 4, 10),
  bricks: (p) => brickGrid(p, rgb(0x96604c), rgb(0xa8a29c), 8, 4, 14),
  sandstone: (p) => {
    // 层理与底色的差必须**够大**，否则 6 色量化会把它并进底色 ——
    // 第一版就是这样：线画了，量化完一条都不剩。
    // 量化是最后一道，配方里任何"很淡的东西"都要按会被并掉来设计
    p.valueNoise(rgb(0xd8ce9e), 8, 2, 6, 2);
    p.hLine(0, rgb(0xa89d6a));
    p.hLine(1, rgb(0xc6bb8c));
    p.hLine(6, rgb(0xb8ad7e));
    p.hLine(12, rgb(0xb8ad7e));
    p.edgeShade(7);
  },

  // --- 矿石：石头底 + 带暗边的矿物团 ---
  // 直接撒亮点（原来的 speckles）在石头底上是"洒了一把糖"，退远了糊成一片；
  // 加了暗边每一团才有轮廓
  coal_ore: (p) => { stoneBase(p); p.oreBlobs(rgb(0x2b2b2b), rgb(0x151515), 5, 1.9); p.edgeShade(10); },
  iron_ore: (p) => { stoneBase(p); p.oreBlobs(rgb(0xd8a882), rgb(0x9a7458), 5, 1.9); p.edgeShade(10); },
  gold_ore: (p) => { stoneBase(p); p.oreBlobs(rgb(0xf0d048), rgb(0xa2892a), 5, 1.8); p.edgeShade(10); },
  diamond_ore: (p) => { stoneBase(p); p.oreBlobs(rgb(0x5decdc), rgb(0x33a096), 5, 1.8); p.edgeShade(10); },
  lapis_ore: (p) => { stoneBase(p); p.oreBlobs(rgb(0x3559c0), rgb(0x1b2f6c), 5, 1.9); p.edgeShade(10); },
  redstone_ore: (p) => { stoneBase(p); p.oreBlobs(rgb(0xd02020), rgb(0x861313), 6, 1.7); p.edgeShade(10); },

  // --- 金属与宝石方块 ---
  // 这几张都是"一整块材料"，靠内嵌一圈边框做出板材感
  gold_block: (p) => {
    p.valueNoise(rgb(0xecc93a), 9, 4, 4, 2);
    // 内嵌一圈亮色做板材的厚度。**不能再调一次 valueNoise 来加噪** ——
    // 那会重填整块、把这圈边框冲掉。原来的 gold_block 就栽在这里：
    //   noiseFill(...); rect(1,1,14,14,...); noiseFill(...);
    // 第三句一执行，第二句画的内框一个像素都不剩，等于白写。
    for (let y = 2; y < 14; y++) {
      for (let x = 2; x < 14; x++) {
        const d = (p.rand() - 0.5) * 10;
        p.set(x, y, 0xf8 + d, 0xde + d, 0x5a + d);
      }
    }
    p.rect(0, 0, 16, 1, rgb(0xfae978));
    p.rect(0, 15, 16, 1, rgb(0xc4a428));
    p.edgeShade(6);
  },
  iron_block: (p) => {
    p.valueNoise(rgb(0xd8d8d8), 7, 4, 4, 2);
    p.rect(0, 0, 16, 1, rgb(0xeeeeee));
    p.rect(0, 15, 16, 1, rgb(0xb4b4b4));
    p.edgeShade(7);
  },
  diamond_block: (p) => {
    p.valueNoise(rgb(0x5fdfd6), 10, 4, 4, 2);
    p.oreBlobs(rgb(0x9ff2ea), rgb(0x3fada4), 6, 1.7);
    p.edgeShade(9);
  },
  lapis_block: (p) => {
    p.valueNoise(rgb(0x2b4bab), 14, 4, 4, 2);
    p.oreBlobs(rgb(0x4a6cd0), rgb(0x1a2e6a), 6, 1.8);
    p.edgeShade(10);
  },

  // --- 木材 ---
  planks: (p) => {
    // 横向木纹：格点在 x 上少（沿板长变化慢）、y 上多（跨板变化快）
    p.grain(rgb(0xb08a52), 17);
    const seam = rgb(0x8a6a3c);
    for (const y of [0, 5, 10, 15]) p.hLine(y, seam);
    // 板缝下面提一行亮的：板与板之间才有台阶感，不然只是四条深线
    for (const y of [1, 6, 11]) for (let x = 0; x < 16; x++) p.setWrapped(x, y, 0xc0, 0x99, 0x5e, 255);
    p.edgeShade(8);
  },
  log_side: (p) => {
    // 树皮的特征是几道明确的深沟 + 沟旁的亮棱，不是连续的竖条纹
    barkRidges(p, rgb(0x6f5433), 4);
    p.edgeShade(10);
  },
  log_top: (p) => {
    p.valueNoise(rgb(0x9a7b4f), 12, 5, 5, 2);
    // 年轮。半径上加一点抖动，正圆看着像靶子
    for (const r of [2, 4, 6]) {
      for (let a = 0; a < 96; a++) {
        const t = (a / 96) * Math.PI * 2;
        const rr = r + (p.rand() - 0.5) * 0.7;
        p.set(Math.round(7.5 + Math.cos(t) * rr), Math.round(7.5 + Math.sin(t) * rr), 0x6b, 0x50, 0x30);
      }
    }
    p.edgeShade(11);
  },
  bookshelf: (p) => {
    p.grain(rgb(0xb08a52), 14);
    for (const rowY of [1, 9]) {
      for (let x = 0; x < 16; x += 3) {
        const hue = [0x8b3a3a, 0x3a5f8b, 0x4f8b3a, 0x8b7a3a][Math.floor(p.rand() * 4)] ?? 0x8b3a3a;
        const c = rgb(hue);
        p.rect(x, rowY, 2, 6, c);
        // 每本书的书脊左侧提亮一条，一排书才分得开
        for (let y = rowY; y < rowY + 6; y++) p.set(x, y, c.r + 22, c.g + 22, c.b + 22);
      }
    }
    p.edgeShade(9);
  },
  crafting_table_top: (p) => {
    p.grain(rgb(0xa5763f), 13);
    for (let i = 1; i < 3; i++) { p.hLine(i * 5, rgb(0x6b4a24)); p.vLine(i * 5, rgb(0x6b4a24)); }
    p.edgeShade(9);
  },
  crafting_table_side: (p) => {
    p.grain(rgb(0xb08a52), 13);
    p.rect(0, 0, 16, 4, rgb(0x8a6a3c));
    p.rect(2, 6, 5, 4, rgb(0x7a5a2c));
    p.rect(9, 6, 5, 4, rgb(0x7a5a2c));
    p.edgeShade(9);
  },
  // --- M15/M16 的维度方块 ---
  //
  // 两张传送门都是**动画**贴图（见 block-textures 的 ANIMATED 表）：
  // 静止的紫色矩形一眼假，而门在 MC 里最显著的特征恰恰是它一直在流动。
  // 这里画的是第 0 帧，其余帧由动画表按相位重算。
  nether_portal: (p) => {
    // 底色偏黑的紫，不是亮紫 —— 门是**半透明**的，亮紫叠在背景上会发白
    p.valueNoise(rgb(0x51189c), 9, 6, 6, 2);
    // 竖直拉长的涡流。传送门的纹理感是"竖着流"，横向的斑点会像大理石
    for (let x = 0; x < 16; x++) {
      const f = p.noiseField(1, 6, 2);
      for (let y = 0; y < 16; y++) {
        const v = f[y]!;
        if (v > 0.62) p.shade(x, y, 40 + v * 60);
        else if (v < 0.3) p.shade(x, y, -30);
      }
    }
    p.blobs(rgb(0xb46cff), 5, 1.1, 7);
    p.quantize(6);
  },
  // 末地门是"透过一个洞看见星空"，所以底是纯黑加几点星
  end_portal: (p) => {
    p.fill(rgb(0x0a0616));
    p.grain(rgb(0x140a24), 6);
    for (let i = 0; i < 18; i++) {
      const x = Math.floor(p.rand() * 16);
      const y = Math.floor(p.rand() * 16);
      const b = 120 + p.rand() * 120;
      p.set(x, y, b * 0.7, b * 0.8, b);
    }
    p.blobs(rgb(0x2a1a52), 4, 1.4, 6);
  },
  end_portal_frame_top: (p) => {
    p.valueNoise(rgb(0xdcdca8), 12, 5, 5, 2);
    // 中间一圈凹槽，末影之眼就嵌在这里
    p.rect(3, 3, 10, 10, rgb(0x4a5a3c));
    // 凹槽的立体感：上/左压暗，下/右提亮 —— 与 UI 的凹陷框同一套光照约定
    for (let i = 3; i < 13; i++) {
      p.shade(i, 3, -34); p.shade(3, i, -34);
      p.shade(i, 12, 26); p.shade(12, i, 26);
    }
    p.blobs(rgb(0x3a4a30), 4, 1.2, 5);
    p.edgeShade(10);
  },
  end_portal_frame_side: (p) => {
    p.valueNoise(rgb(0xdcdca8), 12, 5, 5, 2);
    p.blobs(rgb(0xc2c28a), 6, 1.6, 11);
    // 上沿三格是那圈凹槽的侧面，明显更暗
    p.rect(0, 0, 16, 3, rgb(0x4a5a3c));
    p.edgeShade(9);
  },
  dragon_egg: (p) => {
    p.fill(rgb(0x0d0d12));
    p.grain(rgb(0x16161e), 8);
    // 蛋壳上的浅色斑点，越靠上越亮 —— 让蛋在暗处也读得出立体
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        if (p.rand() < 0.16) {
          const b = 26 + (15 - y) * 3.2;
          p.set(x, y, 0x18 + b, 0x12 + b * 0.7, 0x28 + b);
        }
      }
    }
    p.blobs(rgb(0x2b1c3a), 5, 1.5, 7);
    p.quantize(5);
  },

  // 灰度：由 FOLIAGE tint 染色
  leaves: (p) => {
    p.valueNoise(rgb(0xc8c8c8), 12, 8, 8, 2);
    p.blobs(rgb(0xb8b8b8), 7, 1.2, 10);
    p.blobs(rgb(0xd6d6d6), 6, 1.0, 8);
    // 孔洞必须**成团**。原来 noiseFill 的 density 是逐像素独立挖孔，
    // 出来是一张均匀的筛子，退开看就是一层灰雾；成团的孔才像枝叶间的缝隙
    p.holes(0.73, 7);
  },
};
