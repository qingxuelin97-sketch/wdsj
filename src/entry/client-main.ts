/**
 * 客户端入口。
 *
 * M1：真正的方块注册表 + 区块存储 + 18³ padded 网格化 + 多子区块渲染 + 视锥剔除。
 * 世界内容目前来自 client/debug/test-world.ts，M2 会换成服务端的世界生成。
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
import { buildTestWorld } from '../client/debug/test-world.ts';
import { createBlockRegistry } from '../content/blocks.ts';
import { extractPaddedNeighborhood } from '../core/world/chunk-codec.ts';
import { Frustum } from '../core/math/frustum.ts';
import { SECTIONS_PER_COLUMN, SECTION_SIZE, DEFAULT_RENDER_DISTANCE } from '../core/constants.ts';
import { TILE_SIZE } from '../client/render/texgen.ts';

const canvas = document.getElementById('gl') as HTMLCanvasElement | null;
const hud = document.getElementById('hud');
const hint = document.getElementById('hint');
if (canvas === null) throw new Error('找不到 #gl canvas');

const { gl, caps, anisoExt } = createContext(canvas);
recordLog(`GPU: ${caps.rendererName}`);
console.log(`[gl] ${caps.rendererName}`);

// ---------------------------------------------------------------------------
// 方块表与贴图
// ---------------------------------------------------------------------------
const registry = createBlockRegistry();
const tables = registry.getTables();
const atlas = buildAtlas(tables.collectTextureNames());
const faceLayer = buildFaceLayerTable(tables, atlas);
recordLog(`方块 ${registry.size} 种 · 贴图 ${atlas.layers} 张`);
console.log(`[content] ${registry.size} 种方块, ${atlas.layers} 张贴图`);

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
gl.texSubImage3D(
  gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0,
  TILE_SIZE, TILE_SIZE, atlas.layers,
  gl.RGBA, gl.UNSIGNED_BYTE, atlas.data,
);
gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
// 放大用最近邻保住像素画硬边；缩小走 mipmap 防止远处闪烁。
// 数组纹理的 mip 不跨层，所以不需要任何 padding。
gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
if (anisoExt !== null) {
  gl.texParameterf(gl.TEXTURE_2D_ARRAY, anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(4, caps.maxAnisotropy));
}

// ---------------------------------------------------------------------------
// 世界与网格化
// ---------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed') ?? 1234);
const chunkRadius = Number(params.get('radius') ?? 2);

const tStart = performance.now();
const world = buildTestWorld(registry, { seed, chunkRadius });
const tGen = performance.now();

const renderer = new ChunkRenderer(gl);
const frustum = new Frustum();

// 网格化任务的输入缓冲：所有子区块复用同一组，避免每次分配 18 KB
const jobBlocks = new Uint16Array(PADDED_VOLUME);
const jobLight = new Uint8Array(PADDED_VOLUME);
const jobBiomes = new Uint8Array(PADDED_AREA);

let meshedSections = 0;
for (const chunk of world.chunkValues()) {
  for (let sy = 0; sy < SECTIONS_PER_COLUMN; sy++) {
    const section = chunk.sections[sy];
    if (section == null || section.isEmpty) continue;
    extractPaddedNeighborhood(
      (x, y, z) => world.getState(x, y, z),
      (x, y, z) => (world.getSkyLight(x, y, z) << 4) | world.getBlockLight(x, y, z),
      (x, z) => world.getBiome(x, z),
      chunk.cx, sy, chunk.cz,
      jobBlocks, jobLight, jobBiomes,
    );
    const result = meshSection(
      { cx: chunk.cx, cy: sy, cz: chunk.cz, rev: 1, blocks: jobBlocks, light: jobLight, biomes: jobBiomes },
      mesherTables,
    );
    if (result.layers.length > 0) {
      renderer.upload(result);
      meshedSections++;
    }
  }
}
const tMesh = performance.now();
console.log(
  `[world] 生成 ${(tGen - tStart).toFixed(0)}ms · 网格化 ${meshedSections} 段 ${(tMesh - tGen).toFixed(0)}ms · ` +
    `${(renderer.totalBytes / 1048576).toFixed(1)} MB 顶点数据`,
);
recordLog(`世界 ${world.size} 区块 · 网格 ${meshedSections} 段 · ${(renderer.totalBytes / 1048576).toFixed(1)} MB`);

// ---------------------------------------------------------------------------
// 运行时
// ---------------------------------------------------------------------------
const clock = new Clock();
const camera = new Camera();
camera.setPosition(-14, 52, -14);
camera.setRotation(-Math.PI * 0.25, 0.38);
camera.far = 320;
const input = new Input(canvas);
const shader = new Shader(gl, BLOCK_VERT_SRC, BLOCK_FRAG_SRC, 'block');
const tintColors = tintColorArray();

const SKY = { r: 0.62, g: 0.76, b: 0.98 };
let sizeLocked = false;

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
  shader.setFloat('uFogStart', DEFAULT_RENDER_DISTANCE * SECTION_SIZE * 0.7);
  shader.setFloat('uFogEnd', DEFAULT_RENDER_DISTANCE * SECTION_SIZE * 1.6);
  shader.setInt('uAtlas', 0);
  const tintLoc = shader.loc('uTintColors[0]');
  if (tintLoc !== null) gl.uniform3fv(tintLoc, tintColors);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);

  renderer.render(shader, frustum, camera.position[0]!, camera.position[1]!, camera.position[2]!);
}

installTestHook({
  clock,
  camera,
  input,
  canvas,
  renderOnce,
  drawStats: () => ({ drawCalls: renderer.drawCalls, quads: renderer.quadsDrawn }),
  setSizeLock: (locked: boolean) => {
    sizeLocked = locked;
  },
});

let firstFrameDone = false;
let hudAccum = 0;

function frame(nowMs: number): void {
  clock.advance(nowMs);
  if (!sizeLocked) resizeToDisplay(canvas!, Math.min(window.devicePixelRatio || 1, 2));

  const snap = input.sample();
  if (!clock.frozen) camera.applyFreeFlight(snap, clock.dt, 12);

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
      `fps ${clock.fps.toFixed(0)}  (${clock.frameMs.toFixed(1)} ms)\n` +
      `xyz ${p[0]!.toFixed(1)} ${p[1]!.toFixed(1)} ${p[2]!.toFixed(1)}\n` +
      `yaw ${((camera.yaw * 180) / Math.PI).toFixed(0)}  pitch ${((camera.pitch * 180) / Math.PI).toFixed(0)}\n` +
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

scheduleFrame(frame);
