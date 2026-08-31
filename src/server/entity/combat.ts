/**
 * 战斗与投射物：玩家打生物、箭的飞行与命中、爆炸、玩家掉血。
 *
 * 从 server-core.ts 里分出来的（那个文件到了 627 行、越过 600 硬上限）。
 * 分界线是"谁伤到了谁"：所有伤害路径聚在一处，将来加盔甲减伤、
 * 伤害类型、附魔加成时只有这一个文件要改。
 */
import type { ServerCore } from '../server-core.ts';
import type { ServerPlayer } from '../player/server-player.ts';
import type { Mob } from './mob.ts';
import type { TargetRef } from './goal.ts';
import { ArrowEntity, ARROW_SPEED, type ArrowEntity as Arrow } from './arrow.ts';
import { explode } from './explosion.ts';
import { REACH_LIMIT_SQ } from '../player/block-interaction.ts';
import { isEmpty, cloneStack, clearStack } from '../../core/item/item-def.ts';
import { Dimension } from '../../core/world/dimension.ts';
import { MobType } from '../../content/mobs.ts';
import { applyArmor, DamageKind } from '../player/player-vitals.ts';
import {
  rollOf, meleeBonusAgainst, knockbackLevels, fireAspectSeconds, afterProtection, damageItem,
  lootingLevelOf,
} from '../player/enchant-apply.ts';
import { xpToNextLevel } from '../player/experience.ts';
import { tossFromPlayer, spawnXpOrbs } from './item-manager.ts';
import { syncInventory } from '../player/inventory-actions.ts';
import { setBodyBox, makeBox } from '../../core/physics/block-collision.ts';
import { S_EntityEvent, S_Explosion, S_PlayerHealth, S_PlayerPosLook, S_ChangeDimension } from '../../core/net/packets.ts';
import { EYE_HEIGHT, PLAYER_WIDTH, PLAYER_HEIGHT, MAX_HEALTH, INVULNERABLE_TICKS, EXHAUSTION, TPS } from '../../core/constants.ts';

/** 箭命中判定复用的盒子。每刻可能有几十支箭，别每支都新建 */
const arrowScratch = makeBox();

/**
 * 箭的每刻：飞、命中、消失。
 *
 * 命中判定按 entityId 升序遍历，保证多个目标挤在一起时"射中谁"是确定的。
 */
export function tickArrows(core: ServerCore): void {
  if (core.arrows.size === 0) return;
  const dead: number[] = [];
  for (const arrow of core.arrows.values()) {
    arrow.tick(core.world.store, core.world.tables);
    if (!arrow.dead && !arrow.stuck) resolveArrowHit(core, arrow);
    if (arrow.dead) dead.push(arrow.entityId);
  }
  for (const id of dead) core.arrows.delete(id);
}

function resolveArrowHit(core: ServerCore, arrow: Arrow): void {
  // 玩家优先：被自己射的箭打到在 1.0 里是不会发生的（骷髅射的箭能打到骷髅，
  // 但打不到射它的那只），所以只跳过 owner 自己
  for (const player of [...core.eachPlayer()].sort((a, b) => a.entityId - b.entityId)) {
    if (player.entityId === arrow.ownerId || player.health <= 0) continue;
    setBodyBox(arrowScratch, player.x, player.y, player.z, PLAYER_WIDTH, PLAYER_HEIGHT);
    if (!arrow.hits(arrowScratch)) continue;
    damagePlayer(core, player, arrow.damage, arrow.x, arrow.z);
    arrow.dead = true;
    return;
  }
  for (const mob of [...core.mobs.mobs.values()].sort((a, b) => a.entityId - b.entityId)) {
    if (mob.entityId === arrow.ownerId || !mob.alive) continue;
    setBodyBox(arrowScratch, mob.x, mob.y, mob.z, mob.def.width, mob.def.height);
    if (!arrow.hits(arrowScratch)) continue;
    if (mob.hurt(arrow.damage)) {
      mob.knockback(arrow.x - mob.x, arrow.z - mob.z);
      mob.targetId = arrow.ownerId;
    }
    arrow.dead = true;
    return;
  }
}

