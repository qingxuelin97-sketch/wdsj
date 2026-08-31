/**
 * 天空：穹顶、日月、星星、云。
 *
 * 画在世界**之前**，且**不写深度**（depthMask(false)）—— 天空永远在所有地形
 * 背后，让它参与深度测试只会带来精度问题。清屏的颜色仍然设成天空色，
 * 这样穹顶没盖到的边角也不会露出黑边。
 *
 * 所有动画相位都由 renderTick 驱动，不读挂钟（规约第 4 条）。
 * 云要在 freeze() 之后停住，否则同一个机位每次截出来的云都在不同位置。
 *
 * 天球半径 100，但整个球**跟着相机平移**。天空要表现"无限远"，做法不是真的
 * 画得很远（深度精度撑不住），而是让它永远以相机为球心。于是玩家怎么走，
 * 太阳都在同一个方向 —— 这正是真实天体的观感。
 */
import { Shader } from '../gl/shader.ts';
import { skyColorFor, celestialAngle, sunBrightness } from '../../core/world/day-night.ts';
import { buildStarField, starBrightness, moonPhase, cloudOffset, STAR_COUNT } from '../../core/world/sky.ts';

/** 云所在的高度。MC 是 108（海平面 62 之上 46 格） */
const CLOUD_HEIGHT = 108;
/** 云层平面的半边长（格）。取得比渲染距离大，边缘落在雾里看不见 */
const CLOUD_EXTENT = 512;
/**
 * 一张云贴图覆盖多少世界格。
 *
 * 贴图是 16×16，所以 192 意味着**一个云格 12 格宽** —— 这是 MC 的尺寸。
 * 第一版写的是 12（整张图才 12 格），于是每个云格只有 0.75 格宽，
 * 从 38 格之下看上去是一片噪点，不是云。
 */
const CLOUD_SCALE = 192;

const SKY_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in float aTop;
uniform mat4 uViewProj;
uniform vec3 uCamera;
uniform vec3 uTopColor;
uniform vec3 uHorizonColor;
out vec3 vColor;
void main() {
  // aTop: 1 = 天顶，0 = 地平线。颜色在两者之间插值
  vColor = mix(uHorizonColor, uTopColor, aTop);
  gl_Position = uViewProj * vec4(aPos + uCamera, 1.0);
}`;

const SKY_FRAG = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 fragColor;
void main() { fragColor = vec4(vColor, 1.0); }`;

/** 日月共用：一个贴图四边形，绕天球旋转 */
const CELESTIAL_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUv;
uniform mat4 uViewProj;
uniform vec3 uCamera;
uniform float uAngle;
out vec2 vUv;
void main() {
  vUv = aUv;
  // 绕 X 轴转：日月沿东西方向的一个大圆升落
  float c = cos(uAngle);
  float s = sin(uAngle);
  vec3 p = vec3(aPos.x, aPos.y * c - aPos.z * s, aPos.y * s + aPos.z * c);
  gl_Position = uViewProj * vec4(p + uCamera, 1.0);
}`;

const CELESTIAL_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform highp sampler2DArray uAtlas;
uniform float uLayer;
uniform float uAlpha;
out vec4 fragColor;
void main() {
  vec4 t = texture(uAtlas, vec3(vUv, uLayer));
  if (t.a < 0.02) discard;
  fragColor = vec4(t.rgb, t.a * uAlpha);
}`;

