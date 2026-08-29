/**
 * 流体与火。
 *
 * 从 blocks.ts 里分出来，因为它们共享一套与普通方块很不一样的性质：
 * 没有碰撞体积、可被替换、按元数据变高度、有各自的计划刻节奏。
 *
 * **id 照抄 MC**：流动水 8 / 静止水 9 / 流动岩浆 10 / 静止岩浆 11 / 火 51。
 * "流动"和"静止"是两个 id 而不是一个标志位，这是 1.0 的历史包袱，
 * 但必须照搬 —— 存档格式、合成表、所有对照资料都按这套写。
 * TNT（46）在 blocks-crafted.ts 里已有，这里只负责点燃它。
 *
 * 元数据 0..7 是**液面高度的反向**：0 = 满（也就是源），7 = 最薄。
 * 加上 8 那一位表示"从上面落下来"，那种流体不管 level 是几都按满格算。
 */
import { defineBlock, type BlockDef } from '../core/block/block-def.ts';
import { ModelKind, RenderLayer, SoundGroup, TintKind } from '../core/block/types.ts';
import { layerModel } from '../core/block/block-model.ts';
import type { BlockRegistry } from '../core/registry/block-registry.ts';

export const FluidBlocks = {
  FLOWING_WATER: 'flowing_water',
  WATER: 'water',
  FLOWING_LAVA: 'flowing_lava',
  LAVA: 'lava',
  FIRE: 'fire',
} as const;

/** 水的最大流动距离：源之外还能流 7 格 */
export const WATER_MAX_LEVEL = 7;
/** 岩浆在主世界只流 3 格（下界 7 格） */
export const LAVA_MAX_LEVEL = 3;
/** 水每多少刻流一次 */
export const WATER_TICK_RATE = 5;
/** 岩浆每多少刻流一次（主世界） */
export const LAVA_TICK_RATE = 30;
/** "从上面落下来"的标志位 */
export const FALLING_BIT = 8;

/** 元数据里的液面高度：0 是源（满格），7 最薄 */
export function fluidLevel(meta: number): number {
  return meta & 7;
}
export function isFalling(meta: number): boolean {
  return (meta & FALLING_BIT) !== 0;
}

/**
 * 某个液面高度画多高（1/16 格）。
 *
 * 照抄 MC 的 `getFluidHeightPercent`：液面 = 1 − (level+1)/9，也就是
 * **十六分之十六乘 (8−level)/9**。分母是 9 而不是 8，所以：
 *   源（level 0）→ 14.2/16，站在水面上时视线正好在水下一点，
 *                  这个差是"水面"这个观感的来源
 *   最薄（level 7）→ 1.8/16，**不是 0** —— 线性插值写成 14−level×2
 *                  会让 level 7 变成零高度，那一格水就彻底消失了
 *
 * 落下来的（falling）一律按满格画，否则瀑布中间会出现一道道缝。
 */
export function fluidHeight(meta: number): number {
  if (isFalling(meta)) return 16;
  return 16 * (8 - fluidLevel(meta)) / 9;
}

function fluidBlock(
  id: number, name: string, still: boolean, lava: boolean,
): BlockDef {
  return defineBlock({
    id,
    name,
    // 流体挖不动也砸不烂，但它会被别的方块替换掉
    hardness: 100,
    blastResistance: 500,
    solid: false,
    opaque: lava,
    // 水吸光：每格扣 3 级，这是"水底越深越暗"的来源。岩浆自己发光
    opacity: lava ? 0 : 3,
    lightEmission: lava ? 15 : 0,
    replaceable: true,
    modelKind: ModelKind.FLUID,
    modelFor: (meta) => layerModel(fluidHeight(meta)),
    textures: still ? (lava ? 'lava' : 'water') : (lava ? 'lava_flow' : 'water_flow'),
    renderLayer: lava ? RenderLayer.OPAQUE : RenderLayer.TRANSLUCENT,
    tint: lava ? TintKind.NONE : TintKind.WATER,
    soundGroup: SoundGroup.CLOTH,
    // 流体之间互相不画面：两格水中间不该有一层膜
    cullSameType: true,
    // 没有碰撞盒 —— 玩家会掉进去而不是站在上面
    collisionShape: [],
  });
}

/** 注册流体与火 */
export function registerFluidBlocks(r: BlockRegistry): void {
  r.register(fluidBlock(8, FluidBlocks.FLOWING_WATER, false, false));
  r.register(fluidBlock(9, FluidBlocks.WATER, true, false));
  r.register(fluidBlock(10, FluidBlocks.FLOWING_LAVA, false, true));
  r.register(fluidBlock(11, FluidBlocks.LAVA, true, true));

  r.register(defineBlock({
    id: 51,
    name: FluidBlocks.FIRE,
    hardness: 0,
    blastResistance: 0,
    solid: false,
    opaque: false,
    opacity: 0,
    lightEmission: 15,
    replaceable: true,
    // 火是两片交叉的方片，和草一样 —— 但它是自发光的，所以走 CUTOUT 而非
    // TRANSLUCENT：火苗要么画要么不画，没有半透明的部分
    modelKind: ModelKind.CROSS,
    textures: 'fire',
    renderLayer: RenderLayer.CUTOUT,
    soundGroup: SoundGroup.CLOTH,
    collisionShape: [],
    randomTick: true,
  }));
}

/** 这个方块 id 是不是水（流动或静止） */
export function isWaterId(id: number): boolean {
  return id === 8 || id === 9;
}
/** 是不是岩浆 */
export function isLavaId(id: number): boolean {
  return id === 10 || id === 11;
}
/** 是不是流体 */
export function isFluidId(id: number): boolean {
  return id >= 8 && id <= 11;
}
/** 流体的"静止"形态 id */
export function stillIdOf(id: number): number {
  return isWaterId(id) ? 9 : 11;
}
/** 流体的"流动"形态 id */
export function flowingIdOf(id: number): number {
  return isWaterId(id) ? 8 : 10;
}
