/**
 * 容器点击语义。
 *
 * 这套逻辑写错不会崩，只会让玩家偶尔丢东西 ——
 * 而"我明明有 64 个煤，怎么变成 63 个了"是永远查不出来的那种 bug。
 * 所以每一条语义都单独钉住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Container, SlotKind, ClickButton, type SlotRegion,
} from '../../src/core/inventory/container.ts';
import { makeStack, isEmpty, copyStack, type ItemStack } from '../../src/core/item/item-def.ts';

const STONE = 1;
const DIRT = 3;
const SWORD = 267; // 不可叠

const maxStackOf = (id: number): number => (id === SWORD ? 1 : 64);

/** 两片区域：0 = 主存放，1 = 快捷栏。Shift 在两者之间互搬 */
function twoRegions(): SlotRegion[] {
  return [
    { start: 0, count: 9, kind: SlotKind.STORAGE, shiftTargets: [1] },
    { start: 9, count: 9, kind: SlotKind.STORAGE, shiftTargets: [0] },
  ];
}

function makeContainer(): Container {
  return new Container(18, twoRegions(), maxStackOf);
}

const set = (c: Container, slot: number, id: number, count: number, damage = 0): void => {
  const s = c.slots[slot]!;
  s.id = id; s.count = count; s.damage = damage;
};

const show = (s: ItemStack): string => (isEmpty(s) ? '空' : `${s.id}×${s.count}`);

// ---------------------------------------------------------------------------
// 左键
// ---------------------------------------------------------------------------

test('左键空手点一堆：全部拿起', () => {
  const c = makeContainer();
  set(c, 0, STONE, 32);
  c.click(0, ClickButton.LEFT, false);
  assert.equal(show(c.cursor), '1×32');
  assert.ok(isEmpty(c.slots[0]!), '原格应清空');
});

test('左键持物点空槽：全部放下', () => {
  const c = makeContainer();
  set(c, 0, STONE, 32);
  c.click(0, ClickButton.LEFT, false);
  c.click(5, ClickButton.LEFT, false);
  assert.ok(isEmpty(c.cursor), '手上应清空');
  assert.equal(show(c.slots[5]!), '1×32');
});

test('左键持物点同类：尽量合并，放不下的**留在手上**', () => {
  const c = makeContainer();
  set(c, 0, STONE, 40);
  set(c, 1, STONE, 40);
  c.click(0, ClickButton.LEFT, false);   // 手上 40
  c.click(1, ClickButton.LEFT, false);   // 目标 40，最多 64
  assert.equal(show(c.slots[1]!), '1×64', '目标应补满');
  assert.equal(show(c.cursor), '1×16', '放不下的 16 个必须还在手上，不能凭空消失');
});

test('左键持物点异类：交换', () => {
  const c = makeContainer();
  set(c, 0, STONE, 10);
  set(c, 1, DIRT, 5);
  c.click(0, ClickButton.LEFT, false);
  c.click(1, ClickButton.LEFT, false);
  assert.equal(show(c.slots[1]!), '1×10');
  assert.equal(show(c.cursor), '3×5');
});

test('左键点满格的同类：什么都不该发生', () => {
  const c = makeContainer();
  set(c, 0, STONE, 20);
  set(c, 1, STONE, 64);
  c.click(0, ClickButton.LEFT, false);
  const changed = c.click(1, ClickButton.LEFT, false);
  assert.equal(changed, false);
  assert.equal(show(c.cursor), '1×20', '手上的东西不能被吞掉');
  assert.equal(show(c.slots[1]!), '1×64');
});

// ---------------------------------------------------------------------------
// 右键
// ---------------------------------------------------------------------------

test('右键空手点一堆：拿一半，向上取整', () => {
  const c = makeContainer();
  set(c, 0, STONE, 7);
  c.click(0, ClickButton.RIGHT, false);
  assert.equal(show(c.cursor), '1×4', '7 个拿一半是 4');
  assert.equal(show(c.slots[0]!), '1×3');
});

