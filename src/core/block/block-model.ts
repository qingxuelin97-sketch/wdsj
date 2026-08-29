/**
 * 方块模型：一组带贴图与剔除信息的盒子。
 *
 * 这是"楼梯/半砖/栅栏/门/火把/铁轨/玻璃板/蛋糕/床几乎白送"的那一层。
 * 没有它，每一种非立方体方块都要在 mesher 里加一个 if 分支，
 * 到第五种的时候 mesher 就没法读了 —— 前作正是这么烂掉的。
 *
 * 坐标单位是 **1/16 格**（0..16 的整数），和 MC 的 JSON 模型一致。
 * 用整数而不是浮点，是为了让顶点打包直接落在 1/16 的网格上，
 * 不会因为浮点误差在两个相邻元素之间露出一条缝。
 *
 * ## cullface 是这套东西里最容易写错的一处
 *
 * 一个面只有在**正好贴着格子边界**时才允许被邻居剔除。半砖的顶面在 y=8，
 * 它不贴边界，所以哪怕上面压着一块石头也必须画出来 —— 标成可剔除的话，
 * 半砖上面放东西就会看穿。所以 cullface 由 `autoCullface` 从坐标推导，
 * 而不是让内容作者手写。
 */
import { Facing } from './types.ts';

/** 一个盒子元素。坐标 0..16 */
export interface ModelElement {
  readonly from: readonly [number, number, number];
  readonly to: readonly [number, number, number];
  /**
   * 六个面各用哪个贴图槽（对应 BlockDef.textures 的六面顺序），
   * −1 表示这一面不画。
   */
  readonly faceTexture: readonly number[];
  /**
   * 六个面的剔除方向：贴着该方向的格子边界时填对应 Facing，
   * 否则填 −1（永不剔除）。由 autoCullface 推导。
   */
  readonly cullface: readonly number[];
  /** 这一面的 UV 是否随元素尺寸裁剪。半砖要裁（贴图只用下半张），火把不裁 */
  readonly clampUv: boolean;
}

export interface BlockModel {
  readonly elements: readonly ModelElement[];
}

/** 面在各轴上的"贴边"判据：[轴, 该轴上的期望值] */
const FACE_BOUNDARY: readonly (readonly [number, number])[] = [
  [1, 0],  // DOWN  贴 y=0
  [1, 16], // UP    贴 y=16
  [2, 0],  // NORTH 贴 z=0
  [2, 16], // SOUTH 贴 z=16
  [0, 0],  // WEST  贴 x=0
  [0, 16], // EAST  贴 x=16
];

/**
 * 从元素的坐标推导每个面的 cullface。
 *
 * 只有贴着格子边界的面才可能被邻居完全挡住。这一步交给代码而不是内容作者，
 * 是因为写错的后果（半砖上面放方块会看穿）在编辑器里完全看不出来，
 * 只有在游戏里从特定角度看才会显形。
 */
export function autoCullface(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
): number[] {
  const out: number[] = [];
  for (let f = 0; f < 6; f++) {
    const [axis, want] = FACE_BOUNDARY[f]!;
    const v = want === 0 ? from[axis]! : to[axis]!;
    out.push(v === want ? f : -1);
  }
  return out;
}

/** 造一个元素，cullface 自动推导 */
export function element(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  faceTexture: readonly number[] = [0, 1, 2, 3, 4, 5],
  clampUv = true,
): ModelElement {
  return { from, to, faceTexture, cullface: autoCullface(from, to), clampUv };
}

/** 整格立方体 */
export function cubeModel(): BlockModel {
  return { elements: [element([0, 0, 0], [16, 16, 16])] };
}

/** 半砖。bottom=true 时占下半格 */
export function slabModel(bottom: boolean): BlockModel {
  return bottom
    ? { elements: [element([0, 0, 0], [16, 8, 16])] }
    : { elements: [element([0, 8, 0], [16, 16, 16])] };
}

/**
 * 楼梯：一块半砖 + 一块靠某一侧的四分之一。
 * @param facing 台阶**升高**的那一侧（玩家从对面走上来）
 * @param top 是否上下颠倒（贴着天花板放的楼梯）
 */
export function stairsModel(facing: Facing, top: boolean): BlockModel {
  const base: ModelElement = top
    ? element([0, 8, 0], [16, 16, 16])
    : element([0, 0, 0], [16, 8, 16]);
  // 上半块占哪一侧
  const [x0, z0, x1, z1] =
    facing === Facing.EAST ? [8, 0, 16, 16]
    : facing === Facing.WEST ? [0, 0, 8, 16]
    : facing === Facing.SOUTH ? [0, 8, 16, 16]
    : [0, 0, 16, 8]; // NORTH
  const upper: ModelElement = top
    ? element([x0, 0, z0], [x1, 8, z1])
    : element([x0, 8, z0], [x1, 16, z1]);
  return { elements: [base, upper] };
}

/** 雪层之类的薄片。height 单位 1/16 */
export function layerModel(height: number): BlockModel {
  return { elements: [element([0, 0, 0], [16, height, 16])] };
}

/**
 * 栅栏：中间一根柱子 + 朝各个已连接方向的两根横梁。
 * @param connect 四个水平方向是否连接，顺序 N/S/W/E
 */
