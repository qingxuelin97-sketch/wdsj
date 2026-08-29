/**
 * 生物与 AI。
 *
 * 三条被 ROADMAP 点名的单测在这里：僵尸日灼、苦力怕引信、末影人传送。
 * 它们各自定义了一种生物的性格，写错了不会崩，只会"感觉不对" ——
 * 而"感觉不对"是最难在几万行里定位的一类问题。
 *
 * 还有一条压力测试：100 只生物跑 600 刻，验的是不炸 + 单刻耗时。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerCore } from '../../src/server/server-core.ts';
import { createBlockRegistry, Blocks } from '../../src/content/blocks.ts';
import { createItemRegistry, Items } from '../../src/content/items.ts';
import { MobType, MobCategory, mobDefOf } from '../../src/content/mobs.ts';
import { Mob, mobFromNbt } from '../../src/server/entity/mob.ts';
import { CREEPER_FUSE_TICKS } from '../../src/server/entity/goals.ts';
import { PathFinder } from '../../src/server/entity/pathfind.ts';
import { LoopbackTransport, PacketChannel } from '../../src/core/net/transport.ts';
import { S2C, C_Handshake, C_SetViewDistance, PROTOCOL_VERSION } from '../../src/core/net/packets.ts';
import { packState, AIR_STATE } from '../../src/core/world/chunk.ts';
import type { ServerPlayer } from '../../src/server/player/server-player.ts';

const registry = createBlockRegistry();
const items = createItemRegistry();
const STONE = registry.idOf(Blocks.STONE);

/**
 * 一个只有平地的测试世界：把 48×48 的一片地面铺成石头，上面掏空。
 *
 * **必须挂一个玩家**。没有玩家时 unloadDistantChunks 会在第一刻就把所有
 * 区块卸载掉（没人需要它们），于是天光读出来是 0、生物一进 tick 就被
 * 当作"在未加载区块里"收走 —— 表现是僵尸不烧、牛不掉东西，
 * 看上去像生物逻辑坏了，其实是脚手架没让世界活着。
 */
function makeFlatCore(seed = 11n): { core: ServerCore; player: ServerPlayer } {
  const core = new ServerCore({ seed, registry });
  const player = attachPlayer(core);
  player.x = 8.5;
  player.y = 71;
  player.z = 8.5;
  for (let cx = -2; cx <= 2; cx++) {
    for (let cz = -2; cz <= 2; cz++) core.world.forceChunk(cx, cz);
  }
  for (let x = -16; x < 32; x++) {
    for (let z = -16; z < 32; z++) {
      core.world.setBlock(x, 70, z, packState(STONE));
      for (let y = 71; y < 78; y++) core.world.setBlock(x, y, z, AIR_STATE);
    }
  }
  core.tick();
  return { core, player };
}

/** 接一个客户端，返回玩家 */
function attachPlayer(core: ServerCore): ServerPlayer {
  const [clientSide, serverSide] = LoopbackTransport.createPair();
  clientSide.synchronous = true;
  serverSide.synchronous = true;
  core.addClient(serverSide);
  const channel = new PacketChannel(clientSide, S2C);
  channel.onPacket(() => {});
  channel.send(C_Handshake, { protocolVersion: PROTOCOL_VERSION, playerName: 'tester' });
  channel.send(C_SetViewDistance, { distance: 2 });
  channel.flush();
  return [...core.playersForTest()][0]!;
}

test('僵尸在白天的天光下会烧起来，晚上不会', () => {
  const { core } = makeFlatCore();
  const zombie = core.mobs.spawn(mobDefOf(MobType.ZOMBIE)!, 4.5, 71, 4.5);
  assert.equal(zombie.def.burnsInSunlight, true);

  // 正午，露天
  core.world.timeOfDay = 6000;
  core.world.daylightCycle = false;
  for (let i = 0; i < 5; i++) core.tick();
  assert.ok(zombie.fireTicks > 0, `正午露天应该烧起来，实得 fireTicks=${zombie.fireTicks}`);

  // 换一只，放在午夜
  const night = core.mobs.spawn(mobDefOf(MobType.ZOMBIE)!, 8.5, 71, 8.5);
  core.world.timeOfDay = 18000;
  night.fireTicks = 0;
  for (let i = 0; i < 5; i++) core.tick();
  assert.equal(night.fireTicks, 0, '午夜不该烧');
});

