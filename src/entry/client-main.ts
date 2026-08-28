/**
 * 客户端入口。M0：把工具链、顶点格式、纹理数组、相机、输入、测试钩子串成第一帧。
 *
 * 这一版故意直接用最终的 12 字节顶点格式和 TEXTURE_2D_ARRAY，而不是随便画个四边形 ——
 * 这两件事是 M1 网格化的地基，越早跑通越好。
 */
import { createContext, resizeToDisplay } from '../client/gl/context.ts';
import { Shader } from '../client/gl/shader.ts';
import { Clock } from '../client/clock.ts';
import { Camera } from '../client/camera.ts';
import { Input } from '../client/input/input.ts';
import { installTestHook, recordError, recordLog } from '../client/debug/test-hook.ts';
import { scheduleFrame } from '../client/frame-scheduler.ts';
import { BLOCK_VERT_SRC, BLOCK_FRAG_SRC, VERTEX_STRIDE } from '../client/render/block-shader.ts';
import { generateTileArray, TILE_SIZE } from '../client/render/texgen.ts';
import { meshSection, sectionIndex, type BlockAppearance } from '../client/mesh/simple-mesher.ts';
import { SECTION_SIZE, DEFAULT_RENDER_DISTANCE } from '../core/constants.ts';
import { noiseFromSeed } from '../core/noise/perlin.ts';

const canvas = document.getElementById('gl') as HTMLCanvasElement | null;
const hud = document.getElementById('hud');
const hint = document.getElementById('hint');
if (canvas === null) throw new Error('找不到 #gl canvas');

const { gl, caps, anisoExt } = createContext(canvas);
recordLog(`GPU: ${caps.rendererName} | ${caps.vendorName}`);
recordLog(`纹理数组层上限 ${caps.maxArrayTextureLayers} · 各向异性上限 ${caps.maxAnisotropy}`);
console.log(`[gl] ${caps.rendererName}`);

// ---------------------------------------------------------------------------
// 贴图：程序化生成后上传成 2D 纹理数组
// ---------------------------------------------------------------------------
const atlas = generateTileArray();
const texture = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
// mip 层数：16×16 一路降到 1×1 是 5 层
const mipLevels = Math.floor(Math.log2(TILE_SIZE)) + 1;
gl.texStorage3D(gl.TEXTURE_2D_ARRAY, mipLevels, gl.RGBA8, TILE_SIZE, TILE_SIZE, atlas.layers);
gl.texSubImage3D(
  gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0,
  TILE_SIZE, TILE_SIZE, atlas.layers,
  gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(atlas.data.buffer),
);
gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
// 放大用最近邻保住像素画的硬边；缩小走 mipmap 避免远处闪烁。
// 数组纹理的 mip 不跨层，所以这里不需要任何 padding —— 图集方案的渗色问题在这里不存在。
gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
if (anisoExt !== null) {
  gl.texParameterf(gl.TEXTURE_2D_ARRAY, anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(4, caps.maxAnisotropy));
}

const L = (name: string): number => {
  const i = atlas.index.get(name);
  if (i === undefined) throw new Error(`贴图未生成: ${name}`);
  return i;
};

// 方块 id -> 六面贴图。面序：DOWN UP NORTH SOUTH WEST EAST
const BLOCK = { AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, COBBLE: 4, PLANKS: 5, LOG: 6, LEAVES: 7, SAND: 8, COAL: 9, IRON: 10, DIAMOND: 11, BEDROCK: 12 } as const;
const appearance = new Map<number, BlockAppearance>([
  [BLOCK.GRASS, { layers: [L('dirt'), L('grass_top'), L('grass_side'), L('grass_side'), L('grass_side'), L('grass_side')] }],
  [BLOCK.DIRT, { layers: [L('dirt'), L('dirt'), L('dirt'), L('dirt'), L('dirt'), L('dirt')] }],
  [BLOCK.STONE, { layers: [L('stone'), L('stone'), L('stone'), L('stone'), L('stone'), L('stone')] }],
  [BLOCK.COBBLE, { layers: [L('cobblestone'), L('cobblestone'), L('cobblestone'), L('cobblestone'), L('cobblestone'), L('cobblestone')] }],
  [BLOCK.PLANKS, { layers: [L('planks'), L('planks'), L('planks'), L('planks'), L('planks'), L('planks')] }],
  [BLOCK.LOG, { layers: [L('log_top'), L('log_top'), L('log_side'), L('log_side'), L('log_side'), L('log_side')] }],
  [BLOCK.LEAVES, { layers: [L('leaves'), L('leaves'), L('leaves'), L('leaves'), L('leaves'), L('leaves')] }],
  [BLOCK.SAND, { layers: [L('sand'), L('sand'), L('sand'), L('sand'), L('sand'), L('sand')] }],
  [BLOCK.COAL, { layers: [L('coal_ore'), L('coal_ore'), L('coal_ore'), L('coal_ore'), L('coal_ore'), L('coal_ore')] }],
  [BLOCK.IRON, { layers: [L('iron_ore'), L('iron_ore'), L('iron_ore'), L('iron_ore'), L('iron_ore'), L('iron_ore')] }],
  [BLOCK.DIAMOND, { layers: [L('diamond_ore'), L('diamond_ore'), L('diamond_ore'), L('diamond_ore'), L('diamond_ore'), L('diamond_ore')] }],
  [BLOCK.BEDROCK, { layers: [L('bedrock'), L('bedrock'), L('bedrock'), L('bedrock'), L('bedrock'), L('bedrock')] }],
]);

