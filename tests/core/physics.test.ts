/**
 * 玩家物理的黄金轨迹。
 *
 * 这些数值是 MC「手感」的全部来源。差一点点，玩起来立刻是假的 ——
 * 跳不上一格、疾跑跳跨不过沟、从高处落下的时机对不上。
 * 而且这类偏差**不会报错**，只会让人说不出哪里怪，所以必须逐个钉死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChunkStore } from '../../src/core/world/block-view.ts';
import { packState, AIR_STATE } from '../../src/core/world/chunk.ts';
import { createBlockRegistry, Blocks } from '../../src/content/blocks.ts';
import {
  makeBody, emptyInput, stepBody, type Body, type MoveInput, type PhysicsTables,
} from '../../src/core/physics/entity-physics.ts';
import { TPS, JUMP_VELOCITY, GRAVITY, DRAG_VERTICAL } from '../../src/core/constants.ts';

const registry = createBlockRegistry();
const TABLES = registry.getTables() as unknown as PhysicsTables;
const STONE = packState(registry.idOf(Blocks.STONE));
const ICE = packState(registry.idOf(Blocks.ICE));

/** 一片地面：方块填到 y=63，站立面在 y=64 */
function flatWorld(surfaceState = STONE): ChunkStore {
  const store = new ChunkStore();
  for (let cz = -2; cz <= 2; cz++) for (let cx = -2; cx <= 2; cx++) store.createChunk(cx, cz);
  for (let z = -32; z < 32; z++) {
    for (let x = -32; x < 32; x++) {
      for (let y = 60; y <= 63; y++) store.setState(x, y, z, surfaceState);
    }
  }
  return store;
}

function run(world: ChunkStore, body: Body, input: MoveInput, ticks: number): void {
  for (let i = 0; i < ticks; i++) stepBody(world, TABLES, body, input);
}

test('自由落体：积分顺序是"先移动再加重力"，终端速度 78.4 格/秒', () => {
  const world = flatWorld();
  const body = makeBody(0.5, 100, 0.5);

  // MC 的顺序：先按**当前**速度移动，再 vy = (vy - 0.08) * 0.98。
  // 于是走下悬崖的第一个 tick 是不掉的（速度还是 0），第二个 tick 才落 0.0784。
  // 顺序反过来的话第一 tick 就掉 0.0784 —— 跳跃高度会随之变成 1.29 而不是 1.2522，
  // 所以这条和下面的跳跃高度是互相印证的。
  let vy = 0;
  let y = 100;
  const golden: number[] = [];
  for (let i = 0; i < 10; i++) {
    y += vy;
    vy = (vy - GRAVITY) * DRAG_VERTICAL;
    golden.push(y);
  }
  for (let i = 0; i < 10; i++) {
    stepBody(world, TABLES, body, emptyInput());
    assert.ok(
      Math.abs(body.y - golden[i]!) < 1e-9,
      `第 ${i + 1} tick：期望 y=${golden[i]}，实得 ${body.y}`,
    );
  }
  assert.equal(golden[0], 100, '第一 tick 不下落');
  assert.ok(Math.abs(golden[1]! - (100 - 0.0784)) < 1e-9, `第二 tick 应落 0.0784，实得 ${100 - golden[1]!}`);

  // 终端速度 = 0.08 × 0.98 / (1 − 0.98) = 3.92 格/tick = 78.4 格/秒，MC 的原值
  let v = 0;
  for (let i = 0; i < 2000; i++) v = (v - GRAVITY) * DRAG_VERTICAL;
  assert.ok(Math.abs(v * TPS + 78.4) < 1e-3, `终端速度应为 −78.4 格/秒，实得 ${(v * TPS).toFixed(4)}`);
});

