/**
 * 药水效果：状态、每刻推进、以及"这个效果到底改了什么"。
 *
 * 这个文件存在的理由是一条已经发生过两次的事故：**算法做完了但没接进玩法**。
 * 酿造表（core/craft/brewing.ts）早就能酿出一瓶迅捷药水，可那瓶药水
 * 除了占一个格子什么也不做 —— 和"附魔 V 不加伤害"是同一种缺陷。
 *
 * 所以这里的每一条效果都必须指得出**它改了哪一个计算**：
 *
 *   治疗 / 伤害   applyPotion 当场加减 vitals.health（瞬间，没有时长）
 *   中毒 / 再生   tickEffects 按间隔掉血 / 回血
 *   力量 / 虚弱   meleePotionBonus()，由 entity/combat.ts 的 onAttackEntity 取用
 *   抗火         player-vitals.ts 的岩浆与着火两处伤害
 *   水下呼吸      player-vitals.ts 的扣氧气那一步
 *
 * 没接上的（迅捷/缓慢/夜视/隐身）**一条都不存进来**：存了却没人读，
 * 就又变成"看起来做完了"的假象。理由记在 docs/DEVIATIONS.md。
 *
 * 时间一律按 tick 记，不读挂钟 —— 服务端的一切都是这样，
 * 否则存档、录像与 `node --test` 里的手动 tick 三者会各走各的时间。
 */
import type { ServerPlayer } from './server-player.ts';
import { DamageKind, type VitalsContext } from './player-vitals.ts';
import {
  Effect, EFFECTS, readPotion, potionPotency, type EffectId,
} from '../../core/craft/brewing.ts';
import { MAX_HEALTH, POTION } from '../../core/constants.ts';

/** 一条正在生效的效果 */
export interface ActiveEffect {
  id: EffectId;
  /** 剩余刻数。到 0 就摘掉 */
  ticks: number;
  /** 0 = I 级，1 = II 级（增强药水）。所有"按等级翻倍"的量都用它移位 */
  amplifier: number;
  /**
   * 距离上一次"跳"过了几刻，中毒与再生按它掉血/回血。
   *
   * 计时器挂在这条效果身上，而不是借 PlayerVitals.due() 那张表：
   * due 的计数在效果结束后还留在表里，于是"喝完一瓶毒、过一阵再喝一瓶"
   * 时第二瓶的第一次掉血会提前十几刻到来。挂在效果上则随效果一起消失。
   */
  sinceLast: number;
}

/** 存档用的一条效果。字段名照 MC 的 player.dat（ActiveEffects） */
export interface SavedEffect {
  id: number;
  amplifier: number;
  ticks: number;
}

/**
 * 一个玩家身上所有正在生效的药水效果。
 *
 * 用 Map 按效果 id 索引：同一种效果只能有一条（再喝一瓶是"续期或覆盖"，
 * 不是叠加）。做成数组的话，连喝五瓶迅捷会得到五条各自计时的效果，
 * 而玩家看到的是"药水效果永远不结束"。
 */
export class PlayerEffects {
  private readonly active = new Map<number, ActiveEffect>();

  get size(): number {
    return this.active.size;
  }

  has(id: EffectId): boolean {
    return this.active.has(id);
  }

  /** 这条效果的等级；没有这条效果时返回 −1（0 是合法的 I 级） */
  amplifierOf(id: EffectId): number {
    return this.active.get(id)?.amplifier ?? -1;
  }

  /** 还剩几刻。没有这条效果时返回 0 */
  remainingTicks(id: EffectId): number {
    return this.active.get(id)?.ticks ?? 0;
  }

  /**
   * 加一条效果（或续期）。
   *
   * 覆盖规则照 MC：等级高的赢；等级相同则时间长的赢。
   * 反过来写的话，喝一瓶普通迅捷会把身上那瓶增强迅捷降级 ——
   * 玩家会觉得"喝药反而变弱了"，而且完全找不到原因。
   */
  add(id: EffectId, ticks: number, amplifier: number): void {
    if (ticks <= 0) return;
    const old = this.active.get(id);
    if (old !== undefined) {
      if (amplifier < old.amplifier) return;
      if (amplifier === old.amplifier && ticks <= old.ticks) return;
    }
    this.active.set(id, { id, ticks, amplifier, sinceLast: 0 });
  }

  remove(id: EffectId): void {
    this.active.delete(id);
  }

  clear(): void {
    this.active.clear();
  }

  /** 逐条遍历，供 tickEffects 推进 */
  each(): Iterable<ActiveEffect> {
    return this.active.values();
  }

  /** 存盘用的快照 */
  snapshot(): SavedEffect[] {
    return [...this.active.values()].map((e) => ({
      id: e.id, amplifier: e.amplifier, ticks: e.ticks,
    }));
  }

