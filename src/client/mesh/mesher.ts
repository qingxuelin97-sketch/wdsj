/**
 * 子区块网格化。
 *
 * 输入是一个 **18³ 的 padded 邻域**（16 + 两侧各 1 格），不是裸的 16³ ——
 * 少了这一圈，边界处的面剔除、AO 和光照全是错的，表现为每 16 格一条可见的光照缝，
 * 外加整面被遮挡却仍被生成的四边形。前作正是栽在这里（ga/mesher.ts:97,102-104,114）。
 *
 * 不做贪心合并，与 MC 本身一致：可见的面几乎都有 AO/光照梯度，能合并的多半已经被剔除了，
 * 合并率不值那份复杂度（还会把 UV 从"恒为整格"变成"要按尺寸缩放"，正是前作 UV bug 的来源）。
 *
 * 热路径纪律（docs/RULES.md 第 6、9 条）：只读扁平 typed array，输出缓冲预分配后用游标写入。
 */
import { MESH_PADDED_SIZE, SECTION_SIZE } from '../../core/constants.ts';
import { stateId, stateMeta } from '../../core/world/chunk.ts';
import { ModelKind, RenderLayer } from '../../core/block/types.ts';
import type { ModelTables } from '../../core/registry/model-tables.ts';
import { FACES } from './cube-faces.ts';
import { packVertex } from '../render/block-shader.ts';

const P = MESH_PADDED_SIZE; // 18
const S = SECTION_SIZE; // 16
export const PADDED_VOLUME = P * P * P; // 5832
export const PADDED_AREA = P * P; // 324

/** padded 邻域内的下标。x/y/z ∈ [0,18)，中心 16³ 位于 [1,17) */
export function paddedIndex(x: number, y: number, z: number): number {
  return (y * P + z) * P + x;
}

/** mesher 需要的方块属性表，全部是按 blockId 索引的扁平数组 */
export interface MesherTables {
  /** 按状态索引的模型表，见 core/registry/model-tables.ts */
  readonly models: ModelTables;
  readonly modelKind: Uint8Array;
  readonly renderLayer: Uint8Array;
  readonly tint: Uint8Array;
  /** 哪些面参与染色，按 Facing 位掩码 */
  readonly tintFaces: Uint8Array;
  readonly fullCube: Uint8Array;
  readonly cullSameType: Uint8Array;
  readonly opaque: Uint8Array;
  /** blockId*6 + face -> 纹理层号 */
  readonly faceLayer: Uint16Array;
}

export interface MeshJob {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  /** 任务版本号。结果回来时不匹配就丢弃，见 docs/RULES.md 第 11 条 */
  readonly rev: number;
  /** 18³ 方块状态 */
  readonly blocks: Uint16Array;
  /** 18³ 光照，sky(4) | block(4) */
  readonly light: Uint8Array;
  /** 18² 群系 id */
  readonly biomes: Uint8Array;
}

export interface MeshLayerData {
  readonly layer: RenderLayer;
  readonly vertices: Uint32Array;
  readonly indices: Uint32Array;
  readonly quadCount: number;
}

export interface MeshResult {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly rev: number;
  readonly layers: MeshLayerData[];
  /** 15 bit 面连通性掩码，供后续的洞穴剔除使用 */
  readonly visibilityMask: number;
}

/**
 * 面是否需要生成。
 *
 * 规则与 MC 一致：
 *   - 邻居是不透明完整立方体 -> 剔除（绝大多数情况）
 *   - 同种方块且该方块声明了 cullSameType -> 剔除（玻璃对玻璃剔，树叶对树叶不剔）
 *   - 其余保留
 */
function faceVisible(t: MesherTables, selfId: number, neighborState: number): boolean {
  const nId = stateId(neighborState);
  if (nId === 0) return true; // 空气
  if (t.fullCube[nId] === 1) return false;
  if (nId === selfId && t.cullSameType[selfId] === 1) return false;
  return true;
}

/** 该位置是否算作"实心"，用于 AO 采样 */
function aoSolid(t: MesherTables, state: number): boolean {
  const id = stateId(state);
  return id !== 0 && t.fullCube[id] === 1;
}

/**
 * 标准 3 采样环境光遮蔽。
 * 两个侧向都被挡住时角落无关紧要，直接给最暗值 —— 这是经典的 "if (s1 && s2) return 0"。
 */
function cornerAO(s1: boolean, s2: boolean, corner: boolean): number {
  if (s1 && s2) return 0;
  return 3 - ((s1 ? 1 : 0) + (s2 ? 1 : 0) + (corner ? 1 : 0));
}