const STAR_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
uniform mat4 uViewProj;
uniform vec3 uCamera;
uniform float uAngle;
void main() {
  float c = cos(uAngle);
  float s = sin(uAngle);
  vec3 d = vec3(aPos.x, aPos.y * c - aPos.z * s, aPos.y * s + aPos.z * c);
  gl_Position = uViewProj * vec4(d * 90.0 + uCamera, 1.0);
  gl_PointSize = 2.0;
}`;

const STAR_FRAG = `#version 300 es
precision highp float;
uniform float uAlpha;
out vec4 fragColor;
void main() { fragColor = vec4(1.0, 1.0, 1.0, uAlpha); }`;

const CLOUD_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUv;
uniform mat4 uViewProj;
uniform vec3 uCamera;
uniform float uOffset;
uniform float uScale;
out vec2 vUv;
out vec2 vLocal;
void main() {
  // 云平面跟着相机水平移动（永远铺满视野），但 uv 取的是**世界坐标**，
  // 所以云本身不跟着玩家跑 —— 走过去能看到云从头顶掠过
  vec3 world = vec3(aPos.x + uCamera.x, aPos.y, aPos.z + uCamera.z);
  vUv = vec2(world.x + uOffset, world.z) / uScale;
  // 传**位置**，不传距离。四个角到相机的水平距离全都是 √2·extent，
  // 插值一个处处相等的量得到的是常数 —— 淡出系数会在整个平面上一样，
  // 表现为云要么全在要么全不在（第一版就是这么全没了的）
  vLocal = aPos.xz;
  gl_Position = uViewProj * vec4(world, 1.0);
}`;

