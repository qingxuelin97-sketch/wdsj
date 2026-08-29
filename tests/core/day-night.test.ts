/**
 * 昼夜循环的黄金值。
 *
 * 这些数不是"看着差不多"选的，是 MC 1.0 原式算出来的。锁死它们的理由：
 * `skyLightSubtracted` 直接决定夜里露天的光照等级，而怪物生成的判据是光照 ≤ 7。
 * 这个数偏一点，夜晚要么怪满地跑、要么一只不刷，而且极难从表象反推回来。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  celestialAngle, skyLightSubtracted, sunBrightness, lightBrightness, skyColor,
} from '../../src/core/world/day-night.ts';
import { MAX_LIGHT } from '../../src/core/constants.ts';

test('天体角度：0 tick 在 0.78 附近，正午回到 0.03 附近', () => {
  // MC 把 0 tick 定为日出，所以角度要平移 1/4 天
  assert.ok(Math.abs(celestialAngle(0) - 0.7845) < 1e-3, `实得 ${celestialAngle(0)}`);
  assert.ok(Math.abs(celestialAngle(6000) - 0.0) < 1e-3, `实得 ${celestialAngle(6000)}`);
  assert.ok(Math.abs(celestialAngle(12000) - 0.2155) < 1e-3, `实得 ${celestialAngle(12000)}`);
  assert.ok(Math.abs(celestialAngle(18000) - 0.5) < 1e-3, `实得 ${celestialAngle(18000)}`);
  // 一整天单调递增（跨过 1 之后回绕）
  for (let t = 0; t < 24000; t += 500) {
    const a = celestialAngle(t);
    assert.ok(a >= 0 && a <= 1, `t=${t} 角度越界 ${a}`);
  }
});

test('天光扣减：白天 0，午夜 11 —— 夜里露天正好是 4 级', () => {
  assert.equal(skyLightSubtracted(0), 0, '清晨');
  assert.equal(skyLightSubtracted(6000), 0, '正午');
  assert.equal(skyLightSubtracted(12000), 0, '日落瞬间还是亮的');
  assert.equal(skyLightSubtracted(18000), 11, '午夜');
  assert.equal(skyLightSubtracted(22000), 11, '黎明前');

  // 这一条是整个夜晚玩法的支点：露天 15-11 = 4 ≤ 7，所以地面会刷怪
  assert.equal(MAX_LIGHT - skyLightSubtracted(18000), 4, '午夜露天光照等级');
  assert.ok(MAX_LIGHT - skyLightSubtracted(18000) <= 7, '午夜露天必须能刷怪');
  assert.ok(MAX_LIGHT - skyLightSubtracted(6000) > 7, '正午露天必须不能刷怪');
});

test('太阳亮度在 0.2..1.0 之间', () => {
  assert.ok(Math.abs(sunBrightness(6000) - 1.0) < 1e-4);
  assert.ok(Math.abs(sunBrightness(18000) - 0.2) < 1e-4);
  for (let t = 0; t < 24000; t += 250) {
    const b = sunBrightness(t);
    assert.ok(b >= 0.2 - 1e-6 && b <= 1 + 1e-6, `t=${t} 亮度越界 ${b}`);
  }
});

test('光照亮度曲线是 MC 的非线性曲线，不是 level/15', () => {
  assert.equal(lightBrightness(0), 0);
  assert.equal(lightBrightness(15), 1);
  // 关键：7 级只有 0.18，远低于线性的 0.47。
  // 这是"一支火把只照亮很小一圈"和"光照 13 到 15 差别很大"的来源。
  assert.ok(Math.abs(lightBrightness(7) - 0.1795) < 1e-3, `实得 ${lightBrightness(7)}`);
  assert.ok(lightBrightness(7) < 7 / 15 - 0.2, '必须明显低于线性');
  assert.ok(Math.abs(lightBrightness(14) - 0.7778) < 1e-3, `实得 ${lightBrightness(14)}`);
  // 单调递增
  for (let l = 1; l <= 15; l++) {
    assert.ok(lightBrightness(l) > lightBrightness(l - 1), `${l} 不比 ${l - 1} 亮`);
  }
});

test('天空色：正午偏亮蓝，午夜偏暗蓝，且始终蓝分量最高', () => {
  const noon = skyColor(6000);
  const night = skyColor(18000);
  assert.ok(noon.b > noon.r && noon.b > noon.g, '正午天空应偏蓝');
  assert.ok(night.b > night.r && night.b > night.g, '午夜天空应偏蓝');
  assert.ok(noon.r + noon.g + noon.b > (night.r + night.g + night.b) * 2, '正午应明显亮于午夜');
  for (let t = 0; t < 24000; t += 250) {
    const c = skyColor(t);
    for (const v of [c.r, c.g, c.b]) assert.ok(v >= 0 && v <= 1, `t=${t} 颜色越界 ${v}`);
  }
});
