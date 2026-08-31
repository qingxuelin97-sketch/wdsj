/**
 * 末地与末影龙。**整个游戏的结局**，所以每一条规则都要能被玩家读出来。
 *
 * 这一战有三件事必须成立，缺一件整场战斗就说不通：
 *   1. 不拆水晶就打不死（否则第一阶段完全不存在）
 *   2. 拆完水晶打得死（否则玩家会以为自己漏了什么）
 *   3. 死了要给出口传送门和龙蛋（否则"通关"没有证据）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerCore } from '../../src/server/server-core.ts';
import { createBlockRegistry, Blocks } from '../../src/content/blocks.ts';
import { LoopbackTransport, PacketChannel } from '../../src/core/net/transport.ts';
import {
  S2C, C_Handshake, C_SetViewDistance, PROTOCOL_VERSION,
} from '../../src/core/net/packets.ts';
import { stateId } from '../../src/core/world/chunk.ts';
import { Dimension } from '../../src/core/world/dimension.ts';
import { MobType } from '../../src/content/mobs.ts';
import {
  EndGenerator, endPillars, END_GROUND_Y, END_ISLAND_RADIUS, END_PILLAR_COUNT,
} from '../../src/server/world/gen/end-gen.ts';
import {
  tickDragonFight, onDragonDeath, CRYSTAL_HEAL, CRYSTAL_HEAL_INTERVAL,
} from '../../src/server/entity/dragon.ts';
import { enterTheEnd } from '../../src/server/world/end-portal.ts';
import { WORLD_HEIGHT, CHUNK_SIZE } from '../../src/core/constants.ts';
import type { ServerPlayer } from '../../src/server/player/server-player.ts';
import type { Mob } from '../../src/server/entity/mob.ts';

const registry = createBlockRegistry();

function makeCore(): { core: ServerCore; player: ServerPlayer } {
  const core = new ServerCore({ seed: 42n, registry });
  core.randomTicks = false;
  core.mobs.naturalSpawning = false;
  const [c, s] = LoopbackTransport.createPair();
  c.synchronous = true;
  s.synchronous = true;
  core.addClient(s);
  const ch = new PacketChannel(c, S2C);
  ch.onPacket(() => {});
  ch.send(C_Handshake, { protocolVersion: PROTOCOL_VERSION, playerName: 't' });
  ch.send(C_SetViewDistance, { distance: 2 });
  ch.flush();
  return { core, player: [...core.eachPlayer()][0]! };
}

function dragonOf(core: ServerCore): Mob | undefined {
  return core.mobs.mobs.get(core.dragonFight.dragonId);
}

// --- 地形 ---

test('末地是一座悬空的岛：中间有地、外面是虚空', () => {
  const gen = new EndGenerator(42n, registry);
  // 中心必须有地
  const center = gen.generate(0, 0);
  let solid = 0;
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) if (stateId(center.getState(x, y, z)) !== 0) solid++;
    }
  }
  assert.ok(solid > 1000, `主岛中心只有 ${solid} 格实体`);

  // 远处必须是纯虚空
  const far = gen.generate(40, 40);
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        assert.equal(stateId(far.getState(x, y, z)), 0, `(40,40) 区块里 y=${y} 有东西`);
      }
    }
  }
});

test('岛是一块板，不是填到底的世界 —— 悬浮感全在这里', () => {
  const gen = new EndGenerator(42n, registry);
  const c = gen.generate(0, 0);
  // 地面之下若干格是空的（板的下方）
  let empties = 0;
  for (let y = 1; y < END_GROUND_Y - 30; y++) {
    if (stateId(c.getState(8, y, 8)) === 0) empties++;
  }
  assert.ok(empties > 20, `岛下面只有 ${empties} 格空气 —— 它被填到底了`);
});

test('十根黑曜石柱，位置只依赖种子', () => {
  const a = endPillars(42n);
  const b = endPillars(42n);
  assert.equal(a.length, END_PILLAR_COUNT);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, endPillars(43n));
  for (const p of a) {
    const r = Math.hypot(p.x, p.z);
    assert.ok(r > 20 && r < END_ISLAND_RADIUS, `柱子在 r=${r.toFixed(0)}，跑到岛外了`);
    assert.ok(p.height >= 30 && p.height < 60);
  }
});

test('柱子真的立起来了，柱顶是基岩', () => {
  const gen = new EndGenerator(42n, registry);
  const p = endPillars(42n)[0]!;
  const c = gen.generate(p.x >> 4, p.z >> 4);
  const lx = ((p.x % 16) + 16) % 16;
  const lz = ((p.z % 16) + 16) % 16;
  const top = END_GROUND_Y + p.height;
  assert.equal(stateId(c.getState(lx, top, lz)), registry.idOf(Blocks.OBSIDIAN), '柱身不是黑曜石');
  assert.equal(stateId(c.getState(lx, top + 1, lz)), registry.idOf(Blocks.BEDROCK), '柱顶不是基岩');
});

// --- 龙战 ---

test('进末地会摆好一条龙和十个水晶，且只摆一次', () => {
  const { core, player } = makeCore();
  enterTheEnd(core, player);
  assert.equal(player.dimension, Dimension.END);
  const dragon = dragonOf(core);
  assert.ok(dragon !== undefined, '没有龙');
  assert.equal(dragon.def.type, MobType.ENDER_DRAGON);
  assert.equal(core.dragonFight.crystals.size, END_PILLAR_COUNT);

  // 再进一次不该多出一条龙
  const before = core.mobs.mobs.size;
  enterTheEnd(core, player);
  assert.equal(core.mobs.mobs.size, before, '第二次进末地又摆了一套');
});

test('水晶坐在柱顶上，不悬在半空', () => {
  const { core, player } = makeCore();
  enterTheEnd(core, player);
  const pillars = endPillars(core.worldOf(Dimension.END).seed);
  const crystals = [...core.dragonFight.crystals]
    .map((id) => core.mobs.mobs.get(id)!)
    .filter((m) => m !== undefined);
  assert.equal(crystals.length, pillars.length);
  for (const p of pillars) {
    const match = crystals.find((c) => Math.abs(c.x - (p.x + 0.5)) < 0.01);
    assert.ok(match !== undefined, `柱子 (${p.x},${p.z}) 上没有水晶`);
    assert.ok(Math.abs(match.y - (END_GROUND_Y + p.height + 2)) < 0.01,
      `水晶在 y=${match.y}，柱顶在 ${END_GROUND_Y + p.height + 1}`);
  }
});

test('水晶还在时龙会回血 —— 这是"先拆水晶"这条规则的全部来源', () => {
  const { core, player } = makeCore();
  enterTheEnd(core, player);
  const dragon = dragonOf(core)!;
  dragon.health = 100;
  // 把一颗水晶挪到龙旁边，保证在治疗半径内
  const crystal = core.mobs.mobs.get([...core.dragonFight.crystals][0]!)!;
  crystal.body.x = dragon.x;
  crystal.body.z = dragon.z;
  const before = dragon.health;
  for (let i = 0; i < CRYSTAL_HEAL_INTERVAL * 4; i++) {
    crystal.body.x = dragon.x;
    crystal.body.z = dragon.z;
    tickDragonFight(core);
    dragon.age++;
  }
  assert.ok(dragon.health > before, `龙没回血：${before} -> ${dragon.health}`);
  assert.ok(dragon.health <= before + 4 * CRYSTAL_HEAL + 1,
    `一刻回了不止一次 —— 十个水晶一起照会让龙瞬间满血`);
});

test('水晶全炸掉之后龙不再回血', () => {
  const { core, player } = makeCore();
  enterTheEnd(core, player);
  const dragon = dragonOf(core)!;
  for (const id of [...core.dragonFight.crystals]) {
    const c = core.mobs.mobs.get(id)!;
    c.health = 0;
    c.die();
  }
  dragon.health = 50;
  for (let i = 0; i < 100; i++) {
    tickDragonFight(core);
    dragon.age++;
  }
  assert.equal(dragon.health, 50, '水晶都没了龙还在回血');
  assert.equal(core.dragonFight.crystals.size, 0);
});

test('龙会绕着岛飞，不会掉下去也不会飞出岛外', () => {
  const { core, player } = makeCore();
  enterTheEnd(core, player);
  const dragon = dragonOf(core)!;
  const seen = new Set<string>();
  for (let i = 0; i < 400; i++) {
    core.tick();
    if (!dragon.alive) break;
    seen.add(`${Math.round(dragon.x / 16)},${Math.round(dragon.z / 16)}`);
    assert.ok(dragon.y > END_GROUND_Y - 10, `龙掉到了 y=${dragon.y.toFixed(1)}`);
    assert.ok(Math.hypot(dragon.x, dragon.z) < END_ISLAND_RADIUS + 40,
      `龙飞出岛外 ${Math.hypot(dragon.x, dragon.z).toFixed(0)} 格`);
  }
  assert.ok(seen.size > 3, `龙一直待在原地（只去过 ${seen.size} 个区块）`);
});

test('龙死了：出口传送门、龙蛋、一大堆经验', () => {
  const { core, player } = makeCore();
  enterTheEnd(core, player);
  const dragon = dragonOf(core)!;
  onDragonDeath(core, dragon);

  const end = core.worldOf(Dimension.END);
  assert.equal(stateId(end.getBlock(0, END_GROUND_Y + 1, 0)), registry.idOf(Blocks.END_PORTAL),
    '没有出口传送门 —— 通关没有证据');
  assert.equal(stateId(end.getBlock(0, END_GROUND_Y + 4, 0)), registry.idOf(Blocks.DRAGON_EGG),
    '没有龙蛋');
  assert.equal(stateId(end.getBlock(3, END_GROUND_Y, 0)), registry.idOf(Blocks.BEDROCK),
    '出口平台不是基岩');
  assert.ok(core.dragonFight.finished);

  // 再调一次不该重复放
  const eggBefore = end.getBlock(0, END_GROUND_Y + 4, 0);
  onDragonDeath(core, dragon);
  assert.equal(end.getBlock(0, END_GROUND_Y + 4, 0), eggBefore);
});

test('龙的经验值配得上一场 BOSS 战', () => {
  const { core, player } = makeCore();
  enterTheEnd(core, player);
  const dragon = dragonOf(core)!;
  assert.equal(dragon.def.maxHealth, 200, '龙该是 200 血');
  assert.ok(dragon.def.xp >= 10000, `龙只给 ${dragon.def.xp} 经验，配不上结局`);
});

test('龙和水晶都有模型，客户端画得出来', async () => {
  const { mobModelOf } = await import('../../src/content/mob-models.ts');
  for (const type of [MobType.ENDER_DRAGON, MobType.ENDER_CRYSTAL]) {
    const m = mobModelOf(type);
    assert.ok(m !== null && m.boxes.length > 0, `type ${type} 没有模型`);
  }
  // 龙必须有轮廓，不能是一个方块
  const dragon = mobModelOf(MobType.ENDER_DRAGON)!;
  assert.ok(dragon.boxes.length >= 10, `龙只有 ${dragon.boxes.length} 个盒子，看着会像蝙蝠`);
});