/** 输出缓冲。按渲染层各一份，容量不足时翻倍 */
class LayerBuffer {
  vertices: Uint32Array;
  indices: Uint32Array;
  vi = 0;
  ii = 0;
  quads = 0;

  constructor(initialQuads: number) {
    this.vertices = new Uint32Array(initialQuads * 4 * 3);
    this.indices = new Uint32Array(initialQuads * 6);
  }

  ensure(extraQuads: number): void {
    const needV = this.vi + extraQuads * 4 * 3;
    const needI = this.ii + extraQuads * 6;
    if (needV > this.vertices.length) {
      const grown = new Uint32Array(Math.max(needV, this.vertices.length * 2));
      grown.set(this.vertices.subarray(0, this.vi));
      this.vertices = grown;
    }
    if (needI > this.indices.length) {
      const grown = new Uint32Array(Math.max(needI, this.indices.length * 2));
      grown.set(this.indices.subarray(0, this.ii));
      this.indices = grown;
    }
  }

  finish(layer: RenderLayer): MeshLayerData {
    return {
      layer,
      vertices: this.vertices.subarray(0, this.vi),
      indices: this.indices.subarray(0, this.ii),
      quadCount: this.quads,
    };
  }
}

/** 四个角相对于面中心的方向，顺序对应 origin / +u / +u+v / +v */
const CORNER_DIRS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

export function meshSection(job: MeshJob, t: MesherTables): MeshResult {
  const { blocks, light } = job;
  const buffers: LayerBuffer[] = [new LayerBuffer(512), new LayerBuffer(128), new LayerBuffer(64)];

  for (let ly = 0; ly < S; ly++) {
    for (let lz = 0; lz < S; lz++) {
      for (let lx = 0; lx < S; lx++) {
        const px = lx + 1;
        const py = ly + 1;
        const pz = lz + 1;
        const state = blocks[paddedIndex(px, py, pz)]!;
        const id = stateId(state);
        if (id === 0) continue;

        const kind = t.modelKind[id]!;
        if (kind === ModelKind.NONE) continue;

        const layerIdx = t.renderLayer[id]! as RenderLayer;
        const buf = buffers[layerIdx]!;
        const tint = t.tint[id]!;

        if (kind === ModelKind.CROSS) {
          emitCross(buf, t, id, tint, lx, ly, lz, light[paddedIndex(px, py, pz)]!);
          continue;
        }

        emitElements(buf, t, id, stateMeta(state), tint, lx, ly, lz, px, py, pz, blocks, light);
      }
    }
  }

  const layers: MeshLayerData[] = [];
  for (let i = 0; i < 3; i++) {
    const b = buffers[i]!;
    if (b.quads > 0) layers.push(b.finish(i as RenderLayer));
  }

  return { cx: job.cx, cy: job.cy, cz: job.cz, rev: job.rev, layers, visibilityMask: 0 };
}

/**
 * 十字植物：两个对角面，各自双面渲染（共 4 个四边形）。
 * 无 AO（植物本来就没有可信的遮蔽方向），光照取所在格。
 */
function emitCross(
  buf: LayerBuffer,
  t: MesherTables,
  id: number,
  tint: number,
  lx: number,
  ly: number,
  lz: number,
  lightVal: number,
): void {
  buf.ensure(4);
  const layerTex = t.faceLayer[id * 6 + 1]!; // 十字植物六面同图，取 UP
  const sky = lightVal >> 4;
  const blk = lightVal & 0xf;
  // 稍微内缩，避免与相邻方块的面 z-fighting
  const lo = 0.854 / 2; // (1 - 1/sqrt(2)) / 2 附近，让对角面正好嵌在格子里
  const hi = 1 - lo;

  const diagonals: readonly (readonly [number, number, number, number])[] = [
    [lo, lo, hi, hi], // 左下 -> 右上
    [lo, hi, hi, lo], // 左上 -> 右下
  ];

  for (const d of diagonals) {
    const [x0, z0, x1, z1] = d;
    // 正反两面各一个四边形，这样从任何角度都看得见
    for (let side = 0; side < 2; side++) {
      const ax = side === 0 ? x0 : x1;
      const az = side === 0 ? z0 : z1;
      const bx = side === 0 ? x1 : x0;
      const bz = side === 0 ? z1 : z0;
      const base = buf.quads * 4;
      const corners: readonly (readonly [number, number, number, number, number])[] = [
        [ax, 0, az, 0, 16],
        [bx, 0, bz, 16, 16],
        [bx, 1, bz, 16, 0],
        [ax, 1, az, 0, 0],
      ];
      for (const c of corners) {
        packVertex(
          buf.vertices, buf.vi,
          Math.round((lx + c[0]) * 16), Math.round((ly + c[1]) * 16), Math.round((lz + c[2]) * 16),
          c[3], c[4], layerTex,
          sky, blk,
          1, 3, tint,
        );
        buf.vi += 3;
      }
      buf.indices[buf.ii] = base;
      buf.indices[buf.ii + 1] = base + 1;
      buf.indices[buf.ii + 2] = base + 2;
      buf.indices[buf.ii + 3] = base;
      buf.indices[buf.ii + 4] = base + 2;
      buf.indices[buf.ii + 5] = base + 3;
      buf.ii += 6;
      buf.quads++;
    }
  }
  // meta 目前未参与十字植物渲染，留给 M7 的作物生长阶段使用
  void stateMeta;
  void t;
}

