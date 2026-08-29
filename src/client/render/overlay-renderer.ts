/**
 * 选中框与挖掘裂纹。
 *
 * 两样东西都画在**已经画完的世界之上**，用的是同一套很小的管线：
 *   选中框 —— 12 条线的线框盒，稍微外扩一点点避免与方块面 z-fighting
 *   裂纹   —— 一个略大于方块的立方体，贴 10 张 destroy_stage 之一，
 *             用 dst*src 的乘法混合压暗表面，正是 MC 的做法
 *
 * 裂纹用乘法混合而不是普通 alpha 混合，是因为它要**跟着底下方块的颜色走**：
 * 白石头上的裂纹是灰的，黑曜石上的裂纹几乎看不见 —— 这就是乘法的效果。
 * 用 alpha 混合的话所有方块上的裂纹都是同一个灰，一眼假。
 */
import { Shader } from '../gl/shader.ts';

/** 线框盒：12 条边，24 个顶点 */
const BOX_LINES = new Float32Array([
  // 底面
  0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0,
  // 顶面
  0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0,
  // 四条竖边
  0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 0, 0, 1, 0, 1, 1,
]);

/** 立方体的 6 个面，每面两个三角形；位置 + uv */
function buildCube(): Float32Array {
  const faces: [number, number, number][][] = [
    // [origin, u 轴, v 轴]
    [[0, 0, 0], [1, 0, 0], [0, 1, 0]], // -Z
    [[1, 0, 1], [-1, 0, 0], [0, 1, 0]], // +Z
    [[0, 0, 1], [0, 0, -1], [0, 1, 0]], // -X
    [[1, 0, 0], [0, 0, 1], [0, 1, 0]], // +X
    [[0, 0, 0], [1, 0, 0], [0, 0, 1]], // -Y
    [[0, 1, 1], [1, 0, 0], [0, 0, -1]], // +Y
  ];
  const out: number[] = [];
  for (const [o, u, v] of faces) {
    const corner = (a: number, b: number): number[] => [
      o![0]! + u![0]! * a + v![0]! * b,
      o![1]! + u![1]! * a + v![1]! * b,
      o![2]! + u![2]! * a + v![2]! * b,
      a, b,
    ];
    const p00 = corner(0, 0);
    const p10 = corner(1, 0);
    const p11 = corner(1, 1);
    const p01 = corner(0, 1);
    out.push(...p00, ...p10, ...p11, ...p00, ...p11, ...p01);
  }
  return new Float32Array(out);
}

const OUTLINE_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
uniform mat4 uViewProj;
uniform vec3 uOrigin;
uniform float uInflate;
void main() {
  // 以方块中心为基准向外扩一点，让线框浮在方块表面之外，
  // 否则会和方块面 z-fighting，转动视角时线条断断续续
  vec3 p = (aPos - 0.5) * (1.0 + uInflate * 2.0) + 0.5;
  gl_Position = uViewProj * vec4(uOrigin + p, 1.0);
}`;

const OUTLINE_FRAG = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 fragColor;
void main() { fragColor = uColor; }`;

const CRACK_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUv;
uniform mat4 uViewProj;
uniform vec3 uOrigin;
uniform float uInflate;
out vec2 vUv;
void main() {
  vec3 p = (aPos - 0.5) * (1.0 + uInflate * 2.0) + 0.5;
  vUv = aUv;
  gl_Position = uViewProj * vec4(uOrigin + p, 1.0);
}`;

const CRACK_FRAG = `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 vUv;
uniform sampler2DArray uAtlas;
uniform float uLayer;
out vec4 fragColor;
void main() {
  vec4 tex = texture(uAtlas, vec3(vUv, uLayer));
  // 裂纹贴图是"白底黑纹"：alpha 为 0 的地方不该压暗，
  // 所以按 alpha 在"原样"和"纹理色"之间插值，再交给乘法混合
  vec3 c = mix(vec3(1.0), tex.rgb, tex.a);
  fragColor = vec4(c, 1.0);
}`;

export class OverlayRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly outlineShader: Shader;
  private readonly crackShader: Shader;
  private readonly outlineVao: WebGLVertexArrayObject;
  private readonly crackVao: WebGLVertexArrayObject;
  private readonly crackVertexCount: number;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.outlineShader = new Shader(gl, OUTLINE_VERT, OUTLINE_FRAG, 'outline');
    this.crackShader = new Shader(gl, CRACK_VERT, CRACK_FRAG, 'crack');

    this.outlineVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.outlineVao);
    const lineBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, BOX_LINES, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);

    const cube = buildCube();
    this.crackVertexCount = cube.length / 5;
    this.crackVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.crackVao);
    const cubeBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, cubeBuf);
    gl.bufferData(gl.ARRAY_BUFFER, cube, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);

    gl.bindVertexArray(null);
  }

  /** 画选中方块的线框 */
  drawOutline(viewProj: Float32Array, x: number, y: number, z: number): void {
    const gl = this.gl;
    this.outlineShader.use();
    this.outlineShader.setMat4('uViewProj', viewProj);
    this.outlineShader.setVec3('uOrigin', x, y, z);
    this.outlineShader.setFloat('uInflate', 0.002);
    const loc = this.outlineShader.loc('uColor');
    if (loc !== null) gl.uniform4f(loc, 0, 0, 0, 0.55);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.outlineVao);
    gl.drawArrays(gl.LINES, 0, BOX_LINES.length / 3);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  /**
   * 画挖掘裂纹。
   * @param stage 0..9，来自 core/block/breaking.ts 的 crackStage
   * @param layer0 destroy_stage_0 在纹理数组里的层号
   */
  drawCrack(
    viewProj: Float32Array,
    x: number, y: number, z: number,
    stage: number,
    texture: WebGLTexture,
    layer0: number,
  ): void {
    if (stage < 0) return;
    const gl = this.gl;
    this.crackShader.use();
    this.crackShader.setMat4('uViewProj', viewProj);
    this.crackShader.setVec3('uOrigin', x, y, z);
    // 比方块大一丁点，保证裂纹盖在表面之上而不是穿插进去
    this.crackShader.setFloat('uInflate', 0.0015);
    this.crackShader.setFloat('uLayer', layer0 + Math.min(9, stage));
    this.crackShader.setInt('uAtlas', 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);

    gl.enable(gl.BLEND);
    // 乘法混合：裂纹跟着底下方块的颜色走，而不是糊一层统一的灰
    gl.blendFunc(gl.DST_COLOR, gl.ZERO);
    gl.depthMask(false);
    gl.bindVertexArray(this.crackVao);
    gl.drawArrays(gl.TRIANGLES, 0, this.crackVertexCount);
    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }
}
