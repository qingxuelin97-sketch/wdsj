/**
 * 恶魂与它的火球。
 *
 * ## 为什么火球是"生物"
 *
 * 因为**玩家要能打到它**。箭走的是另一条链路（服务端算完就完，
 * 客户端根本看不见），而击回火球的全部前提是玩家能瞄准它、
 * 左键点到它。生物那条链路（出生包 / 移动包 / 销毁包 / C_AttackEntity）
 * 恰好就是这一整套，所以火球复用它，代价只是一个没有 AI 的 MobType。
 *
 * ## 击回是怎么回事
 *
 * MC 里打中火球会把它的速度**按玩家的视线方向重设**，并把
 * "谁射的"改成玩家 —— 于是它飞回去炸恶魂，而不是掉头原路返回。
 * 原路返回是个常见的错误实现：玩家侧身一挥就能让火球飞向
 * 一个谁也没瞄的方向，看起来像随机。
 */
import type { Mob } from './mob.ts';
import type { MobCtx } from './goal.ts';
import { GoalFlag, type Goal } from './goal.ts';
import type { ServerCore } from '../server-core.ts';
import type { ServerWorld } from '../world/server-world.ts';
import { MobType } from '../../content/mobs.ts';

/** 火球每刻飞多远（格）。慢到能反应过来，快到躲不掉 */
export const FIREBALL_SPEED = 0.55;
/** 火球活多久就自己消失，防止飞到天涯海角 */
export const FIREBALL_LIFETIME = 200;
/** 火球炸多大。MC 的恶魂火球是 1，比苦力怕(3)小得多 */
export const FIREBALL_POWER = 1;
/** 恶魂两发之间隔多久 */
export const GHAST_SHOOT_INTERVAL = 60;
/** 开火前的蓄力时间。没有它玩家没有反应窗口 */
export const GHAST_CHARGE_TICKS = 20;
/** 恶魂在多远之内会开火 */
export const GHAST_ATTACK_RANGE = 64;
/**
 * 直击伤害。爆炸之外**另算**的一份。
 *
 * 必须有它：爆炸半径只有 2 格，而恶魂本身有 4 格宽 —— 火球碰到它
 * 外壳的那一刻，爆心离它的中心已经 2.6 格了，正好落在伤害范围外。
 * 只靠爆炸的话，"把火球打回去"这件事在数值上完全没有效果，
 * 而画面上却是结结实实炸在脸上。MC 同样是直击 + 爆炸两份。
 */
export const FIREBALL_DIRECT_DAMAGE = 6;
/** 恶魂想保持的离地高度 */
const GHAST_HOVER_HEIGHT = 12;

/**
 * 恶魂的 AI：悬停 + 蓄力 + 开火。
 *
 * 它不追人 —— MC 的恶魂是漫无目的地飘，看见谁就打谁。
 * 追人的话它会一直贴到脸上，而恶魂的威胁感恰恰来自"够不着"。
 */
export class GhastShootGoal implements Goal {
  readonly name = 'ghast-shoot';
  readonly priority: number;
  readonly flags = GoalFlag.MOVE | GoalFlag.LOOK;
  /** 蓄力剩余刻数，-1 表示没在蓄力 */
  private charge = -1;

  constructor(priority: number) {
    this.priority = priority;
  }

  canStart(c: MobCtx): boolean {
    return c.nearestPlayer(GHAST_ATTACK_RANGE) !== null;
  }

  canContinue(c: MobCtx): boolean {
    return this.canStart(c);
  }

  start(): void {
    this.charge = -1;
  }