test('右键点单个物品：整个拿走', () => {
  const c = makeContainer();
  set(c, 0, STONE, 1);
  c.click(0, ClickButton.RIGHT, false);
  assert.equal(show(c.cursor), '1×1');
  assert.ok(isEmpty(c.slots[0]!));
});

test('右键持物：一次放一个', () => {
  const c = makeContainer();
  set(c, 0, STONE, 10);
  c.click(0, ClickButton.LEFT, false);
  c.click(5, ClickButton.RIGHT, false);
  c.click(5, ClickButton.RIGHT, false);
  assert.equal(show(c.slots[5]!), '1×2');
  assert.equal(show(c.cursor), '1×8');
});

test('右键往满格里放：放不进去', () => {
  const c = makeContainer();
  set(c, 0, STONE, 10);
  set(c, 5, STONE, 64);
  c.click(0, ClickButton.LEFT, false);
  const changed = c.click(5, ClickButton.RIGHT, false);
  assert.equal(changed, false);
  assert.equal(show(c.cursor), '1×10');
});

// ---------------------------------------------------------------------------
// 不可叠的物品
// ---------------------------------------------------------------------------

test('工具不可叠：两把剑不会合成一堆', () => {
  const c = makeContainer();
  set(c, 0, SWORD, 1);
  set(c, 1, SWORD, 1);
  c.click(0, ClickButton.LEFT, false);
  c.click(1, ClickButton.LEFT, false);
  // 叠不上就应该交换，而不是变成一格 2 把
  assert.equal(show(c.slots[1]!), `${SWORD}×1`);
  assert.equal(show(c.cursor), `${SWORD}×1`);
});

test('耐久不同的同种工具不能合并 —— 否则会凭空修好一把', () => {
  const c = makeContainer();
  set(c, 0, SWORD, 1, 100);
  set(c, 1, SWORD, 1, 5);
  c.click(0, ClickButton.LEFT, false);
  c.click(1, ClickButton.LEFT, false);
  assert.equal(c.slots[1]!.damage, 100, '交换之后耐久要跟着走');
  assert.equal(c.cursor.damage, 5);
});

// ---------------------------------------------------------------------------
// Shift 点击
// ---------------------------------------------------------------------------

test('Shift 点击把整堆搬到另一片区域', () => {
  const c = makeContainer();
  set(c, 0, STONE, 30);
  c.click(0, ClickButton.LEFT, true);
  assert.ok(isEmpty(c.slots[0]!), '源格应清空');
  assert.equal(show(c.slots[9]!), '1×30', '应搬到第二片区域的第一个空格');
});

test('Shift 搬运**先补满同类再占空格**', () => {
  const c = makeContainer();
  set(c, 0, STONE, 30);
  set(c, 9, DIRT, 1);     // 第一个空位被别的东西占着
  set(c, 10, STONE, 50);  // 这里有半格同类
  c.click(0, ClickButton.LEFT, true);
  assert.equal(show(c.slots[10]!), '1×64', '应先把同类补满');
  assert.equal(show(c.slots[11]!), '1×16', '剩下的才去找空格');
  assert.ok(isEmpty(c.slots[0]!));
});

test('Shift 搬不下时留在原处，不会丢', () => {
  const c = makeContainer();
  set(c, 0, STONE, 64);
  for (let i = 9; i < 18; i++) set(c, i, DIRT, 64); // 目标区域塞满别的东西
  const changed = c.click(0, ClickButton.LEFT, true);
  assert.equal(changed, false);
  assert.equal(show(c.slots[0]!), '1×64', '搬不动就该原样留着');
});

// ---------------------------------------------------------------------------
// 产物槽
// ---------------------------------------------------------------------------

