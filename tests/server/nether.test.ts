/**
 * 下界：地形生成、传送门点火、1:8 传送、回程。
 *
 * 传送门是整个游戏里**跨系统最多**的一条链：物品（打火石）→ 方块几何
 * （黑曜石框）→ 维度（第二个 ServerWorld）→ 坐标换算 → 区块流送 →
 * 客户端镜像重建。任何一环断了，症状都是"掉进虚空"或者"卡在原地"，
 * 而中间那些步骤在浏览器里全都看不见。所以这里在 node 里逐步验。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerCore } from '../../src/server/server-core.ts';
import { createBlockRegistry, Blocks } from '../../src/content/blocks.ts';
import { LoopbackTransport, PacketChannel } from '../../src/core/net/transport.ts';
import { S2C, C_Handshake, C_SetViewDistance, PROTOCOL_VERSION } from '../../src/core/net/packets.ts';
import { packState, stateId, AIR_STATE } from '../../src/core/world/chunk.ts';
import { Dimension, convertCoords } from '../../src/core/world/dimension.ts';
import { buildPortalPlan } from '../../src/core/world/portal.ts';
import {
  ignitePortal, tickPortal, PORTAL_DWELL_TICKS,
} from '../../src/server/world/portal-manager.ts';
import { NetherGenerator, NETHER_LAVA_LEVEL } from '../../src/server/world/gen/nether-gen.ts';
import { WORLD_HEIGHT, CHUNK_SIZE } from '../../src/core/constants.ts';
import type { ServerPlayer } from '../../src/server/player/server-player.ts';

const registry = createBlockRegistry();
const OBSIDIAN = packState(registry.idOf(Blocks.OBSIDIAN));
const PORTAL = registry.idOf(Blocks.NETHER_PORTAL);
const STONE = packState(registry.idOf(Blocks.STONE));

interface Rig {
  core: ServerCore;
  player: ServerPlayer;
  /** 客户端收到的包，按名字计数 */
  seen: { name: string; value: Record<string, unknown> }[];
}

function makeRig(): Rig {
  const core = new ServerCore({ seed: 77n, registry });
  const [clientSide, serverSide] = LoopbackTransport.createPair();
  clientSide.synchronous = true;
  serverSide.synchronous = true;
  core.addClient(serverSide);
  const channel = new PacketChannel(clientSide, S2C);
  const seen: { name: string; value: Record<string, unknown> }[] = [];
  channel.onPacket((name, value) => { seen.push({ name, value }); });
  channel.send(C_Handshake, { protocolVersion: PROTOCOL_VERSION, playerName: 't' });
  channel.send(C_SetViewDistance, { distance: 2 });
  channel.flush();
  const player = [...core.eachPlayer()][0]!;
  // 随机刻与生物会让世界自己变，逐格断言就没法做了
  core.randomTicks = false;
  for (let cx = -2; cx <= 2; cx++) {
    for (let cz = -2; cz <= 2; cz++) core.world.forceChunk(cx, cz);
  }
  for (let x = -16; x < 16; x++) {
    for (let z = -16; z < 16; z++) {
      core.world.setBlock(x, 70, z, STONE);
      for (let y = 71; y < 90; y++) core.world.setBlock(x, y, z, AIR_STATE);
    }
  }
  player.x = 0.5;
  player.y = 71;
  player.z = 0.5;
  core.tick();
  return { core, player, seen };
}

/** 在主世界 (x0,71,z0) 处砌一座门的框 */
function buildFrame(core: ServerCore, x0: number, z0: number): void {
  for (const c of buildPortalPlan('x', x0, 71, z0).frame) {
    core.world.setBlock(c.x, c.y, c.z, OBSIDIAN);
  }
}

// --- 地形 ---

test('下界地形：有天花板、有岩浆海、走得进去', () => {
  const gen = new NetherGenerator(77n, registry);
  const counts = new Map<number, number>();
  let air = 0;
  let total = 0;
  for (let cx = 0; cx < 2; cx++) {
    for (let cz = 0; cz < 2; cz++) {
      const c = gen.generate(cx, cz);
      // 顶与底必须是基岩，否则玩家能从下界掉出世界
      for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
          assert.notEqual(stateId(c.getState(x, 0, z)), 0, '下界的地板漏了');
          assert.notEqual(stateId(c.getState(x, WORLD_HEIGHT - 1, z)), 0, '下界的天花板漏了');
        }
      }
      for (let y = 0; y < WORLD_HEIGHT; y++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
          for (let x = 0; x < CHUNK_SIZE; x++) {
            const id = stateId(c.getState(x, y, z));
            counts.set(id, (counts.get(id) ?? 0) + 1);
            if (id === 0) air++;
            total++;
          }
        }
      }
    }
  }
  // 至少两成是空气 —— 走不进去的下界等于没做。
  // （第一版把偏置写反了，结果只有 9.7% 空气，整个维度是块实心砖）
  assert.ok(air / total > 0.2, `下界只有 ${(100 * air / total).toFixed(1)}% 空气，走不进去`);
  assert.ok(air / total < 0.7, `下界有 ${(100 * air / total).toFixed(1)}% 空气，太空了`);
  const has = (name: string): number => counts.get(registry.idOf(name)) ?? 0;
  assert.ok(has(Blocks.NETHERRACK) > total * 0.2, '地狱岩太少');
  assert.ok(has(Blocks.LAVA) > 0, '没有岩浆海');
  assert.ok(has(Blocks.GLOWSTONE) > 0, '没有萤石 —— 下界会是纯黑的');
});

