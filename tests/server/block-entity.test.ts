/**
 * 方块实体：熔炉的燃烧与熔炼、箱子的存取、被拆时撒一地。
 *
 * 熔炉的数值必须对上 MC 1.0：一次熔炼 200 刻，煤烧 1600 刻正好八次。
 * 这不是"差不多就行"的地方 —— 玩家对"一炉煤烧八个"是有肌肉记忆的，
 * 差一点点就会觉得这游戏哪里不对，但说不出哪里。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerCore } from '../../src/server/server-core.ts';
import { createBlockRegistry, Blocks } from '../../src/content/blocks.ts';
import { createItemRegistry, Items } from '../../src/content/items.ts';
import { packState, stateId, AIR_STATE } from '../../src/core/world/chunk.ts';
import { makeStack } from '../../src/core/item/item-def.ts';
import {
  FurnaceEntity, ChestEntity, SMELT_TICKS, blockEntityFromNbt,
} from '../../src/server/world/block-entity.ts';
import { makeBlockEntityContext } from '../../src/server/world/block-entity-tick.ts';

const registry = createBlockRegistry();
const items = createItemRegistry();
const FURNACE = registry.idOf(Blocks.FURNACE);
const LIT_FURNACE = registry.idOf(Blocks.LIT_FURNACE);
const CHEST = registry.idOf(Blocks.CHEST);
const IRON_ORE = registry.idOf(Blocks.IRON_ORE);
const COAL = items.idOf(Items.COAL);
const IRON_INGOT = items.idOf(Items.IRON_INGOT);

/** 一个只有平地的世界太贵，直接建一个 core 并强制生成出生区块 */
function makeCore(): ServerCore {
  const core = new ServerCore({ seed: 99n, registry });
  core.world.forceChunk(0, 0);
  return core;
}

test('放下熔炉会长出一个方块实体，拆掉会收回去', () => {
  const core = makeCore();
  core.world.setBlock(4, 70, 4, packState(FURNACE));
  const entity = core.world.blockEntities.get(4, 70, 4);
  assert.ok(entity instanceof FurnaceEntity, '应该建出一个熔炉方块实体');

  core.world.setBlock(4, 70, 4, AIR_STATE);
  assert.equal(core.world.blockEntities.get(4, 70, 4), null, '拆掉之后不该还留着');
  const broken = core.world.drainBrokenBlockEntities();
  assert.equal(broken.length, 1, '拆下来的方块实体要交出来，好让里面的东西掉出来');
});

test('熔炉：一块煤烧满 1600 刻，正好熔出 8 个铁锭', () => {
  const core = makeCore();
  core.world.setBlock(4, 70, 4, packState(FURNACE));
  const furnace = core.world.blockEntities.get(4, 70, 4) as FurnaceEntity;
  // 放 16 个铁矿 + 1 块煤：煤只够烧 8 个
  furnace.slots[0] = makeStack(IRON_ORE, 16);
  furnace.slots[1] = makeStack(COAL, 1);

  const ctx = makeBlockEntityContext(core);
  for (let i = 0; i < 2000; i++) furnace.tick(ctx);

  assert.equal(furnace.slots[2]!.id, IRON_INGOT, '产物应该是铁锭');
  assert.equal(furnace.slots[2]!.count, 8, '1600 / 200 = 8 个');
  assert.equal(furnace.slots[0]!.count, 8, '烧掉 8 个，还剩 8 个矿');
  assert.equal(furnace.slots[1]!.count, 0, '煤应该用完了');
  assert.equal(furnace.burnTime, 0, '燃料烧尽');
});

test('熔炉：点着时方块换成 lit_furnace，烧完换回来，而且不清空内容', () => {
  const core = makeCore();
  core.world.setBlock(4, 70, 4, packState(FURNACE));
  const furnace = core.world.blockEntities.get(4, 70, 4) as FurnaceEntity;
  furnace.slots[0] = makeStack(IRON_ORE, 1);
  furnace.slots[1] = makeStack(COAL, 1);

  const ctx = makeBlockEntityContext(core);
  furnace.tick(ctx);
  assert.equal(stateId(core.world.getBlock(4, 70, 4)), LIT_FURNACE, '点着了该换成 lit_furnace');
  // 换 id 会走 setBlock，那里会调 updateBlockEntity —— 必须认出 61/62 是同一种，
  // 否则每次点火都把炉子里的东西清空。这一条正是为了钉死那个坑
  assert.equal(core.world.blockEntities.get(4, 70, 4), furnace, '还得是同一个方块实体');
  assert.equal(furnace.slots[0]!.count, 1, '内容不该被清掉');

  for (let i = 0; i < 1700; i++) furnace.tick(ctx);
  assert.equal(stateId(core.world.getBlock(4, 70, 4)), FURNACE, '烧完该换回普通熔炉');
  assert.equal(furnace.slots[2]!.count, 1, '这一炉的产物还在');
});

