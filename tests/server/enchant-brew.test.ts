/**
 * 附魔台与酿造台接到世界上之后的行为。
 *
 * `tests/core/enchanting.test.ts` 验的是表和算法；这里验的是**接线**：
 * 右键开不开得了界面、书架数得对不对、点了报价扣不扣级、
 * 一份材料是不是真的酿了三瓶。算法全对而接线错了的症状是
 * "附魔台点了没反应"，而那在浏览器里也看不出原因。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerCore } from '../../src/server/server-core.ts';
import { createBlockRegistry, Blocks } from '../../src/content/blocks.ts';
import { createItemRegistry, Items } from '../../src/content/items.ts';
import { LoopbackTransport, PacketChannel } from '../../src/core/net/transport.ts';
import {
  S2C, C_Handshake, C_SetViewDistance, C_UseBlock, C_EnchantSelect, PROTOCOL_VERSION,
  WindowKind,
} from '../../src/core/net/packets.ts';
import { packState, AIR_STATE } from '../../src/core/world/chunk.ts';
import { makeStack, canMerge, cloneStack } from '../../src/core/item/item-def.ts';
import {
  EnchantingEntity, BrewingEntity, BREW_TICKS,
} from '../../src/server/world/block-entity-craft.ts';
import {
  countBookshelves, targetOf, enchantabilityOf,
} from '../../src/server/player/enchant-actions.ts';
import { EnchantTarget } from '../../src/core/item/enchantment.ts';
import {
  AWKWARD_POTION, WATER_BOTTLE, readPotion, Effect,
} from '../../src/core/craft/brewing.ts';
import type { ServerPlayer } from '../../src/server/player/server-player.ts';

const registry = createBlockRegistry();
const items = createItemRegistry();
const STONE = packState(registry.idOf(Blocks.STONE));
const BOOKSHELF = packState(registry.idOf(Blocks.BOOKSHELF));
const TABLE = packState(registry.idOf(Blocks.ENCHANTING_TABLE));
const STAND = packState(registry.idOf(Blocks.BREWING_STAND));

interface Rig {
  core: ServerCore;
  player: ServerPlayer;
  send: (p: unknown, v: Record<string, unknown>) => void;
  seen: { name: string; value: Record<string, unknown> }[];
}

function makeRig(): Rig {
  const core = new ServerCore({ seed: 5n, registry });
  core.randomTicks = false;
  const [clientSide, serverSide] = LoopbackTransport.createPair();
  clientSide.synchronous = true;
  serverSide.synchronous = true;
  core.addClient(serverSide);
  const channel = new PacketChannel(clientSide, S2C);
  const seen: { name: string; value: Record<string, unknown> }[] = [];
  channel.onPacket((name, value) => { seen.push({ name, value }); });
  channel.send(C_Handshake, { protocolVersion: PROTOCOL_VERSION, playerName: 't' });
  channel.send(C_SetViewDistance, { distance: 2 });
  channel.flush();
  const player = [...core.eachPlayer()][0]!;
  for (let cx = -1; cx <= 1; cx++) {
    for (let cz = -1; cz <= 1; cz++) core.world.forceChunk(cx, cz);
  }
  for (let x = -8; x < 8; x++) {
    for (let z = -8; z < 8; z++) {
      core.world.setBlock(x, 70, z, STONE);
      for (let y = 71; y < 80; y++) core.world.setBlock(x, y, z, AIR_STATE);
    }
  }
  player.x = 0.5;
  player.y = 71;
  player.z = 0.5;
  core.tick();
  return {
    core, player, seen,
    send: (p, v) => { channel.send(p as never, v as never); channel.flush(); },
  };
}

// --- 附魔台 ---

test('右键附魔台开出附魔界面，且台子上是空的时候报价是三个 0', () => {
  const r = makeRig();
  r.core.world.setBlock(2, 71, 0, TABLE);
  r.seen.length = 0;
  r.send(C_UseBlock, { x: 2, y: 71, z: 0, face: 1, hitX: 0.5, hitY: 1, hitZ: 0.5 });
  // 服务端的出包在 tick 末尾统一 flush，不 tick 一下客户端什么都收不到
  r.core.tick();
  const open = r.seen.find((p) => p.name === 'S_OpenWindow');
  assert.ok(open !== undefined, '没开出窗口');
  assert.equal(open.value['kind'], WindowKind.ENCHANTING);
  const offers = r.seen.find((p) => p.name === 'S_EnchantOffers');
  assert.ok(offers !== undefined, '开界面时没报价');
  assert.deepEqual([offers.value['a'], offers.value['b'], offers.value['c']], [0, 0, 0]);
});

test('数书架：要留一格过道，埋进书堆里不算数', () => {
  const r = makeRig();
  const w = r.core.world;
  w.setBlock(0, 71, 0, TABLE);
  // 贴着台子摆一圈书架 —— 距离 1，不在 5×5 的外环上，一个都不该算
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue;
      w.setBlock(dx, 71, dz, BOOKSHELF);
    }
  }
  assert.equal(countBookshelves(w, 0, 71, 0), 0, '贴着台子的书架不该算数');

  // 清掉，改成正确的：距离 2，中间那格是空气
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue;
      w.setBlock(dx, 71, dz, AIR_STATE);
    }
  }
  w.setBlock(2, 71, 0, BOOKSHELF);
  w.setBlock(-2, 71, 0, BOOKSHELF);
  assert.equal(countBookshelves(w, 0, 71, 0), 2);

  // 把过道堵上，就又不算了
  w.setBlock(1, 71, 0, STONE);
  assert.equal(countBookshelves(w, 0, 71, 0), 1, '过道被堵住的那个书架还在算');
});

test('书架越多报价越高，且封顶 15 个', () => {
  const r = makeRig();
  const w = r.core.world;
  w.setBlock(0, 72, 0, TABLE);
  const entity = w.blockEntities.get(0, 72, 0);
  assert.ok(entity instanceof EnchantingEntity, '附魔台没有方块实体');

  // 摆满两层外环：5×5 的环每层 16 格，两层 32 格，远超 15
  let placed = 0;
  for (let dy = 0; dy <= 1; dy++) {
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.abs(dx) !== 2 && Math.abs(dz) !== 2) continue;
        w.setBlock(dx, 72 + dy, dz, BOOKSHELF);
        placed++;
      }
    }
  }
  assert.ok(placed > 15);
  assert.equal(countBookshelves(w, 0, 72, 0), 15, '书架该封顶在 15');
});

test('点报价：扣级、写附魔；等级不够时什么都不做', () => {
  const r = makeRig();
  const w = r.core.world;
  w.setBlock(2, 71, 0, TABLE);
  const entity = w.blockEntities.get(2, 71, 0) as EnchantingEntity;
  entity.slots[0] = makeStack(items.idOf(Items.DIAMOND_SWORD), 1);
  r.send(C_UseBlock, { x: 2, y: 71, z: 0, face: 1, hitX: 0.5, hitY: 1, hitZ: 0.5 });

  const cost = entity.offers[0];
  assert.ok(cost > 0, '放了钻石剑还是没报价');

  // 等级不够：什么都不该发生
  r.player.xp.reset();
  r.send(C_EnchantSelect, { windowId: r.player.windowId, slot: 0 });
  assert.equal(entity.slots[0]!.enchantments, undefined, '等级不够却附上了魔');
  assert.equal(r.player.xp.level, 0);

  // 给够级再点
  r.player.xp.add(100000);
  const before = r.player.xp.level;
  assert.ok(before >= cost, `给了十万点经验还不到 ${cost} 级`);
  r.send(C_EnchantSelect, { windowId: r.player.windowId, slot: 0 });
  // 从 contents() 里重读一份：上面那句 assert.equal(..., undefined) 会把
  // 类型收窄成 never，直接再读同一个属性 tsc 会拒
  const after = entity.contents()[0];
  assert.ok(after !== undefined, '装备没了');
  assert.ok((after.enchantments ?? []).length > 0, '点了报价却没附上魔');
  assert.equal(r.player.xp.level, before - cost, '扣的级数不对');
  // 附完之后报价该清空，不能再点一次
  assert.deepEqual(entity.offers, [0, 0, 0]);
});

test('附过魔的东西不能再附一次', () => {
  const r = makeRig();
  const w = r.core.world;
  w.setBlock(2, 71, 0, TABLE);
  const entity = w.blockEntities.get(2, 71, 0) as EnchantingEntity;
  const sword = makeStack(items.idOf(Items.DIAMOND_SWORD), 1);
  const marked: { id: number; level: number }[] = [{ id: 16, level: 1 }];
  sword.enchantments = marked;
  entity.slots[0] = sword;
  r.player.xp.add(100000);
  r.send(C_UseBlock, { x: 2, y: 71, z: 0, face: 1, hitX: 0.5, hitY: 1, hitZ: 0.5 });
  const before = r.player.xp.level;
  r.send(C_EnchantSelect, { windowId: r.player.windowId, slot: 0 });
  assert.equal(marked.length, 1, '附了第二遍');
  assert.equal(r.player.xp.level, before, '失败了却扣了级 —— 半成功是最糟的结果');
});

test('哪些东西能附魔', () => {
  const r = makeRig();
  const t = (name: string): string | null => targetOf(r.core, items.idOf(name));
  assert.equal(t(Items.DIAMOND_SWORD), EnchantTarget.SWORD);
  assert.equal(t(Items.DIAMOND_PICKAXE), EnchantTarget.DIGGER);
  assert.equal(t(Items.BOW), EnchantTarget.BOW);
  assert.equal(t(Items.IRON_HELMET), EnchantTarget.ARMOR_HEAD);
  assert.equal(t(Items.IRON_BOOTS), EnchantTarget.ARMOR_FEET);
  assert.equal(t(Items.IRON_CHESTPLATE), EnchantTarget.ARMOR);
  assert.equal(t(Items.APPLE), null, '苹果不该能附魔');
  assert.equal(t(Items.STICK), null);
});

test('附魔性：金最高、石头最低 —— MC 的反直觉设定', () => {
  const r = makeRig();
  const e = (name: string): number => enchantabilityOf(r.core, items.idOf(name));
  assert.equal(e(Items.GOLDEN_SWORD), 22);
  assert.equal(e(Items.WOODEN_SWORD), 15);
  assert.equal(e(Items.IRON_SWORD), 14);
  assert.equal(e(Items.DIAMOND_SWORD), 10);
  assert.equal(e(Items.STONE_SWORD), 5);
});

// --- 酿造台 ---

test('右键酿造台开出酿造界面', () => {
  const r = makeRig();
  r.core.world.setBlock(2, 71, 0, STAND);
  r.seen.length = 0;
  r.send(C_UseBlock, { x: 2, y: 71, z: 0, face: 1, hitX: 0.5, hitY: 1, hitZ: 0.5 });
  r.core.tick();
  const open = r.seen.find((p) => p.name === 'S_OpenWindow');
  assert.ok(open !== undefined);
  assert.equal(open.value['kind'], WindowKind.BREWING);
});

test('一份下界疣同时酿三瓶 —— 这是酿造唯一的效率来源', () => {
  const r = makeRig();
  const w = r.core.world;
  w.setBlock(2, 71, 0, STAND);
  const stand = w.blockEntities.get(2, 71, 0);
  assert.ok(stand instanceof BrewingEntity, '酿造台没有方块实体');
  for (let i = 0; i < 3; i++) {
    stand.slots[i] = makeStack(items.idOf(Items.POTION), 1, WATER_BOTTLE);
  }
  stand.slots[3] = makeStack(items.idOf(Items.NETHER_WART), 1);

  for (let i = 0; i < BREW_TICKS + 5; i++) r.core.tick();
  for (let i = 0; i < 3; i++) {
    assert.equal(stand.slots[i]!.damage, AWKWARD_POTION, `第 ${i} 瓶没酿成粗制的药水`);
  }
  assert.equal(stand.slots[3]!.count, 0, '材料该被消耗掉');
});

test('酿造要花满 400 刻，中途拿走材料会归零', () => {
  const r = makeRig();
  const w = r.core.world;
  w.setBlock(2, 71, 0, STAND);
  const stand = w.blockEntities.get(2, 71, 0) as BrewingEntity;
  stand.slots[0] = makeStack(items.idOf(Items.POTION), 1, WATER_BOTTLE);
  stand.slots[3] = makeStack(items.idOf(Items.NETHER_WART), 1);
  for (let i = 0; i < 100; i++) r.core.tick();
  assert.ok(stand.brewTime > 0 && stand.brewTime < BREW_TICKS, `进度不对：${stand.brewTime}`);
  assert.equal(stand.slots[0]!.damage, WATER_BOTTLE, '还没到时间就出货了');

  // 材料被拿走
  stand.slots[3] = makeStack(0, 0, 0);
  r.core.tick();
  assert.equal(stand.brewTime, 0, '材料没了进度该归零');
  assert.equal(stand.slots[0]!.damage, WATER_BOTTLE);
});

test('走完一整条药水链：水瓶 -> 粗制 -> 迅捷 -> 增强', () => {
  const r = makeRig();
  const w = r.core.world;
  w.setBlock(2, 71, 0, STAND);
  const stand = w.blockEntities.get(2, 71, 0) as BrewingEntity;
  const potion = items.idOf(Items.POTION);
  const brewOne = (ingredient: string): number => {
    stand.slots[3] = makeStack(items.idOf(ingredient), 1);
    for (let i = 0; i < BREW_TICKS + 2; i++) r.core.tick();
    return stand.slots[0]!.damage;
  };
  stand.slots[0] = makeStack(potion, 1, WATER_BOTTLE);
  assert.equal(brewOne(Items.NETHER_WART), AWKWARD_POTION);
  const speed = brewOne(Items.SUGAR);
  assert.equal(readPotion(speed).effect, Effect.SPEED);
  const strong = brewOne(Items.GLOWSTONE_DUST);
  assert.equal(readPotion(strong).upgraded, true);
});

test('酿不出来的组合不消耗材料', () => {
  const r = makeRig();
  const w = r.core.world;
  w.setBlock(2, 71, 0, STAND);
  const stand = w.blockEntities.get(2, 71, 0) as BrewingEntity;
  // 水瓶 + 糖：糖是主料，必须先有下界疣
  stand.slots[0] = makeStack(items.idOf(Items.POTION), 1, WATER_BOTTLE);
  stand.slots[3] = makeStack(items.idOf(Items.SUGAR), 3);
  for (let i = 0; i < BREW_TICKS + 5; i++) r.core.tick();
  assert.equal(stand.slots[0]!.damage, WATER_BOTTLE);
  assert.equal(stand.slots[3]!.count, 3, '酿不出来却把材料吃了');
  assert.equal(stand.brewTime, 0);
});

test('附了魔的物品不与别的堆合并 —— 合并会吞掉三十级的成果', () => {
  const a = makeStack(1, 1, 0);
  const b = makeStack(1, 1, 0);
  a.enchantments = [{ id: 16, level: 3 }];
  assert.equal(canMerge(a, b), false);
  // 深拷：改副本不该动到原件
  const c = cloneStack(a);
  c.enchantments![0]!.level = 99;
  assert.equal(a.enchantments[0]!.level, 3, 'cloneStack 是浅拷的');
});
