/**
 * 客户端入口。
 *
 * M2：客户端不再直接持有世界，而是通过协议从 ServerCore 接收区块。
 * 服务端目前跑在**同一个线程**上（LoopbackTransport），M5 会把它移进 Web Worker ——
 * 届时唯一的改动是换一个 Transport 实现，本文件之外的代码一行不动。
 *
 * entry 是胶水层，允许同时 import server 与 client（docs/RULES.md 第 3 条）。
 */
import { createContext, resizeToDisplay } from '../client/gl/context.ts';
import { Shader } from '../client/gl/shader.ts';
import { Clock } from '../client/clock.ts';
import { Camera } from '../client/camera.ts';
import { Input } from '../client/input/input.ts';
import { recordError, recordLog } from '../client/debug/test-hook.ts';
import { wireTestHook } from './test-hook-wiring.ts';
import { scheduleFrame } from '../client/frame-scheduler.ts';
import { ClientEntities } from '../client/entity/client-entities.ts';
import { ClientMobs } from '../client/entity/client-mobs.ts';
import { ItemEntityRenderer } from '../client/render/item-entity-renderer.ts';
import { MobRenderer } from '../client/render/mob-renderer.ts';
import { EntityView } from './entity-view.ts';
import { drawWorldFrame } from './world-render.ts';
import { mobDefOf } from '../content/mobs.ts';
import { MobSound, mobVoicePitch } from '../core/audio/sound-spec.ts';
import { XP_ORB_ITEM_ID } from '../core/item/item-def.ts';

import { BLOCK_VERT_SRC, BLOCK_FRAG_SRC } from '../client/render/block-shader.ts';
import { tintColorArray } from '../client/render/block-textures.ts';
import { bootRenderResources } from '../client/render/resources.ts';
import type { MenuAction } from '../client/ui/menu-screen.ts';
import { runMenuAction } from './menu-actions.ts';
import { ClientAmbience } from './client-ambience.ts';
import { SkyRenderer } from '../client/render/sky-renderer.ts';
import { WeatherRenderer } from '../client/render/weather-renderer.ts';
import { ParticleEmitters } from '../client/particle/emitters.ts';
import { ChunkRenderer } from '../client/render/chunk-renderer.ts';
import { OverlayRenderer } from '../client/render/overlay-renderer.ts';
import { ParticleRenderer } from '../client/render/particle-renderer.ts';
import { AudioEngine } from '../client/audio/audio-engine.ts';
import { Interaction } from '../client/player/interaction.ts';
import { UiRenderer } from '../client/ui/ui-renderer.ts';
import { UiController, decodeSlots } from '../client/ui/ui-controller.ts';
import { createItemRegistry } from '../content/items.ts';
import { LocalPlayer } from '../client/player/local-player.ts';
import { ClientMeshing } from './client-meshing.ts';
import { ClientWorld } from '../client/world/client-world.ts';
import { createBlockRegistry } from '../content/blocks.ts';
import { Frustum } from '../core/math/frustum.ts';
import { ClientSession } from './client-session.ts';
import { installPacketHandlers } from './net-handlers.ts';
import { FrameInput } from './frame-input.ts';
import { collectDebugInfo } from '../client/ui/debug-info.ts';
import {
  C_Handshake, C_PlayerMove, C_SetViewDistance, C_AttackEntity, PROTOCOL_VERSION,
} from '../core/net/packets.ts';
import { SECTION_SIZE, DEFAULT_RENDER_DISTANCE, TPS, MS_PER_TICK } from '../core/constants.ts';

const canvas = document.getElementById('gl') as HTMLCanvasElement | null;
const hint = document.getElementById('hint');
if (canvas === null) throw new Error('找不到 #gl canvas');

const { gl, caps, anisoExt } = createContext(canvas);
recordLog(`GPU: ${caps.rendererName}`);
console.log(`[gl] ${caps.rendererName}`);

// ---------------------------------------------------------------------------
// 内容表与贴图
// ---------------------------------------------------------------------------
const params = new URLSearchParams(location.search);

const registry = createBlockRegistry();
const itemRegistry = createItemRegistry();
const tables = registry.getTables();
// 贴图集、资源包覆盖层、GPU 纹理 —— 三步是一条必须按顺序发生的链，
// 收在 client/render/resources.ts 里，见那里的注释
const { atlas, faceLayer, mesherTables, texture } = await bootRenderResources({
  gl, registry, items: itemRegistry, caps, anisoExt,
  packUrl: params.get('pack') ?? '', log: recordLog,
});
recordLog(`方块 ${registry.size} 种 · 物品 ${itemRegistry.size} 件 · 贴图 ${atlas.layers} 张`);

