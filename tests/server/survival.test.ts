/**
 * 生存循环：饥饿曲线、坠落伤害表、护甲减伤公式、经验等级、死亡重生。
 *
 * 这几张表是玩家**已经内化**的常识：从多高跳下来会掉几颗心、穿一套铁甲
 * 能扛几下、一格面包能顶多久。数字错了不会崩，但整个游戏会"感觉不对"，
 * 而那种问题在几万行里最难定位。所以这里逐值断言。
 *
 * 经验等级曲线是个例外：1.3 之前的线性公式我没有原始源码可逐值核对，
 * 只能断言它的**性质**（线性、单调、0 升 1 需 10 点）。
 * docs/DEVIATIONS.md 里如实记了这一点。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerCore } from '../../src/server/server-core.ts';
import { createBlockRegistry, Blocks } from '../../src/content/blocks.ts';
import { createItemRegistry, Items } from '../../src/content/items.ts';
import { LoopbackTransport, PacketChannel } from '../../src/core/net/transport.ts';
import {
  S2C, C_Handshake, C_SetViewDistance, C_PlayerMove, PROTOCOL_VERSION,
} from '../../src/core/net/packets.ts';
import { packState, AIR_STATE } from '../../src/core/world/chunk.ts';
import { makeStack, XP_ORB_ITEM_ID } from '../../src/core/item/item-def.ts';
import {
  PlayerVitals, applyArmor, fallDamage, DamageKind,
} from '../../src/server/player/player-vitals.ts';
import { Experience, xpToNextLevel, totalXpForLevel, splitIntoOrbs } from '../../src/server/player/experience.ts';
import { damagePlayer, respawnPlayer } from '../../src/server/entity/combat.ts';

import {
  MAX_HUNGER, EXHAUSTION_PER_UNIT, REGEN_MIN_HUNGER, REGEN_INTERVAL,
} from '../../src/core/constants.ts';
import type { ServerPlayer } from '../../src/server/player/server-player.ts';

const registry = createBlockRegistry();
const items = createItemRegistry();
const STONE = registry.idOf(Blocks.STONE);

function makeRig(): { core: ServerCore; player: ServerPlayer; send: (p: unknown, v: Record<string, unknown>) => void } {
  const core = new ServerCore({ seed: 31n, registry });
  const [clientSide, serverSide] = LoopbackTransport.createPair();
  clientSide.synchronous = true;
  serverSide.synchronous = true;
  core.addClient(serverSide);
  const channel = new PacketChannel(clientSide, S2C);
  channel.onPacket(() => {});
  channel.send(C_Handshake, { protocolVersion: PROTOCOL_VERSION, playerName: 't' });
  channel.send(C_SetViewDistance, { distance: 2 });
  channel.flush();
  const player = [...core.eachPlayer()][0]!;
  for (let cx = -2; cx <= 2; cx++) {
    for (let cz = -2; cz <= 2; cz++) core.world.forceChunk(cx, cz);
  }
  // 一片干净的平地，免得地形里的水/岩浆/仙人掌插一脚
  for (let x = -20; x < 20; x++) {
    for (let z = -20; z < 20; z++) {
      core.world.setBlock(x, 70, z, packState(STONE));
      for (let y = 71; y < 100; y++) core.world.setBlock(x, y, z, AIR_STATE);
    }
  }
  player.x = 0.5;
  player.y = 71;
  player.z = 0.5;
  player.peakY = 71;
  player.onGround = true;
  core.tick();
  return {
    core, player,
    send: (p, v) => { channel.send(p as never, v as never); channel.flush(); },
  };
}

// ---------------------------------------------------------------------------
// 纯函数：可以逐值断言的那些
// ---------------------------------------------------------------------------

test('坠落伤害表：ceil(距离 − 3)，逐值对 MC', () => {
  // 距离 -> 伤害。这张表玩家背得比谁都熟：三格不掉血，
  // 二十三格摔死（20 点血）
  const table: [number, number][] = [
    [0, 0], [1, 0], [2, 0], [3, 0],
    [3.5, 1], [4, 1], [5, 2], [6, 3], [10, 7],
    [13, 10], [23, 20], [24, 21],
  ];
  for (const [distance, expected] of table) {
    assert.equal(fallDamage(distance), expected, `落 ${distance} 格该掉 ${expected} 点`);
  }
});

test('护甲减伤：输出 = 输入 × (25 − 点数) / 25', () => {
  // 无甲不减
  assert.equal(applyArmor(10, 0, DamageKind.PHYSICAL), 10);
  // 整套皮甲 7 点：10 × 18/25 = 7.2 -> 7
  assert.equal(applyArmor(10, 7, DamageKind.PHYSICAL), 7);
  // 整套铁甲 15 点：10 × 10/25 = 4
  assert.equal(applyArmor(10, 15, DamageKind.PHYSICAL), 4);
  // 整套钻甲 20 点：10 × 5/25 = 2，也就是减 80%
  assert.equal(applyArmor(10, 20, DamageKind.PHYSICAL), 2);
  // 超过 20 点不再更强
  assert.equal(applyArmor(10, 25, DamageKind.PHYSICAL), 2);
  // 至少掉 1 点 —— 否则满甲会变成完全免疫
  assert.equal(applyArmor(1, 20, DamageKind.PHYSICAL), 1);

  // 摔落与"无视护甲"的伤害不吃减免
  assert.equal(applyArmor(10, 20, DamageKind.FALL), 10, '1.0 里护甲挡不住摔落');
  assert.equal(applyArmor(10, 20, DamageKind.BYPASS_ARMOR), 10, '溺水/窒息/饿死无视护甲');
});

test('经验曲线：线性、单调、0 升 1 需要 10 点', () => {
  assert.equal(xpToNextLevel(0), 10);
  assert.equal(xpToNextLevel(1), 12);
  assert.equal(xpToNextLevel(10), 30);
  // 单调递增
  for (let l = 0; l < 60; l++) {
    assert.ok(xpToNextLevel(l + 1) > xpToNextLevel(l), `第 ${l} 级到 ${l + 1} 级的需求应该递增`);
  }
  // 线性：二阶差分恒为 0
  for (let l = 0; l < 50; l++) {
    const d1 = xpToNextLevel(l + 1) - xpToNextLevel(l);
    const d2 = xpToNextLevel(l + 2) - xpToNextLevel(l + 1);
    assert.equal(d2 - d1, 0, '1.3 之前的曲线是线性的，不是分段二次');
  }
  assert.equal(totalXpForLevel(0), 0);
  assert.equal(totalXpForLevel(1), 10);
  assert.equal(totalXpForLevel(3), 10 + 12 + 14);
});

test('经验累加会正确升级，且余数进到下一级', () => {
  const xp = new Experience();
  xp.add(10);
  assert.equal(xp.level, 1);
  assert.equal(xp.progress, 0);
  xp.add(5);
  assert.equal(xp.level, 1);
  assert.equal(xp.progress, 5);
  xp.add(7); // 12 需求，5+7=12 正好
  assert.equal(xp.level, 2);
  assert.equal(xp.progress, 0);

  // 一次给一大笔要能连升好几级
  const big = new Experience();
  big.add(1000);
  assert.ok(big.level > 20, `1000 点该升到 20 级以上，实得 ${big.level}`);
  assert.equal(big.total, 1000);
});

test('经验球按面额拆，不会拆成一堆 1', () => {
  assert.deepEqual(splitIntoOrbs(1), [1]);
  assert.deepEqual(splitIntoOrbs(5), [3, 1, 1]);
  assert.deepEqual(splitIntoOrbs(7), [7]);
  const hundred = splitIntoOrbs(100);
  assert.equal(hundred.reduce((a, b) => a + b, 0), 100, '总数要守恒');
  assert.ok(hundred.length <= 6, `100 点最多拆成几颗，实得 ${hundred.length} 颗`);
});

test('饥饿：消耗攒够 4.0 扣一格，先扣饱和再扣饥饿', () => {
  const v = new PlayerVitals();
  v.hunger = 20;
  v.saturation = 5;

  v.addExhaustion(EXHAUSTION_PER_UNIT - 0.01);
  assert.equal(v.saturation, 5, '没攒够就不扣');

  v.addExhaustion(0.01);
  assert.equal(v.saturation, 4, '攒够了先扣饱和');
  assert.equal(v.hunger, 20, '饱和还有就不动饥饿');

  // 把饱和耗光
  v.addExhaustion(EXHAUSTION_PER_UNIT * 4);
  assert.equal(v.saturation, 0);
  assert.equal(v.hunger, 20);

  v.addExhaustion(EXHAUSTION_PER_UNIT);
  assert.equal(v.hunger, 19, '饱和空了才扣饥饿');
});

test('吃东西：饥饿与饱和一起涨，饱和不超过饥饿', () => {
  const v = new PlayerVitals();
  v.hunger = 10;
  v.saturation = 0;
  // 面包：foodPoints 5，saturation 0.6 -> 饱和 +6，但被饥饿(15) 夹住
  v.eat(5, 0.6);
  assert.equal(v.hunger, 15);
  assert.equal(v.saturation, 6);

  // 吃到满
  v.eat(20, 1);
  assert.equal(v.hunger, MAX_HUNGER, '饥饿封顶 20');
  assert.ok(v.saturation <= v.hunger, '饱和不该超过饥饿');
});

// ---------------------------------------------------------------------------
// 接到世界上之后
// ---------------------------------------------------------------------------

test('饱食时会自然回血，且回血本身要花体力', () => {
  const { core, player } = makeRig();
  player.vitals.health = 10;
  player.vitals.hunger = MAX_HUNGER;
  player.vitals.saturation = 20;
  assert.ok(player.vitals.hunger >= REGEN_MIN_HUNGER);

  for (let i = 0; i < REGEN_INTERVAL + 2; i++) core.tick();
  assert.equal(player.vitals.health, 11, `${REGEN_INTERVAL} 刻该回 1 点血`);
  // 一次回血花 3.0 体力，而扣掉一格饱和需要攒满 4.0 ——
  // 所以**一次回血还不足以**让饱和掉一格，得两次
  assert.ok(player.vitals.exhaustion > 0, '回血要花体力');
  assert.equal(player.vitals.saturation, 20, '一次回血还没攒满 4.0，饱和不该掉');

  for (let i = 0; i < REGEN_INTERVAL + 2; i++) core.tick();
  assert.equal(player.vitals.health, 12, '再过一轮再回 1 点');
  assert.ok(player.vitals.saturation < 20, '两次回血攒够 4.0，饱和该掉了');
});

test('饥饿见底会掉到 1 血为止，不会真的饿死（普通难度）', () => {
  const { core, player } = makeRig();
  player.vitals.hunger = 0;
  player.vitals.saturation = 0;
  player.vitals.health = 20;

  for (let i = 0; i < 80 * 25; i++) core.tick();
  assert.equal(player.vitals.health, 1, `普通难度饿到 1 血为止，实得 ${player.vitals.health}`);
  assert.equal(player.vitals.dead, false);
});

test('掉进水里会憋气，憋完开始掉血', () => {
  const { core, player } = makeRig();
  // 把玩家埋进水里
  for (let y = 71; y <= 75; y++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        core.world.setBlock(dx, y, dz, packState(registry.idOf('water')));
      }
    }
  }
  player.y = 72;
  const startAir = player.vitals.air;
  for (let i = 0; i < 60; i++) core.tick();
  assert.ok(player.vitals.air < startAir, '在水里氧气该往下掉');

  player.vitals.air = 0;
  const hp = player.vitals.health;
  for (let i = 0; i < 100; i++) core.tick();
  assert.ok(player.vitals.health < hp, `憋完该掉血，实得 ${player.vitals.health}`);
});

test('岩浆里掉血更快，而且会着火', () => {
  const { core, player } = makeRig();
  core.world.setBlock(0, 71, 0, packState(registry.idOf('lava')));
  player.y = 71;
  for (let i = 0; i < 30; i++) core.tick();
  assert.ok(player.vitals.health < 20, '岩浆该掉血');
  assert.ok(player.vitals.fireTicks > 0, '该着火了');
});

test('摔落伤害由服务端判 —— 客户端只报位置', () => {
  const { core, player, send } = makeRig();
  // 客户端报"我在 y=100 空中"
  send(C_PlayerMove, {
    seq: 1, x: 0.5, y: 100, z: 0.5, yaw: 0, pitch: 0,
    onGround: false, sneaking: false, sprinting: false,
  });
  // 再报"我落地了"
  send(C_PlayerMove, {
    seq: 2, x: 0.5, y: 71, z: 0.5, yaw: 0, pitch: 0,
    onGround: true, sneaking: false, sprinting: false,
  });
  // 落差 29 -> ceil(29-3) = 26 -> 直接死
  assert.equal(player.vitals.dead, true, `落 29 格该摔死，实得血量 ${player.vitals.health}`);
  void core;
});

test('穿上盔甲真的减伤', () => {
  const { core, player } = makeRig();
  const before = player.vitals.health;
  damagePlayer(core, player, 10, 5, 5, DamageKind.PHYSICAL);
  const noArmor = before - player.vitals.health;

  // 换个人，穿整套铁甲
  const rig2 = makeRig();
  rig2.player.inventory.slots[0] = makeStack(items.idOf(Items.IRON_HELMET), 1);
  rig2.player.inventory.slots[1] = makeStack(items.idOf(Items.IRON_CHESTPLATE), 1);
  rig2.player.inventory.slots[2] = makeStack(items.idOf(Items.IRON_LEGGINGS), 1);
  rig2.player.inventory.slots[3] = makeStack(items.idOf(Items.IRON_BOOTS), 1);
  damagePlayer(rig2.core, rig2.player, 10, 5, 5, DamageKind.PHYSICAL);
  const withArmor = 20 - rig2.player.vitals.health;

  assert.equal(noArmor, 10, '无甲全额');
  assert.equal(withArmor, 4, '整套铁甲 15 点 -> 10 × 10/25 = 4');
});

test('死亡：背包撒一地、掉经验、等重生；重生回满血', () => {
  const { core, player } = makeRig();
  player.inventory.slots[10] = makeStack(items.idOf(Items.DIAMOND), 12);
  player.xp.add(200);
  const levelBefore = player.xp.level;
  assert.ok(levelBefore > 0);

  damagePlayer(core, player, 100, 5, 5, DamageKind.PHYSICAL);
  assert.equal(player.vitals.dead, true);
  assert.equal(player.awaitingRespawn, true, '该等着客户端请求重生');
  assert.equal(player.inventory.slots[10]!.count, 0, '背包该空了');
  assert.equal(player.xp.level, 0, '经验该清零');

  const dropped = [...core.world.items.values()];
  assert.ok(
    dropped.some((e) => e.stack.id === items.idOf(Items.DIAMOND)),
    '钻石该掉在地上',
  );
  assert.ok(
    dropped.some((e) => e.stack.id === XP_ORB_ITEM_ID),
    '该撒出经验球',
  );

  respawnPlayer(core, player);
  assert.equal(player.vitals.health, 20, '重生该满血');
  assert.equal(player.vitals.hunger, MAX_HUNGER, '重生该满饥饿');
  assert.equal(player.awaitingRespawn, false);
});

test('打死生物会掉经验球，捡起来能升级', () => {
  const { core, player } = makeRig();
  const zombie = core.mobs.spawnByName('zombie', 2.5, 71, 0.5)!;
  zombie.hurt(100);
  for (let i = 0; i < 30; i++) core.tick();

  const orbs = [...core.world.items.values()].filter((e) => e.stack.id === XP_ORB_ITEM_ID);
  assert.ok(orbs.length > 0, '僵尸该掉经验球');
  const totalXp = orbs.reduce((a, e) => a + e.stack.count, 0);
  assert.equal(totalXp, 5, '僵尸给 5 点经验');

  // 走过去捡
  player.x = 2.5;
  for (let i = 0; i < 60; i++) core.tick();
  assert.equal(player.xp.total, 5, `经验该进到玩家身上，实得 ${player.xp.total}`);
});

test('压力：生存 - 死亡 - 重生跑 2 万刻不出异常', () => {
  const { core, player } = makeRig();
  core.world.timeOfDay = 18000;
  core.world.daylightCycle = false;
  let deaths = 0;

  for (let i = 0; i < 20000; i++) {
    core.tick();
    // 每隔一阵子打自己一下，逼出死亡与重生这条路径
    if (i % 1500 === 0) damagePlayer(core, player, 25, 1, 1, DamageKind.PHYSICAL);
    if (player.awaitingRespawn) {
      respawnPlayer(core, player);
      deaths++;
    }
  }
  assert.ok(deaths >= 10, `该死过好几回，实得 ${deaths}`);
  assert.equal(player.vitals.dead, false, '最后应该活着');
  assert.ok(player.vitals.health > 0);
});

test('生存状态跟着 player.dat 一起存读', async () => {
  const { MemoryStorage } = await import('../../src/platform/storage.ts');
  const { WorldSave } = await import('../../src/server/save/world-save.ts');
  const { SaveController } = await import('../../src/server/save/save-controller.ts');

  const storage = new MemoryStorage();
  const a = makeRig();
  const ctrlA = new SaveController(a.core, new WorldSave(storage));
  a.player.vitals.health = 7;
  a.player.vitals.hunger = 11;
  a.player.vitals.saturation = 3;
  a.player.xp.add(150);
  const levelBefore = a.player.xp.level;
  await ctrlA.saveNow();

  const b = makeRig();
  const ctrlB = new SaveController(b.core, new WorldSave(storage));
  await ctrlB.loadLevel();
  assert.ok(ctrlB.restorePlayer(b.player), '该读到 player.dat');
  assert.equal(b.player.vitals.health, 7, '血量要还原 —— 否则退出重进就是回满血的免费药');
  assert.equal(b.player.vitals.hunger, 11);
  assert.equal(b.player.xp.level, levelBefore, '经验等级要还原');
});
