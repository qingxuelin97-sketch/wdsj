/**
 * 具体的 AI 目标。
 *
 * 每个目标只做一件事，生物的行为由它们的**组合**决定 ——
 * 僵尸 = 追人 + 打人 + 游荡 + 看人；苦力怕 = 追人 + 鼓起来 + 游荡 + 看人。
 * 两者共用前后两个，差别只在中间那个。
 *
 * 优先级数字小的优先，与 MC 一致。
 */
import { GoalFlag, Navigator, type Goal, type MobCtx, type TargetRef } from './goal.ts';

/** 苦力怕引信长度：30 刻（1.5 秒） */
export const CREEPER_FUSE_TICKS = 30;
/** 苦力怕在多近开始鼓 */
const CREEPER_SWELL_RANGE = 3;
/** 苦力怕爆炸威力。TNT 是 4 */
export const CREEPER_POWER = 3;
/** 近战攻击间隔 */
const ATTACK_INTERVAL = 20;
/** 骷髅射箭间隔 */
const SHOOT_INTERVAL = 30;
/** 骷髅保持的距离：太近了会退，太远了会靠近 */
const SKELETON_IDEAL_RANGE = 8;

// ---------------------------------------------------------------------------
// 目标选择（决定 mob.targetId）
// ---------------------------------------------------------------------------

/**
 * 盯上最近的玩家。
 *
 * 不占任何通道：它只写 `targetId`，具体怎么追由别的目标决定。
 * 这样"追"和"选谁"可以分别替换 —— 末影人的选人规则将来要换成
 * "被盯着看才敌对"，只改这一个目标。
 */
export class TargetNearestPlayerGoal implements Goal {
  readonly name = 'target-nearest-player';
  readonly priority: number;
  readonly flags = 0;
  private readonly range: number;
  /** 只在夜里/暗处敌对（僵尸白天在阴影里也会追） */

  constructor(priority: number, range: number) {
    this.priority = priority;
    this.range = range;
  }

  canStart(c: MobCtx): boolean {
    const target = c.nearestPlayer(this.range);
    if (target === null) return false;
    c.mob.targetId = target.entityId;
    return true;
  }

  canContinue(c: MobCtx): boolean {
    const target = c.playerById(c.mob.targetId);
    if (target === null || !target.alive) {
      c.mob.targetId = -1;
      return false;
    }
    // 跟丢了：距离超过追踪范围的 1.5 倍
    const d = Math.hypot(target.x - c.mob.x, target.z - c.mob.z);
    if (d > this.range * 1.5) {
      c.mob.targetId = -1;
      return false;
    }
    return true;
  }

  start(): void { /* canStart 里已经设好了 */ }
  tick(): void { /* 目标的维护在 canContinue 里 */ }
  stop(c: MobCtx): void {
    c.mob.targetId = -1;
  }
}

// ---------------------------------------------------------------------------
// 移动
// ---------------------------------------------------------------------------

/** 追着目标打 */
export class MeleeAttackGoal implements Goal {
  readonly name = 'melee-attack';
  readonly priority: number;
  readonly flags = GoalFlag.MOVE | GoalFlag.LOOK | GoalFlag.JUMP;
  private readonly nav = new Navigator();

  constructor(priority: number) {
    this.priority = priority;
  }

  canStart(c: MobCtx): boolean {
    return c.mob.targetId >= 0 && c.playerById(c.mob.targetId) !== null;
  }

  canContinue(c: MobCtx): boolean {
    return this.canStart(c);
  }

  start(): void { /* nav 自己会算路 */ }

  tick(c: MobCtx): void {
    const target = c.playerById(c.mob.targetId);
    if (target === null) return;
    lookAt(c, target);
    this.nav.moveTo(c, target.x, target.y, target.z);

    // 够得着就打。攻击距离按体型算，蜘蛛比僵尸宽，够得更远
    const reach = c.mob.def.width + 1.0;
    const dx = target.x - c.mob.x;
    const dz = target.z - c.mob.z;
    if (dx * dx + dz * dz > reach * reach) return;
    if (Math.abs(target.y - c.mob.y) > 2) return;
    if (c.mob.attackCooldown > 0) return;
    if (c.mob.def.attackDamage <= 0) return;
    c.mob.attackCooldown = ATTACK_INTERVAL;
    c.attack(target, c.mob.def.attackDamage);
  }

  stop(c: MobCtx): void {
    this.nav.clear();
    c.mob.input.forward = 0;
    c.mob.input.jump = false;
  }
}

/**
 * 苦力怕：靠近就鼓起来，鼓满了炸。
 *
 * 关键是**离开范围会缩回去**：引信倒着走而不是清零。这一条决定了
 * "听到嘶声赶紧跑"这个玩法成不成立 —— 清零的话跑开就完全没事了，
 * 而 MC 里跑开只是让它重新蓄力。
 */
