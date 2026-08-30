/**
 * 天气状态机。
 *
 * 天气是这个项目里**最难用眼睛验收**的系统：一段雨要下十几分钟，
 * 晴天平均一个多小时。真跑起来看，一个下午也就见到两三次转换，
 * 而"时长分布对不对"这种事根本看不出来。所以全靠这里跑几十万刻去量。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Weather } from '../../src/core/world/weather.ts';
import { JavaRandom } from '../../src/core/rng/java-random.ts';

/** 跑 n 刻，返回每一段天气的时长 */
function runSegments(n: number, seed = 1234n): { rain: number[]; thunder: number[] } {
  const w = new Weather();
  const rng = new JavaRandom(seed);
  const rain: number[] = [];
  const thunder: number[] = [];
  let rainSince = 0;
  let thunderSince = 0;
  let wasRain = w.raining;
  let wasThunder = w.thundering;
  for (let i = 0; i < n; i++) {
    w.tick(rng);
    if (w.raining !== wasRain) {
      rain.push(i - rainSince);
      rainSince = i;
      wasRain = w.raining;
    }
    if (w.thundering !== wasThunder) {
      thunder.push(i - thunderSince);
      thunderSince = i;
      wasThunder = w.thundering;
    }
  }
  return { rain, thunder };
}

test('天气会自己变 —— 跑够久必然下雨也必然停', () => {
  const w = new Weather();
  const rng = new JavaRandom(99n);
  let sawRain = false;
  let sawClear = false;
  for (let i = 0; i < 400000; i++) {
    w.tick(rng);
    if (w.raining) sawRain = true; else if (sawRain) sawClear = true;
  }
  assert.ok(sawRain, '40 万刻(约 5.5 小时游戏时间)里应该下过雨');
  assert.ok(sawClear, '下过之后应该停');
});

test('雨段时长落在 MC 的 10–20 分钟里', () => {
  const { rain } = runSegments(2000000);
  // 第一段是从"世界刚开始、计时器为 0"起算的，不能代表分布
  const segments = rain.slice(1);
  assert.ok(segments.length >= 6, `样本太少：只有 ${segments.length} 段`);

  // 雨段与晴段交替。判定哪些是雨段：偶数/奇数取决于起始状态，
  // 这里直接按长度分 —— 雨段 12000..24000，晴段 12000..180000，
  // 有重叠，所以改用"短的那一半必然全是雨段"的弱断言
  const short = segments.filter((t) => t <= 24000);
  assert.ok(short.length > 0, '应该有落在雨段范围里的');
  for (const t of short) {
    assert.ok(t >= 12000, `雨段不该短于 12000 刻，实得 ${t}`);
  }
  for (const t of segments) {
    assert.ok(t <= 180001, `没有哪一段该超过 180000 刻，实得 ${t}`);
  }
});

test('雷暴段比雨段短 —— 3 分钟起步而不是 10 分钟', () => {
  const { thunder } = runSegments(2000000);
  const segments = thunder.slice(1);
  assert.ok(segments.length >= 6, `样本太少：只有 ${segments.length} 段`);
  const shortest = Math.min(...segments);
  assert.ok(shortest >= 3600, `最短的一段不该短于 3600 刻，实得 ${shortest}`);
  assert.ok(
    shortest < 12000,
    `雷暴该能出现短段（3600..15600），实得最短 ${shortest} —— 说明用错了雨的常数`,
  );
});

test('强度是 100 刻淡入淡出，不是瞬间切换', () => {
  const w = new Weather();
  const rng = new JavaRandom(7n);
  w.set(true, false);
  assert.equal(w.rainStrength, 0, '刚开始下雨时强度还是 0');

  for (let i = 0; i < 50; i++) w.tick(rng);
  assert.ok(w.rainStrength > 0.4 && w.rainStrength < 0.6, `50 刻后应在半途，实得 ${w.rainStrength}`);

  for (let i = 0; i < 60; i++) w.tick(rng);
  assert.equal(w.rainStrength, 1, '110 刻后应当到顶');

  // 转晴同样要淡出
  w.set(false, false);
  for (let i = 0; i < 50; i++) w.tick(rng);
  assert.ok(w.rainStrength > 0.4 && w.rainStrength < 0.6, `淡出也该是渐变，实得 ${w.rainStrength}`);
});

test('雷暴的表现强度不会超过雨强度', () => {
  // 状态上雷和雨是独立的两条计时器，"晴天打雷"在状态上完全可能。
  // 但表现（天色压暗、劈闪电）必须跟着雨走，否则会出现万里无云突然天黑
  const w = new Weather();
  w.set(false, true);
  w.snapStrength();
  assert.equal(w.thunderStrength, 1, '内部状态上雷暴强度是满的');
  assert.equal(w.snapshot().thunderStrength, 0, '但对外表现必须是 0 —— 没下雨');

  w.set(true, true);
  w.snapStrength();
  assert.equal(w.snapshot().thunderStrength, 1);
});

test('同一个种子给出同一串天气 —— 存读之后不能分叉', () => {
  const run = (): string => {
    const w = new Weather();
    const rng = new JavaRandom(555n);
    const marks: string[] = [];
    for (let i = 0; i < 200000; i++) {
      w.tick(rng);
      if (i % 10000 === 0) marks.push(`${w.raining ? 'R' : '-'}${w.thundering ? 'T' : '-'}`);
    }
    return marks.join('');
  };
  assert.equal(run(), run());
});

test('snapStrength 立刻到位 —— 截图回归等不起 5 秒淡入', () => {
  const w = new Weather();
  w.set(true, true);
  w.snapStrength();
  assert.equal(w.rainStrength, 1);
  assert.equal(w.snapshot().thunderStrength, 1);
});