// ---------------------------------------------------------------------------
// 运行时对象
// ---------------------------------------------------------------------------
const seed = Number(params.get('seed') ?? 1234);
// let 而不是 const：设置界面能改视距（见 applyMenuAction）
let renderDistance = Number(params.get('rd') ?? DEFAULT_RENDER_DISTANCE);

const renderer = new ChunkRenderer(gl);
const frustum = new Frustum();
const clock = new Clock();
const camera = new Camera();
camera.far = renderDistance * SECTION_SIZE * 1.8;
const input = new Input(canvas);
const shader = new Shader(gl, BLOCK_VERT_SRC, BLOCK_FRAG_SRC, 'block');
const tintColors = tintColorArray();
const world = new ClientWorld(tables);
const overlay = new OverlayRenderer(gl);
const uiRenderer = new UiRenderer(gl);
const ui = new UiController();

/**
 * 物品 id -> 该画哪一层纹理。
 *
 * 方块画它的顶面（俯视图在物品栏里最好认），物品画自己的图标。
 * 两者在同一个纹理数组里，所以 UI 与世界共用一次纹理绑定。
 */
const iconLayerOf = (id: number, damage: number): number => {
  void damage;
  if (id <= 0) return -1;
  // 经验球用的是合成 id（见 server/entity/item-manager.ts），
  // 既不在方块表也不在物品表里，单独查
  if (id === XP_ORB_ITEM_ID) return atlas.index.get('xp_orb') ?? -1;
  if (id < 256) return faceLayer[id * 6 + 1] ?? -1;
  const def = itemRegistry.get(id);
  if (def === undefined) return -1;
  return atlas.index.get(def.texture) ?? -1;
};
const uiCtx = {
  iconLayer: iconLayerOf,
  maxStack: (id: number): number => itemRegistry.get(id)?.maxStack ?? 64,
};
const particles = new ParticleRenderer(gl);
const entities = new ClientEntities();
const mobs = new ClientMobs();
const itemEntityRenderer = new ItemEntityRenderer(gl);
const mobRenderer = new MobRenderer(gl);
/** 实体的绘制与拾取。见 entry/entity-view.ts */
const entityView = new EntityView({
  entities, mobs, itemEntityRenderer, mobRenderer,
  world, tables, faceLayer, iconLayer: iconLayerOf,
});
/**
 * 掉落物的 20 Hz 刻累加器。
 *
 * 客户端主循环是按帧走的，但掉落物的浮动、旋转与位置插值都必须按**刻**走 ——
 * 按帧走的话，转速会随帧率变化，而且插值的分母就没有意义了。
 */
let entityAccumMs = 0;
let entityPartialTick = 0;
const audio = new AudioEngine();
input.onUserGesture(() => audio.resume());

/** 粒子与音效用的随机源。固定种子，同一次运行里可复现 */
const RAND_SEED0 = 0x1234567;
let soundSeed = RAND_SEED0;
const rand = (): number => {
  soundSeed = (Math.imul(soundSeed, 1664525) + 1013904223) >>> 0;
  return soundSeed / 0x100000000;
};
const player = new LocalPlayer(0.5, 70, 0.5);

/** 环境音与背景音乐。调度在 core，播放在 client，这里只是把两头接上 */
const ambience = new ClientAmbience({
  audio,
  playerBlock: () => ({
    x: Math.floor(player.body.x), y: Math.floor(player.body.y), z: Math.floor(player.body.z),
  }),
  skyLightAt: (x, y, z) => world.store.getSkyLight(x, y, z),
});

/**
 * 粒子发射器。用同一个 rand —— 粒子必须**可复现**：
 * freeze() 之后连拍两张，粒子的位置要一样，否则截图回归天天飘。
 */
/**
 * 环境粒子的开关。默认开，截图回归关。
 * 和 persist / mobs / randomTicks 是同一类东西：它们都让世界自己变。
 */
// let 而不是 const：设置界面能关环境粒子
let ambientParticles = params.get('particles') !== '0';

const emitters = new ParticleEmitters({
  particles,
  store: world.store,
  layerOf: (texture) => atlas.index.get(texture) ?? 0,
  rand,
});

