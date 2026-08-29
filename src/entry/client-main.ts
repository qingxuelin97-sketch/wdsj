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
import { installTestHook, recordError, recordLog } from '../client/debug/test-hook.ts';
import { scheduleFrame } from '../client/frame-scheduler.ts';
import { ClientEntities } from '../client/entity/client-entities.ts';
import { ClientMobs } from '../client/entity/client-mobs.ts';
import { ItemEntityRenderer } from '../client/render/item-entity-renderer.ts';
import { MobRenderer } from '../client/render/mob-renderer.ts';
import { EntityView } from './entity-view.ts';
import { drawWorldFrame } from './world-render.ts';
import { mobModelOf, WOOL_COLORS } from '../content/mob-models.ts';
import { MobType, mobDefOf } from '../content/mobs.ts';
import { MobSound, mobVoicePitch } from '../core/audio/sound-spec.ts';
import { XP_ORB_ITEM_ID } from '../core/item/item-def.ts';

import { BLOCK_VERT_SRC, BLOCK_FRAG_SRC } from '../client/render/block-shader.ts';
import { tintColorArray } from '../client/render/block-textures.ts';
import { buildRenderResources } from '../client/render/resources.ts';
import { ChunkRenderer } from '../client/render/chunk-renderer.ts';
import { OverlayRenderer } from '../client/render/overlay-renderer.ts';
import { ParticleRenderer } from '../client/render/particle-renderer.ts';
import { AudioEngine } from '../client/audio/audio-engine.ts';
import { Interaction } from '../client/player/interaction.ts';
import { UiRenderer } from '../client/ui/ui-renderer.ts';
import { UiController, decodeSlots } from '../client/ui/ui-controller.ts';
import { createItemRegistry } from '../content/items.ts';
import { LocalPlayer } from '../client/player/local-player.ts';
import { type MesherTables } from '../client/mesh/mesher.ts';
import { MeshWorkerPool, recommendedMeshWorkers } from '../client/mesh/mesh-worker-pool.ts';
import { ClientWorld, type SectionCoord } from '../client/world/client-world.ts';
import { createBlockRegistry } from '../content/blocks.ts';
import { extractPaddedNeighborhood } from '../core/world/chunk-codec.ts';
import { stateId } from '../core/world/chunk.ts';
import { raycastBlocks } from '../core/physics/raycast.ts';
import { Frustum } from '../core/math/frustum.ts';
import { startServerHost } from './server-host.ts';
import { installPacketHandlers } from './net-handlers.ts';
import {
  S2C, C_Handshake, C_Command, C_PlayerMove, C_PlayerAction, C_UseBlock,
  C_SetViewDistance, C_WindowClick, C_CloseWindow, C_HeldSlot, C_AttackEntity, C_Respawn,
  PROTOCOL_VERSION, PlayerActionKind, WindowKind,
  ENTITY_POS_SCALE, SPAWN_ITEM_STRIDE, ENTITY_MOVE_STRIDE,
} from '../core/net/packets.ts';
import { SECTION_SIZE, DEFAULT_RENDER_DISTANCE, TPS, REACH_SURVIVAL, MS_PER_TICK } from '../core/constants.ts';
import { skyColor, sunBrightness } from '../core/world/day-night.ts';
import { StatSlot, readStat, writeStat, STAT_BYTES } from '../core/shared-stats.ts';
import { TILE_SIZE } from '../client/render/texgen.ts';

const canvas = document.getElementById('gl') as HTMLCanvasElement | null;
const hud = document.getElementById('hud');
const hint = document.getElementById('hint');
if (canvas === null) throw new Error('找不到 #gl canvas');

const { gl, caps, anisoExt } = createContext(canvas);
recordLog(`GPU: ${caps.rendererName}`);
console.log(`[gl] ${caps.rendererName}`);