function craftContainer(): { c: Container; taken: ItemStack[] } {
  const regions: SlotRegion[] = [
    { start: 0, count: 4, kind: SlotKind.INPUT, shiftTargets: [2] },
    { start: 4, count: 1, kind: SlotKind.OUTPUT, shiftTargets: [2] },
    { start: 5, count: 9, kind: SlotKind.STORAGE, shiftTargets: [0] },
  ];
  const c = new Container(14, regions, maxStackOf);
  const taken: ItemStack[] = [];
  c.onTakeOutput = (_slot, t) => { taken.push(t); };
  return { c, taken };
}

test('产物槽只能取不能放', () => {
  const { c } = craftContainer();
  set(c, 5, STONE, 10);
  c.click(5, ClickButton.LEFT, false); // 手上拿着石头
  const changed = c.click(4, ClickButton.LEFT, false);
  assert.equal(changed, false, '不该能把东西放进产物槽');
  assert.equal(show(c.cursor), '1×10');
  assert.ok(isEmpty(c.slots[4]!));
});

test('取走产物时才回调扣材料', () => {
  const { c, taken } = craftContainer();
  set(c, 4, DIRT, 4);
  assert.equal(taken.length, 0, '还没取走就不该扣材料');
  c.click(4, ClickButton.LEFT, false);
  assert.equal(taken.length, 1);
  assert.equal(show(taken[0]!), '3×4');
  assert.equal(show(c.cursor), '3×4');
});

test('手上拿着同类时取产物会叠上去；拿着异类则取不走', () => {
  const { c } = craftContainer();
  set(c, 4, DIRT, 4);
  set(c, 5, DIRT, 10);
  c.click(5, ClickButton.LEFT, false);      // 手上 10 个泥土
  c.click(4, ClickButton.LEFT, false);
  assert.equal(show(c.cursor), '3×14', '应该叠起来');

  const { c: c2 } = craftContainer();
  set(c2, 4, DIRT, 4);
  set(c2, 5, STONE, 10);
  c2.click(5, ClickButton.LEFT, false);     // 手上是石头
  const changed = c2.click(4, ClickButton.LEFT, false);
  assert.equal(changed, false, '手上拿着别的东西就取不走产物');
});

// ---------------------------------------------------------------------------
// 拾取
// ---------------------------------------------------------------------------

test('addItem 塞得下就全塞，塞不下返回剩余', () => {
  const c = makeContainer();
  // 9 格的区域塞 100 个石头绰绰有余：占两格（64 + 36），一个都不剩
  assert.equal(c.addItem(makeStack(STONE, 100)), 0, '应该全塞得下');
  assert.equal(c.countOf(STONE), 100);
  assert.equal(c.slots[0]!.count, 64, '第一格应该塞满');
  assert.equal(c.slots[1]!.count, 36);

  const full = makeContainer();
  for (let i = 0; i < 9; i++) set(full, i, DIRT, 64);
  const left = full.addItem(makeStack(STONE, 10), 0);
  assert.equal(left, 10, '区域塞满时应原样退回');
});

// ---------------------------------------------------------------------------
// 附魔要跟着物品走
//
// 这一组盯的是同一类 bug：copyStack 只搬 id/count/damage，
// 附魔那个可选字段被漏在原地。表现是玩家在物品栏里把附了魔的剑
// **挪一下位置**，附魔就没了 —— 剑还在，图标一模一样，只是不再发光，
// 伤害也掉回基础值。没有任何报错，玩家只会觉得"我记错了吧"。
// ---------------------------------------------------------------------------

/** 一把锋利 V + 火焰附加 II 的剑 */
function enchantedSword(): ItemStack {
  const s = makeStack(SWORD, 1, 12);
  s.enchantments = [{ id: 16, level: 5 }, { id: 20, level: 2 }];
  return s;
}

const putEnchanted = (c: Container, slot: number): void => {
  copyStack(enchantedSword(), c.slots[slot]!);
};

const enchOf = (s: ItemStack): string => (s.enchantments ?? []).map((e) => `${e.id}/${e.level}`).join(',');

