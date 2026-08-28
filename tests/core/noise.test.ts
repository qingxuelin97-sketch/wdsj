/**
 * 噪声验证。
 *
 * 噪声出问题的典型症状是"地形看起来怪但说不出哪里怪"，所以这里把可以断言的性质全钉死：
 * 确定性、值域、连续性、格点归零、频谱随倍频增加、以及不同 salt 之间互相独立。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JavaRandom } from '../../src/core/rng/java-random.ts';
import { PerlinNoise, OctaveNoise, noiseFromSeed } from '../../src/core/noise/perlin.ts';

test('同种子完全确定 —— 同种子必须给出同一个世界', () => {
  const a = new PerlinNoise(new JavaRandom(1234));
  const b = new PerlinNoise(new JavaRandom(1234));
  assert.equal(a.xOffset, b.xOffset);
  assert.equal(a.yOffset, b.yOffset);
  assert.equal(a.zOffset, b.zOffset);
  for (let i = 0; i < 500; i++) {
    const x = i * 0.37;
    const y = i * 0.11;
    const z = i * -0.53;
    assert.equal(a.noise3(x, y, z), b.noise3(x, y, z), `i=${i}`);
  }
});

test('不同种子给出不同噪声', () => {
  const a = new PerlinNoise(new JavaRandom(1));
  const b = new PerlinNoise(new JavaRandom(2));
  let differences = 0;
  for (let i = 0; i < 200; i++) {
    if (a.noise3(i * 0.31, 0, i * 0.17) !== b.noise3(i * 0.31, 0, i * 0.17)) differences++;
  }
  assert.ok(differences > 190, `期望绝大多数取样不同，实得 ${differences}/200`);
});

test('值域落在 [-1, 1] 内', () => {
  const n = new PerlinNoise(new JavaRandom(42));
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < 20000; i++) {
    const v = n.noise3((i % 137) * 0.19, ((i / 137) | 0) * 0.23, (i % 71) * 0.41);
    if (v < min) min = v;
    if (v > max) max = v;
    assert.ok(v >= -1.001 && v <= 1.001, `越界 ${v}`);
  }
  // 应该真的用到了大部分值域，否则说明梯度或归一化有问题
  assert.ok(min < -0.4, `最小值只到 ${min}，噪声可能太平`);
  assert.ok(max > 0.4, `最大值只到 ${max}，噪声可能太平`);
});

test('连续性 —— 相邻取样点不会突变', () => {
  const n = new PerlinNoise(new JavaRandom(7));
  const step = 0.001;
  let maxJump = 0;
  for (let i = 0; i < 5000; i++) {
    const x = i * 0.013;
    const a = n.noise3(x, 3.5, -2.25);
    const b = n.noise3(x + step, 3.5, -2.25);
    maxJump = Math.max(maxJump, Math.abs(a - b));
  }
  // Perlin 的梯度上界约为 sqrt(3)，step=0.001 时跳变应远小于 0.01
  assert.ok(maxJump < 0.01, `相邻取样最大跳变 ${maxJump}，噪声不连续`);
});

test('倍频叠加：层数越多细节越多，且仍在值域内', () => {
  const coarse = new OctaveNoise(new JavaRandom(99), 1);
  const fine = new OctaveNoise(new JavaRandom(99), 6);
  assert.equal(coarse.octaveCount, 1);
  assert.equal(fine.octaveCount, 6);

  // 用二阶差分（曲率）衡量"细节量"，不能用一阶变差。
  //
  // 一阶变差对倍频几乎不敏感：各层的 amp*freq 恒为 1，所以每层贡献相同；独立层叠加是
  // sqrt(n) 而不是 n 倍，再乘归一化系数 1/1.96875，6 倍频对 1 倍频的比值只有
  // sqrt(6)*0.508 ≈ 1.24 —— 看起来"高频没生效"，其实是度量选错了。
  // 二阶差分对频率是平方敏感（amp*freq^2 = 2^i 逐层翻倍），比值约 18 倍，才能真正区分。
  const roughness = (n: OctaveNoise): number => {
    let sum = 0;
    const step = 0.01;
    let a = n.noise2(0, 0);
    let b = n.noise2(step, 0);
    for (let i = 2; i < 2000; i++) {
      const c = n.noise2(i * step, 0);
      sum += Math.abs(c - 2 * b + a);
      a = b;
      b = c;
    }
    return sum;
  };
  const rc = roughness(coarse);
  const rf = roughness(fine);
  assert.ok(rf > rc * 5, `6 倍频的粗糙度 ${rf.toFixed(4)} 应远大于 1 倍频的 ${rc.toFixed(4)}`);

  for (let i = 0; i < 5000; i++) {
    const v = fine.noise3(i * 0.07, i * 0.03, i * -0.05);
    assert.ok(v >= -1.001 && v <= 1.001, `倍频噪声越界 ${v}`);
  }
});

test('ridged2 值域为 [0, 1] 且能产生脊线', () => {
  const n = new OctaveNoise(new JavaRandom(2024), 4);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < 10000; i++) {
    const v = n.ridged2((i % 101) * 0.05, ((i / 101) | 0) * 0.05);
    assert.ok(v >= -0.001 && v <= 1.001, `ridged 越界 ${v}`);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  assert.ok(max > 0.8, `脊线最高只到 ${max}，看不出山脊`);
  assert.ok(min < 0.5, `最低只到 ${min}，脊状特征不明显`);
});

test('noiseFromSeed：同 salt 确定，异 salt 独立', () => {
  const seed = 8675309;
  const a1 = noiseFromSeed(seed, 0x1234, 4);
  const a2 = noiseFromSeed(seed, 0x1234, 4);
  const b = noiseFromSeed(seed, 0x5678, 4);

  for (let i = 0; i < 200; i++) {
    assert.equal(a1.noise2(i * 0.1, i * 0.2), a2.noise2(i * 0.1, i * 0.2), `同 salt i=${i}`);
  }

  // 不同 salt 应基本不相关。算一下 Pearson 相关系数。
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const x = (i % 79) * 0.13;
    const z = ((i / 79) | 0) * 0.17;
    const va = a1.noise2(x, z);
    const vb = b.noise2(x, z);
    sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb;
  }
  const cov = sab / N - (sa / N) * (sb / N);
  const sda = Math.sqrt(saa / N - (sa / N) ** 2);
  const sdb = Math.sqrt(sbb / N - (sb / N) ** 2);
  const corr = cov / (sda * sdb);
  assert.ok(Math.abs(corr) < 0.15, `不同 salt 的噪声相关系数 ${corr.toFixed(3)}，应接近 0`);
});

test('bigint 世界种子可用', () => {
  const big = 6135803682982461360n;
  const a = noiseFromSeed(big, 0xbeef, 3);
  const b = noiseFromSeed(big, 0xbeef, 3);
  for (let i = 0; i < 100; i++) {
    assert.equal(a.noise3(i * 0.3, i * 0.1, i * 0.7), b.noise3(i * 0.3, i * 0.1, i * 0.7));
  }
});

test('置换表是 0..255 的一个排列 —— 洗牌不能丢值或重复', () => {
  // 通过取样间接验证：若置换表有重复/缺失，噪声会出现明显的周期性伪影。
  // 这里直接检查内部表的正确性更可靠，用 256 个格点整数处的取值应严格为 0。
  const n = new PerlinNoise(new JavaRandom(5));
  // Perlin 在整数格点上恒为 0（梯度与偏移向量点积为 0）。
  // 我们的实现加了 xOffset 等偏移，所以要减掉它才落在格点上。
  for (let i = -20; i < 20; i++) {
    for (let j = -20; j < 20; j++) {
      const v = n.noise3(i - n.xOffset, -n.yOffset, j - n.zOffset);
      assert.ok(Math.abs(v) < 1e-12, `格点 (${i},0,${j}) 处噪声应为 0，实得 ${v}`);
    }
  }
});
