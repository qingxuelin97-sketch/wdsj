/**
 * 工具、武器、盔甲这一组图标。
 *
 * 从 `item-recipes.ts` 里拆出来，一是那个文件已经过了 400 行软上限，
 * 二是这一组共用一套"斜柄 + 头"的骨架，放一起才看得出它们是不是对齐的：
 * 五把工具的柄必须**一模一样**，玩家是靠头部形状认工具、靠颜色认材质的，
 * 柄若各画各的，物品栏一排工具会显得像五个不同的游戏拼出来的。
 */
import { rgb, type Rgb, type TilePainter } from './texgen.ts';
import { MATERIAL, type Painter, clear, fillRect, lift, px, shade, woodHandle } from './item-recipes-common.ts';

/**
 * 金属的四级色阶。
 *
 * 为什么要四级：`buildAtlas` 把物品量化到 6 色，两三级色阶用不满这个预算，
 * 出来的东西是"一块平涂 + 一条高光"，看着像塑料。金属之所以像金属，
 * 靠的是**亮部到暗部跨度大**且中间有过渡 —— 高光近白、暗部近黑。
 */
function tones(c: Rgb): { hi: Rgb; body: Rgb; lo: Rgb; dark: Rgb } {
  return {
    hi: lift(shade(c, 1.15), 22),
    body: c,
    lo: shade(c, 0.68),
    dark: shade(c, 0.42),
  };
}

// 柄的固定几何：底端 (2,13)，长 10 格，顶端占 (11,4)-(12,4)。
// 四种头都按这个顶点接：改了这里就得把四个 head 的接点一起改
function handle(p: TilePainter): void {
  woodHandle(p, 2, 13, 10);
}

/**
 * 镐：柄顶上扣一道 ∩ 形的弧，两端收成尖。
 *
 * 原来是一条平的横杠加两个凸起，读出来是"锤子"或者"八字胡"。
 * 镐之所以是镐，全在**两端向下的尖**上 —— 弧顶高、两臂垂下来，
 * 这个剪影缩到 16px 也认得出。
 */
function pickHead(p: TilePainter, c: Rgb): void {
  const t = tones(c);
  for (let x = 3; x <= 15; x++) {
    // 抛物线：中间高（y 小）、两端低。系数 4.8 —— 3.4 的时候两臂只垂下两格，
    // 剪影读出来是"锤子"；要垂到接近柄的中段，那两个向下的尖才立得住
    const top = Math.round(4.8 * ((x - 9) / 6) ** 2);
    const thick = Math.abs(x - 9) >= 5 ? 2 : 3; // 两端薄一格 = 尖
    for (let k = 0; k < thick; k++) {
      px(p, x, top + k, k === 0 ? t.hi : k === thick - 1 ? t.lo : t.body);
    }
  }
}

/** 斧：柄顶朝左伸出一块楔子，左缘是刃（最亮的一列） */
function axeHead(p: TilePainter, c: Rgb): void {
  const t = tones(c);
  // 顶行不能收得比下面窄太多，否则剪影是个朝右上的三角形（"鲨鱼鳍"）。
  // 斧头是**方头**的：上下两条边近乎平行，只有左缘的刃是弧的
  const rows: [number, number][] = [[5, 11], [4, 11], [3, 11], [3, 11], [3, 10], [4, 9], [6, 8]];
  for (let r = 0; r < rows.length; r++) {
    const [x0, x1] = rows[r]!;
    for (let x = x0; x <= x1; x++) {
      // 刃口（最左一列）提到最亮：斧子的辨识点是那条竖直的亮刃，
      // 整块平涂的话就只是个方疙瘩
      px(p, x, 1 + r, x === x0 ? t.hi : x >= x1 - 1 ? t.lo : t.body);
    }
  }
}

/** 锹：柄顶上一块铲面，下面收出一个銎 */
function shovelHead(p: TilePainter, c: Rgb): void {
  const t = tones(c);
  // 铲面要够大。原来是 5 格宽扣在柄顶上，读出来是"一根火柴"或者勺子 ——
  // 铲子的比例是"大面 + 细柄"，面小了就不是铲子了
  const rows: [number, number][] = [[10, 13], [9, 14], [9, 14], [9, 14], [9, 14], [10, 13], [11, 12]];
  for (let r = 0; r < rows.length; r++) {
    const [x0, x1] = rows[r]!;
    for (let x = x0; x <= x1; x++) {
      px(p, x, r, r === 0 || x === x0 ? t.hi : x === x1 ? t.lo : t.body);
    }
  }
}

/** 锄：一条横刃 + 左端垂下的一颗齿 */
function hoeHead(p: TilePainter, c: Rgb): void {
  const t = tones(c);
  // 刃要三行厚：两行的时候加上描边只剩一条黑线，缩到 16px 完全糊掉
  for (let x = 8; x <= 14; x++) {
    px(p, x, 1, t.hi);
    px(p, x, 2, x <= 10 ? t.body : t.lo);
    px(p, x, 3, t.lo);
  }
  // 齿：锄和镐的区别就在这一小截往下的钩，没有它是把"铲子横着放"
  for (let y = 4; y <= 6; y++) { px(p, 8, y, t.body); px(p, 9, y, t.lo); }
}

