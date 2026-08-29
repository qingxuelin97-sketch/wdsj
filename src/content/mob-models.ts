/**
 * 生物模型：一组带颜色的盒子。
 *
 * MC 的生物模型就是若干个长方体（`ModelRenderer`），贴图从一张图上按 UV 取。
 * 这里保留"若干个长方体"的结构，但先用**纯色 + 少量细节盒**代替贴图 ——
 * 生物贴图的程序化生成放在 M14 表现层，和音效、天气、粒子一起做。
 *
 * 这样做不是省事：一只生物能不能被认出来，主要靠**轮廓**和**主色**。
 * 苦力怕是"细高的绿柱子加四条短腿"，蜘蛛是"扁宽的黑身子加八条腿"，
 * 这两件事在纯色下一样成立。反过来，贴图再准，盒子摆错了照样不像。
 *
 * 坐标单位是 1/16 格（与方块模型一致），原点在生物脚底中心，+Z 是朝向。
 */
import { MobType } from './mobs.ts';

/** 一个盒子。x/y/z 是最小角，w/h/d 是尺寸，都以 1/16 格为单位 */
export interface MobBox {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
  readonly h: number;
  readonly d: number;
  /** RGB，0..1 */
  readonly color: readonly [number, number, number];
  /**
   * 这个盒子随走路摆动的相位。
   *   0 = 不动（身体、头）
   *   1 / −1 = 前后摆（腿、手臂），符号相反的两条腿才是交替迈步
   */
  readonly swing?: number;
  /** 属于头部：跟着 headYaw 转，而不是身体朝向 */
  readonly head?: boolean;
}

export interface MobModel {
  readonly boxes: readonly MobBox[];
}

const b = (
  x: number, y: number, z: number, w: number, h: number, d: number,
  color: readonly [number, number, number],
  extra: { swing?: number; head?: boolean } = {},
): MobBox => ({ x, y, z, w, h, d, color, ...extra });

// --- 常用配色 ---
const ZOMBIE_SKIN: readonly [number, number, number] = [0.32, 0.53, 0.31];
const ZOMBIE_SHIRT: readonly [number, number, number] = [0.24, 0.35, 0.55];
const ZOMBIE_PANTS: readonly [number, number, number] = [0.28, 0.28, 0.42];
const BONE_WHITE: readonly [number, number, number] = [0.83, 0.83, 0.80];
const CREEPER_GREEN: readonly [number, number, number] = [0.35, 0.68, 0.30];
const CREEPER_DARK: readonly [number, number, number] = [0.20, 0.42, 0.18];
const SPIDER_BODY: readonly [number, number, number] = [0.24, 0.19, 0.16];
const SPIDER_LEG: readonly [number, number, number] = [0.16, 0.12, 0.10];
const ENDER_BLACK: readonly [number, number, number] = [0.08, 0.08, 0.10];
const ENDER_EYE: readonly [number, number, number] = [0.75, 0.30, 0.95];
const PIG_PINK: readonly [number, number, number] = [0.94, 0.62, 0.62];
const PIG_SNOUT: readonly [number, number, number] = [0.83, 0.49, 0.51];
const COW_BROWN: readonly [number, number, number] = [0.29, 0.22, 0.17];
const COW_WHITE: readonly [number, number, number] = [0.85, 0.85, 0.85];
const SHEEP_WOOL: readonly [number, number, number] = [0.93, 0.93, 0.90];
const SHEEP_SKIN: readonly [number, number, number] = [0.85, 0.70, 0.62];
const CHICKEN_WHITE: readonly [number, number, number] = [0.93, 0.93, 0.93];
const CHICKEN_BEAK: readonly [number, number, number] = [0.90, 0.65, 0.15];
const CHICKEN_LEG: readonly [number, number, number] = [0.85, 0.55, 0.12];
const EYE_DARK: readonly [number, number, number] = [0.05, 0.05, 0.06];

/**
 * 人形：僵尸与骷髅共用的骨架。
 *
 * 僵尸的手臂在 MC 里是**平举**的，骷髅是垂下的 —— 这个差别比配色更好认，
 * 远远看见一个平举双手的剪影就知道该跑了。
 */
