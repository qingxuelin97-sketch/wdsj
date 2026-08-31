/**
 * 维度换算与传送门几何。
 *
 * 这两样都是**纯**的，所以能在 node 里逐格断言 —— 而它们又都是
 * "看起来对但其实错了"的重灾区：门柱少一格、朝向判反、负坐标偏一格，
 * 全都要走进去才发现，而走进去这件事在自动化里很贵。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Dimension, DIMENSIONS, ALL_DIMENSIONS, convertCoords, dimensionOf, isDimension,
} from '../../src/core/world/dimension.ts';
import {
  findPortalShape, verifyPortal, buildPortalPlan,
  PORTAL_WIDTH, PORTAL_HEIGHT, type PortalProbe,
} from '../../src/core/world/portal.ts';

// --- 维度换算 ---

test('主世界 <-> 下界是 1:8', () => {
  assert.deepEqual(convertCoords(Dimension.OVERWORLD, Dimension.NETHER, 800, 1600), { x: 100, z: 200 });
  assert.deepEqual(convertCoords(Dimension.NETHER, Dimension.OVERWORLD, 100, 200), { x: 800, z: 1600 });
});

test('换算是可逆的（在 8 的整数倍上）', () => {
  for (const x of [0, 8, 64, 800, -8, -64, -4096]) {
    const n = convertCoords(Dimension.OVERWORLD, Dimension.NETHER, x, x);
    const back = convertCoords(Dimension.NETHER, Dimension.OVERWORLD, n.x, n.z);
    assert.equal(back.x, x, `${x} 来回换算不一致`);
  }
});

test('负坐标用 floor 而不是 round —— 用 round 会让世界的一半偏一格', () => {
  // −1 属于下界的 −1 号格（−1/8 = −0.125，floor 是 −1）。
  // round 会给 0，于是主世界西半边整体偏一格，而东半边不偏
  assert.deepEqual(convertCoords(Dimension.OVERWORLD, Dimension.NETHER, -1, -1), { x: -1, z: -1 });
  assert.deepEqual(convertCoords(Dimension.OVERWORLD, Dimension.NETHER, -8, -8), { x: -1, z: -1 });
  assert.deepEqual(convertCoords(Dimension.OVERWORLD, Dimension.NETHER, -9, -9), { x: -2, z: -2 });
});

test('末地不缩放，末地 <-> 下界走的是同一条公式', () => {
  assert.deepEqual(convertCoords(Dimension.OVERWORLD, Dimension.END, 800, -800), { x: 800, z: -800 });
  // 末地 -> 下界：先回主世界尺度（×1）再进下界（÷8）
  assert.deepEqual(convertCoords(Dimension.END, Dimension.NETHER, 800, -800), { x: 100, z: -100 });
  assert.deepEqual(convertCoords(Dimension.NETHER, Dimension.END, 100, -100), { x: 800, z: -800 });
});

test('维度表齐全且 id 与 MC 一致', () => {
  assert.equal(Dimension.NETHER, -1);
  assert.equal(Dimension.OVERWORLD, 0);
  assert.equal(Dimension.END, 1);
  assert.equal(ALL_DIMENSIONS.length, 3);
  for (const id of ALL_DIMENSIONS) {
    assert.equal(DIMENSIONS[id].id, id, '表的键与 def.id 必须一致');
    assert.ok(isDimension(id));
    assert.equal(dimensionOf(id).id, id);
  }
  assert.equal(isDimension(7), false);
  assert.throws(() => dimensionOf(7), /没有这个维度/);
});

test('只有主世界有天光，只有下界有天花板', () => {
  // 这三条布尔量决定了昼夜、天气、刷怪与地形生成的走向，
  // 设反一个的后果是"下界会下雨"这种一眼假
  assert.equal(DIMENSIONS[Dimension.OVERWORLD].hasSkyLight, true);
  assert.equal(DIMENSIONS[Dimension.NETHER].hasSkyLight, false);
  assert.equal(DIMENSIONS[Dimension.END].hasSkyLight, false);
  assert.equal(DIMENSIONS[Dimension.NETHER].hasCeiling, true);
  assert.equal(DIMENSIONS[Dimension.OVERWORLD].hasCeiling, false);
  assert.equal(DIMENSIONS[Dimension.END].hasCeiling, false);
});

// --- 传送门几何 ---

/** 一张手写的假地图：只记哪些格子是黑曜石 */
function fakeWorld(frame: Iterable<string>): PortalProbe {
  const set = new Set(frame);
  return {
    isFrame: (x, y, z) => set.has(`${x},${y},${z}`),
    isEmpty: (x, y, z) => !set.has(`${x},${y},${z}`),
  };
}

/** 造一座标准门的框（不含角），内部左下角在 x0,y0,z0 */
function frameCells(axis: 'x' | 'z', x0: number, y0: number, z0: number): string[] {
  return buildPortalPlan(axis, x0, y0, z0).frame.map((c) => `${c.x},${c.y},${c.z}`);
}

test('标准的 4x5 门能被认出来，内部正好 6 格', () => {
  const p = fakeWorld(frameCells('x', 10, 64, 20));
  // 打火石打在内部地面那一格
  const shape = findPortalShape(p, 10, 64, 20);
  assert.ok(shape !== null, '标准门没被认出来');
  assert.equal(shape.axis, 'x');
  assert.deepEqual({ x: shape.x, y: shape.y, z: shape.z }, { x: 10, y: 64, z: 20 });
  assert.equal(shape.cells.length, PORTAL_WIDTH * PORTAL_HEIGHT);
});

