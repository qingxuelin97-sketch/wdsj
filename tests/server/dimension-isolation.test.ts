/**
 * 维度隔离：三个维度**共用同一套坐标**，所以任何"只按坐标算"的判定
 * 都会跨维度串味。
 *
 * 这一整个文件盯的是同一类 bug：某个子系统写死了 core.world（永远是主世界），
 * 或者广播时只看订阅集而不看玩家在哪个维度。症状都很吓人但一眼看不出原因：
 * 在下界挖的矿被主世界的人捡走、末影龙挂在主世界出生点的天上、
 * 下界炸一发 TNT 把主世界的人炸死。
 *
 * 单人玩不出这些 —— 一个玩家同一时刻只在一个维度里。所以只能在这里钉住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerCore } from '../../src/server/server-core.ts';
import { createBlockRegistry, Blocks } from '../../src/content/blocks.ts';
import { createItemRegistry, Items } from '../../src/content/items.ts';
import { LoopbackTransport, PacketChannel } from '../../src/core/net/transport.ts';
import { S2C, C_Handshake, C_SetViewDistance, PROTOCOL_VERSION } from '../../src/core/net/packets.ts';
import { makeStack } from '../../src/core/item/item-def.ts';
import { Dimension } from '../../src/core/world/dimension.ts';
import { packState } from '../../src/core/world/chunk.ts';
import { spawnItem, tickItems } from '../../src/server/entity/item-manager.ts';
import { respawnPlayer, onPlayerDeath } from '../../src/server/entity/combat.ts';
import { standable } from '../../src/server/entity/mob-spawning.ts';
import { MobType, mobDefOf } from '../../src/content/mobs.ts';
import type { ServerPlayer } from '../../src/server/player/server-player.ts';

const registry = createBlockRegistry();
const items = createItemRegistry();

function makeCore(): ServerCore {
  return new ServerCore({ seed: 1234n, registry });
}

function join(core: ServerCore, name: string): ServerPlayer {
  const [c, sv] = LoopbackTransport.createPair();
  c.synchronous = true;
  sv.synchronous = true;
  core.addClient(sv);
  const ch = new PacketChannel(c, S2C);
  ch.onPacket(() => {});
  ch.send(C_Handshake, { protocolVersion: PROTOCOL_VERSION, playerName: name });
  ch.send(C_SetViewDistance, { distance: 2 });
  ch.flush();
  return [...core.eachPlayer()].find((p) => p.name === name)!;
}

test('掉落物落在丢它的那个维度里，不会跑到主世界去', () => {
  const core = makeCore();
  const nether = core.worldOf(Dimension.NETHER);
  nether.forceChunk(0, 0);

  spawnItem(core, nether, 5.5, 40, 5.5, makeStack(items.idOf(Items.DIAMOND), 3), false);
  assert.equal(nether.items.size, 1, '应该落在下界');
  assert.equal(core.world.items.size, 0, '主世界不该凭空多出一件');
});

test('主世界的玩家捡不到下界地上的东西', () => {
  const core = makeCore();
  const p = join(core, '主世界的人');
  const nether = core.worldOf(Dimension.NETHER);
  nether.forceChunk(0, 0);

  // 把玩家挪到和那件东西**完全一样的坐标**上 —— 拾取判定只看 xyz
  p.x = 5.5; p.y = 40; p.z = 5.5;
  assert.equal(p.dimension, Dimension.OVERWORLD);

  const e = spawnItem(core, nether, 5.5, 40, 5.5, makeStack(items.idOf(Items.DIAMOND), 3), false);
  e!.pickupDelay = 0;
  for (let i = 0; i < 5; i++) tickItems(core, nether);

  assert.equal(nether.items.size, 1, '东西该还在下界地上');
  assert.equal(
    p.inventory.slots.filter((s) => s.id === items.idOf(Items.DIAMOND)).length, 0,
    '主世界的人隔着维度把下界的钻石吸走了',
  );
});

/**
 * 两个玩家，一个在主世界一个在下界，**站在完全一样的坐标上**。
 *
 * 这是这一整类 bug 唯一能复现的姿势：单人玩不出来（一个人同一刻只在一个
 * 维度里），而两个人分处两界又不站同一个坐标的话，订阅集本来就不重叠，
 * 照样测不出来。
 *
 * 下界那个玩家还有一个作用：把下界那个世界**钉住**。没人在的维度会被
 * 卸载，里面的生物跟着一起没了 —— 那样断言"主世界的人看不见它"是白测的。
 */