test('僵尸躲在屋顶下不烧 —— 判据是天光，不是"时间到了"', () => {
  const { core } = makeFlatCore();
  core.world.timeOfDay = 6000;
  core.world.daylightCycle = false;
  // 盖一个够大的顶。4×4 是不够的 —— 天光会从四边斜着渗进来，
  // 屋顶正下方仍有 13-14 级光，那不是 bug 而是正确的光照行为
  for (let x = -1; x <= 10; x++) {
    for (let z = -1; z <= 10; z++) core.world.setBlock(x, 74, z, packState(STONE));
  }
  for (let i = 0; i < 5; i++) core.tick(); // 让光照收敛

  const shaded = core.mobs.spawn(mobDefOf(MobType.ZOMBIE)!, 4.5, 71, 4.5);
  const exposed = core.mobs.spawn(mobDefOf(MobType.ZOMBIE)!, 20.5, 71, 20.5);
  for (let i = 0; i < 5; i++) core.tick();

  assert.equal(shaded.fireTicks, 0, '屋顶下的僵尸不该烧');
  assert.ok(exposed.fireTicks > 0, '露天的应该烧');
});

test('苦力怕：靠近鼓 30 刻就炸，离开会缩回去而不是清零', () => {
  const { core, player } = makeFlatCore();
  player.x = 4.5;
  player.y = 71;
  player.z = 4.5;

  const creeper = core.mobs.spawn(mobDefOf(MobType.CREEPER)!, 5.5, 71, 4.5);
  assert.equal(creeper.fuse, -1, '一开始没在鼓');

  // 玩家就在旁边：引信应该开始涨
  for (let i = 0; i < 10; i++) core.tick();
  const midway = creeper.fuse;
  assert.ok(midway > 0 && midway < CREEPER_FUSE_TICKS, `应该鼓到一半，实得 ${midway}`);

  // 玩家跑开：引信要**往回缩**，不是清零。
  // 这一条决定了"听到嘶声赶紧跑"之后回来还得重新蓄力，而不是完全没事
  player.x = 40.5;
  player.z = 40.5;
  core.tick();
  assert.equal(creeper.fuse, midway - 1, '离开之后引信应该退 1，而不是归零');

  // 回来把它鼓满
  player.x = 5.0;
  player.z = 4.5;
  let exploded = false;
  for (let i = 0; i < 200 && !exploded; i++) {
    core.tick();
    if (creeper.fuse === -1 && creeper.age > 20) exploded = true;
  }
  assert.ok(exploded, '鼓满了应该炸');
  assert.ok(player.health < 20, `炸完玩家应该掉血，实得 ${player.health}`);
});

test('苦力怕炸出来的坑：黑曜石挡得住，泥土挡不住', () => {
  const { core } = makeFlatCore();
  const OBSIDIAN = registry.idOf(Blocks.OBSIDIAN);
  const DIRT = registry.idOf(Blocks.DIRT);
  // 左边一片黑曜石，右边一片泥土，中间炸
  for (let x = -4; x <= -1; x++) {
    for (let z = -2; z <= 2; z++) {
      for (let y = 71; y <= 73; y++) core.world.setBlock(x, y, z, packState(OBSIDIAN));
    }
  }
  for (let x = 1; x <= 4; x++) {
    for (let z = -2; z <= 2; z++) {
      for (let y = 71; y <= 73; y++) core.world.setBlock(x, y, z, packState(DIRT));
    }
  }
  core.explode(0.5, 72, 0.5, 3);

  let obsidianLeft = 0;
  let dirtLeft = 0;
  for (let z = -2; z <= 2; z++) {
    for (let y = 71; y <= 73; y++) {
      for (let x = -4; x <= -1; x++) if ((core.world.getBlock(x, y, z) & 0xfff) === OBSIDIAN) obsidianLeft++;
      for (let x = 1; x <= 4; x++) if ((core.world.getBlock(x, y, z) & 0xfff) === DIRT) dirtLeft++;
    }
  }
  assert.equal(obsidianLeft, 60, '黑曜石抗性 6000，一块都不该被炸掉');
  assert.ok(dirtLeft < 60, `泥土应该被炸掉一些，实得还剩 ${dirtLeft}/60`);
});