test('左键拿起再放下附了魔的剑：附魔还在', () => {
  const c = makeContainer();
  putEnchanted(c, 0);

  c.click(0, ClickButton.LEFT, false);
  assert.equal(enchOf(c.cursor), '16/5,20/2', '拿在手上时附魔就得跟过来');

  c.click(5, ClickButton.LEFT, false);
  assert.equal(enchOf(c.slots[5]!), '16/5,20/2', '放到新格子里附魔要还在');
  assert.equal(c.slots[5]!.damage, 12, '耐久也别丢');
  assert.equal(enchOf(c.cursor), '', '手上应该空了');
});

test('右键拿单件附魔剑：整件带走，附魔跟着', () => {
  const c = makeContainer();
  putEnchanted(c, 0);
  c.click(0, ClickButton.RIGHT, false);
  assert.ok(isEmpty(c.slots[0]!), '单件右键是整件拿走');
  assert.equal(enchOf(c.cursor), '16/5,20/2');
});

test('右键往空格里放一件附魔剑：附魔跟着', () => {
  const c = makeContainer();
  copyStack(enchantedSword(), c.cursor);
  c.click(3, ClickButton.RIGHT, false);
  assert.equal(enchOf(c.slots[3]!), '16/5,20/2');
});

test('附魔剑与普通物品交换位置：两边都不串味', () => {
  const c = makeContainer();
  putEnchanted(c, 0);
  set(c, 4, STONE, 20);

  c.click(0, ClickButton.LEFT, false);   // 拿起剑
  c.click(4, ClickButton.LEFT, false);   // 点石头 -> 异类交换
  assert.equal(enchOf(c.slots[4]!), '16/5,20/2', '剑落到 4 号格，附魔还在');
  assert.equal(c.cursor.id, STONE, '手上换成了石头');
  assert.equal(enchOf(c.cursor), '', '石头身上不该沾到附魔');
});

test('搬走附魔剑后原格子不留幽灵附魔', () => {
  const c = makeContainer();
  // 这里**直接**给槽位挂上附魔，不经过 copyStack ——
  // 要测的是 clearStack 有没有把这个字段一起清掉
  const slot = c.slots[0]!;
  slot.id = SWORD; slot.count = 1; slot.damage = 0;
  slot.enchantments = [{ id: 16, level: 5 }];

  c.click(0, ClickButton.LEFT, false);   // 拿走，0 号格走 clearStack
  assert.equal(enchOf(c.slots[0]!), '', '清空过的格子身上不该还挂着附魔');

  // 而这个"幽灵"最伤人的地方是它会被下一件普通物品捡走
  c.cursor.id = 0; c.cursor.count = 0; delete c.cursor.enchantments;
  set(c, 0, STONE, 1);
  c.click(0, ClickButton.LEFT, false);
  assert.equal(enchOf(c.cursor), '', '一堆石头不该凭空带上锋利');
});

test('两把附魔剑不会合并 —— 合并等于烧掉一份附魔', () => {
  const c = makeContainer();
  putEnchanted(c, 0);
  putEnchanted(c, 1);
  c.click(0, ClickButton.LEFT, false);
  c.click(1, ClickButton.LEFT, false);
  // 不能合并，只能交换：两把剑仍然是两把
  assert.equal(c.slots[1]!.count, 1);
  assert.equal(enchOf(c.slots[1]!), '16/5,20/2');
  assert.equal(c.cursor.count, 1);
  assert.equal(enchOf(c.cursor), '16/5,20/2');
});

test('附魔是深拷：改了一处不会动到另一处', () => {
  const c = makeContainer();
  putEnchanted(c, 0);
  c.click(0, ClickButton.LEFT, false);
  c.click(5, ClickButton.LEFT, false);
  putEnchanted(c, 0);
  c.slots[0]!.enchantments![0]!.level = 1;
  assert.equal(c.slots[5]!.enchantments![0]!.level, 5, '两个格子不该共用同一个数组');
});
