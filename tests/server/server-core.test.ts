/**
 * ServerCore 验收。
 *
 * 这是整个验证体系的地基：ServerCore 不含 Worker / DOM / 定时器依赖，
 * 所以这里能直接 new 出来、挂 loopback 客户端、手动驱动 tick，
 * 在 node 里完整验证服务端行为，一个浏览器都不需要。
 *
 * 后续里程碑（光照、红石、流体、AI、容器、伤害）的验收都会挂在这个模式上。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerCore } from '../../src/server/server-core.ts';
import { createBlockRegistry } from '../../src/content/blocks.ts';
import { LoopbackTransport, PacketChannel } from '../../src/core/net/transport.ts';
import { S2C, C_Handshake, C_PlayerMove, C_PlayerAction, C_Command, C_SetViewDistance, PROTOCOL_VERSION, PlayerActionKind } from '../../src/core/net/packets.ts';
import { decodeChunk } from '../../src/core/world/chunk-codec.ts';
import { AIR_STATE, packState, stateId } from '../../src/core/world/chunk.ts';

const registry = createBlockRegistry();

/** 测试用的极简客户端：记录收到的所有包 */
class TestClient {
  readonly channel: PacketChannel;
  readonly received: { name: string; value: Record<string, unknown> }[] = [];

  constructor(transport: LoopbackTransport) {
    // 同步投递，测试里才能"tick 完立刻断言"，不必到处 await
    transport.synchronous = true;
    this.channel = new PacketChannel(transport, S2C);
    this.channel.onPacket((name, value) => this.received.push({ name, value }));
  }

  of(name: string): Record<string, unknown>[] {
    return this.received.filter((p) => p.name === name).map((p) => p.value);
  }

  last(name: string): Record<string, unknown> | undefined {
    for (let i = this.received.length - 1; i >= 0; i--) {
      if (this.received[i]!.name === name) return this.received[i]!.value;
    }
    return undefined;
  }

  clear(): void {
    this.received.length = 0;
  }
}

/** 建一个服务端 + 一个已握手的客户端 */
function makePair(seed = 1234n, viewDistance = 2): { server: ServerCore; client: TestClient; playerId: number } {
  const server = new ServerCore({ seed, registry });
  const [clientSide, serverSide] = LoopbackTransport.createPair();
  clientSide.synchronous = true;
  serverSide.synchronous = true;
  const player = server.addClient(serverSide);
  const client = new TestClient(clientSide);
  client.channel.send(C_Handshake, { protocolVersion: PROTOCOL_VERSION, playerName: 'tester' });
  // 默认用小视距：测试关心的是行为不是规模，视距 8 会让每个用例多生成上百个区块
  client.channel.send(C_SetViewDistance, { distance: viewDistance });
  client.channel.flush();
  return { server, client, playerId: player.entityId };
}

test('直接 new ServerCore 并跑 200 tick，不需要任何浏览器', () => {
  const server = new ServerCore({ seed: 1234n, registry });
  for (let i = 0; i < 200; i++) server.tick();
  assert.equal(server.tickNumber, 200);
  assert.equal(server.world.worldAge, 200);
  assert.equal(server.playerCount, 0);
});

test('握手后收到 S_Login，出生点合法', () => {
  const { client } = makePair();
  const login = client.last('S_Login');
  assert.ok(login !== undefined, '没有收到 S_Login');
  assert.equal(login!['dimension'], 0);
  assert.equal(login!['seed'], 1234n);
  assert.ok((login!['spawnY'] as number) > 0, '出生点 y 应为正');
  assert.ok(client.last('S_Chat') !== undefined, '应收到欢迎消息');
});

test('协议版本不匹配会被拒绝', () => {
  const server = new ServerCore({ seed: 1n, registry });
  const [clientSide, serverSide] = LoopbackTransport.createPair();
  clientSide.synchronous = true;
  serverSide.synchronous = true;
  server.addClient(serverSide);
  const client = new TestClient(clientSide);
  client.channel.send(C_Handshake, { protocolVersion: PROTOCOL_VERSION + 99, playerName: 'x' });
  client.channel.flush();

  const dis = client.last('S_Disconnect');
  assert.ok(dis !== undefined, '版本不匹配应被断开');
  assert.match(String(dis!['reason']), /协议版本不匹配/);
  assert.equal(server.playerCount, 0, '被拒绝的客户端不应留在玩家列表里');
});

