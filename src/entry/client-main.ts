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
import { BLOCK_VERT_SRC, BLOCK_FRAG_SRC } from '../client/render/block-shader.ts';
import { buildAtlas, buildFaceLayerTable, tintColorArray } from '../client/render/block-textures.ts';
import { ChunkRenderer } from '../client/render/chunk-renderer.ts';
import { type MesherTables } from '../client/mesh/mesher.ts';
import { MeshWorkerPool, recommendedMeshWorkers } from '../client/mesh/mesh-worker-pool.ts';
import { ClientWorld, type SectionCoord } from '../client/world/client-world.ts';
import { createBlockRegistry } from '../content/blocks.ts';
import { extractPaddedNeighborhood } from '../core/world/chunk-codec.ts';
import { Frustum } from '../core/math/frustum.ts';
import { MessagePortTransport, PacketChannel } from '../core/net/transport.ts';
import { S2C, C_Handshake, C_Command, C_PlayerMove, C_SetViewDistance, PROTOCOL_VERSION } from '../core/net/packets.ts';
import { SECTION_SIZE, DEFAULT_RENDER_DISTANCE, TPS } from '../core/constants.ts';
import { skyColor, sunBrightness } from '../core/world/day-night.ts';
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
const atlas = buildAtlas(tables.collectTextureNames());
const faceLayer = buildFaceLayerTable(tables, atlas);
recordLog(`方块 ${registry.size} 种 · 贴图 ${atlas.layers} 张`);

const mesherTables: MesherTables = {
  modelKind: tables.modelKind,
  renderLayer: tables.renderLayer,
  tint: tables.tint,
  tintFaces: tables.tintFaces,
  fullCube: tables.fullCube,
  cullSameType: tables.cullSameType,
  opaque: tables.opaque,
  faceLayer,
};

const texture = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
const mipLevels = Math.floor(Math.log2(TILE_SIZE)) + 1;
gl.texStorage3D(gl.TEXTURE_2D_ARRAY, mipLevels, gl.RGBA8, TILE_SIZE, TILE_SIZE, atlas.layers);
gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, TILE_SIZE, TILE_SIZE, atlas.layers, gl.RGBA, gl.UNSIGNED_BYTE, atlas.data);
gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
if (anisoExt !== null) {
  gl.texParameterf(gl.TEXTURE_2D_ARRAY, anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(4, caps.maxAnisotropy));
}

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

// ---------------------------------------------------------------------------
// 服务端：跑在自己的 Worker 里
//
// 世界生成一次要 22 ms，放在主线程时玩家一移动帧率就从 60 掉到 19。
// 搬进 Worker 后主线程只剩渲染与网格化派发。
// 这里唯一变的是 Transport 实现，ServerCore 及其以下的代码一行没动 —— 这正是
// 当初把传输抽象成接口的目的。
// ---------------------------------------------------------------------------
const serverWorker = new Worker(new URL('./server-worker.ts', import.meta.url).href, {
  type: 'module',
  name: 'server',
});
serverWorker.onerror = (ev: ErrorEvent): void => {
  console.error(`[server-worker] ${ev.message}`);
  recordError(`服务端 worker 错误: ${ev.message}`);
};
const channel = new MessageChannel();
serverWorker.postMessage({ kind: 'start', seed, port: channel.port2 }, [channel.port2]);

const net = new PacketChannel(new MessagePortTransport(channel.port1), S2C);
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