/**
 * 玩家打一只生物。
 *
 * 伤害取手上物品的 attackDamage（空手 1）：木剑 4 / 石剑 5 / 铁剑 6 /
 * 钻石剑 7 / 金剑 4。工具也能打，只是伤害低 —— 与 MC 一致。
 *
 * 触及距离与挖方块共用同一个上限：客户端是按自己预测的位置发包的，
 * 两套标准会让"看着够得着却打不到"偶发出现。
 */
export function onAttackEntity(core: ServerCore, player: ServerPlayer, value: Record<string, unknown>): void {
  const mob = core.mobs.mobs.get(value['entityId'] as number);
  if (mob === undefined || !mob.alive) return;
  const dx = mob.x - player.x;
  const dy = mob.y + mob.def.height / 2 - (player.y + EYE_HEIGHT);
  const dz = mob.z - player.z;
  if (dx * dx + dy * dy + dz * dz > REACH_LIMIT_SQ) return;

  // 火球：打中不是"造成伤害"而是**击回**。
  //
  // 方向取玩家的**视线**而不是"火球到玩家的反向"：反向的话
  // 玩家侧身一挥就能把火球送向谁也没瞄的方向，看起来像随机。
  // MC 也是按攻击者朝向重设速度的
  if (mob.def.type === MobType.FIREBALL) {
    const look = lookVector(player);
    if (core.mobs.deflectFireball(mob.entityId, look.x, look.y, look.z, player.entityId)) {
      for (const p of core.eachPlayer()) {
        if (p.dimension !== player.dimension) continue;
        if (!p.isSubscribed(Math.floor(mob.x) >> 4, Math.floor(mob.z) >> 4)) continue;
        p.channel.send(S_EntityEvent, { entityId: mob.entityId, event: 0 });
      }
    }
    return;
  }

  const held = player.inventory.held;
  const world = core.worldOf(player.dimension);
  const roll = rollOf(world);
  const base = isEmpty(held) ? 1 : (core.items.get(held.id)?.attackDamage ?? 1);
  // 附魔加成在最后一步才取整，与 MC 一致：锋利 V 是 +6.25，
  // 先取整成 +6 的话五级和四级（+5.0）之间就只差 1 而不是 1.25
  const damage = Math.floor(base + meleeBonusAgainst(held, mob));
  // 抢夺等级要在**打之前**记下来：mob.hurt 可能当场把它打死并走掉落，
  // 而掉落那边已经不知道是谁打的了
  mob.lootingLevel = lootingLevelOf(held);
  if (!mob.hurt(damage)) return;

  // 火焰附加：点燃它。MC 的 setFire 单位是秒
  const burn = fireAspectSeconds(held);
  if (burn > 0) mob.fireTicks = Math.max(mob.fireTicks, burn * TPS);

  // 武器掉耐久。空手不掉，方块也不掉 —— maxDurability 为 0 的东西
  // damageItem 会直接返回
  if (!isEmpty(held)) {
    const def = core.items.get(held.id);
    if (def !== undefined && damageItem(held, def.maxDurability, roll)) syncInventory(core, player);
  }

  // 末影水晶被打死就炸。爆炸是它唯一的存在感 ——
  // 悄无声息地消失的话，玩家不会把"拆水晶"和"龙不再回血"联系起来
  if (mob.def.type === MobType.ENDER_CRYSTAL && !mob.alive) {
    core.explode(mob.x, mob.y + 1, mob.z, 6, mob.entityId, core.worldOf(player.dimension));
  }
  // 击退：每级多推一段。MC 的 Knockback 是"额外的击退强度"，
  // 不是把基础击退乘几倍
  mob.knockback(dx, dz, knockbackLevels(held));
  // 打了它就会还手；被动生物则会逃跑，那由 PanicGoal 负责
  if (mob.def.attackDamage > 0) mob.targetId = player.entityId;
  for (const p of core.eachPlayer()) {
    if (!p.isSubscribed(Math.floor(mob.x) >> 4, Math.floor(mob.z) >> 4)) continue;
    p.channel.send(S_EntityEvent, { entityId: mob.entityId, event: mob.alive ? 0 : 1 });
  }
}

/**
 * 玩家的视线单位向量。
 *
 * yaw 0 朝 +Z（与 client/camera.ts 一致），pitch 正值朝下 ——
 * 两个约定任一处搞反，击回的火球都会飞向天花板，
 * 而那看起来像"打回去了但没打中"。
 */