  tick(c: MobCtx): void {
    const mob = c.mob;
    const target = c.nearestPlayer(GHAST_ATTACK_RANGE);
    if (target === null) return;

    // 悬停：往目标头顶那个高度慢慢飘，水平方向保持一段距离
    const dx = target.x - mob.x;
    const dz = target.z - mob.z;
    const dist = Math.hypot(dx, dz);
    const wantY = target.y + GHAST_HOVER_HEIGHT;
    mob.body.vy = clamp((wantY - mob.body.y) * 0.02, -0.06, 0.06);
    if (dist > 24) {
      mob.body.vx = (dx / dist) * 0.06;
      mob.body.vz = (dz / dist) * 0.06;
    } else if (dist < 12 && dist > 0.01) {
      mob.body.vx = -(dx / dist) * 0.05;
      mob.body.vz = -(dz / dist) * 0.05;
    } else {
      mob.body.vx *= 0.9;
      mob.body.vz *= 0.9;
    }
    mob.body.yaw = Math.atan2(dx, dz);
    mob.headYaw = mob.body.yaw;

    if (this.charge >= 0) {
      this.charge--;
      if (this.charge <= 0) {
        this.charge = -1;
        mob.attackCooldown = GHAST_SHOOT_INTERVAL;
        c.shootFireball(mob, target);
      }
      return;
    }
    // 看不见就不开火。隔着墙打人是"作弊感"最强的一种 AI 行为
    if (mob.attackCooldown <= 0 && c.canSee(target)) this.charge = GHAST_CHARGE_TICKS;
  }

  stop(c: MobCtx): void {
    this.charge = -1;
    c.mob.body.vx = 0;
    c.mob.body.vz = 0;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 把一个火球射向某个方向。
 *
 * @param owner 谁射的。火球不会炸到自己的主人（恶魂自己射的不炸自己），
 *              而被击回之后主人会换成玩家 —— 于是它反过来能炸恶魂
 */
export function aimFireball(
  fireball: Mob, ownerId: number, dx: number, dy: number, dz: number,
): void {
  const len = Math.hypot(dx, dy, dz) || 1;
  fireball.body.vx = (dx / len) * FIREBALL_SPEED;
  fireball.body.vy = (dy / len) * FIREBALL_SPEED;
  fireball.body.vz = (dz / len) * FIREBALL_SPEED;
  fireball.body.yaw = Math.atan2(dx, dz);
  fireball.headYaw = fireball.body.yaw;
  fireball.targetId = ownerId;
}


/**
 * 火球的一刻：直线飞，撞到东西就炸。
 *
 * 撞的判定有三种：撞方块（hitWall）、撞到不是自己主人的实体、活够了。
 * 三种都归到同一处 —— 分散写的话很容易漏掉"活够了"，
 * 而那条漏了的后果是一颗打偏的火球会一直飞下去，
 * 顺路把沿途的区块全部加载出来。
 *
 * @returns 是不是该把它从世界里拿掉
 */
export function tickFireball(
  core: ServerCore, mob: Mob, world: ServerWorld, allMobs: Iterable<Mob>,
): boolean {
  mob.tickPhysicsAndVitals(world.store, world.tables, 15, true);
  if (mob.removed) return true;

  let boom = mob.hitWall || mob.age > FIREBALL_LIFETIME;
  /** 直接撞上的那个东西。爆炸之外还要单算一份伤害 */
  let struck: Mob | null = null;

  if (!boom) {
    for (const p of core.eachPlayer()) {
      if (p.dimension !== world.dimension) continue;
      if (p.entityId === mob.targetId) continue;
      if (Math.hypot(p.x - mob.x, p.y + 0.9 - mob.y, p.z - mob.z) > 1.4) continue;
      boom = true;
      break;
    }
  }
  if (!boom) {
    // 打回去的火球要能炸到恶魂
    for (const other of allMobs) {
      if (other === mob || other.dimension !== world.dimension) continue;
      if (other.entityId === mob.targetId) continue;
      if (other.def.type === MobType.FIREBALL) continue;
      const r = other.def.width / 2 + 0.6;
      if (Math.hypot(other.x - mob.x, other.z - mob.z) > r) continue;
      if (mob.y < other.y - 0.5 || mob.y > other.y + other.def.height + 0.5) continue;
      boom = true;
      struck = other;
      break;
    }
  }
  if (!boom) return false;
  // 直击先算：炸完之后目标可能已经被移除了
  if (struck !== null) struck.hurt(FIREBALL_DIRECT_DAMAGE);
  core.explode(mob.x, mob.y, mob.z, FIREBALL_POWER, mob.entityId, world);
  return true;
}
