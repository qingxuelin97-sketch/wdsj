/**
 * 玩家的生存循环：血量、饥饿、饱和、消耗、回血、憋气、各种伤害源、死亡重生。
 *
 * 全部数值取自 `core/constants.ts`，那里的每一条都对着 MC 1.0 的原值。
 * 这一层只负责**把它们串起来**，不自己发明任何数字 —— 生存循环的手感
 * 完全由这些数字决定，改动其中任何一个都会让"一天要吃几次饭""摔多高会死"
 * 这类玩家早已内化的常识失效。
 *
 * 消耗（exhaustion）是这套系统的枢纽，也是最容易写错的地方：
 * 它不是"饥饿值"本身，而是一个累加器 —— 每攒够 4.0 就扣 1 点饱和度，
 * 饱和度空了才扣饥饿。这个双层结构是"刚吃饱时能疯跑很久，
 * 饿了之后掉得飞快"的全部来源。
 */
import type { ServerPlayer } from './server-player.ts';
import type { ServerWorld } from '../world/server-world.ts';
import { stateId } from '../../core/world/chunk.ts';
import { consumesAir } from '../../core/item/enchant-effects.ts';
import {
  MAX_HEALTH, MAX_HUNGER, EXHAUSTION_PER_UNIT, EXHAUSTION,
  REGEN_MIN_HUNGER, REGEN_INTERVAL, AIR_SUPPLY_TICKS,
  DAMAGE_DROWN, DAMAGE_LAVA, DAMAGE_FIRE, DAMAGE_SUFFOCATE, DAMAGE_STARVE, DAMAGE_VOID,
  DAMAGE_CACTUS, ARMOR_DAMAGE_DIVISOR, FALL_DAMAGE_THRESHOLD,
  PLAYER_HEIGHT, EYE_HEIGHT,
} from '../../core/constants.ts';

/** 伤害类型。决定护甲挡不挡得住、以及要不要给无敌帧 */
export const DamageKind = {
  /** 近战、箭、爆炸 —— 护甲有效 */
  PHYSICAL: 0,
  /** 摔落 —— 1.0 里护甲**无效** */
  FALL: 1,
  /** 火、岩浆 —— 护甲有效 */
  FIRE: 2,
  /** 溺水、窒息、饿死、虚空 —— 护甲无效 */
  BYPASS_ARMOR: 3,
} as const;
export type DamageKind = (typeof DamageKind)[keyof typeof DamageKind];

/** 玩家的生存状态。与位置、物品栏并列挂在 ServerPlayer 上 */
export class PlayerVitals {
  health = MAX_HEALTH;
  hunger = MAX_HUNGER;
  /** 饱和度。上限是当前饥饿值，吃东西时一起涨 */
  saturation = 5;
  /** 消耗累加器，攒够 EXHAUSTION_PER_UNIT 就扣一格 */
  exhaustion = 0;
  /** 剩余氧气 */
  air = AIR_SUPPLY_TICKS;
  /** 距离上次自然回血过了几刻 */
  regenTimer = 0;
  /** 饿死计时 */
  starveTimer = 0;
  /** 受击无敌帧 */
  invulnerable = 0;
  /** 着火剩余刻数 */
  fireTicks = 0;
  /** 各种持续伤害的计时器 */
  private readonly timers = new Map<string, number>();
  /** 从多高开始下落 */
  fallStartY = 0;
  /** 死了没 */
  get dead(): boolean {
    return this.health <= 0;
  }

  /** 攒一点消耗 */
  addExhaustion(amount: number): void {
    if (this.dead) return;
    this.exhaustion += amount;
    while (this.exhaustion >= EXHAUSTION_PER_UNIT) {
      this.exhaustion -= EXHAUSTION_PER_UNIT;
      if (this.saturation > 0) this.saturation = Math.max(0, this.saturation - 1);
      else this.hunger = Math.max(0, this.hunger - 1);
    }
  }

  /** 吃东西 */
  eat(foodPoints: number, saturationModifier: number): void {
    this.hunger = Math.min(MAX_HUNGER, this.hunger + foodPoints);
    // MC 的原式：饱和度加 foodPoints × modifier × 2，且不超过当前饥饿值
    this.saturation = Math.min(this.hunger, this.saturation + foodPoints * saturationModifier * 2);
  }

