/**
 * 物品图标的程序化生成。
 *
 * 一百二十多件物品逐个画像素画不现实，所以按**原型**生成：
 * 锭 / 宝石 / 粉末 / 工具（柄 + 头）/ 剑 / 盔甲 / 食物 / 容器。
 * 同一原型换个配色就是另一件物品 —— 这正是 MC 自己的做法，
 * 铁镐和钻石镐的图形完全一样，只有头部颜色不同。
 *
 * 关键是**同一类物品必须共用同一个形状**：玩家是靠形状认"这是把镐"、
 * 靠颜色认"这是铁的"。两者混起来（比如每把镐形状略有不同）会让物品栏
 * 变得读不懂，而这种坏处很难在单个图标上看出来。
 */
import { rgb, type Rgb, type TilePainter } from './texgen.ts';

type Painter = (p: TilePainter) => void;

/** 清空成全透明 */
function clear(p: TilePainter): void {
  p.clear();
}

function px(p: TilePainter, x: number, y: number, c: Rgb, a = 255): void {
  p.set(x, y, c.r, c.g, c.b, a);
}

function fillRect(p: TilePainter, x0: number, y0: number, w: number, h: number, c: Rgb): void {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) px(p, x, y, c);
}

/** 加深/提亮，用来给图标做一点体积感 */
function shade(c: Rgb, f: number): Rgb {
  return {
    r: Math.max(0, Math.min(255, Math.round(c.r * f))),
    g: Math.max(0, Math.min(255, Math.round(c.g * f))),
    b: Math.max(0, Math.min(255, Math.round(c.b * f))),
  };
}

// ---------------------------------------------------------------------------
// 原型
// ---------------------------------------------------------------------------

/** 锭：一条带斜切角的方块 */
function ingot(color: Rgb): Painter {
  return (p) => {
    clear(p);
    const hi = shade(color, 1.25);
    const lo = shade(color, 0.7);
    for (let y = 5; y < 11; y++) {
      const inset = y < 8 ? 8 - y : y - 7;
      for (let x = 2 + inset; x < 14 - inset; x++) px(p, x, y, color);
    }
    for (let x = 4; x < 12; x++) px(p, x, 5, hi);
    for (let x = 4; x < 12; x++) px(p, x, 10, lo);
  };
}

/** 宝石：菱形 */
function gem(color: Rgb): Painter {
  return (p) => {
    clear(p);
    const hi = shade(color, 1.3);
    for (let y = 3; y < 13; y++) {
      const half = 6 - Math.abs(y - 8);
      for (let x = 8 - half; x < 8 + half; x++) px(p, x, y, color);
    }
    for (let y = 5; y < 8; y++) for (let x = 6; x < 9; x++) px(p, x, y, hi);
  };
}

/** 粉末/颗粒：一撮散点 */
/**
 * 粉末：一小堆散开的颗粒。红石、火药、糖、骨粉、种子用它。
 *
 * 原来撒在 10×8 的范围里、共 26 粒，太散 —— 读起来像"图标坏了掉渣"，
 * 不像一堆粉。收紧到一个中心堆，边缘再稀疏几粒才像。
 */
function dust(color: Rgb): Painter {
  return (p) => {
    clear(p);
    for (let i = 0; i < 34; i++) {
      // 两次随机取平均 -> 往中心聚，边缘自然变稀
      const x = 4 + Math.floor((p.rand() + p.rand()) * 4);
      const y = 7 + Math.floor((p.rand() + p.rand()) * 3);
      px(p, x, y, p.rand() < 0.3 ? shade(color, 1.3) : color);
    }
  };
}

/**
 * 矿块：一整块带棱角的疙瘩。煤与木炭用它。
 *
 * 它们原来走的是 `dust` —— 于是煤炭是"26 粒近黑的碎点撒在透明底上"，
 * 压在深色快捷栏上几乎完全看不见。煤在 MC 里是**一整块**，
 * 形状信息全在轮廓上，散点把轮廓彻底丢了。
 */
function lump(color: Rgb): Painter {
  return (p) => {
    clear(p);
    const hi = shade(color, 1.7);
    for (let y = 4; y < 13; y++) {
      // 每行宽度不同，边界带抖动 —— 规则的椭圆看着像颗药丸
      const half = 5 - Math.round(Math.abs(y - 8) * 0.7);
      const jitter = p.rand() < 0.35 ? 1 : 0;
      for (let x = 8 - half - jitter; x <= 7 + half; x++) px(p, x, y, color);
    }
    // 左上一小片高光，煤那种"玻璃质"的反光靠它
    for (let i = 0; i < 4; i++) px(p, 5 + (i % 2), 6 + Math.floor(i / 2), hi);
  };
}

/** 木棍：一条斜线 */
const stick: Painter = (p) => {
  clear(p);
  const wood = rgb(0x9a7a44);
  for (let i = 0; i < 11; i++) {
    px(p, 4 + i, 12 - i, wood);
    px(p, 5 + i, 12 - i, shade(wood, 0.8));
  }
};