// ---------------------------------------------------------------------------
// 服务端：跑在自己的 Worker 里
//
// 世界生成一次要 22 ms，放在主线程时玩家一移动帧率就从 60 掉到 19。
// 搬进 Worker 后主线程只剩渲染与网格化派发。
// 这里唯一变的是 Transport 实现，ServerCore 及其以下的代码一行没动 —— 这正是
// 当初把传输抽象成接口的目的。接线细节见 entry/server-host.ts。
// ---------------------------------------------------------------------------
const session = new ClientSession({ seed, params, recordError, recordLog });
const net = session.net;
const serverStats = session.stats;
const weather = session.weather;

/** 最近一次闪电落在哪一个渲染刻。-1 表示没劈过 */
let lightningFlashTick = -1;

/** 世界里某处相对相机的左右声道位置，-1..1 */
const panTo = (x: number, z: number): number => {
  const dx = x - camera.position[0]!;
  const dz = z - camera.position[2]!;
  return Math.max(-1, Math.min(1, dx / Math.max(8, Math.abs(dz) + Math.abs(dx))));
};

/**
 * 天空。日月星云都在这里，画在世界之前。
 *
 * 图集层号在这里查好再传进去：渲染器不该知道贴图是怎么命名的，
 * 那是内容层的事 —— 它只要一个层号。
 */
const sky = new SkyRenderer(gl);
const weatherRenderer = new WeatherRenderer(gl);
const skyLayers = {
  sun: atlas.index.get('sun') ?? 0,
  clouds: atlas.index.get('clouds') ?? 0,
  moons: Array.from({ length: 8 }, (_, i) => atlas.index.get(`moon_phase_${i}`) ?? 0),
  rain: atlas.index.get('rain') ?? 0,
  snow: atlas.index.get('snowflake') ?? 0,
};

const interaction = new Interaction({
  camera, world, tables, audio, particles,
  player,
  crackLayer0: atlas.index.get('destroy_stage_0') ?? 0,
  faceLayer,
  send: (packet, value) => net.send(packet, value),
  rand,
  tintColors,
});

installPacketHandlers(net, {
  world, entities, mobs, ui, renderer, interaction,
  onExplosion: (x, y, z, power) => {
    emitters.explosion(x, y, z, power);
    audio.play(MobSound.EXPLODE, panTo(x, z), 1);
  },
  onEntityEvent: (entityId, event) => {
    const m = mobs.get(entityId);
    if (m === undefined) return;
    // 受伤与死亡共用两条参数，音高按体型缩放 —— 大家伙声音更低
    const def = mobDefOf(m.type);
    const pitch = mobVoicePitch(def === null ? 1 : def.height / 1.8);
    audio.play(event === 1 ? MobSound.DEATH : MobSound.HURT, 0, pitch);
  },
  onHealth: (v) => {
    Object.assign(ui.vitals, v);
    const wasDead = ui.dead;
    ui.dead = v.health <= 0;
    // 刚死的那一刻解除指针锁，让玩家能点重生
    if (ui.dead && !wasDead) document.exitPointerLock();
  },
  onLogin: (x, y, z) => {
    // 相机和**身体**都要放到出生点。只挪相机的话，物理下一帧就会
    // 把相机拽回身体所在的位置（世界原点上空），表现为一出生就掉进虚空
    player.teleport(x, y, z);
    camera.setPosition(x, y + player.eyeHeight, z);
    session.spawned = true;
  },
  onTime: (age, tod) => {
    session.worldAge = age;
    session.timeOfDay = tod;
  },
  onWeather: (rain, thunder) => {
    weather.rain = rain;
    weather.thunder = thunder;
  },
  onLightning: (x, y, z) => {
    // 闪电本身是一瞬间的事：记下时刻，渲染那边照着它闪几帧白光。
    // 用 renderTick 而不是挂钟 —— freeze() 之后闪电也该停在那一帧上
    lightningFlashTick = clock.renderTick;
    // 雷声用爆炸那条参数 —— 低通 500Hz 的长噪声加一段下滑的音调，
    // 正是雷的形状
    audio.play(MobSound.EXPLODE, panTo(x, z), 0.55);
    void y;
  },
  onServerStats: (tick, pending, loaded, tickMs) => {
    serverStats.tick = tick;
    serverStats.pendingChunks = pending;
    serverStats.loadedChunks = loaded;
    serverStats.tickMs = tickMs;
  },
  onCommandResult: (requestId, ok, text) => session.onCommandResult(requestId, ok, text),
  decodeSlots,
  releasePointer: () => document.exitPointerLock(),
  recordError,
});

net.send(C_Handshake, { protocolVersion: PROTOCOL_VERSION, playerName: '玩家' });
net.send(C_SetViewDistance, { distance: renderDistance });
net.flush();