// ---------------------------------------------------------------------------
// 内容表与贴图
// ---------------------------------------------------------------------------
const registry = createBlockRegistry();
const tables = registry.getTables();
// 贴图集与 GPU 纹理。物品图标也一并烘进去 —— UI 与世界共用一个 sampler
const itemRegistry = createItemRegistry();
const { atlas, faceLayer, mesherTables, texture } = buildRenderResources(
  gl, tables, caps, anisoExt,
  // 经验球的图标既不属于方块也不属于物品，要显式塞进图集
  [...itemRegistry.all().map((d) => d.texture), 'xp_orb'],
);
recordLog(`方块 ${registry.size} 种 · 物品 ${itemRegistry.size} 件 · 贴图 ${atlas.layers} 张`);

// ---------------------------------------------------------------------------
// 运行时对象
// ---------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed') ?? 1234);
const renderDistance = Number(params.get('rd') ?? DEFAULT_RENDER_DISTANCE);

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
let soundSeed = 0x1234567;
const rand = (): number => {
  soundSeed = (Math.imul(soundSeed, 1664525) + 1013904223) >>> 0;
  return soundSeed / 0x100000000;
};
const player = new LocalPlayer(0.5, 70, 0.5);

// ---------------------------------------------------------------------------
// 服务端：跑在自己的 Worker 里
//
// 世界生成一次要 22 ms，放在主线程时玩家一移动帧率就从 60 掉到 19。
// 搬进 Worker 后主线程只剩渲染与网格化派发。
// 这里唯一变的是 Transport 实现，ServerCore 及其以下的代码一行没动 —— 这正是
// 当初把传输抽象成接口的目的。接线细节见 entry/server-host.ts。
// ---------------------------------------------------------------------------
const host = startServerHost({
  seed,
  // 截图回归必须关掉存档：存了的话"同一个种子跑两次"会得到不同的世界 ——
  // 第二次读的是第一次留下的状态，包括玩家走过的位置与挖掉的方块
  persist: params.get('persist') !== '0',
  // 同理：野生的怪会走进画面，让同一个机位每次截出来都不一样
  spawnMobs: params.get('mobs') !== '0',
  recordError,
  recordLog,
});
const net = host.net;

/** 页面关闭时叫停心跳线程 —— 它睡在 futex 上，不主动叫醒就会一直跑 */
self.addEventListener('pagehide', () => {
  host.shutdown();
});

/**
 * 关页面前存一次盘。
 *
 * 用 visibilitychange 而不是 beforeunload：手机浏览器与某些桌面场景根本
 * 不触发 beforeunload，而 visibilitychange 是唯一可靠的"页面要没了"信号。
 * 存盘本身是异步的、可能来不及跑完 —— 所以它只是自动存盘之外的一层保险，
 * 真正的保障是每 30 秒一次的自动存盘。
 */
self.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && host.persist) void host.requestSave();
});
let spawned = false;
let serverTick = 0;
/** 未回执的指令，按 requestId 索引 */
const commandWaiters = new Map<number, (r: { ok: boolean; text: string }) => void>();
let nextCommandId = 1;

/** 发一条指令给服务端，等回执。超时会 reject，避免测试永远挂着 */
function sendCommand(text: string): Promise<{ ok: boolean; text: string }> {
  const requestId = nextCommandId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      commandWaiters.delete(requestId);
      reject(new Error(`指令超时: ${text}`));
    }, 8000);
    commandWaiters.set(requestId, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    net.send(C_Command, { requestId, text });
  });
}
/** 服务端权威的当日时间，0..23999。渲染只读它，绝不自己推进 */
let timeOfDay = 0;
/** 服务端最近一次上报的状态。主线程读不到 worker 内部，只能靠它 */
const serverStats = { tick: 0, pendingChunks: 0, loadedChunks: 0, tickMs: 0 };

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
  onEntityEvent: (entityId, event) => {
    if (event === 2) {
      audio.play(MobSound.EXPLODE, 0, 1);
      return;
    }
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
    spawned = true;
  },
  onTime: (age, tod) => {
    serverTick = age;
    timeOfDay = tod;
  },
  onServerStats: (tick, pending, loaded, tickMs) => {
    serverStats.tick = tick;
    serverStats.pendingChunks = pending;
    serverStats.loadedChunks = loaded;
    serverStats.tickMs = tickMs;
  },
  onCommandResult: (requestId, ok, text) => {
    const pending = commandWaiters.get(requestId);
    if (pending === undefined) return;
    commandWaiters.delete(requestId);
    pending({ ok, text });
  },
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
const dirtyBatch: SectionCoord[] = [];
/**
 * 每帧最多**派发**几个网格化任务。
 * 派发本身很便宜（一次 5832 项的复制 + postMessage），真正的计算在 worker 里，
 * 所以这个数可以比同步版本大得多。
 */