/**
 * 工具：一根斜柄 + 一个头。
 * head 决定头部形状 —— 玩家靠这个形状认工具种类。
 */
function tool(head: 'pickaxe' | 'axe' | 'shovel' | 'hoe', color: Rgb): Painter {
  return (p) => {
    clear(p);
    const wood = rgb(0x8a6a3a);
    // 柄：从左下到右上
    for (let i = 0; i < 9; i++) px(p, 4 + i, 13 - i, wood);
    for (let i = 0; i < 9; i++) px(p, 5 + i, 13 - i, shade(wood, 0.8));

    const hi = shade(color, 1.25);
    switch (head) {
      case 'pickaxe':
        // 一道横跨的弧
        for (let x = 3; x < 14; x++) px(p, x, 4 - (x > 5 && x < 11 ? 1 : 0), color);
        for (let x = 3; x < 14; x++) px(p, x, 5 - (x > 5 && x < 11 ? 1 : 0), hi);
        px(p, 2, 5, color); px(p, 13, 5, color);
        break;
      case 'axe':
        // 一块靠左的斧头
        fillRect(p, 3, 2, 6, 6, color);
        fillRect(p, 3, 2, 6, 2, hi);
        px(p, 2, 4, color); px(p, 2, 5, color);
        break;
      case 'shovel':
        // 一个铲面
        fillRect(p, 9, 2, 5, 5, color);
        fillRect(p, 9, 2, 5, 2, hi);
        break;
      case 'hoe':
        // 一横一竖的锄头
        fillRect(p, 8, 2, 6, 2, color);
        fillRect(p, 8, 4, 2, 2, hi);
        break;
    }
  };
}

/** 剑：斜刃 + 护手 + 柄 */
function sword(color: Rgb): Painter {
  return (p) => {
    clear(p);
    const hi = shade(color, 1.3);
    for (let i = 0; i < 9; i++) {
      px(p, 4 + i, 11 - i, color);
      px(p, 5 + i, 11 - i, hi);
    }
    const guard = rgb(0x8a6a3a);
    px(p, 3, 12, guard); px(p, 4, 13, guard); px(p, 5, 12, guard);
    px(p, 2, 13, guard); px(p, 3, 14, guard);
  };
}

/** 盔甲：四个部位各一个剪影 */
function armor(slot: 'helmet' | 'chestplate' | 'leggings' | 'boots', color: Rgb): Painter {
  return (p) => {
    clear(p);
    const hi = shade(color, 1.2);
    switch (slot) {
      case 'helmet':
        fillRect(p, 3, 4, 10, 4, color);
        fillRect(p, 3, 8, 3, 3, color);
        fillRect(p, 10, 8, 3, 3, color);
        fillRect(p, 3, 4, 10, 1, hi);
        break;
      case 'chestplate':
        fillRect(p, 3, 3, 10, 9, color);
        fillRect(p, 2, 4, 2, 5, color);
        fillRect(p, 12, 4, 2, 5, color);
        fillRect(p, 5, 3, 6, 1, hi);
        break;
      case 'leggings':
        fillRect(p, 3, 2, 10, 4, color);
        fillRect(p, 3, 6, 4, 8, color);
        fillRect(p, 9, 6, 4, 8, color);
        fillRect(p, 3, 2, 10, 1, hi);
        break;
      case 'boots':
        fillRect(p, 2, 8, 5, 5, color);
        fillRect(p, 9, 8, 5, 5, color);
        fillRect(p, 2, 8, 5, 1, hi);
        fillRect(p, 9, 8, 5, 1, hi);
        break;
    }
  };
}

/** 食物：一个不规则的团 */
function blob(color: Rgb, spot?: Rgb): Painter {
  return (p) => {
    clear(p);
    const hi = shade(color, 1.2);
    for (let y = 3; y < 13; y++) {
      const half = Math.round(5 - Math.abs(y - 8) * 0.35);
      for (let x = 8 - half; x < 8 + half; x++) px(p, x, y, color);
    }
    for (let x = 6; x < 10; x++) px(p, x, 4, hi);
    if (spot !== undefined) {
      for (let i = 0; i < 6; i++) {
        px(p, 5 + Math.floor(p.rand() * 6), 6 + Math.floor(p.rand() * 5), spot);
      }
    }
  };
}

/** 桶/碗一类的容器剪影 */
function vessel(color: Rgb, fill: Rgb | null): Painter {
  return (p) => {
    clear(p);
    for (let y = 5; y < 13; y++) {
      const inset = Math.floor((y - 5) / 4);
      for (let x = 3 + inset; x < 13 - inset; x++) px(p, x, y, color);
    }
    if (fill !== null) fillRect(p, 5, 6, 6, 3, fill);
    for (let x = 3; x < 13; x++) px(p, x, 5, shade(color, 1.3));
  };
}

/** 细长条：骨头、羽毛、甘蔗 */
function rodShape(color: Rgb): Painter {
  return (p) => {
    clear(p);
    const hi = shade(color, 1.25);
    for (let i = 0; i < 12; i++) {
      px(p, 3 + i, 12 - i, color);
      px(p, 4 + i, 12 - i, hi);
    }
  };
}

