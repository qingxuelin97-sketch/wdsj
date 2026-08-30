/**
 * 天气在世界里的后果：降水类型、积雪结冰、闪电、以及它对刷怪的影响。
 *
 * 状态机本身在 tests/core/weather.test.ts 里量过了，这里只测**需要世界**
 * 才能测的那半边。
 *
 * 最要紧的一条是最后那个：**雷暴天的白天怪会刷、僵尸不烧**。
 * 那不是给天气加的特判，是天光曲线自然给出的结果 —— 但也正因为
 * 它是"自然给出的"，一旦哪天有人忘了把 rain 传进 isDaytime，
 * 天气就会悄悄退化成纯画面效果，而没有任何报错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerCore } from '../../src/server/server-core.ts';
import { createBlockRegistry, Blocks } from '../../src/content/blocks.ts';
import { LoopbackTransport, PacketChannel } from '../../src/core/net/transport.ts';
import { S2C, C_Handshake, C_SetViewDistance, PROTOCOL_VERSION } from '../../src/core/net/packets.ts';
import { packState, stateId, AIR_STATE } from '../../src/core/world/chunk.ts';
import { runWeatherTick } from '../../src/server/world/weather-tick.ts';
import { precipitationOf } from '../../src/content/biomes.ts';
import { Biome } from '../../src/content/biomes.ts';
import { isDaytime, skyLightSubtracted } from '../../src/core/world/day-night.ts';
import type { ServerPlayer } from '../../src/server/player/server-player.ts';

const registry = createBlockRegistry();
const DIRT = registry.idOf(Blocks.DIRT);
const WATER = registry.idOf('water');
const SNOW_LAYER = registry.idOf(Blocks.SNOW_LAYER);
const ICE = registry.idOf(Blocks.ICE);
const Y = 71;

function makeWorld(biome: number): { core: ServerCore; player: ServerPlayer } {
  const core = new ServerCore({ seed: 4242n, registry });
  const [c, sv] = LoopbackTransport.createPair();
  c.synchronous = true;
  sv.synchronous = true;
  core.addClient(sv);
  const ch = new PacketChannel(c, S2C);
  ch.onPacket(() => {});
  ch.send(C_Handshake, { protocolVersion: PROTOCOL_VERSION, playerName: 't' });
  ch.send(C_SetViewDistance, { distance: 2 });
  ch.flush();
  const player = [...core.eachPlayer()][0]!;
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) core.world.forceChunk(cx, cz);

  // 一片露天的泥土地，整片改成指定群系
  for (let x = -12; x < 12; x++) {
    for (let z = -12; z < 12; z++) {
      core.world.setBlock(x, Y - 1, z, packState(DIRT));
      for (let y = Y; y < Y + 12; y++) core.world.setBlock(x, y, z, AIR_STATE);
    }
  }
  player.x = 0.5;
  player.y = Y;
  player.z = 0.5;
  core.tick();
  // 群系必须**在 tick 之后**再刷：这一刻的 prepareChunks 会连同 3×3 邻域
  // 一起生成新区块，那些区块带的是自然生成的群系。先刷后 tick 的话，
  // 边上会混进一圈别的群系 —— 而症状是"沙漠里劈了三次闪电"，
  // 看起来像降水判据坏了
  for (const chunk of core.world.store.chunkValues()) chunk.biomes.fill(biome);
  return { core, player };
}

test('降水由群系决定：沙漠不下、雪原下雪、平原下雨', () => {
  assert.equal(precipitationOf(Biome.DESERT), 'none', '沙漠的 rainfall 是 0，彻底不降水');
  assert.equal(precipitationOf(Biome.ICE_PLAINS), 'snow');
  assert.equal(precipitationOf(Biome.PLAINS), 'rain');
  assert.equal(precipitationOf(Biome.TAIGA), 'snow', '针叶林是 snowy');
});

test('雪原下雨时会积雪', () => {
  const { core } = makeWorld(Biome.ICE_PLAINS);
  core.world.weather.set(true, false);
  core.world.weather.snapStrength();

  // 每区块每刻只试一格，跑够久让它铺开
  for (let i = 0; i < 4000; i++) runWeatherTick(core.world);

  let snow = 0;
  for (let x = -8; x < 8; x++) {
    for (let z = -8; z < 8; z++) {
      if (stateId(core.world.getBlock(x, Y, z)) === SNOW_LAYER) snow++;
    }
  }
  assert.ok(snow > 20, `雪原下了 4000 刻的雪，地上该积起来，实得 ${snow} 格`);
});

test('平原下雨不积雪 —— 那是下雨不是下雪', () => {
  const { core } = makeWorld(Biome.PLAINS);
  core.world.weather.set(true, false);
  core.world.weather.snapStrength();
  for (let i = 0; i < 4000; i++) runWeatherTick(core.world);

  let snow = 0;
  for (let x = -8; x < 8; x++) {
    for (let z = -8; z < 8; z++) {
      if (stateId(core.world.getBlock(x, Y, z)) === SNOW_LAYER) snow++;
    }
  }
  assert.equal(snow, 0, `平原不该积雪，却积了 ${snow} 格`);
});

test('雪原的露天水面会结冰', () => {
  const { core } = makeWorld(Biome.ICE_PLAINS);
  // 挖一个水坑
  for (let x = -3; x <= 3; x++) {
    for (let z = -3; z <= 3; z++) core.world.setBlock(x, Y - 1, z, packState(WATER));
  }
  core.world.weather.set(true, false);
  core.world.weather.snapStrength();
  for (let i = 0; i < 4000; i++) runWeatherTick(core.world);

  let ice = 0;
  for (let x = -3; x <= 3; x++) {
    for (let z = -3; z <= 3; z++) {
      if (stateId(core.world.getBlock(x, Y - 1, z)) === ICE) ice++;
    }
  }
  assert.ok(ice > 0, '雪原的水面该结冰');
});

test('晴天什么都不发生', () => {
  const { core } = makeWorld(Biome.ICE_PLAINS);
  core.world.weather.set(false, false);
  core.world.weather.snapStrength();
  for (let i = 0; i < 4000; i++) {
    assert.equal(runWeatherTick(core.world).length, 0, '晴天不该有闪电');
  }
  let snow = 0;
  for (let x = -8; x < 8; x++) {
    for (let z = -8; z < 8; z++) {
      if (stateId(core.world.getBlock(x, Y, z)) === SNOW_LAYER) snow++;
    }
  }
  assert.equal(snow, 0, '晴天不该积雪');
});

test('雷暴会劈闪电，且只劈在下雨的群系', () => {
  const { core } = makeWorld(Biome.PLAINS);
  core.world.weather.set(true, true);
  core.world.weather.snapStrength();

  // 1/100000 每区块每刻，9 个区块 —— 要跑很久才见得到一次
  let strikes = 0;
  for (let i = 0; i < 400000 && strikes === 0; i++) {
    strikes += runWeatherTick(core.world).length;
  }
  assert.ok(strikes > 0, '40 万刻里 9 个区块该劈中至少一次');

  // 沙漠里永远不劈
  const desert = makeWorld(Biome.DESERT);
  desert.core.world.weather.set(true, true);
  desert.core.world.weather.snapStrength();
  let desertStrikes = 0;
  for (let i = 0; i < 400000; i++) desertStrikes += runWeatherTick(desert.core.world).length;
  assert.equal(desertStrikes, 0, '沙漠不下雨，也就不该有闪电');
});

test('雷暴天的白天，天光低到能刷怪 —— 这才是雷暴让人紧张的原因', () => {
  const NOON = 6000;
  assert.ok(isDaytime(NOON), '正午晴天当然是白天');
  assert.ok(isDaytime(NOON, 1, 0), '光下雨还不足以让天黑到刷怪');

  // 雨扣 5/16、雷再扣 5/16，两个都满时正午的天光扣减越过 3
  const clear = skyLightSubtracted(NOON, 0, 0);
  const storm = skyLightSubtracted(NOON, 1, 1);
  assert.ok(storm > clear, `雷暴该压低天光：晴 ${clear} -> 暴 ${storm}`);
  assert.equal(
    isDaytime(NOON, 1, 1), false,
    `雷暴的正午该判成"非白天"（怪会刷、僵尸不烧），实得天光扣减 ${storm}`,
  );
});

test('天气跟着世界一起存读', async () => {
  const { core } = makeWorld(Biome.PLAINS);
  core.world.weather.set(true, true, 5000);
  core.world.weather.snapStrength();

  // 直接验状态字段能被完整取出、装回去 —— 存档的编解码在
  // persistence.test.ts 里过，这里只盯住"该带的字段一个不少"
  const saved = {
    raining: core.world.weather.raining,
    thundering: core.world.weather.thundering,
    rainTime: core.world.weather.rainTime,
    thunderTime: core.world.weather.thunderTime,
  };
  assert.deepEqual(saved, { raining: true, thundering: true, rainTime: 5000, thunderTime: 5000 });

  const fresh = new ServerCore({ seed: 4242n, registry });
  Object.assign(fresh.world.weather, saved);
  fresh.world.weather.snapStrength();
  assert.equal(fresh.world.weather.snapshot().rainStrength, 1, '读档时雨该直接是大的，不淡入');
  assert.equal(fresh.world.weather.snapshot().thunderStrength, 1);
});

test('雪只盖在实心方块上 —— 不盖在水面、树叶、火把上', () => {
  const { core } = makeWorld(Biome.ICE_PLAINS);
  // 一根火把（非实心）立在泥土上
  const TORCH = registry.idOf(Blocks.TORCH);
  core.world.setBlock(5, Y, 5, packState(TORCH, 1));
  core.world.weather.set(true, false);
  core.world.weather.snapStrength();
  for (let i = 0; i < 6000; i++) runWeatherTick(core.world);

  assert.equal(
    stateId(core.world.getBlock(5, Y + 1, 5)), 0,
    '火把顶上不该积雪',
  );
});
