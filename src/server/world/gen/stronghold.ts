/**
 * 要塞。**纯函数生成器**：给一个种子和区块坐标，返回该往里写哪些方块。
 *
 * ## 它为什么必须存在
 *
 * 要塞是通往末地的**唯一**入口。没有它，末影之眼、末地传送门、
 * 末影龙这一整条主线都无处安放 —— 而"打通主线"正是这个项目的目标。
 *
 * ## 与 MC 的取舍
 *
 * MC 1.0 的要塞是一个递归的房间拼接系统（走廊、螺旋楼梯、图书馆、
 * 十字路口……几十种部件），生成一座要塞要跑几千次随机。那套东西
 * 的价值在"探索感"，而不在玩法 —— 玩家在里面做的事只有一件：
 * 找到传送门房间。
 *
 * 这里做的是一座**规整但完整**的要塞：一条主走廊串起若干房间，
 * 尽头是传送门房间。房间数与朝向由种子决定，所以每个世界的要塞不同；
 * 但它不会长成 MC 那种迷宫。这一条如实记在 docs/DEVIATIONS.md 里。
 *
 * ## 位置
 *
 * MC 1.0 有三座要塞，均匀分布在一个半径 640..1152 格的圆环上。
 * 照抄这个数是因为它决定了"找要塞要走多远"这件事的量级 ——
 * 给近了末影之眼就没意义了，给远了第一次去末地会变成苦役。
 */
import { JavaRandom } from '../../../core/rng/java-random.ts';
import { CHUNK_SIZE } from '../../../core/constants.ts';

/** 有几座要塞。MC 1.0 是 3 */
export const STRONGHOLD_COUNT = 3;
/** 要塞所在圆环的内外半径（格） */
export const STRONGHOLD_MIN_RADIUS = 640;
export const STRONGHOLD_MAX_RADIUS = 1152;
/** 传送门房间的地面高度 */
export const PORTAL_ROOM_Y = 20;
/** 走廊的净高 */
const HALL_HEIGHT = 4;
/** 走廊的净宽 */
const HALL_WIDTH = 3;
/** 传送门房间的边长（内部） */
export const PORTAL_ROOM_SIZE = 11;

export interface StrongholdSite {
  /** 传送门房间中心的世界坐标 */
  readonly x: number;
  readonly z: number;
  /** 主走廊朝哪个方向延伸：0=+X 1=+Z 2=−X 3=−Z */
  readonly facing: number;
  /** 主走廊上挂了几个房间 */
  readonly rooms: number;
}

/**
 * 一个世界的三座要塞在哪。**只依赖种子** —— 末影之眼、地图、
 * 生成器三处都要问这个问题，各算一遍必然漂移，而漂移的表现是
 * "眼睛指向的地方什么都没有"。
 */
export function strongholdSites(seed: bigint): StrongholdSite[] {
  const rand = new JavaRandom(BigInt.asIntN(64, seed ^ 0x5354524fn));
  const out: StrongholdSite[] = [];
  // 起始角随机，之后均分 —— MC 也是这样，于是三座要塞不会挤在一边
  const angle0 = rand.nextDouble() * Math.PI * 2;
  for (let i = 0; i < STRONGHOLD_COUNT; i++) {
    const angle = angle0 + (i / STRONGHOLD_COUNT) * Math.PI * 2;
    const r = STRONGHOLD_MIN_RADIUS
      + rand.nextInt(STRONGHOLD_MAX_RADIUS - STRONGHOLD_MIN_RADIUS);
    out.push({
      x: Math.round(Math.cos(angle) * r),
      z: Math.round(Math.sin(angle) * r),
      facing: rand.nextInt(4),
      rooms: 2 + rand.nextInt(3),
    });
  }
  return out;
}