function lookVector(player: ServerPlayer): { x: number; y: number; z: number } {
  const cp = Math.cos(player.pitch);
  return {
    x: Math.sin(player.yaw) * cp,
    y: -Math.sin(player.pitch),
    z: Math.cos(player.yaw) * cp,
  };
}

/**
 * 骷髅放箭。
 *
 * 瞄准照抄 MC 的 `EntitySkeleton.attackEntityWithRangedAttack`：
 *   出膛点 = 射手眼高 − 0.1
 *   竖直分量 = (目标眼高 − 1.1 − 出膛点) + 水平距离 × 0.2
 *
 * 那个 **−1.1** 是关键：瞄的是目标的胸口而不是眼睛。少了它、
 * 或者随手改成一个"抬一点枪口"的估值，抛物线的顶点就会落在目标头顶 ——
 * 实测用 −0.3 时箭从玩家头上 0.17 格掠过，六格外百发百不中，
 * 而画面上看起来完全像是射中了。
 */
export function shootArrow(core: ServerCore, mob: Mob, target: TargetRef): void {
  const originY = mob.eyeY - 0.1;
  const arrow = new ArrowEntity(
    core.world.allocEntityId(), mob.entityId,
    mob.x, originY, mob.z, mob.def.attackDamage,
  );
  const dx = target.x - mob.x;
  const dz = target.z - mob.z;
  const dy = target.eyeY - 1.1 - originY;
  const dist = Math.hypot(dx, dz);
  arrow.shoot(
    dx, dy + dist * 0.2, dz,
    ARROW_SPEED, 0.06, () => core.world.random.nextDouble(),
  );
  core.arrows.set(arrow.entityId, arrow);
}

/** 炸一下。苦力怕与（M11 的）TNT 共用 */
export function explodeAt(
  core: ServerCore, x: number, y: number, z: number, power: number,
  sourceId = -1, world = core.world,
): void {
  const result = explode(core, x, y, z, power, sourceId, world);
  for (const hit of result.hurtPlayers) {
    const player = core.playerById(hit.entityId);
    if (player !== undefined) damagePlayer(core, player, hit.damage, x, z);
  }
  for (const player of core.eachPlayer()) {
    // 只有同一维度的人才听得见。不看维度的话，下界炸一发 TNT
    // 会让主世界同坐标的玩家眼前闪一下
    if (player.dimension !== world.dimension) continue;
    if (!player.isSubscribed(Math.floor(x) >> 4, Math.floor(z) >> 4)) continue;
    player.channel.send(S_Explosion, { x, y, z, power });
  }
}

/**
 * 玩家掉血。
 *
 * 全部伤害都从这里过：生物的攻击、箭、爆炸、以及 player-vitals.ts 里
 * 那一串环境伤害。集中在一处的好处是护甲减伤、无敌帧、死亡处理各只有
 * 一份实现 —— 分散写的话，"某种伤害忘了算护甲"这种 bug 会一直藏着，
 * 因为它只在穿着甲被那一种东西打时才显形。
 */
export function damagePlayer(
  core: ServerCore, player: ServerPlayer, amount: number,
  fromX: number, fromZ: number, kind: DamageKind = DamageKind.PHYSICAL,
): void {
  const v = player.vitals;
  if (v.dead) return;
  // 无敌帧只挡"一次性"的伤害。环境伤害（岩浆、溺水）各有自己的节奏，
  // 走无敌帧的话它们会被近战打断，泡在岩浆里反而更安全
  if (kind === DamageKind.PHYSICAL && v.invulnerable > 0) return;

  const armor = armorPointsOf(core, player);
  // 顺序照抄 MC：**先护甲点数，再保护系附魔**。
  // 反过来的话满钻甲 + 保护 IV 会算出接近零的伤害
  const pieces = [0, 1, 2, 3].map((i) => player.inventory.armorAt(i));
  const dealt = Math.max(1, Math.floor(
    afterProtection(applyArmor(amount, armor, kind), pieces, kind),
  ));
  v.health = Math.max(0, v.health - dealt);
  if (kind === DamageKind.PHYSICAL) v.invulnerable = INVULNERABLE_TICKS;
  // 受伤会消耗体力 —— 挨打之后更容易饿，这是 MC 的设计
  v.addExhaustion(EXHAUSTION.damageTaken);

  // 击退：把玩家推离伤害来源。客户端会自己预测，服务端只发一次位置
  const dx = player.x - fromX;
  const dz = player.z - fromZ;
  const len = Math.hypot(dx, dz);
  if (len > 1e-6 && kind === DamageKind.PHYSICAL) {
    player.x += dx / len * 0.4;
    player.z += dz / len * 0.4;
  }

  sendVitals(player);
  if (v.dead) onPlayerDeath(core, player);
}

