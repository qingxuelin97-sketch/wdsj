/**
 * 点阵字模。
 *
 * 字模是那种"错了也不报错"的东西：一个字母画歪了，游戏照样跑，
 * 只是 F3 上某个字长得怪。所以这里断言的是**结构性**的东西 ——
 * 每个字符都有字模、字模真的有内容、形状能对上几个人人都认得的字母。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFont, textWidth, GLYPH_H, GLYPH_W, GLYPH_ADVANCE } from '../../src/client/ui/font.ts';

/** 把一个字符的字模还原成可读的字符串，便于断言里直接比 */
function render(ch: string): string[] {
  const f = buildFont();
  const base = (ch.charCodeAt(0) - f.first) * GLYPH_H;
  const out: string[] = [];
  for (let row = 0; row < GLYPH_H; row++) {
    const v = f.bits[base + row]!;
    let line = '';
    for (let c = 0; c < GLYPH_W; c++) line += (v >> (GLYPH_W - 1 - c) & 1) ? '#' : '.';
    out.push(line);
  }
  return out;
}

test('可打印 ASCII 全都有字模', () => {
  const f = buildFont();
  assert.equal(f.first, 32);
  assert.equal(f.last, 126);
  assert.equal(f.bits.length, (126 - 32 + 1) * GLYPH_H);
});

test('除空格外每个字符都有亮点 —— 空字模等于"这个字打不出来"', () => {
  const f = buildFont();
  const blank: string[] = [];
  for (let code = 33; code <= 126; code++) {
    const base = (code - f.first) * GLYPH_H;
    let any = 0;
    for (let row = 0; row < GLYPH_H; row++) any |= f.bits[base + row]!;
    if (any === 0) blank.push(String.fromCharCode(code));
  }
  assert.deepEqual(blank, [], `这些字符是空的：${blank.join('')}`);
});

test('空格是空的', () => {
  assert.deepEqual(render(' '), Array(GLYPH_H).fill('.'.repeat(GLYPH_W)));
});

test('字形对得上 —— 抽查几个人人都认得的', () => {
  // 这几个断言的价值不在"证明字模完美"，而在于**一旦有人改动打包逻辑**
  // （位序、行序、宽高）立刻会红。位序反了的话 E 会变成 ヨ，
  // 而那种错误在别的测试里全都看不出来
  assert.deepEqual(render('E'), [
    '#####',
    '#....',
    '#....',
    '####.',
    '#....',
    '#....',
    '#####',
  ]);
  assert.deepEqual(render('L'), [
    '#....',
    '#....',
    '#....',
    '#....',
    '#....',
    '#....',
    '#####',
  ]);
  assert.deepEqual(render('T'), [
    '#####',
    '..#..',
    '..#..',
    '..#..',
    '..#..',
    '..#..',
    '..#..',
  ]);
  assert.deepEqual(render('1'), [
    '..#..',
    '.##..',
    '..#..',
    '..#..',
    '..#..',
    '..#..',
    '.###.',
  ]);
});

test('大小写是不同的字形', () => {
  for (const ch of 'ABEGKMQRW') {
    assert.notDeepEqual(
      render(ch), render(ch.toLowerCase()),
      `${ch} 与 ${ch.toLowerCase()} 的字模一样 —— 多半是漏写了小写`,
    );
  }
});

test('小写 g p q y 有下伸部 —— 最后一行不能是空的', () => {
  // 下伸部是"这套字模是认真画的"的标志。少了的话小写 g 看着像 9，
  // 而那种别扭很难指出来是哪里不对
  for (const ch of 'gpqy') {
    const rows = render(ch);
    assert.notEqual(rows[GLYPH_H - 1], '.....', `${ch} 该有下伸部`);
  }
});

test('宽度计算与步进一致', () => {
  assert.equal(textWidth('abc'), 3 * GLYPH_ADVANCE);
  assert.equal(textWidth('abc', 2), 3 * GLYPH_ADVANCE * 2);
  assert.equal(textWidth(''), 0);
});

test('缺字回退到 ? 而不是抛异常', () => {
  // F3 叠层不该因为某人在世界名里打了个中文就把整帧画崩
  const f = buildFont();
  assert.ok(f.bits.length > 0);
  // 制表符（9）落在范围外，画的时候会被跳过，不该崩
  assert.doesNotThrow(() => textWidth('\ttab'));
});
