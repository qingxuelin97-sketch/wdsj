/**
 * 雨和雪。
 *
 * 做法照抄 MC：以玩家为中心的一圈方格里，每一列画一条**竖直的贴图带**，
 * 从地面一直到头顶上方。不是粒子系统 —— 一场雨要几千个粒子才铺得满视野，
 * 而这样只要一百来个四边形，且天然做到"雨从天上下到地上"而不是
 * "一堆点在空中飘"。
 *
 * 三件事让它看起来像雨而不是像贴图：
 *   1. **每列独立的相位偏移**。同相位的话整片雨会像一块布一样上下抖
 *   2. 雨快、雪慢，而且雪还左右飘（用列坐标做种子，不用随机数 ——
 *      随机数会让 freeze() 之后的画面不可复现）
 *   3. 雨带朝向相机（billboard），所以转身时雨还是竖的
 *
 * 每列画什么由**群系**决定：沙漠那一列什么都不画，雪原画雪。
 * 所以站在沙漠边上能看见雨在几十格外停住 —— 这是 MC 的经典画面。
 *
 * 动画相位来自 renderTick，不读挂钟（规约第 4 条）。
 */
import { Shader } from '../gl/shader.ts';
import { precipitationOf } from '../../content/biomes.ts';
import type { ChunkStore } from '../../core/world/block-view.ts';

/** 以玩家为中心画多大一圈。MC 是 5（11×11 列） */
const RADIUS = 5;
/** 雨带以相机为中心，上下各张开多少格 */
const HALF_SPAN = 10;
/** 一列雨带的宽度 */
const WIDTH = 1;
/** 每列最多能画的四边形数 */
const MAX_COLUMNS = (RADIUS * 2 + 1) * (RADIUS * 2 + 1);
/** 贴图每多少格重复一次。越小雨丝越短越密 */
const TILE_BLOCKS = 2;
/** 雨往下掉多快（uv 每刻走多少），雪慢得多 */
const RAIN_SPEED = 0.12;
const SNOW_SPEED = 0.02;
/** 每个顶点几个 float：位置 3 + uv 2 + alpha 1 */
const FLOATS_PER_VERTEX = 6;
const VERTS_PER_QUAD = 6;

const VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUv;
layout(location = 2) in float aAlpha;
uniform mat4 uViewProj;
out vec2 vUv;
out float vAlpha;
void main() {
  vUv = aUv;
  vAlpha = aAlpha;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
in float vAlpha;
uniform highp sampler2DArray uAtlas;
uniform float uLayer;
uniform float uStrength;
uniform vec3 uTint;
out vec4 fragColor;
void main() {
  // textureLod(..., 0.0) 强制用**最高一级** mip。
  //
  // 雨丝在贴图里只有一两个像素宽，而雨带是斜着看的窄条 —— GPU 据此
  // 选到很高的 mip，那一级上一根根雨丝早已被平均成一片糊。
  // 画出来是一团团飘着的白斑，第一版就是这样，看着像烟不像雨。
  vec4 t = textureLod(uAtlas, vec3(fract(vUv), uLayer), 0.0);
  if (t.a < 0.05) discard;
  fragColor = vec4(t.rgb * uTint, t.a * vAlpha * uStrength);
}`;

export interface WeatherFrame {
  readonly viewProj: Float32Array;
  readonly cameraX: number;
  readonly cameraY: number;
  readonly cameraZ: number;
  readonly cameraYaw: number;
  /** 0..1，服务端权威的雨强度 */
  readonly rain: number;
  /** 渲染刻，驱动下落相位 */
  readonly renderTick: number;
  readonly store: ChunkStore;
  readonly texture: WebGLTexture;
  readonly rainLayer: number;
  readonly snowLayer: number;
  /** 天色，雨要跟着环境光变暗，否则夜里的雨是一片亮白 */
  readonly brightness: number;
}

export class WeatherRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly shader: Shader;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffer: WebGLBuffer;
  private readonly data: Float32Array;
  /** 上一帧画了多少列，供 F3 显示 */
  lastColumns = 0;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.shader = new Shader(gl, VERT, FRAG, 'weather');
    this.data = new Float32Array(MAX_COLUMNS * VERTS_PER_QUAD * FLOATS_PER_VERTEX);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    const stride = FLOATS_PER_VERTEX * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 20);
    gl.bindVertexArray(null);
  }

  render(f: WeatherFrame): void {
    if (f.rain <= 0.01) {
      this.lastColumns = 0;
      return;
    }
    const gl = this.gl;

    // 雨带正对相机。只用 yaw，不用 pitch —— 抬头看时雨该还是竖的，
    // 跟着 pitch 转的话雨会在仰视时躺平成一片
    const sin = Math.sin(f.cameraYaw);
    const cos = Math.cos(f.cameraYaw);

    const cx = Math.floor(f.cameraX);
    const cz = Math.floor(f.cameraZ);
    const d = this.data;

    /**
     * 把一种降水的所有列写进顶点缓冲，返回写到哪。
     *
     * 雨和雪**分两趟**攒，因为它们是两张贴图，一次 drawArrays 只能绑一张。
     * 分不开的后果是群系边界上雨会被画成雪 —— 而那正是最容易被看见的地方，
     * 玩家站在雪原边上看着雨变成雪本来是这个系统最好看的一幕。
     */
    const emit = (want: 'rain' | 'snow', from: number): number => {
      let n = from;
      for (let dz = -RADIUS; dz <= RADIUS; dz++) {
        for (let dx = -RADIUS; dx <= RADIUS; dx++) {
          // 圆形而不是方形：方形的话斜角方向的雨比正前方远 1.4 倍，
          // 边界是一个能看出来的方框
          const dist2 = dx * dx + dz * dz;
          if (dist2 > RADIUS * RADIUS) continue;

          const x = cx + dx;
          const z = cz + dz;
          if (precipitationOf(f.store.getBiome(x, z)) !== want) continue;

          // 地面高度。区块没加载就跳过 —— 画一根悬空的雨柱比不画更难看
          const ground = f.store.getHeight(x, z);
          if (ground <= 0) continue;

          // 边缘淡出，不然雨在半径处会被一刀切断。
          //
          // 近处也要淡：相机正站在 dx=dz=0 那一列里，那条雨带贴着镜头，
          // 一条就能糊住半个屏幕。真实感来自远处那一圈，不是脸上这一条
          const dist = Math.sqrt(dist2);
          // 两头都要淡：
          //   远端 —— 不淡的话雨在半径处被一刀切断，是个能看见的圆边
          //   近端 —— 相机就站在中心那一列里，两三格内的雨带几乎与视线共面，
          //           一条就能糊住半个屏幕。这些近处的带子贡献的不是"雨"，
          //           是一层白雾。真实感全部来自中远处那一圈
          const near = Math.min(1, Math.max(0, (dist - 1.2) / 2));
          const far = 1 - dist / (RADIUS + 1);
          const alpha = near * far;

          // 每列独立相位：用坐标哈希，不用随机数 —— 随机数会让
          // freeze() 之后的画面每帧都变，截图回归就废了
          const phase = ((x * 73856093) ^ (z * 19349663)) & 1023;
          const speed = want === 'snow' ? SNOW_SPEED : RAIN_SPEED;
          const vOffset = (f.renderTick * speed + phase * 0.01) % 1;
          // 雪左右飘，雨不飘
          const sway = want === 'snow' ? Math.sin(f.renderTick * 0.03 + phase) * 0.35 : 0;

          const bx = x + 0.5 + sway;
          const bz = z + 0.5;
          // 雨带**以相机为中心**上下张开，再截到地面为止。
          //
          // 写成"从地面往上 HEIGHT 格"是不行的：站在高处往下看时，
          // 雨带整个落在视线下方，画面里只有脚下一圈短桩，头顶一滴没有。
          // 而下雨时人第一眼看的就是头顶。
          const y1 = f.cameraY + HALF_SPAN;
          const y0 = Math.max(ground, f.cameraY - HALF_SPAN);
          if (y1 <= y0) continue;
          // 沿着"垂直于视线"的方向张开，得到一条正对相机的竖带
          const ex = cos * WIDTH * 0.5;
          const ez = -sin * WIDTH * 0.5;
          // v 从上往下增长，加上随时间增长的 vOffset 就是往下落。
          //
          // 每 TILE_BLOCKS 格重复一次贴图。这个数直接决定一条雨丝有多长：
          // 第一版用了 HEIGHT/4，也就是一条雨丝拉到 4 格高，画出来是一道
          // 缓缓飘的白痕，完全不像在下落
          const vTop = vOffset;
          const vBot = vOffset + (y1 - y0) / TILE_BLOCKS;

          const push = (px: number, py: number, pz: number, u: number, v: number): void => {
            d[n++] = px; d[n++] = py; d[n++] = pz;
            d[n++] = u; d[n++] = v; d[n++] = alpha;
          };
          push(bx - ex, y1, bz - ez, 0, vTop);
          push(bx + ex, y1, bz + ez, 1, vTop);
          push(bx + ex, y0, bz + ez, 1, vBot);
          push(bx - ex, y1, bz - ez, 0, vTop);
          push(bx + ex, y0, bz + ez, 1, vBot);
          push(bx - ex, y0, bz - ez, 0, vBot);
        }
      }
      return n;
    };

    const rainEnd = emit('rain', 0);
    const snowEnd = emit('snow', rainEnd);
    this.lastColumns = snowEnd / (VERTS_PER_QUAD * FLOATS_PER_VERTEX);
    if (snowEnd === 0) return;

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, d.subarray(0, snowEnd));

    this.shader.use();
    this.shader.setMat4('uViewProj', f.viewProj);
    this.shader.setFloat('uStrength', f.rain);
    this.shader.setInt('uAtlas', 0);
    const b = f.brightness;
    this.shader.setVec3('uTint', b, b, b);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, f.texture);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    // 不写深度：雨带互相之间不该遮挡，写了会因为绘制顺序产生方块状的缺口
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);

    const rainVerts = rainEnd / FLOATS_PER_VERTEX;
    const snowVerts = (snowEnd - rainEnd) / FLOATS_PER_VERTEX;
    if (rainVerts > 0) {
      this.shader.setFloat('uLayer', f.rainLayer);
      gl.drawArrays(gl.TRIANGLES, 0, rainVerts);
    }
    if (snowVerts > 0) {
      this.shader.setFloat('uLayer', f.snowLayer);
      gl.drawArrays(gl.TRIANGLES, rainVerts, snowVerts);
    }

    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }
}
