/**
 * 计划刻队列。
 *
 * 这套东西自己不做任何游戏行为，但流体、红石、沙子下落、作物生长全都建在它上面 ——
 * 所以它错了的话，M11 与 M13 会以"水流得不对"这种间接症状显形，
 * 追起来要绕一大圈。这里趁它还是孤立的，把顺序与去重钉死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScheduledTickQueue } from '../../src/server/world/scheduled-ticks.ts';
import { JavaRandom } from '../../src/core/rng/java-random.ts';

test('按到期时间出队，同刻按排队顺序', () => {
  const q = new ScheduledTickQueue();
  q.schedule(0, 1, 64, 0, 8, 10);
  q.schedule(0, 2, 64, 0, 8, 5);
  q.schedule(0, 3, 64, 0, 8, 5);   // 与上一条同刻，但排在后面
  q.schedule(0, 4, 64, 0, 8, 1);

  assert.equal(q.drainDue(0).length, 0, '一刻都还没到');
  assert.deepEqual(q.drainDue(1).map((e) => e.x), [4]);
  assert.deepEqual(q.drainDue(5).map((e) => e.x), [2, 3], '同刻要按排队顺序，不能反');
  assert.deepEqual(q.drainDue(10).map((e) => e.x), [1]);
  assert.equal(q.size, 0);
});

test('同一格同一方块只排一条 —— 少了这条，震荡电路会指数膨胀', () => {
  const q = new ScheduledTickQueue();
  assert.equal(q.schedule(0, 5, 5, 5, 55, 2), true);
  assert.equal(q.schedule(0, 5, 5, 5, 55, 2), false, '重复的要被丢掉');
  assert.equal(q.schedule(0, 5, 5, 5, 55, 9), false, '延迟不同也算重复，与 MC 一致');
  assert.equal(q.schedule(0, 5, 5, 5, 76, 2), true, '换个方块 id 就是另一条');
  assert.equal(q.size, 2);

  // 出队之后去重键要放开，否则同一格再也排不进第二次
  q.drainDue(100);
  assert.equal(q.schedule(100, 5, 5, 5, 55, 2), true, '出队后应该能重新排');
});

test('一刻最多处理 limit 条，剩下的留到下一刻', () => {
  const q = new ScheduledTickQueue();
  for (let i = 0; i < 50; i++) q.schedule(0, i, 64, 0, 8, 1);
  assert.equal(q.drainDue(1, 20).length, 20);
  assert.equal(q.size, 30, '没做完的要留着');
  assert.equal(q.drainDue(1, 20).length, 20);
  assert.equal(q.drainDue(1, 20).length, 10);
});

test('按区块范围取出与删除', () => {
  const q = new ScheduledTickQueue();
  q.schedule(0, 3, 64, 5, 8, 10);      // 区块 (0,0)
  q.schedule(0, 20, 64, 5, 8, 10);     // 区块 (1,0)
  q.schedule(0, 3, 70, 5, 9, 10);      // 区块 (0,0)，另一个方块

  assert.equal(q.entriesIn(0, 0, 15, 15).length, 2);
  assert.equal(q.removeIn(0, 0, 15, 15), 2, '卸载区块要带走它的计划刻');
  assert.equal(q.size, 1);
  assert.equal(q.entriesIn(16, 0, 31, 15).length, 1);
  // 删掉之后去重键也要清干净，不然区块重新加载时排不进去
  assert.equal(q.schedule(0, 3, 64, 5, 8, 10), true);
});

test('restore 保留原来的时间与序号，读档后顺序不变', () => {
  const q = new ScheduledTickQueue();
  q.restore({ x: 1, y: 0, z: 0, blockId: 8, time: 100, order: 7 });
  q.restore({ x: 2, y: 0, z: 0, blockId: 8, time: 100, order: 3 });
  assert.deepEqual(q.drainDue(100).map((e) => e.x), [2, 1], '序号小的先出');
  // 新排进来的序号必须大于读进来的最大值，否则会插到旧条目前面
  q.restore({ x: 9, y: 0, z: 0, blockId: 8, time: 200, order: 99 });
  q.schedule(190, 8, 0, 0, 8, 10);
  assert.deepEqual(q.drainDue(200).map((e) => e.x), [9, 8]);
});

test('模糊：随机排队与出队，结果始终按 (时间, 序号) 全序', () => {
  const rng = new JavaRandom(777);
  for (let round = 0; round < 100; round++) {
    const q = new ScheduledTickQueue();
    for (let i = 0; i < 200; i++) {
      q.schedule(0, rng.nextInt(1000), rng.nextInt(120), rng.nextInt(1000), 1 + rng.nextInt(5), 1 + rng.nextInt(50));
    }
    const out = q.drainDue(1000, 10000);
    for (let i = 1; i < out.length; i++) {
      const a = out[i - 1]!;
      const b = out[i]!;
      assert.ok(
        a.time < b.time || (a.time === b.time && a.order < b.order),
        `第 ${round} 轮：出队顺序不是全序（${a.time}/${a.order} 排在 ${b.time}/${b.order} 前面）`,
      );
    }
  }
});
