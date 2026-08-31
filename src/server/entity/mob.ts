/**
 * 一只生物。
 *
 * 物理**直接复用** `core/physics/entity-physics.ts` 的 `stepBody` ——
 * 和玩家、和客户端预测是同一份实现。这是计划里那条"服务端模拟、
 * 客户端预测、生物 AI 共用同一个 stepEntity"的兑现处：僵尸和玩家
 * 掉下悬崖的轨迹逐格相同，上半砖的行为也一样，不需要第二套调参。
 *
 * 行为不在这里，在 AI 目标里（goal.ts）。这个类只负责"一只生物有什么状态"，
 * 以及那些与行为无关的每刻杂务：无敌帧、日灼、掉落伤害、死亡计时。
 */
import { makeBody, emptyInput, stepBody, type Body, type MoveInput, type PhysicsTables } from '../../core/physics/entity-physics.ts';
import type { BlockView } from '../../core/world/block-view.ts';
import type { MobDef } from '../../content/mobs.ts';
import { nbt, getInt, getList, TagType, type NbtValue } from '../../core/nbt/nbt.ts';
import { WORLD_HEIGHT } from '../../core/constants.ts';
import { GoalSelector } from './goal.ts';
import { collideMove, makeBox, setBodyBox } from '../../core/physics/block-collision.ts';

/** 飞行碰撞复用的盒子。每刻可能有几十个飞行体，别每个都新建 */
const flyBox = makeBox();

/** 受伤之后多少刻内不再吃伤害。与玩家一致 */
export const INVULNERABLE_TICKS = 10;
/** 死亡动画多少刻之后真正移除 */
export const DEATH_TICKS = 20;
/** 天光达到多少才会烧起来 */
const SUNLIGHT_BURN_THRESHOLD = 12;
/** 着火时每多少刻掉一点血 */
const FIRE_DAMAGE_INTERVAL = 20;

/**
 * 玩家走路 4.317 格/秒对应 `stepBody` 里的 speed = 1。
 * 生物定义表里写的是格/秒，这里换算成倍率。
 */
export const PLAYER_WALK_SPEED = 4.317;

export class Mob {
  /**
   * 生物在哪个维度。默认主世界。
   *
   * 与箭同理：不带维度的话，下界的恶魂会去打主世界同坐标上的玩家。
   * 存档时按维度分开写（见 world-persistence）。
   */
  dimension = 0;
  readonly entityId: number;
  readonly def: MobDef;
  readonly body: Body;
  readonly input: MoveInput = emptyInput();
  readonly goals: GoalSelector;

  health: number;
  /** 活了多少刻 */
  age = 0;
  /** 剩余无敌帧 */
  invulnerable = 0;
  /** 受伤闪红的剩余刻数，客户端用 */
  hurtTime = 0;
  /** 剩余着火刻数 */
  fireTicks = 0;
  /**
   * 打死它的那一击手上武器的抢夺等级。0 = 没有，或者不是被玩家打死的。
   *
   * 记在生物身上而不是在掉落时现查：掉落发生在 dropLoot 里，那时候
   * 早就不知道是谁打的了；而玩家完全可能在打完最后一下之后立刻换手 ——
   * 现查的话玩家能"打完换上抢夺剑再等它死"，那是个白嫖的漏洞。
   *
   * **不存盘**：区块卸载时这只怪没被打死（dropLoot 会因为 health > 0
   * 直接返回），所以它的值到那时已经没有意义了
   */
  lootingLevel = 0;
  /** 死了之后的计时；≥0 表示正在播死亡动画 */
  deathTicks = -1;
  /** 已经可以从世界里移除 */
  removed = false;
  /** 当前锁定的攻击目标（玩家 entityId），−1 表示没有 */
  targetId = -1;
  /** 距离上次挥手/攻击还有几刻 */
  attackCooldown = 0;
  /** 从多高开始下落的，用于摔落伤害 */
  private fallStartY: number;
  /** 头朝哪（与身体朝向分开，生物会扭头看玩家） */
  headYaw = 0;
  /** 苦力怕的引信；−1 表示没在鼓 */
  fuse = -1;
  /** 羊的颜色（0..15），只有羊用 */
  variant = 0;