const MESH_DISPATCH_PER_FRAME = 6;
/** 在飞任务的上限，避免玩家快速移动时把队列堆到几千 */
const MAX_IN_FLIGHT = 48;

const meshPool = new MeshWorkerPool(mesherTables, {
  scriptUrl: new URL('./mesh-worker.ts', import.meta.url).href,
  workers: Number(params.get('meshWorkers') ?? recommendedMeshWorkers()),
});
console.log(`[mesh] ${meshPool.workerCount} 个网格 worker`);

let sizeLocked = false;
let meshedTotal = 0;
let moveSeq = 0;

/** 把当前相机位置作为玩家位置报给服务端 */
function sendPlayerPosition(sneak = false, sprint = false): void {
  if (!spawned) return;
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
  meshDirtySections();
}

/** 网格化结果回来：先验 rev，过期的直接丢 */
meshPool.setResultHandler((result) => {
  const currentRev = world.revOf(result.cx, result.cy, result.cz);
  if (result.rev < currentRev) {
    // 玩家快速挖放时同一段会连续产生任务，回来的顺序不保证 —— 旧结果必须丢弃，
    // 否则会把过期的网格盖到新状态上（docs/RULES.md 第 11 条）
    meshPool.noteDiscarded();
    return;
  }
  if (result.layers.length > 0) renderer.upload(result);
  else renderer.remove(result.cx, result.cy, result.cz);
  meshedTotal++;
});

/** 把脏的子区块派发给 worker 池 */
function meshDirtySections(): void {
  if (meshPool.pendingJobs >= MAX_IN_FLIGHT) return;
  const budget = Math.min(MESH_DISPATCH_PER_FRAME, MAX_IN_FLIGHT - meshPool.pendingJobs);
  const p = camera.position;
  world.takeDirty(budget, p[0]!, p[1]!, p[2]!, dirtyBatch);
  for (const { cx, cy, cz } of dirtyBatch) {
    if (!world.hasContent(cx, cy, cz)) {
      renderer.remove(cx, cy, cz);
      continue;
    }
    const buffers = meshPool.acquireBuffers();
    extractPaddedNeighborhood(
      (x, y, z) => world.store.getState(x, y, z),
      (x, y, z) => (world.store.getSkyLight(x, y, z) << 4) | world.store.getBlockLight(x, y, z),
      (x, z) => world.store.getBiome(x, z),
      cx, cy, cz,
      buffers.blocks, buffers.light, buffers.biomes,
    );
    // 缓冲的所有权转移给 worker，之后不能再碰
    meshPool.submit(cx, cy, cz, world.revOf(cx, cy, cz), buffers);
  }
}

/**
 * 画一帧世界。所有绘制状态与顺序都在 entry/world-render.ts 里，
 * 这里只是把这一帧要用到的东西递过去。
 */
function renderOnce(): void {
  drawWorldFrame({
    gl, canvas: canvas!, camera, frustum, shader, renderer, tintColors,
    texture, renderDistance, timeOfDay,
    entityView, itemEntityRenderer, mobRenderer, particles, interaction,
    overlay, ui, uiRenderer, uiCtx, entityPartialTick,
  });
}

