/**
 * 自然生成：什么时候、在哪里、刷什么。
 *
 * 从 mob-manager.ts 拆出来的（那个文件到了 614 行、越过 600 硬上限），
 * 但分界线不是"腾地方"而是**两件不同的事**：mob-manager 管的是
 * "已经存在的生物这一刻怎么动、怎么同步给客户端"，这里管的是
 * "世界里该不该多一只怪"。前者每刻都跑，后者每 20 刻才跑一次；
 * 前者与网络协议纠缠，后者只跟世界和随机数打交道。
 *
 * 写成模块函数而不是类的方法，是因为它们只需要 MobManager 的
 * 三四个公开入口（spawn / countOf / core）—— 用参数传比留在类里
 * 更能说明"生成逻辑不掌握生物列表"。
 */
import type { MobManager } from './mob-manager.ts';
import type { ServerWorld } from '../world/server-world.ts';
import type { ServerPlayer } from '../player/server-player.ts';
import { MobCategory, mobDefOf, type MobDef } from '../../content/mobs.ts';
import { WORLD_HEIGHT } from '../../core/constants.ts';

/** 一个世界里最多几只敌对生物 */
export const HOSTILE_CAP = 70;
/** 最多几只动物 */
export const PASSIVE_CAP = 15;
/** 敌对生物要离玩家多远才能刷 */
const MIN_SPAWN_DISTANCE = 24;
/** 敌对生物能在多暗的地方刷 */
const MAX_SPAWN_LIGHT = 7;
/** 一轮最多尝试几个位置 */
const SPAWN_ATTEMPTS = 24;


/** 这一格能不能站一只这么大的生物 */
export function standable(m: MobManager, x: number, y: number, z: number, def: MobDef): boolean {
  const world = m.core.world;
  const tables = world.tables;
  const solidAt = (bx: number, by: number, bz: number): boolean => {
    const id = world.getBlock(bx, by, bz) & 0xfff;
    return id !== 0 && (tables.solid[id] ?? 0) !== 0;
  };
  if (!solidAt(x, y - 1, z)) return false;
  const top = Math.ceil(def.height);
  for (let oy = 0; oy < top; oy++) {
    if (y + oy >= WORLD_HEIGHT) return false;
    if (solidAt(x, y + oy, z)) return false;
  }
  return true;
}

// -------------------------------------------------------------------------
// 生成
// -------------------------------------------------------------------------

/**
 * 试着刷一批生物。
 *
 * 规则照抄 1.0 的可观察部分：敌对生物要方块光 ≤7、离玩家 >24 格、
 * 在已加载区块里、脚下站得住；动物只在白天的草地上刷。
 * 上限分开算（敌对 70 / 动物 15）—— 合在一起算的话，天黑之后动物会被
 * 挤得刷不出来，而 MC 里两者互不影响。
 */