  /**
   * 计时器到点了吗。到了就重置并返回 true。
   *
   * 每种持续伤害各有自己的节奏（岩浆 10 刻、溺水 20 刻、饿死 80 刻），
   * 共用一张表而不是各开一个字段：加一种伤害源时不用改类的形状。
   */
  due(key: string, interval: number): boolean {
    const t = (this.timers.get(key) ?? 0) + 1;
    if (t >= interval) {
      this.timers.set(key, 0);
      return true;
    }
    this.timers.set(key, t);
    return false;
  }

  reset(): void {
    this.health = MAX_HEALTH;
    this.hunger = MAX_HUNGER;
    this.saturation = 5;
    this.exhaustion = 0;
    this.air = AIR_SUPPLY_TICKS;
    this.regenTimer = 0;
    this.starveTimer = 0;
    this.invulnerable = 0;
    this.fireTicks = 0;
    this.timers.clear();
  }
}

/**
 * 护甲减伤。1.9 之前的公式：输出 = 输入 × (25 − 点数) / 25。
 *
 * 每点减 4%，满 20 点（整套钻石）减 80%。这条公式简单到可以心算，
 * 也正因为如此，玩家对"穿钻甲能扛几下"是有精确预期的。
 */
export function applyArmor(damage: number, armorPoints: number, kind: DamageKind): number {
  if (kind === DamageKind.FALL || kind === DamageKind.BYPASS_ARMOR) return damage;
  const reduced = damage * (ARMOR_DAMAGE_DIVISOR - Math.min(20, armorPoints)) / ARMOR_DAMAGE_DIVISOR;
  // MC 的伤害是整数，向下取整但至少 1 —— 否则满甲会变成完全免疫
  return Math.max(1, Math.floor(reduced));
}

/** 摔落伤害：ceil(距离 − 3)，与生物同一条公式 */
export function fallDamage(distance: number): number {
  return distance > FALL_DAMAGE_THRESHOLD ? Math.ceil(distance - FALL_DAMAGE_THRESHOLD) : 0;
}

export interface VitalsContext {
  world: ServerWorld;
  /** 玩家整套护甲的点数 */
  armorPoints(player: ServerPlayer): number;
  /** 掉血（已经过护甲），负责广播与死亡处理 */
  hurt(player: ServerPlayer, amount: number, kind: DamageKind): void;
}

/**
 * 推进一个玩家的生存状态一刻。
 *
 * 顺序有讲究：先算环境伤害，再算饥饿与回血。反过来的话，
 * 玩家会在被岩浆烧死的同一刻回一点血，血量曲线看着莫名其妙。
 */
