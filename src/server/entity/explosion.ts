/**
 * 爆炸。
 *
 * 苦力怕（威力 3）与 TNT（威力 4，M11）共用这一套。算法照抄 MC 的
 * `Explosion.doExplosionA`，因为爆坑的**形状**是玩家极其熟悉的东西 ——
 * 随便写个球形削除法，坑会太圆太规整，一眼就假。
 *
 * MC 的做法是从爆心往 16×16×16 个方向各打一条射线：
 *   1. 射线强度 = 威力 × (0.7 + random×0.6)
 *   2. 每前进 0.3 格，扣掉该处方块的爆炸抗性带来的衰减
 *   3. 强度还是正的就把那一格记进"要炸掉"的集合
 *
 * 于是抗性高的方块（黑曜石 6000）挡得住，泥土沙子挡不住，
 * 坑的边缘参差不齐 —— 这三件事一起构成了"MC 的爆坑"。
 *
 * 与 MC 的偏差（记进 docs/DEVIATIONS.md）：不做"方块掉落率 1/威力"，
 * 改成固定按方块自己的掉落表掉一半 —— 1.0 的那条概率规则要额外一份
 * 随机流，而我们的随机源要保持确定以支撑截图回归。
 */
import type { ServerCore } from '../server-core.ts';
import { AIR_STATE, stateId } from '../../core/world/chunk.ts';
import { WORLD_HEIGHT } from '../../core/constants.ts';

/** 射线格子边长，与 MC 一致 */
const RAY_GRID = 16;
/** 每一步走多远 */
const STEP = 0.3;

export interface ExplosionResult {
  /** 被炸掉的方块坐标 */
  destroyed: { x: number; y: number; z: number; state: number }[];
  /** 受到伤害的玩家 id 与伤害值 */
  hurtPlayers: { entityId: number; damage: number }[];
  /** 受到伤害的生物 id */
  hurtMobs: number[];
}

/**
 * 炸一下。
 *
 * @param power 威力。苦力怕 3，TNT 4
 * @param sourceId 引爆者的实体 id，−1 表示没有（它自己不该被自己炸）
 */
export function explode(
  core: ServerCore,
  cx: number, cy: number, cz: number,
  power: number,
  sourceId = -1,
): ExplosionResult {
  const world = core.world;
  const rng = world.random;
  const affected = new Set<number>();
  const result: ExplosionResult = { destroyed: [], hurtPlayers: [], hurtMobs: [] };
  // 集合的键用**相对爆心的偏移**而不是世界坐标：射线最远走 power×~5 格，
  // 偏移必定落在 ±32 里，压成一个小整数不会溢出。
  // 直接打包世界坐标的话，z 只留 8 位就会在 z=1000 这种地方绕回来，
  // 拆的是别处的方块 —— 而那种错误只在远离原点时出现
  const ocx = Math.floor(cx);
  const ocy = Math.floor(cy);
  const ocz = Math.floor(cz);

  // --- 1. 射线削除 ---
  for (let gx = 0; gx < RAY_GRID; gx++) {
    for (let gy = 0; gy < RAY_GRID; gy++) {
      for (let gz = 0; gz < RAY_GRID; gz++) {
        // 只打**表面**上的方向。内部的格子会被表面的射线覆盖，
        // 全打一遍是 4096 条射线里有 3000 多条白跑
        const onSurface = gx === 0 || gx === RAY_GRID - 1
          || gy === 0 || gy === RAY_GRID - 1
          || gz === 0 || gz === RAY_GRID - 1;
        if (!onSurface) continue;

        let dx = gx / (RAY_GRID - 1) * 2 - 1;
        let dy = gy / (RAY_GRID - 1) * 2 - 1;
        let dz = gz / (RAY_GRID - 1) * 2 - 1;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-9) continue;
        dx /= len;
        dy /= len;
        dz /= len;

        // 强度带随机：爆坑边缘的参差就来自这里
        let strength = power * (0.7 + rng.nextDouble() * 0.6);
        let x = cx;
        let y = cy;
        let z = cz;
        while (strength > 0) {
          const bx = Math.floor(x);
          const by = Math.floor(y);
          const bz = Math.floor(z);
          if (by < 0 || by >= WORLD_HEIGHT) break;
          const state = world.getBlock(bx, by, bz);
          const id = stateId(state);
          if (id !== 0) {
            const resistance = world.tables.blastResistance[id] ?? 0;
            // 基岩这类抗性拉满的直接吃掉整条射线
            strength -= (resistance / 5 + 0.3) * STEP;
            if (strength > 0) affected.add(offsetKey(bx - ocx, by - ocy, bz - ocz));
          }
          x += dx * STEP;
          y += dy * STEP;
          z += dz * STEP;
          strength -= STEP * 0.225;
        }
      }
    }
  }

  // --- 2. 拆方块 ---
  for (const k of affected) {
    if (k < 0) continue;
    const bx = ocx + keyDx(k);
    const by = ocy + keyDy(k);
    const bz = ocz + keyDz(k);
    const state = world.getBlock(bx, by, bz);
    const id = stateId(state);
    if (id === 0) continue;
    // 不可破坏的（基岩）留着
    if ((world.tables.hardness[id] ?? 0) < 0) continue;
    result.destroyed.push({ x: bx, y: by, z: bz, state });
    world.setBlock(bx, by, bz, AIR_STATE);
  }

  // --- 3. 伤害 ---
  // MC 的公式：按到爆心的距离归一化，再乘一个视线遮挡系数。
  // 这里省掉遮挡系数（那要给每个实体再打一批射线），改用纯距离衰减，
  // 于是"躲在方块后面"挡不住爆炸 —— 记在 DEVIATIONS 里
  const radius = power * 2;
  for (const p of core.playersForTest()) {
    const d = Math.hypot(p.x - cx, p.y + 0.9 - cy, p.z - cz);
    if (d > radius) continue;
    const factor = 1 - d / radius;
    const damage = Math.floor((factor * factor + factor) / 2 * 8 * power + 1);
    if (damage > 0) result.hurtPlayers.push({ entityId: p.entityId, damage });
  }
  for (const mob of core.mobs.mobs.values()) {
    if (mob.entityId === sourceId) continue;
    const d = Math.hypot(mob.x - cx, mob.y + mob.def.height / 2 - cy, mob.z - cz);
    if (d > radius) continue;
    const factor = 1 - d / radius;
    const damage = Math.floor((factor * factor + factor) / 2 * 8 * power + 1);
    if (damage > 0 && mob.hurt(damage)) result.hurtMobs.push(mob.entityId);
  }

  return result;
}

/**
 * 把相对爆心的偏移打包成一个整数。
 *
 * 每轴取 ±32（用 64 个格位，加 32 变成 0..63），三轴共 18 位。
 * 超出范围的返回 −1，调用方会把它当成一个普通的集合元素 ——
 * 反正射线走不了那么远，真走到了也只是少拆一格。
 */
const RANGE = 32;
const SPAN = RANGE * 2;

function offsetKey(dx: number, dy: number, dz: number): number {
  if (dx < -RANGE || dx >= RANGE || dy < -RANGE || dy >= RANGE || dz < -RANGE || dz >= RANGE) return -1;
  return ((dx + RANGE) * SPAN + (dy + RANGE)) * SPAN + (dz + RANGE);
}
function keyDx(k: number): number {
  return Math.floor(k / (SPAN * SPAN)) - RANGE;
}
function keyDy(k: number): number {
  return Math.floor(k / SPAN) % SPAN - RANGE;
}
function keyDz(k: number): number {
  return k % SPAN - RANGE;
}
