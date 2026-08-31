/**
 * 恶魂与火球。
 *
 * "恶魂火球可击回"是 M15 的验收项之一。它跨了三个系统：飞行物理、
 * 实体攻击、爆炸。任何一环断了，表现都只是"打了没反应"——
 * 而在下界的黑暗里，玩家连火球飞去哪了都看不清。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerCore } from '../../src/server/server-core.ts';
import { createBlockRegistry, Blocks } from '../../src/content/blocks.ts';
import { LoopbackTransport, PacketChannel } from '../../src/core/net/transport.ts';
import {
  S2C, C_Handshake, C_SetViewDistance, C_AttackEntity, PROTOCOL_VERSION,
} from '../../src/core/net/packets.ts';
import { packState, AIR_STATE } from '../../src/core/world/chunk.ts';
import { MobType, mobDefOf } from '../../src/content/mobs.ts';
import {
  GHAST_CHARGE_TICKS, GHAST_SHOOT_INTERVAL, FIREBALL_SPEED, FIREBALL_LIFETIME,
} from '../../src/server/entity/ghast.ts';
import type { ServerPlayer } from '../../src/server/player/server-player.ts';
import type { Mob } from '../../src/server/entity/mob.ts';

const registry = createBlockRegistry();
const STONE = packState(registry.idOf(Blocks.STONE));

interface Rig {
  core: ServerCore;
  player: ServerPlayer;
  send: (p: unknown, v: Record<string, unknown>) => void;
}

function makeRig(): Rig {
  const core = new ServerCore({ seed: 3n, registry });
  core.randomTicks = false;
  core.mobs.naturalSpawning = false;
  const [clientSide, serverSide] = LoopbackTransport.createPair();
  clientSide.synchronous = true;
  serverSide.synchronous = true;
  core.addClient(serverSide);
  const channel = new PacketChannel(clientSide, S2C);
  channel.onPacket(() => {});
  channel.send(C_Handshake, { protocolVersion: PROTOCOL_VERSION, playerName: 't' });
  channel.send(C_SetViewDistance, { distance: 3 });
  channel.flush();
  const player = [...core.eachPlayer()][0]!;
  for (let cx = -3; cx <= 3; cx++) {
    for (let cz = -3; cz <= 3; cz++) core.world.forceChunk(cx, cz);
  }
  // 一片开阔的平台：恶魂要有地方飞
  for (let x = -40; x < 40; x++) {
    for (let z = -40; z < 40; z++) {
      core.world.setBlock(x, 70, z, STONE);
      for (let y = 71; y < 110; y++) core.world.setBlock(x, y, z, AIR_STATE);
    }
  }
  player.x = 0.5;
  player.y = 71;
  player.z = 0.5;
  core.tick();
  return {
    core, player,
    send: (p, v) => { channel.send(p as never, v as never); channel.flush(); },
  };
}

function fireballs(core: ServerCore): Mob[] {
  return [...core.mobs.mobs.values()].filter((m) => m.def.type === MobType.FIREBALL);
}

test('恶魂是会飞的：不受重力，悬在空中', () => {
  const r = makeRig();
  const ghast = r.core.mobs.spawnByName('ghast', 0.5, 95, 20.5)!;
  const y0 = ghast.y;
  for (let i = 0; i < 40; i++) r.core.tick();
  // 会掉的话 40 刻早掉到地上了（自由落体 40 刻 > 30 格）
  assert.ok(ghast.y > 70 + 5, `恶魂掉到了 y=${ghast.y.toFixed(1)}`);
  assert.ok(Math.abs(ghast.y - y0) < 25, '恶魂飘得太离谱');
});

test('恶魂看见玩家会蓄力然后开火', () => {
  const r = makeRig();
  r.core.mobs.spawnByName('ghast', 0.5, 90, 20.5);
  assert.equal(fireballs(r.core).length, 0);
  // 蓄力 + 一点余量
  for (let i = 0; i < GHAST_CHARGE_TICKS + 6; i++) r.core.tick();
  assert.ok(fireballs(r.core).length >= 1, '恶魂一直没开火');
});

test('隔着墙不开火 —— 隔墙打人是最像作弊的一种 AI', () => {
  const r = makeRig();
  // 在玩家头顶盖一层石板，把视线挡住
  for (let x = -6; x <= 6; x++) {
    for (let z = -6; z <= 6; z++) r.core.world.setBlock(x, 78, z, STONE);
  }
  r.core.mobs.spawnByName('ghast', 0.5, 95, 8.5);
  for (let i = 0; i < GHAST_CHARGE_TICKS * 3; i++) r.core.tick();
  assert.equal(fireballs(r.core).length, 0, '隔着屋顶开了火');
});

test('火球朝玩家飞，速度就是 FIREBALL_SPEED', () => {
  const r = makeRig();
  r.core.mobs.spawnByName('ghast', 0.5, 90, 30.5);
  for (let i = 0; i < GHAST_CHARGE_TICKS + 6; i++) r.core.tick();
  const ball = fireballs(r.core)[0];
  assert.ok(ball !== undefined, '没有火球');
  const speed = Math.hypot(ball.body.vx, ball.body.vy, ball.body.vz);
  assert.ok(Math.abs(speed - FIREBALL_SPEED) < 1e-6, `火球速度是 ${speed}`);
  // 往 −Z 飞（恶魂在 +Z 那边）
  assert.ok(ball.body.vz < 0, `火球朝 +Z 飞走了：vz=${ball.body.vz}`);
});

test('击回：打一下火球，它按玩家视线方向重新飞，主人换成玩家', () => {
  const r = makeRig();
  r.core.mobs.spawnByName('ghast', 0.5, 90, 30.5);
  for (let i = 0; i < GHAST_CHARGE_TICKS + 6; i++) r.core.tick();
  const ball = fireballs(r.core)[0]!;
  const ownerBefore = ball.targetId;
  assert.notEqual(ownerBefore, r.player.entityId, '火球一出生主人就是玩家？');

  // 把玩家挪到火球旁边（够得着），并让他朝 +Z 看
  r.player.x = ball.x;
  r.player.y = ball.y - 1.62;
  r.player.z = ball.z - 1;
  r.player.yaw = 0;   // 0 朝 +Z
  r.player.pitch = 0;
  r.send(C_AttackEntity, { entityId: ball.entityId });

  assert.equal(ball.targetId, r.player.entityId, '击回之后主人没换成玩家');
  assert.ok(ball.body.vz > 0, `击回后该朝 +Z 飞，实得 vz=${ball.body.vz}`);
  const speed = Math.hypot(ball.body.vx, ball.body.vy, ball.body.vz);
  assert.ok(Math.abs(speed - FIREBALL_SPEED) < 1e-6, `击回后速度变了：${speed}`);
});

test('击回用的是视线方向，不是"原路返回"', () => {
  const r = makeRig();
  r.core.mobs.spawnByName('ghast', 0.5, 90, 30.5);
  for (let i = 0; i < GHAST_CHARGE_TICKS + 6; i++) r.core.tick();
  const ball = fireballs(r.core)[0]!;
  r.player.x = ball.x;
  r.player.y = ball.y - 1.62;
  r.player.z = ball.z - 1;
  // 朝 +X 看（yaw = π/2）。原路返回的话它会朝 +Z 飞
  r.player.yaw = Math.PI / 2;
  r.player.pitch = 0;
  r.send(C_AttackEntity, { entityId: ball.entityId });
  assert.ok(ball.body.vx > 0.4, `该朝 +X 飞，实得 vx=${ball.body.vx.toFixed(3)}`);
  assert.ok(Math.abs(ball.body.vz) < 0.1, `不该还有 Z 分量：vz=${ball.body.vz.toFixed(3)}`);
});

test('击回后能炸到恶魂', () => {
  const r = makeRig();
  const ghast = r.core.mobs.spawnByName('ghast', 0.5, 90, 24.5)!;
  for (let i = 0; i < GHAST_CHARGE_TICKS + 6; i++) r.core.tick();
  const ball = fireballs(r.core)[0]!;
  const hpBefore = ghast.health;
  // 直接瞄准恶魂
  const dx = ghast.x - ball.x;
  const dy = ghast.y + 2 - ball.y;
  const dz = ghast.z - ball.z;
  r.core.mobs.deflectFireball(ball.entityId, dx, dy, dz, r.player.entityId);
  for (let i = 0; i < 120; i++) {
    r.core.tick();
    if (!r.core.mobs.mobs.has(ball.entityId)) break;
  }
  assert.ok(!r.core.mobs.mobs.has(ball.entityId), '火球没炸掉');
  assert.ok(ghast.health < hpBefore || !ghast.alive,
    `恶魂没被炸到：${hpBefore} -> ${ghast.health}`);
});

test('火球撞墙会炸掉，不会一直飞', () => {
  const r = makeRig();
  const def = mobDefOf(MobType.FIREBALL)!;
  const ball = r.core.mobs.spawn(def, 0.5, 75, 0.5);
  // 朝地面射
  ball.body.vy = -FIREBALL_SPEED;
  ball.targetId = -1;
  for (let i = 0; i < 60 && r.core.mobs.mobs.has(ball.entityId); i++) r.core.tick();
  assert.ok(!r.core.mobs.mobs.has(ball.entityId), '火球撞地了还在飞');
});

test('打偏的火球会自己消失，不会无限加载区块', () => {
  const r = makeRig();
  const def = mobDefOf(MobType.FIREBALL)!;
  const ball = r.core.mobs.spawn(def, 0.5, 100, 0.5);
  // 朝天上射，永远撞不到东西
  ball.body.vy = FIREBALL_SPEED;
  ball.targetId = -1;
  for (let i = 0; i < FIREBALL_LIFETIME + 20 && r.core.mobs.mobs.has(ball.entityId); i++) {
    r.core.tick();
  }
  assert.ok(!r.core.mobs.mobs.has(ball.entityId),
    '火球活过了寿命上限 —— 它会一路飞下去把沿途的区块全加载出来');
});

test('恶魂两发之间有间隔，不会连射', () => {
  const r = makeRig();
  r.core.mobs.spawnByName('ghast', 0.5, 90, 30.5);
  for (let i = 0; i < GHAST_CHARGE_TICKS + 6; i++) r.core.tick();
  assert.equal(fireballs(r.core).length, 1);
  // 再跑不到一个间隔，不该出第二发
  for (let i = 0; i < GHAST_SHOOT_INTERVAL - GHAST_CHARGE_TICKS - 10; i++) r.core.tick();
  const n = fireballs(r.core).length;
  assert.ok(n <= 1, `间隔内连射了 ${n} 发`);
});

test('火球有模型，客户端画得出来', async () => {
  const { mobModelOf } = await import('../../src/content/mob-models.ts');
  for (const type of [MobType.GHAST, MobType.FIREBALL]) {
    const model = mobModelOf(type);
    assert.ok(model !== null, `type ${type} 没有模型 —— 客户端会画不出来`);
    assert.ok(model.boxes.length > 0);
  }
});

test('恶魂只在下界刷，主世界不刷', () => {
  const r = makeRig();
  r.core.mobs.naturalSpawning = true;
  // 主世界跑很久：恶魂一只都不该出现
  for (let i = 0; i < 400; i++) r.core.tick();
  const inOverworld = [...r.core.mobs.mobs.values()]
    .filter((m) => m.def.type === MobType.GHAST);
  assert.equal(inOverworld.length, 0, `主世界刷出了 ${inOverworld.length} 只恶魂`);
});
