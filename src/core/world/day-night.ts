/**
 * 昼夜循环。
 *
 * 全部复刻 MC 1.0 的原式，而不是"随便找个正弦凑一下"。
 * 差别不是审美问题：`skyLightSubtracted` 决定了夜里露天的光照等级是多少，
 * 而怪物生成的判据是"方块光 ≤ 7"。这个数值错了，整个夜晚的恐惧循环就错了 ——
 * 要么怪满地跑，要么一只都不刷。
 *
 * 一天 24000 tick：0 = 日出，6000 = 正午，12000 = 日落，18000 = 午夜。
 */
import { DAY_LENGTH_TICKS } from '../constants.ts';

/**
 * 天体角度，0..1。
 *
 * MC 的原式：先把时间平移 1/4 天（因为 0 tick 是日出不是午夜），
 * 再用余弦做一次缓动，最后和线性值按 1:2 混合。
 * 那个 `/3` 的混合是 MC 太阳"中午走得快、地平线附近走得慢"的来源。
 */
export function celestialAngle(timeOfDay: number, partialTick = 0): number {
  let f = ((timeOfDay % DAY_LENGTH_TICKS) + partialTick) / DAY_LENGTH_TICKS - 0.25;
  if (f < 0) f += 1;
  if (f > 1) f -= 1;
  const linear = f;
  const eased = 1 - (Math.cos(f * Math.PI) + 1) / 2;
  return linear + (eased - linear) / 3;
}

/**
 * 天光要减去多少级，0（正午）..11（午夜）。整数。
 *
 * 实际光照 = 存储的天光等级 - 这个值。所以午夜露天是 15-11 = 4 级 ——
 * 正好在"怪物能生成"的 ≤7 之内，这就是夜里地面会刷怪、而白天不会的原因。
 */
export function skyLightSubtracted(timeOfDay: number, rain = 0, thunder = 0): number {
  const angle = celestialAngle(timeOfDay);
  let f = 1 - (Math.cos(angle * Math.PI * 2) * 2 + 0.5);
  f = Math.min(1, Math.max(0, f));
  f = 1 - f;
  f *= 1 - (rain * 5) / 16;
  f *= 1 - (thunder * 5) / 16;
  return Math.floor((1 - f) * 11);
}

/** 太阳整体亮度，0.2（夜）..1.0（昼）。用于缩放天光的颜色贡献 */
export function sunBrightness(timeOfDay: number, rain = 0, thunder = 0): number {
  const angle = celestialAngle(timeOfDay);
  let f = 1 - (Math.cos(angle * Math.PI * 2) * 2 + 0.5);
  f = Math.min(1, Math.max(0, f));
  f = 1 - f;
  f *= 1 - (rain * 5) / 16;
  f *= 1 - (thunder * 5) / 16;
  return f * 0.8 + 0.2;
}

/**
 * MC 的光照亮度曲线：等级 0..15 映射到 0..1，但**不是线性的**。
 *
 *   brightness(l) = (1-f) / (3f+1)，其中 f = 1 - l/15
 *
 * 曲线在低等级处压得很扁（7 级只有 0.18），高等级处才快速抬起来。
 * 这正是 MC 里"光照 7 和 8 看着差别不大，但 13 到 15 差很多"的原因，
 * 也是洞穴里一支火把只能照亮很小一圈的观感来源。
 */
export function lightBrightness(level: number): number {
  const f = 1 - Math.max(0, Math.min(15, level)) / 15;
  return (1 - f) / (f * 3 + 1);
}

/**
 * 天空颜色，随昼夜在白昼蓝与夜空深蓝之间过渡。
 *
 * 下雨时**去饱和 + 压暗**，而不是简单乘一个系数：雨天的天不是"暗一点的蓝"，
 * 是灰的。做法是把 rgb 拉向它们自己的灰度值，再整体压暗。
 * 只压暗不去饱和的话，暴雨天的天空是一片深蓝，看着像夜里而不是像下雨。
 */
export function skyColor(
  timeOfDay: number, rain = 0, thunder = 0,
): { r: number; g: number; b: number } {
  const angle = celestialAngle(timeOfDay);
  // MC 用 cos(angle*2π)*2+0.5 夹到 0..1 当作"白昼程度"
  const day = Math.min(1, Math.max(0, Math.cos(angle * Math.PI * 2) * 2 + 0.5));
  // 日出日落时天空偏暖，用 day 在 0.35 附近的窗口取一个权重
  const dusk = Math.max(0, 1 - Math.abs(day - 0.35) / 0.35);
  const r = (0.11 + 0.42 * day) * (1 - dusk) + 0.72 * dusk;
  const g = (0.13 + 0.53 * day) * (1 - dusk) + 0.42 * dusk;
  const b = (0.26 + 0.63 * day) * (1 - dusk) + 0.32 * dusk;

  // 两个因子**相乘**，和 skyLightSubtracted 是同一个形状。
  //
  // 写成 min(1, rain + thunder) 那样相加是错的：雨一到 1 就顶住上限，
  // 雷暴再怎么强天色也不会更暗了 —— 而"雷暴比普通下雨更黑"正是
  // 雷暴唯一的视觉标志。
  if (rain <= 0 && thunder <= 0) return { r, g, b };
  const gray = r * 0.3 + g * 0.59 + b * 0.11;
  // 去饱和只看雨：雨天的天是灰的，而雷暴天是**更暗的**灰，不是更灰的灰
  const desat = 0.7 * rain;
  const dim = (1 - 0.45 * rain) * (1 - 0.35 * thunder);
  return {
    r: (r * (1 - desat) + gray * desat) * dim,
    g: (g * (1 - desat) + gray * desat) * dim,
    b: (b * (1 - desat) + gray * desat) * dim,
  };
}

/** 太阳在天空中的方位角（弧度），供后续画日月用 */
export function sunAngleRadians(timeOfDay: number): number {
  return celestialAngle(timeOfDay) * Math.PI * 2;
}

/**
 * 是不是白天。
 *
 * 判据用 `skyLightSubtracted` 而不是"时间在 0..12000 之间"：真正决定
 * 僵尸烧不烧、怪刷不刷的是**天光被扣掉多少**，而那条曲线在日出日落
 * 前后各有一段过渡。用时间硬切的话，怪会在日出那一刻整齐地烧起来，
 * 而 MC 里是天亮的过程中陆续烧。
 *
 * 天气也走这条路：下雨扣 5/16、雷暴再扣 5/16，两个都满时白天的天光
 * 只剩不到一半。于是**雷暴天的白天怪会刷、僵尸不烧** —— 这不是给天气
 * 单独加的特判，是同一条曲线自然给出的结果。
 */
export function isDaytime(timeOfDay: number, rain = 0, thunder = 0): boolean {
  return skyLightSubtracted(timeOfDay, rain, thunder) <= 3;
}