const CLOUD_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vLocal;
uniform highp sampler2DArray uAtlas;
uniform float uLayer;
uniform vec3 uTint;
uniform float uFade;
out vec4 fragColor;
void main() {
  // 直接用 vUv，**不**套 fract：纹理已经是 REPEAT 的（这正是当初选
  // TEXTURE_2D_ARRAY 而不是图集的理由之一）。套上 fract 反而会在每个平铺
  // 边界处让 uv 的导数突变，GPU 据此选到最高一级 mip，画面上是一条条
  // 沿着三角形对角线的虚线接缝
  vec4 t = texture(uAtlas, vec3(vUv, uLayer));
  if (t.a < 0.02) discard;
  // 远处的云淡进雾里，否则云层会有一条硬邦邦的方形边界。
  // 距离必须在这里按片元算，不能在顶点着色器算好了插值过来 —— 见 vLocal 那段
  float fade = clamp(1.0 - length(vLocal) / uFade, 0.0, 1.0);
  fragColor = vec4(t.rgb * uTint, t.a * fade);
}`;

/** 天球穹顶：天顶一点 + 一圈地平线 + 天底一点。位置是相对相机的偏移 */
function buildDome(segments: number, radius: number): Float32Array {
  const out: number[] = [];
  const push = (x: number, y: number, z: number, top: number): void => { out.push(x, y, z, top); };
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    // 上半球：天顶 -> 地平线
    push(0, radius, 0, 1);
    push(Math.cos(a1) * radius, 0, Math.sin(a1) * radius, 0);
    push(Math.cos(a0) * radius, 0, Math.sin(a0) * radius, 0);
    // 下半球用地平线色铺满。往下看时不该看见虚空 ——
    // 玩家站在山顶往下俯视，视野下缘越过地形边界之后就是这里
    push(0, -radius, 0, 0);
    push(Math.cos(a0) * radius, 0, Math.sin(a0) * radius, 0);
    push(Math.cos(a1) * radius, 0, Math.sin(a1) * radius, 0);
  }
  return new Float32Array(out);
}

/** 天球上的一个正方形贴图片，旋转前正对北方地平线 */
function buildCelestialQuad(halfSize: number, distance: number): Float32Array {
  const h = halfSize;
  // +distance，不是 -distance：celestialAngle 在正午是 0，也就是**不旋转**，
  // 所以未旋转时的位置就是正午太阳该在的地方 —— 头顶正上方。
  // 写成负的会让正午天上挂着月亮、太阳在脚底下，而且这个错误在
  // 地面视角的截图里只表现为"日出时天边那点橙色位置不太对"
  const d = distance;
  return new Float32Array([
    -h, d, -h, 0, 0,
    h, d, -h, 1, 0,
    h, d, h, 1, 1,
    -h, d, -h, 0, 0,
    h, d, h, 1, 1,
    -h, d, h, 0, 1,
  ]);
}

function buildCloudPlane(extent: number, height: number): Float32Array {
  const e = extent;
  return new Float32Array([
    -e, height, -e, 0, 0,
    e, height, -e, 1, 0,
    e, height, e, 1, 1,
    -e, height, -e, 0, 0,
    e, height, e, 1, 1,
    -e, height, e, 0, 1,
  ]);
}

export interface SkyFrame {
  readonly viewProj: Float32Array;
  readonly cameraX: number;
  readonly cameraY: number;
  readonly cameraZ: number;
  readonly timeOfDay: number;
  readonly worldAge: number;
  /** 渲染刻。云的漂移由它驱动 —— 不许读挂钟 */
  readonly renderTick: number;
  readonly rain: number;
  readonly texture: WebGLTexture;
  /** 图集里的层号，由入口按贴图名查好传进来 */
  readonly sunLayer: number;
  readonly moonLayers: readonly number[];
  readonly cloudLayer: number;
  readonly renderDistance: number;
  /**
   * −1 下界 / 0 主世界 / 1 末地。
   *
   * 下界与末地**不画太阳、月亮、云**，只留一个常色的穹顶 ——
   * 那两个地方抬头看见太阳是一眼假，比什么都出戏。
   */
  readonly dimension: number;
}

export class SkyRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly domeShader: Shader;
  private readonly celestialShader: Shader;
  private readonly starShader: Shader;
  private readonly cloudShader: Shader;
  private readonly domeVao: WebGLVertexArrayObject;
  private readonly domeVerts: number;
  private readonly quadVao: WebGLVertexArrayObject;
  private readonly starVao: WebGLVertexArrayObject;
  private readonly cloudVao: WebGLVertexArrayObject;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.domeShader = new Shader(gl, SKY_VERT, SKY_FRAG, 'sky-dome');
    this.celestialShader = new Shader(gl, CELESTIAL_VERT, CELESTIAL_FRAG, 'sky-celestial');
    this.starShader = new Shader(gl, STAR_VERT, STAR_FRAG, 'sky-stars');
    this.cloudShader = new Shader(gl, CLOUD_VERT, CLOUD_FRAG, 'sky-clouds');

    const dome = buildDome(16, 100);
    this.domeVerts = dome.length / 4;
    this.domeVao = this.makeVao(dome, [[0, 3, 16, 0], [1, 1, 16, 12]]);
    this.quadVao = this.makeVao(buildCelestialQuad(15, 100), [[0, 3, 20, 0], [1, 2, 20, 12]]);
    this.starVao = this.makeVao(buildStarField(), [[0, 3, 12, 0]]);
    this.cloudVao = this.makeVao(
      buildCloudPlane(CLOUD_EXTENT, CLOUD_HEIGHT), [[0, 3, 20, 0], [1, 2, 20, 12]],
    );
  }

  private makeVao(data: Float32Array, attrs: readonly (readonly [number, number, number, number])[]): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    for (const [loc, size, stride, offset] of attrs) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
    }
    gl.bindVertexArray(null);
    return vao;
  }

  /**
   * 画天空。必须在世界之前调用。
   *
   * 全程 depthMask(false)：天空只提供颜色，深度缓冲留给地形。
   */
  render(f: SkyFrame): void {
    const gl = this.gl;
    // 必须把 rain 传进去。只改 clearColor 是不够的 —— 穹顶整个盖在清屏色
    // 上面，玩家看到的是穹顶。第一版就是这么"下着雨天却still是蓝的"
    const sky = skyColorFor(f.dimension, f.timeOfDay, f.rain);
    // 没有天光的维度：画完穹顶就收工。星星、日月、云一概不画
    const celestial = f.dimension === 0;
    // 天顶比地平线稍深、稍蓝。这个差值就是"天空有层次"的全部来源 ——
    // 单一颜色的天空看起来像一块背景板，而不是一片天
    const topR = sky.r * 0.78;
    const topG = sky.g * 0.86;
    const topB = Math.min(1, sky.b * 1.06);

    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);

    this.domeShader.use();
    this.domeShader.setMat4('uViewProj', f.viewProj);
    this.domeShader.setVec3('uCamera', f.cameraX, f.cameraY, f.cameraZ);
    this.domeShader.setVec3('uTopColor', topR, topG, topB);
    this.domeShader.setVec3('uHorizonColor', sky.r, sky.g, sky.b);
    gl.bindVertexArray(this.domeVao);
    gl.drawArrays(gl.TRIANGLES, 0, this.domeVerts);

    if (!celestial) {
      // 状态要还原，不然下一次画世界时深度写入还是关着的
      gl.depthMask(true);
      gl.enable(gl.CULL_FACE);
      return;
    }

    // 天体角度：0 tick（日出）时太阳在东方地平线上
    const angle = celestialAngle(f.timeOfDay) * Math.PI * 2;

    // --- 星星 ---
    const stars = starBrightness(f.timeOfDay, f.rain);
    if (stars > 0.01) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      this.starShader.use();
      this.starShader.setMat4('uViewProj', f.viewProj);
      this.starShader.setVec3('uCamera', f.cameraX, f.cameraY, f.cameraZ);
      this.starShader.setFloat('uAngle', angle);
      this.starShader.setFloat('uAlpha', stars);
      gl.bindVertexArray(this.starVao);
      gl.drawArrays(gl.POINTS, 0, STAR_COUNT);
      gl.disable(gl.BLEND);
    }

    // --- 日月 ---
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.celestialShader.use();
    this.celestialShader.setMat4('uViewProj', f.viewProj);
    this.celestialShader.setVec3('uCamera', f.cameraX, f.cameraY, f.cameraZ);
    this.celestialShader.setInt('uAtlas', 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, f.texture);
    gl.bindVertexArray(this.quadVao);

    // 太阳在 angle，月亮在正对面，所以 angle + π
    this.celestialShader.setFloat('uAngle', angle);
    this.celestialShader.setFloat('uLayer', f.sunLayer);
    this.celestialShader.setFloat('uAlpha', 1 - f.rain * 0.8);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    const phase = moonPhase(f.worldAge);
    this.celestialShader.setFloat('uAngle', angle + Math.PI);
    this.celestialShader.setFloat('uLayer', f.moonLayers[phase] ?? f.moonLayers[0] ?? 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // --- 云 ---
    // 只在相机低于云层时画。飞到云上时从上往下看会看见云的背面，
    // 而这个平面是单面的 —— 与其做双面，不如承认 1.0 里玩家极少上到 108
    if (f.cameraY < CLOUD_HEIGHT) {
      this.cloudShader.use();
      this.cloudShader.setMat4('uViewProj', f.viewProj);
      this.cloudShader.setVec3('uCamera', f.cameraX, f.cameraY, f.cameraZ);
      this.cloudShader.setFloat('uOffset', cloudOffset(f.renderTick));
      this.cloudShader.setFloat('uScale', CLOUD_SCALE);
      this.cloudShader.setFloat('uLayer', f.cloudLayer);
      // 云的亮度直接用 sunBrightness（0.2 夜 .. 1.0 昼）。
      //
      // 自己拿天空色凑一个亮度是第一版的做法，结果午夜的云有 0.69 的亮度 ——
      // 一片灰白糊在星空前面，比月亮还显眼。而 MC 早就有这条曲线了，
      // 它算的正是"这一刻有多少阳光"，云该有多亮本来就该问它。
      // （规约：MC 有的常数就照抄，自己估的数都是将来的 bug）
      const lum = sunBrightness(f.timeOfDay, f.rain);
      this.cloudShader.setVec3('uTint', lum, lum, lum);
      this.cloudShader.setFloat('uFade', f.renderDistance * 16 * 1.4);
      this.cloudShader.setInt('uAtlas', 0);
      gl.bindVertexArray(this.cloudVao);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.depthMask(true);
  }
}
