/**
 * 多人：两个客户端连同一个 ServerCore，互相看得见、互相影响。
 *
 * 能在 node 里跑，是因为 `ServerCore` 不含任何 Worker/DOM 依赖 ——
 * 这条从 M2 立下的规矩到这里才兑现全部价值：多人服务端与
 * 单人 worker 里跑的是**同一个对象**，两个 LoopbackTransport
 * 就是两个玩家。
 *
 * 跨维度不可见这一条特别要紧：坐标在三个维度里是重叠的，
 * 不筛维度的话主世界的人会看见站在下界同名坐标上的人 ——
 * 而那看起来像"有人在地下瞬移"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerCore } from '../../src/server/server-core.ts';
import { createBlockRegistry, Blocks } from '../../src/content/blocks.ts';
import { LoopbackTransport, PacketChannel } from '../../src/core/net/transport.ts';
import {
  S2C, C_Handshake, C_SetViewDistance, C_PlayerMove, C_Command, PROTOCOL_VERSION,
  SPAWN_MOB_STRIDE, MOB_MOVE_STRIDE, ENTITY_POS_SCALE,
} from '../../src/core/net/packets.ts';
import { packState, AIR_STATE, stateId } from '../../src/core/world/chunk.ts';
import { MobType } from '../../src/content/mobs.ts';
import { Dimension } from '../../src/core/world/dimension.ts';
import type { ServerPlayer } from '../../src/server/player/server-player.ts';

const registry = createBlockRegistry();
const STONE = packState(registry.idOf(Blocks.STONE));

interface Client {
  player: ServerPlayer;
  seen: { name: string; value: Record<string, unknown> }[];
  send: (p: unknown, v: Record<string, unknown>) => void;
  /** 这个客户端认识的实体：id -> 种类 */
  entities: Map<number, number>;
}

function makeWorld(): { core: ServerCore; join: (name: string) => Client } {
  const core = new ServerCore({ seed: 8n, registry });
  core.randomTicks = false;
  core.mobs.naturalSpawning = false;
  for (let cx = -2; cx <= 2; cx++) {
    for (let cz = -2; cz <= 2; cz++) core.world.forceChunk(cx, cz);
  }
  for (let x = -24; x < 24; x++) {
    for (let z = -24; z < 24; z++) {
      core.world.setBlock(x, 70, z, STONE);
      for (let y = 71; y < 90; y++) core.world.setBlock(x, y, z, AIR_STATE);
    }
  }

  const join = (name: string): Client => {
    const [c, s] = LoopbackTransport.createPair();
    c.synchronous = true;
    s.synchronous = true;
    core.addClient(s);
    const ch = new PacketChannel(c, S2C);
    const seen: { name: string; value: Record<string, unknown> }[] = [];
    const entities = new Map<number, number>();
    ch.onPacket((pname, value) => {
      seen.push({ name: pname, value });
      // 客户端侧的实体表：出生包加、销毁包减。断言看的就是它
      if (pname === 'S_SpawnMobs') {
        const b = value['entries'] as Uint8Array;
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        for (let o = 0; o + SPAWN_MOB_STRIDE <= b.byteLength; o += SPAWN_MOB_STRIDE) {
          entities.set(dv.getUint32(o, true), dv.getUint8(o + 4));
        }
      } else if (pname === 'S_DestroyEntities') {
        const b = value['entries'] as Uint8Array;
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        for (let o = 0; o + 4 <= b.byteLength; o += 4) entities.delete(dv.getUint32(o, true));
      }
    });
    ch.send(C_Handshake, { protocolVersion: PROTOCOL_VERSION, playerName: name });
    ch.send(C_SetViewDistance, { distance: 2 });
    ch.flush();
    const player = [...core.eachPlayer()].at(-1)!;
    player.x = 0.5;
    player.y = 71;
    player.z = 0.5;
    return {
      player, seen, entities,
      send: (p, v) => { ch.send(p as never, v as never); ch.flush(); },
    };
  };
  return { core, join };
}

test('两个玩家互相看得见，且看到的是 PLAYER 而不是别的', () => {
  const { core, join } = makeWorld();
  const a = join('a');
  const b = join('b');
  b.player.x = 4.5;
  b.player.z = 4.5;
  for (let i = 0; i < 3; i++) core.tick();

  assert.equal(a.entities.get(b.player.entityId), MobType.PLAYER, 'a 看不见 b');
  assert.equal(b.entities.get(a.player.entityId), MobType.PLAYER, 'b 看不见 a');
  // 不该看见自己
  assert.equal(a.entities.has(a.player.entityId), false, 'a 看见了自己');
  assert.equal(b.entities.has(b.player.entityId), false, 'b 看见了自己');
});

test('单人时一个玩家同步包都不发', () => {
  const { core, join } = makeWorld();
  const a = join('a');
  for (let i = 0; i < 5; i++) core.tick();
  a.seen.length = 0;
  for (let i = 0; i < 20; i++) core.tick();
  const spawnPackets = a.seen.filter((p) => p.name === 'S_SpawnMobs' || p.name === 'S_MobMoves');
  assert.equal(spawnPackets.length, 0, `单人还发了 ${spawnPackets.length} 个实体包`);
});

