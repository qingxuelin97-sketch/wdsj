/**
 * 射线选中与挖掘时间。
 *
 * 挖掘时间是"下矿"这段玩法的节奏本身：徒手挖石头 7.5 秒、木镐 1.15 秒、
 * 钻石镐 0.25 秒 —— 这三个数决定了玩家什么时候会去做第一把镐。
 * 错了不会报错，只会让整个前期节奏变味。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChunkStore } from '../../src/core/world/block-view.ts';
import { packState, stateId } from '../../src/core/world/chunk.ts';
import { createBlockRegistry, Blocks } from '../../src/content/blocks.ts';
import { raycastBlocks } from '../../src/core/physics/raycast.ts';
import {
  breakProgressPerTick, ticksToBreak, canHarvest, crackStage,
  type BreakingTables, type HeldTool,
} from '../../src/core/block/breaking.ts';
import { ToolKind, ToolTier } from '../../src/core/block/types.ts';
import { TPS, TOOL_SPEED } from '../../src/core/constants.ts';

const registry = createBlockRegistry();
const TABLES = registry.getTables() as unknown as BreakingTables;
const STONE = packState(registry.idOf(Blocks.STONE));
const DIRT = packState(registry.idOf(Blocks.DIRT));

const pick = (tier: ToolTier, speed: number): HeldTool => ({ kind: ToolKind.PICKAXE, tier, speed });
const shovel = (tier: ToolTier, speed: number): HeldTool => ({ kind: ToolKind.SHOVEL, tier, speed });

function world(): ChunkStore {
  const store = new ChunkStore();
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) store.createChunk(cx, cz);
  return store;
}

// ---------------------------------------------------------------------------
// 射线
// ---------------------------------------------------------------------------

test('射线沿 +Z 命中最近的方块，法线朝向射线来的一侧', () => {
  const w = world();
  w.setState(0, 64, 5, STONE);
  w.setState(0, 64, 8, STONE); // 更远的一块，不该被选中
  const hit = raycastBlocks(w, 0.5, 64.5, 0.5, 0, 0, 1, 10);
  assert.ok(hit !== null, '应该命中');
  assert.deepEqual([hit.x, hit.y, hit.z], [0, 64, 5]);
  assert.deepEqual([hit.nx, hit.ny, hit.nz], [0, 0, -1], '法线应指向 −Z（射线来的那侧）');
  assert.ok(Math.abs(hit.distance - 4.5) < 1e-9, `距离应为 4.5，实得 ${hit.distance}`);
});

test('射线能命中各个面 —— 法线决定放置方向', () => {
  const w = world();
  w.setState(3, 64, 3, STONE);
  const cases: [number[], number[], number[]][] = [
    // 起点、方向、期望法线
    [[3.5, 64.5, 0.5], [0, 0, 1], [0, 0, -1]],
    [[3.5, 64.5, 6.5], [0, 0, -1], [0, 0, 1]],
    [[0.5, 64.5, 3.5], [1, 0, 0], [-1, 0, 0]],
    [[6.5, 64.5, 3.5], [-1, 0, 0], [1, 0, 0]],
    [[3.5, 68.5, 3.5], [0, -1, 0], [0, 1, 0]],
    [[3.5, 60.5, 3.5], [0, 1, 0], [0, -1, 0]],
  ];
  for (const [origin, dir, normal] of cases) {
    const hit = raycastBlocks(w, origin[0]!, origin[1]!, origin[2]!, dir[0]!, dir[1]!, dir[2]!, 10);
    assert.ok(hit !== null, `从 ${origin} 朝 ${dir} 应命中`);
    assert.deepEqual([hit.x, hit.y, hit.z], [3, 64, 3], `从 ${origin} 命中的格子`);
    assert.deepEqual([hit.nx, hit.ny, hit.nz], normal, `从 ${origin} 朝 ${dir} 的法线`);
  }
});

test('斜射不会穿过薄墙 —— 这正是要用 DDA 而不是定步长采样的原因', () => {
  const w = world();
  // z=5 处一整面墙
  for (let y = 60; y < 70; y++) for (let x = -8; x < 8; x++) w.setState(x, y, 5, STONE);
  // 扫一圈**确实指向墙**的方向：dz 始终为正且占主导，
  // 让射线在还没跑出墙的 y/x 范围之前一定会到达 z=5
  let checked = 0;
  for (let i = 0; i < 64; i++) {
    const yaw = (i / 64 - 0.5) * 0.6;    // ±0.3 弧度
    const pitch = ((i * 7) % 64) / 64 * 0.6 - 0.3;
    const dx = Math.sin(yaw) * Math.cos(pitch);
    const dy = Math.sin(pitch);
    const dz = Math.cos(yaw) * Math.cos(pitch);
    const hit = raycastBlocks(w, 0.5, 64.5, 0.5, dx, dy, dz, 12);
    assert.ok(hit !== null, `角度 ${i}（${dx.toFixed(2)},${dy.toFixed(2)},${dz.toFixed(2)}）应被墙挡住`);
    assert.equal(hit.z, 5, `角度 ${i} 命中了 z=${hit.z}，应为 5 —— 说明射线从墙缝里漏过去了`);
    checked++;
  }
  assert.equal(checked, 64);
});

test('超出距离返回 null；打进未加载区块也返回 null', () => {
  const w = world();
  w.setState(0, 64, 9, STONE);
  assert.equal(raycastBlocks(w, 0.5, 64.5, 0.5, 0, 0, 1, 5), null, '5 格够不到 9 格外的方块');
  assert.ok(raycastBlocks(w, 0.5, 64.5, 0.5, 0, 0, 1, 12) !== null, '12 格够得到');
  // 朝未加载的方向
  assert.equal(raycastBlocks(w, 0.5, 64.5, 0.5, 1, 0, 0, 100), null, '打进未加载区块应返回 null');
});

test('起点就在方块内部时立刻命中 —— 贴着墙站也要能挖', () => {
  const w = world();
  w.setState(0, 64, 0, STONE);
  const hit = raycastBlocks(w, 0.5, 64.5, 0.5, 0, 0, 1, 5);
  assert.ok(hit !== null);
  assert.deepEqual([hit.x, hit.y, hit.z], [0, 64, 0]);
  assert.equal(hit.distance, 0);
});

// ---------------------------------------------------------------------------
// 挖掘
// ---------------------------------------------------------------------------

test('挖掘时间对上 MC 1.0 —— 徒手石头 7.5 秒，木镐 1.15 秒，钻石镐 0.25 秒', () => {
  const stone = registry.idOf(Blocks.STONE);
  const bare = ticksToBreak(TABLES, stone, null) / TPS;
  const wood = ticksToBreak(TABLES, stone, pick(ToolTier.WOOD, TOOL_SPEED.wood)) / TPS;
  const diamond = ticksToBreak(TABLES, stone, pick(ToolTier.DIAMOND, TOOL_SPEED.diamond)) / TPS;

  assert.ok(Math.abs(bare - 7.5) < 0.06, `徒手挖石头 ${bare.toFixed(2)} 秒，MC 是 7.5`);
  assert.ok(Math.abs(wood - 1.15) < 0.06, `木镐挖石头 ${wood.toFixed(2)} 秒，MC 是 1.15`);
  assert.ok(Math.abs(diamond - 0.25) < 0.06, `钻石镐挖石头 ${diamond.toFixed(2)} 秒，MC 是 0.25`);
});

test('工具不对口只快在"能不能收获"上 —— 铲子挖石头和徒手一样慢', () => {
  const stone = registry.idOf(Blocks.STONE);
  const bare = ticksToBreak(TABLES, stone, null);
  const withShovel = ticksToBreak(TABLES, stone, shovel(ToolTier.DIAMOND, TOOL_SPEED.diamond));
  assert.equal(withShovel, bare, '钻石铲挖石头不该比徒手快');
  assert.equal(canHarvest(TABLES, stone, shovel(ToolTier.DIAMOND, TOOL_SPEED.diamond)), false,
    '铲子挖石头不该掉落');
});

test('挖得动 ≠ 收得到 —— 徒手挖得动石头，但什么都不掉', () => {
  const stone = registry.idOf(Blocks.STONE);
  assert.ok(breakProgressPerTick(TABLES, stone, null) > 0, '徒手也挖得动石头');
  assert.equal(canHarvest(TABLES, stone, null), false, '徒手挖石头不掉落');
  assert.equal(canHarvest(TABLES, stone, pick(ToolTier.WOOD, TOOL_SPEED.wood)), true, '木镐能收获石头');
});

test('钻石矿要铁镐以上 —— 石镐挖得动但拿不到', () => {
  const ore = registry.idOf(Blocks.DIAMOND_ORE);
  assert.equal(canHarvest(TABLES, ore, pick(ToolTier.STONE, TOOL_SPEED.stone)), false, '石镐拿不到钻石');
  assert.equal(canHarvest(TABLES, ore, pick(ToolTier.IRON, TOOL_SPEED.iron)), true, '铁镐可以');
  assert.ok(breakProgressPerTick(TABLES, ore, pick(ToolTier.STONE, TOOL_SPEED.stone)) > 0, '石镐挖得动');
});

test('泥土用铲子快，且徒手也能收获', () => {
  const dirt = registry.idOf(Blocks.DIRT);
  const bare = ticksToBreak(TABLES, dirt, null);
  const withShovel = ticksToBreak(TABLES, dirt, shovel(ToolTier.IRON, TOOL_SPEED.iron));
  assert.ok(withShovel < bare, `铁铲 ${withShovel} tick 应快过徒手 ${bare} tick`);
  assert.equal(canHarvest(TABLES, dirt, null), true, '泥土徒手就能收获');
  void stateId(DIRT);
});

test('基岩挖不动', () => {
  const bedrock = registry.idOf(Blocks.BEDROCK);
  assert.equal(breakProgressPerTick(TABLES, bedrock, pick(ToolTier.DIAMOND, TOOL_SPEED.diamond)), 0);
  assert.equal(ticksToBreak(TABLES, bedrock, pick(ToolTier.DIAMOND, TOOL_SPEED.diamond)), Infinity);
});

test('悬空与水下各慢五倍', () => {
  const stone = registry.idOf(Blocks.STONE);
  const tool = pick(ToolTier.IRON, TOOL_SPEED.iron);
  const normal = breakProgressPerTick(TABLES, stone, tool, true, false);
  const airborne = breakProgressPerTick(TABLES, stone, tool, false, false);
  const underwater = breakProgressPerTick(TABLES, stone, tool, true, true);
  assert.ok(Math.abs(normal / airborne - 5) < 1e-6, `悬空应慢 5 倍，实得 ${(normal / airborne).toFixed(2)}`);
  assert.ok(Math.abs(normal / underwater - 5) < 1e-6, `水下应慢 5 倍，实得 ${(normal / underwater).toFixed(2)}`);
});

test('裂纹分 10 级', () => {
  assert.equal(crackStage(0), -1, '没开始挖时没有裂纹');
  assert.equal(crackStage(0.05), 0);
  assert.equal(crackStage(0.5), 5);
  assert.equal(crackStage(0.99), 9);
  assert.equal(crackStage(1), 9, '满进度也停在第 9 级');
});