/**
 * 按模型的元素盒逐面发四边形。整格立方体只是"一个元素"的特例。
 *
 * 有两处值得说明：
 *
 * **剔除**只在 `cullface >= 0` 的面上做，也就是正好贴着格子边界的面。
 * 半砖的顶面在 y=8，不贴边界，所以上面压一块石头也照画 ——
 * 标成可剔除的话，半砖上放东西会看穿。cullface 由 autoCullface 从坐标推导，
 * 不让内容作者手写，正是因为这种错在编辑器里完全看不出来。
 *
 * **平滑光照与 AO 只给贴边界的面**。内部面（楼梯的台阶立面、栅栏的横梁）
 * 用所在格子的光照平铺。给它们做 AO 需要在子格精度上采样，代价不小，
 * 而收益在这些又小又碎的面上几乎看不见。
 */
function emitElements(
  buf: LayerBuffer,
  t: MesherTables,
  id: number,
  meta: number,
  tint: number,
  lx: number, ly: number, lz: number,
  px: number, py: number, pz: number,
  blocks: Uint16Array,
  light: Uint8Array,
): void {
  const m = t.models;
  const model = m.stateModel[id * 16 + meta] ?? 0;
  const elemStart = m.modelElementStart[model] ?? 0;
  const elemCount = m.modelElementCount[model] ?? 0;
  const ownLight = light[paddedIndex(px, py, pz)]!;

  for (let e = 0; e < elemCount; e++) {
    const ei = elemStart + e;
    const bi = ei * 6;
    const lo0 = m.elementBox[bi]!, lo1 = m.elementBox[bi + 1]!, lo2 = m.elementBox[bi + 2]!;
    const hi0 = m.elementBox[bi + 3]!, hi1 = m.elementBox[bi + 4]!, hi2 = m.elementBox[bi + 5]!;
    const lo = [lo0, lo1, lo2];
    const hi = [hi0, hi1, hi2];
    const clampUv = m.elementClampUv[ei] === 1;

    for (let f = 0; f < 6; f++) {
      const slot = m.elementTexture[bi + f]!;
      if (slot < 0) continue;
      const cull = m.elementCullface[bi + f]!;

      const face = FACES[f]!;
      const nx = px + face.nx;
      const ny = py + face.ny;
      const nz = pz + face.nz;
      const onBoundary = cull >= 0;
      if (onBoundary && !faceVisible(t, id, blocks[paddedIndex(nx, ny, nz)]!)) continue;

      const nAxis = face.nx !== 0 ? 0 : face.ny !== 0 ? 1 : 2;
      const nSign = face.nx + face.ny + face.nz;
      const uAxis = face.ux !== 0 ? 0 : face.uy !== 0 ? 1 : 2;
      const uSign = face.ux + face.uy + face.uz;
      const vAxis = face.vx !== 0 ? 0 : face.vy !== 0 ? 1 : 2;
      const vSign = face.vx + face.vy + face.vz;

      const plane = nSign > 0 ? hi[nAxis]! : lo[nAxis]!;
      const uStart = uSign > 0 ? lo[uAxis]! : hi[uAxis]!;
      const vStart = vSign > 0 ? lo[vAxis]! : hi[vAxis]!;
      const uLen = hi[uAxis]! - lo[uAxis]!;
      const vLen = hi[vAxis]! - lo[vAxis]!;
      if (uLen === 0 || vLen === 0) continue; // 退化成一条线的面不画

      // 贴图坐标以**整格**的面原点为基准，于是半砖的侧面自然只取贴图的下半张
      const originU = ([face.ox, face.oy, face.oz][uAxis] ?? 0) * 16;
      const originV = ([face.ox, face.oy, face.oz][vAxis] ?? 0) * 16;

      buf.ensure(1);
      const layerTex = t.faceLayer[id * 6 + slot]!;
      const faceTint = ((t.tintFaces[id]! >> face.face) & 1) === 1 ? tint : 0;
      const base = buf.quads * 4;

      const ao = [3, 3, 3, 3];
      const lightVals = [ownLight, ownLight, ownLight, ownLight];
      if (onBoundary) sampleFaceLighting(t, blocks, light, face, nx, ny, nz, ao, lightVals);

      const flip = ao[0]! + ao[2]! > ao[1]! + ao[3]!;
      for (let c = 0; c < 4; c++) {
        const addU = c === 1 || c === 2 ? 1 : 0;
        const addV = c === 2 || c === 3 ? 1 : 0;
        const coord = [0, 0, 0];
        coord[nAxis] = plane;
        coord[uAxis] = uStart + uSign * uLen * addU;
        coord[vAxis] = vStart + vSign * vLen * addV;

        const texU = clampUv ? uSign * (coord[uAxis]! - originU) : addU * 16;
        const texV = clampUv ? 16 - vSign * (coord[vAxis]! - originV) : 16 - addV * 16;
        const lv = lightVals[c]!;
        packVertex(
          buf.vertices, buf.vi,
          lx * 16 + coord[0]!, ly * 16 + coord[1]!, lz * 16 + coord[2]!,
          texU, texV, layerTex,
          lv >> 4, lv & 0xf,
          face.face, ao[c]!, faceTint,
        );
        buf.vi += 3;
      }

      if (flip) {
        buf.indices[buf.ii] = base + 1;
        buf.indices[buf.ii + 1] = base + 2;
        buf.indices[buf.ii + 2] = base + 3;
        buf.indices[buf.ii + 3] = base + 1;
        buf.indices[buf.ii + 4] = base + 3;
        buf.indices[buf.ii + 5] = base;
      } else {
        buf.indices[buf.ii] = base;
        buf.indices[buf.ii + 1] = base + 1;
        buf.indices[buf.ii + 2] = base + 2;
        buf.indices[buf.ii + 3] = base;
        buf.indices[buf.ii + 4] = base + 2;
        buf.indices[buf.ii + 5] = base + 3;
      }
      buf.ii += 6;
      buf.quads++;
    }
  }
}