test('跳跃高度约 1.25 格 —— 刚好上得去一格', () => {
  const world = flatWorld();
  const body = makeBody(0.5, 64, 0.5);
  body.onGround = true;
  let peak = body.y;
  for (let i = 0; i < 30; i++) {
    stepBody(world, TABLES, body, i === 0 ? { ...emptyInput(), jump: true } : emptyInput());
    peak = Math.max(peak, body.y);
  }
  const height = peak - 64;
  // 1.2522 是 MC 的精确值，不是"大约 1.25"。它同时锁死了 0.42 的初速度、
  // 0.08 的重力和 0.98 的阻尼，以及三者的运算顺序。
  assert.ok(Math.abs(height - 1.2522) < 1e-3, `跳跃高度 ${height.toFixed(4)}，MC 是 1.2522`);
  assert.ok(Math.abs(body.y - 64) < 1e-6, `应落回 y=64，实得 ${body.y}`);
  assert.equal(body.onGround, true);
  assert.equal(JUMP_VELOCITY, 0.42);
});

test('行走速度约 4.3 格/秒，方向与 yaw 一致', () => {
  const world = flatWorld();
  const body = makeBody(0.5, 64, 0.5, 0); // yaw 0 -> 朝 +Z
  body.onGround = true;
  const input = { ...emptyInput(), forward: 1 };
  run(world, body, input, TPS * 3);
  const startZ = body.z;
  run(world, body, input, TPS);
  const speed = body.z - startZ;
  // MC 的实测值 4.317。少了 onLivingUpdate 里那个 0.98 的输入衰减就会变成 4.405 ——
  // 行走/疾跑/潜行会同时高出 2.05%，是"漏了一处公共乘数"的指纹。
  assert.ok(Math.abs(speed - 4.317) < 0.01, `行走速度 ${speed.toFixed(4)} 格/秒，MC 是 4.317`);
  assert.ok(Math.abs(body.x - 0.5) < 1e-9, `yaw=0 时不该有 x 位移，实得 ${body.x}`);
});

test('疾跑比行走快约三成', () => {
  const world = flatWorld();
  const walk = makeBody(0.5, 64, 0.5);
  walk.onGround = true;
  const sprint = makeBody(0.5, 64, 0.5);
  sprint.onGround = true;
  run(world, walk, { ...emptyInput(), forward: 1 }, TPS * 4);
  run(world, sprint, { ...emptyInput(), forward: 1, sprint: true }, TPS * 4);
  const ratio = (sprint.z - 0.5) / (walk.z - 0.5);
  assert.ok(ratio > 1.25 && ratio < 1.35, `疾跑/行走 = ${ratio.toFixed(3)}，应在 1.3 附近`);
  // 稳态速度对 MC 的 5.612
  const before = sprint.z;
  run(world, sprint, { ...emptyInput(), forward: 1, sprint: true }, TPS);
  assert.ok(Math.abs(sprint.z - before - 5.612) < 0.01,
    `疾跑速度 ${(sprint.z - before).toFixed(4)} 格/秒，MC 是 5.612`);
});

test('潜行把速度压到三成', () => {
  const world = flatWorld();
  const walk = makeBody(0.5, 64, 0.5);
  walk.onGround = true;
  const sneak = makeBody(0.5, 64, 0.5);
  sneak.onGround = true;
  run(world, walk, { ...emptyInput(), forward: 1 }, TPS * 4);
  run(world, sneak, { ...emptyInput(), forward: 1, sneak: true }, TPS * 4);
  const ratio = (sneak.z - 0.5) / (walk.z - 0.5);
  assert.ok(ratio > 0.25 && ratio < 0.35, `潜行/行走 = ${ratio.toFixed(3)}，应在 0.3 附近`);
  const before = sneak.z;
  run(world, sneak, { ...emptyInput(), forward: 1, sneak: true }, TPS);
  assert.ok(Math.abs(sneak.z - before - 1.295) < 0.01,
    `潜行速度 ${(sneak.z - before).toFixed(4)} 格/秒，MC 是 1.295`);
});

