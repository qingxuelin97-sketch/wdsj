/**
 * 末影龙战。**整个游戏的结局**，所以它的每一条规则都要能被玩家读出来。
 *
 * MC 1.0 的龙战是三段式：
 *
 *   1. **拆水晶** —— 龙飞过黑曜石柱时会被柱顶的水晶治疗。
 *      不先拆水晶的话，玩家的伤害永远追不上回血速度 ——
 *      而这一点玩家是**自己发现**的（打半天血条不动，抬头看见一道光束）。
 *      光束是这场战斗唯一的教学，所以必须有。
 *   2. **追着打** —— 龙绕着主岛盘旋，间或俯冲。
 *   3. **死** —— 掉一大堆经验，出口传送门与龙蛋出现。
 *
 * ## 为什么单独一个文件而不是一个 Goal
 *
 * 因为它不是"一种脾气"，而是一场**有阶段的战斗**：龙的行为取决于
 * 还剩几个水晶、血量到了哪一档。塞进 GoalSelector 会让那套
 * "按优先级抢通道"的机制去表达一个状态机，两边都会变得难懂。
 */
import type { ServerCore } from '../server-core.ts';
import type { ServerWorld } from '../world/server-world.ts';
import type { Mob } from './mob.ts';
import { MobType, mobDefOf } from '../../content/mobs.ts';
import { Dimension } from '../../core/world/dimension.ts';
import { endPillars, END_GROUND_Y } from '../world/gen/end-gen.ts';
import { packState } from '../../core/world/chunk.ts';
import { Blocks } from '../../content/blocks.ts';

/** 龙每刻飞多远 */
const DRAGON_SPEED = 0.55;
/** 盘旋半径 */
const CIRCLE_RADIUS = 46;
/** 盘旋高度（相对末地地面） */
const CIRCLE_HEIGHT = 22;
/** 水晶治疗一次给多少血 */
export const CRYSTAL_HEAL = 1;
/** 多少刻治疗一次 */
export const CRYSTAL_HEAL_INTERVAL = 10;
/** 水晶的治疗半径 */
export const CRYSTAL_HEAL_RANGE = 32;
/** 龙俯冲时离玩家多近算撞到 */
const DRAGON_HIT_RANGE = 4;
/** 两次俯冲之间的间隔 */
const CHARGE_INTERVAL = 200;
/** 一次俯冲持续多久 */
const CHARGE_TICKS = 80;
/** 出口传送门的黑曜石台半径 */
const EXIT_RADIUS = 4;

/**
 * 一场龙战的状态。
 *
 * 挂在 ServerCore 上而不是龙身上：龙死了之后还要放出口传送门、
 * 龙蛋与经验，那些事发生在"龙已经不存在"之后。
 */
export class DragonFight {
  /** 龙的实体 id，-1 表示没有龙 */
  dragonId = -1;
  /** 还活着的水晶 */
  readonly crystals = new Set<number>();
  /** 龙已经绕了多少弧度 */
  angle = 0;
  /** 距离下一次俯冲还有几刻 */
  chargeTimer = CHARGE_INTERVAL;
  /** 正在俯冲的剩余刻数 */
  charging = 0;
  /** 龙死了没（用来只放一次出口传送门） */
  finished = false;
  /**
   * 真的看见它血空过。
   *
   * "龙不在生物表里了"**不等于**"龙死了"：`killall`、区块卸载、
   * 换存档都会让它消失。不分这两种情况的话，一条 killall 指令
   * 就会凭空在末地建起出口传送门、撒下一万二经验 —— 而那之后
   * 服务端要 tick 的实体多到指令全部超时。这是实测出来的。
   */
  sawDeath = false;
  /** 战斗初始化过了没 */
  spawned = false;
}

/**
 * 玩家第一次进末地时把龙和水晶摆好。
 *
 * 只做一次 —— 反复调的话每来一个玩家就多一条龙。
 */