// ---------------------------------------------------------------------------
// 网格化
// ---------------------------------------------------------------------------
const meshing = new ClientMeshing({
  world, camera, renderer, tables: mesherTables,
  workerScriptUrl: new URL('./mesh-worker.ts', import.meta.url).href,
  workerCount: params.get('meshWorkers') === null
    ? undefined : Number(params.get('meshWorkers')),
  log: (m) => console.log(m),
});
const meshPool = meshing.pool;

let sizeLocked = false;
let moveSeq = 0;

/** 把当前相机位置作为玩家位置报给服务端 */
function sendPlayerPosition(sneak = false, sprint = false): void {
  if (!session.spawned) return;
  const p = camera.position;
  net.send(C_PlayerMove, {
    seq: ++moveSeq, x: p[0]!, y: p[1]! - 1.62, z: p[2]!,
    yaw: camera.yaw, pitch: camera.pitch,
    onGround: false, sneaking: sneak, sprinting: sprint,
  });
  net.flush();
}

/**
 * 推进一步客户端侧的工作，供 __mc.waitForIdle 使用。
 *
 * 服务端已经在自己的 Worker 里按 20 TPS 自走，主线程驱动不了它，
 * 所以这里只做"把位置报上去 + 派发网格化"，服务端的进度靠 S_ServerStats 观察。
 */
function pumpWorld(): void {
  sendPlayerPosition();
  meshing.dispatch();
}

/**
 * 画一帧世界。所有绘制状态与顺序都在 entry/world-render.ts 里，
 * 这里只是把这一帧要用到的东西递过去。
 */
function renderOnce(): void {
  drawWorldFrame({
    gl, canvas: canvas!, camera, frustum, shader, renderer, tintColors,
    texture, renderDistance, timeOfDay: session.timeOfDay,
    entityView, itemEntityRenderer, mobRenderer, particles, interaction,
    overlay, ui, uiRenderer, uiCtx, entityPartialTick,
    sky, skyLayers, worldAge: session.worldAge, renderTick: clock.renderTick,
    anim: { start: atlas.animStart, groups: atlas.animGroups },
    rain: weather.rain, thunder: weather.thunder,
    weatherRenderer, lightningFlashTick, store: world.store,
    debug: showDebug ? collectDebugInfo({
      clock, camera, world, registry, renderer, particles, entities, mobs,
      timeOfDay: session.timeOfDay, worldAge: session.worldAge,
      rain: weather.rain, thunder: weather.thunder,
      serverChunks: serverStats.loadedChunks, pendingChunks: serverStats.pendingChunks,
      meshInFlight: meshPool.pendingJobs,
      serverTick: serverStats.tick, serverTickMs: serverStats.tickMs,
    }, pinDebug) : null,
  });
}

wireTestHook({
  gl, canvas: canvas!, clock, camera, input, world, session, meshing, renderer,
  entities, mobs, mobRenderer, particles, emitters, uiRenderer, ui, audio,
  interaction, player, renderOnce, pumpWorld, applyMenuAction,
  setSizeLock: (locked) => { sizeLocked = locked; },
  setDebugOverlay: (on, pinned) => { showDebug = on; pinDebug = pinned; },
  resetRand: () => { soundSeed = RAND_SEED0; },
});

/**
 * 选中、挖掘、放置。抽成一个模块是因为 client-main 已经顶到 600 行的硬上限了 ——
 * 那条规则的用处正是在这种时候：它逼着人把长出来的东西搬走，而不是继续糊。
 */
// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------
let firstFrameDone = false;

/**
 * F3 开着没有。
 *
 * 默认**关**：它每帧要画六七百个矩形，而且会出现在每一张截图里 ——
 * 黄金图比对的是像素，多一行 fps 就全不匹配。
 * URL 带 ?debug=1 可以默认打开，给人看的时候方便。
 */
let showDebug = params.get('debug') === '1';
/** 把 F3 上的遥测数字换成固定值，供截图回归。见 debug-info.ts 的 PINNED */
let pinDebug = false;
let prevDebugKey = false;

/** 界面输入的边沿触发状态，见 entry/frame-input.ts */
const frameInput = new FrameInput({
  net, ui,
  pointer: () => ({ x: input.pointerX, y: input.pointerY, w: canvas!.width, h: canvas!.height }),
  onMenuAction: (action) => { applyMenuAction(action); },
});

/** 菜单按钮的执行搬到了 entry/menu-actions.ts，见那里的注释 */
function applyMenuAction(action: MenuAction): void {
  runMenuAction(action, {
    ui, camera, net, audio, session,
    setRenderDistance: (n) => { renderDistance = n; },
    setAmbientParticles: (on) => { ambientParticles = on; },
  });
}

