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
import { meshSection, PADDED_VOLUME, PADDED_AREA, type MesherTables } from '../client/mesh/mesher.ts';
import { ClientWorld, type SectionCoord } from '../client/world/client-world.ts';
import { createBlockRegistry } from '../content/blocks.ts';
import { extractPaddedNeighborhood } from '../core/world/chunk-codec.ts';
import { Frustum } from '../core/math/frustum.ts';
import { LoopbackTransport, PacketChannel } from '../core/net/transport.ts';
import { S2C, C_Handshake, C_PlayerMove, C_SetViewDistance, PROTOCOL_VERSION } from '../core/net/packets.ts';
import { ServerCore } from '../server/server-core.ts';
import { SECTION_SIZE, DEFAULT_RENDER_DISTANCE, MS_PER_TICK, TPS } from '../core/constants.ts';
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
const world = new ClientWorld();

// ---------------------------------------------------------------------------
// 服务端（M2 同线程，M5 搬进 worker）
// ---------------------------------------------------------------------------
const server = new ServerCore({ seed: BigInt(seed), registry });
const [clientSide, serverSide] = LoopbackTransport.createPair();
server.addClient(serverSide);

const net = new PacketChannel(clientSide, S2C);
let spawned = false;
let serverTick = 0;

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
// 输入缓冲复用，避免每个任务分配 18 KB
const jobBlocks = new Uint16Array(PADDED_VOLUME);
const jobLight = new Uint8Array(PADDED_VOLUME);
const jobBiomes = new Uint8Array(PADDED_AREA);
const dirtyBatch: SectionCoord[] = [];
/** 每帧最多网格化几个子区块。太多会掉帧，太少地形出现得慢 */
const MESH_BUDGET_PER_FRAME = 6;

const SKY = { r: 0.62, g: 0.76, b: 0.98 };
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

/** 手动推进一步模拟。供 __mc.waitForIdle 精确驱动世界，不依赖帧率 */
function pumpWorld(): void {
  sendPlayerPosition();
  server.tick();
  meshDirtySections();
}

function meshDirtySections(): void {
  const p = camera.position;
  world.takeDirty(MESH_BUDGET_PER_FRAME, p[0]!, p[1]!, p[2]!, dirtyBatch);
  for (const { cx, cy, cz } of dirtyBatch) {
    if (!world.hasContent(cx, cy, cz)) {
      renderer.remove(cx, cy, cz);
      continue;
    }
    extractPaddedNeighborhood(
      (x, y, z) => world.store.getState(x, y, z),
      (x, y, z) => (world.store.getSkyLight(x, y, z) << 4) | world.store.getBlockLight(x, y, z),
      (x, z) => world.store.getBiome(x, z),
      cx, cy, cz,
      jobBlocks, jobLight, jobBiomes,
    );
    const result = meshSection(
      { cx, cy, cz, rev: world.revOf(cx, cy, cz), blocks: jobBlocks, light: jobLight, biomes: jobBiomes },
      mesherTables,
    );
    if (result.layers.length > 0) renderer.upload(result);
    else renderer.remove(cx, cy, cz);
    meshedTotal++;
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
  gl.clearColor(SKY.r, SKY.g, SKY.b, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  camera.update(w / Math.max(1, h));
  frustum.update(camera.viewProjection);

  shader.use();
  shader.setMat4('uViewProj', camera.viewProjection);
  shader.setFloat('uSkyBrightness', 1);
  shader.setVec3('uFogColor', SKY.r, SKY.g, SKY.b);
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
  idleStats: () => ({ dirty: world.dirtyCount, chunks: world.chunkCount, serverPending: server.pendingChunkCount() }),
  pumpWorld,
  debugWorld: () => world,
});

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------
let firstFrameDone = false;
let hudAccum = 0;
let tickAccum = 0;

function frame(nowMs: number): void {
  clock.advance(nowMs);
  if (!sizeLocked) resizeToDisplay(canvas!, Math.min(window.devicePixelRatio || 1, 2));

  const snap = input.sample();
  if (!clock.frozen && spawned) camera.applyFreeFlight(snap, clock.dt, 12);

  // 以固定步长驱动服务端。M5 之后这段由 worker 里的 SAB 时钟负责。
  tickAccum += clock.dt * 1000;
  let ticks = 0;
  while (tickAccum >= MS_PER_TICK && ticks < 4) {
    server.tick();
    tickAccum -= MS_PER_TICK;
    ticks++;
  }
  // 追不上时丢弃积压，避免卡顿之后疯狂补 tick 造成二次卡顿
  if (tickAccum > MS_PER_TICK * 8) tickAccum = 0;

  if (ticks > 0) sendPlayerPosition(snap.sneak, snap.sprint);

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
      `fps ${clock.fps.toFixed(0)}  (${clock.frameMs.toFixed(1)} ms)  服务端 tick ${serverTick}\n` +
      `xyz ${p[0]!.toFixed(1)} ${p[1]!.toFixed(1)} ${p[2]!.toFixed(1)}\n` +
      `区块 ${world.chunkCount}  待网格 ${world.dirtyCount}  已网格 ${meshedTotal}\n` +
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

console.log(`[boot] 服务端同线程启动，种子 ${seed}，渲染距离 ${renderDistance}，${TPS} TPS`);
scheduleFrame(frame);