// ---------------------------------------------------------------------------
// 测试用的 section：用 Perlin 起伏的地面 + 一排材质柱
// ---------------------------------------------------------------------------
const S = SECTION_SIZE;
const blocks = new Uint16Array(S * S * S);
const terrainNoise = noiseFromSeed(1234, 0x7e44, 3);

for (let z = 0; z < S; z++) {
  for (let x = 0; x < S; x++) {
    const h = 3 + Math.round((terrainNoise.noise2(x * 0.12, z * 0.12) + 1) * 2.2);
    for (let y = 0; y < h && y < S; y++) {
      blocks[sectionIndex(x, y, z)] = y === 0 ? BLOCK.BEDROCK : y === h - 1 ? BLOCK.GRASS : y > h - 4 ? BLOCK.DIRT : BLOCK.STONE;
    }
  }
}
// 一排材质柱，方便肉眼核对每种贴图与六面朝向
const showcase = [BLOCK.COBBLE, BLOCK.PLANKS, BLOCK.LOG, BLOCK.LEAVES, BLOCK.SAND, BLOCK.COAL, BLOCK.IRON, BLOCK.DIAMOND];
for (let i = 0; i < showcase.length; i++) {
  const x = 2 + i;
  const z = 13;
  for (let y = 8; y < 11; y++) blocks[sectionIndex(x, y, z)] = showcase[i]!;
}

const mesh = meshSection(blocks, appearance, 15);
console.log(`[mesh] ${mesh.quadCount} 个面, ${mesh.vertices.byteLength / 1024 | 0} KB 顶点数据`);
recordLog(`mesh: ${mesh.quadCount} quads`);

// ---------------------------------------------------------------------------
// 上传 VAO
// ---------------------------------------------------------------------------
const vao = gl.createVertexArray();
gl.bindVertexArray(vao);
const vbo = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
// 关键：整数属性必须用 vertexAttribIPointer，用 vertexAttribPointer 会被当成浮点归一化
gl.enableVertexAttribArray(0);
gl.vertexAttribIPointer(0, 3, gl.UNSIGNED_INT, VERTEX_STRIDE, 0);
const ebo = gl.createBuffer();
gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
gl.bindVertexArray(null);

const shader = new Shader(gl, BLOCK_VERT_SRC, BLOCK_FRAG_SRC, 'block');

// ---------------------------------------------------------------------------
// 运行时
// ---------------------------------------------------------------------------
const clock = new Clock();
const camera = new Camera();
// 站在 section 的 -X-Z 角外侧，朝 +X+Z 方向俯视中心 (8,6,8)。
// 注意 yaw 是负的：forward.x = -sin(yaw)*cos(pitch)，要朝 +X 看就得 sin(yaw)<0。
camera.setPosition(-6, 14, -6);
camera.setRotation(-Math.PI * 0.25, 0.386);
const input = new Input(canvas);

const SKY = { r: 0.62, g: 0.76, b: 0.98 };
let drawCalls = 0;
/** 被 __mc.setCanvasSize 锁定时，主循环不再按窗口尺寸重算绘制缓冲 */
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

  shader.use();
  shader.setMat4('uViewProj', camera.viewProjection);
  shader.setVec3('uSectionOrigin', 0, 0, 0);
  shader.setFloat('uSkyBrightness', 1);
  shader.setVec3('uFogColor', SKY.r, SKY.g, SKY.b);
  shader.setVec3('uCameraPos', camera.position[0]!, camera.position[1]!, camera.position[2]!);
  shader.setFloat('uFogStart', DEFAULT_RENDER_DISTANCE * 16 * 0.55);
  shader.setFloat('uFogEnd', DEFAULT_RENDER_DISTANCE * 16 * 0.95);
  shader.setInt('uAtlas', 0);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);

  gl.bindVertexArray(vao);
  gl.drawElements(gl.TRIANGLES, mesh.quadCount * 6, gl.UNSIGNED_INT, 0);
  gl.bindVertexArray(null);
  drawCalls = 1;
}

installTestHook({
  clock,
  camera,
  input,
  canvas,
  renderOnce,
  drawStats: () => ({ drawCalls, quads: mesh.quadCount }),
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
    const api = (globalThis as unknown as { __mc: { _markReady(): void } }).__mc;
    api._markReady();
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
      `quads ${mesh.quadCount}  draws ${drawCalls}  tick ${clock.renderTick}`;
  }
  if (hint !== null) hint.classList.toggle('hidden', input.pointerLocked);

  scheduleFrame(frame);
}

// WebGL 的错误不会抛异常，必须主动查；只在启动后查一次，热路径里查会强制同步。
const err = gl.getError();
if (err !== gl.NO_ERROR) {
  const msg = `WebGL 错误 0x${err.toString(16)}`;
  recordError(msg);
  console.error(msg);
}

scheduleFrame(frame);
