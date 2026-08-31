/**
 * 附了魔的物品在界面上长什么样。
 *
 * 这一层最容易出的错**不是**颜色难看，而是三件在截图里看不出来的事：
 *
 *   1. 摘要解错了 —— 等级和条数是同一个 int32 的不同字节，错一位就是
 *      "锋利 I" 显示成 "锋利 0"，而画面照样有光效，看着完全正常；
 *   2. 光效漏出图标框 —— 隔壁那把没附魔的剑跟着一起闪；
 *   3. 动画不是帧号驱动的 —— freeze() 停不住，截图取样永远等不到
 *      "连续两帧一样"（clock.ts 顶部那段说的就是这个坑）。
 *
 * 所以这里断言的是**结构**：解出来的数、矩形的位置、同一帧号可复现。
 * 一个颜色都不比 —— 那种测试改一次配色就红，而配色本来就该能随手调。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeEnchantSummary, enchantSummaryOf, enchantTooltipFor,
  romanLevel, enchantDisplayName, itemDisplayName,
} from '../../src/client/ui/item-enchant.ts';
import { drawEnchantGlint } from '../../src/client/ui/item-glint.ts';
import { drawItemTooltip } from '../../src/client/ui/item-tooltip.ts';
import { decodeSlots } from '../../src/client/ui/ui-controller.ts';
import { drawWindow, layoutFor, type DrawContext } from '../../src/client/ui/inventory-screen.ts';
import { WindowKind } from '../../src/core/net/packets.ts';
import { Enchantment } from '../../src/core/item/enchantment.ts';
import { emptyStack, makeStack, type ItemStack } from '../../src/core/item/item-def.ts';

const IRON_SWORD = 267;

/** 按服务端 syncInventory 的编码拼一个摘要字 */
function summaryWord(total: number, id: number, level: number): number {
  return (total & 0xff) | ((id & 0xff) << 8) | ((level & 0xff) << 16);
}

interface Call { kind: string; args: number[] }

/** 只实现被测代码用到的那几个方法，把调用原样记下来 */
function fakeUi(): { calls: Call[]; ui: never } {
  const calls: Call[] = [];
  const texts: string[] = [];
  const ui = {
    rect: (...args: number[]) => { calls.push({ kind: 'rect', args }); },
    sprite: (...args: number[]) => { calls.push({ kind: 'sprite', args }); },
    number: (...args: number[]) => { calls.push({ kind: 'number', args }); },
    text: (s: string, ...args: number[]) => {
      texts.push(s);
      calls.push({ kind: `text:${s}`, args });
    },
    begin: () => {},
    texts,
  };
  return { calls, ui: ui as never };
}

/** 把一次绘制序列化成字符串，用来比"两次画得一样不一样" */
function snapshot(calls: readonly Call[]): string {
  return calls.map((c) => `${c.kind}(${c.args.join(',')})`).join('\n');
}

// ---------------------------------------------------------------------------
// 摘要解码
// ---------------------------------------------------------------------------

test('附魔摘要：条数 / 主附魔 id / 等级各就各位', () => {
  const s = decodeEnchantSummary(summaryWord(1, Enchantment.SHARPNESS, 5));
  assert.notEqual(s, null);
  assert.deepEqual(s, { total: 1, id: Enchantment.SHARPNESS, level: 5 });

  // 三个字段各自跑到 0xff 也不能互相串位
  const wide = decodeEnchantSummary(summaryWord(0xff, 0xff, 0xff));
  assert.deepEqual(wide, { total: 0xff, id: 0xff, level: 0xff });
});

test('没附魔的格子解不出摘要 —— 光效与提示条都从这里返回', () => {
  assert.equal(decodeEnchantSummary(0), null);
  // 条数为 0 却又非 0 的摘要不该出现，出现了也当没附魔处理，
  // 而不是画一个"零条附魔"的光效
  assert.equal(decodeEnchantSummary(summaryWord(0, Enchantment.SHARPNESS, 3)), null);
});