test('区块被推送给玩家，且内容可解码', () => {
  const { server, client } = makePair();
  // 视距调小，让推送快点收敛
  client.channel.send(C_SetViewDistance, { distance: 2 });
  client.channel.flush();
  for (let i = 0; i < 40; i++) server.tick();

  const chunks = client.of('S_ChunkData');
  assert.ok(chunks.length >= 10, `只推送了 ${chunks.length} 个区块`);

  // 随便挑一个解码，验证不是空壳
  const c = chunks[0]!;
  const chunk = decodeChunk(c['cx'] as number, c['cz'] as number, c['blob'] as Uint8Array);
  let nonAir = 0;
  for (let y = 0; y < 128; y += 4) {
    for (let z = 0; z < 16; z += 4) {
      for (let x = 0; x < 16; x += 4) if (chunk.getState(x, y, z) !== AIR_STATE) nonAir++;
    }
  }
  assert.ok(nonAir > 0, '推送的区块里一个方块都没有');
});

test('区块推送有节流，不会一 tick 全发完', () => {
  const { server, client } = makePair();
  client.channel.send(C_SetViewDistance, { distance: 4 });
  client.channel.flush();
  client.clear();
  server.tick();
  const firstTick = client.of('S_ChunkData').length;
  assert.ok(firstTick > 0, '第一 tick 应该开始推送');
  assert.ok(firstTick <= 4, `一 tick 推了 ${firstTick} 个区块，节流没生效`);
});

test('玩家跨区块移动会推送新区块并卸载旧区块', () => {
  const { server, client } = makePair();
  client.channel.send(C_SetViewDistance, { distance: 2 });
  client.channel.flush();
  for (let i = 0; i < 60; i++) server.tick();
  client.clear();

  // 移动到很远的地方
  client.channel.send(C_PlayerMove, {
    seq: 1, x: 800, y: 80, z: 800, yaw: 0, pitch: 0,
    onGround: true, sneaking: false, sprinting: false,
  });
  client.channel.flush();
  for (let i = 0; i < 60; i++) server.tick();

  assert.ok(client.of('S_ChunkUnload').length > 0, '远离后应收到卸载包');
  assert.ok(client.of('S_ChunkData').length > 0, '到达新区域后应收到新区块');
});

test('挖掉方块会广播 S_BlockUpdate', () => {
  const { server, client } = makePair();
  for (let i = 0; i < 40; i++) server.tick();

  // 找一个玩家附近的实心方块
  const login = client.last('S_Login')!;
  const px = Math.floor(login['spawnX'] as number);
  const pz = Math.floor(login['spawnZ'] as number);
  const py = Math.floor(login['spawnY'] as number);
  let target: [number, number, number] | null = null;
  for (let y = py; y > py - 6 && target === null; y--) {
    if (server.world.getBlock(px, y, pz) !== AIR_STATE) target = [px, y, pz];
  }
  assert.ok(target !== null, '玩家脚下应该有方块');

  client.clear();
  client.channel.send(C_PlayerAction, {
    action: PlayerActionKind.FINISH_DIG,
    x: target![0], y: target![1], z: target![2], face: 1,
  });
  client.channel.flush();
  server.tick();

  const update = client.last('S_BlockUpdate');
  assert.ok(update !== undefined, '挖掉方块后应收到 S_BlockUpdate');
  assert.equal(update!['state'], AIR_STATE);
  assert.equal(server.world.getBlock(target![0], target![1], target![2]), AIR_STATE);
});

test('挖掘有触及距离检查，够不着的方块动不了', () => {
  const { server, client } = makePair();
  for (let i = 0; i < 40; i++) server.tick();
  const login = client.last('S_Login')!;
  const far: [number, number, number] = [Math.floor(login['spawnX'] as number) + 40, 70, Math.floor(login['spawnZ'] as number)];
  server.world.ensureChunk(far[0] >> 4, far[2] >> 4);
  const before = server.world.getBlock(far[0], far[1], far[2]);

  client.channel.send(C_PlayerAction, { action: PlayerActionKind.FINISH_DIG, x: far[0], y: far[1], z: far[2], face: 1 });
  client.channel.flush();
  server.tick();
  assert.equal(server.world.getBlock(far[0], far[1], far[2]), before, '超出触及距离的方块不该被改动');
});

