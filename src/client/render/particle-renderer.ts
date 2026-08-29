/**
 * 方块破碎粒子。
 *
 * 每个粒子是一个朝向相机的小方片，贴图取自**被破坏方块自己的贴图**的一小块。
 * 这一点是"像 MC"的关键：碎屑的颜色必须来自那块方块，用统一的灰点或纯色球
 * 立刻就假了 —— 挖草出绿屑、挖石出灰屑，玩家不会意识到自己在读这个信息，
 * 但缺了就是不对。
 *
 * 粒子的运动用和玩家同一套的重力/阻尼常数，但**不做方块碰撞**：
 * 几十个粒子每帧扫一遍碰撞不值当，而且它们活不到 1 秒，穿墙几乎看不出来。
 */
import { Shader } from '../gl/shader.ts';
import { GRAVITY, DRAG_VERTICAL } from '../../core/constants.ts';

/** 同时存在的粒子上限。超了就覆盖最老的，绝不增长数组 */
const MAX_PARTICLES = 512;
/** 每个方块碎多少片 */
const PER_BLOCK = 24;
/** 每个粒子的浮点数：位置 3 + uv 2 + 层 1 + 尺寸 1 + 亮度 1 + 群系染色 3 */
const FLOATS_PER_VERTEX = 11;

const VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aCenter;
layout(location = 1) in vec2 aUv;
layout(location = 2) in float aLayer;
layout(location = 3) in float aSize;
layout(location = 4) in float aShade;
layout(location = 5) in vec2 aCorner;
layout(location = 6) in vec3 aTint;

uniform mat4 uViewProj;
uniform vec3 uRight;
uniform vec3 uUp;

out vec2 vUv;
flat out float vLayer;
out float vShade;
out vec3 vTint;

