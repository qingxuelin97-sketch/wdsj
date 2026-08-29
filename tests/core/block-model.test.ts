/**
 * 方块模型与碰撞盒。
 *
 * 碰撞盒**由模型推导**，不另存一份 —— 所以这些用例同时锁住了两件事：
 * 看得见的形状，和撞得到的形状。两份分开写的话，改了模型忘了改碰撞，
 * 表现是玩家卡在看不见的东西上，且极难复现（要从特定角度走特定路线）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cubeModel, slabModel, stairsModel, fenceModel, torchModel, paneModel,
  layerModel, cakeModel, doorModel, bedModel, railModel,
  autoCullface, isFullCube, modelCollisionBoxes,
} from '../../src/core/block/block-model.ts';
import { Facing } from '../../src/core/block/types.ts';
import { createBlockRegistry, Blocks } from '../../src/content/blocks.ts';
import { modelIndexOf } from '../../src/core/registry/model-tables.ts';

const registry = createBlockRegistry();
const TABLES = registry.getTables();

/** 取某个状态的全部碰撞盒 */
function boxesOf(name: string, meta = 0): number[][] {
  const id = registry.idOf(name);
  const m = TABLES.models;
  const model = modelIndexOf(m, id, meta);
  const start = m.modelBoxStart[model]!;
  const count = m.modelBoxCount[model]!;
  const out: number[][] = [];
  for (let i = 0; i < count; i++) {
    const o = (start + i) * 6;
    out.push([
      m.collisionBoxes[o]!, m.collisionBoxes[o + 1]!, m.collisionBoxes[o + 2]!,
      m.collisionBoxes[o + 3]!, m.collisionBoxes[o + 4]!, m.collisionBoxes[o + 5]!,
    ]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// cullface —— 这套东西里最容易写错的一处
// ---------------------------------------------------------------------------

test('只有贴着格子边界的面才允许被剔除', () => {
  // 整格：六个面全贴边
  assert.deepEqual(autoCullface([0, 0, 0], [16, 16, 16]), [0, 1, 2, 3, 4, 5]);

  // 下半砖：顶面在 y=8，**不贴边**，所以不能被剔除。
  // 标错了的后果是半砖上面放方块会看穿，而这在静止截图里很难发现。
  const slab = autoCullface([0, 0, 0], [16, 8, 16]);
  assert.equal(slab[0], 0, '底面贴 y=0，可剔除');
  assert.equal(slab[1], -1, '顶面在 y=8，不可剔除');
  assert.equal(slab[2], 2, '四个侧面仍然贴边');
  assert.equal(slab[5], 5);

  // 火把那样悬在中间的小盒子：一个面都不能剔
  assert.deepEqual(autoCullface([7, 0, 7], [9, 10, 9]), [0, -1, -1, -1, -1, -1]);
});

test('isFullCube 只认真正的整格', () => {
  assert.equal(isFullCube(cubeModel()), true);
  assert.equal(isFullCube(slabModel(true)), false);
  assert.equal(isFullCube(stairsModel(Facing.NORTH, false)), false);
  assert.equal(isFullCube(layerModel(16)), true, '满高的层就是整格');
  assert.equal(isFullCube(layerModel(2)), false);
});

// ---------------------------------------------------------------------------
// 各形状的碰撞盒
// ---------------------------------------------------------------------------

test('半砖：下半砖占 0..0.5，上半砖占 0.5..1', () => {
  assert.deepEqual(modelCollisionBoxes(slabModel(true)), [[0, 0, 0, 1, 0.5, 1]]);
  assert.deepEqual(modelCollisionBoxes(slabModel(false)), [[0, 0.5, 0, 1, 1, 1]]);
  // 注册表里的真半砖也一样
  assert.deepEqual(boxesOf(Blocks.STONE_SLAB, 0), [[0, 0, 0, 1, 0.5, 1]]);
  assert.deepEqual(boxesOf(Blocks.STONE_SLAB, 1), [[0, 0.5, 0, 1, 1, 1]]);
});

test('楼梯：两个盒子，上半块靠向朝向那一侧', () => {
  for (const [facing, expect] of [
    [Facing.EAST, [0.5, 0.5, 0, 1, 1, 1]],
    [Facing.WEST, [0, 0.5, 0, 0.5, 1, 1]],
    [Facing.SOUTH, [0, 0.5, 0.5, 1, 1, 1]],
    [Facing.NORTH, [0, 0.5, 0, 1, 1, 0.5]],
  ] as const) {
    const boxes = modelCollisionBoxes(stairsModel(facing, false));
    assert.equal(boxes.length, 2, `朝向 ${facing} 应有两个盒子`);
    assert.deepEqual(boxes[0], [0, 0, 0, 1, 0.5, 1], '下半块永远是完整的半砖');
    assert.deepEqual(boxes[1], expect, `朝向 ${facing} 的上半块位置`);
  }
  // 上下颠倒的楼梯：底座在上半格
  const top = modelCollisionBoxes(stairsModel(Facing.NORTH, true));
  assert.deepEqual(top[0], [0, 0.5, 0, 1, 1, 1]);
  assert.deepEqual(top[1], [0, 0, 0, 1, 0.5, 0.5]);
});

test('栅栏：一根柱子 + 每个连接方向两根横梁', () => {
  const none = modelCollisionBoxes(fenceModel([false, false, false, false]));
  assert.equal(none.length, 1, '没有连接时只有柱子');
  assert.deepEqual(none[0], [6 / 16, 0, 6 / 16, 10 / 16, 1, 10 / 16]);

  const north = modelCollisionBoxes(fenceModel([true, false, false, false]));
  assert.equal(north.length, 3, '一个方向连接 = 柱子 + 上下两根横梁');

  const all = modelCollisionBoxes(fenceModel([true, true, true, true]));
  assert.equal(all.length, 9, '四向连接 = 柱子 + 8 根横梁');

  // 注册表里的栅栏，元数据即连接位
  assert.equal(boxesOf(Blocks.FENCE, 0).length, 1);
  assert.equal(boxesOf(Blocks.FENCE, 0b1111).length, 9);
});

test('雪层：厚度随元数据递增，第 8 层刚好一整格', () => {
  for (let meta = 0; meta < 8; meta++) {
    const boxes = boxesOf(Blocks.SNOW_LAYER, meta);
    const height = boxes[0]![4]!;
    assert.ok(Math.abs(height - (meta + 1) * 2 / 16) < 1e-6,
      `meta ${meta} 的高度应为 ${(meta + 1) * 2 / 16}，实得 ${height}`);
  }
  // 前三层都低于 STEP_HEIGHT(0.6)，走得上去；这是"雪地能直接走"的原因
  assert.ok(boxesOf(Blocks.SNOW_LAYER, 0)[0]![4]! < 0.6);
});

test('蛋糕：每吃一口从一侧缩进 2/16', () => {
  const full = modelCollisionBoxes(cakeModel(0))[0]!;
  assert.deepEqual(full, [1 / 16, 0, 1 / 16, 15 / 16, 0.5, 15 / 16]);
  for (let bites = 0; bites <= 6; bites++) {
    const b = modelCollisionBoxes(cakeModel(bites))[0]!;
    assert.ok(Math.abs(b[0]! - (1 + bites * 2) / 16) < 1e-6, `吃了 ${bites} 口`);
    assert.equal(b[4], 0.5, '蛋糕永远是半格高');
  }
});

test('门：占 3/16 厚，开合时换到另一侧', () => {
  const closed = modelCollisionBoxes(doorModel(Facing.NORTH, false))[0]!;
  assert.deepEqual(closed, [0, 0, 0, 1, 1, 3 / 16]);
  const open = modelCollisionBoxes(doorModel(Facing.NORTH, true))[0]!;
  // 开门后转 90°，贴到东边
  assert.deepEqual(open, [13 / 16, 0, 0, 1, 1, 1]);
});

test('火把与铁轨没有碰撞体积，但有可见的模型', () => {
  // solid=false 意味着物理完全不看它们
  assert.equal(TABLES.solid[registry.idOf(Blocks.TORCH)], 0);
  assert.equal(TABLES.solid[registry.idOf(Blocks.RAIL)], 0);
  // 但模型不能是空的，否则根本看不见
  assert.ok(modelCollisionBoxes(torchModel(null)).length > 0);
  assert.ok(modelCollisionBoxes(railModel()).length > 0);
  // 铁轨贴地，只有 1/16 高
  assert.equal(modelCollisionBoxes(railModel())[0]![4], 1 / 16);
});

test('贴墙火把移到那一侧，且仍在格子内', () => {
  for (const f of [Facing.NORTH, Facing.SOUTH, Facing.WEST, Facing.EAST]) {
    const b = modelCollisionBoxes(torchModel(f))[0]!;
    for (const v of b) assert.ok(v >= 0 && v <= 1, `贴墙火把越出格子：${b}`);
  }
  // 贴东墙的火把应该偏向西侧（火把在墙的这一面上）
  const east = modelCollisionBoxes(torchModel(Facing.EAST))[0]!;
  const west = modelCollisionBoxes(torchModel(Facing.WEST))[0]!;
  assert.ok(east[0]! < west[0]!, '贴东墙与贴西墙应偏向相反');
});

test('床占 9/16 高 —— 比半砖高，走不上去必须跳', () => {
  const b = modelCollisionBoxes(bedModel())[0]!;
  assert.equal(b[4], 9 / 16);
  assert.ok(b[4]! > 0.5, '床比半砖高');
});

test('玻璃板：无连接时是个十字，有连接时只伸向连接的方向', () => {
  const none = modelCollisionBoxes(paneModel([false, false, false, false]));
  assert.equal(none.length, 2, '孤立的玻璃板画成十字，否则薄得看不见');
  const north = modelCollisionBoxes(paneModel([true, false, false, false]));
  assert.equal(north.length, 1);
  assert.equal(north[0]![5], 9 / 16, '只伸到中心，不穿过整格');
});

// ---------------------------------------------------------------------------
// 全局不变量
// ---------------------------------------------------------------------------

test('所有方块的所有状态：碰撞盒都在格子内且非退化', () => {
  const m = TABLES.models;
  let checked = 0;
  for (let id = 1; id < TABLES.count; id++) {
    if (TABLES.defs[id] == null) continue;
    for (let meta = 0; meta < 16; meta++) {
      const model = modelIndexOf(m, id, meta);
      const start = m.modelBoxStart[model]!;
      const count = m.modelBoxCount[model]!;
      for (let i = 0; i < count; i++) {
        const o = (start + i) * 6;
        const b = [
          m.collisionBoxes[o]!, m.collisionBoxes[o + 1]!, m.collisionBoxes[o + 2]!,
          m.collisionBoxes[o + 3]!, m.collisionBoxes[o + 4]!, m.collisionBoxes[o + 5]!,
        ];
        const where = `${registry.get(id)?.name} meta=${meta} 盒${i}`;
        for (const v of b) assert.ok(v >= 0 && v <= 1, `${where} 越出格子：${b}`);
        assert.ok(b[3]! > b[0]!, `${where} X 方向退化`);
        assert.ok(b[4]! > b[1]!, `${where} Y 方向退化`);
        assert.ok(b[5]! > b[2]!, `${where} Z 方向退化`);
        checked++;
      }
    }
  }
  assert.ok(checked > 500, `抽查数太少：${checked}`);
});

test('模型去重生效：几十种方块 × 16 元数据只烘出少量模型', () => {
  const m = TABLES.models;
  // 绝大多数方块的 16 个状态都是同一个整格立方体
  assert.ok(m.modelCount < 120, `模型数 ${m.modelCount}，去重似乎没生效`);
  assert.ok(m.modelCount > 20, `模型数 ${m.modelCount}，非立方体方块可能没进表`);
  // 空气指向 0 号空模型
  assert.equal(modelIndexOf(m, 0, 0), 0);
  assert.equal(m.modelElementCount[0], 0);
});
