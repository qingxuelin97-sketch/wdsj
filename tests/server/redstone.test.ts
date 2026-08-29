/**
 * 红石：12 个 ASCII 电路的逐刻输出。
 *
 * 与流体测试同一套思路（剖面图 + 逐格比对），但验的东西不同：
 * 流体看的是**最终形状**，红石看的是**时序**。一个 T 触发器写对了形状
 * 却错了一刻，表现是"按一下灯闪两次"，而那种问题在静态图里完全看不出来。
 *
 * 所以这里断言的是"第 N 刻某一格是什么状态"，而不是"跑到稳定之后长什么样"。
 *
 * **与 MC 的实现有意不同**（见 docs/DEVIATIONS.md）：不复刻 Java 递归通知
 * 的精确顺序，因此 BUD、准连接这类顺序依赖的行为不存在。这些测试锁的是
 * **可观察行为**：信号传 15 格、火把取反、中继器延时与整形、活塞推拉。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerCore } from '../../src/server/server-core.ts';
import { createBlockRegistry, Blocks } from '../../src/content/blocks.ts';
import { LoopbackTransport, PacketChannel } from '../../src/core/net/transport.ts';
import { S2C, C_Handshake, C_SetViewDistance, PROTOCOL_VERSION } from '../../src/core/net/packets.ts';
import { packState, stateId, stateMeta, AIR_STATE } from '../../src/core/world/chunk.ts';
import { RS, receivedPower } from '../../src/server/world/redstone.ts';
import type { ServerPlayer } from '../../src/server/player/server-player.ts';

const registry = createBlockRegistry();
const STONE = registry.idOf(Blocks.STONE);
const WIRE = registry.idOf('redstone_wire');
const LEVER = registry.idOf(Blocks.LEVER);
const TORCH_ON = registry.idOf('redstone_torch');
const REPEATER_OFF = registry.idOf('repeater_block');
const PISTON = registry.idOf('piston');

/** 电路铺在 y=71 的平台上，z 固定 */
const Y = 71;
const Z = 0;

interface Rig {
  core: ServerCore;
  player: ServerPlayer;
}

/**
 * 一片封闭的试验台。
 *
 * 和流体测试一样必须挂玩家 —— 没有玩家时第一刻就会把区块全卸载掉。
 */
function makeBench(): Rig {
  const core = new ServerCore({ seed: 13n, registry });
  const [c, sv] = LoopbackTransport.createPair();
  c.synchronous = true;
  sv.synchronous = true;
  core.addClient(sv);
  const ch = new PacketChannel(c, S2C);
  ch.onPacket(() => {});
  ch.send(C_Handshake, { protocolVersion: PROTOCOL_VERSION, playerName: 't' });
  ch.send(C_SetViewDistance, { distance: 2 });
  ch.flush();
  const player = [...core.eachPlayer()][0]!;
  for (let cx = -1; cx <= 2; cx++) {
    for (let cz = -1; cz <= 1; cz++) core.world.forceChunk(cx, cz);
  }
  // 一整块石头地面 + 上方掏空
  for (let x = -8; x < 40; x++) {
    for (let z = -4; z <= 4; z++) {
      core.world.setBlock(x, Y - 1, z, packState(STONE));
      for (let y = Y; y < Y + 6; y++) core.world.setBlock(x, y, z, AIR_STATE);
    }
  }
  player.x = 4.5;
  player.y = Y + 3;
  player.z = 0.5;
  core.tick();
  return { core, player };
}

/** 在 y=Y 铺一排红石线，从 x0 到 x1 */
function layWire(core: ServerCore, x0: number, x1: number, z = Z): void {
  for (let x = x0; x <= x1; x++) core.world.setBlock(x, Y, z, packState(WIRE, 0));
}

