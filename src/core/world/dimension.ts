/**
 * 维度。**纯数据 + 纯坐标换算，不碰世界对象。**
 *
 * MC 1.0 有三个维度，靠三样东西区分：
 *
 *   1. **坐标比例** —— 下界 1 格 = 主世界 8 格。这一条是下界唯一的
 *      玩法价值（走 100 格顶主世界 800 格），也是"传送门链接"整个
 *      系统存在的理由。
 *   2. **有没有天光** —— 下界与末地没有。这不只是亮度问题：没有天光
 *      就没有昼夜、没有天气、没有"晚上刷怪"，怪物在任何时刻都刷。
 *   3. **有没有天花板** —— 下界顶上是基岩。它决定了床会炸、
 *      也决定了地形生成是"从地面往上长"还是"两头往中间夹"。
 *
 * 放在 core 是因为这三样都是**规则**，服务端要用（生成、传送），
 * 客户端也要用（天空怎么画、雾什么颜色）。
 *
 * ## 为什么 id 是 -1 / 0 / 1
 *
 * 沿用 MC 的真实数值，与方块 id 同一个理由：对照原版时不需要换算。
 * 代价是不能拿它当数组下标，所以下面的表用 Record 而不是数组。
 */

export const Dimension = {
  NETHER: -1,
  OVERWORLD: 0,
  END: 1,
} as const;
export type DimensionId = (typeof Dimension)[keyof typeof Dimension];

export const ALL_DIMENSIONS: readonly DimensionId[] = [
  Dimension.OVERWORLD, Dimension.NETHER, Dimension.END,
];

export interface DimensionDef {
  readonly id: DimensionId;
  /** 存档目录名与指令里用的名字 */
  readonly name: string;
  /**
   * 与主世界的坐标比例。主世界坐标 ÷ scale = 本维度坐标。
   * 下界是 8，其余是 1。**Y 永远不缩放** —— 缩放 Y 的话
   * 下界顶部会映射到主世界 1024 格高，那里什么都没有。
   */
  readonly coordScale: number;
  /** 有没有天光。没有的话昼夜、天气、按光照刷怪全部不适用 */
  readonly hasSkyLight: boolean;
  /** 有没有基岩天花板 */
  readonly hasCeiling: boolean;
  /**
   * 没有天光时的环境光底数（0..15）。
   *
   * 下界给 4：不是纯黑，远处的地形能看出轮廓 —— MC 的下界正是这种
   * "到处都有点暗红的光"的感觉。末地给 0，靠自身的天空色照亮。
   */
  readonly ambientLight: number;
  /** 新玩家/传送落点找不到落脚点时的兜底 Y */
  readonly defaultSpawnY: number;
}

export const DIMENSIONS: Readonly<Record<DimensionId, DimensionDef>> = {
  [Dimension.OVERWORLD]: {
    id: Dimension.OVERWORLD, name: 'overworld', coordScale: 1,
    hasSkyLight: true, hasCeiling: false, ambientLight: 0, defaultSpawnY: 64,
  },
  [Dimension.NETHER]: {
    id: Dimension.NETHER, name: 'nether', coordScale: 8,
    hasSkyLight: false, hasCeiling: true, ambientLight: 4, defaultSpawnY: 64,
  },
  [Dimension.END]: {
    id: Dimension.END, name: 'end', coordScale: 1,
    hasSkyLight: false, hasCeiling: false, ambientLight: 0, defaultSpawnY: 64,
  },
};

export function dimensionOf(id: number): DimensionDef {
  const d = DIMENSIONS[id as DimensionId];
  if (d === undefined) throw new Error(`没有这个维度：${id}`);
  return d;
}

export function isDimension(id: number): id is DimensionId {
  return DIMENSIONS[id as DimensionId] !== undefined;
}

/**
 * 把一个坐标从 `from` 维度换算到 `to` 维度。
 *
 * 只有水平坐标缩放，Y 原样带过去。
 *
 * ## 为什么是先乘后除而不是先除后乘
 *
 * 主世界 → 下界是 ÷8，下界 → 主世界是 ×8。写成"先换算到主世界尺度，
 * 再换算到目标尺度"这一种形式，任意两个维度之间就都通了，
 * 而不必为每一对写一遍 —— 末地 ↔ 下界虽然游戏里去不了，
 * 但指令 `tp` 允许，而写死方向的实现在那里会算错。
 *
 * 取整用 floor 而不是 round：方块坐标的语义就是 floor（−0.5 属于方块 −1），
 * 用 round 的话负坐标会整体偏一格，而那种偏差只在世界的一半出现。
 */
export function convertCoords(
  from: DimensionId, to: DimensionId, x: number, z: number,
): { x: number; z: number } {
  const ratio = DIMENSIONS[from].coordScale / DIMENSIONS[to].coordScale;
  return { x: Math.floor(x * ratio), z: Math.floor(z * ratio) };
}

/**
 * 在目标维度里搜索已有传送门的半径（格）。
 *
 * MC 1.0 是 128。给大了的后果不是"更方便"而是"门会串"：
 * 主世界两座相距 1000 格的门（下界里相距 125 格）会连到同一个下界门，
 * 于是从 A 进去、出来、再进去，人到了 B。这是 MC 里真实存在的坑，
 * 照抄这个数才能复现同样的行为。
 */
export const PORTAL_SEARCH_RADIUS = 128;