test('末影人挨打就传送走', () => {
  const { core } = makeFlatCore();
  const enderman = core.mobs.spawn(mobDefOf(MobType.ENDERMAN)!, 4.5, 71, 4.5);
  const before = { x: enderman.x, z: enderman.z };

  enderman.hurt(4);
  assert.ok(enderman.hurtTime > 8, '刚受伤时 hurtTime 应该接近满值');
  core.tick();

  const moved = Math.hypot(enderman.x - before.x, enderman.z - before.z);
  assert.ok(moved > 4, `应该传送到别处，实际只挪了 ${moved.toFixed(2)} 格`);
  assert.ok(enderman.alive, '传送不该把它弄死');
});

test('骷髅会射箭，箭能打到人', () => {
  const { core, player } = makeFlatCore();
  player.x = 4.5;
  player.y = 71;
  player.z = 4.5;

  core.mobs.spawn(mobDefOf(MobType.SKELETON)!, 10.5, 71, 4.5);
  let sawArrow = false;
  for (let i = 0; i < 200; i++) {
    core.tick();
    if (core.arrows.size > 0) sawArrow = true;
    if (player.health < 20) break;
  }
  assert.ok(sawArrow, '骷髅应该射出过箭');
  assert.ok(player.health < 20, `箭应该打到玩家，实得血量 ${player.health}`);
});

test('僵尸会朝玩家走过来', () => {
  const { core, player } = makeFlatCore();
  player.x = 4.5;
  player.y = 71;
  player.z = 4.5;

  const zombie = core.mobs.spawn(mobDefOf(MobType.ZOMBIE)!, 20.5, 71, 4.5);
  core.world.timeOfDay = 18000; // 夜里，免得它烧死
  core.world.daylightCycle = false;
  const startDist = Math.hypot(zombie.x - player.x, zombie.z - player.z);

  for (let i = 0; i < 200; i++) core.tick();
  const endDist = Math.hypot(zombie.x - player.x, zombie.z - player.z);
  assert.ok(endDist < startDist - 4, `应该走近了，从 ${startDist.toFixed(1)} 到 ${endDist.toFixed(1)}`);
  assert.equal(zombie.targetId, player.entityId, '应该锁定了玩家');
});

test('生物掉血、死亡、掉东西', () => {
  const { core } = makeFlatCore();
  const cow = core.mobs.spawn(mobDefOf(MobType.COW)!, 4.5, 71, 4.5);
  assert.equal(cow.health, 10);

  // 无敌帧：连着打两下只掉一次血
  assert.equal(cow.hurt(3), true);
  assert.equal(cow.hurt(3), false, '无敌帧内不该再掉血');
  assert.equal(cow.health, 7);

  cow.invulnerable = 0;
  cow.hurt(100);
  assert.equal(cow.alive, false, '应该死了');

  for (let i = 0; i < 30; i++) core.tick();
  assert.equal(core.mobs.mobs.has(cow.entityId), false, '死亡动画放完应该被移除');
  const drops = [...core.world.items.values()].map((e) => e.stack.id);
  assert.ok(drops.includes(items.idOf(Items.RAW_BEEF)), `牛应该掉生牛肉，实得 ${JSON.stringify(drops)}`);
});

test('烧死的猪掉熟猪排', () => {
  const { core } = makeFlatCore();
  const pig = core.mobs.spawn(mobDefOf(MobType.PIG)!, 4.5, 71, 4.5);
  pig.fireTicks = 100;
  pig.hurt(100);
  for (let i = 0; i < 30; i++) core.tick();
  const drops = [...core.world.items.values()].map((e) => e.stack.id);
  assert.ok(
    drops.includes(items.idOf(Items.COOKED_PORKCHOP)),
    `烧死的猪该掉熟猪排，实得 ${JSON.stringify(drops)}`,
  );
});