test('岩浆海面在 31，上面没有岩浆悬空', () => {
  const gen = new NetherGenerator(77n, registry);
  const c = gen.generate(3, -2);
  const lava = registry.idOf(Blocks.LAVA);
  for (let y = NETHER_LAVA_LEVEL + 1; y < WORLD_HEIGHT; y++) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        assert.notEqual(stateId(c.getState(x, y, z)), lava,
          `岩浆出现在 y=${y}，海面应该是 ${NETHER_LAVA_LEVEL}`);
      }
    }
  }
});

test('下界生成是确定的：同种子同坐标逐格相同', () => {
  const a = new NetherGenerator(77n, registry).generate(5, -3);
  const b = new NetherGenerator(77n, registry).generate(5, -3);
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        assert.equal(a.getState(x, y, z), b.getState(x, y, z), `(${x},${y},${z}) 不一致`);
      }
    }
  }
});

test('不同种子生成不同地形', () => {
  const a = new NetherGenerator(1n, registry).generate(0, 0);
  const b = new NetherGenerator(2n, registry).generate(0, 0);
  let diff = 0;
  for (let y = 8; y < WORLD_HEIGHT - 8; y++) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) if (a.getState(x, y, z) !== b.getState(x, y, z)) diff++;
    }
  }
  assert.ok(diff > 1000, `两个种子只差 ${diff} 格 —— salt 可能没接上`);
});

// --- 传送门 ---

test('点火成门：六格内部全变成传送门方块', () => {
  const { core } = makeRig();
  buildFrame(core, 4, 4);
  const r = ignitePortal(core, core.world, 4, 71, 4);
  assert.equal(r.lit, true, '标准框点不着');
  assert.equal(r.cells, 6);
  for (let w = 0; w < 2; w++) {
    for (let h = 0; h < 3; h++) {
      assert.equal(stateId(core.world.getBlock(4 + w, 71 + h, 4)), PORTAL,
        `(${4 + w},${71 + h},4) 不是门`);
    }
  }
});

test('没有框的地方点不着门', () => {
  const { core } = makeRig();
  assert.equal(ignitePortal(core, core.world, 4, 71, 4).lit, false);
});

test('站进去 4 秒才走，不到时间不走', () => {
  const { core, player } = makeRig();
  buildFrame(core, 4, 4);
  ignitePortal(core, core.world, 4, 71, 4);
  player.x = 4.5;
  player.y = 71;
  player.z = 4.5;
  for (let i = 0; i < PORTAL_DWELL_TICKS - 1; i++) tickPortal(core, player);
  assert.equal(player.dimension, Dimension.OVERWORLD, `第 ${PORTAL_DWELL_TICKS - 1} 刻就走了，太早`);
  tickPortal(core, player);
  assert.equal(player.dimension, Dimension.NETHER, '站够时间了还没走');
});

test('走出去会把计时清零 —— 反复蹭门不该攒够时间', () => {
  const { core, player } = makeRig();
  buildFrame(core, 4, 4);
  ignitePortal(core, core.world, 4, 71, 4);
  for (let round = 0; round < 5; round++) {
    player.x = 4.5;
    player.z = 4.5;
    for (let i = 0; i < 40; i++) tickPortal(core, player);
    // 出去一刻
    player.x = 10.5;
    tickPortal(core, player);
  }
  assert.equal(player.dimension, Dimension.OVERWORLD, '蹭了 200 刻门居然把人送走了');
  assert.equal(player.portalTicks, 0);
});