function humanoid(
  skin: readonly [number, number, number],
  shirt: readonly [number, number, number],
  pants: readonly [number, number, number],
  armsForward: boolean,
  slim: boolean,
): MobModel {
  const armW = slim ? 2 : 4;
  const armX = slim ? 4 : 4;
  return {
    boxes: [
      // 头（跟着 headYaw 转）
      b(-4, 24, -4, 8, 8, 8, skin, { head: true }),
      // 眼睛：一小片深色，让"脸朝哪"看得出来
      b(-3, 27, -4.5, 2, 2, 1, EYE_DARK, { head: true }),
      b(1, 27, -4.5, 2, 2, 1, EYE_DARK, { head: true }),
      // 身体
      b(-4, 12, -2, 8, 12, 4, shirt),
      // 手臂
      armsForward
        ? b(-armX - armW, 15, -10, armW, 3, 12, skin)
        : b(-armX - armW, 12, -2, armW, 12, 4, skin, { swing: 1 }),
      armsForward
        ? b(armX, 15, -10, armW, 3, 12, skin)
        : b(armX, 12, -2, armW, 12, 4, skin, { swing: -1 }),
      // 腿
      b(-4, 0, -2, 4, 12, 4, pants, { swing: -1 }),
      b(0, 0, -2, 4, 12, 4, pants, { swing: 1 }),
    ],
  };
}

/** 四足动物：猪、牛、羊共用 */
function quadruped(
  body: readonly [number, number, number],
  head: readonly [number, number, number],
  legs: readonly [number, number, number],
  bodyH: number,
  legH: number,
  extras: readonly MobBox[] = [],
): MobModel {
  const bodyY = legH;
  return {
    boxes: [
      // 身体（横躺的长方体）
      b(-5, bodyY, -8, 10, bodyH, 16, body),
      // 头
      b(-4, bodyY + bodyH - 6, -14, 8, 8, 6, head, { head: true }),
      b(-2.5, bodyY + bodyH - 2, -14.5, 1.5, 1.5, 1, EYE_DARK, { head: true }),
      b(1, bodyY + bodyH - 2, -14.5, 1.5, 1.5, 1, EYE_DARK, { head: true }),
      // 四条腿：前后各一对，同侧前后反相才像在走路
      b(-5, 0, -7, 4, legH, 4, legs, { swing: 1 }),
      b(1, 0, -7, 4, legH, 4, legs, { swing: -1 }),
      b(-5, 0, 3, 4, legH, 4, legs, { swing: -1 }),
      b(1, 0, 3, 4, legH, 4, legs, { swing: 1 }),
      ...extras,
    ],
  };
}

const MODELS = new Map<MobType, MobModel>();

MODELS.set(MobType.ZOMBIE, humanoid(ZOMBIE_SKIN, ZOMBIE_SHIRT, ZOMBIE_PANTS, true, false));
MODELS.set(MobType.SKELETON, humanoid(BONE_WHITE, BONE_WHITE, BONE_WHITE, false, true));

MODELS.set(MobType.CREEPER, {
  boxes: [
    b(-4, 18, -4, 8, 8, 8, CREEPER_GREEN, { head: true }),
    // 苦力怕那张脸：两只眼加一张嘴
    b(-3, 22, -4.5, 2, 2, 1, EYE_DARK, { head: true }),
    b(1, 22, -4.5, 2, 2, 1, EYE_DARK, { head: true }),
    b(-1, 19, -4.5, 2, 3, 1, EYE_DARK, { head: true }),
    b(-1, 20, -4.5, 4, 1, 1, EYE_DARK, { head: true }),
    b(-3, 20, -4.5, 2, 1, 1, EYE_DARK, { head: true }),
    // 身体：细高的柱子，这是苦力怕最好认的地方
    b(-4, 6, -2, 8, 12, 4, CREEPER_GREEN),
    // 四条短腿
    b(-4, 0, -4, 4, 6, 4, CREEPER_DARK, { swing: 1 }),
    b(0, 0, -4, 4, 6, 4, CREEPER_DARK, { swing: -1 }),
    b(-4, 0, 0, 4, 6, 4, CREEPER_DARK, { swing: -1 }),
    b(0, 0, 0, 4, 6, 4, CREEPER_DARK, { swing: 1 }),
  ],
});