test('打在内部任意一格都能找到同一座门', () => {
  const p = fakeWorld(frameCells('x', 10, 64, 20));
  const base = findPortalShape(p, 10, 64, 20);
  assert.ok(base !== null);
  for (let w = 0; w < PORTAL_WIDTH; w++) {
    for (let h = 0; h < PORTAL_HEIGHT; h++) {
      const s = findPortalShape(p, 10 + w, 64 + h, 20);
      assert.ok(s !== null, `打在 (+${w},+${h}) 上认不出门`);
      assert.deepEqual({ x: s.x, y: s.y, z: s.z }, { x: base.x, y: base.y, z: base.z },
        `打在 (+${w},+${h}) 上找到的是另一座门`);
    }
  }
});

test('Z 轴朝向的门同样成立，且朝向不会判反', () => {
  const p = fakeWorld(frameCells('z', 10, 64, 20));
  const shape = findPortalShape(p, 10, 64, 20);
  assert.ok(shape !== null);
  assert.equal(shape.axis, 'z');
  // 内部六格必须沿 Z 排开，不是沿 X
  const xs = new Set(shape.cells.map((c) => c.x));
  const zs = new Set(shape.cells.map((c) => c.z));
  assert.equal(xs.size, 1, 'Z 朝向的门内部不该跨多个 X');
  assert.equal(zs.size, PORTAL_WIDTH);
});

test('缺一格框就不成门', () => {
  const full = frameCells('x', 10, 64, 20);
  for (let i = 0; i < full.length; i++) {
    const p = fakeWorld(full.filter((_, j) => j !== i));
    assert.equal(findPortalShape(p, 10, 64, 20), null, `少了 ${full[i]} 还认成门了`);
  }
});

test('角可以缺 —— 玩家造门时确实常常不放那四格', () => {
  const plan = buildPortalPlan('x', 10, 64, 20);
  // buildPortalPlan 本来就不含角，这里正面确认一下：加上角也照样成门
  const withCorners = [
    ...plan.frame.map((c) => `${c.x},${c.y},${c.z}`),
    '10,63,19', '11,63,19', '10,67,19', '11,67,19',
  ];
  assert.ok(findPortalShape(fakeWorld(withCorners), 10, 64, 20) !== null, '带角的门也该成立');
  assert.equal(plan.frame.length, 10, '不含角的框应是 10 格（两根柱各 3 + 底顶各 2）');
});

test('内部被塞住就不成门', () => {
  const p = fakeWorld([...frameCells('x', 10, 64, 20), '10,65,20']);
  assert.equal(findPortalShape(p, 10, 64, 20), null, '内部有方块还认成门了');
});

test('四面都是黑曜石的房间里点火不成门', () => {
  // 两个方向都有框 -> 朝向不确定 -> 不成门。
  // 没有这一条的话，在黑曜石掩体里点一把火会莫名其妙开出一道门
  const box: string[] = [];
  for (let x = 8; x <= 13; x++) {
    for (let y = 62; y <= 68; y++) {
      for (let z = 18; z <= 23; z++) {
        if (x === 8 || x === 13 || z === 18 || z === 23 || y === 62 || y === 68) box.push(`${x},${y},${z}`);
      }
    }
  }
  assert.equal(findPortalShape(fakeWorld(box), 10, 64, 20), null);
});

test('空地上点火不成门', () => {
  assert.equal(findPortalShape(fakeWorld([]), 10, 64, 20), null);
});

test('造门计划造出来的门，校验必须认得 —— 否则会长出黑曜石林', () => {
  // 造门与认门两份实现一旦漂移，玩家走回来时会被判成"这里没有门"，
  // 于是每来一次就造一座
  for (const axis of ['x', 'z'] as const) {
    const plan = buildPortalPlan(axis, -5, 64, -7);
    const p = fakeWorld(plan.frame.map((c) => `${c.x},${c.y},${c.z}`));
    const shape = verifyPortal(p, axis, -5, 64, -7);
    assert.ok(shape !== null, `${axis} 朝向：自己造的门自己认不出`);
    assert.equal(plan.interior.length, PORTAL_WIDTH * PORTAL_HEIGHT);
    // 内部与框不能重叠
    const frameKeys = new Set(plan.frame.map((c) => `${c.x},${c.y},${c.z}`));
    for (const c of plan.interior) {
      assert.ok(!frameKeys.has(`${c.x},${c.y},${c.z}`), '内部格子和框重叠了');
    }
    // 且点火也能认出来
    assert.ok(findPortalShape(p, -5, 64, -7) !== null, `${axis} 朝向：点火认不出自己造的门`);
  }
});

test('门高是 3、宽是 2 —— 1.0 不支持自定义尺寸', () => {
  assert.equal(PORTAL_WIDTH, 2);
  assert.equal(PORTAL_HEIGHT, 3);
  // 真的造一座 3 宽的门：柱子在 x=9 与 x=13，底顶横跨 x=10..12
  const wide: string[] = [];
  for (let h = 0; h < PORTAL_HEIGHT; h++) {
    wide.push(`9,${64 + h},20`, `13,${64 + h},20`);
  }
  for (let w = 10; w <= 12; w++) wide.push(`${w},63,20`, `${w},67,20`);
  const p = fakeWorld(wide);
  // 打在中间那一格：往左退一格得到 x0=10，但右柱在 x=13 而不是 x=12，
  // 于是 verifyPortal 通不过
  assert.equal(findPortalShape(p, 11, 64, 20), null, '3 宽的门在 1.0 里不该成立');
  assert.equal(findPortalShape(p, 12, 64, 20), null, '3 宽的门在 1.0 里不该成立');
});