export function beginDragonFight(core: ServerCore): void {
  const fight = core.dragonFight;
  if (fight.spawned || fight.finished) return;
  fight.spawned = true;
  const end = core.worldOf(Dimension.END);
  const dragonDef = mobDefOf(MobType.ENDER_DRAGON);
  const crystalDef = mobDefOf(MobType.ENDER_CRYSTAL);
  if (dragonDef === null || crystalDef === null) return;

  for (const p of endPillars(end.seed)) {
    // 水晶坐在柱顶的基岩上。柱子由生成器立起来，这里只放水晶 ——
    // 两边各算一次柱高必然漂移，而漂移的表现是水晶悬在半空
    const c = core.mobs.spawn(
      crystalDef, p.x + 0.5, END_GROUND_Y + p.height + 2, p.z + 0.5, Dimension.END,
    );
    fight.crystals.add(c.entityId);
  }

  const dragon = core.mobs.spawn(dragonDef, 0.5, END_GROUND_Y + CIRCLE_HEIGHT, 0.5, Dimension.END);
  fight.dragonId = dragon.entityId;
}

/**
 * 龙战的一刻。
 *
 * 排在生物 tick **之后**：龙的位置这一刻已经算完了，
 * 治疗与俯冲判定要看的是新位置。
 */
export function tickDragonFight(core: ServerCore): void {
  const fight = core.dragonFight;
  if (fight.dragonId < 0) return;
  const dragon = core.mobs.mobs.get(fight.dragonId);
  if (dragon !== undefined && !dragon.alive) {
    // 血空了但死亡动画还在播。记下来，等它真的从表里消失再结算
    fight.sawDeath = true;
    return;
  }
  if (dragon === undefined) {
    if (fight.sawDeath) onDragonDeath(core, undefined);
    // 没看见它死却不见了 —— 被 killall 或卸载收走了。
    // 这一场就此作废，不结算也不再找它
    fight.dragonId = -1;
    return;
  }
  const end = core.worldOf(Dimension.END);
  flyDragon(fight, dragon, core, end);
  healFromCrystals(core, fight, dragon);
}

/** 龙的飞行：盘旋 + 间或俯冲 */
function flyDragon(fight: DragonFight, dragon: Mob, core: ServerCore, end: ServerWorld): void {
  const target = nearestEndPlayer(core, dragon);

  if (fight.charging > 0) {
    fight.charging--;
    if (target !== null) {
      // 俯冲：直奔玩家
      const dx = target.x - dragon.x;
      const dy = target.y + 1 - dragon.y;
      const dz = target.z - dragon.z;
      const len = Math.hypot(dx, dy, dz) || 1;
      dragon.body.vx = (dx / len) * DRAGON_SPEED * 1.6;
      dragon.body.vy = (dy / len) * DRAGON_SPEED * 1.6;
      dragon.body.vz = (dz / len) * DRAGON_SPEED * 1.6;
      dragon.body.yaw = Math.atan2(dx, dz);
      dragon.headYaw = dragon.body.yaw;
      if (len < DRAGON_HIT_RANGE) {
        core.damagePlayer(target.player, dragon.def.attackDamage, dragon.x, dragon.z);
        // 撞到就结束这一次俯冲，不然会贴着玩家连续造成伤害
        fight.charging = 0;
      }
    }
    if (fight.charging === 0) fight.chargeTimer = CHARGE_INTERVAL;
    return;
  }

  // 盘旋
  fight.angle += DRAGON_SPEED / CIRCLE_RADIUS;
  const wantX = Math.cos(fight.angle) * CIRCLE_RADIUS;
  const wantZ = Math.sin(fight.angle) * CIRCLE_RADIUS;
  const wantY = END_GROUND_Y + CIRCLE_HEIGHT;
  dragon.body.vx = clampStep(wantX - dragon.x);
  dragon.body.vy = clampStep(wantY - dragon.y);
  dragon.body.vz = clampStep(wantZ - dragon.z);
  // 头朝前进方向
  dragon.body.yaw = Math.atan2(dragon.body.vx, dragon.body.vz);
  dragon.headYaw = dragon.body.yaw;
  void end;

  fight.chargeTimer--;
  if (fight.chargeTimer <= 0 && target !== null) fight.charging = CHARGE_TICKS;
}

function clampStep(d: number): number {
  return Math.max(-DRAGON_SPEED, Math.min(DRAGON_SPEED, d * 0.12));
}