// ---------------------------------------------------------------------------
// 每件物品用哪个原型
// ---------------------------------------------------------------------------

const MATERIAL: Record<string, Rgb> = {
  wooden: rgb(0x9a7a44),
  stone: rgb(0x8a8a8a),
  iron: rgb(0xd8d8d8),
  golden: rgb(0xf0d040),
  diamond: rgb(0x5ce0d8),
  leather: rgb(0xa06840),
};

function toolIcons(): Record<string, Painter> {
  const out: Record<string, Painter> = {};
  for (const [mat, color] of Object.entries(MATERIAL)) {
    if (mat === 'leather') continue;
    out[`${mat}_pickaxe`] = tool('pickaxe', color);
    out[`${mat}_axe`] = tool('axe', color);
    out[`${mat}_shovel`] = tool('shovel', color);
    out[`${mat}_hoe`] = tool('hoe', color);
    out[`${mat}_sword`] = sword(color);
  }
  for (const [mat, color] of Object.entries(MATERIAL)) {
    if (mat === 'wooden' || mat === 'stone') continue;
    for (const slot of ['helmet', 'chestplate', 'leggings', 'boots'] as const) {
      out[`${mat}_${slot}`] = armor(slot, color);
    }
  }
  return out;
}

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
  string: (p) => {
    clear(p);
    const c = rgb(0xe0e0e0);
    for (let i = 0; i < 12; i++) px(p, 4 + Math.floor(Math.sin(i * 0.9) * 3) + 3, 2 + i, c);
  },
  feather: rodShape(rgb(0xf0f0f0)),
  gunpowder: dust(rgb(0x808080)),
  redstone: dust(rgb(0xd02020)),
  glowstone_dust: dust(rgb(0xf0e0a0)),
  sugar: dust(rgb(0xf8f8f8)),
  bone: rodShape(rgb(0xf0f0e0)),
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
    for (let i = 0; i < 12; i++) { px(p, 7, 2 + i, c); px(p, 8, 2 + i, shade(c, 1.2)); }
    for (let y = 3; y < 11; y += 2) { px(p, 5, y, c); px(p, 10, y, c); }
  },
  sugar_cane: rodShape(rgb(0x9ac46a)),
  dye: dust(rgb(0x3a5a2a)),

  // --- 食物 ---
  apple: blob(rgb(0xd02020), rgb(0x40a040)),
  golden_apple: blob(rgb(0xf0d040), rgb(0xfff0a0)),
  bread: blob(rgb(0xc09040)),
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
    for (let y = 4; y < 13; y++) {
      const half = Math.round((y - 3) * 0.7);
      for (let x = 8 - half; x < 8 + half; x++) px(p, x, y, rgb(0xd04040));
    }
    for (let x = 3; x < 14; x++) px(p, x, 13, rgb(0x5a9a3a));
  },
  mushroom_stew: vessel(rgb(0x9a7a54), rgb(0xa08050)),
  cake_item: (p) => { clear(p); fillRect(p, 2, 5, 12, 7, rgb(0xf0e8d8)); fillRect(p, 2, 5, 12, 2, rgb(0xd04040)); },

  // --- 器具 ---
  bowl: vessel(rgb(0x9a7a54), null),
  bucket: vessel(rgb(0xc0c0c0), null),
  water_bucket: vessel(rgb(0xc0c0c0), rgb(0x3050d0)),
  lava_bucket: vessel(rgb(0xc0c0c0), rgb(0xf07020)),
  milk_bucket: vessel(rgb(0xc0c0c0), rgb(0xf8f8f8)),
  glass_bottle: vessel(rgb(0xc0e0e8), null),
  potion: vessel(rgb(0xc0e0e8), rgb(0xd040d0)),
  cauldron_item: vessel(rgb(0x4a4a4a), null),
  brewing_stand_item: rodShape(rgb(0xa0a0a0)),
  // 打火石：一把钢条 + 一块燧石。原来是两个不挨着的矩形，
  // 读不出是一件东西 —— 两部分必须接触，眼睛才把它们当成一个物体
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
    const w = rgb(0x9a7a44);
    for (let i = 0; i < 12; i++) {
      const t = i / 11;
      px(p, 3 + Math.round(Math.sin(t * Math.PI) * 6), 2 + i, w);
    }
    for (let i = 0; i < 12; i++) px(p, 3, 2 + i, rgb(0xf0f0f0));
  },
  arrow: (p) => {
    clear(p);
    const s = rgb(0x9a7a44);
    for (let i = 0; i < 10; i++) px(p, 7, 4 + i, s);
    fillRect(p, 6, 2, 4, 3, rgb(0xd8d8d8));
    px(p, 6, 12, rgb(0xf0f0f0)); px(p, 9, 12, rgb(0xf0f0f0));
  },
  fishing_rod: (p) => {
    clear(p);
    const w = rgb(0x9a7a44);
    for (let i = 0; i < 10; i++) px(p, 4 + i, 12 - i, w);
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
