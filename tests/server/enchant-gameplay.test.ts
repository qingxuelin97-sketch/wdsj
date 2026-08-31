/**
 * 附魔**真的作用在玩法上**了吗。
 *
 * 与 tests/core/enchant-effects.test.ts 的分工：那边验的是公式算得对不对
 * （纯函数，不碰服务端）；这里验的是那些公式**被接上了** ——
 * 附魔的剑打出去伤害真的更高、附了效率的镐真的挖得更快、
 * 精准采集真的掉石头本身。
 *
 * 这一整个文件的存在理由是一条真实发生过的事故：附魔系统整套做完、
 * 25 条单元测试全绿、界面上也有紫光，而 enchantLevel() 在全仓库
 * **零调用者** —— 玩家花三十级换来的锋利 V 对伤害没有任何影响。
 * 公式对不代表接上了，所以两边都要有测试。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerCore } from '../../src/server/server-core.ts';
import { createBlockRegistry, Blocks } from '../../src/content/blocks.ts';
import { createItemRegistry, Items } from '../../src/content/items.ts';
import { LoopbackTransport, PacketChannel } from '../../src/core/net/transport.ts';
import { S2C, C_Handshake, C_SetViewDistance, PROTOCOL_VERSION } from '../../src/core/net/packets.ts';
import { makeStack, type ItemStack } from '../../src/core/item/item-def.ts';
import { Enchantment } from '../../src/core/item/enchantment.ts';
import { packState } from '../../src/core/world/chunk.ts';
import { ticksToBreak, breakProgressPerTick } from '../../src/core/block/breaking.ts';
import { toolOf, dropOf } from '../../src/server/player/inventory-actions.ts';
import { advanceDigging } from '../../src/server/player/block-interaction.ts';
import { onAttackEntity, damagePlayer } from '../../src/server/entity/combat.ts';
import { DamageKind } from '../../src/server/player/player-vitals.ts';
import type { ServerPlayer } from '../../src/server/player/server-player.ts';

const registry = createBlockRegistry();
const items = createItemRegistry();

function rig(): { core: ServerCore; player: ServerPlayer } {
  const core = new ServerCore({ seed: 99n, registry });
  const [c, sv] = LoopbackTransport.createPair();
  c.synchronous = true;
  sv.synchronous = true;
  core.addClient(sv);
  const ch = new PacketChannel(c, S2C);
  ch.onPacket(() => {});
  ch.send(C_Handshake, { protocolVersion: PROTOCOL_VERSION, playerName: 'tester' });
  ch.send(C_SetViewDistance, { distance: 2 });
  ch.flush();
  const player = [...core.eachPlayer()][0]!;
  // 3×3 而不是一个：测试里放方块的位置在玩家旁边两格，
  // 很容易落到隔壁区块里，而没加载的区块 setBlock 会**静默失败** ——
  // 表现是"挖了 120 下耐久一点没掉"，看着像接线断了
  const cx = Math.floor(player.x) >> 4;
  const cz = Math.floor(player.z) >> 4;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) core.world.forceChunk(cx + dx, cz + dz);
  }
  return { core, player };
}

/**
 * 把这件东西放到玩家**手上**。
 *
 * 不能写 `slots[selectedHotbar]` —— 那是护甲格。快捷栏在
 * ARMOR_SLOTS + MAIN_SLOTS 之后（见 player-inventory.ts 的 held）。
 * 写错的表现是"附魔完全没生效"，而那正好和接线断了的症状一模一样，
 * 特别容易把人带沟里
 */
function setHeld(player: ServerPlayer, stack: ItemStack): void {
  const dst = player.inventory.held;
  dst.id = stack.id;
  dst.count = stack.count;
  dst.damage = stack.damage;
  if (stack.enchantments !== undefined) dst.enchantments = stack.enchantments;
  else delete dst.enchantments;
}