/** 离某个点最近的要塞 */
export function nearestStronghold(seed: bigint, x: number, z: number): StrongholdSite {
  const sites = strongholdSites(seed);
  let best = sites[0]!;
  let bestD = Infinity;
  for (const s of sites) {
    const d = (s.x - x) ** 2 + (s.z - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/** 要塞用到的方块状态，由调用方按注册表填 */
export interface StrongholdStates {
  readonly stoneBricks: number;
  /**
   * 斑驳的那两种。
   *
   * MC 用的是石砖的**元数据变体**（98:1 苔石砖、98:2 裂石砖），
   * 而本项目的贴图是按方块名索引的、不认元数据。与其为两种装饰砖
   * 铺一整套"按 meta 取贴图"的机制，不如用现成的苔石与圆石顶上 ——
   * 观感接近，如实记在 docs/DEVIATIONS.md。
   */
  readonly mossyStoneBricks: number;
  readonly crackedStoneBricks: number;
  readonly air: number;
  readonly portalFrame: number;
  readonly lavaBelow: number;
  readonly torch: number;
}

/** 往世界里写一格。坐标是世界坐标，实现负责裁剪到目标区块 */
export type StrongholdWriter = (x: number, y: number, z: number, state: number) => void;

/**
 * 把落在 (cx,cz) 这个区块里的要塞部分写出来。
 *
 * 每个区块**独立**决定自己该写什么 —— 不需要"先生成整座要塞再切块"。
 * 这一条让要塞生成不必跨区块通信，也就不需要 MC 那套两阶段缓存。
 * 代价是每个区块都要把整座要塞的几何过一遍，而那只是几百次比较。
 */
export function carveStronghold(
  seed: bigint, cx: number, cz: number, st: StrongholdStates, write: StrongholdWriter,
): boolean {
  const baseX = cx * CHUNK_SIZE;
  const baseZ = cz * CHUNK_SIZE;
  let touched = false;
  for (const site of strongholdSites(seed)) {
    // 快速排除：整座要塞的包围盒离这个区块太远就跳过
    const reach = PORTAL_ROOM_SIZE + site.rooms * 20 + 24;
    if (site.x + reach < baseX || site.x - reach > baseX + CHUNK_SIZE) continue;
    if (site.z + reach < baseZ || site.z - reach > baseZ + CHUNK_SIZE) continue;
    if (carveSite(seed, site, baseX, baseZ, st, write)) touched = true;
  }
  return touched;
}

/** 一座要塞在这个区块里的部分 */
function carveSite(
  seed: bigint, site: StrongholdSite, baseX: number, baseZ: number,
  st: StrongholdStates, write: StrongholdWriter,
): boolean {
  // 墙面的斑驳按坐标播种，不按调用顺序 —— 同一格在任何区块里
  // 算出来必须是同一种砖，否则区块边界上会出现一条颜色不连续的缝
  const brickAt = (x: number, y: number, z: number): number => {
    const h = hash3(seed, x, y, z);
    if ((h & 15) === 0) return st.mossyStoneBricks;
    if ((h & 15) === 1) return st.crackedStoneBricks;
    return st.stoneBricks;
  };
  const inChunk = (x: number, z: number): boolean =>
    x >= baseX && x < baseX + CHUNK_SIZE && z >= baseZ && z < baseZ + CHUNK_SIZE;

  let touched = false;
  /** 挖一个空心盒子：内部掏空，外面包一层砖 */
  const room = (
    cxCenter: number, czCenter: number, halfX: number, halfZ: number, height: number,
  ): void => {
    for (let x = cxCenter - halfX - 1; x <= cxCenter + halfX + 1; x++) {
      for (let z = czCenter - halfZ - 1; z <= czCenter + halfZ + 1; z++) {
        if (!inChunk(x, z)) continue;
        touched = true;
        for (let y = PORTAL_ROOM_Y - 1; y <= PORTAL_ROOM_Y + height; y++) {
          const inside = x > cxCenter - halfX - 1 && x < cxCenter + halfX + 1
            && z > czCenter - halfZ - 1 && z < czCenter + halfZ + 1
            && y > PORTAL_ROOM_Y - 1 && y < PORTAL_ROOM_Y + height;
          write(x, y, z, inside ? st.air : brickAt(x, y, z));
        }
      }
    }
  };

  // 主走廊：从传送门房间往 facing 方向延伸
  const [dx, dz] = FACING[site.facing]!;
  const hallLen = 12 + site.rooms * 14;
  for (let i = 0; i <= hallLen; i++) {
    const hx = site.x + dx * (PORTAL_ROOM_SIZE / 2 + i);
    const hz = site.z + dz * (PORTAL_ROOM_SIZE / 2 + i);
    // 走廊横截面：垂直于前进方向展开
    const half = Math.floor(HALL_WIDTH / 2);
    room(Math.round(hx), Math.round(hz), dx !== 0 ? 0 : half, dz !== 0 ? 0 : half, HALL_HEIGHT);
    // 每隔一段挂一个房间
    if (i > 6 && (i - 7) % 14 === 0) {
      const side = ((i / 14) | 0) % 2 === 0 ? 1 : -1;
      room(
        Math.round(hx + dz * side * 6), Math.round(hz + dx * side * 6),
        4, 4, HALL_HEIGHT + 1,
      );
    }
  }

  // 传送门房间
  const half = Math.floor(PORTAL_ROOM_SIZE / 2);
  room(site.x, site.z, half, half, HALL_HEIGHT + 2);

  // 中间的岩浆池与十二个框架
  for (let x = site.x - 2; x <= site.x + 2; x++) {
    for (let z = site.z - 2; z <= site.z + 2; z++) {
      if (!inChunk(x, z)) continue;
      touched = true;
      write(x, PORTAL_ROOM_Y - 1, z, st.lavaBelow);
    }
  }
  for (const f of portalFrameCells(site)) {
    if (!inChunk(f.x, f.z)) continue;
    touched = true;
    // meta 低 2 位是朝向，第 3 位（值 4）表示嵌了眼。生成时都不嵌
    write(f.x, PORTAL_ROOM_Y, f.z, st.portalFrame | (f.facing << 12));
  }
  // 四角各一支火把，不然房间是全黑的
  for (const [ox, oz] of [[-4, -4], [4, -4], [-4, 4], [4, 4]] as const) {
    const tx = site.x + ox;
    const tz = site.z + oz;
    if (!inChunk(tx, tz)) continue;
    touched = true;
    write(tx, PORTAL_ROOM_Y + 1, tz, st.torch);
  }
  return touched;
}

/** 走廊四个朝向的单位向量 */
const FACING: readonly (readonly [number, number])[] = [[1, 0], [0, 1], [-1, 0], [0, -1]];

/**
 * 十二个末地传送门框架的位置与朝向。
 *
 * 排成一个 3×3 的方框缺四角 —— 与 MC 一致。**朝向必须朝内**：
 * 朝外的话激活时那张黑色平面会画在框外面，看起来像浮在空中。
 */
export function portalFrameCells(
  site: { x: number; z: number },
): { x: number; z: number; facing: number }[] {
  const out: { x: number; z: number; facing: number }[] = [];
  for (let i = -1; i <= 1; i++) {
    // 北边一排朝南，南边一排朝北，西边朝东，东边朝西
    out.push({ x: site.x + i, z: site.z - 2, facing: 0 });
    out.push({ x: site.x + i, z: site.z + 2, facing: 2 });
    out.push({ x: site.x - 2, z: site.z + i, facing: 1 });
    out.push({ x: site.x + 2, z: site.z + i, facing: 3 });
  }
  return out;
}

/** 三维坐标 + 种子的稳定哈希 */
function hash3(seed: bigint, x: number, y: number, z: number): number {
  let h = Number(BigInt.asUintN(32, seed)) ^ 0x9e3779b9;
  h = Math.imul(h ^ x, 0x85ebca6b);
  h = Math.imul(h ^ y, 0xc2b2ae35);
  h = Math.imul(h ^ z, 0x27d4eb2f);
  return (h ^ (h >>> 15)) >>> 0;
}