export function trySpawn(m: MobManager, day: boolean, world: ServerWorld): void {
  const rng = world.random;
  // 只用**这个维度里**的玩家当锚点。不筛的话，主世界的玩家会
  // 在下界的同名坐标上刷出一圈怪，而那边一个人都没有
  const players = [...m.core.eachPlayer()].filter((p) => p.dimension === world.dimension);
  if (players.length === 0) return;
  // 下界的刷怪表与主世界完全不同：没有动物，敌对里多了恶魂。
  // 而且下界永远是"夜晚"（没有天光），所以不看 day
  const nether = world.dimension === -1;
  const pool = nether ? NETHER_POOL : HOSTILE_POOL;

  let hostiles = m.countOf(MobCategory.HOSTILE);
  let passives = m.countOf(MobCategory.PASSIVE);
  if (hostiles >= HOSTILE_CAP && passives >= PASSIVE_CAP) return;

  for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
    // 上限要在**循环里**复查。只在进循环前查一次的话，一轮 24 次尝试
    // 全成功就会一次性超出上限 24 只，而且越接近上限超得越多
    const wantHostile = hostiles < HOSTILE_CAP;
    const wantPassive = passives < PASSIVE_CAP;
    if (!wantHostile && !wantPassive) return;
    const anchor = players[rng.nextInt(players.length)]!;
    // 在玩家周围 24..48 格的环带里挑点。太近了会当着面刷出来，
    // 太远了在视距外白刷一批然后立刻超距消失
    const angle = rng.nextDouble() * Math.PI * 2;
    const dist = MIN_SPAWN_DISTANCE + rng.nextInt(24);
    const x = Math.floor(anchor.x + Math.cos(angle) * dist);
    const z = Math.floor(anchor.z + Math.sin(angle) * dist);
    if (!world.isLoaded(x >> 4, z >> 4)) continue;

    const surface = world.store.getHeight(x, z);
    if (surface <= 0 || surface >= WORLD_HEIGHT - 2) continue;

    // 敌对：从地表往下找一个够暗的落脚点（洞里也能刷）
    if (wantHostile) {
      const y = findHostileSpot(m, x, z, surface, rng.nextInt(Math.max(1, surface)));
      if (y > 0 && farEnough(m, x, y, z, players)) {
        const def = pool[rng.nextInt(pool.length)]!;
        // 恶魂在空中刷，不需要落脚点 —— 拿 standable 判它的话
        // 一只都刷不出来（它 4 格高，地面上根本站不下）
        if (def.flying) {
          m.spawn(def, x + 0.5, Math.min(WORLD_HEIGHT - 6, y + 20), z + 0.5, world.dimension);
          hostiles++;
          continue;
        }
        if (standable(m, x, y, z, def)) {
          m.spawn(def, x + 0.5, y, z + 0.5, world.dimension);
          hostiles++;
          continue;
        }
      }
    }

    // 动物：白天、地表、草方块上。下界没有动物
    if (wantPassive && day && !nether) {
      const y = surface;
      const below = world.getBlock(x, y - 1, z) & 0xfff;
      if (below === m.core.registry.idOf('grass_block') && farEnough(m, x, y, z, players)) {
        const def = PASSIVE_POOL[rng.nextInt(PASSIVE_POOL.length)]!;
        if (standable(m, x, y, z, def)) {
          m.spawn(def, x + 0.5, y, z + 0.5);
          passives++;
        }
      }
    }
  }
}

/** 从某个高度往下找第一个够暗、站得住的位置 */
function findHostileSpot(m: MobManager, x: number, z: number, surface: number, startOffset: number): number {
  const world = m.core.world;
  const from = Math.min(surface, Math.max(2, startOffset + 2));
  for (let y = from; y > 1; y--) {
    if (world.store.getBlockLight(x, y, z) > MAX_SPAWN_LIGHT) continue;
    if (world.store.getSkyLight(x, y, z) > MAX_SPAWN_LIGHT) continue;
    const below = world.getBlock(x, y - 1, z) & 0xfff;
    if (below === 0) continue;
    if ((world.getBlock(x, y, z) & 0xfff) !== 0) continue;
    if ((world.getBlock(x, y + 1, z) & 0xfff) !== 0) continue;
    return y;
  }
  return -1;
}

function farEnough(m: MobManager, x: number, y: number, z: number, players: readonly ServerPlayer[]): boolean {
  for (const p of players) {
    const dx = p.x - x;
    const dy = p.y - y;
    const dz = p.z - z;
    if (dx * dx + dy * dy + dz * dz < MIN_SPAWN_DISTANCE * MIN_SPAWN_DISTANCE) return false;
  }
  return true;
}

// -------------------------------------------------------------------------

/** 敌对生物的生成池。末影人在 1.0 里比较少见，这里靠重复次数控制比例 */
const HOSTILE_POOL: readonly MobDef[] = [
  mobDefOf(4)!, mobDefOf(4)!, mobDefOf(4)!,   // 僵尸 ×3
  mobDefOf(5)!, mobDefOf(5)!, mobDefOf(5)!,   // 骷髅 ×3
  mobDefOf(6)!, mobDefOf(6)!,                 // 苦力怕 ×2
  mobDefOf(7)!, mobDefOf(7)!,                 // 蜘蛛 ×2
  mobDefOf(8)!,                               // 末影人 ×1
];

/**
 * 下界的生成池。
 *
 * 恶魂只占 1/5：它体型 4×4、能隔着 64 格开火，密度给高一点整个下界
 * 就没法走了。MC 的恶魂权重也很低，正是这个道理。
 * 骷髅在下界照样刷（1.0 里下界要塞才有凋灵骷髅，普通骷髅是通刷的）。
 */
const NETHER_POOL: readonly MobDef[] = [
  mobDefOf(9)!,                               // 恶魂 ×1
  mobDefOf(4)!, mobDefOf(4)!,                 // 僵尸 ×2
  mobDefOf(5)!, mobDefOf(5)!,                 // 骷髅 ×2
];

const PASSIVE_POOL: readonly MobDef[] = [
  mobDefOf(0)!, mobDefOf(1)!, mobDefOf(2)!, mobDefOf(3)!,
];
