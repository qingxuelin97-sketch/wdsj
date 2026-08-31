/**
 * 每一种生物都得有模型。
 *
 * 这条检查与 `atlas.test.ts` 是同一类：**从"谁需要"出发，而不是
 * 从"谁有"出发**。加一种生物时很容易只加 `MOBS` 里的定义而忘了
 * `MODELS` 里那一条 —— 服务端照常刷它、客户端照常收到出生包，
 * 但画不出任何东西。症状是"世界里有一只看不见的怪在打我"，
 * 而没有任何报错。
 *
 * 加恶魂、火球、末影之眼、龙、水晶、玩家这六种的时候，模型每次都是
 * 靠记性补上的。这条测试把记性换成断言。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOBS, MobType, MOB_TYPE_COUNT, mobDefOf } from '../../src/content/mobs.ts';
import { mobModelOf, WOOL_COLORS } from '../../src/content/mob-models.ts';

test('每一种生物都有定义，编号连续无空洞', () => {
  const types = MOBS.map((m) => m.type).sort((a, b) => a - b);
  assert.equal(types.length, MOB_TYPE_COUNT,
    `MOBS 有 ${types.length} 条而 MOB_TYPE_COUNT 是 ${MOB_TYPE_COUNT}`);
  for (let i = 0; i < types.length; i++) {
    assert.equal(types[i], i, `生物编号该是 0..${MOB_TYPE_COUNT - 1} 连续的，第 ${i} 个是 ${types[i]}`);
    assert.ok(mobDefOf(i) !== null, `type ${i} 查不到定义`);
  }
});

test('每一种生物都有模型，且模型不是空的', () => {
  const missing: string[] = [];
  for (const def of MOBS) {
    const model = mobModelOf(def.type);
    if (model === null || model.boxes.length === 0) missing.push(`${def.name}(${def.type})`);
  }
  assert.deepEqual(missing, [],
    `这些生物画不出来（服务端会照常刷它们，客户端收到出生包却什么都不画）：${missing.join(', ')}`);
});

test('模型的盒子都有正的尺寸 —— 零厚度的盒子画出来是看不见的', () => {
  for (const def of MOBS) {
    const model = mobModelOf(def.type)!;
    for (const [i, b] of model.boxes.entries()) {
      assert.ok(b.w > 0 && b.h > 0 && b.d > 0,
        `${def.name} 的第 ${i} 个盒子有零或负的边长：${b.w}×${b.h}×${b.d}`);
    }
  }
});

test('模型大致装得进生物的碰撞盒 —— 差太多的话选中框会对不上身体', () => {
  // 一格 = 16 单位。允许超出一点（翅膀、触手、末影人的手臂本来就伸在外面），
  // 但不能离谱 —— 离谱说明单位搞错了（比如按格写了尺寸）
  for (const def of MOBS) {
    const model = mobModelOf(def.type)!;
    let maxY = 0;
    for (const b of model.boxes) maxY = Math.max(maxY, b.y + b.h);
    const boxHeight = def.height * 16;
    assert.ok(maxY <= boxHeight * 2.2,
      `${def.name} 的模型高 ${maxY} 单位，而碰撞盒只有 ${boxHeight} —— 单位是不是写成格了？`);
    assert.ok(maxY >= boxHeight * 0.25,
      `${def.name} 的模型高 ${maxY} 单位，碰撞盒 ${boxHeight} —— 模型太小，选中框会空一大块`);
  }
});

test('羊毛 16 色齐全，羊的第一个盒子拿它染色', () => {
  assert.equal(WOOL_COLORS.length, 16);
  for (const c of WOOL_COLORS) {
    assert.equal(c.length, 3);
    for (const v of c) assert.ok(v >= 0 && v <= 1, `颜色分量越界 ${v}`);
  }
  assert.ok((mobModelOf(MobType.SHEEP)?.boxes.length ?? 0) > 0);
});
