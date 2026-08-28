/**
 * 立方体六个面的几何定义。
 *
 * 每个面用 origin + 两条边向量 u、v 描述，且满足 u × v = 面法线。
 * 于是顶点按 origin, origin+u, origin+u+v, origin+v 的顺序就一定是从外侧看的逆时针，
 * 背面剔除（CCW 为正面）自动成立 —— 不需要逐个面手工试出顶点顺序。
 *
 * 面编号采用 MC 的约定：DOWN=0 UP=1 NORTH=2 SOUTH=3 WEST=4 EAST=5。
 */

export interface FaceDef {
  readonly face: number;
  /** 面朝向的邻居偏移，用于面剔除 */
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** 面的左下角（单位立方体内） */
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;
  /** 第一条边向量（贴图 u 方向） */
  readonly ux: number;
  readonly uy: number;
  readonly uz: number;
  /** 第二条边向量（贴图 v 方向，向上） */
  readonly vx: number;
  readonly vy: number;
  readonly vz: number;
}

export const FACES: readonly FaceDef[] = [
  // DOWN (-Y)
  { face: 0, nx: 0, ny: -1, nz: 0, ox: 0, oy: 0, oz: 0, ux: 1, uy: 0, uz: 0, vx: 0, vy: 0, vz: 1 },
  // UP (+Y)
  { face: 1, nx: 0, ny: 1, nz: 0, ox: 0, oy: 1, oz: 0, ux: 0, uy: 0, uz: 1, vx: 1, vy: 0, vz: 0 },
  // NORTH (-Z)
  { face: 2, nx: 0, ny: 0, nz: -1, ox: 1, oy: 0, oz: 0, ux: -1, uy: 0, uz: 0, vx: 0, vy: 1, vz: 0 },
  // SOUTH (+Z)
  { face: 3, nx: 0, ny: 0, nz: 1, ox: 0, oy: 0, oz: 1, ux: 1, uy: 0, uz: 0, vx: 0, vy: 1, vz: 0 },
  // WEST (-X)
  { face: 4, nx: -1, ny: 0, nz: 0, ox: 0, oy: 0, oz: 0, ux: 0, uy: 0, uz: 1, vx: 0, vy: 1, vz: 0 },
  // EAST (+X)
  { face: 5, nx: 1, ny: 0, nz: 0, ox: 1, oy: 0, oz: 1, ux: 0, uy: 0, uz: -1, vx: 0, vy: 1, vz: 0 },
];

/**
 * 四个角的 UV，单位是 1/16 格（一整格贴图 = 16）。
 * 顺序对应 origin / +u / +u+v / +v。贴图原点在左上，所以 v 轴要翻转。
 */
export const FACE_UV: readonly (readonly [number, number])[] = [
  [0, 16], // origin      -> 左下
  [16, 16], // +u         -> 右下
  [16, 0], // +u+v        -> 右上
  [0, 0], // +v           -> 左上
];