  /**
   * 读档：把存下来的效果装回去。
   *
   * 盘上的字节可能是坏的或来自别的版本，所以不认识的效果 id 直接丢掉 ——
   * 留着的话它会永远挂在玩家身上（没有任何 case 会处理它，也就没人扣它的时间），
   * 而界面上还显示着一条谁也解释不了的效果。
   */
  restore(saved: readonly SavedEffect[]): void {
    this.active.clear();
    for (const s of saved) {
      if (EFFECTS[s.id] === undefined || s.ticks <= 0) continue;
      this.active.set(s.id, {
        id: s.id as EffectId,
        ticks: s.ticks,
        amplifier: Math.max(0, s.amplifier),
        sinceLast: 0,
      });
    }
  }
}

/**
 * 把一瓶药水的效果加到玩家身上。
 *
 * @param potionDamage 物品的 damage 值，药水的种类全写在里面
 * @returns 这瓶药水有没有效果。水瓶与粗制的药水返回 false ——
 *          它们照样喝得下去（瓶子会变回玻璃瓶），只是什么也不发生
 */
export function applyPotion(
  player: ServerPlayer, potionDamage: number, ctx: VitalsContext,
): boolean {
  const info = readPotion(potionDamage);
  const def = EFFECTS[info.effect];
  if (def === undefined || info.effect === Effect.NONE) return false;
  const { durationTicks, amplifier } = potionPotency(potionDamage);

  // 瞬间生效的两瓶（治疗/伤害）不进状态表：它们没有时长，
  // 存进去的话会得到一条永远在"治疗"却不知道该治多久的效果
  if (def.durationTicks === 0) {
    const amount = POTION.instantAmount << amplifier;
    if (info.effect === Effect.HEALING) {
      player.vitals.health = Math.min(MAX_HEALTH, player.vitals.health + amount);
      // 回了血不同步的话血条要等到下一次受伤才更新，
      // 玩家会以为这瓶治疗药水没生效
      ctx.sync(player);
    } else {
      // 伤害药水是魔法伤害，**穿甲**（MC 的 DamageSource.magic 就是这样）。
      // 走护甲的话穿一套钻甲喝伤害药水几乎不掉血，那瓶药就成了摆设
      ctx.hurt(player, amount, DamageKind.BYPASS_ARMOR);
    }
    return true;
  }

  player.effects.add(info.effect, durationTicks, amplifier);
  return true;
}

/**
 * 推进一个玩家身上的所有效果一刻。
 *
 * 排在 tickVitals 之后调用：中毒掉血要看的是环境伤害算完之后的血量，
 * 否则"泡在岩浆里被毒死"这种事的最后一刀会算错是谁打的。
 */
export function tickEffects(player: ServerPlayer, ctx: VitalsContext): void {
  const effects = player.effects;
  if (effects.size === 0) return;
  const v = player.vitals;
  // 死了就全部清掉。重生是满血满状态的新开始，带着一身毒重生
  // 会让人刚站起来又倒下 —— MC 也是死亡即清空
  if (v.dead) {
    effects.clear();
    return;
  }

  const expired: EffectId[] = [];
  for (const e of effects.each()) {
    e.sinceLast++;
    switch (e.id) {
      case Effect.POISON: {
        // 等级越高跳得越快（MC 是 25 >> 等级）
        const interval = Math.max(1, POTION.poisonInterval >> e.amplifier);
        if (e.sinceLast >= interval) {
          e.sinceLast = 0;
          // **中毒不会把人毒死**：1.0 的规则是最低留 1 血。
          // 少了这一条，一瓶蜘蛛眼酿的毒药就成了必杀技，
          // 而 MC 里中毒的定位是"难受但死不了"
          if (v.health > 1) ctx.hurt(player, 1, DamageKind.BYPASS_ARMOR);
        }
        break;
      }
      case Effect.REGENERATION: {
        const interval = Math.max(1, POTION.regenInterval >> e.amplifier);
        if (e.sinceLast >= interval && v.health < MAX_HEALTH) {
          e.sinceLast = 0;
          v.health = Math.min(MAX_HEALTH, v.health + 1);
          ctx.sync(player);
        }
        break;
      }
      default:
        // 其余效果不需要每刻做事：抗火与水下呼吸由 player-vitals.ts
        // 在判伤害时**查**这张表，力量/虚弱由 combat.ts 在挥刀时查。
        // 它们在这里只是在走时间
        break;
    }
    e.ticks--;
    if (e.ticks <= 0) expired.push(e.id);
  }
  // 遍历时不能改 Map，攒到最后一起摘
  for (const id of expired) effects.remove(id);
}

/**
 * 力量与虚弱加/减多少近战伤害。
 *
 * 由 entity/combat.ts 的 onAttackEntity 取用，和附魔的 meleeBonusAgainst
 * 加在一起之后才取整 —— 分别取整的话两个加成的零头会各被抹掉一次。
 *
 * 数值照 MC 1.0 的 EntityPlayer：力量 +3<<等级，虚弱 −2<<等级。
 */
export function meleePotionBonus(effects: PlayerEffects): number {
  let bonus = 0;
  const strength = effects.amplifierOf(Effect.STRENGTH);
  if (strength >= 0) bonus += POTION.strengthBonus << strength;
  const weakness = effects.amplifierOf(Effect.WEAKNESS);
  if (weakness >= 0) bonus -= POTION.weaknessPenalty << weakness;
  return bonus;
}