const ench = (id: number, count: number, list: { id: number; level: number }[]): ItemStack => {
  const s = makeStack(id, count);
  s.enchantments = list;
  return s;
};

/** 拿这把武器打一只满血僵尸一下，返回它掉了多少血 */
function hitZombie(core: ServerCore, player: ServerPlayer, weapon: ItemStack): number {
  const mob = core.mobs.spawnByName('zombie', player.x + 1, player.y, player.z, player.dimension);
  assert.ok(mob !== null);
  const before = mob.health;
  setHeld(player, weapon);
  onAttackEntity(core, player, { entityId: mob.entityId } as never);
  return before - mob.health;
}

test('锋利真的加伤害 —— 接线断了的话这条会和普通剑打成平手', () => {
  const { core, player } = rig();
  const plain = hitZombie(core, player, makeStack(items.idOf(Items.DIAMOND_SWORD), 1));
  const sharp = hitZombie(core, player, ench(items.idOf(Items.DIAMOND_SWORD), 1, [
    { id: Enchantment.SHARPNESS, level: 5 },
  ]));
  // 钻石剑基础 7，锋利 V 是 +6.25 -> floor(13.25) = 13
  assert.equal(plain, 7, '钻石剑的基础伤害');
  assert.equal(sharp, 13, `锋利 V 应该打出 13，实得 ${sharp}`);
});

test('亡灵杀手只对亡灵有用，打猪没有加成', () => {
  const { core, player } = rig();
  const smite = ench(items.idOf(Items.DIAMOND_SWORD), 1, [{ id: Enchantment.SMITE, level: 3 }]);

  const zombie = hitZombie(core, player, smite);
  assert.equal(zombie, 14, `亡灵杀手 III 打僵尸应该是 7 + 7.5 -> 14，实得 ${zombie}`);

  const pig = core.mobs.spawnByName('pig', player.x + 2, player.y, player.z, player.dimension)!;
  const before = pig.health;
  setHeld(player, smite);
  onAttackEntity(core, player, { entityId: pig.entityId } as never);
  assert.equal(before - pig.health, 7, '打猪不该有亡灵加成');
});

test('火焰附加真的把怪点着了', () => {
  const { core, player } = rig();
  const mob = core.mobs.spawnByName('zombie', player.x + 1, player.y, player.z, player.dimension)!;
  assert.equal(mob.fireTicks, 0);
  setHeld(player, ench(items.idOf(Items.DIAMOND_SWORD), 1, [
    { id: Enchantment.FIRE_ASPECT, level: 2 },
  ]));
  onAttackEntity(core, player, { entityId: mob.entityId } as never);
  // 火焰附加 II = 8 秒 = 160 刻
  assert.equal(mob.fireTicks, 160, `应该烧 160 刻，实得 ${mob.fireTicks}`);
});

test('保护系真的减伤', () => {
  const armorId = items.idOf('diamond_chestplate');

  /** 穿上（或不穿）这件胸甲，挨 10 点物理伤害，返回实际掉了多少血 */
  const takeHit = (piece: ItemStack | null): number => {
    const { core, player } = rig();
    if (piece !== null) {
      const dst = player.inventory.armorAt(1);
      dst.id = piece.id;
      dst.count = piece.count;
      dst.damage = piece.damage;
      if (piece.enchantments !== undefined) dst.enchantments = piece.enchantments;
    }
    player.vitals.health = 20;
    damagePlayer(core, player, 10, player.x + 5, player.z, DamageKind.PHYSICAL);
    return 20 - player.vitals.health;
  };

  const bare = takeHit(null);
  const plainArmor = takeHit(makeStack(armorId, 1));
  const enchanted = takeHit(ench(armorId, 1, [{ id: Enchantment.PROTECTION, level: 4 }]));

  assert.ok(plainArmor < bare, `穿甲要比裸的抗打：裸 ${bare}，甲 ${plainArmor}`);
  assert.ok(
    enchanted < plainArmor,
    `保护 IV 要比同一件不带附魔的更抗打：普通甲 ${plainArmor}，附魔甲 ${enchanted}`,
  );
  assert.ok(enchanted >= 1, 'MC 的伤害至少是 1 —— 减到 0 等于完全免疫');
});

