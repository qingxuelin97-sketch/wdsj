/**
 * 环境音与音乐的**调度**。
 *
 * `sound-render.test.ts` 验的是"响出来是什么"，这里验的是"什么时候响"。
 * 两者都塌得静悄悄：调度坏了的表现是**一整局什么都没听见**，
 * 而没有任何截图、任何波形哈希会因此变红。
 *
 * 之所以能在 node 里逐刻断言，是因为调度器是纯的 —— 只回答
 * "这一刻该播哪些 spec"，不碰 WebAudio。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AmbienceScheduler, composePhrase, AMBIENT,
  AMBIENT_MIN_INTERVAL_TICKS, AMBIENT_MAX_SKYLIGHT, AMBIENT_MAX_Y,
  MUSIC_MIN_GAP_TICKS,
} from '../../src/core/audio/ambience.ts';
import { mulberry32 } from '../../src/core/rng/mulberry.ts';
import { renderSound } from '../../src/core/audio/sound-render.ts';
import type { SoundSpec } from '../../src/core/audio/sound-spec.ts';

const AMBIENT_SPECS = new Set<SoundSpec>(Object.values(AMBIENT));
const TPS = 20;

interface Run {
  ambient: number;
  music: number;
  firstAmbient: number;
  firstMusic: number;
}

/** 跑 `minutes` 分钟，统计各类事件 */
function run(y: number, skyLight: number, minutes: number, seed = 0x51ed270b): Run {
  const s = new AmbienceScheduler(mulberry32(seed));
  const out: Run = { ambient: 0, music: 0, firstAmbient: -1, firstMusic: -1 };
  for (let t = 0; t < minutes * 60 * TPS; t++) {
    for (const spec of s.tick(t, y, skyLight)) {
      if (AMBIENT_SPECS.has(spec)) {
        out.ambient++;
        if (out.firstAmbient < 0) out.firstAmbient = t;
      } else {
        out.music++;
        if (out.firstMusic < 0) out.firstMusic = t;
      }
    }
  }
  return out;
}

test('地下且黑的时候会响洞穴音', () => {
  // 一局半小时听不到一声洞穴音，等于这套东西白做
  const r = run(20, 0, 30);
  assert.ok(r.ambient >= 8, `半小时只响了 ${r.ambient} 声洞穴音，太少`);
  assert.ok(r.ambient <= 40, `半小时响了 ${r.ambient} 声，太吵 —— MC 的量级是分钟级`);
});

test('地面上、或者有光的地方不响洞穴音', () => {
  // 白天站在草地上传来矿洞的塌方声，是 MC 玩家一耳朵就能听出的错
  assert.equal(run(70, 15, 30).ambient, 0, '地表大白天不该有洞穴音');
  assert.equal(run(20, AMBIENT_MAX_SKYLIGHT + 6, 30).ambient, 0, '有天光的地下不该有洞穴音');
  assert.equal(run(AMBIENT_MAX_Y + 10, 0, 30).ambient, 0, '高处的暗是夜晚，不是洞穴');
});

test('开局不立刻响 —— 刚进游戏就来一声很突兀', () => {
  const r = run(20, 0, 30);
  assert.ok(r.firstAmbient >= AMBIENT_MIN_INTERVAL_TICKS,
    `第 ${r.firstAmbient} 刻就响了，至少该等 ${AMBIENT_MIN_INTERVAL_TICKS}`);
  assert.ok(r.firstMusic >= MUSIC_MIN_GAP_TICKS,
    `音乐第 ${r.firstMusic} 刻就起了，至少该等 ${MUSIC_MIN_GAP_TICKS}`);
});

test('条件不满足时计时照样往后推 —— 否则一进洞会连响一串', () => {
  // 在地表待很久，攒下的"待播"必须被丢掉而不是排队。
  // 排队的话玩家一下矿就会被十几声塌方糊脸
  const s = new AmbienceScheduler(mulberry32(1));
  for (let t = 0; t < 30 * 60 * TPS; t++) s.tick(t, 70, 15); // 半小时地表
  let burst = 0;
  const t0 = 30 * 60 * TPS;
  for (let t = t0; t < t0 + AMBIENT_MIN_INTERVAL_TICKS; t++) {
    for (const spec of s.tick(t, 20, 0)) if (AMBIENT_SPECS.has(spec)) burst++;
  }
  assert.ok(burst <= 1, `刚进洞的第一个间隔里响了 ${burst} 声，说明事件在排队`);
});

test('背景音乐留白很多 —— 一直垫着会让人关掉', () => {
  const r = run(70, 15, 30);
  assert.ok(r.music > 0, '半小时一个音符都没有');
  // 一段 8 个音符、跨度不到 200 刻；半小时里最多几段
  assert.ok(r.music <= 8 * 8, `半小时 ${r.music} 个音符，太密`);
});

test('同一个种子跑两次事件序列完全相同', () => {
  // 音频回归的地基。不确定的话金值哈希、截图回归全都无从谈起
  const a = run(20, 0, 30);
  const b = run(20, 0, 30);
  assert.deepEqual(a, b);
});

test('不同种子给出不同的序列 —— 种子没接上会导致每局一模一样', () => {
  const a = run(20, 0, 30, 1);
  const b = run(20, 0, 30, 2);
  assert.notDeepEqual(a, b);
});

test('乐句是五声音阶，音符互不重叠地铺开', () => {
  const notes = composePhrase(mulberry32(7));
  assert.equal(notes.length, 8);
  for (let i = 1; i < notes.length; i++) {
    assert.ok(notes[i]!.atTick > notes[i - 1]!.atTick,
      '音符时间必须严格递增，否则会挤在一起变成和弦');
  }
  // 音高要落在同一个音阶里：五声音阶是"随机挑也不难听"的原因，
  // 挑错了会立刻出现半音碰撞
  const ratios = notes.map((n) => n.spec.toneStart / 220);
  for (const r of ratios) {
    const semi = Math.round(12 * Math.log2(r));
    assert.ok([0, 2, 4, 7, 9, 12, 14, 16, 19, 21].includes(semi),
      `音符落在音阶外：第 ${semi} 个半音`);
  }
});

test('每个洞穴音都是长而闷的 —— 有明确音高会听成有东西在唱歌', () => {
  for (const [name, spec] of Object.entries(AMBIENT)) {
    assert.ok(spec.noiseDuration > 0, `${name} 该以噪声为主体`);
    assert.ok(spec.cutoff <= 3500, `${name} 截止 ${spec.cutoff} 太亮，听着不像远处`);
    assert.ok(spec.gain < 0.4, `${name} 音量 ${spec.gain} 太大 —— 环境音不该盖过操作声`);
  }
  // 除了水滴，其余都该是"长"的
  const long = Object.entries(AMBIENT).filter(([, s]) => s.noiseDuration >= 1.5);
  assert.ok(long.length >= 3, '洞穴音里长音太少，听起来会像点击而不是氛围');
});

test('调度出来的 spec 都能真的渲染成声音', () => {
  // 调度与合成是两个模块，接口对不上的表现是"逻辑全对但一片静音"
  const s = new AmbienceScheduler(mulberry32(3));
  let checked = 0;
  for (let t = 0; t < 30 * 60 * TPS; t++) {
    for (const spec of s.tick(t, 20, 0)) {
      const w = renderSound(spec);
      let peak = 0;
      for (const v of w) peak = Math.max(peak, Math.abs(v));
      assert.ok(peak > 0.02, `第 ${t} 刻排的音渲染出来几乎无声`);
      checked++;
    }
  }
  assert.ok(checked > 10, `只检查了 ${checked} 个事件，样本太少`);
});