test('斜着走只快 2%，不是快 41% —— moveFlying 的归一化规则', () => {
  const world = flatWorld();
  const straight = makeBody(0.5, 64, 0.5);
  straight.onGround = true;
  const diagonal = makeBody(0.5, 64, 0.5);
  diagonal.onGround = true;
  run(world, straight, { ...emptyInput(), forward: 1 }, TPS * 4);
  run(world, diagonal, { ...emptyInput(), forward: 1, strafe: 1 }, TPS * 4);
  const dStraight = Math.hypot(straight.x - 0.5, straight.z - 0.5);
  const dDiagonal = Math.hypot(diagonal.x - 0.5, diagonal.z - 0.5);
  const ratio = dDiagonal / dStraight;

  // 没有归一化的话斜走会快 √2（41%），那是老式 FPS 的"斜跳加速"。
  // MC 归一化了，所以不会。
  assert.ok(ratio < 1.1, `斜走快了 ${((ratio - 1) * 100).toFixed(1)}%，不该有 √2 那种加速`);

  // 但也**不是**严格相等，而是恰好快 1/0.98 = 2.04%：
  // 直走时输入长度 0.98 < 1，moveFlying 的 `if (len < 1) len = 1` 让它不被放大回去；
  // 斜走时两轴各 0.98、长度 1.386 > 1，归一化后拿到满额加速度。
  // 这个 2% 是 0.98 输入衰减与归一化规则相互作用的产物，MC 里确实存在。
  assert.ok(Math.abs(ratio - 1 / 0.98) < 0.005,
    `斜/直 = ${ratio.toFixed(4)}，应为 1/0.98 = ${(1 / 0.98).toFixed(4)}`);
});

test('撞墙会停下，且不会把速度攒起来', () => {
  const world = flatWorld();
  for (let y = 64; y <= 66; y++) {
    for (let x = -4; x <= 4; x++) world.setState(x, y, 6, STONE);
  }
  const body = makeBody(0.5, 64, 0.5);
  body.onGround = true;
  run(world, body, { ...emptyInput(), forward: 1 }, TPS * 3);
  // 玩家半宽 0.3，最多贴到 z = 5.7
  assert.ok(body.z <= 6 - 0.3 + 1e-6, `不应穿墙，实得 z=${body.z}`);
  assert.ok(body.z > 5.5, `应该贴到墙上，实得 z=${body.z}`);
  assert.ok(Math.abs(body.vz) < 1e-6, `贴墙时 z 速度应为 0，实得 ${body.vz}`);
});

test('自动上台阶：半砖走得上去（碰撞盒由模型推导）', () => {
  // 用**真正的半砖**，不是改过表的合成方块。
  // 碰撞盒现在直接从模型推导，所以这条同时验了模型系统与物理的接缝：
  // 模型说半格高，撞上去就必须是半格高。
  const HALF = packState(registry.idOf(Blocks.STONE_SLAB), 0); // meta 0 = 下半砖

  const world = flatWorld();
  for (let x = -4; x <= 4; x++) {
    for (let z = 6; z <= 10; z++) world.setState(x, 64, z, HALF);
  }
  const body = makeBody(0.5, 64, 0.5);
  body.onGround = true;
  // 只走到台阶区间（z=6..10）里，别走过头 —— 走过去之后地面又回到 y=64 了
  let minSpeedOnStep = Infinity;
  for (let i = 0; i < 40; i++) {
    const before = body.z;
    stepBody(world, TABLES, body, { ...emptyInput(), forward: 1 });
    if (body.z > 6.5 && body.z < 9.5) minSpeedOnStep = Math.min(minSpeedOnStep, body.z - before);
    if (body.z > 9) break;
  }
  assert.ok(body.y >= 64.5 - 1e-6, `应该站上半格台阶（y=64.5），实得 ${body.y}`);
  assert.ok(body.z > 7, `应该走到台阶上去，实得 z=${body.z}`);
  // 上台阶不该把速度清零：无条件清零的话每上一级都会顿一下，
  // 走楼梯就成了一顿一顿的
  assert.ok(minSpeedOnStep > 0.15,
    `上台阶后不该失速，台阶上的最低单 tick 位移 ${minSpeedOnStep.toFixed(4)}`);
});

test('整格高的坎走不上去，必须跳 —— STEP_HEIGHT 是 0.6', () => {
  const world = flatWorld();
  for (let x = -4; x <= 4; x++) {
    for (let z = 6; z <= 10; z++) world.setState(x, 64, z, STONE);
  }
  const body = makeBody(0.5, 64, 0.5);
  body.onGround = true;
  run(world, body, { ...emptyInput(), forward: 1 }, TPS * 4);
  assert.ok(body.y < 65, `整格的坎不该走上去，实得 y=${body.y}`);
  assert.ok(body.z <= 6 - 0.3 + 1e-6, `应该被挡在坎前，实得 z=${body.z}`);
});

