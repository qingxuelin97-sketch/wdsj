/**
 * 物品图标的程序化生成。
 *
 * 一百二十多件物品逐个画像素画不现实，所以按**原型**生成：
 * 锭 / 宝石 / 粉末 / 工具（柄 + 头）/ 剑 / 盔甲 / 食物 / 容器。
 * 同一原型换个配色就是另一件物品 —— 这正是 MC 自己的做法。
 * 关键是**同一类物品共用同一个形状**：玩家靠形状认"这是把镐"、靠颜色认"这是铁的"，
 * 两者混起来物品栏就读不懂了，而这种坏处很难在单个图标上看出来。
 *
 * 描边与体积感**不在这里做**：`buildAtlas` 对所有物品统一跑
 * `formShade()` + `outline()`，这里再加一遍会得到双层黑边。
 * 但它跑在 `quantize(6)` **之后** —— 这里画的色阶会被压到 6 种，
 * 而且量化是**按像素数加权**的 k-means：几格孤立的亮点会被质心吃掉
 * （煤的高光、苹果的叶子都栽在这上面）。要留住一种颜色，
 * 要么给它足够的面积，要么让它在 RGB 空间里离得足够远。
 * 每个原型都该给到 4 级：暗部 / 本体 / 亮部 / 高光 —— 两三级出来是塑料。
 */
import { rgb, type Rgb } from './texgen.ts';
import { type Painter, clear, fillRect, lift, px, shade } from './item-recipes-common.ts';
import { stick, toolIcons } from './item-recipes-tools.ts';

// 工具/武器/盔甲那一组搬到了 item-recipes-tools.ts（本文件已过 400 行软上限）。
// 转出去让外部仍能按原型取用，省得调用方去记"哪个原型在哪个文件"。
export { armor, sword, stick, tool } from './item-recipes-tools.ts';

// ---------------------------------------------------------------------------
// 原型
// ---------------------------------------------------------------------------

/** 按行给出 [左端, 右端] 的实心形状，行从 y0 开始。返回每行的跨度供上色用 */
function rows(p: import('./texgen.ts').TilePainter, y0: number, spans: readonly (readonly [number, number])[],
  tint: (x: number, y: number, x0: number, x1: number) => Rgb): void {
  for (let r = 0; r < spans.length; r++) {
    const [x0, x1] = spans[r]!;
    for (let x = x0; x <= x1; x++) px(p, x, y0 + r, tint(x, y0 + r, x0, x1));
  }
}

/**
 * 锭：一块带顶面的长方体。
 *
 * 原来是"上下各一条亮线夹一块平涂"，读出来是一张纸片。锭是**立体**的：
 * 上表面朝天最亮、正面本体、底棱最暗，三段之间要有明确的分界线
 * （不是渐变）—— 分界线才是"这是一块有厚度的金属"的全部信息。
 */
function ingot(color: Rgb): Painter {
  return (p) => {
    clear(p);
    const top = lift(shade(color, 1.18), 20);
    const lo = shade(color, 0.72);
    const dark = shade(color, 0.5);
    // 上面两行是顶面（往右上方斜出去），下面四行是正面，正面必须比顶面**厚**：
    // 反过来的话（顶面占一半高）读出来是一张折了一下的纸，没有块的重量
    const spans: [number, number][] = [[6, 13], [5, 12], [4, 12], [4, 12], [4, 12], [4, 11]];
    rows(p, 5, spans, (x, y, x0) => (y <= 6 ? top : x === x0 ? lift(color, 22) : y <= 8 ? color : lo));
    // 底棱：整条压到最暗，锭才"坐"在那儿而不是浮着
    for (let x = 4; x <= 11; x++) px(p, x, 10, dark);
    // 顶面上一小段高光，位置固定在左半边（光从左上来）
    for (let x = 7; x <= 10; x++) px(p, x, 5, lift(top, 30));
  };
}

/**
 * 宝石：切割过的菱形，带刻面。
 *
 * 原来是"菱形平涂 + 左上一块亮斑"，那是一颗塑料珠子。宝石看着像宝石，
 * 靠的是**刻面之间的硬边**：台面最亮、冠部左右分明暗、亭部收一条竖棱。
 * 边界必须是硬的 —— 一旦成了渐变，量化会把它抹成一片，又变回珠子。
 */
