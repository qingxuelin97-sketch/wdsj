/**
 * 天空的几何与颜色。
 *
 * 这里断言的东西在截图上几乎看不出对错 —— 星星多几颗少几颗、
 * 月相差一天，肉眼都发现不了。但它们一旦失去确定性，夜景截图的哈希
 * 就会莫名其妙地飘，而那时人会去怀疑渲染器。所以在这一层锁死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStarField, starBrightness, moonPhase, cloudOffset, fogRange,
  STAR_COUNT, MOON_PHASES,
} from '../../src/core/world/sky.ts';

test('星场：数量足额、全部在单位球面上、两次生成完全相同', () => {
  const a = buildStarField();
  const b = buildStarField();
  assert.equal(a.length, STAR_COUNT * 3);
  assert.deepEqual([...a], [...b], '星场必须确定性 —— 否则夜景截图每次都不同');

  for (let i = 0; i < STAR_COUNT; i++) {
    const x = a[i * 3]!, y = a[i * 3 + 1]!, z = a[i * 3 + 2]!;
    const len = Math.hypot(x, y, z);
    assert.ok(Math.abs(len - 1) < 1e-5, `第 ${i} 颗星不在单位球面上：|v|=${len}`);
  }
});

test('星场是球面均匀的，不是立方体均匀的', () => {
  // 拒绝采样那一步的意义：少了它，星星会在天球的八个角上明显变密。
  // 检验办法是比较"轴向附近"与"角落方向附近"的密度。
  const s = buildStarField();
  let axis = 0;
  let corner = 0;
  const cornerDir = 1 / Math.sqrt(3);
  for (let i = 0; i < STAR_COUNT; i++) {
    const x = s[i * 3]!, y = s[i * 3 + 1]!, z = s[i * 3 + 2]!;
    // 与 +Y 轴的夹角 < 20°
    if (y > Math.cos(20 * Math.PI / 180)) axis++;
    // 与 (1,1,1)/√3 的夹角 < 20°
    if (x * cornerDir + y * cornerDir + z * cornerDir > Math.cos(20 * Math.PI / 180)) corner++;
  }
  // 两个方向张的立体角一样，密度应当接近。放宽到 2 倍以内 —— 1500 颗样本有涨落
  assert.ok(axis > 0 && corner > 0, `两个方向都该有星星，实得 轴向${axis} 角落${corner}`);
  const ratio = Math.max(axis, corner) / Math.min(axis, corner);
  assert.ok(ratio < 2, `球面应当均匀，轴向${axis} 对 角落${corner}，比值 ${ratio.toFixed(2)}`);
});

test('星星亮度：正午为 0，午夜接近 1，黄昏晚于线性出现', () => {
  assert.equal(starBrightness(6000), 0, '正午不该看见星星');
  assert.ok(starBrightness(18000) > 0.9, `午夜该满亮，实得 ${starBrightness(18000)}`);

  // 平方曲线的意义：在"白昼程度"刚开始下降时，星星亮度要比线性更低
  const t = 12200;
  assert.ok(starBrightness(t) < 0.5, `黄昏刚过星星不该太亮，实得 ${starBrightness(t)}`);
  // 单调：从黄昏到午夜一路变亮
  for (let a = 13000; a < 18000; a += 500) {
    assert.ok(starBrightness(a + 500) >= starBrightness(a) - 1e-9, `${a} -> ${a + 500} 不该变暗`);
  }
});

test('下雨看不见星星', () => {
  assert.ok(starBrightness(18000, 0) > 0.9);
  assert.equal(starBrightness(18000, 1), 0);
});

test('月相按天走，不按当日时间走', () => {
  // 同一天之内相位不变
  assert.equal(moonPhase(0), moonPhase(23999));
  // 隔一天就换
  assert.notEqual(moonPhase(0), moonPhase(24000));
  // 8 天一轮回
  for (let d = 0; d < 20; d++) {
    assert.equal(moonPhase(d * 24000), d % MOON_PHASES);
  }
});

test('云的偏移只由 renderTick 决定，且会循环', () => {
  assert.equal(cloudOffset(0), 0);
  assert.ok(cloudOffset(100) > cloudOffset(50), '云要往前飘');
  // 12 格一循环
  assert.ok(Math.abs(cloudOffset(400) - cloudOffset(0)) < 1e-9, '400 刻应当正好绕回原点');
});

test('雾：水下与岩浆里都比地表近得多', () => {
  const [, airFar] = fogRange(8, 'none');
  const [, waterFar] = fogRange(8, 'water');
  const [, lavaFar] = fogRange(8, 'lava');
  assert.ok(waterFar < airFar, '水下的雾该更近');
  assert.ok(lavaFar < waterFar, '岩浆里该几乎看不见 —— 这是掉进岩浆之所以可怕的一半原因');
  assert.ok(lavaFar < 5, `岩浆能见度应当只有几格，实得 ${lavaFar}`);
});