/** 工具：一根斜柄 + 一个头。head 决定头部形状 —— 玩家靠这个形状认工具种类。 */
export function tool(head: 'pickaxe' | 'axe' | 'shovel' | 'hoe', color: Rgb): Painter {
  return (p) => {
    clear(p);
    handle(p);
    // 头**画在柄之后**：头是挡在柄前面的实体，柄画上去会从头中间穿过
    switch (head) {
      case 'pickaxe': pickHead(p, color); break;
      case 'axe': axeHead(p, color); break;
      case 'shovel': shovelHead(p, color); break;
      case 'hoe': hoeHead(p, color); break;
    }
  };
}

/**
 * 剑：斜刃 + 十字护手 + 柄。
 *
 * 原来只有一条 2px 的斜线加一撮棕色，读出来是"一根染了色的棍子"。
 * 剑的三个必要特征：
 *   - 刃有厚度且**左亮右暗**（左上受光的那一面），这是"金属片"的观感来源
 *   - 一道**垂直于刃**的护手，这是剑与棍唯一的形状差别
 *   - 尖端收窄
 */
export function sword(color: Rgb): Painter {
  return (p) => {
    clear(p);
    const t = tones(color);
    const guard = shade(color, 0.5);
    // 刃：每行三格（亮/本体/暗），逐行右移一格。
    // 必须按"横向三连"画，不能按垂直方向加粗斜线 —— 后者只在对角相邻，
    // 描边会顺着缝隙钻进刃的中间，把一把剑切成两条虚线
    for (let y = 10; y >= 3; y--) {
      const x0 = 4 + (10 - y);
      px(p, x0, y, t.hi); px(p, x0 + 1, y, t.body); px(p, x0 + 2, y, t.lo);
    }
    px(p, 12, 2, t.hi); px(p, 13, 2, t.body); // 尖：收成两格
    // 护手：沿另一条对角线，同样用"横向两连"保证四邻连通
    for (let k = 0; k <= 3; k++) { px(p, 3 + k, 9 + k, guard); px(p, 4 + k, 9 + k, t.dark); }
    // 柄与柄头
    const w = rgb(0x6a4a28);
    for (let k = 0; k < 3; k++) {
      px(p, 3 - k, 11 + k, shade(w, 1.25));
      px(p, 4 - k, 11 + k, w);
    }
    px(p, 2, 13, t.dark);
  };
}

/**
 * 盔甲：四个部位各一个剪影。
 *
 * 加了一层内侧暗边与顶部高光条 —— 原来是整块平涂，四件放一排像四张色卡。
 * 甲片的辨识度靠的是**边缘的厚度感**，不是形状本身（形状已经很小了）。
 */
export function armor(slot: 'helmet' | 'chestplate' | 'leggings' | 'boots', color: Rgb): Painter {
  return (p) => {
    clear(p);
    const t = tones(color);
    const band = (x0: number, y: number, w: number): void => fillRect(p, x0, y, w, 1, t.hi);
    switch (slot) {
      // ## 面窗与领口必须是**透明的洞**，不是深色的块
      //
      // 填成深色时，`outline()` 只沿外缘描一圈，那个"洞"就成了甲片上的
      // 一块补丁 —— 头盔读出来是台烤面包机、胸甲是台洗衣机。
      // 留空的话描边会绕着洞也描一圈，剪影本身就说明了"这里是脸/脖子"。
      case 'helmet':
        fillRect(p, 4, 3, 8, 1, t.hi); // 顶：收窄一格做出圆顶
        fillRect(p, 3, 4, 10, 4, t.body);
        fillRect(p, 3, 8, 3, 3, t.body); // 左颊
        fillRect(p, 10, 8, 3, 3, t.body); // 右颊 —— 中间 x=6..9 留空 = 面窗
        band(4, 4, 8);
        fillRect(p, 4, 7, 8, 1, t.lo);
        fillRect(p, 11, 5, 2, 3, t.lo);
        break;
      case 'chestplate':
        fillRect(p, 3, 4, 10, 8, t.body);
        band(3, 3, 4); band(9, 3, 4); // 两片肩甲，中间 x=7,8 留空 = 领口
        fillRect(p, 2, 4, 2, 5, t.body);
        fillRect(p, 12, 4, 2, 5, t.body);
        fillRect(p, 11, 5, 2, 6, t.lo);
        fillRect(p, 4, 5, 1, 6, t.hi);
        fillRect(p, 3, 11, 10, 1, t.lo);
        break;
      case 'leggings':
        fillRect(p, 3, 2, 10, 4, t.body);
        fillRect(p, 3, 6, 4, 8, t.body);
        fillRect(p, 9, 6, 4, 8, t.body);
        band(3, 2, 10);
        fillRect(p, 3, 5, 10, 1, t.lo); // 腰带
        fillRect(p, 11, 7, 2, 7, t.lo);
        break;
      case 'boots':
        fillRect(p, 2, 8, 5, 5, t.body);
        fillRect(p, 9, 8, 5, 5, t.body);
        band(2, 8, 5); band(9, 8, 5);
        fillRect(p, 2, 12, 5, 1, t.dark); // 鞋底
        fillRect(p, 9, 12, 5, 1, t.dark);
        fillRect(p, 5, 9, 2, 3, t.lo);
        fillRect(p, 12, 9, 2, 3, t.lo);
        break;
    }
  };
}

/** 木棍：一条斜线。工具柄的独立版本，几何与 `woodHandle` 一致 */
export const stick: Painter = (p) => {
  clear(p);
  woodHandle(p, 3, 12, 10);
};

export function toolIcons(): Record<string, Painter> {
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