function gem(color: Rgb): Painter {
  return (p) => {
    clear(p);
    const table = lift(shade(color, 1.35), 24);
    const hi = shade(color, 1.12);
    const lo = shade(color, 0.72);
    const deep = shade(color, 0.56);
    const spans: [number, number][] = [
      [6, 9], [5, 10], [4, 11], [3, 12], [3, 12], [4, 11], [5, 10], [6, 9], [6, 9], [7, 8],
    ];
    rows(p, 2, spans, (x, y) => {
      if (y <= 3) return table; // 台面
      if (y >= 6 && y <= 8 && x >= 7 && x <= 8) return deep; // 亭部中央的竖棱
      if (y <= 5) return x <= 7 ? hi : color; // 冠部：左亮右本体
      return x <= 7 ? color : lo; // 亭部：左本体右暗
    });
    // 闪光：两格，够了。再多就成了"图标上沾了白点"
    px(p, 5, 4, lift(table, 40)); px(p, 6, 4, lift(table, 40));
  };
}

/**
 * 粉末：一小堆散开的颗粒。红石、火药、糖、骨粉、种子用它。
 *
 * 两次随机取平均 -> 往中心聚，边缘自然变稀。撒得太散读起来像"图标坏了掉渣"。
 */
function dust(color: Rgb): Painter {
  return (p) => {
    clear(p);
    const hi = lift(color, 34);
    const lo = shade(color, 0.62);
    // 每粒画成 2 格的小簇，不画孤立单点。
    // 单点撒开读出来是"图标坏了在掉渣"（红石那张尤其像血溅），
    // 两格连着才有颗粒的体积，一堆才聚得成"一撮粉"
    for (let i = 0; i < 26; i++) {
      const x = 4 + Math.floor((p.rand() + p.rand()) * 4);
      // 竖向范围要比横向窄：撒成方形一团时，随机咬出来的缺口会让它读成
      // 一个小人（红石那张原来就长了两条腿）。扁一点才是"摊在地上的一撮"
      const y = 7 + Math.floor((p.rand() + p.rand()) * 3);
      const r = p.rand();
      const c = r < 0.28 ? hi : r > 0.78 ? lo : color;
      px(p, x, y, c);
      if (p.rand() < 0.5) px(p, x + 1, y, c); else px(p, x, y + 1, c);
    }
  };
}

/**
 * 矿块：一整块带棱角的疙瘩。煤与木炭用它。
 *
 * 它们走 `dust` 的时候是"散点撒在透明底上"，压在深色快捷栏上几乎看不见 ——
 * 煤在 MC 里是**一整块**，形状信息全在轮廓上。
 *
 * 明暗必须用 `lift`（加常数）而不是 `shade`（乘系数）：煤是 0x2a2a2a，
 * 乘 1.7 之后还是黑的，量化时和本体归进同一簇。
 */
function lump(color: Rgb): Painter {
  return (p) => {
    clear(p);
    // 高光曾经写成三格 lift(+128) 的亮点：三格淹在九十格近黑里，质心被拖回本体，
    // 图标又变回一颗纯黑的球。加大亮度没用，得加大**面积** —— 亮度分四段、
    // 每段各占一片，直方图铺得开，六个质心才分得到人（见文件头那条量化规则）
    const hi = lift(color, 92);
    const mid = lift(color, 44);
    const dark = lift(color, -20);
    // 轮廓故意画成折线（每行左右端跳着走），不是椭圆。
    // 煤是**敲下来的碎块**，圆滑的边缘会读成一颗药丸
    const spans: [number, number][] = [
      [6, 10], [4, 11], [4, 13], [3, 12], [3, 13], [2, 12], [4, 13], [3, 11], [5, 11], [6, 9],
    ];
    // 两条不同角度的解理面，把块面切成三片。一条的话是个"被斜切的球"，
    // 两条才有"敲下来的碎块"那种不规则感
    rows(p, 3, spans, (x, y) => {
      if (x + y < 11) return hi;
      if (x + y > 20 || x - y > 5) return dark;
      return x + y < 15 ? mid : color;
    });
  };
}

/**
 * 食物/圆团：一个接近圆的实心块。
 *
 * 原来每行宽度只差 0.35 格，出来是个圆角矩形 —— 一排食物全是同一个色块，
 * 靠颜色分辨。圆一点、上下收得明显一点，剪影才有区别。
 */