/** 整套护甲的点数 */
export function armorPointsOf(core: ServerCore, player: ServerPlayer): number {
  let points = 0;
  for (let i = 0; i < 4; i++) {
    const stack = player.inventory.armorAt(i);
    if (isEmpty(stack)) continue;
    points += core.items.get(stack.id)?.armorPoints ?? 0;
  }
  return points;
}

/** 把血量与饥饿同步给客户端 */
export function sendVitals(player: ServerPlayer): void {
  player.channel.send(S_PlayerHealth, {
    health: Math.max(0, Math.round(player.vitals.health)),
    maxHealth: MAX_HEALTH,
    hunger: Math.max(0, Math.round(player.vitals.hunger)),
    air: Math.max(0, Math.round(player.vitals.air / 15)),
    xpLevel: Math.min(255, player.xp.level),
    xpProgress: Math.round(xpBarFraction(player) * 255),
  });
}

function xpBarFraction(player: ServerPlayer): number {
  const need = xpToNextLevel(player.xp.level);
  return need <= 0 ? 0 : Math.min(1, player.xp.progress / need);
}

/**
 * 玩家死了。
 *
 * 掉光背包、按等级掉经验、等客户端请求重生。**不立刻重生** ——
 * 那会让死亡毫无重量，而"看着自己的东西撒了一地"正是死亡的代价本身。
 */
export function onPlayerDeath(core: ServerCore, player: ServerPlayer): void {
  if (player.awaitingRespawn) return;
  player.awaitingRespawn = true;

  // 背包全掉在原地
  for (const slot of player.inventory.slots) {
    if (isEmpty(slot)) continue;
    tossFromPlayer(core, player, cloneStack(slot));
    // clearStack 而不是逐字段清 —— 它还会把附魔删掉。
    // 不删的话这个空格子身上挂着一份幽灵附魔，重生后捡回来的第一件
    // 普通物品会白捡到它
    clearStack(slot);
  }
  // 经验按等级掉，上限 100 点
  const dropped = player.xp.dropOnDeath();
  if (dropped > 0) {
    spawnXpOrbs(core, core.worldOf(player.dimension), player.x, player.y + 0.5, player.z, dropped);
  }
  player.xp.reset();

  syncInventory(core, player);
  sendVitals(player);
  core.sendChat(player, '你死了');
}

/** 重生：满血满饥饿，回到出生点 */
export function respawnPlayer(core: ServerCore, player: ServerPlayer): void {
  player.vitals.reset();
  player.awaitingRespawn = false;
  // 出生点在**主世界**。只改坐标不改维度的话，在下界死掉的人会"重生"
  // 在下界的主世界出生点坐标上 —— 那八成是实心的地狱岩，人一进去就窒息，
  // 死了又重生，卡在循环里出不来
  const wasElsewhere = player.dimension !== Dimension.OVERWORLD;
  player.dimension = Dimension.OVERWORLD;
  player.x = core.spawnX;
  player.y = core.spawnY;
  player.z = core.spawnZ;
  player.peakY = player.y;
  player.resetSubscriptions();
  if (wasElsewhere) {
    // 换维度要发 S_ChangeDimension 而不是 S_PlayerPosLook：客户端要靠它
    // 清掉上一个维度的方块镜像与在飞的网格。只发 PosLook 的话，
    // 人回了主世界而看到的还是下界的地形
    player.channel.send(S_ChangeDimension, {
      dimension: Dimension.OVERWORLD, x: player.x, y: player.y, z: player.z, yaw: player.yaw,
    });
  } else {
    player.channel.send(S_PlayerPosLook, {
      seq: 0, x: player.x, y: player.y, z: player.z,
      yaw: player.yaw, pitch: player.pitch, onGround: true,
    });
  }
  sendVitals(player);
  syncInventory(core, player);
}
