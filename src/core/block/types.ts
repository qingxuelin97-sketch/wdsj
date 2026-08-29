/**
 * 方块系统的基础类型。
 *
 * 全部用 `as const` 对象 + 联合类型，不用 enum —— Node 的类型剥离只支持可擦除语法。
 * 见 docs/RULES.md 第 2 条。
 */

/** 面朝向。编号与 MC 一致，且与 mesher 的 FACES 表、顶点格式的 face 字段共用同一套编号 */
export const Facing = {
  DOWN: 0,
  UP: 1,
  NORTH: 2,
  SOUTH: 3,
  WEST: 4,
  EAST: 5,
} as const;
export type Facing = (typeof Facing)[keyof typeof Facing];

/** 各朝向的坐标偏移，下标即 Facing 值 */
export const FACING_OFFSET: readonly (readonly [number, number, number])[] = [
  [0, -1, 0], // DOWN
  [0, 1, 0], // UP
  [0, 0, -1], // NORTH
  [0, 0, 1], // SOUTH
  [-1, 0, 0], // WEST
  [1, 0, 0], // EAST
];

/** 相对的面 */
export const FACING_OPPOSITE: readonly Facing[] = [
  Facing.UP,
  Facing.DOWN,
  Facing.SOUTH,
  Facing.NORTH,
  Facing.EAST,
  Facing.WEST,
];

/** 挖掘工具类别。null 表示任意工具都算"对口"（如泥土） */
export const ToolKind = {
  PICKAXE: 0,
  AXE: 1,
  SHOVEL: 2,
  HOE: 3,
  SWORD: 4,
  SHEARS: 5,
} as const;
export type ToolKind = (typeof ToolKind)[keyof typeof ToolKind];

/** 工具材质等级，用于判断能否挖出掉落物（钻石镐才挖得动黑曜石） */
export const ToolTier = {
  WOOD: 0,
  GOLD: 0, // 金和木同级：挖得快但一样只能挖低级方块
  STONE: 1,
  IRON: 2,
  DIAMOND: 3,
} as const;
export type ToolTier = (typeof ToolTier)[keyof typeof ToolTier];

/**
 * 渲染层。
 * OPAQUE 全不透明，正常深度写入；
 * CUTOUT 有全透明像素（树叶、草、玻璃板），着色器 discard，仍写深度；
 * TRANSLUCENT 半透明（水、冰），需要按距离排序且不写深度。
 */
export const RenderLayer = {
  OPAQUE: 0,
  CUTOUT: 1,
  TRANSLUCENT: 2,
} as const;
export type RenderLayer = (typeof RenderLayer)[keyof typeof RenderLayer];

/**
 * 生物群系染色。
 * 草和树叶的贴图本身是灰度的，最终颜色由所在群系的色表决定 —— 这是让截图
 * "一眼看上去就是 MC"的最便宜的手段之一。
 */
export const TintKind = {
  NONE: 0,
  GRASS: 1,
  FOLIAGE: 2,
  WATER: 3,
} as const;
export type TintKind = (typeof TintKind)[keyof typeof TintKind];

/** 音效组，决定脚步声、破坏声、放置声 */
export const SoundGroup = {
  STONE: 0,
  WOOD: 1,
  GRAVEL: 2,
  GRASS: 3,
  METAL: 4,
  GLASS: 5,
  CLOTH: 6,
  SAND: 7,
  SNOW: 8,
  LADDER: 9,
} as const;
export type SoundGroup = (typeof SoundGroup)[keyof typeof SoundGroup];

/**
 * 方块模型种类。
 * CUBE 是绝大多数方块；CROSS 是十字billboard（花、草、树苗、作物）；
 * FLUID 是带 8 级高度的液面；CUSTOM 用 elements[] 描述任意盒子组合
 * （楼梯、半砖、栅栏、门、火把、铁轨、玻璃板、蛋糕、床…）。
 */
export const ModelKind = {
  NONE: 0, // 空气，不渲染
  CUBE: 1,
  CROSS: 2,
  FLUID: 3,
  CUSTOM: 4,
} as const;
export type ModelKind = (typeof ModelKind)[keyof typeof ModelKind];
