/**
 * 下界传送门的**几何**。纯函数：读一个方块查询回调，返回要填哪些格子。
 *
 * 把它从世界对象里剥出来，是为了能在 node 里用一张手写的假地图逐格断言。
 * 传送门是个很容易"看起来对"的东西 —— 点火之后紫色出现了，
 * 但门柱少一格、或者朝向判反了，要等真的走进去才发现。
 *
 * ## MC 1.0 的门是固定尺寸的
 *
 * 内部恰好 **2 宽 × 3 高**，外面一圈黑曜石（角上可以缺）。
 * 后来的版本才允许 2..21 宽。这里照 1.0 实现 —— "1:1 复刻 1.0"
 * 意味着连"造不了大门"这件事也要一样。
 *
 * ## 朝向
 *
 * 门只能立在 X 轴或 Z 轴平面上。判定方式照抄 MC：看点火处的左右
 * 有没有黑曜石。**两边都有或都没有就不成门** —— 这不是偷懒，
 * 而是它让"在黑曜石房间中间点火"不会意外造出门。
 */

/** 内部宽度（格），MC 1.0 固定 2 */
export const PORTAL_WIDTH = 2;
/** 内部高度（格），MC 1.0 固定 3 */
export const PORTAL_HEIGHT = 3;

/** 门所在的平面 */
export type PortalAxis = 'x' | 'z';

export interface PortalShape {
  readonly axis: PortalAxis;
  /** 内部左下角（沿轴方向最小、Y 最小的那一格） */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** 内部的六格 */
  readonly cells: readonly { x: number; y: number; z: number }[];
}

/** 判断某坐标是不是黑曜石 / 是不是可被门占据的空位 */
export interface PortalProbe {
  isFrame(x: number, y: number, z: number): boolean;
  /** 空气或火 —— 门内部允许的东西 */
  isEmpty(x: number, y: number, z: number): boolean;
}

/** 沿轴走一格的方向向量 */
function step(axis: PortalAxis): { dx: number; dz: number } {
  return axis === 'x' ? { dx: 1, dz: 0 } : { dx: 0, dz: 1 };
}

/**
 * 从点火处判定门的形状。
 *
 * @param x,y,z 被点着的那一格（打火石打在门内部的地面上）
 * @returns 成门则返回形状，否则 null
 */
export function findPortalShape(p: PortalProbe, x: number, y: number, z: number): PortalShape | null {
  // 朝向：宽度沿 X 的门，两根柱子就在 ±X 上。
  // 两边都有或都没有就不成门 —— 见文件头
  const framedOnX = p.isFrame(x - 1, y, z) || p.isFrame(x + 1, y, z);
  const framedOnZ = p.isFrame(x, y, z - 1) || p.isFrame(x, y, z + 1);
  let axis: PortalAxis;
  if (framedOnX && !framedOnZ) axis = 'x';
  else if (framedOnZ && !framedOnX) axis = 'z';
  else return null;

  const { dx, dz } = step(axis);

  // 沿轴往负方向退到内部的第一格。
  // 只退一格：宽度固定 2，退更多就不是 1.0 的门了
  let x0 = x;
  let z0 = z;
  if (p.isEmpty(x - dx, y, z - dz) && !p.isFrame(x - dx, y, z - dz)) {
    x0 -= dx;
    z0 -= dz;
  }

  // 往下落到底：玩家可能打在门内部的第二、三层
  let y0 = y;
  while (y0 > 0 && p.isEmpty(x0, y0 - 1, z0) && p.isEmpty(x0 + dx, y0 - 1, z0 + dz)) y0--;

  return verifyPortal(p, axis, x0, y0, z0);
}

/**
 * 校验一个候选的内部左下角是不是完整的门，是则返回形状。
 *
 * 单独暴露出来，是为了"传送落点找现成的门"也能用同一份校验 ——
 * 两份实现会漂移，而漂移的症状是"点火造得出的门，搜索却认不出"。
 */
export function verifyPortal(
  p: PortalProbe, axis: PortalAxis, x0: number, y0: number, z0: number,
): PortalShape | null {
  const { dx, dz } = step(axis);
  const cells: { x: number; y: number; z: number }[] = [];

  for (let w = 0; w < PORTAL_WIDTH; w++) {
    const cx = x0 + dx * w;
    const cz = z0 + dz * w;
    // 底与顶
    if (!p.isFrame(cx, y0 - 1, cz)) return null;
    if (!p.isFrame(cx, y0 + PORTAL_HEIGHT, cz)) return null;
    for (let h = 0; h < PORTAL_HEIGHT; h++) {
      if (!p.isEmpty(cx, y0 + h, cz)) return null;
      cells.push({ x: cx, y: y0 + h, z: cz });
    }
  }
  // 两侧的柱子
  for (let h = 0; h < PORTAL_HEIGHT; h++) {
    if (!p.isFrame(x0 - dx, y0 + h, z0 - dz)) return null;
    if (!p.isFrame(x0 + dx * PORTAL_WIDTH, y0 + h, z0 + dz * PORTAL_WIDTH)) return null;
  }
  // 角不检查 —— MC 允许缺角，玩家造门时也确实常常不放角上那四格
  return { axis, x: x0, y: y0, z: z0, cells };
}

/**
 * 在目标维度凭空造一座门时，框与内部各要哪些格子。
 *
 * 找不到现成的门就要造一座（MC 的行为），而造出来的必须是
 * `verifyPortal` 认得的形状 —— 否则玩家再走回来时会被判定成"没有门"，
 * 于是又造一座，几次之后目标点周围会长出一片黑曜石林。
 *
 * @returns frame 要放黑曜石的格子，interior 要放门方块的格子
 */
export function buildPortalPlan(
  axis: PortalAxis, x0: number, y0: number, z0: number,
): { frame: { x: number; y: number; z: number }[]; interior: { x: number; y: number; z: number }[] } {
  const { dx, dz } = step(axis);
  const frame: { x: number; y: number; z: number }[] = [];
  const interior: { x: number; y: number; z: number }[] = [];
  // 沿轴 −1..宽度，竖直 −1..高度 —— 一圈框加中间的洞
  for (let w = -1; w <= PORTAL_WIDTH; w++) {
    for (let h = -1; h <= PORTAL_HEIGHT; h++) {
      const cx = x0 + dx * w;
      const cz = z0 + dz * w;
      const cy = y0 + h;
      const inside = w >= 0 && w < PORTAL_WIDTH && h >= 0 && h < PORTAL_HEIGHT;
      const corner = (w === -1 || w === PORTAL_WIDTH) && (h === -1 || h === PORTAL_HEIGHT);
      if (inside) interior.push({ x: cx, y: cy, z: cz });
      else if (!corner) frame.push({ x: cx, y: cy, z: cz });
    }
  }
  return { frame, interior };
}
