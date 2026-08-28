/**
 * M0 的最小网格化器：只做面剔除，不做 AO、不做贪心合并、不跨区块。
 *
 * 它的作用是把顶点格式、面朝向、UV 映射、背面剔除这几件事在 M0 就跑通并可断言；
 * M1 会把它替换成 worker 里的完整实现（18³ padded 邻域 + AO + 贪心合并）。
 * 保留这个简单版是有意的：M1 的完整 mesher 要拿它当差分基准。
 */
import { SECTION_SIZE } from '../../core/constants.ts';
import { packVertex } from '../render/block-shader.ts';
import { FACES, FACE_UV } from './cube-faces.ts';

/** 每个方块六个面各自的贴图层号；-1 表示该方块是空气 */
export interface BlockAppearance {
  /** 按 FACE 编号索引的 6 个层号 */
  readonly layers: readonly [number, number, number, number, number, number];
}

export interface SimpleMeshResult {
  /** 每顶点 3 个 uint32 */
  readonly vertices: Uint32Array;
  readonly indices: Uint32Array;
  readonly quadCount: number;
}

const S = SECTION_SIZE;

function idx(x: number, y: number, z: number): number {
  return (y * S + z) * S + x;
}

/**
 * @param blocks  长度 4096 的方块数组，0 表示空气
 * @param appearance 方块 id -> 六面贴图层号
 * @param skyLight 统一的天光值（M0 还没有光照引擎，M4 会替换）
 */
export function meshSection(
  blocks: Uint16Array,
  appearance: ReadonlyMap<number, BlockAppearance>,
  skyLight = 15,
): SimpleMeshResult {
  if (blocks.length !== S * S * S) {
    throw new RangeError(`blocks 长度应为 ${S * S * S}，实得 ${blocks.length}`);
  }

  // 先数一遍需要多少个面，一次性分配到位，避免热循环里 push 造成的百万次分配
  let faceCount = 0;
  for (let y = 0; y < S; y++) {
    for (let z = 0; z < S; z++) {
      for (let x = 0; x < S; x++) {
        if (blocks[idx(x, y, z)] === 0) continue;
        for (const f of FACES) {
          const nx = x + f.nx;
          const ny = y + f.ny;
          const nz = z + f.nz;
          // 越界当作空气：M0 只渲染单个 section，没有邻居数据。
          // M1 会传入 18³ 的 padded 邻域来消除这里的边界假面。
          const outside = nx < 0 || nx >= S || ny < 0 || ny >= S || nz < 0 || nz >= S;
          if (outside || blocks[idx(nx, ny, nz)] === 0) faceCount++;
        }
      }
    }
  }

  const vertices = new Uint32Array(faceCount * 4 * 3);
  const indices = new Uint32Array(faceCount * 6);
  let vi = 0;
  let ii = 0;
  let quad = 0;

  for (let y = 0; y < S; y++) {
    for (let z = 0; z < S; z++) {
      for (let x = 0; x < S; x++) {
        const id = blocks[idx(x, y, z)]!;
        if (id === 0) continue;
        const look = appearance.get(id);
        if (look === undefined) continue;

        for (const f of FACES) {
          const nx = x + f.nx;
          const ny = y + f.ny;
          const nz = z + f.nz;
          const outside = nx < 0 || nx >= S || ny < 0 || ny >= S || nz < 0 || nz >= S;
          if (!outside && blocks[idx(nx, ny, nz)] !== 0) continue;

          const layer = look.layers[f.face]!;
          const base = quad * 4;

          // 四个角：origin, +u, +u+v, +v —— 顺序保证从外侧看是逆时针
          for (let c = 0; c < 4; c++) {
            const addU = c === 1 || c === 2 ? 1 : 0;
            const addV = c === 2 || c === 3 ? 1 : 0;
            const px = x + f.ox + f.ux * addU + f.vx * addV;
            const py = y + f.oy + f.uy * addU + f.vy * addV;
            const pz = z + f.oz + f.uz * addU + f.vz * addV;
            const uv = FACE_UV[c]!;
            packVertex(
              vertices,
              vi,
              px * 16,
              py * 16,
              pz * 16,
              uv[0],
              uv[1],
              layer,
              skyLight,
              0,
              f.face,
              3, // M0 没有 AO，恒取最亮
              0,
            );
            vi += 3;
          }

          indices[ii] = base;
          indices[ii + 1] = base + 1;
          indices[ii + 2] = base + 2;
          indices[ii + 3] = base;
          indices[ii + 4] = base + 2;
          indices[ii + 5] = base + 3;
          ii += 6;
          quad++;
        }
      }
    }
  }

  return { vertices, indices, quadCount: quad };
}

export { idx as sectionIndex };