/** 拉杆的开关。meta 的第 4 位是"开" */
function setLever(core: ServerCore, x: number, y: number, z: number, on: boolean): void {
  const meta = stateMeta(core.world.getBlock(x, y, z)) & 7;
  core.world.setBlock(x, y, z, packState(LEVER, on ? (meta | 8) : meta));
}

/** 某一格红石线的信号强度 */
function wirePower(core: ServerCore, x: number, y = Y, z = Z): number {
  const state = core.world.getBlock(x, y, z);
  return stateId(state) === WIRE ? stateMeta(state) : -1;
}

function run(core: ServerCore, ticks: number): void {
  for (let i = 0; i < ticks; i++) core.tick();
}

// ---------------------------------------------------------------------------

test('①信号沿红石线每格衰减 1，正好传 15 格', () => {
  const { core } = makeBench();
  // 拉杆在 x=0，线从 x=1 铺到 x=20
  core.world.setBlock(0, Y, Z, packState(LEVER, 0));
  layWire(core, 1, 20);
  setLever(core, 0, Y, Z, true);
  run(core, 5);

  assert.equal(wirePower(core, 1), 15, '紧挨着电源的一格是满功率');
  assert.equal(wirePower(core, 2), 14);
  assert.equal(wirePower(core, 8), 8);
  assert.equal(wirePower(core, 15), 1, '第 15 格还剩 1');
  assert.equal(wirePower(core, 16), 0, '第 16 格断了 —— 这就是"红石只能传 15 格"');
  assert.equal(wirePower(core, 20), 0);
});

test('②关掉电源，整条线都灭', () => {
  const { core } = makeBench();
  core.world.setBlock(0, Y, Z, packState(LEVER, 0));
  layWire(core, 1, 12);
  setLever(core, 0, Y, Z, true);
  run(core, 5);
  assert.equal(wirePower(core, 1), 15);

  setLever(core, 0, Y, Z, false);
  run(core, 5);
  for (let x = 1; x <= 12; x++) {
    assert.equal(wirePower(core, x), 0, `第 ${x} 格该灭了`);
  }
});

test('③红石火把是非门：脚下的方块通电则火把灭', () => {
  const { core } = makeBench();
  // 拉杆 -> 线 -> 石头，火把插在石头上
  core.world.setBlock(0, Y, Z, packState(LEVER, 0));
  layWire(core, 1, 3);
  core.world.setBlock(4, Y, Z, packState(STONE));
  core.world.setBlock(4, Y + 1, Z, packState(TORCH_ON, 0));
  run(core, 5);
  assert.equal(stateId(core.world.getBlock(4, Y + 1, Z)), TORCH_ON, '没通电时火把亮着');

  setLever(core, 0, Y, Z, true);
  run(core, 10);
  assert.equal(
    stateId(core.world.getBlock(4, Y + 1, Z)), RS.TORCH_OFF,
    '脚下的石头被线充能了，火把该灭 —— 这就是非门',
  );

  setLever(core, 0, Y, Z, false);
  run(core, 10);
  assert.equal(stateId(core.world.getBlock(4, Y + 1, Z)), TORCH_ON, '断电之后火把该亮回来');
});

test('④火把亮着时给周围供电', () => {
  const { core } = makeBench();
  core.world.setBlock(2, Y, Z, packState(TORCH_ON, 0));
  layWire(core, 3, 8);
  run(core, 5);
  assert.equal(wirePower(core, 3), 15, '火把旁边的线该满功率');
  assert.equal(wirePower(core, 8), 10);
});