test('效率真的挖得更快', () => {
  const { core } = rig();
  const stoneId = registry.idOf(Blocks.STONE);
  const pick = makeStack(items.idOf(Items.DIAMOND_PICKAXE), 1);
  const fast = ench(items.idOf(Items.DIAMOND_PICKAXE), 1, [{ id: Enchantment.EFFICIENCY, level: 5 }]);

  // 比**每刻进度**而不是 ticksToBreak：后者要 ceil 成整数刻，
  // 而石头只要 6 刻，取整会把 4.25 倍压成 3 倍，测出来的是取整误差
  const plain = breakProgressPerTick(core.world.tables, stoneId, toolOf(core, pick));
  const quick = breakProgressPerTick(core.world.tables, stoneId, toolOf(core, fast));
  const ratio = quick / plain;

  // 钻石镐速度 8，效率 V 加 5²+1 = 26 -> 34，正好 4.25 倍
  assert.ok(Math.abs(ratio - 4.25) < 0.01, `效率 V 该是 4.25 倍，实得 ${ratio.toFixed(3)}`);

  // 顺带确认整数刻那一层也确实更快了 —— 玩家感受到的是这个
  assert.ok(
    ticksToBreak(core.world.tables, stoneId, toolOf(core, fast))
    < ticksToBreak(core.world.tables, stoneId, toolOf(core, pick)),
    '按整数刻算也该更快',
  );
});

test('效率对不对口的方块无效 —— 拿镐挖泥土不会因为附魔变快', () => {
  const { core } = rig();
  const dirtId = registry.idOf(Blocks.DIRT);
  const plain = makeStack(items.idOf(Items.DIAMOND_PICKAXE), 1);
  const fast = ench(items.idOf(Items.DIAMOND_PICKAXE), 1, [{ id: Enchantment.EFFICIENCY, level: 5 }]);
  assert.equal(
    ticksToBreak(core.world.tables, dirtId, toolOf(core, fast)),
    ticksToBreak(core.world.tables, dirtId, toolOf(core, plain)),
    '镐对泥土不对口，效率不该生效',
  );
});

test('精准采集让石头掉石头而不是圆石', () => {
  const { core, player } = rig();
  const stoneId = registry.idOf(Blocks.STONE);

  setHeld(player, makeStack(items.idOf(Items.DIAMOND_PICKAXE), 1));
  const normal = dropOf(core, stoneId, player);
  assert.equal(normal?.id, registry.idOf(Blocks.COBBLESTONE), '普通镐该掉圆石');

  setHeld(player, ench(items.idOf(Items.DIAMOND_PICKAXE), 1, [
    { id: Enchantment.SILK_TOUCH, level: 1 },
  ]));
  const silk = dropOf(core, stoneId, player);
  assert.equal(silk?.id, stoneId, '精准采集该掉石头本身');
});

test('时运让煤矿多掉，但对石头无效', () => {
  const { core, player } = rig();
  const coalOre = registry.idOf(Blocks.COAL_ORE);
  const fortune = ench(items.idOf(Items.DIAMOND_PICKAXE), 1, [{ id: Enchantment.FORTUNE, level: 3 }]);

  // 摇很多次，至少要出现过一次 >1
  setHeld(player, fortune);
  let sawExtra = false;
  let total = 0;
  for (let i = 0; i < 200; i++) {
    const d = dropOf(core, coalOre, player);
    total += d?.count ?? 0;
    if ((d?.count ?? 0) > 1) sawExtra = true;
  }
  assert.ok(sawExtra, '时运 III 挖煤矿应该出现过多掉');
  assert.ok(total > 200, `期望值应该明显大于 1 件/次，实得平均 ${(total / 200).toFixed(2)}`);

  // 石头不吃时运
  const stoneId = registry.idOf(Blocks.STONE);
  for (let i = 0; i < 50; i++) {
    assert.equal(dropOf(core, stoneId, player)?.count, 1, '石头不该吃时运');
  }
});