MODELS.set(MobType.SPIDER, {
  boxes: [
    // 扁而宽的身子 + 单独的头胸，八条腿向两侧张开
    b(-5, 3, -3, 10, 8, 12, SPIDER_BODY),
    b(-4, 4, -11, 8, 8, 8, SPIDER_BODY, { head: true }),
    b(-3, 9, -11.5, 2, 2, 1, [0.85, 0.15, 0.15], { head: true }),
    b(1, 9, -11.5, 2, 2, 1, [0.85, 0.15, 0.15], { head: true }),
    // 左四右四。z 各不相同，看着才像蜘蛛而不是一排栅栏
    b(-13, 4, -6, 8, 2, 2, SPIDER_LEG, { swing: 1 }),
    b(-13, 4, -2, 8, 2, 2, SPIDER_LEG, { swing: -1 }),
    b(-13, 4, 2, 8, 2, 2, SPIDER_LEG, { swing: 1 }),
    b(-13, 4, 6, 8, 2, 2, SPIDER_LEG, { swing: -1 }),
    b(5, 4, -6, 8, 2, 2, SPIDER_LEG, { swing: -1 }),
    b(5, 4, -2, 8, 2, 2, SPIDER_LEG, { swing: 1 }),
    b(5, 4, 2, 8, 2, 2, SPIDER_LEG, { swing: -1 }),
    b(5, 4, 6, 8, 2, 2, SPIDER_LEG, { swing: 1 }),
  ],
});

MODELS.set(MobType.ENDERMAN, {
  boxes: [
    b(-4, 40, -4, 8, 8, 8, ENDER_BLACK, { head: true }),
    // 紫色的眼睛 —— 末影人在黑暗里唯一看得见的部分
    b(-4, 43, -4.5, 3, 1.5, 1, ENDER_EYE, { head: true }),
    b(1, 43, -4.5, 3, 1.5, 1, ENDER_EYE, { head: true }),
    b(-4, 26, -2, 8, 14, 4, ENDER_BLACK),
    // 细长的手脚，这是末影人的全部特征
    b(-6, 26, -1, 2, 22, 2, ENDER_BLACK, { swing: 1 }),
    b(4, 26, -1, 2, 22, 2, ENDER_BLACK, { swing: -1 }),
    b(-3, 0, -1, 2, 26, 2, ENDER_BLACK, { swing: -1 }),
    b(1, 0, -1, 2, 26, 2, ENDER_BLACK, { swing: 1 }),
  ],
});

MODELS.set(MobType.PIG, quadruped(PIG_PINK, PIG_PINK, PIG_PINK, 8, 6, [
  b(-2, 8, -15, 4, 3, 1, PIG_SNOUT, { head: true }),
]));
MODELS.set(MobType.COW, quadruped(COW_BROWN, COW_BROWN, COW_BROWN, 10, 12, [
  // 白斑与犄角
  b(-5.2, 14, -4, 4, 5, 6, COW_WHITE),
  b(1.2, 14, 2, 4, 4, 5, COW_WHITE),
  b(-5, 22, -13, 2, 3, 2, COW_WHITE, { head: true }),
  b(3, 22, -13, 2, 3, 2, COW_WHITE, { head: true }),
]));
MODELS.set(MobType.SHEEP, quadruped(SHEEP_WOOL, SHEEP_SKIN, SHEEP_SKIN, 12, 12, []));
MODELS.set(MobType.CHICKEN, {
  boxes: [
    b(-3, 5, -3, 6, 6, 8, CHICKEN_WHITE),
    b(-2, 9, -6, 4, 6, 3, CHICKEN_WHITE, { head: true }),
    b(-1, 11, -7.5, 2, 2, 2, CHICKEN_BEAK, { head: true }),
    b(-1, 14, -5, 2, 2, 3, [0.85, 0.15, 0.15], { head: true }),
    // 翅膀
    b(-4, 6, -2, 1, 4, 6, CHICKEN_WHITE),
    b(3, 6, -2, 1, 4, 6, CHICKEN_WHITE),
    b(-2, 0, -1, 1.5, 5, 3, CHICKEN_LEG, { swing: 1 }),
    b(0.5, 0, -1, 1.5, 5, 3, CHICKEN_LEG, { swing: -1 }),
  ],
});

/** 羊毛的 16 种颜色。羊的第一个盒子（身体）用它染色 */
export const WOOL_COLORS: readonly (readonly [number, number, number])[] = [
  [0.93, 0.93, 0.90], [0.92, 0.51, 0.20], [0.72, 0.30, 0.79], [0.39, 0.55, 0.79],
  [0.78, 0.72, 0.19], [0.35, 0.70, 0.20], [0.85, 0.55, 0.63], [0.26, 0.26, 0.26],
  [0.60, 0.63, 0.63], [0.19, 0.49, 0.55], [0.50, 0.25, 0.70], [0.15, 0.25, 0.62],
  [0.35, 0.24, 0.14], [0.22, 0.35, 0.14], [0.62, 0.20, 0.19], [0.09, 0.09, 0.10],
];

export function mobModelOf(type: number): MobModel | null {
  return MODELS.get(type as MobType) ?? null;
}
