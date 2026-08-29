/**
 * 掉落物实体。
 *
 * M8 之前的临时做法是"挖掉的方块直接进背包"（记在 docs/DEVIATIONS.md 里），
 * 到这里被真正的掉落物取代。这不只是观感问题：背包满了该怎么办、
 * 从高处挖掉的方块会不会掉下来、爆炸炸出来的东西散落在哪 ——
 * 这些行为全都依赖"掉落物是世界里的一个实体"。
 *
 * 物理常量来自 MC 1.0 的 `EntityItem.onUpdate`：
 *   motionY -= 0.04
 *   moveEntity(...)
 *   在空中 motionXZ *= 0.98；落地时 *= 0.98 * 0.6（默认滑度）
 *   落地那一刻 motionY *= -0.5（轻微反弹）
 *   6000 刻（5 分钟）后消失
 *
 * 重力是 **0.04** 而不是玩家的 0.08 —— 掉落物飘得比玩家慢，这是可见的差别。
 */
import { collideMove, makeBox, setBodyBox, type CollisionTables } from '../../core/physics/block-collision.ts';
import type { BlockView } from '../../core/world/block-view.ts';
import { makeStack, type ItemStack } from '../../core/item/item-def.ts';
import { nbt, getInt, getList, type NbtValue } from '../../core/nbt/nbt.ts';
import { TagType } from '../../core/nbt/nbt.ts';

/** 掉落物的碰撞盒是 0.25 见方 */
export const ITEM_SIZE = 0.25;
/** 掉落物重力，比玩家的 0.08 小一半 */
const ITEM_GRAVITY = 0.04;
const AIR_DRAG = 0.98;
/** 落地时水平方向额外乘一个默认滑度 0.6 */
const GROUND_FRICTION = 0.6;
/** 落地反弹 */
const BOUNCE = -0.5;
/** 多少刻之后消失（5 分钟） */
export const ITEM_LIFETIME = 6000;
/** 刚掉出来的这些刻里捡不起来，免得刚扔就被自己捡回去 */
export const PICKUP_DELAY = 10;
/** 每隔多少刻找一次附近的同类合并 */
const MERGE_INTERVAL = 25;
/** 玩家离多近算捡到（水平与垂直分别判） */
const PICKUP_RANGE_XZ = 1.0;
const PICKUP_RANGE_Y = 1.0;

/** 复用的碰撞盒。掉落物动辄几百个，每 tick 各新建一个对象是白给的 GC 压力 */
const scratchBox = makeBox();

export class ItemEntity {
  readonly entityId: number;
  readonly stack: ItemStack;
  x: number; y: number; z: number;
  vx = 0; vy = 0; vz = 0;
  onGround = false;
  /** 活了多少刻 */
  age = 0;
  /** 还有多少刻才能被捡 */
  pickupDelay = PICKUP_DELAY;
  /** 已经被捡走或者过期，等待清理 */
  dead = false;

  constructor(entityId: number, x: number, y: number, z: number, stack: ItemStack) {
    this.entityId = entityId;
    this.x = x;
    this.y = y;
    this.z = z;
    this.stack = stack;
  }

  /**
   * 给一个随机的初速度，让掉落物"蹦"出来一点。
   *
   * 用调用方传进来的随机数而不是自己取 —— 服务端的一切随机都必须走
   * 世界的确定性随机源，否则同一个存档同一串操作会得到不同的掉落物位置，
   * 而截图回归会随之飘。
   */
  scatter(rx: number, ry: number, rz: number): void {
    this.vx = rx * 0.2;
    this.vy = 0.2 + ry * 0.2;
    this.vz = rz * 0.2;
  }

  tick(world: BlockView, tables: CollisionTables): void {
    this.age++;
    if (this.pickupDelay > 0) this.pickupDelay--;
    if (this.age >= ITEM_LIFETIME) {
      this.dead = true;
      return;
    }

    this.vy -= ITEM_GRAVITY;

    const box = setBodyBox(scratchBox, this.x, this.y, this.z, ITEM_SIZE, ITEM_SIZE);
    const moved = collideMove(world, tables, box, this.vx, this.vy, this.vz);
    this.x += moved.dx;
    this.y += moved.dy;
    this.z += moved.dz;

    // 撞上东西就把那个轴的速度清掉，否则会贴着墙一直"推"
    if (moved.hitX) this.vx = 0;
    if (moved.hitZ) this.vz = 0;
    const landed = moved.hitY && this.vy < 0;
    this.onGround = landed;

    let drag = AIR_DRAG;
    if (this.onGround) drag = AIR_DRAG * GROUND_FRICTION;
    this.vx *= drag;
    this.vy *= AIR_DRAG;
    this.vz *= drag;
    if (landed) this.vy *= BOUNCE;
    if (moved.hitY && this.vy > 0) this.vy = 0;

    // 极小的速度直接归零：否则掉落物会以 1e-8 的速度永远"在动"，
    // 每 tick 都要发一个位置包出去
    if (Math.abs(this.vx) < 1e-3) this.vx = 0;
    if (Math.abs(this.vy) < 1e-3) this.vy = 0;
    if (Math.abs(this.vz) < 1e-3) this.vz = 0;
  }

  /** 该不该找附近的同类合并 */
  shouldTryMerge(): boolean {
    return this.age % MERGE_INTERVAL === 0;
  }

  /** 玩家够得到吗 */
  canBePickedUpBy(px: number, py: number, pz: number): boolean {
    if (this.dead || this.pickupDelay > 0) return false;
    if (Math.abs(px - this.x) > PICKUP_RANGE_XZ) return false;
    if (Math.abs(pz - this.z) > PICKUP_RANGE_XZ) return false;
    // 玩家的 y 是脚底，掉落物要在脚到头之间这一段附近
    return py - PICKUP_RANGE_Y <= this.y && this.y <= py + 2;
  }

  toNbt(): NbtValue {
    return nbt.compound({
      Age: nbt.short(this.age),
      PickupDelay: nbt.short(this.pickupDelay),
      Pos: nbt.list(TagType.DOUBLE, [nbt.double(this.x), nbt.double(this.y), nbt.double(this.z)]),
      Motion: nbt.list(TagType.DOUBLE, [nbt.double(this.vx), nbt.double(this.vy), nbt.double(this.vz)]),
      Item: nbt.compound({
        id: nbt.short(this.stack.id),
        Count: nbt.byte(this.stack.count),
        Damage: nbt.short(this.stack.damage),
      }),
    });
  }
}

/** 从 NBT 还原一个掉落物。entityId 由调用方重新分配 —— 它只在本次运行内有意义 */
export function itemEntityFromNbt(entityId: number, tag: NbtValue): ItemEntity | null {
  const item = tag.type === TagType.COMPOUND ? tag.value.get('Item') : undefined;
  if (item === undefined) return null;
  const pos = getList(tag, 'Pos');
  const motion = getList(tag, 'Motion');
  const num = (list: NbtValue[], i: number): number => {
    const v = list[i];
    return v !== undefined && (v.type === TagType.DOUBLE || v.type === TagType.FLOAT) ? v.value : 0;
  };
  const stack = makeStack(getInt(item, 'id'), getInt(item, 'Count'), getInt(item, 'Damage'));
  if (stack.id === 0 || stack.count <= 0) return null;
  const e = new ItemEntity(entityId, num(pos, 0), num(pos, 1), num(pos, 2), stack);
  e.vx = num(motion, 0);
  e.vy = num(motion, 1);
  e.vz = num(motion, 2);
  e.age = getInt(tag, 'Age');
  e.pickupDelay = getInt(tag, 'PickupDelay');
  return e;
}