test('耐久真的让工具更耐用', () => {
  const stoneId = registry.idOf(Blocks.STONE);

  /** 拿这把镐真的挖 120 格石头，返回它磨掉了多少耐久 */
  const wearAfter120 = (tool: ItemStack): number => {
    const { core, player } = rig();
    const bx = Math.floor(player.x) + 2;
    const bz = Math.floor(player.z);
    const by = Math.floor(player.y) + 1;
    setHeld(player, tool);
    // 读**槽位里那一件**，不是传进来的这个对象 ——
    // setHeld 是把字段抄进槽位，原对象不会跟着变
    const inHand = player.inventory.held;
    for (let i = 0; i < 120; i++) {
      assert.ok(core.world.setBlock(bx, by, bz, packState(stoneId)), '石头应该放得下');
      player.digging = true;
      player.digX = bx; player.digY = by; player.digZ = bz;
      player.digProgress = 1;   // 直接推到挖穿那一刻
      advanceDigging(core, player);
    }
    return inHand.damage;
  };

  const plain = wearAfter120(makeStack(items.idOf(Items.DIAMOND_PICKAXE), 1));
  assert.equal(plain, 120, `普通镐挖 120 格该掉 120 点耐久，实得 ${plain}`);

  const tough = wearAfter120(ench(items.idOf(Items.DIAMOND_PICKAXE), 1, [
    { id: Enchantment.UNBREAKING, level: 3 },
  ]));
  // 耐久 III 期望只扣四分之一。摇 120 次，落在 10..60 之外基本不可能
  assert.ok(tough > 10 && tough < 60, `耐久 III 该把 120 点磨损压到 30 上下，实得 ${tough}`);
  assert.ok(tough < plain, '附了耐久反而磨得更快？');
});

test('挖硬度为 0 的东西不掉耐久 —— 否则在草地上走一趟就废一把镐', () => {
  const { core, player } = rig();
  const torch = registry.idOf(Blocks.TORCH);
  const bx = Math.floor(player.x) + 2;
  const bz = Math.floor(player.z);
  const by = Math.floor(player.y) + 1;
  setHeld(player, makeStack(items.idOf(Items.DIAMOND_PICKAXE), 1));
  const pick = player.inventory.held;
  for (let i = 0; i < 30; i++) {
    assert.ok(core.world.setBlock(bx, by, bz, packState(torch)), '火把应该放得下');
    player.digging = true;
    player.digX = bx; player.digY = by; player.digZ = bz;
    player.digProgress = 1;
    advanceDigging(core, player);
  }
  assert.equal(pick.damage, 0, '火把硬度为 0，挖它不该算一次使用');
});

test('抢夺记在打死它的那一击上，事后换刀无效', () => {
  const { core, player } = rig();
  const mob = core.mobs.spawnByName('zombie', player.x + 1, player.y, player.z, player.dimension)!;
  const looting = ench(items.idOf(Items.DIAMOND_SWORD), 1, [{ id: Enchantment.LOOTING, level: 3 }]);

  setHeld(player, looting);
  onAttackEntity(core, player, { entityId: mob.entityId } as never);
  assert.equal(mob.lootingLevel, 3, '打的那一下就该把抢夺等级记上');

  // 换一把没附魔的再打
  setHeld(player, makeStack(items.idOf(Items.DIAMOND_SWORD), 1));
  onAttackEntity(core, player, { entityId: mob.entityId } as never);
  assert.equal(mob.lootingLevel, 0, '换成普通剑之后该清零 —— 记的永远是最后一击');
});
