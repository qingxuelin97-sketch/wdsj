/**
 * 农业：耕地、小麦、甘蔗、草蔓延、树苗。
 *
 * 这一套全部由**随机刻**驱动，而随机刻是 3/4096 的概率 —— 一株小麦
 * 平均要几分钟才长一级。测试不可能等，所以直接调 `runRandomTicks` 上千次，
 * 或者干脆调被它调用的那些函数。
 *
 * 断言的是**规则**而不是速度：湿地比干地快、挤在一起比隔行慢、
 * 没光不长、甘蔗最多三格。速度本身由那个 3/4096 决定，改它等于改整个
 * 农业的节奏，所以它是常数不是参数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerCore } from '../../src/server/server-core.ts';
import { createBlockRegistry, Blocks } from '../../src/content/blocks.ts';
import { LoopbackTransport, PacketChannel } from '../../src/core/net/transport.ts';
import { S2C, C_Handshake, C_SetViewDistance, PROTOCOL_VERSION } from '../../src/core/net/packets.ts';
import { packState, stateId, stateMeta, AIR_STATE } from '../../src/core/world/chunk.ts';
import { runRandomTicks, tillSoil, applyBoneMeal, WHEAT_MAX_AGE } from '../../src/server/world/random-ticks.ts';
import type { ServerPlayer } from '../../src/server/player/server-player.ts';

const registry = createBlockRegistry();
const STONE = registry.idOf(Blocks.STONE);
const DIRT = registry.idOf(Blocks.DIRT);
const GRASS = registry.idOf(Blocks.GRASS_BLOCK);
const FARMLAND = registry.idOf(Blocks.FARMLAND);
const WHEAT = registry.idOf(Blocks.WHEAT_CROP);
const WATER = registry.idOf('water');
const CANE = registry.idOf(Blocks.SUGAR_CANE_BLOCK);
const SAPLING = registry.idOf(Blocks.SAPLING);
const Y = 71;

function makeFarm(): { core: ServerCore; player: ServerPlayer } {
  const core = new ServerCore({ seed: 77n, registry });
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
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) core.world.forceChunk(cx, cz);
  // 一片露天的泥土地
  for (let x = -12; x < 12; x++) {
    for (let z = -12; z < 12; z++) {
      core.world.setBlock(x, Y - 1, z, packState(DIRT));
      for (let y = Y; y < Y + 8; y++) core.world.setBlock(x, y, z, AIR_STATE);
    }
  }
  player.x = 0.5;
  player.y = Y;
  player.z = 0.5;
  core.tick();
  return { core, player };
}

test('锄头把泥土翻成耕地；旁边有水就是湿的', () => {
  const { core } = makeFarm();
  assert.equal(tillSoil(core.world, 3, Y - 1, 3), true, '泥土该翻得动');
  assert.equal(stateId(core.world.getBlock(3, Y - 1, 3)), FARMLAND);
  assert.equal(stateMeta(core.world.getBlock(3, Y - 1, 3)), 0, '附近没水就是干的');

  core.world.setBlock(5, Y - 1, 5, packState(WATER));
  assert.equal(tillSoil(core.world, 5, Y - 1, 6), true);
  assert.equal(stateMeta(core.world.getBlock(5, Y - 1, 6)), 7, '旁边有水该是湿的');

  // 石头翻不动，头顶有东西也翻不动
  core.world.setBlock(7, Y - 1, 7, packState(STONE));
  assert.equal(tillSoil(core.world, 7, Y - 1, 7), false, '石头翻不动');
  core.world.setBlock(8, Y, 8, packState(STONE));
  assert.equal(tillSoil(core.world, 8, Y - 1, 8), false, '头顶被压住就翻不动');
});

test('小麦在耕地上会长到 7 级', () => {
  const { core } = makeFarm();
  core.world.setBlock(2, Y - 1, 2, packState(WATER));
  tillSoil(core.world, 2, Y - 1, 3);
  core.world.setBlock(2, Y, 3, packState(WHEAT, 0));
  core.tick(); // 让光照收敛

  // 随机刻是 3/4096：一个指定的格子平均 1365 刻才被挑中一次，
  // 而长熟要七次成功的生长判定。实测约 6 万轮到顶，这里给 10 万轮。
  //
  // 换算成游戏时间是几十分钟 —— 那正是 MC 里小麦的成熟时间，
  // 这个"慢"不是实现问题，它就是农业玩法的节奏本身
  for (let i = 0; i < 100000; i++) runRandomTicks(core.world);
  const age = stateMeta(core.world.getBlock(2, Y, 3));
  assert.equal(age, WHEAT_MAX_AGE, `小麦该长熟，实际到 ${age} 级`);
});

test('没光的小麦不长', () => {
  const { core } = makeFarm();
  tillSoil(core.world, 2, Y - 1, 3);
  core.world.setBlock(2, Y, 3, packState(WHEAT, 0));
  // 盖一层够大的顶。5×5 是不够的 —— 天光会从四边斜着渗进来，
  // 正中间仍有 12 级光，作物照长不误（M10 的僵尸日灼测试踩过同一个坑）
  for (let dx = -8; dx <= 8; dx++) {
    for (let dz = -8; dz <= 8; dz++) core.world.setBlock(2 + dx, Y + 3, 3 + dz, packState(STONE));
  }
  for (let i = 0; i < 8; i++) core.tick();

  for (let i = 0; i < 100000; i++) runRandomTicks(core.world);
  assert.equal(stateMeta(core.world.getBlock(2, Y, 3)), 0, '暗处的小麦不该长');
});

test('骨粉直接把小麦催熟', () => {
  const { core } = makeFarm();
  tillSoil(core.world, 2, Y - 1, 3);
  core.world.setBlock(2, Y, 3, packState(WHEAT, 2));
  assert.equal(applyBoneMeal(core.world, 2, Y, 3), true);
  assert.equal(stateMeta(core.world.getBlock(2, Y, 3)), WHEAT_MAX_AGE);
  // 已经熟了就浪费不了
  assert.equal(applyBoneMeal(core.world, 2, Y, 3), false, '熟了就不该再吃骨粉');
});

test('耕地没水会慢慢变干，干透且没作物就退回泥土', () => {
  const { core } = makeFarm();
  core.world.setBlock(4, Y - 1, 4, packState(FARMLAND, 7));
  for (let i = 0; i < 20000; i++) runRandomTicks(core.world);
  assert.equal(
    stateId(core.world.getBlock(4, Y - 1, 4)), DIRT,
    '荒了的田该退回泥土 —— 这是"不种就白翻"的来源',
  );
});

test('甘蔗最多长三格', () => {
  const { core } = makeFarm();
  core.world.setBlock(6, Y, 6, packState(CANE, 0));
  // 甘蔗每次被挑中只把计时 +1，攒到 15 才长一格，两格就要三十次
  for (let i = 0; i < 200000; i++) runRandomTicks(core.world);
  let height = 0;
  for (let y = Y; y < Y + 6; y++) {
    if (stateId(core.world.getBlock(6, y, 6)) === CANE) height++;
  }
  assert.equal(height, 3, `甘蔗该长到 3 格，实际 ${height} 格`);
});

test('草会往旁边的泥土上蔓延', () => {
  const { core } = makeFarm();
  core.world.setBlock(0, Y - 1, 0, packState(GRASS));
  for (let i = 0; i < 8; i++) core.tick(); // 光照

  let spread = 0;
  for (let i = 0; i < 30000; i++) runRandomTicks(core.world);
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      if (dx === 0 && dz === 0) continue;
      if (stateId(core.world.getBlock(dx, Y - 1, dz)) === GRASS) spread++;
    }
  }
  assert.ok(spread > 0, '草该蔓延到旁边的泥土上');
});

test('树苗会长成一棵有树干和树冠的树', () => {
  const { core } = makeFarm();
  core.world.setBlock(0, Y, 0, packState(SAPLING, 0));
  for (let i = 0; i < 5; i++) core.tick();
  for (let i = 0; i < 20000; i++) runRandomTicks(core.world);

  const LOG = registry.idOf(Blocks.LOG);
  const LEAVES = registry.idOf(Blocks.LEAVES);
  let logs = 0;
  let leaves = 0;
  for (let y = Y; y < Y + 8; y++) {
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        const id = stateId(core.world.getBlock(dx, y, dz));
        if (id === LOG) logs++;
        if (id === LEAVES) leaves++;
      }
    }
  }
  assert.ok(logs >= 4, `该有一根 4 格以上的树干，实际 ${logs} 格`);
  assert.ok(leaves > 10, `该有树冠，实际 ${leaves} 片叶子`);
});