test('熔炉：断料时进度回退而不是清零', () => {
  const core = makeCore();
  core.world.setBlock(4, 70, 4, packState(FURNACE));
  const furnace = core.world.blockEntities.get(4, 70, 4) as FurnaceEntity;
  furnace.slots[0] = makeStack(IRON_ORE, 1);
  furnace.slots[1] = makeStack(items.idOf(Items.STICK), 1); // 木棍只烧 100 刻

  const ctx = makeBlockEntityContext(core);
  for (let i = 0; i < 100; i++) furnace.tick(ctx);
  const midway = furnace.cookTime;
  assert.ok(midway > 0 && midway < SMELT_TICKS, `烧到一半应该有进度，实际 ${midway}`);

  // 断料之后进度每刻退 2
  furnace.tick(ctx);
  assert.equal(furnace.cookTime, midway - 2, '断料后进度回退 2');
  assert.equal(furnace.slots[2]!.count, 0, '没烧完不该有产物');
});

test('熔炉：产物满了就停下，不会把材料吃掉', () => {
  const core = makeCore();
  core.world.setBlock(4, 70, 4, packState(FURNACE));
  const furnace = core.world.blockEntities.get(4, 70, 4) as FurnaceEntity;
  furnace.slots[0] = makeStack(IRON_ORE, 10);
  furnace.slots[1] = makeStack(COAL, 10);
  furnace.slots[2] = makeStack(IRON_INGOT, 64); // 已经满了

  const ctx = makeBlockEntityContext(core);
  for (let i = 0; i < 500; i++) furnace.tick(ctx);
  assert.equal(furnace.slots[0]!.count, 10, '材料一个都不该少');
  assert.equal(furnace.slots[1]!.count, 10, '燃料也不该被点着');
  assert.equal(furnace.slots[2]!.count, 64);
});

test('箱子被拆掉时，里面的东西全部撒出来', () => {
  const core = makeCore();
  core.world.setBlock(4, 70, 4, packState(CHEST));
  const chest = core.world.blockEntities.get(4, 70, 4) as ChestEntity;
  chest.slots[0] = makeStack(items.idOf(Items.DIAMOND), 5);
  chest.slots[13] = makeStack(COAL, 32);

  const contents = chest.contents();
  assert.equal(contents.length, 2, '只有非空的格子算数');
  assert.equal(contents.reduce((a, s) => a + s.count, 0), 37);
});

test('方块实体的 NBT 往返：熔炉的进度与内容一格不差', () => {
  const furnace = new FurnaceEntity(10, 64, -20);
  furnace.slots[0] = makeStack(IRON_ORE, 7);
  furnace.slots[1] = makeStack(COAL, 3);
  furnace.slots[2] = makeStack(IRON_INGOT, 12);
  furnace.burnTime = 743;
  furnace.burnTotal = 1600;
  furnace.cookTime = 137;

  const back = blockEntityFromNbt(furnace.toNbt()) as FurnaceEntity;
  assert.ok(back instanceof FurnaceEntity);
  assert.deepEqual([back.x, back.y, back.z], [10, 64, -20]);
  assert.equal(back.burnTime, 743, '燃烧进度必须原样还原 —— 这是 M9 的验收项之一');
  assert.equal(back.burnTotal, 1600);
  assert.equal(back.cookTime, 137);
  assert.deepEqual(
    back.slots.map((s) => [s.id, s.count]),
    [[IRON_ORE, 7], [COAL, 3], [IRON_INGOT, 12]],
  );
});

test('箱子的 NBT 往返：空格子不占地方，但槽位号要对得上', () => {
  const chest = new ChestEntity(-3, 5, 8);
  chest.slots[26] = makeStack(items.idOf(Items.DIAMOND), 1);
  const back = blockEntityFromNbt(chest.toNbt()) as ChestEntity;
  assert.equal(back.slots[26]!.id, items.idOf(Items.DIAMOND), '最后一格不能错位');
  assert.equal(back.slots[0]!.count, 0);
});

test('燃烧中的熔炉：只有格子真的动了才报"内容变了"', () => {
  const core = makeCore();
  core.world.setBlock(4, 70, 4, packState(FURNACE));
  const furnace = core.world.blockEntities.get(4, 70, 4) as FurnaceEntity;
  furnace.slots[0] = makeStack(IRON_ORE, 4);
  furnace.slots[1] = makeStack(COAL, 1);

  const ctx = makeBlockEntityContext(core);
  let contentTicks = 0;
  for (let i = 0; i < 900; i++) {
    furnace.tick(ctx);
    if (furnace.contentsChanged) contentTicks++;
  }

  // 900 刻里内容只该动 5 次：点火消耗 1 块煤，加上熔出 4 个铁锭。
  // 其余 895 刻变的都只是计时器 —— 那走 6 字节的进度包，
  // 不该触发整份 46 格窗口的重发
  assert.equal(contentTicks, 5, `内容变更应该只有 5 次，实得 ${contentTicks}`);
  assert.equal(furnace.slots[2]!.count, 4);
});