export function tickVitals(player: ServerPlayer, v: PlayerVitals, ctx: VitalsContext): void {
  if (v.invulnerable > 0) v.invulnerable--;
  if (v.dead) return;

  const world = ctx.world;
  const bx = Math.floor(player.x);
  const bz = Math.floor(player.z);
  const feetY = Math.floor(player.y);
  const headY = Math.floor(player.y + EYE_HEIGHT);
  const tables = world.tables;

  const idAt = (x: number, y: number, z: number): number => stateId(world.getBlock(x, y, z));
  const headId = idAt(bx, headY, bz);
  const feetId = idAt(bx, feetY, bz);

  /**
   * 身体**任意一格**是不是某种方块。
   *
   * 只看 `floor(y)` 那一格是不够的，而且错法很隐蔽：玩家站在岩浆池
   * 底上时，脚下有实心方块托着，y 会停在 11.9999996 —— `floor` 得到 11，
   * 也就是**池底那块石头**，于是"在岩浆里"判定为假，人整个泡在岩浆里
   * 却不再掉血。闸门②卡了很久就是这个（诊断信息里 `y=12.000000` 而
   * `blk=…,11,…`，两个数看着矛盾，其实是 toFixed 四舍五入把它藏起来了）。
   *
   * MC 的判据是**碰撞盒与流体相交**。这里按身高扫一遍所占的格子，
   * 语义相同而代价只有两三次查表。
   */
  const bodyHas = (pred: (id: number) => boolean): boolean => {
    // 从脚下那一格扫到头顶那一格。+0.01 吸收浮点：贴着方块顶面站着时
    // y 可能是 11.9999996，那一格其实已经不属于身体
    const y0 = Math.floor(player.y + 0.01);
    const y1 = Math.floor(player.y + PLAYER_HEIGHT - 0.01);
    for (let y = y0; y <= y1; y++) {
      if (pred(idAt(bx, y, bz))) return true;
    }
    return false;
  };

  // --- 虚空 ---
  if (player.y < -8 && v.due('void', DAMAGE_VOID.interval)) {
    ctx.hurt(player, DAMAGE_VOID.amount, DamageKind.BYPASS_ARMOR);
    return;
  }

  // --- 溺水：头在水里就憋气，憋完开始掉血 ---
  const headInWater = (tables.isWater[headId] ?? 0) !== 0;
  if (headInWater) {
    // 水下呼吸：摇中就这一刻不扣氧气。逐刻判定而不是"把总时长乘以倍数"，
    // 与原版一致 —— 结果的期望是 ×(等级+1)，呼吸 III 大约 60 秒
    if (consumesAir(player.inventory.armorAt(0), (n: number) => world.random.nextInt(n))) v.air--;
    if (v.air < 0) {
      v.air = 0;
      if (v.due('drown', DAMAGE_DROWN.interval)) {
        ctx.hurt(player, DAMAGE_DROWN.amount, DamageKind.BYPASS_ARMOR);
      }
    }
  } else {
    v.air = Math.min(AIR_SUPPLY_TICKS, v.air + 4);
  }

  // --- 岩浆与火 ---
  //
  // 按整个身体判，不是只看脚下那一格 —— 见 bodyHas 的注释。
  // 10/11 是流动/静止岩浆
  const inLava = bodyHas((id) => id === 10 || id === 11);
  if (inLava) {
    v.fireTicks = Math.max(v.fireTicks, 300);
    if (v.due('lava', DAMAGE_LAVA.interval)) ctx.hurt(player, DAMAGE_LAVA.amount, DamageKind.FIRE);
  }
  // 火同理：站在火苗边上、火在膝盖高度时照样该着火
  if (bodyHas((id) => id === 51)) {
    v.fireTicks = Math.max(v.fireTicks, 160);
  }
  if (v.fireTicks > 0) {
    v.fireTicks--;
    // 站在水里会灭火
    if (headInWater || bodyHas((id) => (tables.isWater[id] ?? 0) !== 0)) v.fireTicks = 0;
    else if (v.due('fire', DAMAGE_FIRE.interval)) ctx.hurt(player, DAMAGE_FIRE.amount, DamageKind.FIRE);
  }

  // --- 仙人掌 ---
  if (feetId === 81 && v.due('cactus', DAMAGE_CACTUS.interval)) {
    ctx.hurt(player, DAMAGE_CACTUS.amount, DamageKind.PHYSICAL);
  }

  // --- 窒息：头卡在实心方块里 ---
  if (headId !== 0 && (tables.solid[headId] ?? 0) !== 0 && (tables.fullCube[headId] ?? 0) !== 0
    && v.due('suffocate', DAMAGE_SUFFOCATE.interval)) {
    ctx.hurt(player, DAMAGE_SUFFOCATE.amount, DamageKind.BYPASS_ARMOR);
  }

  // --- 饥饿与回血 ---
  if (v.hunger >= REGEN_MIN_HUNGER && v.health < MAX_HEALTH) {
    v.regenTimer++;
    if (v.regenTimer >= REGEN_INTERVAL) {
      v.regenTimer = 0;
      v.health = Math.min(MAX_HEALTH, v.health + 1);
      // 回血要花消耗 —— 这是"吃饱了会自己回血，但回血也会让你再饿"的来源
      v.addExhaustion(EXHAUSTION.regen);
    }
  } else {
    v.regenTimer = 0;
  }

  if (v.hunger <= 0) {
    v.starveTimer++;
    if (v.starveTimer >= DAMAGE_STARVE.interval) {
      v.starveTimer = 0;
      // 1.0 的普通难度：饿到 1 血为止，不会真的饿死（困难难度才会）
      if (v.health > 1) ctx.hurt(player, DAMAGE_STARVE.amount, DamageKind.BYPASS_ARMOR);
    }
  } else {
    v.starveTimer = 0;
  }

  void PLAYER_HEIGHT;
}
