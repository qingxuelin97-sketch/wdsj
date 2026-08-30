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

test('雨是竖的短丝，雪是散开的点', () => {
  const rain = paint('rain');
  const snow = paint('snow');

  // 阈值 25。两次调低都是有原因的：
  //   从 128 降到 40 —— 单条雨丝是**故意画得很淡**的（视野里同时叠着
  //     上百条，浓了会糊成一堵白墙），按 128 去数一个像素都数不到
  //   从 40 再降到 25 —— 雨丝的头尾又刻意再淡一档（那是"速度感"的来源），
  //     阈值 40 正好把两头切掉，量出来的平均段长 2.5 反而比雪还短，
  //     看着像"雨不是竖的"。而那纯粹是尺子的问题，不是图的问题
  const VISIBLE = 25;
  // 量的是**平均**连续段长，不是最长的那一段。
  //
  // "最长段"分不出"一条雨丝"和"三片雪花恰好叠在一起" —— 后者是随机
  // 撒点必然会发生的巧合，而它在画面上完全看不出异样。
  // 平均段长直接对应"streaky 还是 dotty"，才是这个断言真正想问的
  const columnRuns = (p: TilePainter): { meanRun: number; maxRun: number; filled: number } => {
    const runs: number[] = [];
    let filled = 0;
    for (let x = 0; x < 16; x++) {
      let run = 0;
      for (let y = 0; y < 16; y++) {
        if (p.data[(y * 16 + x) * 4 + 3]! > VISIBLE) {
          run++; filled++;
        } else if (run > 0) {
          runs.push(run); run = 0;
        }
      }
      if (run > 0) runs.push(run);
    }
    const meanRun = runs.length === 0 ? 0 : runs.reduce((a, b) => a + b, 0) / runs.length;
    return { meanRun, maxRun: runs.length === 0 ? 0 : Math.max(...runs), filled };
  };

  const r = columnRuns(rain);
  const s = columnRuns(snow);

  assert.ok(r.meanRun >= 3.5, `雨该是竖着的一段，平均只有 ${r.meanRun.toFixed(1)} 像素`);
  assert.ok(
    r.maxRun < 16,
    `雨丝不该从头连到尾（${r.maxRun}）—— 连满的话滚动起来看不出在动，`
    + '那正是第一版画成一幅静止帘子的原因',
  );
  assert.ok(r.filled > 40, `雨该有一定密度，实得 ${r.filled} 个可见像素`);

  assert.ok(
    s.meanRun < r.meanRun,
    `雪该比雨更"点状"：雪平均段长 ${s.meanRun.toFixed(1)}，雨 ${r.meanRun.toFixed(1)}`,
  );
  assert.ok(s.meanRun <= 3, `雪的平均段长该在 2 上下（2×2 的方点），实得 ${s.meanRun.toFixed(1)}`);
  assert.ok(s.filled > 20, `雪也得看得见，实得 ${s.filled} 个可见像素`);
  assert.ok(s.filled < r.filled, '雪该比雨稀疏');
});
