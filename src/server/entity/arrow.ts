/**
 * 箭。
 *
 * 骷髅射的、以及以后玩家用弓射的，都是这一种。物理比掉落物简单：
 * 重力 0.05、阻力 0.99，撞到方块就停下插在那儿，撞到实体就造成伤害。
 *
 * 命中判定用**上一刻到这一刻的线段**去扫，而不是"当前位置在不在实体盒里"。
 * 箭一刻能飞两三格，按位置判的话会直接穿过一个 0.6 宽的玩家 ——
 * 而那种"明明射中了却没伤害"的手感问题，玩家会归咎于整个游戏做得糙。
 */
import { collideMove, makeBox, setBodyBox, type Box, type CollisionTables } from '../../core/physics/block-collision.ts';
import type { BlockView } from '../../core/world/block-view.ts';
import { nbt, getInt, getList, TagType, type NbtValue } from '../../core/nbt/nbt.ts';

/** 箭的重力，比掉落物还小一点 */
const ARROW_GRAVITY = 0.05;
const ARROW_DRAG = 0.99;
/** 插在方块上之后多久消失 */
const STUCK_LIFETIME = 1200;
/** 飞在空中最多活多久 */
const FLIGHT_LIFETIME = 1200;
/** 骷髅射出来的初速度 */
export const ARROW_SPEED = 1.6;

const scratchBox = makeBox();

export class ArrowEntity {
  readonly entityId: number;
  /**
   * 箭在哪个维度。默认主世界。
   *
   * 不带维度的话，下界里射出去的箭会在主世界的同名坐标上判定命中 ——
   * 症状是"射空了"或者"隔着一个维度打到了人"，两种都极难归因。
   */
  dimension = 0;
  /** 谁射的。用来避免刚出膛就打到射手自己 */
  readonly ownerId: number;
  readonly damage: number;
  x: number; y: number; z: number;
  vx = 0; vy = 0; vz = 0;
  /** 插住了就不再动 */
  stuck = false;
  age = 0;
  dead = false;
  /** 上一刻的位置，命中判定用它做线段起点 */
  prevX: number;
  prevY: number;
  prevZ: number;

  constructor(entityId: number, ownerId: number, x: number, y: number, z: number, damage: number) {
    this.entityId = entityId;
    this.ownerId = ownerId;
    this.damage = damage;
    this.x = x;
    this.y = y;
    this.z = z;
    this.prevX = x;
    this.prevY = y;
    this.prevZ = z;
  }

  /** 朝某个方向射出去。spread 是散布，0 表示指哪打哪 */
  shoot(dx: number, dy: number, dz: number, speed: number, spread: number, rnd: () => number): void {
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-9) return;
    this.vx = dx / len * speed + (rnd() - 0.5) * spread;
    this.vy = dy / len * speed + (rnd() - 0.5) * spread;
    this.vz = dz / len * speed + (rnd() - 0.5) * spread;
  }

  tick(world: BlockView, tables: CollisionTables): void {
    this.age++;
    if (this.stuck) {
      if (this.age > STUCK_LIFETIME) this.dead = true;
      return;
    }
    if (this.age > FLIGHT_LIFETIME) {
      this.dead = true;
      return;
    }

    this.prevX = this.x;
    this.prevY = this.y;
    this.prevZ = this.z;

    this.vy -= ARROW_GRAVITY;
    // 箭很细，碰撞盒给 0.1 —— 用掉落物那样的 0.25 会在贴着墙飞时提前插住
    const box = setBodyBox(scratchBox, this.x, this.y, this.z, 0.1, 0.1);
    const moved = collideMove(world, tables, box, this.vx, this.vy, this.vz);
    this.x += moved.dx;
    this.y += moved.dy;
    this.z += moved.dz;
    if (moved.hitX || moved.hitY || moved.hitZ) {
      this.stuck = true;
      this.vx = 0;
      this.vy = 0;
      this.vz = 0;
      this.age = 0; // 插住之后重新计时
      return;
    }
    this.vx *= ARROW_DRAG;
    this.vy *= ARROW_DRAG;
    this.vz *= ARROW_DRAG;
  }

  /**
   * 这一刻的飞行线段有没有穿过某个碰撞盒。
   *
   * 用线段-盒相交（slab 法）而不是判端点是否在盒内：箭一刻飞两三格，
   * 端点判定会整个穿过去。
   */
  hits(box: Box): boolean {
    if (this.stuck) return false;
    let tMin = 0;
    let tMax = 1;
    const dx = this.x - this.prevX;
    const dy = this.y - this.prevY;
    const dz = this.z - this.prevZ;

    const slab = (start: number, delta: number, lo: number, hi: number): boolean => {
      if (Math.abs(delta) < 1e-9) return start >= lo && start <= hi;
      const t1 = (lo - start) / delta;
      const t2 = (hi - start) / delta;
      const near = Math.min(t1, t2);
      const far = Math.max(t1, t2);
      if (near > tMin) tMin = near;
      if (far < tMax) tMax = far;
      return tMin <= tMax;
    };

    if (!slab(this.prevX, dx, box.minX, box.maxX)) return false;
    if (!slab(this.prevY, dy, box.minY, box.maxY)) return false;
    if (!slab(this.prevZ, dz, box.minZ, box.maxZ)) return false;
    return true;
  }

  toNbt(): NbtValue {
    return nbt.compound({
      id: nbt.string('Arrow'),
      Owner: nbt.int(this.ownerId),
      Damage: nbt.short(this.damage),
      Age: nbt.short(this.age),
      Stuck: nbt.byte(this.stuck ? 1 : 0),
      Pos: nbt.list(TagType.DOUBLE, [nbt.double(this.x), nbt.double(this.y), nbt.double(this.z)]),
      Motion: nbt.list(TagType.DOUBLE, [nbt.double(this.vx), nbt.double(this.vy), nbt.double(this.vz)]),
    });
  }
}

/** 从 NBT 还原一支箭 */
export function arrowFromNbt(entityId: number, tag: NbtValue): ArrowEntity | null {
  const num = (list: NbtValue[], i: number): number => {
    const v = list[i];
    return v !== undefined && (v.type === TagType.DOUBLE || v.type === TagType.FLOAT) ? v.value : 0;
  };
  const pos = getList(tag, 'Pos');
  if (pos.length < 3) return null;
  const motion = getList(tag, 'Motion');
  const a = new ArrowEntity(
    entityId, getInt(tag, 'Owner', -1),
    num(pos, 0), num(pos, 1), num(pos, 2),
    getInt(tag, 'Damage', 2),
  );
  a.vx = num(motion, 0);
  a.vy = num(motion, 1);
  a.vz = num(motion, 2);
  a.age = getInt(tag, 'Age');
  a.stuck = getInt(tag, 'Stuck') !== 0;
  return a;
}