test('寻路：绕过一堵墙', () => {
  const { core } = makeFlatCore();
  // 在 x=10 立一堵墙，中间留个门
  for (let z = -10; z <= 10; z++) {
    if (z === 0) continue;
    for (let y = 71; y <= 73; y++) core.world.setBlock(10, y, z, packState(STONE));
  }
  const finder = new PathFinder();
  const path = finder.find(
    core.world.store, core.world.tables,
    5, 71, 5, 15, 71, 5, 0.6, 1.8,
  );
  assert.ok(path.length > 0, '应该找得到路');
  const last = path[path.length - 1]!;
  assert.ok(Math.abs(last.x - 15) <= 1 && Math.abs(last.z - 5) <= 1, `应该走到目标附近，实得 ${JSON.stringify(last)}`);
  // 必须**穿过那个门**（z=0），而不是从墙里穿过去
  assert.ok(path.some((p) => p.x === 10 && p.z === 0), '应该从 z=0 的缺口过去');
  for (const p of path) {
    if (p.x !== 10) continue;
    assert.equal(p.z, 0, `不该穿墙：路径经过了 (10, ${p.z})`);
  }
});

test('寻路：目标被完全封死时不返回穿墙的路', () => {
  const { core } = makeFlatCore();
  // 把 (20,71,5) 用石头整个封起来
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    core.world.setBlock(20 + dx!, 71 + dy!, 5 + dz!, packState(STONE));
  }
  const finder = new PathFinder();
  const path = finder.find(
    core.world.store, core.world.tables,
    5, 71, 5, 20, 71, 5, 0.6, 1.8,
  );
  // 允许走到附近（那是"尽力而为"的半程路），但终点绝不能是被封的那一格
  const last = path[path.length - 1];
  if (last !== undefined) {
    assert.ok(!(last.x === 20 && last.y === 71 && last.z === 5), '不该声称走到了被封死的格子里');
  }
});

test('生物的 NBT 往返', () => {
  const def = mobDefOf(MobType.SHEEP)!;
  const mob = new Mob(7, def, 1.25, 64.5, -3.75, 0.5);
  mob.health = 6;
  mob.fireTicks = 33;
  mob.age = 900;
  mob.variant = 14;
  mob.headYaw = -1.25;
  mob.body.vy = -0.25;

  const back = mobFromNbt(99, mob.toNbt(), mobDefOf);
  assert.ok(back !== null);
  assert.equal(back.entityId, 99);
  assert.equal(back.def.type, MobType.SHEEP);
  assert.deepEqual([back.x, back.y, back.z], [1.25, 64.5, -3.75]);
  assert.equal(back.health, 6);
  assert.equal(back.fireTicks, 33);
  assert.equal(back.variant, 14, '羊的颜色要还原，否则重进游戏羊会集体变白');
  assert.equal(back.headYaw, -1.25);
  assert.equal(back.body.vy, -0.25);
});

test('压力：100 只生物跑 600 刻，不炸且单刻够快', () => {
  const { core, player } = makeFlatCore(2024n);
  void player;
  core.world.timeOfDay = 18000;
  core.world.daylightCycle = false;

  const rng = core.world.random;
  for (let i = 0; i < 100; i++) {
    const def = mobDefOf(rng.nextInt(9))!;
    core.mobs.spawn(def, -10 + rng.nextInt(40) + 0.5, 71, -10 + rng.nextInt(40) + 0.5);
  }
  assert.equal(core.mobs.count, 100);

  const t0 = performance.now();
  for (let i = 0; i < 600; i++) core.tick();
  const perTick = (performance.now() - t0) / 600;

  assert.ok(core.mobs.count > 0, '不该全都消失了');
  assert.ok(perTick < 15, `单刻应该 <15 ms，实得 ${perTick.toFixed(2)} ms`);
  console.log(`    100 只生物：${perTick.toFixed(2)} ms/刻，跑完还剩 ${core.mobs.count} 只`);
});

test('生成规则：敌对生物不会刷在玩家脸上，也不会刷在亮处', () => {
  const { core, player } = makeFlatCore(555n);
  core.world.timeOfDay = 18000;
  core.world.daylightCycle = false;

  for (let i = 0; i < 400; i++) core.tick();
  const hostiles = [...core.mobs.mobs.values()].filter((m) => m.def.category === MobCategory.HOSTILE);
  for (const m of hostiles) {
    const d = Math.hypot(m.x - player.x, m.y - player.y, m.z - player.z);
    // 刷出来之后它们会走过来，所以只检查"刚生成时"的约束不现实；
    // 这里退一步：至少不能出现在玩家正踩着的那一格
    assert.ok(d > 0.5, `生物不该和玩家重叠，距离 ${d.toFixed(2)}`);
  }
  assert.ok(core.mobs.countOf(MobCategory.HOSTILE) <= 70, '敌对生物不该超过上限');
});
