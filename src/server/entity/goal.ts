/**
 * AI 目标系统。
 *
 * 一只生物的行为 = 一组带优先级的目标，每刻挑出**互不冲突**的一批来跑。
 * 这是 MC 自己的结构，照抄它有个很实际的好处：僵尸和苦力怕的差别变成
 * "目标列表不同"，而不是两棵各写一遍追人逻辑的继承树。
 *
 * 互斥用位掩码：一个目标声明自己要占用哪些"控制通道"（移动 / 朝向 / 跳跃），
 * 优先级高的先占，占不到通道的目标这一刻就不跑。少了互斥的话，
 * "游荡"和"追人"会同时往 input 里写，生物原地抽搐。
 */
import type { Mob } from './mob.ts';
import type { BlockView } from '../../core/world/block-view.ts';
import type { PhysicsTables } from '../../core/physics/entity-physics.ts';
import type { PathFinder, PathNode } from './pathfind.ts';
import type { JavaRandom } from '../../core/rng/java-random.ts';

/** 控制通道 */
export const GoalFlag = {
  MOVE: 1,
  LOOK: 2,
  JUMP: 4,
} as const;

/** 目标能看到的世界。刻意做窄：目标不该能直接改世界 */
export interface MobCtx {
  readonly mob: Mob;
  readonly world: BlockView;
  readonly tables: PhysicsTables;
  readonly rng: JavaRandom;
  readonly pathfinder: PathFinder;
  /** 当前世界年龄 */
  readonly worldAge: number;
  /** 是不是白天 */
  readonly isDay: boolean;
  /** 找最近的玩家。超出 range 返回 null */
  nearestPlayer(range: number): TargetRef | null;
  /** 按 id 找玩家 */
  playerById(id: number): TargetRef | null;
  /** 从 mob 眼睛到目标眼睛有没有遮挡 */
  canSee(target: TargetRef): boolean;
  /** 打一下目标 */
  attack(target: TargetRef, damage: number): void;
  /** 苦力怕引爆 */
  explode(mob: Mob, power: number): void;
  /** 骷髅射箭 */
  shootArrow(mob: Mob, target: TargetRef): void;
  /** 恶魂吐火球 */
  shootFireball(mob: Mob, target: TargetRef): void;
  /** 末影人传送到某处，返回是否成功 */
  teleportRandomly(mob: Mob): boolean;
}

/** 一个可以被瞄准的东西（目前只有玩家） */
export interface TargetRef {
  readonly entityId: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** 眼睛高度处的 y */
  readonly eyeY: number;
  /** 手上拿的物品 id，用于"被小麦吸引" */
  readonly heldItemId: number;
  readonly alive: boolean;
}

export interface Goal {
  readonly name: string;
  readonly priority: number;
  readonly flags: number;
  /** 能不能开始。每刻问一次（未在运行时） */
  canStart(c: MobCtx): boolean;
  /** 能不能继续。默认与 canStart 相同 */
  canContinue(c: MobCtx): boolean;
  start(c: MobCtx): void;
  tick(c: MobCtx): void;
  stop(c: MobCtx): void;
}

/**
 * 目标选择器。
 *
 * 每刻的流程：
 *   1. 已在跑的目标里，`canContinue` 为假的停掉
 *   2. 按优先级从高到低，让还没跑的目标试着开始 —— 通道被占就跳过
 *   3. 跑所有还在运行的目标
 *
 * 优先级数字**小的优先**（与 MC 一致，0 是最高）。
 */
export class GoalSelector {
  private readonly goals: Goal[] = [];
  private readonly running = new Set<Goal>();

  add(goal: Goal): void {
    this.goals.push(goal);
    // 插入时就排好序，每刻少一次排序 —— 一个世界七十只生物 × 每只六七个目标
    this.goals.sort((a, b) => a.priority - b.priority);
  }

  /** 正在跑的目标名，排查与测试用 */
  runningNames(): string[] {
    return [...this.running].map((g) => g.name);
  }

  isRunning(name: string): boolean {
    for (const g of this.running) if (g.name === name) return true;
    return false;
  }

  tick(c: MobCtx): void {
    // 1. 该停的停掉
    for (const goal of [...this.running]) {
      if (goal.canContinue(c)) continue;
      goal.stop(c);
      this.running.delete(goal);
    }

    // 2. 按优先级抢通道。已经在跑的先把自己的通道占上
    let occupied = 0;
    for (const goal of this.running) occupied |= goal.flags;

    for (const goal of this.goals) {
      if (this.running.has(goal)) continue;
      if ((goal.flags & occupied) !== 0) continue;
      if (!goal.canStart(c)) continue;
      goal.start(c);
      this.running.add(goal);
      occupied |= goal.flags;
    }

    // 3. 跑
    for (const goal of this.running) goal.tick(c);
  }