test('两格高的坎同样走不上去', () => {
  const world = flatWorld();
  for (let x = -4; x <= 4; x++) {
    for (let z = 6; z <= 10; z++) {
      world.setState(x, 64, z, STONE);
      world.setState(x, 65, z, STONE);
    }
  }
  const body = makeBody(0.5, 64, 0.5);
  body.onGround = true;
  run(world, body, { ...emptyInput(), forward: 1 }, TPS * 4);
  assert.ok(body.y < 65, `两格高的坎不该走上去，实得 y=${body.y}`);
  assert.ok(body.z <= 6 - 0.3 + 1e-6, `应该被挡在坎前，实得 z=${body.z}`);
});

test('冰面：起步更慢，松手后滑得更远', () => {
  const stoneWorld = flatWorld(STONE);
  const iceWorld = flatWorld(ICE);
  const onStone = makeBody(0.5, 64, 0.5);
  onStone.onGround = true;
  const onIce = makeBody(0.5, 64, 0.5);
  onIce.onGround = true;

  run(stoneWorld, onStone, { ...emptyInput(), forward: 1 }, 10);
  run(iceWorld, onIce, { ...emptyInput(), forward: 1 }, 10);
  assert.ok(onIce.z < onStone.z,
    `冰上起步应更慢：冰 ${onIce.z.toFixed(3)} vs 石 ${onStone.z.toFixed(3)}`);

  const stoneBefore = onStone.z;
  const iceBefore = onIce.z;
  run(stoneWorld, onStone, emptyInput(), TPS * 3);
  run(iceWorld, onIce, emptyInput(), TPS * 3);
  const stoneSlide = onStone.z - stoneBefore;
  const iceSlide = onIce.z - iceBefore;
  assert.ok(iceSlide > stoneSlide * 2,
    `冰上应滑得明显更远：冰 ${iceSlide.toFixed(3)} vs 石 ${stoneSlide.toFixed(3)}`);
});

test('疾跑跳能跨过 3 格宽的沟，走跳跨不过', () => {
  const world = flatWorld();
  for (let x = -4; x <= 4; x++) {
    for (let z = 6; z <= 8; z++) {
      for (let y = 55; y <= 63; y++) world.setState(x, y, z, AIR_STATE);
    }
  }
  const jumpAcross = (sprint: boolean): Body => {
    const b = makeBody(0.5, 64, 0.5);
    b.onGround = true;
    const running = { ...emptyInput(), forward: 1, sprint };
    // 先助跑到稳态，再从沟沿起跳
    for (let i = 0; i < TPS * 2; i++) {
      stepBody(world, TABLES, b, running);
      if (b.z > 5.5) break;
    }
    for (let i = 0; i < TPS * 3; i++) {
      stepBody(world, TABLES, b, i === 0 ? { ...running, jump: true } : running);
      if (b.onGround) break;
    }
    return b;
  };

  const sprinted = jumpAcross(true);
  assert.ok(sprinted.y >= 64 - 1e-6, `疾跑跳不该掉进沟里，实得 y=${sprinted.y}`);
  assert.ok(sprinted.z > 9, `疾跑跳应跨过沟，实得 z=${sprinted.z.toFixed(2)}`);

  const walked = jumpAcross(false);
  assert.ok(walked.y < 64, `走跳跨不过这条沟才对，实得 y=${walked.y.toFixed(2)}`);
});

test('未加载的区块当实心 —— 不让玩家掉进还没到货的地形', () => {
  const store = new ChunkStore();
  store.createChunk(0, 0);
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) store.setState(x, 63, z, STONE);
  const body = makeBody(8.5, 64, 15.5);
  body.onGround = true;
  run(store, body, { ...emptyInput(), forward: 1 }, TPS * 2);
  assert.ok(body.z < 16, `不该走进未加载的区块，实得 z=${body.z}`);
  assert.ok(body.y >= 64 - 1e-6, `不该掉下去，实得 y=${body.y}`);
});