test('decodeSlots 把摘要挂到对应的那一格上，普通格子干干净净', () => {
  const buf = new Int32Array([
    IRON_SWORD, 1, 0, summaryWord(2, Enchantment.UNBREAKING, 3),
    IRON_SWORD, 1, 0, 0,
  ]);
  const slots = decodeSlots(new Uint8Array(buf.buffer));
  assert.equal(slots.length, 2);

  const ench = enchantSummaryOf(slots[0]!);
  assert.deepEqual(ench, { total: 2, id: Enchantment.UNBREAKING, level: 3 });
  // ItemStack 上仍然只有**第一条**，因为协议只发了第一条
  assert.deepEqual(slots[0]!.enchantments, [{ id: Enchantment.UNBREAKING, level: 3 }]);

  assert.equal(enchantSummaryOf(slots[1]!), null);
  assert.equal(slots[1]!.enchantments, undefined);
});

// ---------------------------------------------------------------------------
// 文字
// ---------------------------------------------------------------------------

test('罗马数字只做 I..V，越界退回十进制', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(romanLevel), ['I', 'II', 'III', 'IV', 'V']);
  // 1.0 的等级上限就是 V。真出现 0 或 6 说明数据出了问题，
  // 这时显示一个能和数据对上的数字比画一个错的罗马数字有用
  assert.equal(romanLevel(6), '6');
  assert.equal(romanLevel(0), '0');
});

test('附魔名取自 core 那张表，不另抄一份', () => {
  assert.equal(enchantDisplayName(Enchantment.SHARPNESS), 'Sharpness');
  assert.equal(enchantDisplayName(Enchantment.UNBREAKING), 'Unbreaking');
  assert.equal(enchantDisplayName(Enchantment.SILK_TOUCH), 'Silk Touch');
  // 小连词保持小写，与 MC 的 "Bane of Arthropods" 一致
  assert.equal(enchantDisplayName(Enchantment.BANE_OF_ARTHROPODS), 'Bane of Arthropods');
  // 不认识的 id 也得给个能排查的东西，不能崩
  assert.equal(enchantDisplayName(200), 'Enchantment 200');
});

test('物品名', () => {
  assert.equal(itemDisplayName(IRON_SWORD), 'Iron Sword');
  assert.equal(itemDisplayName(999), '#999');
});

test('提示文字：只有一条时就写这一条', () => {
  const stack = decodeSlots(new Uint8Array(
    new Int32Array([IRON_SWORD, 1, 0, summaryWord(1, Enchantment.SHARPNESS, 5)]).buffer,
  ))[0]!;
  assert.deepEqual(enchantTooltipFor(stack), {
    title: 'Iron Sword',
    lines: ['Sharpness V'],
  });
});

test('提示文字：多于一条时只报总数，**不编造**其余几条', () => {
  const stack = decodeSlots(new Uint8Array(
    new Int32Array([IRON_SWORD, 1, 0, summaryWord(3, Enchantment.SHARPNESS, 5)]).buffer,
  ))[0]!;
  const tip = enchantTooltipFor(stack)!;
  assert.deepEqual(tip.lines, ['Sharpness V', '3 Enchantments']);
  // 协议里只发了第一条，所以第二、三条叫什么客户端根本不知道。
  // 万一哪天这里冒出了第二个附魔名，那一定是有人在编
  const all = tip.lines.join(' ');
  for (const name of ['Unbreaking', 'Fire Aspect', 'Looting', 'Knockback']) {
    assert.equal(all.includes(name), false, `不该凭空出现 ${name}`);
  }
});

test('提示条真的把那两行字画出来了', () => {
  const { calls, ui } = fakeUi();
  drawItemTooltip(ui, { title: 'Iron Sword', lines: ['Sharpness V'] }, 100, 100);
  const drawn = calls.filter((c) => c.kind.startsWith('text:')).map((c) => c.kind.slice(5));
  assert.deepEqual(drawn, ['Iron Sword', 'Sharpness V']);
});

test('提示条不许跑出屏幕 —— 悬停最右下角那格时也一样', () => {
  const { calls, ui } = fakeUi();
  drawItemTooltip(ui, { title: 'Diamond Pickaxe', lines: ['Efficiency V', '3 Enchantments'] }, 318, 238);
  const rects = calls.filter((c) => c.kind === 'rect');
  assert.ok(rects.length > 0);
  for (const r of rects) {
    const [x, y, w, h] = r.args as [number, number, number, number];
    assert.ok(x >= 0 && y >= 0, `提示条跑到左上外面了：${x},${y}`);
    assert.ok(x + w <= 320 && y + h <= 240, `提示条跑到右下外面了：${x + w},${y + h}`);
  }
});