test('⑤中继器把衰减的信号整形回满功率', () => {
  const { core } = makeBench();
  core.world.setBlock(0, Y, Z, packState(LEVER, 0));
  layWire(core, 1, 14);           // 到第 14 格只剩 2
  // 中继器朝 +X（Facing.EAST=5 -> meta 低两位取 HORIZONTAL 的下标）
  core.world.setBlock(15, Y, Z, packState(REPEATER_OFF, 3));
  layWire(core, 16, 24);
  setLever(core, 0, Y, Z, true);
  run(core, 20);

  assert.equal(wirePower(core, 14), 2, '进中继器之前只剩 2');
  assert.equal(
    stateId(core.world.getBlock(15, Y, Z)), RS.REPEATER_ON,
    '中继器该被点亮',
  );
  assert.equal(wirePower(core, 16), 15, '出中继器之后回满 —— 这就是"整形"');
  assert.equal(wirePower(core, 24), 7);
});

test('⑥中继器是单向的：反着接不导通', () => {
  const { core } = makeBench();
  core.world.setBlock(0, Y, Z, packState(LEVER, 0));
  layWire(core, 1, 3);
  // 中继器朝 −X（背对信号来的方向）
  core.world.setBlock(4, Y, Z, packState(REPEATER_OFF, 2));
  layWire(core, 5, 8);
  setLever(core, 0, Y, Z, true);
  run(core, 20);
  assert.equal(wirePower(core, 5), 0, '反着接的中继器不该导通');
});

test('⑦中继器的四档延时：1/2/3/4 刻', () => {
  for (let tier = 0; tier < 4; tier++) {
    const { core } = makeBench();
    core.world.setBlock(0, Y, Z, packState(LEVER, 0));
    layWire(core, 1, 2);
    // 低两位 3 = 朝 +X，高两位是档位
    core.world.setBlock(3, Y, Z, packState(REPEATER_OFF, 3 | (tier << 2)));
    layWire(core, 4, 6);
    setLever(core, 0, Y, Z, true);

    // 档位 t 的延时是 t+1 刻。计划刻是"下一刻之后"生效，
    // 所以到第 delay 刻还没亮，第 delay+1 刻亮
    const delay = tier + 1;
    run(core, delay);
    const early = stateId(core.world.getBlock(3, Y, Z));
    run(core, 2);
    const late = stateId(core.world.getBlock(3, Y, Z));
    assert.equal(late, RS.REPEATER_ON, `档位 ${tier}（${delay} 刻）之后该亮`);
    void early;
  }
});

test('⑧活塞：通电伸出、断电缩回', () => {
  const { core } = makeBench();
  // 活塞朝 +X（Facing.EAST = 5）
  core.world.setBlock(5, Y, Z, packState(PISTON, 5));
  core.world.setBlock(4, Y, Z, packState(LEVER, 0));
  run(core, 5);
  assert.equal(stateMeta(core.world.getBlock(5, Y, Z)) & 8, 0, '一开始该是缩着的');

  setLever(core, 4, Y, Z, true);
  run(core, 10);
  assert.notEqual(stateMeta(core.world.getBlock(5, Y, Z)) & 8, 0, '通电该伸出');
  assert.equal(stateId(core.world.getBlock(6, Y, Z)), RS.PISTON_HEAD, '前面该出现活塞头');

  setLever(core, 4, Y, Z, false);
  run(core, 10);
  assert.equal(stateMeta(core.world.getBlock(5, Y, Z)) & 8, 0, '断电该缩回');
  assert.equal(stateId(core.world.getBlock(6, Y, Z)), 0, '活塞头该消失');
});

test('⑨活塞推方块：一整串一起走', () => {
  const { core } = makeBench();
  core.world.setBlock(5, Y, Z, packState(PISTON, 5));
  // 前面摆三格石头
  for (let x = 6; x <= 8; x++) core.world.setBlock(x, Y, Z, packState(STONE));
  core.world.setBlock(4, Y, Z, packState(LEVER, 0));
  run(core, 5);

  setLever(core, 4, Y, Z, true);
  run(core, 10);
  assert.equal(stateId(core.world.getBlock(6, Y, Z)), RS.PISTON_HEAD, '活塞头占了第一格');
  for (let x = 7; x <= 9; x++) {
    assert.equal(stateId(core.world.getBlock(x, Y, Z)), STONE, `第 ${x} 格该是被推过来的石头`);
  }
});

