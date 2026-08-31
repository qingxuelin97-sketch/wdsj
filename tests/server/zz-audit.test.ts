import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerCore } from '../../src/server/server-core.ts';
import { createBlockRegistry } from '../../src/content/blocks.ts';
import { MemoryStorage } from '../../src/platform/storage.ts';
import { WorldSave } from '../../src/server/save/world-save.ts';
import { SaveController } from '../../src/server/save/save-controller.ts';
import { LoopbackTransport, PacketChannel } from '../../src/core/net/transport.ts';
import { S2C, C_Handshake, C_SetViewDistance, PROTOCOL_VERSION } from '../../src/core/net/packets.ts';
import { Dimension } from '../../src/core/world/dimension.ts';
import type { ServerPlayer } from '../../src/server/player/server-player.ts';

const registry = createBlockRegistry();

interface Rig { core: ServerCore; save: WorldSave; controller: SaveController; player: ServerPlayer }

async function makeRig(storage: MemoryStorage, seed = 4242n, name = 'tester'): Promise<Rig> {
  const core = new ServerCore({ seed, registry });
  const save = new WorldSave(storage);
  const controller = new SaveController(core, save);
  await controller.loadLevel();
  const [clientSide, serverSide] = LoopbackTransport.createPair();
  clientSide.synchronous = true;
  serverSide.synchronous = true;
  core.addClient(serverSide);
  const channel = new PacketChannel(clientSide, S2C);
  channel.onPacket(() => {});
  channel.send(C_Handshake, { protocolVersion: PROTOCOL_VERSION, playerName: name });
  channel.send(C_SetViewDistance, { distance: 2 });
  channel.flush();
  const player = [...core.eachPlayer()][0]!;
  return { core, save, controller, player };
}

async function tickAsync(core: ServerCore, count: number): Promise<void> {
  for (let i = 0; i < count; i++) { core.tick(); await Promise.resolve(); }
}

test('AUDIT: 下界的生物存读之后还在下界', async () => {
  const storage = new MemoryStorage();
  const a = await makeRig(storage);
  await tickAsync(a.core, 20);

  const nether = a.core.worldOf(Dimension.NETHER);
  nether.forceChunk(0, 0);
  const pig = a.core.mobs.spawnByName('pig', 6.5, 40, 6.5, Dimension.NETHER)!;
  pig.health = 7;
  assert.equal(pig.dimension, Dimension.NETHER);
  const rep = await a.controller.saveNow();
  console.log('saved chunks', rep.chunks);

  const b = await makeRig(storage);
  const netherB = b.core.worldOf(Dimension.NETHER);
  for (let i = 0; i < 80 && !netherB.areaReadyForForce(6, 6, 1); i++) await Promise.resolve();
  netherB.forceChunk(0, 0);
  const restored = [...b.core.mobs.mobs.values()];
  console.log('restored mobs:', restored.map((m) => `${m.def.name} dim=${m.dimension} hp=${m.health} @${m.x},${m.y},${m.z}`));
  assert.equal(restored.length, 1, '猪应该回来');
  assert.equal(restored[0]!.dimension, Dimension.NETHER, '<<<< 生物读回来时维度丢了');
});

test('AUDIT: 打完龙、重开、再进末地 —— 龙不该复活', async () => {
  const storage = new MemoryStorage();
  const a = await makeRig(storage);
  await tickAsync(a.core, 5);
  const { enterTheEnd } = await import('../../src/server/world/end-portal.ts');
  const { onDragonDeath } = await import('../../src/server/entity/dragon.ts');
  const end = a.core.worldOf(Dimension.END);
  for (let i = 0; i < 80 && !end.areaReadyForForce(0, 0, 1); i++) await Promise.resolve();
  assert.ok(enterTheEnd(a.core, a.player), '应该进得去末地');
  assert.ok(a.core.dragonFight.dragonId >= 0, '应该有一条龙');
  const dragon = a.core.mobs.mobs.get(a.core.dragonFight.dragonId)!;
  onDragonDeath(a.core, dragon);
  a.core.mobs.removeAll('ender_dragon');
  assert.ok(a.core.dragonFight.finished, '龙战应该结束了');
  await a.controller.saveNow();

  const b = await makeRig(storage);
  await tickAsync(b.core, 5);
  const endB = b.core.worldOf(Dimension.END);
  for (let i = 0; i < 80 && !endB.areaReadyForForce(0, 0, 1); i++) await Promise.resolve();
  assert.ok(enterTheEnd(b.core, b.player));
  console.log('读档后 dragonFight:', JSON.stringify({
    dragonId: b.core.dragonFight.dragonId,
    finished: b.core.dragonFight.finished,
    crystals: b.core.dragonFight.crystals.size,
  }));
  assert.equal(b.core.dragonFight.dragonId, -1, '<<<< 龙复活了');
});