export class CreeperSwellGoal implements Goal {
  readonly name = 'creeper-swell';
  readonly priority: number;
  readonly flags = GoalFlag.MOVE | GoalFlag.LOOK | GoalFlag.JUMP;
  private readonly nav = new Navigator();

  constructor(priority: number) {
    this.priority = priority;
  }

  canStart(c: MobCtx): boolean {
    return c.mob.targetId >= 0 && c.playerById(c.mob.targetId) !== null;
  }

  canContinue(c: MobCtx): boolean {
    // 已经在鼓了就不能被打断，哪怕目标没了 —— 那正是"引信点着了就停不下来"
    return c.mob.fuse > 0 || this.canStart(c);
  }

  start(): void { /* 空 */ }

  tick(c: MobCtx): void {
    const mob = c.mob;
    const target = c.playerById(mob.targetId);
    const near = target !== null
      && Math.hypot(target.x - mob.x, target.z - mob.z) <= CREEPER_SWELL_RANGE
      && c.canSee(target);

    if (near) {
      // 鼓的时候站住不动
      mob.input.forward = 0;
      this.nav.clear();
      if (target !== null) lookAt(c, target);
      mob.fuse = Math.max(0, mob.fuse) + 1;
      if (mob.fuse >= CREEPER_FUSE_TICKS) {
        c.explode(mob, CREEPER_POWER);
        mob.fuse = -1;
      }
      return;
    }

    // 离开了：引信往回缩，同时继续追
    if (mob.fuse > 0) mob.fuse--;
    else mob.fuse = -1;
    if (target !== null) {
      lookAt(c, target);
      this.nav.moveTo(c, target.x, target.y, target.z);
    }
  }

  stop(c: MobCtx): void {
    this.nav.clear();
    c.mob.input.forward = 0;
    c.mob.fuse = -1;
  }
}

/** 骷髅：保持距离射箭 */
export class RangedAttackGoal implements Goal {
  readonly name = 'ranged-attack';
  readonly priority: number;
  readonly flags = GoalFlag.MOVE | GoalFlag.LOOK | GoalFlag.JUMP;
  private readonly nav = new Navigator();

  constructor(priority: number) {
    this.priority = priority;
  }

  canStart(c: MobCtx): boolean {
    return c.mob.targetId >= 0 && c.playerById(c.mob.targetId) !== null;
  }

  canContinue(c: MobCtx): boolean {
    return this.canStart(c);
  }

  start(): void { /* 空 */ }

  tick(c: MobCtx): void {
    const mob = c.mob;
    const target = c.playerById(mob.targetId);
    if (target === null) return;
    lookAt(c, target);
    const dist = Math.hypot(target.x - mob.x, target.z - mob.z);

    if (dist > SKELETON_IDEAL_RANGE) {
      this.nav.moveTo(c, target.x, target.y, target.z);
    } else {
      // 到位了就站住射。倒着走开在 1.0 里其实没有，骷髅只是停下来
      this.nav.clear();
      mob.input.forward = 0;
      if (mob.attackCooldown <= 0 && c.canSee(target)) {
        mob.attackCooldown = SHOOT_INTERVAL;
        c.shootArrow(mob, target);
      }
    }
  }

  stop(c: MobCtx): void {
    this.nav.clear();
    c.mob.input.forward = 0;
  }
}

/** 末影人：受伤就传送走 */
export class EndermanTeleportGoal implements Goal {
  readonly name = 'enderman-teleport';
  readonly priority: number;
  readonly flags = GoalFlag.MOVE;

  constructor(priority: number) {
    this.priority = priority;
  }

  canStart(c: MobCtx): boolean {
    // 刚挨打的那一刻传送。hurtTime 是受伤后倒数的，满值那一刻正是刚受伤
    return c.mob.hurtTime > 8 || (c.mob.fireTicks > 0 && c.mob.age % 20 === 0);
  }

  canContinue(): boolean {
    return false; // 一次性
  }

  start(c: MobCtx): void {
    c.teleportRandomly(c.mob);
  }

  tick(): void { /* 空 */ }
  stop(): void { /* 空 */ }
}

/** 随便走走 */
export class WanderGoal implements Goal {
  readonly name = 'wander';
  readonly priority: number;
  readonly flags = GoalFlag.MOVE | GoalFlag.JUMP;
  private readonly nav = new Navigator();
  private tx = 0;
  private ty = 0;
  private tz = 0;
  /** 多久换一次目的地 */
  private readonly chance: number;

  constructor(priority: number, chance = 120) {
    this.priority = priority;
    this.chance = chance;
  }

  canStart(c: MobCtx): boolean {
    // 平均每 chance 刻起意走一次。生物不该一刻不停地移动 —— 那看着像在巡逻
    if (c.rng.nextInt(this.chance) !== 0) return false;
    const mob = c.mob;
    this.tx = Math.floor(mob.x) + c.rng.nextInt(17) - 8;
    this.ty = Math.floor(mob.y) + c.rng.nextInt(5) - 2;
    this.tz = Math.floor(mob.z) + c.rng.nextInt(17) - 8;
    return true;
  }