function blob(color: Rgb, spot?: Rgb): Painter {
  return (p) => {
    clear(p);
    const hi = lift(color, 26);
    const lo = shade(color, 0.74);
    const spans: [number, number][] = [
      [6, 9], [4, 11], [3, 12], [3, 12], [3, 12], [3, 12], [3, 12], [4, 11], [5, 10], [6, 9],
    ];
    rows(p, 3, spans, (x, y) => (x + y < 11 ? hi : x + y > 20 ? lo : color));
    px(p, 5, 5, lift(color, 52)); px(p, 6, 5, lift(color, 52)); px(p, 5, 6, lift(color, 40));
    if (spot !== undefined) {
      for (let i = 0; i < 5; i++) px(p, 6 + Math.floor(p.rand() * 5), 7 + Math.floor(p.rand() * 4), spot);
    }
  };
}

/**
 * 容器。三种形制共用一个函数，因为它们的差别只在剪影：
 *   bucket 梯形 + 提梁 / open 梯形（碗、坩埚）/ bottle 细颈圆肚（瓶、药水）
 *
 * 提梁和瓶颈是关键 —— 都画成梯形的话，桶、碗、坩埚、玻璃瓶、药水
 * 是同一个图标的五种配色，物品栏里只能靠颜色猜。
 */
function vessel(color: Rgb, fill: Rgb | null, kind: 'bucket' | 'open' | 'bottle' = 'bucket'): Painter {
  return (p) => {
    clear(p);
    const hi = lift(color, 30);
    const lo = shade(color, 0.68);
    const side = (x: number, _y: number, x0: number, x1: number): Rgb =>
      x === x0 ? hi : x >= x1 - 1 ? lo : color;
    if (kind === 'bottle') {
      rows(p, 3, [[7, 8], [7, 8], [6, 9], [5, 10], [4, 11], [4, 11], [4, 11], [5, 10]], side);
      if (fill !== null) {
        fillRect(p, 5, 8, 6, 3, fill);
        for (let x = 5; x <= 10; x++) px(p, x, 8, lift(fill, 34)); // 液面
      }
      for (let x = 6; x <= 9; x++) px(p, x, 2, shade(color, 0.5)); // 瓶塞
      return;
    }
    rows(p, 6, [[3, 12], [3, 12], [3, 12], [4, 11], [4, 11], [4, 11], [5, 10]], side);
    if (fill !== null) fillRect(p, 4, 6, 8, 3, fill);
    // 桶口：一条横边。装了东西的话这条就是液面（提亮），空的是桶沿（高光）
    for (let x = 3; x <= 12; x++) px(p, x, 6, fill === null ? hi : lift(fill, 34));
    px(p, 3, 6, lo); px(p, 12, 6, lo);
    if (kind === 'bucket') {
      // 提梁：两根立柱 + 一道横梁。少了它桶就是个梯形盆
      px(p, 2, 5, lo); px(p, 13, 5, lo); px(p, 3, 4, lo); px(p, 12, 4, lo);
      for (let x = 4; x <= 11; x++) px(p, x, 3, color);
    }
  };
}

/** 细长条：骨头、羽毛、甘蔗。2px 宽的斜杆，左亮右暗 */
function rodShape(color: Rgb): Painter {
  return (p) => {
    clear(p);
    const hi = lift(color, 26);
    const lo = shade(color, 0.7);
    for (let i = 0; i < 12; i++) {
      px(p, 3 + i, 12 - i, hi);
      px(p, 4 + i, 12 - i, i % 3 === 1 ? shade(color, 0.86) : color);
      px(p, 5 + i, 12 - i, lo);
    }
  };
}

// ---------------------------------------------------------------------------
// 几件必须单独画的（原型套不上，且它们是玩家最常盯着看的）
// ---------------------------------------------------------------------------

/** 苹果：果身 + 果柄 + 一片叶子。少了柄和叶子就只是一个红球 */
const apple: Painter = (p) => {
  const body = rgb(0xc42020), hi = rgb(0xe85a4a), lo = rgb(0x7e1414);
  clear(p);
  const spans: [number, number][] = [
    [5, 7], [4, 11], [3, 12], [3, 12], [3, 12], [3, 12], [3, 12], [4, 11], [5, 10], [6, 9],
  ];
  rows(p, 4, spans, (x, y) => (x + y < 12 ? hi : x + y > 21 ? lo : body));
  // 顶部的凹陷（果柄窝）：把右上角那一块挖回来，苹果才不是个球
  px(p, 8, 4, body); px(p, 9, 4, body); px(p, 10, 4, body); px(p, 11, 4, body);
  px(p, 8, 3, rgb(0x5a3a1a)); px(p, 8, 2, rgb(0x5a3a1a)); // 果柄
  // 叶：三格才看得出是叶子，两格会被当成果柄的一部分。用亮绿 ——
  // 暗绿在量化时会和苹果的暗部并成一簇，叶子整个消失
  px(p, 9, 2, rgb(0x6ade3a)); px(p, 10, 2, rgb(0x6ade3a)); px(p, 11, 2, rgb(0x6ade3a));
  px(p, 10, 3, rgb(0x6ade3a)); px(p, 11, 3, rgb(0x6ade3a)); px(p, 12, 2, rgb(0x6ade3a));
  // 高光只用一种颜色。原来还有一格更深的粉，那一格把六个色号里的一个吃掉了，
  // 结果是叶子的绿被并进红里 —— 图标上只剩果柄，看着像颗草莓
  px(p, 5, 6, rgb(0xff9a86)); px(p, 6, 6, rgb(0xff9a86)); px(p, 5, 7, rgb(0xff9a86));
};

