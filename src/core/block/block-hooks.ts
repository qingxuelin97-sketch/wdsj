/**
 * 方块行为钩子。
 *
 * 1.0 的约 110 种方块里只有二十几种需要这里的任何一个钩子；其余全是纯数据。
 *
 * 三条硬约定（docs/RULES.md 第 7 条）：
 *   1. 钩子是**自由函数**，没有 `this` —— 它们挂在共享的 BlockDef 上，被所有同类方块复用
 *   2. 坐标拆成三个 `number` 传，不传 `{x,y,z}` 对象 —— 随机刻每秒调用几十万次，
 *      传对象就是每秒几十万个临时对象
 *   3. 钩子不许直接改世界以外的东西；要影响玩家/实体请走传进来的引用
 */
import type { BlockView, MutableBlockView } from '../world/block-view.ts';
import type { Aabb } from '../math/aabb.ts';
import type { Facing } from './types.ts';

/** 钩子里能用的随机源。服务端传的是与世界种子绑定的确定性 RNG */
export interface Rng {
  nextInt(bound: number): number;
  nextFloat(): number;
  nextDouble(): number;
  nextBoolean(): boolean;
}

/** 一个物品堆的最小形态。完整定义在 core/item */
export interface ItemStackRef {
  readonly id: number;
  readonly count: number;
  readonly meta: number;
}

/** 放置方块时的上下文 */
export interface PlaceContext {
  /** 玩家点击的是哪个面 */
  readonly face: Facing;
  /** 玩家水平朝向，用于门、楼梯、活塞的朝向 */
  readonly yaw: number;
  readonly pitch: number;
  /** 点击点在被点击面上的位置，0..1，用于半砖上下半判定 */
  readonly hitX: number;
  readonly hitY: number;
  readonly hitZ: number;
  readonly placer: PlayerRef | null;
}

/** 玩家引用。钩子只需要这些，不需要看到完整的玩家对象 */
export interface PlayerRef {
  readonly entityId: number;
  readonly sneaking: boolean;
  heldItem(): ItemStackRef | null;
  /** 打开一个容器界面 */
  openContainer(kind: string, x: number, y: number, z: number): void;
  giveItem(stack: ItemStackRef): void;
  damageHeldItem(amount: number): void;
}

/** 实体引用，用于 onEntityInside（仙人掌扎人、火烧人、灵魂沙减速） */
export interface EntityRef {
  readonly entityId: number;
  damage(amount: number, source: string): void;
  setOnFire(ticks: number): void;
  multiplyVelocity(fx: number, fy: number, fz: number): void;
}

export interface BlockHooks {
  /**
   * 随机刻。只有 `randomTick: true` 的方块会收到。
   * 用于作物生长、草蔓延、树叶消失、火焰蔓延、冰雪消融、下界疣生长。
   */
  onRandomTick?(w: MutableBlockView, x: number, y: number, z: number, state: number, rng: Rng): void;

  /**
   * 计划刻。由 `TickScheduler` 在指定延迟后触发。
   * 用于流体流动、红石中继器延迟、沙砾下落检查、TNT 引信。
   */
  onScheduledTick?(w: MutableBlockView, x: number, y: number, z: number, state: number, rng: Rng): void;

  /**
   * 邻居变化通知。fx/fy/fz 是发生变化的那个邻居的坐标。
   * 用于红石传播、流体重算、"失去支撑就掉落"（火把、花、门）。
   */
  onNeighborUpdate?(
    w: MutableBlockView,
    x: number,
    y: number,
    z: number,
    state: number,
    fx: number,
    fy: number,
    fz: number,
  ): void;

  /**
   * 放置时调用，返回**最终写入**的方块状态。
   * 用于按朝向定 meta（楼梯、门、活塞、原木轴向）、按点击位置定半砖上下半。
   */
  onPlace?(w: BlockView, x: number, y: number, z: number, state: number, ctx: PlaceContext): number;

  /** 破坏后调用。用于门的另一半、床的另一半、双箱的伴随处理 */
  onBreak?(w: MutableBlockView, x: number, y: number, z: number, state: number): void;

  /**
   * 右键使用。返回 true 表示"我处理了"，会阻止手上物品的放置行为。
   * 用于开门、开箱子、开熔炉、翻转拉杆、吃蛋糕、上床。
   */
  onUse?(w: MutableBlockView, x: number, y: number, z: number, state: number, player: PlayerRef): boolean;

  /**
   * 掉落物。不实现则掉落方块自身。
   * 用于石头掉圆石、草方块掉泥土、树叶掉树苗、砂砾掉燧石、红石矿掉红石粉。
   */
  getDrops?(state: number, tool: ItemStackRef | null, rng: Rng): ItemStackRef[];

  /** 碰撞形状。不实现则用 BlockDef.collisionShape */
  getShape?(state: number): readonly Aabb[];

  /** 能否存在于此。返回 false 会让方块自毁（火把失去墙、花失去土） */
  canSurvive?(w: BlockView, x: number, y: number, z: number, state: number): boolean;

  /** 该方块向指定方向输出的红石强度 0..15 */
  getRedstonePower?(w: BlockView, x: number, y: number, z: number, state: number, side: Facing): number;

  /** 实体位于方块内部时每 tick 调用。用于仙人掌、火、灵魂沙、蜘蛛网、传送门 */
  onEntityInside?(w: MutableBlockView, x: number, y: number, z: number, state: number, e: EntityRef): void;

  /**
   * 方块被放置后的初始化，用于建立方块实体。
   * 与 onPlace 分开是因为 onPlace 在写入之前跑（它要返回状态），
   * 而方块实体必须在写入之后才能挂上去。
   */
  onPlaced?(w: MutableBlockView, x: number, y: number, z: number, state: number, ctx: PlaceContext): void;
}