void main() {
  // 朝向相机的方片：用相机的右向量与上向量展开，永远正对镜头
  vec3 world = aCenter + uRight * (aCorner.x * aSize) + uUp * (aCorner.y * aSize);
  // 贴图只取方块贴图里的一小块（1/4 格），碎屑才有细节而不是一团糊
  vUv = aUv + (aCorner + 0.5) * 0.25;
  vLayer = aLayer;
  vShade = aShade;
  vTint = aTint;
  gl_Position = uViewProj * vec4(world, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 vUv;
flat in float vLayer;
in float vShade;
in vec3 vTint;
uniform sampler2DArray uAtlas;
out vec4 fragColor;
void main() {
  vec4 tex = texture(uAtlas, vec3(vUv, vLayer));
  if (tex.a < 0.5) discard;
  // 草和树叶的贴图是灰度的，颜色全靠群系染色乘上去。
  // 碎屑不乘的话挖草会掉白色的渣 —— 玩家不会意识到自己在读这个信息，
  // 但缺了就是不对。
  fragColor = vec4(tex.rgb * vTint * vShade, 1.0);
}`;

interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** 剩余寿命（tick） */
  life: number;
  u: number; v: number;
  layer: number;
  size: number;
  shade: number;
  tr: number; tg: number; tb: number;
}

export class ParticleRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly shader: Shader;
  private readonly vao: WebGLVertexArrayObject;
  private readonly instanceBuffer: WebGLBuffer;
  private readonly instanceData = new Float32Array(MAX_PARTICLES * FLOATS_PER_VERTEX);
  private readonly particles: Particle[] = [];
  private cursor = 0;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.shader = new Shader(gl, VERT, FRAG, 'particle');

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    // 一个方片的四个角，两个三角形
    const corners = new Float32Array([
      -0.5, -0.5, 0.5, -0.5, 0.5, 0.5,
      -0.5, -0.5, 0.5, 0.5, -0.5, 0.5,
    ]);
    const cornerBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, corners, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 2, gl.FLOAT, false, 8, 0);

    this.instanceBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.byteLength, gl.DYNAMIC_DRAW);
    const stride = FLOATS_PER_VERTEX * 4;
    const attrib = (loc: number, size: number, offset: number): void => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(loc, 1);
    };
    attrib(0, 3, 0);   // center
    attrib(1, 2, 12);  // uv
    attrib(2, 1, 20);  // layer
    attrib(3, 1, 24);  // size
    attrib(4, 1, 28);  // shade
    attrib(6, 3, 32);  // tint
    gl.bindVertexArray(null);
  }

  get count(): number {
    return this.particles.length;
  }

  /**
   * 在一个方块的位置炸出一把碎屑。
   * @param layer 该方块某个面的贴图层号
   * @param rand 传入随机源，便于把粒子做成可复现的
   */
  burst(
    x: number, y: number, z: number,
    layer: number,
    rand: () => number,
    tint: readonly [number, number, number] = [1, 1, 1],
  ): void {
    for (let i = 0; i < PER_BLOCK; i++) {
      const p = this.makeOne(x, y, z, layer, rand, tint);
      if (this.particles.length >= MAX_PARTICLES) {
        // 满了就顶掉最老的，绝不让数组无限长
        this.particles[this.cursor % MAX_PARTICLES] = p;
        this.cursor++;
      } else {
        this.particles.push(p);
      }
    }
  }

  private makeOne(
    x: number, y: number, z: number,
    layer: number, rand: () => number,
    tint: readonly [number, number, number],
  ): Particle {
    return {
      x: x + rand(), y: y + rand(), z: z + rand(),
      // 向上偏一点，看着像"崩"出来而不是"漏"下去
      vx: (rand() - 0.5) * 0.16,
      vy: rand() * 0.18 + 0.02,
      vz: (rand() - 0.5) * 0.16,
      life: 12 + Math.floor(rand() * 10),
      // uv 取贴图里随机一小块
      u: rand() * 0.75, v: rand() * 0.75,
      layer,
      size: 0.09 + rand() * 0.05,
      shade: 0.7 + rand() * 0.3,
      tr: tint[0], tg: tint[1], tb: tint[2],
    };
  }

  /** 推进一个 tick。粒子不做方块碰撞，见文件顶部说明 */
  update(): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]!;
      p.x += p.vx;
      p.y += p.vy;
      p.z += p.vz;
      p.vy = (p.vy - GRAVITY * 0.4) * DRAG_VERTICAL;
      p.vx *= 0.86;
      p.vz *= 0.86;
      p.life--;
      if (p.life <= 0) {
        // 与末尾交换再弹出：不用 splice，避免每帧搬动整个数组
        this.particles[i] = this.particles[this.particles.length - 1]!;
        this.particles.pop();
      }
    }
  }

  clear(): void {
    this.particles.length = 0;
  }

  render(viewProj: Float32Array, camYaw: number, camPitch: number, texture: WebGLTexture): void {
    if (this.particles.length === 0) return;
    const gl = this.gl;

    let o = 0;
    for (const p of this.particles) {
      this.instanceData[o] = p.x;
      this.instanceData[o + 1] = p.y;
      this.instanceData[o + 2] = p.z;
      this.instanceData[o + 3] = p.u;
      this.instanceData[o + 4] = p.v;
      this.instanceData[o + 5] = p.layer;
      this.instanceData[o + 6] = p.size;
      this.instanceData[o + 7] = p.shade;
      this.instanceData[o + 8] = p.tr;
      this.instanceData[o + 9] = p.tg;
      this.instanceData[o + 10] = p.tb;
      o += FLOATS_PER_VERTEX;
    }

    // 相机的右向量与上向量，用来把方片摆正对镜头
    const cy = Math.cos(camYaw);
    const sy = Math.sin(camYaw);
    const cp = Math.cos(camPitch);
    const sp = Math.sin(camPitch);
    const rightX = -cy;
    const rightZ = -sy;
    const upX = -sy * sp;
    const upY = cp;
    const upZ = cy * sp;

    this.shader.use();
    this.shader.setMat4('uViewProj', viewProj);
    this.shader.setVec3('uRight', rightX, 0, rightZ);
    this.shader.setVec3('uUp', upX, upY, upZ);
    this.shader.setInt('uAtlas', 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instanceData, 0, this.particles.length * FLOATS_PER_VERTEX);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.particles.length);
    gl.bindVertexArray(null);
  }
}