  canContinue(): boolean {
    return this.nav.hasPath;
  }

  start(c: MobCtx): void {
    this.nav.moveTo(c, this.tx, this.ty, this.tz);
  }

  tick(c: MobCtx): void {
    this.nav.moveTo(c, this.tx, this.ty, this.tz);
  }

  stop(c: MobCtx): void {
    this.nav.clear();
    c.mob.input.forward = 0;
    c.mob.input.jump = false;
  }
}

/** 被手持某样东西的玩家吸引，跟着走 */
export class TemptGoal implements Goal {
  readonly name = 'tempt';
  readonly priority: number;
  readonly flags = GoalFlag.MOVE | GoalFlag.LOOK | GoalFlag.JUMP;
  private readonly nav = new Navigator();
  private readonly itemId: number;
  private targetId = -1;

  constructor(priority: number, itemId: number) {
    this.priority = priority;
    this.itemId = itemId;
  }

  canStart(c: MobCtx): boolean {
    const target = c.nearestPlayer(10);
    if (target === null || target.heldItemId !== this.itemId) return false;
    this.targetId = target.entityId;
    return true;
  }

  canContinue(c: MobCtx): boolean {
    const target = c.playerById(this.targetId);
    return target !== null && target.heldItemId === this.itemId
      && Math.hypot(target.x - c.mob.x, target.z - c.mob.z) < 12;
  }

  start(): void { /* 空 */ }

  tick(c: MobCtx): void {
    const target = c.playerById(this.targetId);
    if (target === null) return;
    lookAt(c, target);
    // 太近了就停下，否则会一直往玩家身上挤
    if (Math.hypot(target.x - c.mob.x, target.z - c.mob.z) < 1.6) {
      this.nav.clear();
      c.mob.input.forward = 0;
      return;
    }
    this.nav.moveTo(c, target.x, target.y, target.z);
  }

  stop(c: MobCtx): void {
    this.nav.clear();
    this.targetId = -1;
    c.mob.input.forward = 0;
  }
}

/** 挨打了就跑 */
export class PanicGoal implements Goal {
  readonly name = 'panic';
  readonly priority: number;
  readonly flags = GoalFlag.MOVE | GoalFlag.JUMP;
  private readonly nav = new Navigator();
  private tx = 0;
  private tz = 0;
  private until = 0;

  constructor(priority: number) {
    this.priority = priority;
  }

  canStart(c: MobCtx): boolean {
    return c.mob.hurtTime > 0;
  }

  canContinue(c: MobCtx): boolean {
    return c.worldAge < this.until && this.nav.hasPath;
  }

  start(c: MobCtx): void {
    const mob = c.mob;
    // 朝着"背对伤害来源"的大方向跑。没有伤害来源信息时就随便挑个方向 ——
    // 逃跑的方向对不对，玩家其实分辨不出来，重要的是它真的跑起来了
    const angle = c.rng.nextDouble() * Math.PI * 2;
    this.tx = Math.floor(mob.x + Math.cos(angle) * 12);
    this.tz = Math.floor(mob.z + Math.sin(angle) * 12);
    this.until = c.worldAge + 60;
    this.nav.moveTo(c, this.tx, mob.y, this.tz);
  }

  tick(c: MobCtx): void {
    this.nav.moveTo(c, this.tx, c.mob.y, this.tz);
  }

  stop(c: MobCtx): void {
    this.nav.clear();
    c.mob.input.forward = 0;
  }
}

/** 扭头看玩家。只占朝向通道，可以和移动同时进行 */
export class LookAtPlayerGoal implements Goal {
  readonly name = 'look-at-player';
  readonly priority: number;
  readonly flags = GoalFlag.LOOK;
  private targetId = -1;
  private until = 0;

  constructor(priority: number) {
    this.priority = priority;
  }

  canStart(c: MobCtx): boolean {
    if (c.rng.nextInt(20) !== 0) return false;
    const target = c.nearestPlayer(8);
    if (target === null) return false;
    this.targetId = target.entityId;
    this.until = c.worldAge + 40 + c.rng.nextInt(40);
    return true;
  }

  canContinue(c: MobCtx): boolean {
    return c.worldAge < this.until && c.playerById(this.targetId) !== null;
  }

  start(): void { /* 空 */ }

  tick(c: MobCtx): void {
    const target = c.playerById(this.targetId);
    if (target !== null) lookAt(c, target);
  }

  stop(): void { /* 空 */ }
}

/** 把头转向某个目标。只改 headYaw，不改身体朝向 */
function lookAt(c: MobCtx, target: TargetRef): void {
  c.mob.headYaw = Math.atan2(-(target.x - c.mob.x), target.z - c.mob.z);
}