  constructor(entityId: number, def: MobDef, x: number, y: number, z: number, yaw = 0) {
    this.entityId = entityId;
    this.def = def;
    this.body = makeBody(x, y, z, yaw);
    this.body.width = def.width;
    this.body.height = def.height;
    this.health = def.maxHealth;
    this.fallStartY = y;
    this.headYaw = yaw;
    this.goals = new GoalSelector();
  }

  get x(): number { return this.body.x; }
  get y(): number { return this.body.y; }
  get z(): number { return this.body.z; }
  get yaw(): number { return this.body.yaw; }
  get alive(): boolean { return this.deathTicks < 0 && !this.removed; }

  /** 眼睛的世界坐标 y */
  get eyeY(): number {
    return this.body.y + this.def.eyeHeight;
  }

  /** 速度倍率：定义表里的格/秒换算成 stepBody 认的倍率 */
  get speedMultiplier(): number {
    return this.def.speed / PLAYER_WALK_SPEED;
  }

  /**
   * 与行为无关的每刻杂务。AI 由 GoalSelector 单独驱动。
   *
   * @returns 这一刻是否受了伤（供调用方决定要不要广播）
   */
  tickPhysicsAndVitals(world: BlockView, tables: PhysicsTables, skyLight: number, isDay: boolean): boolean {
    this.age++;
    if (this.invulnerable > 0) this.invulnerable--;
    if (this.hurtTime > 0) this.hurtTime--;
    if (this.attackCooldown > 0) this.attackCooldown--;

    if (this.deathTicks >= 0) {
      this.deathTicks++;
      if (this.deathTicks >= DEATH_TICKS) this.removed = true;
      return false;
    }

    if (this.def.flying) {
      // 会飞的：直接按速度平移并做碰撞，不走 stepBody。
      //
      // 不复用 stepBody 是因为它内建了重力、摩擦和"站在地上"的语义，
      // 而这三样对恶魂和火球全都不成立 —— 硬套的话恶魂会贴着天花板
      // 一路蹭，而那看起来像卡住了
      this.flyStep(world, tables);
      this.fallStartY = this.body.y;
    } else {
      const wasOnGround = this.body.onGround;
      this.body.speed = this.speedMultiplier;
      stepBody(world, tables, this.body, this.input);

      // 摔落伤害：与玩家同一条公式 ceil(距离 − 3)
      if (!this.body.onGround && this.body.vy < 0 && wasOnGround) this.fallStartY = this.body.y;
      if (this.body.onGround && !wasOnGround) {
        const fell = this.fallStartY - this.body.y;
        if (fell > 3) this.hurt(Math.ceil(fell - 3));
        this.fallStartY = this.body.y;
      } else if (this.body.onGround) {
        this.fallStartY = this.body.y;
      }
    }

    let hurtThisTick = false;

    // 日灼。判据是"头顶那一格的天光"而不是"y 够高"——
    // 树下、屋檐下、水里都不该烧，而那三种情况 y 可能一样高
    if (this.def.burnsInSunlight && isDay && skyLight >= SUNLIGHT_BURN_THRESHOLD) {
      if (this.fireTicks <= 0) this.fireTicks = 160;
    }
    if (this.fireTicks > 0) {
      this.fireTicks--;
      if (this.fireTicks % FIRE_DAMAGE_INTERVAL === 0) hurtThisTick = this.hurt(1) || hurtThisTick;
    }

    // 掉出世界
    if (this.body.y < -8) {
      this.health = 0;
      this.die();
    }
    return hurtThisTick;
  }

  /**
   * 掉血。
   * @returns 是否真的掉了（无敌帧内不掉）
   */
  hurt(amount: number): boolean {
    if (!this.alive) return false;
    if (this.invulnerable > 0) return false;
    this.health -= amount;
    this.invulnerable = INVULNERABLE_TICKS;
    this.hurtTime = INVULNERABLE_TICKS;
    if (this.health <= 0) {
      this.health = 0;
      this.die();
    }
    return true;
  }

