/**
 * 掉落物的绘制。
 *
 * 两种形态，与 MC 一致：
 *   - 方块掉落物画成**小方块**（0.25 格），绕 Y 轴慢慢转
 *   - 物品掉落物画成**朝向相机的方片**
 *
 * 这个区分值得专门写：地上散着的绝大多数是方块（圆石、泥土、原木），
 * 一律用方片的话，一堆掉落物会像贴在地上的贴纸，深度感全没了。
 *
 * 几何每帧在 CPU 上重建。视野里同时有几百个掉落物已经是极端情况，
 * 几百 × 36 个顶点对一次 bufferSubData 来说微不足道，
 * 换来的是不需要任何按实体的 GPU 资源管理。
 */
import { Shader } from '../gl/shader.ts';

/** 方块掉落物的边长（格） */
const CUBE_SIZE = 0.25;
/** 物品方片的边长（格） */
const SPRITE_SIZE = 0.4;
/** 上下浮动的幅度 */
const BOB_AMPLITUDE = 0.06;
/** 一次上下浮动多少刻 */
const BOB_PERIOD = 40;
/** 一圈转多少刻 */
const SPIN_PERIOD = 100;
/** 同时最多画多少个 */
const MAX_ENTITIES = 512;
/** 每顶点：位置 3 + uv 2 + 层 1 + 明暗 1 */
const FLOATS_PER_VERTEX = 7;
const VERTS_PER_CUBE = 36;

const VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUv;
layout(location = 2) in float aLayer;
layout(location = 3) in float aShade;
uniform mat4 uViewProj;
out vec2 vUv;
flat out float vLayer;
out float vShade;
void main() {
  vUv = aUv;
  vLayer = aLayer;
  vShade = aShade;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 vUv;
flat in float vLayer;
in float vShade;
uniform sampler2DArray uAtlas;
out vec4 fragColor;
void main() {
  vec4 tex = texture(uAtlas, vec3(vUv, vLayer));
  // 物品图标有透明区域，方块贴图没有；一起丢弃全透明像素，
  // 这样方片不会画出一圈黑边
  if (tex.a < 0.1) discard;
  fragColor = vec4(tex.rgb * vShade, 1.0);
}`;

/** 立方体六个面的角点（单位立方，中心在原点），与面的明暗 */
const CUBE_FACES: readonly {
  readonly corners: readonly (readonly [number, number, number])[];
  readonly shade: number;
  /** faceLayer 表里的面编号：下上北南西东 */
  readonly face: number;
}[] = [
  { face: 0, shade: 0.5, corners: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
  { face: 1, shade: 1.0, corners: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
  { face: 2, shade: 0.8, corners: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
  { face: 3, shade: 0.8, corners: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { face: 4, shade: 0.6, corners: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
  { face: 5, shade: 0.6, corners: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
];

/** 一个四边形按 0-1-2 / 0-2-3 拆成两个三角形 */
const QUAD_INDICES = [0, 1, 2, 0, 2, 3] as const;
const QUAD_UV: readonly (readonly [number, number])[] = [[0, 1], [1, 1], [1, 0], [0, 0]];

export interface ItemDrawRequest {
  x: number; y: number; z: number;
  /** 已经过的刻数（含小数），驱动浮动与旋转 */
  age: number;
  phase: number;
  /** 方块掉落物：六个面各自的纹理层。为 null 表示画成方片 */
  faceLayers: readonly number[] | null;
  /** 方片用的纹理层 */
  spriteLayer: number;
  /** 亮度，取自所在方块的光照 */
  light: number;
}

export class ItemEntityRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly shader: Shader;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffer: WebGLBuffer;
  private readonly data = new Float32Array(MAX_ENTITIES * VERTS_PER_CUBE * FLOATS_PER_VERTEX);
  private cursor = 0;
  private verts = 0;

  /** 上一次画了多少个顶点，排查用 */
  lastVerts = 0;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.shader = new Shader(gl, VERT, FRAG, 'item-entity');
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
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 24);
    gl.bindVertexArray(null);
  }

  begin(): void {
    this.cursor = 0;
    this.verts = 0;
  }

  /**
   * 攒一个掉落物。
   * @param camRight 相机右向量，画方片时用
   * @param camUp 相机上向量
   */
  push(req: ItemDrawRequest, camRight: readonly number[], camUp: readonly number[]): void {
    if (this.verts + VERTS_PER_CUBE > MAX_ENTITIES * VERTS_PER_CUBE) return;
    const bob = Math.sin((req.age / BOB_PERIOD) * Math.PI * 2 + req.phase) * BOB_AMPLITUDE;
    const cy = req.y + CUBE_SIZE + bob;

    if (req.faceLayers === null) {
      if (req.spriteLayer < 0) return;
      this.pushSprite(req.x, cy, req.z, req.spriteLayer, req.light, camRight, camUp);
      return;
    }
    const angle = (req.age / SPIN_PERIOD) * Math.PI * 2 + req.phase;
    this.pushCube(req.x, cy, req.z, angle, req.faceLayers, req.light);
  }

  private vertex(x: number, y: number, z: number, u: number, v: number, layer: number, shade: number): void {
    const d = this.data;
    let o = this.cursor;
    d[o] = x; d[o + 1] = y; d[o + 2] = z;
    d[o + 3] = u; d[o + 4] = v;
    d[o + 5] = layer;
    d[o + 6] = shade;
    this.cursor = o + FLOATS_PER_VERTEX;
    this.verts++;
  }

  private pushCube(
    cx: number, cy: number, cz: number, angle: number,
    faceLayers: readonly number[], light: number,
  ): void {
    const half = CUBE_SIZE / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    for (const f of CUBE_FACES) {
      const layer = faceLayers[f.face] ?? -1;
      if (layer < 0) continue;
      const shade = f.shade * light;
      for (const i of QUAD_INDICES) {
        const c = f.corners[i]!;
        const lx = c[0] * half;
        const ly = c[1] * half;
        const lz = c[2] * half;
        // 绕 Y 轴旋转
        const uv = QUAD_UV[i]!;
        this.vertex(
          cx + lx * cos - lz * sin, cy + ly, cz + lx * sin + lz * cos,
          uv[0], uv[1], layer, shade,
        );
      }
    }
  }

  private pushSprite(
    cx: number, cy: number, cz: number, layer: number, light: number,
    right: readonly number[], up: readonly number[],
  ): void {
    const h = SPRITE_SIZE / 2;
    const corners: readonly (readonly [number, number])[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (const i of QUAD_INDICES) {
      const c = corners[i]!;
      const uv = QUAD_UV[i]!;
      this.vertex(
        cx + (right[0]! * c[0] + up[0]! * c[1]) * h,
        cy + (right[1]! * c[0] + up[1]! * c[1]) * h,
        cz + (right[2]! * c[0] + up[2]! * c[1]) * h,
        uv[0], 1 - uv[1], layer, light,
      );
    }
  }

  render(viewProj: Float32Array, texture: WebGLTexture): void {
    this.lastVerts = this.verts;
    if (this.verts === 0) return;
    const gl = this.gl;
    this.shader.use();
    this.shader.setMat4('uViewProj', viewProj);
    this.shader.setInt('uAtlas', 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    // 方片是双面的（相机绕到背面时不该消失），方块的六个面已经按外向绕序建好，
    // 所以整批都关掉背面剔除最省事
    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.cursor);
    gl.drawArrays(gl.TRIANGLES, 0, this.verts);
    gl.bindVertexArray(null);
    gl.enable(gl.CULL_FACE);
  }
}