function frame(nowMs: number): void {
  clock.advance(nowMs);
  if (!sizeLocked) resizeToDisplay(canvas!, Math.min(window.devicePixelRatio || 1, 2));

  const snap = input.sample();

  // 菜单吃掉一切输入，这一帧只渲染。放在死亡界面**之前** ——
  // 死着的时候也该能按 Esc 打开暂停菜单退回标题
  if (frameInput.handleMenu(snap)) {
    renderOnce();
    scheduleFrame(frame);
    return;
  }

  // 死亡界面吃掉一切输入，这一帧只渲染
  if (frameInput.handleDeath(snap)) {
    renderOnce();
    scheduleFrame(frame);
    return;
  }
  frameInput.handleUi(snap);

  ambience.update(serverStats.tick);

  // F3 要边沿触发，否则按住会每帧翻一次，看起来是在闪
  if (snap.debug && !prevDebugKey) showDebug = !showDebug;
  prevDebugKey = snap.debug;

  if (!clock.frozen && session.spawned && !ui.open) {
    if (player.mode === 'detached') camera.applyFreeFlight(snap, clock.dt, 12);
    player.update(camera, snap, world.store, tables, clock.dt * 1000);

    // 左键按下的那一下：先看有没有指着生物。
    // 有的话打生物、**不**挖方块 —— 与 MC 一致，否则站在怪面前挖矿
    // 会一边挖一边打，两个动作抢同一个按键
    const hitMob = frameInput.attackPressedInWorld(snap)
      ? entityView.pickMob(camera, entityPartialTick) : -1;
    if (hitMob >= 0) {
      net.send(C_AttackEntity, { entityId: hitMob });
      interaction.stopDigging();
    } else {
      interaction.update(snap, clock.dt * 1000);
    }
  }
  frameInput.endWorldFrame(snap);

  // 掉落物按固定 20 Hz 推进；freeze() 之后一起停住，截图才可复现
  if (!clock.frozen) {
    entityAccumMs += clock.dt * 1000;
    // 上限 5 刻：切回后台标签页再回来时累加器可能积了好几秒，
    // 一次补完会让所有掉落物瞬移，还不如丢掉
    let steps = 0;
    // 苦力怕点着引信：放一声嘶。这是整个游戏里最重要的一条音频提示 ——
    // 玩家往往先听见它，再看见那团绿色
    for (const id of mobs.drainJustLit()) {
      void id;
      audio.play(MobSound.CREEPER_HISS, 0, 1);
    }
    while (entityAccumMs >= MS_PER_TICK && steps < 5) {
      entities.tick();
      mobs.tick();
      particles.update();
      // 环境粒子：火把冒烟、岩浆冒泡、火苗。每刻在相机周围随机采样几百格，
      // 采到什么就冒什么 —— 见 client/particle/emitters.ts
      //
      // 可以关掉，理由和 randomTicks 完全一样：它让画面**永远不静止**。
      // 地下十几格外的一洼岩浆就足以让每一帧都不同，而截图回归要的是
      // 逐像素可比。关掉之后 __mc.stepParticles 仍然能确定性地驱动
      // 同一份发射器，所以粒子本身照样被验证到。
      if (ambientParticles) {
        emitters.tickAmbient(camera.position[0]!, camera.position[1]!, camera.position[2]!);
      }
      entityAccumMs -= MS_PER_TICK;
      steps++;
    }
    if (steps >= 5) entityAccumMs = 0;
    entityPartialTick = Math.min(1, entityAccumMs / MS_PER_TICK);
  }

  // 服务端在自己的 Worker 里跑，主线程只需按帧把玩家位置报上去
  sendPlayerPosition(snap.sneak, snap.sprint);

  meshing.dispatch();
  renderOnce();

  if (!firstFrameDone) {
    firstFrameDone = true;
    (globalThis as unknown as { __mc: { _markReady(): void } }).__mc._markReady();
    console.log('[boot] 第一帧完成');
  }

  if (hint !== null) hint.classList.toggle('hidden', input.pointerLocked);

  scheduleFrame(frame);
}

const err = gl.getError();
if (err !== gl.NO_ERROR) {
  const msg = `WebGL 错误 0x${err.toString(16)}`;
  recordError(msg);
  console.error(msg);
}

console.log(`[boot] 服务端 worker 启动，种子 ${seed}，渲染距离 ${renderDistance}，${TPS} TPS`);
scheduleFrame(frame);
