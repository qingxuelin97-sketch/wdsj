/**
 * 生物绘制：把模型里的盒子摆成世界空间的三角形。
 *
 * 几何每帧在 CPU 上重建，与掉落物同一套理由：视野里几十只生物 ×
 * 十来个盒子 × 36 个顶点，一次 bufferSubData 就搞定，
 * 而换来的是完全不需要按实体管理 GPU 资源。
 *
 * 用纯色而不是贴图（见 content/mob-models.ts 顶部）；面的明暗沿用
 * 方块渲染那一套固定值，让盒子有立体感而不需要法线与光源计算。
 */
import { Shader } from '../gl/shader.ts';
import type { MobBox } from '../../content/mob-models.ts';

/** 同时最多画多少个盒子 */
const MAX_BOXES = 2048;
/** 每顶点：位置 3 + 颜色 3 */
const FLOATS_PER_VERTEX = 6;
const VERTS_PER_BOX = 36;

const VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aColor;
uniform mat4 uViewProj;
out vec3 vColor;
void main() {
  vColor = aColor;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 fragColor;
void main() {
  fragColor = vec4(vColor, 1.0);
}`;

/** 六个面的角点（单位立方，0..1）与明暗，与方块渲染的固定明暗一致 */
const FACES: readonly {
  readonly corners: readonly (readonly [number, number, number])[];
  readonly shade: number;
}[] = [
  { shade: 0.5, corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] }, // 下
  { shade: 1.0, corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] }, // 上
  { shade: 0.8, corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] }, // 北
  { shade: 0.8, corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] }, // 南
  { shade: 0.6, corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] }, // 西
  { shade: 0.6, corners: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] }, // 东
];
const QUAD_INDICES = [0, 1, 2, 0, 2, 3] as const;

/** 画一只生物需要的全部参数 */
export interface MobDrawRequest {
  readonly boxes: readonly MobBox[];
  x: number; y: number; z: number;
  yaw: number;
  headYaw: number;
  /** 走路摆动的相位（弧度） */
  walk: number;
  /** 摆动幅度 0..1。站着不动时为 0 */
  walkAmount: number;
  /** 环境亮度 0..1 */
  light: number;
  /** 受伤闪红 0..1 */
  hurt: number;
  /** 苦力怕鼓起 0..1 */
  swell: number;
  /** 死亡倒地 0..1 */
  dying: number;
  /** 覆盖第 0 个盒子的颜色（羊毛染色）。null 表示不覆盖 */
  bodyColor: readonly [number, number, number] | null;
}

export class MobRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly shader: Shader;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffer: WebGLBuffer;
  private readonly data = new Float32Array(MAX_BOXES * VERTS_PER_BOX * FLOATS_PER_VERTEX);
  private cursor = 0;
  private verts = 0;

  lastVerts = 0;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.shader = new Shader(gl, VERT, FRAG, 'mob');
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    const stride = FLOATS_PER_VERTEX * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
    gl.bindVertexArray(null);
  }

  begin(): void {
    this.cursor = 0;
    this.verts = 0;
  }

  push(req: MobDrawRequest): void {
    const cosBody = Math.cos(req.yaw);
    const sinBody = Math.sin(req.yaw);
    const cosHead = Math.cos(req.headYaw);
    const sinHead = Math.sin(req.headYaw);
    // 死亡时整只倒下去：绕 z 轴转 90 度，用一个简单的下沉近似
    const dyingSink = req.dying * 0.6;

    for (const box of req.boxes) {
      if (this.verts + VERTS_PER_BOX > MAX_BOXES * VERTS_PER_BOX) return;
      const cos = box.head === true ? cosHead : cosBody;
      const sin = box.head === true ? sinHead : sinBody;

      // 摆动：绕盒子顶部那条轴前后转。腿和手臂的旋转中心在上端，
      // 直接整块平移的话腿会脱离身体
      const swing = (box.swing ?? 0) * req.walkAmount * Math.sin(req.walk) * 0.5;
      const pivotY = (box.y + box.h) / 16;

      // 苦力怕鼓起：整体放大，同时加一层白
      const scale = 1 + req.swell * 0.25;
      const color = this.tint(box, req);

      for (const face of FACES) {
        const shade = face.shade * req.light;
        for (const i of QUAD_INDICES) {
          const c = face.corners[i]!;
          // 模型局部坐标（格）
          let lx = (box.x + c[0] * box.w) / 16;
          let ly = (box.y + c[1] * box.h) / 16;
          let lz = (box.z + c[2] * box.d) / 16;

          // 摆动：绕 pivotY 处的 X 轴转
          if (swing !== 0) {
            const ry = ly - pivotY;
            const s = Math.sin(swing);
            const cs = Math.cos(swing);
            const ny = ry * cs - lz * s;
            const nz = ry * s + lz * cs;
            ly = pivotY + ny;
            lz = nz;
          }

          lx *= scale;
          ly *= scale;
          lz *= scale;

          // 绕 Y 轴按朝向旋转，再平移到世界坐标
          this.vertex(
            req.x + lx * cos - lz * sin,
            req.y + ly - dyingSink,
            req.z + lx * sin + lz * cos,
            color[0] * shade, color[1] * shade, color[2] * shade,
          );
        }
      }
    }
  }

  /** 盒子的最终颜色：染色 -> 受伤闪红 -> 鼓起泛白 */
  private tint(box: MobBox, req: MobDrawRequest): readonly [number, number, number] {
    let c = box.color;
    if (req.bodyColor !== null && box === req.boxes[0]) c = req.bodyColor;
    if (req.hurt > 0) {
      c = [
        c[0] + (1 - c[0]) * req.hurt * 0.6,
        c[1] * (1 - req.hurt * 0.6),
        c[2] * (1 - req.hurt * 0.6),
      ];
    }
    if (req.swell > 0) {
      // MC 的苦力怕是一闪一闪地发白，频率随鼓起程度加快
      const flash = req.swell > 0.02 ? (Math.floor(req.swell * 30) % 2 === 0 ? 0.55 : 0) : 0;
      c = [
        c[0] + (1 - c[0]) * flash,
        c[1] + (1 - c[1]) * flash,
        c[2] + (1 - c[2]) * flash,
      ];
    }
    return c;
  }

  private vertex(x: number, y: number, z: number, r: number, g: number, bl: number): void {
    const d = this.data;
    let o = this.cursor;
    d[o] = x; d[o + 1] = y; d[o + 2] = z;
    d[o + 3] = r; d[o + 4] = g; d[o + 5] = bl;
    this.cursor = o + FLOATS_PER_VERTEX;
    this.verts++;
  }

  render(viewProj: Float32Array): void {
    this.lastVerts = this.verts;
    if (this.verts === 0) return;
    const gl = this.gl;
    this.shader.use();
    this.shader.setMat4('uViewProj', viewProj);
    // 摆动会让某些盒子的绕序翻过来（负的缩放效应），一律双面画
    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.cursor);
    gl.drawArrays(gl.TRIANGLES, 0, this.verts);
    gl.bindVertexArray(null);
    gl.enable(gl.CULL_FACE);
  }
}