function twoWorldsRig(): { core: ServerCore; over: ServerPlayer; hell: ServerPlayer } {
  const core = makeCore();
  const over = join(core, '主世界的人');
  const hell = join(core, '下界的人');
  const nether = core.worldOf(Dimension.NETHER);
  for (let cz = -1; cz <= 1; cz++) {
    for (let cx = -1; cx <= 1; cx++) nether.forceChunk(cx, cz);
  }
  hell.dimension = Dimension.NETHER;
  for (const p of [over, hell]) {
    p.x = 5.5; p.y = 40; p.z = 5.5;
    p.resetSubscriptions();
  }
  // 下界那一格给块实地，免得人和怪一起掉下去
  const rock = packState(registry.idOf(Blocks.NETHERRACK));
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) nether.setBlock(5 + dx, 39, 5 + dz, rock);
  }
  return { core, over, hell };
}

test('掉落物广播不会把别的维度的东西发给玩家', () => {
  const { core, over, hell } = twoWorldsRig();
  const nether = core.worldOf(Dimension.NETHER);
  spawnItem(core, nether, 5.5, 41, 5.5, makeStack(items.idOf(Items.DIAMOND), 1), false);

  for (let i = 0; i < 4; i++) core.tick();
  assert.equal(over.knownItems.size, 0, '主世界的玩家不该知道下界那件掉落物的存在');
  // 下界那位当然要看得见 —— 否则这条测试可能只是因为广播整个坏了才过的
  assert.ok(hell.knownItems.size > 0 || hell.inventory.slots.some(
    (s) => s.id === items.idOf(Items.DIAMOND),
  ), '下界的玩家应该看得见或者已经捡到了它');
});

test('生物只同步给同一个维度的玩家 —— 否则龙会挂在主世界的天上', () => {
  const { core, over, hell } = twoWorldsRig();
  const mob = core.mobs.spawnByName('zombie', 5.5, 40, 5.5, Dimension.NETHER);
  assert.ok(mob !== null);

  for (let i = 0; i < 6; i++) core.tick();
  assert.ok(core.mobs.mobs.has(mob.entityId), '这只怪不该被卸载掉 —— 卸载了这条测试就白测了');
  assert.equal(over.knownMobs.has(mob.entityId), false, '主世界的玩家看见了下界的怪');
  assert.equal(hell.knownMobs.has(mob.entityId), true, '下界的玩家反而该看得见');
});

test('爆炸只伤同一个维度的人', () => {
  const core = makeCore();
  const p = join(core, '主世界的人');
  const nether = core.worldOf(Dimension.NETHER);
  nether.forceChunk(0, 0);
  p.x = 5.5; p.y = 40; p.z = 5.5;
  const before = p.vitals.health;

  core.explode(5.5, 40, 5.5, 3, -1, nether);
  for (let i = 0; i < 3; i++) core.tick();

  assert.equal(p.vitals.health, before, '下界炸的一发把主世界同坐标的人炸了');
});

test('在下界死掉，重生要回主世界 —— 留在下界会卡在岩石里反复死', () => {
  const core = makeCore();
  const p = join(core, '倒霉蛋');
  core.worldOf(Dimension.NETHER).forceChunk(0, 0);
  p.dimension = Dimension.NETHER;
  p.x = 5.5; p.y = 40; p.z = 5.5;
  p.vitals.health = 0;
  onPlayerDeath(core, p);
  respawnPlayer(core, p);

  assert.equal(p.dimension, Dimension.OVERWORLD, '重生之后还留在下界');
  assert.ok(Math.abs(p.x - core.spawnX) < 1e-9, '应该回到主世界出生点');
});

test('生物落脚点判定读的是它要刷进去的那个维度', () => {
  const core = makeCore();
  const nether = core.worldOf(Dimension.NETHER);
  nether.forceChunk(0, 0);
  core.world.forceChunk(0, 0);

  const def = mobDefOf(MobType.ZOMBIE);
  assert.ok(def !== null, '应该找得到僵尸的定义');

  // 在下界造一个明确站得住的坑：脚下实心、上面两格空
  const stone = packState(registry.idOf(Blocks.NETHERRACK));
  nether.setBlock(5, 39, 5, stone);
  for (let h = 0; h < 3; h++) nether.setBlock(5, 40 + h, 5, 0);
  // 主世界的同一个坐标反过来：填实。读错世界的话这里会判 false
  const dirt = packState(registry.idOf(Blocks.STONE));
  for (let h = 0; h < 3; h++) core.world.setBlock(5, 40 + h, 5, dirt);

  assert.equal(
    standable(nether, 5, 40, 5, def), true,
    '按下界的地形该站得住 —— 判成站不住说明读的是主世界',
  );
  assert.equal(
    standable(core.world, 5, 40, 5, def), false,
    '主世界那边是实心的，该站不住',
  );
});
