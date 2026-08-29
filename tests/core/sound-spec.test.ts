/**
 * 音效参数表。
 *
 * 音频合成本身在 node 里跑不了，但"每种材质该是什么参数"是一张纯数据表，
 * 可以逐项断言。表塌了的表现是**所有材质听起来一个样** ——
 * 那是最容易悄悄发生、又最难从截图里看出来的退化。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digSound, hitSound, stepSound, placeSound } from '../../src/core/audio/sound-spec.ts';
import { SoundGroup } from '../../src/core/block/types.ts';

const ALL: SoundGroup[] = [
  SoundGroup.STONE, SoundGroup.WOOD, SoundGroup.GRAVEL, SoundGroup.GRASS,
  SoundGroup.METAL, SoundGroup.GLASS, SoundGroup.CLOTH, SoundGroup.SAND,
  SoundGroup.SNOW, SoundGroup.LADDER,
];

test('材质身份由低通截止编码，各不相同', () => {
  // 这是整套音效能用几十行覆盖全游戏的原因：材质差异几乎全在这一个数上
  const cutoffs = ALL.map((g) => digSound(g).cutoff);
  assert.equal(new Set(cutoffs).size, cutoffs.length, `截止频率有重复：${cutoffs}`);

  // 从闷到脆的排序必须成立
  assert.ok(digSound(SoundGroup.CLOTH).cutoff < digSound(SoundGroup.GRASS).cutoff, '羊毛应比草更闷');
  assert.ok(digSound(SoundGroup.GRASS).cutoff < digSound(SoundGroup.STONE).cutoff, '草应比石头更闷');
  assert.ok(digSound(SoundGroup.STONE).cutoff < digSound(SoundGroup.WOOD).cutoff, '石头应比木头更闷');
  assert.ok(digSound(SoundGroup.WOOD).cutoff < digSound(SoundGroup.GLASS).cutoff, '木头应比玻璃更闷');
});

test('颗粒材质是纯噪声，整块材质才有音高', () => {
  // 砾石、沙、雪、草、羊毛敲上去没有音高 —— 给它们加正弦会立刻变成"电子音"。
  // 石头、木头、金属、玻璃、梯子是整块的，有一个短促的基频。
  const granular = [SoundGroup.GRAVEL, SoundGroup.GRASS, SoundGroup.CLOTH, SoundGroup.SAND, SoundGroup.SNOW];
  const solid = [SoundGroup.STONE, SoundGroup.WOOD, SoundGroup.METAL, SoundGroup.GLASS, SoundGroup.LADDER];
  for (const g of granular) {
    assert.equal(digSound(g).toneStart, 0, `颗粒材质 ${g} 不该有音高`);
  }
  for (const g of solid) {
    assert.ok(digSound(g).toneStart > 0, `整块材质 ${g} 应该有音高`);
  }
  assert.equal(granular.length + solid.length, ALL.length, '两类应覆盖全部音效组');

  // 音高高低要符合直觉：玻璃最脆、石头最闷
  assert.ok(digSound(SoundGroup.GLASS).toneStart > digSound(SoundGroup.METAL).toneStart);
  assert.ok(digSound(SoundGroup.METAL).toneStart > digSound(SoundGroup.WOOD).toneStart);
  assert.ok(digSound(SoundGroup.WOOD).toneStart > digSound(SoundGroup.STONE).toneStart);
});

test('音调都是下滑的 —— 上滑听起来像卡通', () => {
  for (const g of ALL) {
    const s = digSound(g);
    if (s.toneStart > 0) {
      assert.ok(s.toneEnd < s.toneStart, `${g} 的音调应下滑：${s.toneStart} -> ${s.toneEnd}`);
      assert.ok(s.toneEnd > 20, `${g} 的终点频率不能低到听不见：${s.toneEnd}`);
    }
  }
});

test('挖掘中的"哒"声比破坏声短且轻 —— 否则连播会糊成噪音', () => {
  for (const g of ALL) {
    const dig = digSound(g);
    const hit = hitSound(g);
    assert.ok(hit.noiseDuration < dig.noiseDuration, `${g} 的哒声应更短`);
    assert.ok(hit.gain < dig.gain, `${g} 的哒声应更轻`);
    // 但材质身份要保住：截止频率不能变
    assert.equal(hit.cutoff, dig.cutoff, `${g} 的哒声不该改变材质音色`);
  }
});

test('脚步声更闷更轻', () => {
  for (const g of ALL) {
    const dig = digSound(g);
    const step = stepSound(g);
    assert.ok(step.cutoff < dig.cutoff, `${g} 的脚步应比破坏更闷`);
    assert.ok(step.gain < dig.gain, `${g} 的脚步应更轻`);
  }
});

test('放置声比破坏声轻，但音色一致 —— 与 MC 一致', () => {
  for (const g of ALL) {
    const dig = digSound(g);
    const place = placeSound(g);
    assert.ok(place.gain < dig.gain);
    assert.equal(place.cutoff, dig.cutoff);
  }
});

test('所有参数都在可听范围内', () => {
  for (const g of ALL) {
    for (const [label, s] of [['dig', digSound(g)], ['hit', hitSound(g)], ['step', stepSound(g)], ['place', placeSound(g)]] as const) {
      assert.ok(s.gain > 0 && s.gain <= 1, `${label}/${g} 音量越界 ${s.gain}`);
      assert.ok(s.noiseDuration > 0 && s.noiseDuration < 1, `${label}/${g} 时长越界 ${s.noiseDuration}`);
      assert.ok(s.cutoff >= 100 && s.cutoff <= 20000, `${label}/${g} 截止越界 ${s.cutoff}`);
    }
  }
});