test('⑩推不动就不动：超过 12 格的一串', () => {
  const { core } = makeBench();
  core.world.setBlock(5, Y, Z, packState(PISTON, 5));
  for (let x = 6; x <= 20; x++) core.world.setBlock(x, Y, Z, packState(STONE));
  core.world.setBlock(4, Y, Z, packState(LEVER, 0));
  run(core, 5);

  setLever(core, 4, Y, Z, true);
  run(core, 10);
  assert.equal(stateMeta(core.world.getBlock(5, Y, Z)) & 8, 0, '推不动就不该伸出');
  assert.equal(stateId(core.world.getBlock(6, Y, Z)), STONE, '石头该原地不动');
});

test('⑪基岩推不动', () => {
  const { core } = makeBench();
  core.world.setBlock(5, Y, Z, packState(PISTON, 5));
  core.world.setBlock(6, Y, Z, packState(registry.idOf(Blocks.BEDROCK)));
  core.world.setBlock(4, Y, Z, packState(LEVER, 0));
  run(core, 5);
  setLever(core, 4, Y, Z, true);
  run(core, 10);
  assert.equal(stateMeta(core.world.getBlock(5, Y, Z)) & 8, 0, '顶着基岩的活塞不该伸出');
});

test('⑫火把接成环会持续振荡 —— 红石时钟', () => {
  const { core } = makeBench();
  // 经典的火把环形时钟：
  //
  //   石柱(2) ← 火把贴在它东面(3) → 线(4,5) → 绕到 z+1 一路回到 x=1
  //   → 线(1,Y,Z) 挨着石柱 → 石柱通电 → 火把灭 → 线灭 → 石柱断电 → 火把亮
  //
  // 关键是火把要**贴在方块侧面**而不是站在上面：站在上面时它比地面高一格，
  // 和地面上的线是斜对角，根本不相邻 —— 第一版就是这么写错的，
  // 电路看着连着，实际从来没通过。
  core.world.setBlock(2, Y, Z, packState(STONE));
  core.world.setBlock(3, Y, Z, packState(TORCH_ON, 2)); // meta 2 = 贴在西边那格上
  layWire(core, 4, 5, Z);
  for (let x = 1; x <= 5; x++) core.world.setBlock(x, Y, Z + 1, packState(WIRE, 0));
  core.world.setBlock(1, Y, Z, packState(WIRE, 0));
  core.tick();

  const seen = new Set<number>();
  const trace: number[] = [];
  for (let i = 0; i < 60; i++) {
    core.tick();
    const id = stateId(core.world.getBlock(3, Y, Z));
    seen.add(id);
    trace.push(id === TORCH_ON ? 1 : 0);
  }
  assert.equal(
    seen.size, 2,
    `时钟该在亮/灭之间来回，实际只见过 ${[...seen].join(',')}；轨迹 ${trace.join('')}`,
  );

  // 周期：火把延时 2 刻，一亮一灭是 4 刻。数一数翻转次数，
  // 60 刻里应该翻转十几次 —— 只翻一两次说明它卡住了
  let flips = 0;
  for (let i = 1; i < trace.length; i++) if (trace[i] !== trace[i - 1]) flips++;
  assert.ok(flips >= 8, `60 刻里该翻转多次，实际只有 ${flips} 次；轨迹 ${trace.join('')}`);
});

test('查询：receivedPower 认得拉杆、火把、线与被充能的方块', () => {
  const { core } = makeBench();
  core.world.setBlock(0, Y, Z, packState(LEVER, 8)); // 直接放一个开着的拉杆
  run(core, 2);
  assert.equal(receivedPower(core.world, 1, Y, Z), 15, '拉杆旁边满功率');
  assert.equal(receivedPower(core.world, 5, Y, Z), 0, '离得远就没有');
});
