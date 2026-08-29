/**
 * 挖掘进度。
 *
 * 复刻 MC 1.0 的 `Block.blockStrength`：**每 tick 累加一个"强度"，累到 1 就破坏**。
 *
 *   能收获（工具对口且级别够）：strength = 工具速度 / 硬度 / 30
 *   不能收获：                  strength = 工具速度 / 硬度 / 100
 *
 * 那个 30 与 100 的比值就是"用错工具慢三倍多"的全部来源。徒手挖石头
 * 是 1/1.5/100 = 0.00667，需要 150 tick = 7.5 秒 —— 正是 MC 里的时间。
 *
 * 这里不做"硬度 × 1.5"那种简化公式：简化式在"能收获但工具不对口"
 * （比如用铲子挖石头）这一类上会算错，而那恰恰是玩家最常遇到的情况。
 */
import type { ToolKind, ToolTier } from './types.ts';

/** 方块表里 −1 表示"用什么工具都一样" */
const NO_TOOL = -1;

/** 挖掘计算需要的方块属性 */
export interface BreakingTables {
  /** −1 表示不可破坏（基岩） */
  readonly hardness: Float32Array;
  /** 对口的工具种类，−1 表示任意工具都一样 */
  readonly tool: Int8Array;
  /** 能收获所需的最低工具级别 */
  readonly minTier: Uint8Array;
  /** 收获是否必须有对口工具（1 = 是） */
  readonly requiresTool: Uint8Array;
}

/** 手上工具的描述。空手传 null */
export interface HeldTool {
  kind: ToolKind;
  tier: ToolTier;
  /** 挖掘速度倍率：木 2 / 石 4 / 铁 6 / 钻 8 / 金 12 */
  speed: number;
}

/** 工具对不对得上这个方块 */
export function isCorrectTool(tables: BreakingTables, blockId: number, tool: HeldTool | null): boolean {
  const needed = tables.tool[blockId] ?? NO_TOOL;
  if (needed === NO_TOOL) return true;
  return tool !== null && tool.kind === needed;
}

/**
 * 能否收获（破坏后掉落方块本身）。
 *
 * 注意"能不能挖动"和"能不能收获"是两回事：徒手也挖得动石头，
 * 只是慢，而且什么都不掉。这个区分是 MC 早期游戏体验的核心之一。
 */
export function canHarvest(tables: BreakingTables, blockId: number, tool: HeldTool | null): boolean {
  // "哪种工具最快"和"收获是否**必须**有工具"是两件事：泥土是铲子最快，
  // 但徒手照样能挖到泥土；石头是镐最快，而且**必须**用镐才掉东西。
  // 混成一个判断的话，游戏一开局就没法挖泥土建房了。
  if (tables.requiresTool[blockId] !== 1) return true;
  const needed = tables.tool[blockId] ?? NO_TOOL;
  if (needed === NO_TOOL) return true;
  if (tool === null || tool.kind !== needed) return false;
  return tool.tier >= (tables.minTier[blockId] ?? 0);
}

/** 手上工具对这个方块的速度倍率。不对口一律 1 */
export function toolSpeedAgainst(tables: BreakingTables, blockId: number, tool: HeldTool | null): number {
  if (tool === null) return 1;
  return isCorrectTool(tables, blockId, tool) ? tool.speed : 1;
}

/**
 * 每 tick 累加的挖掘进度，0..1。累计到 1 时方块破坏。
 *
 * @param onGround 悬空时速度只有五分之一 —— MC 的规则，边跳边挖会明显变慢
 * @param inWater  水下且没有水下速掘时同样是五分之一
 */
export function breakProgressPerTick(
  tables: BreakingTables,
  blockId: number,
  tool: HeldTool | null,
  onGround = true,
  inWater = false,
): number {
  const hardness = tables.hardness[blockId] ?? 0;
  if (hardness < 0) return 0;      // 基岩之类，永远挖不动
  if (hardness === 0) return 1;    // 火把、花这类，一下就没

  let speed = toolSpeedAgainst(tables, blockId, tool);
  if (inWater) speed /= 5;
  if (!onGround) speed /= 5;

  const divisor = canHarvest(tables, blockId, tool) ? 30 : 100;
  return speed / hardness / divisor;
}

/** 挖穿需要多少 tick。返回 Infinity 表示挖不动 */
export function ticksToBreak(
  tables: BreakingTables,
  blockId: number,
  tool: HeldTool | null,
  onGround = true,
  inWater = false,
): number {
  const per = breakProgressPerTick(tables, blockId, tool, onGround, inWater);
  if (per <= 0) return Infinity;
  return Math.ceil(1 / per);
}

/** 裂纹贴图的阶段，0..9；未开始挖返回 −1 */
export function crackStage(progress: number): number {
  if (progress <= 0) return -1;
  return Math.min(9, Math.floor(progress * 10));
}
