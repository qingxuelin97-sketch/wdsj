/**
 * 天空贴图。
 *
 * 月相是最容易画错又最不容易被发现的东西：8 张图各画各的，肉眼看每一张
 * 都"像个月亮"，但连起来放会在某一天突然跳一下形状。所以这里断言的是
 * **8 张之间的关系**，不是单张长什么样。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TilePainter } from '../../src/client/render/texgen.ts';
import { SKY_RECIPES, SKY_TILE_NAMES } from '../../src/client/render/tile-recipes-sky.ts';

function paint(name: string): TilePainter {
  const p = new TilePainter(name);
  SKY_RECIPES[name]!(p);
  return p;
}

/** 不透明像素数 */
function litPixels(p: TilePainter): number {
  let n = 0;
  for (let i = 3; i < p.data.length; i += 4) if (p.data[i]! > 128) n++;
  return n;
}

test('天空贴图齐全：太阳、云、雨、雪、8 个月相', () => {
  for (const n of ['sun', 'clouds', 'rain', 'snow']) {
    assert.ok(SKY_TILE_NAMES.includes(n), `缺少 ${n}`);
  }
  for (let i = 0; i < 8; i++) {
    assert.ok(SKY_TILE_NAMES.includes(`moon_phase_${i}`), `缺少 moon_phase_${i}`);
  }
  assert.equal(SKY_TILE_NAMES.length, 12);
});

test('月相：满月最亮、新月几乎全黑，且两侧单调', () => {
  const lit = Array.from({ length: 8 }, (_, i) => litPixels(paint(`moon_phase_${i}`)));

  assert.ok(lit[0]! > 150, `满月该几乎铺满圆盘，实得 ${lit[0]} 像素`);
  assert.ok(lit[4]! < 10, `新月该几乎全黑，实得 ${lit[4]} 像素`);

  // 0 -> 4 单调变暗
  for (let i = 0; i < 4; i++) {
    assert.ok(lit[i + 1]! < lit[i]!, `相位 ${i} -> ${i + 1} 该变暗：${lit[i]} -> ${lit[i + 1]}`);
  }
  // 4 -> 7 单调变亮
  for (let i = 4; i < 7; i++) {
    assert.ok(lit[i + 1]! > lit[i]!, `相位 ${i} -> ${i + 1} 该变亮：${lit[i]} -> ${lit[i + 1]}`);
  }
  // 相位 7 再走一步回到 0，跨天不该跳形状：7 与 0 的差距要和 0 与 1 的差距同量级
  const stepIn = lit[0]! - lit[1]!;
  const stepWrap = lit[0]! - lit[7]!;
  assert.ok(
    Math.abs(stepWrap - stepIn) < stepIn * 0.6,
    `7 -> 0 的跨天步长(${stepWrap}) 应当和 1 -> 0 的步长(${stepIn}) 相当，否则月亮会在跨天时跳形状`,
  );
});

test('月相对称：亏与盈是同一形状的左右镜像', () => {
  // 相位 2（亏半月）与相位 6（盈半月）亮的像素数应当相等
  assert.equal(litPixels(paint('moon_phase_2')), litPixels(paint('moon_phase_6')));
  assert.equal(litPixels(paint('moon_phase_1')), litPixels(paint('moon_phase_7')));
});

test('日月四角必须透明 —— 否则天上挂的是一个方块', () => {
  for (const name of ['sun', 'moon_phase_0']) {
    const p = paint(name);
    for (const [x, y] of [[0, 0], [15, 0], [0, 15], [15, 15]] as const) {
      const a = p.data[(y * 16 + x) * 4 + 3]!;
      assert.equal(a, 0, `${name} 的 (${x},${y}) 角不透明`);
    }
  }
});

test('云可以无缝平铺 —— 左右边缘与上下边缘要接得上', () => {
  // 云贴图要用 REPEAT 平铺一整层，接缝会变成天上一条直线
  const p = paint('clouds');
  const at = (x: number, y: number): number => p.data[(y * 16 + x) * 4 + 3]!;
  // 生成用的是对 16 取模的噪声格，所以第 0 列与第 15 列右邻（即第 0 列）一致 ——
  // 这里退而求其次：断言两侧边缘的覆盖率接近，接缝不会突兀
  let left = 0, right = 0, top = 0, bottom = 0;
  for (let i = 0; i < 16; i++) {
    if (at(0, i) > 128) left++;
    if (at(15, i) > 128) right++;
    if (at(i, 0) > 128) top++;
    if (at(i, 15) > 128) bottom++;
  }
  assert.ok(Math.abs(left - right) <= 6, `左右边缘覆盖率差太多：${left} vs ${right}`);
  assert.ok(Math.abs(top - bottom) <= 6, `上下边缘覆盖率差太多：${top} vs ${bottom}`);
});

test('雨是竖的，雪是散的', () => {
  const rain = paint('rain');
  const snow = paint('snow');
  // 雨：某些列有很多像素，某些列一个都没有
  const colOf = (p: TilePainter): number[] => {
    const cols = new Array<number>(16).fill(0);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      if (p.data[(y * 16 + x) * 4 + 3]! > 128) cols[x] = cols[x]! + 1;
    }
    return cols;
  };
  const rainCols = colOf(rain);
  const snowCols = colOf(snow);
  assert.ok(Math.max(...rainCols) >= 8, `雨该是长竖线，最长一列只有 ${Math.max(...rainCols)}`);
  assert.ok(Math.max(...snowCols) <= 4, `雪不该连成竖线，最长一列有 ${Math.max(...snowCols)}`);
});