  /** 生物死了或被卸载时把所有目标停掉，免得留下半截状态 */
  stopAll(c: MobCtx): void {
    for (const goal of this.running) goal.stop(c);
    this.running.clear();
  }
}

// ---------------------------------------------------------------------------
// 导航：目标共用的"走到某处"
// ---------------------------------------------------------------------------

/**
 * 一只生物的移动状态。
 *
 * 路径不是每刻重算的 —— A* 再快也架不住七十只生物每刻各来一次。
 * 重算的时机是：没路了、路走完了、目标挪远了、或者隔了 `REPATH_INTERVAL` 刻。
 */
export class Navigator {
  private path: PathNode[] = [];
  private index = 0;
  private lastRepath = -1000;
  /** 上次算路时目标在哪，用来判断"目标挪远了" */
  private lastTargetX = 0;
  private lastTargetZ = 0;
  /** 卡住检测：位置几乎没动的连续刻数 */
  private stuckTicks = 0;
  private lastX = 0;
  private lastZ = 0;

  /** 隔多少刻才允许重算一次路 */
  static readonly REPATH_INTERVAL = 20;
  /** 目标挪出这么远就立刻重算 */
  static readonly REPATH_DISTANCE = 3;

  get hasPath(): boolean {
    return this.index < this.path.length;
  }

  get remaining(): number {
    return Math.max(0, this.path.length - this.index);
  }

  clear(): void {
    this.path.length = 0;
    this.index = 0;
  }

  /** 走向某个坐标。每刻调，内部自己决定要不要重算 */
  moveTo(c: MobCtx, tx: number, ty: number, tz: number): void {
    const movedFar = Math.hypot(tx - this.lastTargetX, tz - this.lastTargetZ) > Navigator.REPATH_DISTANCE;
    const stale = c.worldAge - this.lastRepath >= Navigator.REPATH_INTERVAL;
    // 没路可走时也要等到 stale 才重算，否则目标在墙后面的生物会**每刻**跑一次
    // A*：七十只生物 × 每刻一次全量搜索，服务端直接停摆
    if ((!this.hasPath || movedFar || this.stuckTicks > 0) && (stale || movedFar)) {
      this.repath(c, tx, ty, tz);
    }
    this.follow(c);
  }

  private repath(c: MobCtx, tx: number, ty: number, tz: number): void {
    const mob = c.mob;
    this.lastRepath = c.worldAge;
    this.lastTargetX = tx;
    this.lastTargetZ = tz;
    this.path = c.pathfinder.find(
      c.world, c.tables,
      Math.floor(mob.x), Math.floor(mob.y), Math.floor(mob.z),
      Math.floor(tx), Math.floor(ty), Math.floor(tz),
      mob.def.width, mob.def.height,
    );
    this.index = 0;
    this.stuckTicks = 0;
  }

  /** 朝当前路径点走一步 */
  private follow(c: MobCtx): void {
    const mob = c.mob;
    if (!this.hasPath) {
      mob.input.forward = 0;
      return;
    }
    const node = this.path[this.index]!;
    // 路径点是方块坐标，走向它的**中心**
    const tx = node.x + 0.5;
    const tz = node.z + 0.5;
    const dx = tx - mob.x;
    const dz = tz - mob.z;
    const distSq = dx * dx + dz * dz;

    // 到了就换下一个。0.3 格是经验值：太小会在点上打转，太大会切角切进墙里
    if (distSq < 0.09 && Math.abs(node.y - mob.y) < 1.2) {
      this.index++;
      if (!this.hasPath) {
        mob.input.forward = 0;
        return;
      }
    }

    mob.body.yaw = Math.atan2(-dx, dz);
    mob.input.forward = 1;
    // 下一格比脚下高就跳。生物没有"跳跃键"的概念，这一条就是它们的跳
    mob.input.jump = node.y > Math.floor(mob.y) && mob.body.onGround;

    // 卡住了（撞墙、被别的生物挡住）就重来一次
    if (Math.abs(mob.x - this.lastX) < 0.01 && Math.abs(mob.z - this.lastZ) < 0.01) {
      this.stuckTicks++;
      if (this.stuckTicks > 40) {
        this.clear();
        this.stuckTicks = 0;
      }
    } else {
      this.stuckTicks = 0;
    }
    this.lastX = mob.x;
    this.lastZ = mob.z;
  }
}