/** 面包：横着的一条烤面包，顶壳亮、底部暗、上面三道割口 */
const bread: Painter = (p) => {
  const body = rgb(0xb07a34), crust = rgb(0xd8a04e), lo = rgb(0x7a4e1e);
  clear(p);
  const spans: [number, number][] = [[5, 10], [3, 12], [2, 13], [2, 13], [2, 13], [2, 13], [3, 12], [5, 10]];
  rows(p, 4, spans, (_x, y) => (y <= 5 ? crust : y >= 10 ? lo : body));
  // 三道割口。少了它就是一块土黄色的圆角砖 —— 割口是"这是面包"的唯一线索。
  // 每道两格长、连成短斜线；单个像素会被眼睛当成脏点而不是刻痕
  for (const x of [4, 7, 10]) {
    px(p, x + 1, 5, lo); px(p, x, 6, lo); px(p, x + 1, 6, lift(lo, 22)); px(p, x, 7, lo);
  }
  for (let x = 5; x <= 9; x++) px(p, x, 4, lift(crust, 26));
};

// ---------------------------------------------------------------------------
// 每件物品用哪个原型
// ---------------------------------------------------------------------------

export const ITEM_RECIPES: Record<string, Painter> = {
  ...toolIcons(),

  // --- 材料 ---
  stick,
  coal: lump(rgb(0x2a2a2a)),
  charcoal: lump(rgb(0x40342a)),
  diamond: gem(rgb(0x5ce0d8)),
  iron_ingot: ingot(rgb(0xd8d8d8)),
  gold_ingot: ingot(rgb(0xf0d040)),
  gold_nugget: lump(rgb(0xd8b830)),
  brick_item: ingot(rgb(0xa05a48)),
  clay_ball: blob(rgb(0xa4a8b8)),
  flint: gem(rgb(0x4a4a4a)),
  string: (p) => { clear(p); for (let i = 0; i < 12; i++) px(p, 7 + Math.floor(Math.sin(i * 0.9) * 3), 2 + i, rgb(0xe0e0e0)); },
  feather: rodShape(rgb(0xf0f0f0)),
  gunpowder: dust(rgb(0x808080)),
  redstone: dust(rgb(0xd02020)),
  glowstone_dust: dust(rgb(0xf0e0a0)),
  sugar: dust(rgb(0xf8f8f8)),
  // 骨头：光一根白棍读出来是"白色的木棍"。两端的骨节是唯一的区分特征
  bone: (p) => {
    rodShape(rgb(0xf0f0e0))(p);
    const c = rgb(0xf0f0e0);
    const lo = shade(c, 0.72);
    for (const [x, y] of [[2, 11], [2, 12], [2, 13], [3, 13], [4, 13]] as const) px(p, x, y, x === 2 ? c : lo);
    for (const [x, y] of [[13, 0], [14, 0], [15, 0], [15, 1], [15, 2]] as const) px(p, x, y, y === 0 ? c : lo);
  },
  bone_meal: dust(rgb(0xf0f0e0)),
  leather: blob(rgb(0xa06840)),
  slimeball: blob(rgb(0x70d070)),
  snowball: blob(rgb(0xf0f8ff)),
  ender_pearl: gem(rgb(0x1a6a5a)),
  eye_of_ender: gem(rgb(0x30a060)),
  blaze_rod: rodShape(rgb(0xf0c020)),
  blaze_powder: dust(rgb(0xf0a020)),
  ghast_tear: gem(rgb(0xd8f0f0)),
  magma_cream: blob(rgb(0xc06020)),
  nether_wart: blob(rgb(0x8a1a2a)),
  spider_eye: blob(rgb(0x8a2020), rgb(0xf0f0f0)),
  fermented_spider_eye: blob(rgb(0x6a4a8a), rgb(0xa0f0a0)),
  glistering_melon: blob(rgb(0xf0d040), rgb(0xd02020)),
  paper: (p) => { clear(p); fillRect(p, 2, 4, 12, 9, rgb(0xf0f0e8)); fillRect(p, 4, 6, 8, 1, rgb(0xc0c0b8)); fillRect(p, 4, 9, 8, 1, rgb(0xc0c0b8)); },
  book: (p) => { clear(p); fillRect(p, 3, 3, 10, 11, rgb(0x9a5030)); fillRect(p, 5, 3, 8, 11, rgb(0xf0f0e0)); },
  seeds: dust(rgb(0x8aa050)),
  pumpkin_seeds: dust(rgb(0xe0e0b0)),
  melon_seeds: dust(rgb(0xd8d8a8)),
  wheat: (p) => {
    clear(p);
    const c = rgb(0xd8c060);
    for (let i = 0; i < 12; i++) { px(p, 7, 2 + i, c); px(p, 8, 2 + i, lift(c, 26)); }
    for (let y = 3; y < 11; y += 2) { px(p, 5, y, shade(c, 0.8)); px(p, 10, y, shade(c, 0.8)); }
  },
  sugar_cane: rodShape(rgb(0x9ac46a)),
  dye: dust(rgb(0x3a5a2a)),

  // --- 食物 ---
  apple,
  golden_apple: blob(rgb(0xf0d040), rgb(0xfff0a0)),
  bread,
  porkchop: blob(rgb(0xe0a0a0), rgb(0xf0d0d0)),
  cooked_porkchop: blob(rgb(0xc07040), rgb(0xe0a070)),
  raw_beef: blob(rgb(0xd06060), rgb(0xf0a0a0)),
  steak: blob(rgb(0x8a4a28), rgb(0xb06a40)),
  raw_chicken: blob(rgb(0xf0c0a0)),
  cooked_chicken: blob(rgb(0xc08a50)),
  raw_fish: blob(rgb(0x8aa0b0), rgb(0xc0d0e0)),
  cooked_fish: blob(rgb(0xc0a070)),
  rotten_flesh: blob(rgb(0x7a5a40), rgb(0x5a4030)),
  cookie: blob(rgb(0xc08a50), rgb(0x4a3020)),
  melon_slice: (p) => {
    clear(p);
    // 三角形的瓤 + 底下一条绿皮。少了绿皮就是"一块红色的三角"
    for (let y = 4; y < 13; y++) {
      const half = Math.round((y - 3) * 0.7);
      for (let x = 8 - half; x < 8 + half; x++) px(p, x, y, y < 7 ? rgb(0xe86060) : rgb(0xd04040));
    }
    for (let x = 3; x < 14; x++) px(p, x, 13, rgb(0x5a9a3a));
  },
  mushroom_stew: vessel(rgb(0x9a7a54), rgb(0xa08050), 'open'),
  cake_item: (p) => { clear(p); fillRect(p, 2, 5, 12, 7, rgb(0xf0e8d8)); fillRect(p, 2, 5, 12, 2, rgb(0xd04040)); },

  // --- 器具 ---
  bowl: vessel(rgb(0x9a7a54), null, 'open'),
  bucket: vessel(rgb(0xc0c0c0), null),
  water_bucket: vessel(rgb(0xc0c0c0), rgb(0x3050d0)),
  lava_bucket: vessel(rgb(0xc0c0c0), rgb(0xf07020)),
  milk_bucket: vessel(rgb(0xc0c0c0), rgb(0xf8f8f8)),
  glass_bottle: vessel(rgb(0xc0e0e8), null, 'bottle'),
  potion: vessel(rgb(0xc0e0e8), rgb(0xd040d0), 'bottle'),
  cauldron_item: vessel(rgb(0x4a4a4a), null, 'open'),
  brewing_stand_item: rodShape(rgb(0xa0a0a0)),
  // 打火石：一把钢条 + 一块燧石。两部分必须接触，眼睛才把它们当成一个物体
  flint_and_steel: (p) => {
    clear(p);
    for (let i = 0; i < 8; i++) { px(p, 3 + i, 9 - i + (i > 4 ? i - 4 : 0), rgb(0xc8c8c8)); px(p, 3 + i, 10 - i + (i > 4 ? i - 4 : 0), rgb(0x8a8a8a)); }
    fillRect(p, 8, 8, 5, 5, rgb(0x50494a));
    fillRect(p, 9, 9, 3, 3, rgb(0x6a6264));
  },
  shears: (p) => {
    clear(p);
    const m = rgb(0xd8d8d8);
    for (let i = 0; i < 8; i++) { px(p, 3 + i, 3 + i, m); px(p, 12 - i, 3 + i, m); }
    fillRect(p, 6, 11, 4, 3, rgb(0x8a6a3a));
  },
  bow: (p) => {
    clear(p);
    // 弓臂是半个正弦，弦是一条直线 —— 两者之间的空当才是"弓"的形状
    for (let i = 0; i < 12; i++) px(p, 3 + Math.round(Math.sin((i / 11) * Math.PI) * 6), 2 + i, rgb(0x9a7a44));
    for (let i = 0; i < 12; i++) px(p, 3, 2 + i, rgb(0xf0f0f0));
  },
  arrow: (p) => {
    clear(p);
    for (let i = 0; i < 10; i++) px(p, 7, 4 + i, rgb(0x9a7a44));
    fillRect(p, 6, 2, 4, 3, rgb(0xd8d8d8));
    px(p, 6, 12, rgb(0xf0f0f0)); px(p, 9, 12, rgb(0xf0f0f0));
  },
  fishing_rod: (p) => {
    clear(p);
    for (let i = 0; i < 10; i++) px(p, 4 + i, 12 - i, rgb(0x9a7a44));
    for (let i = 0; i < 8; i++) px(p, 13, 3 + i, rgb(0xf0f0f0));
  },
  compass: (p) => { clear(p); fillRect(p, 3, 3, 10, 10, rgb(0xb0b0b0)); fillRect(p, 6, 6, 4, 4, rgb(0xf0f0f0)); fillRect(p, 7, 5, 2, 3, rgb(0xd02020)); },
  clock: (p) => { clear(p); fillRect(p, 3, 3, 10, 10, rgb(0xf0d040)); fillRect(p, 6, 6, 4, 4, rgb(0x3050a0)); },
  saddle: (p) => { clear(p); fillRect(p, 3, 5, 10, 6, rgb(0x8a4a28)); fillRect(p, 5, 4, 6, 2, rgb(0xa06840)); },
  minecart: (p) => { clear(p); fillRect(p, 2, 5, 12, 6, rgb(0xb0b0b0)); fillRect(p, 4, 5, 8, 3, rgb(0x707070)); fillRect(p, 3, 11, 3, 2, rgb(0x4a4a4a)); fillRect(p, 10, 11, 3, 2, rgb(0x4a4a4a)); },
  boat: (p) => { clear(p); fillRect(p, 2, 7, 12, 4, rgb(0x9a7a44)); fillRect(p, 4, 6, 8, 2, rgb(0xb08a54)); },
  painting: (p) => { clear(p); fillRect(p, 2, 3, 12, 10, rgb(0x8a6a3a)); fillRect(p, 4, 5, 8, 6, rgb(0x4a6a9a)); },
  sign: (p) => { clear(p); fillRect(p, 2, 3, 12, 7, rgb(0x9a7a44)); fillRect(p, 7, 10, 2, 4, rgb(0x8a6a3a)); },
  door_item: (p) => { clear(p); fillRect(p, 4, 1, 8, 14, rgb(0x9a7a44)); fillRect(p, 5, 2, 6, 5, rgb(0x8a6a3c)); fillRect(p, 5, 8, 6, 5, rgb(0x8a6a3c)); },
  iron_door_item: (p) => { clear(p); fillRect(p, 4, 1, 8, 14, rgb(0xc0c0c0)); fillRect(p, 5, 2, 6, 5, rgb(0xa8a8a8)); fillRect(p, 5, 8, 6, 5, rgb(0xa8a8a8)); },
  bed_item: (p) => { clear(p); fillRect(p, 2, 6, 12, 5, rgb(0xc03030)); fillRect(p, 2, 6, 4, 5, rgb(0xf0f0f0)); fillRect(p, 2, 11, 12, 2, rgb(0x9a7a44)); },
  repeater: (p) => { clear(p); fillRect(p, 2, 8, 12, 4, rgb(0xbdbdbd)); fillRect(p, 5, 6, 2, 3, rgb(0xd02020)); fillRect(p, 9, 6, 2, 3, rgb(0xd02020)); },
  egg: blob(rgb(0xf0e8d8), rgb(0xc0b0a0)),
};