test('基岩挖不动', () => {
  const { server, client } = makePair();
  for (let i = 0; i < 40; i++) server.tick();
  const login = client.last('S_Login')!;
  const px = Math.floor(login['spawnX'] as number);
  const pz = Math.floor(login['spawnZ'] as number);
  // 把玩家传到基岩边上，绕开触及检查
  client.channel.send(C_PlayerMove, { seq: 1, x: px + 0.5, y: 2, z: pz + 0.5, yaw: 0, pitch: 0, onGround: true, sneaking: false, sprinting: false });
  client.channel.send(C_PlayerAction, { action: PlayerActionKind.FINISH_DIG, x: px, y: 0, z: pz, face: 1 });
  client.channel.flush();
  server.tick();
  assert.notEqual(server.world.getBlock(px, 0, pz), AIR_STATE, '基岩不该被挖掉');
});

test('指令通道可用 —— 这是 __mc 驱动世界的途径', () => {
  const { server, client } = makePair();
  for (let i = 0; i < 40; i++) server.tick();
  const px = Math.floor((client.last('S_Login')!['spawnX'] as number));
  const pz = Math.floor((client.last('S_Login')!['spawnZ'] as number));

  client.clear();
  client.channel.send(C_Command, { requestId: 7, text: `setblock ${px} 80 ${pz} glass` });
  client.channel.flush();
  server.tick();

  const res = client.last('S_CommandResult');
  assert.ok(res !== undefined, '应收到指令回执');
  assert.equal(res!['requestId'], 7);
  assert.equal(res!['ok'], true, `setblock 失败: ${res!['text']}`);
  assert.equal(stateId(server.world.getBlock(px, 80, pz)), registry.idOf('glass'));

  // getblock 应读回同一个方块
  client.channel.send(C_Command, { requestId: 8, text: `getblock ${px} 80 ${pz}` });
  client.channel.flush();
  server.tick();
  const res2 = client.of('S_CommandResult').find((r) => r['requestId'] === 8);
  assert.equal(res2?.['text'], 'glass');
});

test('时间按 20 TPS 推进并周期广播', () => {
  const { server, client } = makePair();
  client.clear();
  for (let i = 0; i < 60; i++) server.tick();
  assert.equal(server.world.worldAge, 60);
  const times = client.of('S_TimeUpdate');
  assert.equal(times.length, 3, `60 tick 应广播 3 次时间，实得 ${times.length}`);
  assert.equal(times[2]!['worldAge'], 60n);
});

test('未知指令与坏参数不会让服务端崩', () => {
  const { server, client } = makePair();
  for (const text of ['nonsense', 'setblock', 'setblock a b c d', 'setblock 0 80 0 不存在的方块', '']) {
    client.channel.send(C_Command, { requestId: 1, text });
    client.channel.flush();
    server.tick();
  }
  assert.ok(server.tickNumber > 0, '服务端应当还活着');
  const results = client.of('S_CommandResult');
  assert.ok(results.some((r) => r['ok'] === false), '坏指令应返回失败而不是抛异常');
});

test('长跑 20000 tick：无异常、时间正确回绕、内存不失控', () => {
  const { server, client } = makePair();
  client.channel.send(C_SetViewDistance, { distance: 2 });
  client.channel.flush();

  for (let i = 0; i < 20000; i++) {
    server.tick();
    // 每 500 tick 让玩家动一下，触发区块加载/卸载的完整循环
    if (i % 500 === 0) {
      const angle = (i / 500) * 0.7;
      client.channel.send(C_PlayerMove, {
        seq: i, x: Math.cos(angle) * 300, y: 80, z: Math.sin(angle) * 300,
        yaw: 0, pitch: 0, onGround: true, sneaking: false, sprinting: false,
      });
      client.channel.flush();
    }
    // 客户端不能无限攒包，否则测的是数组增长而不是服务端
    if (client.received.length > 5000) client.clear();
  }

  assert.equal(server.tickNumber, 20000);
  // 20000 tick = 1000 秒，昼夜周期 24000 tick
  assert.equal(server.world.timeOfDay, 20000 % 24000);
  // 视距 2 时可见区块约 13 个，加上一点余量；远超说明卸载没生效
  assert.ok(server.world.loadedCount < 200, `跑完还有 ${server.world.loadedCount} 个区块驻留，卸载可能没生效`);
});