test('对方走动会发移动包，站着不动不发', () => {
  const { core, join } = makeWorld();
  const a = join('a');
  const b = join('b');
  b.player.x = 4.5;
  for (let i = 0; i < 3; i++) core.tick();

  a.seen.length = 0;
  b.player.x = 6.5;
  core.tick();
  const moves = a.seen.filter((p) => p.name === 'S_MobMoves');
  assert.equal(moves.length, 1, 'b 走了 a 却没收到移动包');
  // 位置对得上
  const bytes = moves[0]!.value['entries'] as Uint8Array;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(dv.getUint32(0, true), b.player.entityId);
  assert.equal(Math.round(dv.getInt32(4, true) / ENTITY_POS_SCALE * 10) / 10, 6.5);
  assert.equal(bytes.byteLength, MOB_MOVE_STRIDE);

  a.seen.length = 0;
  for (let i = 0; i < 10; i++) core.tick();
  assert.equal(a.seen.filter((p) => p.name === 'S_MobMoves').length, 0,
    'b 站着不动却一直在发移动包');
});

test('走远到订阅范围外就看不见了，走回来又能看见', () => {
  const { core, join } = makeWorld();
  const a = join('a');
  const b = join('b');
  for (let i = 0; i < 3; i++) core.tick();
  assert.ok(a.entities.has(b.player.entityId));

  // 挪到订阅半径（视距 2 -> 大约 40 格）之外
  b.player.x = 4000.5;
  b.player.z = 4000.5;
  for (let i = 0; i < 3; i++) core.tick();
  assert.equal(a.entities.has(b.player.entityId), false, 'b 走远了 a 还看得见');

  b.player.x = 2.5;
  b.player.z = 2.5;
  for (let i = 0; i < 3; i++) core.tick();
  assert.equal(a.entities.get(b.player.entityId), MobType.PLAYER, 'b 回来了 a 还看不见');
});

test('跨维度互相看不见 —— 坐标在三个维度里是重叠的', () => {
  const { core, join } = makeWorld();
  const a = join('a');
  const b = join('b');
  for (let i = 0; i < 3; i++) core.tick();
  assert.ok(a.entities.has(b.player.entityId));

  // b 去下界，坐标不变
  b.player.dimension = Dimension.NETHER;
  core.worldOf(Dimension.NETHER).forceChunk(0, 0);
  b.player.resetSubscriptions();
  for (let i = 0; i < 3; i++) core.tick();
  assert.equal(a.entities.has(b.player.entityId), false,
    'a 在主世界看见了站在下界同名坐标上的 b');
  assert.equal(b.entities.has(a.player.entityId), false);
});

test('有人下线，别人屏幕上不会留下一具躯壳', () => {
  const { core, join } = makeWorld();
  const a = join('a');
  const b = join('b');
  for (let i = 0; i < 3; i++) core.tick();
  assert.ok(a.entities.has(b.player.entityId));

  core.removePlayer(b.player);
  // removePlayer 里就该发销毁包，不必等下一 tick
  assert.equal(a.entities.has(b.player.entityId), false, 'b 下线了 a 还看得见他');
});

test('一个人放的方块另一个人收得到', () => {
  const { core, join } = makeWorld();
  join('a');
  const b = join('b');
  for (let i = 0; i < 3; i++) core.tick();
  b.seen.length = 0;
  core.world.setBlock(3, 71, 3, STONE);
  core.tick();
  const upd = b.seen.filter((p) => p.name === 'S_BlockUpdate');
  assert.equal(upd.length, 1, 'b 没收到方块更新');
  assert.equal(stateId(upd[0]!.value['state'] as number), registry.idOf(Blocks.STONE));
});

test('聊天所有人都收得到', () => {
  const { core, join } = makeWorld();
  const a = join('a');
  const b = join('b');
  for (let i = 0; i < 3; i++) core.tick();
  a.seen.length = 0;
  b.seen.length = 0;
  a.send(C_Command, { requestId: 1, text: 'say 你好' });
  core.tick();
  assert.ok(b.seen.some((p) => p.name === 'S_Chat' && String(p.value['text']).includes('你好')),
    'b 没收到聊天');
});

test('两个玩家各有自己的物品栏，互不串', () => {
  const { join } = makeWorld();
  const a = join('a');
  const b = join('b');
  void a;
  a.player.inventory.held.id = 1;
  a.player.inventory.held.count = 5;
  assert.equal(b.player.inventory.held.count, 0, '两个玩家共用了物品栏');
  assert.notEqual(a.player.entityId, b.player.entityId, '两个玩家拿到了同一个实体 id');
});

test('十个玩家同时在线，实体 id 不重号', () => {
  const { core, join } = makeWorld();
  const ids = new Set<number>();
  for (let i = 0; i < 10; i++) {
    const c = join(`p${i}`);
    c.player.x = i * 3 + 0.5;
    assert.equal(ids.has(c.player.entityId), false, `第 ${i} 个玩家的 id 重了`);
    ids.add(c.player.entityId);
  }
  for (let i = 0; i < 5; i++) core.tick();
  assert.equal([...core.eachPlayer()].length, 10);
});

test('玩家移动包会被服务端接受并广播出去', () => {
  const { core, join } = makeWorld();
  const a = join('a');
  const b = join('b');
  for (let i = 0; i < 3; i++) core.tick();
  a.seen.length = 0;
  b.send(C_PlayerMove, {
    seq: 1, x: 8.5, y: 71, z: 8.5, yaw: 1.5, pitch: 0, onGround: true, sneak: false, sprint: false,
  });
  core.tick();
  assert.ok(Math.abs(b.player.x - 8.5) < 0.01, '服务端没收下 b 的位置');
  assert.ok(a.seen.some((p) => p.name === 'S_MobMoves'), 'b 移动了 a 没收到');
});
