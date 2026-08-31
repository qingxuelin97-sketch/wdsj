/**
 * 掉落物实体：物理常数、合并、拾取、消失。
 *
 * 物理数值直接对 MC 1.0 的 `EntityItem.onUpdate`：重力 0.04（**不是**玩家的
 * 0.08）、空中阻力 0.98、落地时水平再乘 0.6、落地反弹 −0.5、6000 刻消失。
 *
 * 重力这一项值得单独测：掉落物飘得比玩家慢是肉眼可见的差别，写成 0.08
 * 的话画面上会"啪"地砸下去，玩家说不出哪里不对但就是觉得不对。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerCore } from '../../src/server/server-core.ts';
import { createBlockRegistry, Blocks } from '../../src/content/blocks.ts';
import { createItemRegistry, Items } from '../../src/content/items.ts';
import { ItemEntity, ITEM_LIFETIME, PICKUP_DELAY } from '../../src/server/entity/item-entity.ts';
import { spawnItem, tickItems } from '../../src/server/entity/item-manager.ts';
import { packState } from '../../src/core/world/chunk.ts';
import { makeStack } from '../../src/core/item/item-def.ts';
import { GRAVITY } from '../../src/core/constants.ts';

const registry = createBlockRegistry();
const items = createItemRegistry();
const DIAMOND = items.idOf(Items.DIAMOND);

function makeCore(): ServerCore {
  const core = new ServerCore({ seed: 5n, registry });
  core.world.forceChunk(0, 0);
  return core;
}

/** 在指定位置放一个掉落物，不给初速度（scatter=false，好让位移可预测） */
function drop(core: ServerCore, x: number, y: number, z: number, count = 1): ItemEntity {
  const e = spawnItem(core, core.world, x, y, z, makeStack(DIAMOND, count), false);
  assert.ok(e !== null);
  return e;
}

test('重力是 0.04，正好是玩家的一半', () => {
  const core = makeCore();
  const e = drop(core, 8.5, 100, 8.5);
  e.tick(core.world.store, core.world.tables);
  // 一刻之后的竖直速度就是负的重力（还没乘阻力之前的位移已经用掉了）
  assert.ok(Math.abs(e.vy + 0.04 * 0.98) < 1e-9, `第一刻的 vy 应该是 -0.0392，实得 ${e.vy}`);
  assert.equal(GRAVITY, 0.08, '玩家的重力仍是 0.08，两者不该混用');
});

test('落在方块上就停住，不会一直往下渗', () => {
  const core = makeCore();
  // 造一个平台
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      core.world.setBlock(8 + dx, 70, 8 + dz, packState(registry.idOf(Blocks.STONE)));
    }
  }
  const e = drop(core, 8.5, 76, 8.5);
  for (let i = 0; i < 200; i++) e.tick(core.world.store, core.world.tables);

  assert.ok(e.onGround, '应该落地了');
  assert.ok(e.y >= 71 && e.y < 71.01, `应该停在平台上（y≈71），实得 ${e.y}`);
  assert.equal(e.vy, 0, '停住之后竖直速度应该归零，不该以 1e-8 的速度永远在动');
});

test('拾取延迟：刚掉出来的 10 刻里捡不起来', () => {
  const core = makeCore();
  const e = drop(core, 8.5, 70, 8.5);
  assert.equal(e.pickupDelay, PICKUP_DELAY);
  assert.equal(e.canBePickedUpBy(8.5, 70, 8.5), false, '延迟没走完不该能捡');
  for (let i = 0; i < PICKUP_DELAY; i++) e.tick(core.world.store, core.world.tables);
  // 这十刻里它一直在下落（脚下没垫东西），所以要按**它现在的位置**判，
  // 而不是按刚才那个坐标 —— 否则测的就成了"掉了多远"
  assert.equal(e.pickupDelay, 0, '延迟应该走完了');
  assert.equal(e.canBePickedUpBy(8.5, e.y, 8.5), true, '延迟走完就该能捡了');
});

test('拾取范围：水平一格以内才算', () => {
  const core = makeCore();
  const e = drop(core, 8.5, 70, 8.5);
  e.pickupDelay = 0;
  assert.equal(e.canBePickedUpBy(8.5, 70, 8.5), true);
  assert.equal(e.canBePickedUpBy(9.4, 70, 8.5), true, '0.9 格以内该能捡');
  assert.equal(e.canBePickedUpBy(10.5, 70, 8.5), false, '两格外不该能捡');
  assert.equal(e.canBePickedUpBy(8.5, 60, 8.5), false, '差十格高不该能捡');
});

test('活到 6000 刻就消失', () => {
  const core = makeCore();
  const e = drop(core, 8.5, 70, 8.5);
  for (let i = 0; i < ITEM_LIFETIME - 1; i++) e.tick(core.world.store, core.world.tables);
  assert.equal(e.dead, false, `第 ${ITEM_LIFETIME - 1} 刻还不该消失`);
  e.tick(core.world.store, core.world.tables);
  assert.equal(e.dead, true, `第 ${ITEM_LIFETIME} 刻该消失了`);
});

test('挨着的同类会合并 —— 砍一棵树不该在地上留六个实体', () => {
  const core = makeCore();
  for (let i = 0; i < 6; i++) drop(core, 8.5 + i * 0.05, 70, 8.5, 1);
  assert.equal(core.world.items.size, 6);

  // 合并每 25 刻试一次，跑够一轮
  for (let i = 0; i < 30; i++) tickItems(core, core.world);
  assert.equal(core.world.items.size, 1, '六个应该并成一个');
  assert.equal([...core.world.items.values()][0]!.stack.count, 6, '数量要守恒');
});

test('超过上限的部分不合并，也不会凭空多出物品', () => {
  const core = makeCore();
  drop(core, 8.5, 70, 8.5, 60);
  drop(core, 8.52, 70, 8.5, 10);
  for (let i = 0; i < 30; i++) tickItems(core, core.world);
  const total = [...core.world.items.values()].reduce((a, e) => a + e.stack.count, 0);
  assert.equal(total, 70, '合并前后总数必须守恒');
  assert.equal(core.world.items.size, 2, '60+10 超过 64，不该合并');
});

test('隔得远的不合并', () => {
  const core = makeCore();
  drop(core, 8.5, 70, 8.5, 1);
  drop(core, 12.5, 70, 8.5, 1);
  for (let i = 0; i < 30; i++) tickItems(core, core.world);
  assert.equal(core.world.items.size, 2, '四格远不该合并');
});

test('NBT 往返：位置、速度、年龄、拾取延迟一个不少', async () => {
  const { itemEntityFromNbt } = await import('../../src/server/entity/item-entity.ts');
  const e = new ItemEntity(42, 1.5, 64.25, -3.75, makeStack(DIAMOND, 33, 7));
  e.vx = 0.125;
  e.vy = -0.5;
  e.vz = 0.0625;
  e.age = 1234;
  e.pickupDelay = 5;

  const back = itemEntityFromNbt(99, e.toNbt());
  assert.ok(back !== null);
  assert.equal(back.entityId, 99, '实体 id 由调用方重新分配 —— 它只在本次运行内有意义');
  assert.deepEqual([back.x, back.y, back.z], [1.5, 64.25, -3.75]);
  assert.deepEqual([back.vx, back.vy, back.vz], [0.125, -0.5, 0.0625]);
  assert.equal(back.age, 1234);
  assert.equal(back.pickupDelay, 5);
  assert.deepEqual([back.stack.id, back.stack.count, back.stack.damage], [DIAMOND, 33, 7]);
});