test('传送落点按 1:8 换算，且人站在下界的一座门里', () => {
  const { core, player } = makeRig();
  buildFrame(core, 4, 4);
  ignitePortal(core, core.world, 4, 71, 4);
  // 挪到一个大坐标，1:8 才看得出来
  player.x = 800.5;
  player.z = -1600.5;
  // 在那边也造一座门，人才走得掉
  for (const c of buildPortalPlan('x', 800, 71, -1601).frame) {
    core.world.forceChunk(c.x >> 4, c.z >> 4);
  }
  for (let x = 795; x < 810; x++) {
    for (let z = -1610; z < -1595; z++) core.world.setBlock(x, 70, z, STONE);
  }
  for (const c of buildPortalPlan('x', 800, 71, -1601).frame) {
    core.world.setBlock(c.x, c.y, c.z, OBSIDIAN);
  }
  ignitePortal(core, core.world, 800, 71, -1601);
  player.x = 800.5;
  player.y = 71;
  player.z = -1601 + 0.5;

  for (let i = 0; i < PORTAL_DWELL_TICKS; i++) tickPortal(core, player);
  assert.equal(player.dimension, Dimension.NETHER, '没走成');

  const want = convertCoords(Dimension.OVERWORLD, Dimension.NETHER, 800, -1601);
  // 落点可能因为找不到平地而在附近挪几格，但必须在 1:8 的邻域里，
  // 不能是 800 那种"忘了换算"
  assert.ok(Math.abs(player.x - want.x) < 12,
    `X 落在 ${player.x.toFixed(1)}，1:8 应在 ${want.x} 附近 —— 是不是没换算？`);
  assert.ok(Math.abs(player.z - want.z) < 12,
    `Z 落在 ${player.z.toFixed(1)}，1:8 应在 ${want.z} 附近`);

  // 落点脚下必须是实心的：站在虚空里等于传送即死
  const nether = core.worldOf(Dimension.NETHER);
  const below = nether.getBlock(Math.floor(player.x), Math.floor(player.y) - 1, Math.floor(player.z));
  assert.notEqual(stateId(below), 0, '落点脚下是空的，人会直接掉下去');
});

test('传送之后有冷却，不会在两个维度之间弹跳', () => {
  const { core, player } = makeRig();
  buildFrame(core, 4, 4);
  ignitePortal(core, core.world, 4, 71, 4);
  player.x = 4.5;
  player.y = 71;
  player.z = 4.5;
  for (let i = 0; i < PORTAL_DWELL_TICKS; i++) tickPortal(core, player);
  assert.equal(player.dimension, Dimension.NETHER);
  // 落地时人就站在下界那座门里。再跑一整个 dwell 时长，不该被弹回去
  for (let i = 0; i < PORTAL_DWELL_TICKS; i++) tickPortal(core, player);
  assert.equal(player.dimension, Dimension.NETHER, '刚过来就被弹回主世界了');
});

test('原路返回会回到同一座门附近', () => {
  const { core, player } = makeRig();
  buildFrame(core, 4, 4);
  ignitePortal(core, core.world, 4, 71, 4);
  player.x = 4.5;
  player.y = 71;
  player.z = 4.5;
  for (let i = 0; i < PORTAL_DWELL_TICKS; i++) tickPortal(core, player);
  assert.equal(player.dimension, Dimension.NETHER);

  // 走开再回来（清掉冷却），然后再站进去
  player.x += 20;
  for (let i = 0; i < 200; i++) tickPortal(core, player);
  const netherPortal = { x: player.x - 20, z: player.z };
  player.x = netherPortal.x;
  player.z = netherPortal.z;
  for (let i = 0; i < PORTAL_DWELL_TICKS + 5; i++) tickPortal(core, player);
  assert.equal(player.dimension, Dimension.OVERWORLD, '回不去主世界');
  // 回到原来那座门的附近（1:8 反算 + 搜索半径）
  assert.ok(Math.hypot(player.x - 5, player.z - 4.5) < 40,
    `回程落在 ${player.x.toFixed(1)},${player.z.toFixed(1)}，离原来的门太远`);
});

test('两个维度的方块互不影响', () => {
  const { core } = makeRig();
  const nether = core.worldOf(Dimension.NETHER);
  nether.forceChunk(0, 0);
  core.world.setBlock(3, 71, 3, STONE);
  assert.notEqual(stateId(core.world.getBlock(3, 71, 3)), 0);
  // 同一个坐标在下界该是下界自己的地形，不是刚放的石头
  const there = nether.getBlock(3, 71, 3);
  assert.notEqual(there, STONE, '主世界放的方块出现在了下界');
});

test('下界没有天光，主世界有', () => {
  const { core } = makeRig();
  assert.equal(core.world.dim.hasSkyLight, true);
  assert.equal(core.worldOf(Dimension.NETHER).dim.hasSkyLight, false);
  assert.equal(core.worldOf(Dimension.NETHER).dim.hasCeiling, true);
});

test('没去过的维度不会被创建 —— 四百个测试不该都去搭下界', () => {
  const core = new ServerCore({ seed: 5n, registry });
  assert.deepEqual([...core.loadedWorlds()].map((w) => w.dimension), [Dimension.OVERWORLD]);
  core.worldOf(Dimension.NETHER);
  assert.equal([...core.loadedWorlds()].length, 2);
  // 再要一次是同一个对象，不是新建
  assert.equal(core.worldOf(Dimension.NETHER), core.worldOf(Dimension.NETHER));
});