installTestHook({
  clock, camera, input, canvas, renderOnce,
  saveWorld: () => host.requestSave('save'),
  wipeSave: () => host.requestSave('wipe'),
  itemEntities: () => [...entities.values()].map((e) => ({
    id: e.entityId, x: e.x, y: e.y, z: e.z, item: e.itemId, count: e.count,
  })),
  mobEntities: () => [...mobs.values()].map((m) => ({
    id: m.entityId, type: m.type, x: m.x, y: m.y, z: m.z, health: m.health,
  })),
  mobVerts: () => mobRenderer.lastVerts,
  isDead: () => ui.dead,
  vitals: () => ({
    health: ui.vitals.health, hunger: ui.vitals.hunger,
    air: ui.vitals.air, xpLevel: ui.vitals.xpLevel,
  }),
  respawn: () => { net.send(C_Respawn, {}); net.flush(); },
  sendAction: (kind, x, y, z) => {
    net.send(C_PlayerAction, {
      action: kind === 'start-dig' ? PlayerActionKind.START_DIG : PlayerActionKind.CANCEL_DIG,
      x, y, z, face: 1,
    });
    net.flush();
  },
  drawStats: () => ({ drawCalls: renderer.drawCalls, quads: renderer.quadsDrawn }),
  setSizeLock: (locked: boolean) => {
    sizeLocked = locked;
  },
  idleStats: () => ({
    // 在飞的网格化任务也算"未安定"——否则会在结果还没回来时就判定世界已就绪
    dirty: world.dirtyCount + meshPool.pendingJobs,
    chunks: world.chunkCount,
    serverPending: serverStats.pendingChunks,
  }),
  pumpWorld,
  command: sendCommand,
  sharedStats: host.sharedStats,
  timeOfDay: () => timeOfDay,
  remeshCount: () => world.remeshCount,
  mirrorInfo: (x: number, y: number, z: number) => ({
    light: `${world.store.getSkyLight(x, y, z)}/${world.store.getBlockLight(x, y, z)}`,
    height: world.store.getHeight(x, z),
    loaded: world.store.isLoaded(x, z),
  }),
  debugWorld: () => world,
  remeshAll: () => world.markAllDirty(),
  detachCamera: () => { player.mode = 'detached'; },
  attachPlayer: (x: number, y: number, z: number) => {
    player.mode = 'physics';
    player.teleport(x, y, z);
    camera.setPosition(x, y + player.eyeHeight, z);
  },
  playerState: () => ({
    x: player.body.x, y: player.body.y, z: player.body.z,
    onGround: player.body.onGround, mode: player.mode,
  }),
  selectedBlock: () => interaction.selectedBlock(),
  digProgress: () => interaction.digProgress,
  audioStats: () => ({ ready: audio.ready, plays: audio.playCount }),
  startAudio: () => audio.resume(),
  particleCount: () => particles.count,
  uiQuads: () => uiRenderer.lastQuads,
  uiOpen: () => ui.open,
  pixelAt: (x: number, y: number) => {
    const buf = new Uint8Array(4);
    // readPixels 的原点在**左下角**，和屏幕坐标相反
    gl.readPixels(x, canvas!.height - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return [buf[0]!, buf[1]!, buf[2]!, buf[3]!];
  },

});

/**
 * 选中、挖掘、放置。抽成一个模块是因为 client-main 已经顶到 600 行的硬上限了 ——
 * 那条规则的用处正是在这种时候：它逼着人把长出来的东西搬走，而不是继续糊。
 */
// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------
let firstFrameDone = false;
/** 上一帧的按键状态，用来做边沿触发 */
let prevInventory = false;
let prevAttack = false;
/** 上一帧世界交互里的左键状态，用来做边沿触发 */
let prevAttackWorld = false;
let prevUse = false;
let hudAccum = 0;

function frame(nowMs: number): void {
  clock.advance(nowMs);
  if (!sizeLocked) resizeToDisplay(canvas!, Math.min(window.devicePixelRatio || 1, 2));

  const snap = input.sample();

  // --- 死了：只接受"重生" ---
  //
  // 死亡界面挡住整个世界，输入也全部截住。让玩家在死亡界面里还能挖方块
  // 会让死亡完全没有分量，而"分量"正是这套生存循环唯一想产生的东西
  if (ui.dead) {
    if ((snap.attack && !prevAttack) || (snap.use && !prevUse) || snap.inventory) {
      net.send(C_Respawn, {});
    }
    prevAttack = snap.attack;
    prevUse = snap.use;
    prevInventory = snap.inventory;
    renderOnce();
    scheduleFrame(frame);
    return;
  }

  // --- 界面开关。按键要做**边沿触发**，否则按住 E 会每帧开一次 ---
  if (snap.inventory && !prevInventory) {
    if (ui.open) {
      net.send(C_CloseWindow, { windowId: ui.windowId });
      ui.onCloseWindow();
    } else {
      net.send(C_PlayerAction, {
        action: PlayerActionKind.OPEN_INVENTORY, x: 0, y: 0, z: 0, face: 0,
      });
    }
  }
  prevInventory = snap.inventory;

  if (snap.escape && ui.open) {
    net.send(C_CloseWindow, { windowId: ui.windowId });
    ui.onCloseWindow();
  }

  // 数字键切快捷栏
  if (snap.hotbarKey >= 0 && snap.hotbarKey !== ui.selectedHotbar) {
    ui.selectedHotbar = snap.hotbarKey;
    net.send(C_HeldSlot, { slot: snap.hotbarKey });
  }

  // --- 界面开着时鼠标用来点格子，不动相机也不挖方块 ---
  if (ui.open) {
    ui.onMouseMove(input.pointerX, input.pointerY, canvas!.width, canvas!.height);
    if (snap.attack && !prevAttack) {
      const click = ui.click(0, snap.sneak);
      if (click !== null) net.send(C_WindowClick, click);
    }
    if (snap.use && !prevUse) {
      const click = ui.click(1, snap.sneak);
      if (click !== null) net.send(C_WindowClick, click);
    }
  }
  prevAttack = snap.attack;
  prevUse = snap.use;

  if (!clock.frozen && spawned && !ui.open) {
    if (player.mode === 'detached') camera.applyFreeFlight(snap, clock.dt, 12);
    player.update(camera, snap, world.store, tables, clock.dt * 1000);

    // 左键按下的那一下：先看有没有指着生物。
    // 有的话打生物、**不**挖方块 —— 与 MC 一致，否则站在怪面前挖矿
    // 会一边挖一边打，两个动作抢同一个按键
    const hitMob = snap.attack && !prevAttackWorld ? entityView.pickMob(camera, entityPartialTick) : -1;
    if (hitMob >= 0) {
      net.send(C_AttackEntity, { entityId: hitMob });
      interaction.stopDigging();
    } else {
      interaction.update(snap, clock.dt * 1000);
    }
  }
  prevAttackWorld = snap.attack;

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
      entityAccumMs -= MS_PER_TICK;
      steps++;
    }
    if (steps >= 5) entityAccumMs = 0;
    entityPartialTick = Math.min(1, entityAccumMs / MS_PER_TICK);
  }

  // 服务端在自己的 Worker 里跑，主线程只需按帧把玩家位置报上去
  sendPlayerPosition(snap.sneak, snap.sprint);

  meshDirtySections();
  renderOnce();

  if (!firstFrameDone) {
    firstFrameDone = true;
    (globalThis as unknown as { __mc: { _markReady(): void } }).__mc._markReady();
    console.log('[boot] 第一帧完成');
  }

  hudAccum += clock.dt;
  if (hud !== null && hudAccum > 0.1) {
    hudAccum = 0;
    const p = camera.position;
    hud.textContent =
      `fps ${clock.fps.toFixed(0)} (${clock.frameMs.toFixed(1)}ms)  服务端 ${serverStats.tick}t ${serverStats.tickMs.toFixed(1)}ms\n` +
      `xyz ${p[0]!.toFixed(1)} ${p[1]!.toFixed(1)} ${p[2]!.toFixed(1)}  世界时间 ${serverTick % 24000}\n` +
      `区块 ${world.chunkCount}/${serverStats.loadedChunks}  待网格 ${world.dirtyCount}  在飞 ${meshPool.pendingJobs}  待推 ${serverStats.pendingChunks}\n` +
      `段 ${renderer.sectionsDrawn}/${renderer.sectionCount}  draws ${renderer.drawCalls}\n` +
      `面 ${renderer.quadsDrawn}  显存 ${(renderer.totalBytes / 1048576).toFixed(1)} MB`;
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
