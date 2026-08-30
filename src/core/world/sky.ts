/**
 * 天空的**几何与颜色**，纯函数。
 *
 * 和 day-night.ts 分开：那边是"光照被扣掉多少"（影响刷怪、僵尸日灼，
 * 是**玩法**），这边是"天上看起来是什么样"（日月方位、星星位置、
 * 云的偏移，是**画面**）。两者共用 celestialAngle，但改动的理由完全不同 ——
 * 调星星亮度不该有任何机会碰到刷怪判据。
 *
 * 放在 core 而不是 client/render，是为了让星场和月相能在 node 里断言。
 * 星场是 1500 个坐标，画错了在截图上只是"星星位置不太对"，
 * 肉眼几乎看不出来，但确定性一旦破掉，截图回归就会莫名其妙地飘。
 */
import { JavaRandom } from '../rng/java-random.ts';
import { celestialAngle } from './day-night.ts';

/** 星星数量。MC 1.0 也是 1500 */
export const STAR_COUNT = 1500;

/** 月相数量。满月 -> 新月 -> 满月，8 个阶段 */
export const MOON_PHASES = 8;

/**
 * 生成星场。
 *
 * 每颗星是天球上的一个小四边形。MC 的做法是在单位立方体里取随机点、
 * 丢掉长度不在 (0, 1] 内的（保证球面均匀而不是立方体均匀），
 * 再推到半径 100 的球面上。这里照抄，包括那个固定种子 10842 ——
 * 星空必须每次一模一样，否则同一个种子的夜景截图每次都不同。
 *
 * @returns 长度 STAR_COUNT*3 的坐标数组（单位球面上）
 */
export function buildStarField(): Float32Array {
  const rng = new JavaRandom(10842n);
  const out = new Float32Array(STAR_COUNT * 3);
  let written = 0;
  // 拒绝采样可能连续失败，给一个上限防止死循环 —— 实测 1500 颗大约要 2900 次
  for (let guard = 0; written < STAR_COUNT && guard < STAR_COUNT * 100; guard++) {
    const x = rng.nextFloat() * 2 - 1;
    const y = rng.nextFloat() * 2 - 1;
    const z = rng.nextFloat() * 2 - 1;
    const d = x * x + y * y + z * z;
    // 落在球外的丢掉。少了这一步，星星会在天球的八个角上明显变密
    if (d <= 0 || d >= 1) continue;
    const inv = 1 / Math.sqrt(d);
    out[written * 3] = x * inv;
    out[written * 3 + 1] = y * inv;
    out[written * 3 + 2] = z * inv;
    written++;
  }
  return out;
}

/**
 * 星星亮度，0（白天完全看不见）..1（午夜）。
 *
 * MC 的原式：以"白昼程度"为基础，取 1-day 后平方。平方让星星在黄昏时
 * **晚一点**才出现、在黎明时**早一点**消失 —— 线性的话星星会在天还很亮的
 * 时候就浮出来，看着像穿帮。
 */
export function starBrightness(timeOfDay: number, rain = 0): number {
  const angle = celestialAngle(timeOfDay);
  const day = Math.min(1, Math.max(0, Math.cos(angle * Math.PI * 2) * 2 + 0.5));
  const f = (1 - day) * (1 - day);
  // 下雨看不见星星
  return f * (1 - rain);
}

/**
 * 当前月相，0..7。0 = 满月。
 *
 * MC 按**天数**取模：`(worldAge / 24000) % 8`。用 worldAge 而不是 timeOfDay，
 * 因为 timeOfDay 每天归零，取模出来永远是同一个相位。
 */
export function moonPhase(worldAge: number): number {
  const day = Math.floor(worldAge / 24000);
  return ((day % MOON_PHASES) + MOON_PHASES) % MOON_PHASES;
}

/**
 * 云层的水平偏移（格）。
 *
 * 由 renderTick 驱动，不读挂钟（规约第 4 条）——  freeze() 之后云要停住，
 * 否则截图回归每次都差一点点。
 *
 * MC 的云速约 0.03 格/刻，飘一整圈（云贴图 12 格一循环）要 400 刻。
 */
export function cloudOffset(renderTick: number): number {
  return (renderTick * 0.03) % 12;
}

/**
 * 雾的浓度系数。水下与下界要比地表浓得多。
 *
 * 返回 [近, 远]，单位是格。渲染距离由调用方乘进去。
 */
export function fogRange(renderDistance: number, submerged: 'none' | 'water' | 'lava'): [number, number] {
  const far = renderDistance * 16;
  if (submerged === 'water') return [0.5, 24];
  // 岩浆里几乎什么都看不见 —— 这是"掉进岩浆"之所以可怕的一半原因
  if (submerged === 'lava') return [0.1, 2.5];
  return [far * 0.65, far * 1.05];
}