// ---------------------------------------------------------------------------
// 光效
// ---------------------------------------------------------------------------

test('光效全部落在图标那 16×16 之内 —— 漏出去就是隔壁格子跟着闪', () => {
  // 整整一个周期挨帧查。斜带是分段画的，只查一帧的话正好错过越界的那一级
  for (let frame = 0; frame < 200; frame++) {
    const { calls, ui } = fakeUi();
    drawEnchantGlint(ui, 40, 60, 16, frame);
    assert.ok(calls.length > 0, `第 ${frame} 帧什么都没画`);
    for (const c of calls) {
      const [x, y, w, h] = c.args as [number, number, number, number];
      assert.ok(w > 0 && h > 0, `第 ${frame} 帧画了个空矩形`);
      assert.ok(x >= 40 && y >= 60, `第 ${frame} 帧漏到左上：${x},${y}`);
      assert.ok(x + w <= 56 && y + h <= 76, `第 ${frame} 帧漏到右下：${x + w},${y + h}`);
    }
  }
});

test('光效由帧号驱动：帧号一样画得一样，帧号不同画得不同', () => {
  const at = (frame: number): string => {
    const { calls, ui } = fakeUi();
    drawEnchantGlint(ui, 0, 0, 16, frame);
    return snapshot(calls);
  };
  // 同一帧号必须逐像素可复现，否则 __mc.freeze() 之后
  // "连续两帧一样"永远等不到，截图回归就废了
  assert.equal(at(30), at(30));
  assert.notEqual(at(0), at(30));
  assert.notEqual(at(30), at(60));
  // 一个周期之后回到原处 —— 相位确实是取模出来的，不是一路涨
  assert.equal(at(7), at(7 + 96 * 61 * 72));
});

// ---------------------------------------------------------------------------
// 接到界面里
// ---------------------------------------------------------------------------

const CTX: DrawContext = { iconLayer: () => 3, maxStack: () => 64 };

/** 把一格东西放进背包界面第 9 格（玩家主存放的第一格）画一帧 */
function windowSnapshot(stack: ItemStack, frame: number, hovered = -1): string {
  const layout = layoutFor(WindowKind.INVENTORY);
  const slots: ItemStack[] = Array.from({ length: 41 }, () => emptyStack());
  slots[9] = stack;
  const { calls, ui } = fakeUi();
  drawWindow(ui, WindowKind.INVENTORY, layout, slots, emptyStack(), hovered, CTX, 30, 40, frame);
  return snapshot(calls);
}

test('没附魔的物品不走光效那条路 —— 它画出来跟帧号完全无关', () => {
  const plain = makeStack(IRON_SWORD, 1);
  assert.equal(enchantSummaryOf(plain), null);
  // 帧号变了画面一点没变，说明确实一个动画元素都没画
  assert.equal(windowSnapshot(plain, 0), windowSnapshot(plain, 37));
});

test('附了魔的物品会动，而且比没附魔的多画了东西', () => {
  const ench = decodeSlots(new Uint8Array(
    new Int32Array([IRON_SWORD, 1, 0, summaryWord(1, Enchantment.SHARPNESS, 5)]).buffer,
  ))[0]!;
  const plain = makeStack(IRON_SWORD, 1);
  assert.notEqual(windowSnapshot(ench, 0), windowSnapshot(ench, 37));
  assert.notEqual(windowSnapshot(ench, 0), windowSnapshot(plain, 0));
});

test('悬停在附了魔的格子上才弹提示条，普通物品不弹', () => {
  const ench = decodeSlots(new Uint8Array(
    new Int32Array([IRON_SWORD, 1, 0, summaryWord(1, Enchantment.SHARPNESS, 5)]).buffer,
  ))[0]!;
  assert.ok(windowSnapshot(ench, 0, 9).includes('text:Sharpness V'));
  // 没悬停的时候不弹
  assert.equal(windowSnapshot(ench, 0, -1).includes('text:Sharpness V'), false);
  // 普通物品悬停也不弹（提示条眼下只为附魔而存在，见 inventory-screen.ts）
  assert.equal(windowSnapshot(makeStack(IRON_SWORD, 1), 0, 9).includes('text:'), false);
});