  /** 被打飞：MC 的击退是固定 0.4 水平 + 0.4 竖直 */
  /**
   * 被推开。
   *
   * @param extraLevels 击退附魔的等级。MC 的 Knockback 是**额外**的强度
   *   （每级再推 0.5 格的水平速度），不是把基础击退乘几倍 ——
   *   写成乘法的话击退 II 能把怪打飞出视野，那是现代版加了击退抗性
   *   之后才成立的手感
   */
  knockback(dx: number, dz: number, extraLevels = 0): void {
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return;
    const strength = 0.4 + extraLevels * 0.5;
    this.body.vx += (dx / len) * strength;
    this.body.vz += (dz / len) * strength;
    this.body.vy = 0.4;
    this.body.onGround = false;
  }

  die(): void {
    if (this.deathTicks < 0) this.deathTicks = 0;
  }

  /** 撞上方块了吗。飞行体每刻更新，火球据此决定要不要炸 */
  hitWall = false;

  /**
   * 飞行体的一步：按速度平移 + 碰撞，无重力无摩擦。
   *
   * 不复用 stepBody：那里内建了重力、摩擦和"站在地上"的语义，
   * 而这三样对恶魂和火球全都不成立 —— 硬套的话恶魂会贴着天花板
   * 一路蹭，看起来像卡住了。
   *
   * 速度由调用方（AI 目标或火球自己）设定，这里只负责搬运与撞墙判定。
   */
  private flyStep(world: BlockView, tables: PhysicsTables): void {
    setBodyBox(flyBox, this.body.x, this.body.y, this.body.z, this.body.width, this.body.height);
    const r = collideMove(world, tables, flyBox, this.body.vx, this.body.vy, this.body.vz);
    this.hitWall = r.hitX || r.hitY || r.hitZ;
    this.body.x += r.dx;
    this.body.y += r.dy;
    this.body.z += r.dz;
    // 撞到哪一轴就把那一轴的速度清掉，不然会一直贴着墙推
    if (r.hitX) this.body.vx = 0;
    if (r.hitY) this.body.vy = 0;
    if (r.hitZ) this.body.vz = 0;
    this.body.onGround = r.hitY && this.body.vy <= 0;
  }

  /** 头顶那一格的世界坐标，用于查天光 */
  headBlock(): { x: number; y: number; z: number } {
    return {
      x: Math.floor(this.body.x),
      y: Math.min(WORLD_HEIGHT - 1, Math.floor(this.body.y + this.def.height)),
      z: Math.floor(this.body.z),
    };
  }

  toNbt(): NbtValue {
    return nbt.compound({
      id: nbt.string('Mob'),
      Type: nbt.short(this.def.type),
      Pos: nbt.list(TagType.DOUBLE, [nbt.double(this.body.x), nbt.double(this.body.y), nbt.double(this.body.z)]),
      Motion: nbt.list(TagType.DOUBLE, [nbt.double(this.body.vx), nbt.double(this.body.vy), nbt.double(this.body.vz)]),
      Rotation: nbt.list(TagType.DOUBLE, [nbt.double(this.body.yaw), nbt.double(this.headYaw)]),
      Health: nbt.short(this.health),
      Fire: nbt.short(this.fireTicks),
      Age: nbt.int(this.age),
      Variant: nbt.byte(this.variant),
    });
  }
}

/** 从 NBT 还原一只生物。entityId 由调用方重新分配 */
export function mobFromNbt(entityId: number, tag: NbtValue, defOf: (type: number) => MobDef | null): Mob | null {
  const def = defOf(getInt(tag, 'Type'));
  if (def === null) return null;
  const num = (list: NbtValue[], i: number): number => {
    const v = list[i];
    return v !== undefined && (v.type === TagType.DOUBLE || v.type === TagType.FLOAT) ? v.value : 0;
  };
  const pos = getList(tag, 'Pos');
  const motion = getList(tag, 'Motion');
  const rot = getList(tag, 'Rotation');
  const mob = new Mob(entityId, def, num(pos, 0), num(pos, 1), num(pos, 2), num(rot, 0));
  mob.body.vx = num(motion, 0);
  mob.body.vy = num(motion, 1);
  mob.body.vz = num(motion, 2);
  mob.headYaw = num(rot, 1);
  mob.health = getInt(tag, 'Health', def.maxHealth);
  mob.fireTicks = getInt(tag, 'Fire');
  mob.age = getInt(tag, 'Age');
  mob.variant = getInt(tag, 'Variant');
  return mob;
}