/** 贴边界的面：按四个角做 AO 与平滑光照。逻辑与 M1 的立方体路径相同 */
function sampleFaceLighting(
  t: MesherTables,
  blocks: Uint16Array,
  light: Uint8Array,
  face: (typeof FACES)[number],
  nx: number, ny: number, nz: number,
  ao: number[],
  lightVals: number[],
): void {
  for (let c = 0; c < 4; c++) {
    const dir = CORNER_DIRS[c]!;
    const su = dir[0];
    const sv = dir[1];
    const s1x = nx + face.ux * su, s1y = ny + face.uy * su, s1z = nz + face.uz * su;
    const s2x = nx + face.vx * sv, s2y = ny + face.vy * sv, s2z = nz + face.vz * sv;
    const cxp = nx + face.ux * su + face.vx * sv;
    const cyp = ny + face.uy * su + face.vy * sv;
    const czp = nz + face.uz * su + face.vz * sv;

    const s1 = aoSolid(t, blocks[paddedIndex(s1x, s1y, s1z)]!);
    const s2 = aoSolid(t, blocks[paddedIndex(s2x, s2y, s2z)]!);
    const cn = aoSolid(t, blocks[paddedIndex(cxp, cyp, czp)]!);
    ao[c] = cornerAO(s1, s2, cn);

    let skySum = 0;
    let blockSum = 0;
    let n = 0;
    const addSample = (ix: number, iy: number, iz: number): void => {
      const idx = paddedIndex(ix, iy, iz);
      if (aoSolid(t, blocks[idx]!)) return;
      const lv = light[idx]!;
      skySum += lv >> 4;
      blockSum += lv & 0xf;
      n++;
    };
    addSample(nx, ny, nz);
    if (!s1) addSample(s1x, s1y, s1z);
    if (!s2) addSample(s2x, s2y, s2z);
    if (!cn) addSample(cxp, cyp, czp);
    lightVals[c] = n === 0
      ? light[paddedIndex(nx, ny, nz)]!
      : ((Math.round(skySum / n) & 0xf) << 4) | (Math.round(blockSum / n) & 0xf);
  }
}