/**
 * 水晶治疗。
 *
 * 每 10 刻回 1 点：200 血、10 个水晶，全留着的话玩家每秒要打出
 * 20 点伤害才追得平 —— 而钻石剑一下才 7。这个数就是"必须先拆水晶"
 * 这条规则的全部来源。
 */
function healFromCrystals(core: ServerCore, fight: DragonFight, dragon: Mob): void {
  // 先清掉已经炸掉的
  for (const id of [...fight.crystals]) {
    const c = core.mobs.mobs.get(id);
    if (c === undefined || !c.alive) fight.crystals.delete(id);
  }
  if (fight.crystals.size === 0) return;
  if (dragon.age % CRYSTAL_HEAL_INTERVAL !== 0) return;
  for (const id of fight.crystals) {
    const c = core.mobs.mobs.get(id);
    if (c === undefined) continue;
    if (Math.hypot(c.x - dragon.x, c.z - dragon.z) > CRYSTAL_HEAL_RANGE) continue;
    dragon.health = Math.min(dragon.def.maxHealth, dragon.health + CRYSTAL_HEAL);
    // 一刻只回一次，不叠加。叠加的话十个水晶一起照会让龙瞬间满血，
    // 而玩家看到的是"血条纹丝不动"，完全读不出发生了什么
    return;
  }
}

/** 离龙最近的、在末地的玩家 */
function nearestEndPlayer(
  core: ServerCore, dragon: Mob,
): { x: number; y: number; z: number; player: Parameters<typeof core.damagePlayer>[0] } | null {
  let best: ReturnType<typeof nearestEndPlayer> = null;
  let bestD = Infinity;
  for (const p of core.eachPlayer()) {
    if (p.dimension !== Dimension.END || p.health <= 0) continue;
    const d = (p.x - dragon.x) ** 2 + (p.z - dragon.z) ** 2;
    if (d >= bestD) continue;
    bestD = d;
    best = { x: p.x, y: p.y, z: p.z, player: p };
  }
  return best;
}

/**
 * 龙死了：放出口传送门、龙蛋，撒经验。
 *
 * 出口传送门是**通关的证明**，龙蛋是唯一的纪念品。两样都只放一次。
 */
export function onDragonDeath(core: ServerCore, dragon: Mob | undefined): void {
  const fight = core.dragonFight;
  if (fight.finished) return;
  fight.finished = true;
  fight.dragonId = -1;

  const end = core.worldOf(Dimension.END);
  const bedrock = packState(core.registry.idOf(Blocks.BEDROCK));
  const portal = packState(core.registry.idOf(Blocks.END_PORTAL));
  const egg = packState(core.registry.idOf(Blocks.DRAGON_EGG));
  const y = END_GROUND_Y;
  end.forceChunk(0, 0);

  // 一座圆形的基岩台，中间三格是出口传送门
  for (let dx = -EXIT_RADIUS; dx <= EXIT_RADIUS; dx++) {
    for (let dz = -EXIT_RADIUS; dz <= EXIT_RADIUS; dz++) {
      if (dx * dx + dz * dz > EXIT_RADIUS * EXIT_RADIUS) continue;
      end.setBlock(dx, y, dz, bedrock);
      // 台面以上清空，不然玩家会被埋在龙战中撞出来的碎块里
      for (let h = 1; h <= 4; h++) end.setBlock(dx, y + h, dz, 0);
    }
  }
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) end.setBlock(dx, y + 1, dz, portal);
  }
  // 龙蛋落在传送门正上方的一根柱子顶上，与 MC 一致
  end.setBlock(0, y + 2, 0, bedrock);
  end.setBlock(0, y + 3, 0, bedrock);
  end.setBlock(0, y + 4, 0, egg);

  if (dragon !== undefined) {
    core.mobs.giveDragonXp(end, dragon.x, dragon.y, dragon.z, dragon.def.xp);
  } else {
    core.mobs.giveDragonXp(end, 0.5, y + 2, 0.5, 12000);
  }
  for (const p of core.eachPlayer()) core.sendChat(p, '末影龙被击败了');
}
