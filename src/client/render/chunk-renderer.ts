/**
 * 子区块的 GPU 资源管理与绘制。
 *
 * 每个子区块每个渲染层一个 VAO。绘制时按层分三趟：
 *   1. OPAQUE      —— 开深度写入，正常绘制
 *   2. CUTOUT      —— 着色器 discard，仍写深度
 *   3. TRANSLUCENT —— 按距离由远及近排序，开混合，不写深度
 *
 * key 一律用数值，绝不用字符串（docs/RULES.md 第 10 条）。
 */
import type { MeshResult, MeshLayerData } from '../mesh/mesher.ts';
import { RenderLayer } from '../../core/block/types.ts';
import { SECTION_SIZE } from '../../core/constants.ts';
import { VERTEX_STRIDE } from './block-shader.ts';
import type { Shader } from '../gl/shader.ts';
import type { Frustum } from '../../core/math/frustum.ts';

interface LayerMesh {
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  ebo: WebGLBuffer;
  indexCount: number;
  quadCount: number;
  bytes: number;
}

interface SectionMesh {
  cx: number;
  cy: number;
  cz: number;
  rev: number;
  layers: (LayerMesh | null)[];
}

/**
 * 子区块 key。cy 只有 0..7，可以直接塞进低位。
 * 与区块 key 一样用偏移法支持负坐标。
 */
export function sectionKey(cx: number, cy: number, cz: number): number {
  return ((cx + 0x800000) * 0x1000000 + (cz + 0x800000)) * 8 + cy;
}

export class ChunkRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly meshes = new Map<number, SectionMesh>();
  /** 半透明层的绘制顺序缓冲，预分配复用 */
  private readonly sortScratch: { mesh: SectionMesh; dist: number }[] = [];

  // 每帧统计
  drawCalls = 0;
  quadsDrawn = 0;
  sectionsDrawn = 0;
  totalBytes = 0;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  get sectionCount(): number {
    return this.meshes.size;
  }

  /** 上传（或替换）一个子区块的网格 */
  upload(result: MeshResult): void {
    const key = sectionKey(result.cx, result.cy, result.cz);
    const existing = this.meshes.get(key);
    if (existing !== undefined) {
      // 结果比已有的旧就丢弃 —— 玩家快速挖放时会连续产生任务
      if (result.rev < existing.rev) return;
      this.disposeSection(existing);
    }

    const layers: (LayerMesh | null)[] = [null, null, null];
    for (const layerData of result.layers) {
      layers[layerData.layer] = this.createLayerMesh(layerData);
    }
    const mesh: SectionMesh = { cx: result.cx, cy: result.cy, cz: result.cz, rev: result.rev, layers };
    this.meshes.set(key, mesh);
    this.recountBytes();
  }

  private createLayerMesh(data: MeshLayerData): LayerMesh | null {
    if (data.quadCount === 0) return null;
    const gl = this.gl;
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    const ebo = gl.createBuffer();
    if (vao === null || vbo === null || ebo === null) throw new Error('创建 GL 缓冲失败');

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data.vertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    // 整数属性必须用 vertexAttribIPointer；用 vertexAttribPointer 会被当成浮点归一化，
    // 表现是整个世界的顶点挤成一团
    gl.vertexAttribIPointer(0, 3, gl.UNSIGNED_INT, VERTEX_STRIDE, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    return {
      vao, vbo, ebo,
      indexCount: data.indices.length,
      quadCount: data.quadCount,
      bytes: data.vertices.byteLength + data.indices.byteLength,
    };
  }

  remove(cx: number, cy: number, cz: number): void {
    const key = sectionKey(cx, cy, cz);
    const mesh = this.meshes.get(key);
    if (mesh === undefined) return;
    this.disposeSection(mesh);
    this.meshes.delete(key);
    this.recountBytes();
  }

  private disposeSection(mesh: SectionMesh): void {
    const gl = this.gl;
    for (const layer of mesh.layers) {
      if (layer === null) continue;
      gl.deleteVertexArray(layer.vao);
      gl.deleteBuffer(layer.vbo);
      gl.deleteBuffer(layer.ebo);
    }
  }

  private recountBytes(): void {
    let total = 0;
    for (const mesh of this.meshes.values()) {
      for (const layer of mesh.layers) if (layer !== null) total += layer.bytes;
    }
    this.totalBytes = total;
  }

  dispose(): void {
    for (const mesh of this.meshes.values()) this.disposeSection(mesh);
    this.meshes.clear();
    this.totalBytes = 0;
  }

  /**
   * 绘制全部可见子区块。
   * @param camX/camY/camZ 相机世界坐标，用于半透明排序与远近判断
   */
  render(shader: Shader, frustum: Frustum, camX: number, camY: number, camZ: number): void {
    const gl = this.gl;
    this.drawCalls = 0;
    this.quadsDrawn = 0;
    this.sectionsDrawn = 0;

    const visible: SectionMesh[] = [];
    for (const mesh of this.meshes.values()) {
      const ox = mesh.cx * SECTION_SIZE;
      const oy = mesh.cy * SECTION_SIZE;
      const oz = mesh.cz * SECTION_SIZE;
      if (!frustum.intersectsAabb(ox, oy, oz, ox + SECTION_SIZE, oy + SECTION_SIZE, oz + SECTION_SIZE)) continue;
      visible.push(mesh);
    }
    this.sectionsDrawn = visible.length;

    // --- 不透明与 cutout：由近及远，让早期深度测试尽量剔掉后面的片元 ---
    for (const layerIdx of [RenderLayer.OPAQUE, RenderLayer.CUTOUT]) {
      for (const mesh of visible) {
        const layer = mesh.layers[layerIdx];
        if (layer == null) continue;
        shader.setVec3('uSectionOrigin', mesh.cx * SECTION_SIZE, mesh.cy * SECTION_SIZE, mesh.cz * SECTION_SIZE);
        gl.bindVertexArray(layer.vao);
        gl.drawElements(gl.TRIANGLES, layer.indexCount, gl.UNSIGNED_INT, 0);
        this.drawCalls++;
        this.quadsDrawn += layer.quadCount;
      }
    }

    // --- 半透明：由远及近，且不写深度，否则互相遮挡会出错 ---
    this.sortScratch.length = 0;
    for (const mesh of visible) {
      if (mesh.layers[RenderLayer.TRANSLUCENT] == null) continue;
      const dx = mesh.cx * SECTION_SIZE + 8 - camX;
      const dy = mesh.cy * SECTION_SIZE + 8 - camY;
      const dz = mesh.cz * SECTION_SIZE + 8 - camZ;
      this.sortScratch.push({ mesh, dist: dx * dx + dy * dy + dz * dz });
    }
    if (this.sortScratch.length > 0) {
      this.sortScratch.sort((a, b) => b.dist - a.dist);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      for (const entry of this.sortScratch) {
        const layer = entry.mesh.layers[RenderLayer.TRANSLUCENT]!;
        shader.setVec3('uSectionOrigin', entry.mesh.cx * SECTION_SIZE, entry.mesh.cy * SECTION_SIZE, entry.mesh.cz * SECTION_SIZE);
        gl.bindVertexArray(layer.vao);
        gl.drawElements(gl.TRIANGLES, layer.indexCount, gl.UNSIGNED_INT, 0);
        this.drawCalls++;
        this.quadsDrawn += layer.quadCount;
      }
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }

    gl.bindVertexArray(null);
  }
}