net.onPacket((name, value) => {
  switch (name) {
    case 'S_Login': {
      const sx = value['spawnX'] as number;
      const sy = value['spawnY'] as number;
      const sz = value['spawnZ'] as number;
      camera.setPosition(sx, sy + 1.62, sz);
      spawned = true;
      console.log(`[net] 登录成功，出生点 ${sx.toFixed(1)} ${sy.toFixed(1)} ${sz.toFixed(1)}`);
      return;
    }
    case 'S_ChunkData':
      world.onChunkData(value['cx'] as number, value['cz'] as number, value['blob'] as Uint8Array);
      return;
    case 'S_ChunkUnload': {
      const cx = value['cx'] as number;
      const cz = value['cz'] as number;
      world.onChunkUnload(cx, cz);
      for (let cy = 0; cy < 8; cy++) renderer.remove(cx, cy, cz);
      return;
    }
    case 'S_BlockUpdate':
      world.onBlockUpdate(value['x'] as number, value['y'] as number, value['z'] as number, value['state'] as number);
      return;
    case 'S_TimeUpdate':
      serverTick = Number(value['worldAge'] as bigint);
      timeOfDay = Number(value['timeOfDay'] as bigint);
      return;
    case 'S_CommandResult': {
      const id = value['requestId'] as number;
      const pending = commandWaiters.get(id);
      if (pending !== undefined) {
        commandWaiters.delete(id);
        pending({ ok: value['ok'] as boolean, text: value['text'] as string });
      }
      return;
    }
    case 'S_ServerStats':
      serverStats.tick = value['tick'] as number;
      serverStats.pendingChunks = value['pendingChunks'] as number;
      serverStats.loadedChunks = value['loadedChunks'] as number;
      serverStats.tickMs = (value['tickMicros'] as number) / 100;
      return;
    case 'S_Chat':
      console.log(`[chat] ${value['text'] as string}`);
      return;
    case 'S_Disconnect': {
      const reason = value['reason'] as string;
      console.error(`[net] 被断开: ${reason}`);
      recordError(`断开: ${reason}`);
      return;
    }
    default:
      return;
  }
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

function renderOnce(): void {
  const w = canvas!.width;
  const h = canvas!.height;
  gl.viewport(0, 0, w, h);
  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  gl.frontFace(gl.CCW);
  // 天空色随昼夜变化，雾色跟着天空走 —— 远处的地形才不会在夜里浮出一层白边
  const sky = skyColor(timeOfDay);
  gl.clearColor(sky.r, sky.g, sky.b, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  camera.update(w / Math.max(1, h));
  frustum.update(camera.viewProjection);

  shader.use();
  shader.setMat4('uViewProj', camera.viewProjection);
  shader.setFloat('uSunBrightness', sunBrightness(timeOfDay));
  shader.setVec3('uFogColor', sky.r, sky.g, sky.b);
  shader.setVec3('uCameraPos', camera.position[0]!, camera.position[1]!, camera.position[2]!);
  shader.setFloat('uFogStart', renderDistance * SECTION_SIZE * 0.65);
  shader.setFloat('uFogEnd', renderDistance * SECTION_SIZE * 1.05);
  shader.setInt('uAtlas', 0);
  const tintLoc = shader.loc('uTintColors[0]');
  if (tintLoc !== null) gl.uniform3fv(tintLoc, tintColors);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
  renderer.render(shader, frustum, camera.position[0]!, camera.position[1]!, camera.position[2]!);
}

installTestHook({
  clock, camera, input, canvas, renderOnce,
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
  timeOfDay: () => timeOfDay,
  remeshCount: () => world.remeshCount,
  mirrorInfo: (x: number, y: number, z: number) => ({
    light: `${world.store.getSkyLight(x, y, z)}/${world.store.getBlockLight(x, y, z)}`,
    height: world.store.getHeight(x, z),
    loaded: world.store.isLoaded(x, z),
  }),
  debugWorld: () => world,
});

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------
let firstFrameDone = false;
let hudAccum = 0;

function frame(nowMs: number): void {
  clock.advance(nowMs);
  if (!sizeLocked) resizeToDisplay(canvas!, Math.min(window.devicePixelRatio || 1, 2));

  const snap = input.sample();
  if (!clock.frozen && spawned) camera.applyFreeFlight(snap, clock.dt, 12);

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
