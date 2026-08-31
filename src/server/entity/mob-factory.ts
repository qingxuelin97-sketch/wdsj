/**
 * 给一只新生物装上它的 AI 目标。
 *
 * 这张表就是"每种生物是什么脾气"的**全部**定义。九种生物、六个目标类型，
 * 组合出来的行为差异靠的是列表内容而不是九个子类 ——
 * 想让骷髅也会怕光只需要加一行。
 *
 * 优先级参考 MC 的排布：保命 > 攻击 > 被吸引 > 游荡 > 发呆。
 */
import type { Mob } from './mob.ts';
import { MobCategory, MobType } from '../../content/mobs.ts';
import {
  TargetNearestPlayerGoal, MeleeAttackGoal, CreeperSwellGoal, RangedAttackGoal,
  EndermanTeleportGoal, WanderGoal, TemptGoal, PanicGoal, LookAtPlayerGoal,
} from './goals.ts';
import { GhastShootGoal } from './ghast.ts';

/** 装目标。itemIdOf 用来解析"被什么吸引" */
export function installGoals(mob: Mob, itemIdOf: (name: string) => number): void {
  const def = mob.def;
  const goals = mob.goals;

  if (def.category === MobCategory.PASSIVE) {
    goals.add(new PanicGoal(1));
    if (def.temptedBy !== null) goals.add(new TemptGoal(2, itemIdOf(def.temptedBy)));
    goals.add(new WanderGoal(5));
    goals.add(new LookAtPlayerGoal(6));
    return;
  }

  // 火球没有 AI —— 它由 MobManager 直接推进（飞、撞、炸）。
  // 给它装目标的话，它会试着"走"向玩家，而它压根没有腿
  if (def.type === MobType.FIREBALL) return;

  // 恶魂只悬停和开火，不追人。追人的话它会贴到脸上，
  // 而恶魂的威胁感恰恰来自"够不着"
  if (def.type === MobType.GHAST) {
    goals.add(new GhastShootGoal(1));
    return;
  }

  // 敌对：先选目标（不占通道），再决定怎么打
  goals.add(new TargetNearestPlayerGoal(0, def.followRange));
  switch (def.type) {
    case MobType.CREEPER:
      goals.add(new CreeperSwellGoal(2));
      break;
    case MobType.SKELETON:
      goals.add(new RangedAttackGoal(2));
      break;
    case MobType.ENDERMAN:
      // 传送优先级高于攻击：挨打的那一刻先闪开，这是末影人最鲜明的特征
      goals.add(new EndermanTeleportGoal(1));
      goals.add(new MeleeAttackGoal(2));
      break;
    default:
      goals.add(new MeleeAttackGoal(2));
      break;
  }
  goals.add(new WanderGoal(5));
  goals.add(new LookAtPlayerGoal(6));
}
