/**
 * 要塞、末影之眼、末地传送门。
 *
 * 这是通往末地的**唯一**一条路，而它跨了四个系统（结构生成 → 物品 →
 * 方块元数据 → 维度）。任何一环断了，玩家只会看到"眼嵌不进去"
 * 或者"十二块都齐了却不亮"，而两者都看不出原因在哪。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerCore } from '../../src/server/server-core.ts';
import { createBlockRegistry, Blocks } from '../../src/content/blocks.ts';
import { createItemRegistry, Items } from '../../src/content/items.ts';
import { LoopbackTransport, PacketChannel } from '../../src/core/net/transport.ts';
import {
  S2C, C_Handshake, C_SetViewDistance, C_UseBlock, PROTOCOL_VERSION,
} from '../../src/core/net/packets.ts';
import { stateId, stateMeta } from '../../src/core/world/chunk.ts';

import {
  strongholdSites, nearestStronghold, portalFrameCells,
  STRONGHOLD_COUNT, STRONGHOLD_MIN_RADIUS, STRONGHOLD_MAX_RADIUS, PORTAL_ROOM_Y,
} from '../../src/server/world/gen/stronghold.ts';
import {
  insertEye, tryActivateEndPortal, throwEnderEye, tickEndPortal,
  FRAME_HAS_EYE, FRAMES_NEEDED,
} from '../../src/server/world/end-portal.ts';
import { Dimension } from '../../src/core/world/dimension.ts';
import { MobType } from '../../src/content/mobs.ts';
import type { ServerPlayer } from '../../src/server/player/server-player.ts';

const registry = createBlockRegistry();
const items = createItemRegistry();
const FRAME = registry.idOf(Blocks.END_PORTAL_FRAME);
const END_PORTAL = registry.idOf(Blocks.END_PORTAL);

interface Rig {
  core: ServerCore;
  player: ServerPlayer;
  send: (p: unknown, v: Record<string, unknown>) => void;
}

function makeCore(seed: bigint): Rig {
  const core = new ServerCore({ seed, registry });
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
  return {
    core,
    player: [...core.eachPlayer()][0]!,
    send: (p, v) => { ch.send(p as never, v as never); ch.flush(); },
  };
}

// --- 位置 ---

test('三座要塞，在 640..1152 的圆环上大致均分', () => {
  const sites = strongholdSites(1234n);
  assert.equal(sites.length, STRONGHOLD_COUNT);
  const angles: number[] = [];
  for (const s of sites) {
    const r = Math.hypot(s.x, s.z);
    assert.ok(r >= STRONGHOLD_MIN_RADIUS - 2 && r <= STRONGHOLD_MAX_RADIUS + 2,
      `半径 ${r.toFixed(0)} 越界`);
    angles.push(Math.atan2(s.z, s.x));
  }
  // 两两夹角都该接近 120°
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      let d = Math.abs(angles[i]! - angles[j]!);
      if (d > Math.PI) d = Math.PI * 2 - d;
      assert.ok(d > 1.5, `第 ${i} 与第 ${j} 座挤在一起了（夹角 ${(d * 57.3).toFixed(0)}°）`);
    }
  }
});

test('位置只依赖种子：同种子同位置，不同种子不同位置', () => {
  assert.deepEqual(strongholdSites(7n), strongholdSites(7n));
  assert.notDeepEqual(strongholdSites(7n), strongholdSites(8n));
});

test('nearestStronghold 真的返回最近的那座', () => {
  const seed = 999n;
  const sites = strongholdSites(seed);
  for (const s of sites) {
    // 站在某座要塞旁边，最近的必须是它
    const near = nearestStronghold(seed, s.x + 5, s.z - 5);
    assert.deepEqual(near, s);
  }
});

// --- 生成 ---

test('传送门房间里正好十二块框架，排成缺角的 3×3 框', () => {
  const { core } = makeCore(1234n);
  const site = strongholdSites(1234n)[0]!;
  const cells = portalFrameCells(site);
  assert.equal(cells.length, FRAMES_NEEDED);
  // 缺角：四个角上不该有
  for (const [ox, oz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]] as const) {
    assert.ok(!cells.some((c) => c.x === site.x + ox && c.z === site.z + oz), '角上不该有框架');
  }

  for (const c of cells) core.world.forceChunk(c.x >> 4, c.z >> 4);
  let found = 0;
  for (const c of cells) {
    if (stateId(core.world.getBlock(c.x, PORTAL_ROOM_Y, c.z)) === FRAME) found++;
  }
  assert.equal(found, FRAMES_NEEDED, `世界里只生成了 ${found} 块框架`);
});

test('生成出来的框架一颗眼都没嵌', () => {
  const { core } = makeCore(1234n);
  const site = strongholdSites(1234n)[0]!;
  for (const c of portalFrameCells(site)) {
    core.world.forceChunk(c.x >> 4, c.z >> 4);
    const meta = stateMeta(core.world.getBlock(c.x, PORTAL_ROOM_Y, c.z));
    assert.equal(meta & FRAME_HAS_EYE, 0, '生成时就自带眼了，那末影之眼就没用了');
  }
});

test('传送门房间是掏空的，走得进去', () => {
  const { core } = makeCore(1234n);
  const site = strongholdSites(1234n)[0]!;
  core.world.forceChunk(site.x >> 4, site.z >> 4);
  // 房间中心往上两格必须是空的
  for (let dy = 1; dy <= 2; dy++) {
    assert.equal(stateId(core.world.getBlock(site.x, PORTAL_ROOM_Y + dy, site.z)), 0,
      `房间中心 y+${dy} 是实心的`);
  }
});

// --- 眼 ---

test('嵌眼：一次一块，重复嵌无效', () => {
  const { core } = makeCore(1234n);
  const site = strongholdSites(1234n)[0]!;
  const cell = portalFrameCells(site)[0]!;
  core.world.forceChunk(cell.x >> 4, cell.z >> 4);
  assert.equal(insertEye(core, core.world, cell.x, PORTAL_ROOM_Y, cell.z), true);
  assert.ok((stateMeta(core.world.getBlock(cell.x, PORTAL_ROOM_Y, cell.z)) & FRAME_HAS_EYE) !== 0);
  assert.equal(insertEye(core, core.world, cell.x, PORTAL_ROOM_Y, cell.z), false,
    '同一块嵌了两次 —— 那会白吃一颗眼');
});

test('往不是框架的地方嵌，什么都不发生', () => {
  const { core } = makeCore(1234n);
  core.world.forceChunk(0, 0);
  assert.equal(insertEye(core, core.world, 0, 64, 0), false);
});

test('十二块齐了才亮，差一块都不行', () => {
  const { core } = makeCore(1234n);
  const site = strongholdSites(1234n)[0]!;
  const cells = portalFrameCells(site);
  for (const c of cells) core.world.forceChunk(c.x >> 4, c.z >> 4);

  for (let i = 0; i < cells.length - 1; i++) {
    insertEye(core, core.world, cells[i]!.x, PORTAL_ROOM_Y, cells[i]!.z);
    assert.equal(tryActivateEndPortal(core, core.world, site.x, site.z), false,
      `才嵌了 ${i + 1} 块就亮了`);
  }
  const last = cells[cells.length - 1]!;
  insertEye(core, core.world, last.x, PORTAL_ROOM_Y, last.z);
  assert.equal(tryActivateEndPortal(core, core.world, site.x, site.z), true, '十二块齐了却不亮');

  // 中间 3×3 变成末地传送门
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      assert.equal(stateId(core.world.getBlock(site.x + dx, PORTAL_ROOM_Y, site.z + dz)), END_PORTAL,
        `(${dx},${dz}) 没变成末地传送门`);
    }
  }
  // 再点一次不该重复亮（会白白广播九次方块变更）
  assert.equal(tryActivateEndPortal(core, core.world, site.x, site.z), false);
});

test('扔眼：飞出一个实体，朝着最近的要塞', () => {
  const { core, player } = makeCore(1234n);
  const site = nearestStronghold(core.world.seed, player.x, player.z);
  assert.equal(throwEnderEye(core, player), true);
  const eyes = [...core.mobs.mobs.values()].filter((m) => m.def.type === MobType.ENDER_EYE);
  assert.equal(eyes.length, 1, '没扔出实体 —— 玩家就看不到方向了');
  const eye = eyes[0]!;
  // 速度方向与"玩家 -> 要塞"同向
  const dx = site.x - player.x;
  const dz = site.z - player.z;
  const len = Math.hypot(dx, dz);
  const dot = (eye.body.vx * dx + eye.body.vz * dz) / (len * Math.hypot(eye.body.vx, eye.body.vz));
  assert.ok(dot > 0.99, `眼没朝要塞飞，方向余弦 ${dot.toFixed(3)}`);
});

test('扔出去的眼会自己消失，不会一路飞出一千格', () => {
  const { core, player } = makeCore(1234n);
  throwEnderEye(core, player);
  for (let i = 0; i < 200; i++) core.tick();
  const eyes = [...core.mobs.mobs.values()].filter((m) => m.def.type === MobType.ENDER_EYE);
  assert.equal(eyes.length, 0, '眼一直在飞 —— 它会把沿途的区块全加载出来');
});

test('在下界扔眼没有反应', () => {
  const { core, player } = makeCore(1234n);
  player.dimension = Dimension.NETHER;
  assert.equal(throwEnderEye(core, player), false);
});

test('用末影之眼右键框架会消耗一颗并可能点亮', () => {
  const { core, player, send } = makeCore(1234n);
  const site = strongholdSites(1234n)[0]!;
  const cells = portalFrameCells(site);
  for (const c of cells) core.world.forceChunk(c.x >> 4, c.z >> 4);
  // 先手动嵌满十一块
  for (let i = 0; i < cells.length - 1; i++) {
    insertEye(core, core.world, cells[i]!.x, PORTAL_ROOM_Y, cells[i]!.z);
  }
  const last = cells[cells.length - 1]!;
  // 玩家站到最后一块旁边，手里拿一颗眼
  player.x = last.x + 0.5;
  player.y = PORTAL_ROOM_Y;
  player.z = last.z + 0.5;
  const held = player.inventory.held;
  held.id = items.idOf(Items.EYE_OF_ENDER);
  held.count = 3;
  held.damage = 0;

  send(C_UseBlock, {
    x: last.x, y: PORTAL_ROOM_Y, z: last.z, face: 1, hitX: 0.5, hitY: 1, hitZ: 0.5,
  });
  assert.equal(player.inventory.held.count, 2, '没消耗那颗眼');
  assert.equal(stateId(core.world.getBlock(site.x, PORTAL_ROOM_Y, site.z)), END_PORTAL,
    '十二块齐了却没点亮');
});

test('踩进末地传送门就去末地，且落点脚下有平台', () => {
  const { core, player } = makeCore(1234n);
  const site = strongholdSites(1234n)[0]!;
  const cells = portalFrameCells(site);
  for (const c of cells) core.world.forceChunk(c.x >> 4, c.z >> 4);
  for (const c of cells) insertEye(core, core.world, c.x, PORTAL_ROOM_Y, c.z);
  tryActivateEndPortal(core, core.world, site.x, site.z);

  player.x = site.x + 0.5;
  player.y = PORTAL_ROOM_Y;
  player.z = site.z + 0.5;
  tickEndPortal(core, player);
  assert.equal(player.dimension, Dimension.END, '踩上去没去末地');

  const end = core.worldOf(Dimension.END);
  const below = end.getBlock(Math.floor(player.x), Math.floor(player.y) - 1, Math.floor(player.z));
  assert.notEqual(stateId(below), 0, '末地落点脚下是空的 —— 会直接掉进虚空');
});

test('末地传送门立刻生效，不像下界门要等四秒', () => {
  const { core, player } = makeCore(1234n);
  const site = strongholdSites(1234n)[0]!;
  for (const c of portalFrameCells(site)) {
    core.world.forceChunk(c.x >> 4, c.z >> 4);
    insertEye(core, core.world, c.x, PORTAL_ROOM_Y, c.z);
  }
  tryActivateEndPortal(core, core.world, site.x, site.z);
  player.x = site.x + 0.5;
  player.y = PORTAL_ROOM_Y;
  player.z = site.z + 0.5;
  // 一刻就够
  tickEndPortal(core, player);
  assert.equal(player.dimension, Dimension.END);
});
