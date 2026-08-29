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
  /** 绘制顺序缓冲，预分配复用。key 参与排序以打破距离相同时的平局 */
  private readonly sortScratch: { mesh: SectionMesh; dist: number; key: number }[] = [];
  private readonly visibleScratch: { mesh: SectionMesh; dist: number; key: number }[] = [];

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

    // 收集可见段并**确定性排序**。
    //
    // 排序不只是为了性能（不透明由近及远能让 early-z 剔掉更多片元）：
    // 半透明层必须由远及近混合，而距离相同时若按 Map 的插入顺序绘制，
    // 结果就取决于网格化完成的先后 —— 同一个场景每次画出来都可能有细微差别，
    // 画面上是水面的闪烁，截图回归里则是永远对不上的哈希。
    // 用 sectionKey 做次级键，彻底消除这个变量。
    const visible = this.visibleScratch;
    visible.length = 0;
    for (const mesh of this.meshes.values()) {
      const ox = mesh.cx * SECTION_SIZE;
      const oy = mesh.cy * SECTION_SIZE;
      const oz = mesh.cz * SECTION_SIZE;
      if (!frustum.intersectsAabb(ox, oy, oz, ox + SECTION_SIZE, oy + SECTION_SIZE, oz + SECTION_SIZE)) continue;
      const dx = ox + 8 - camX;
      const dy = oy + 8 - camY;
      const dz = oz + 8 - camZ;
      visible.push({ mesh, dist: dx * dx + dy * dy + dz * dz, key: sectionKey(mesh.cx, mesh.cy, mesh.cz) });
    }
    visible.sort((a, b) => a.dist - b.dist || a.key - b.key);
    this.sectionsDrawn = visible.length;

    // --- 不透明与 cutout：由近及远，让早期深度测试尽量剔掉后面的片元 ---
    for (const layerIdx of [RenderLayer.OPAQUE, RenderLayer.CUTOUT]) {
      for (const entry of visible) {
        const mesh = entry.mesh;
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
    for (const entry of visible) {
      if (entry.mesh.layers[RenderLayer.TRANSLUCENT] == null) continue;
      this.sortScratch.push(entry);
    }
    if (this.sortScratch.length > 0) {
      // 由远及近，距离相同时按 key —— 与不透明层的次级键一致，保证完全确定
      this.sortScratch.sort((a, b) => b.dist - a.dist || a.key - b.key);
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