export function fenceModel(connect: readonly boolean[]): BlockModel {
  const els: ModelElement[] = [element([6, 0, 6], [10, 16, 10])];
  const bars: [boolean, [number, number, number], [number, number, number]][] = [
    [connect[0] ?? false, [7, 6, 0], [9, 15, 6]],   // N
    [connect[1] ?? false, [7, 6, 10], [9, 15, 16]], // S
    [connect[2] ?? false, [0, 6, 7], [6, 15, 9]],   // W
    [connect[3] ?? false, [10, 6, 7], [16, 15, 9]], // E
  ];
  for (const [on, from, to] of bars) {
    if (!on) continue;
    // 上下两根横梁
    els.push(element(from, [to[0], to[1] - 6, to[2]]));
    els.push(element([from[0], from[1] + 6, from[2]], to));
  }
  return { elements: els };
}

/**
 * 火把：一根细柱。attached 为 null 时立在地上，否则贴在那一侧的墙上。
 *
 * 贴墙的火把在 MC 里是倾斜的，这里用"抬高 + 平移"近似 ——
 * 模型系统不支持旋转元素（那要引入矩阵，而收益只有火把和拉杆两处）。
 * 偏差记在 docs/DEVIATIONS.md。
 */
export function torchModel(attached: Facing | null): BlockModel {
  if (attached === null) {
    return { elements: [element([7, 0, 7], [9, 10, 9], [0, 1, 2, 3, 4, 5], false)] };
  }
  const shift = 5;
  const [dx, dz] =
    attached === Facing.EAST ? [-shift, 0]
    : attached === Facing.WEST ? [shift, 0]
    : attached === Facing.SOUTH ? [0, -shift]
    : [0, shift];
  return {
    elements: [element(
      [7 + dx, 3, 7 + dz], [9 + dx, 13, 9 + dz],
      [0, 1, 2, 3, 4, 5], false,
    )],
  };
}

/** 玻璃板 / 铁栏杆：中间一片，按连接方向伸出 */
export function paneModel(connect: readonly boolean[]): BlockModel {
  const any = connect.some((c) => c);
  if (!any) {
    // 没有连接时画成一个小十字，不然孤立的一块玻璃板是看不见的薄片
    return {
      elements: [
        element([7, 0, 0], [9, 16, 16]),
        element([0, 0, 7], [16, 16, 9]),
      ],
    };
  }
  const els: ModelElement[] = [];
  if (connect[0] === true) els.push(element([7, 0, 0], [9, 16, 9]));
  if (connect[1] === true) els.push(element([7, 0, 7], [9, 16, 16]));
  if (connect[2] === true) els.push(element([0, 0, 7], [9, 16, 9]));
  if (connect[3] === true) els.push(element([7, 0, 7], [16, 16, 9]));
  if (els.length === 0) els.push(element([7, 0, 7], [9, 16, 9]));
  return { elements: els };
}

/** 门：占半格厚，贴在某一侧 */
export function doorModel(facing: Facing, open: boolean): BlockModel {
  // 关着时门板贴在 facing 那一侧；开着时转 90°
  const dir = open ? rotateCw(facing) : facing;
  const t = 3;
  const box: [[number, number, number], [number, number, number]] =
    dir === Facing.NORTH ? [[0, 0, 0], [16, 16, t]]
    : dir === Facing.SOUTH ? [[0, 0, 16 - t], [16, 16, 16]]
    : dir === Facing.WEST ? [[0, 0, 0], [t, 16, 16]]
    : [[16 - t, 0, 0], [16, 16, 16]];
  return { elements: [element(box[0], box[1])] };
}

/** 蛋糕：被吃掉 bites 口之后剩下的部分 */
export function cakeModel(bites: number): BlockModel {
  const eaten = Math.min(6, Math.max(0, bites));
  const x0 = 1 + eaten * 2;
  return { elements: [element([x0, 0, 1], [15, 8, 15])] };
}

/** 床：占 9/16 高 */
export function bedModel(): BlockModel {
  return { elements: [element([0, 0, 0], [16, 9, 16])] };
}

/** 铁轨：贴地的一张薄片 */
export function railModel(): BlockModel {
  return { elements: [element([0, 0, 0], [16, 1, 16], [-1, 1, -1, -1, -1, -1], false)] };
}

/** 顺时针转 90°（俯视） */
function rotateCw(f: Facing): Facing {
  switch (f) {
    case Facing.NORTH: return Facing.EAST;
    case Facing.EAST: return Facing.SOUTH;
    case Facing.SOUTH: return Facing.WEST;
    case Facing.WEST: return Facing.NORTH;
    default: return f;
  }
}

/**
 * 模型的碰撞盒。
 *
 * 直接由模型元素推导，而不是另写一份 —— 这样"看得见的形状"和
 * "撞得到的形状"永远一致。两份分开写的话，改了模型忘了改碰撞，
 * 表现是玩家卡在看不见的东西上，且极难复现。
 */
export function modelCollisionBoxes(model: BlockModel): [number, number, number, number, number, number][] {
  return model.elements.map((e) => [
    e.from[0] / 16, e.from[1] / 16, e.from[2] / 16,
    e.to[0] / 16, e.to[1] / 16, e.to[2] / 16,
  ]);
}

/** 该模型是否是一个完整的整格立方体（决定能不能剔除邻居的面、能不能挡光） */
export function isFullCube(model: BlockModel): boolean {
  if (model.elements.length !== 1) return false;
  const e = model.elements[0]!;
  return e.from[0] === 0 && e.from[1] === 0 && e.from[2] === 0
    && e.to[0] === 16 && e.to[1] === 16 && e.to[2] === 16;
}
