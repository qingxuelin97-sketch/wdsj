/**
 * 音效波形。**M14 验收标准里的"音效生成字节哈希稳定"就是这个文件。**
 *
 * `sound-spec.test.ts` 断言的是参数表；参数对而合成错（包络反了、
 * 噪声段没接上、低通把幅度压成 0）照样是一片静音，而那种退化
 * 参数断言一条也拦不住。这里断言的是**真正发出来的波形**。
 *
 * ## 为什么能在 node 里跑
 *
 * 因为 `renderSound` 是纯函数，不碰 WebAudio。引擎播放时用的也是它 ——
 * 预渲染成 AudioBuffer 再播，**只有一份实现**。两份实现迟早会分叉，
 * 而分叉出来的症状恰恰是"测试全绿但听着不对"。
 *
 * ## 金值怎么维护
 *
 * 下面那张表是当前实现的输出。**故意改音色时，把新值抄进去就行**；
 * 但如果不是故意的，它就是唯一能告诉你"音色变了"的东西 ——
 * 耳朵不在 CI 里。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSound, hashWaveform, SAMPLE_RATE } from '../../src/core/audio/sound-render.ts';
import {
  digSound, hitSound, stepSound, placeSound, MobSound,
} from '../../src/core/audio/sound-spec.ts';
import { AMBIENT } from '../../src/core/audio/ambience.ts';
import { SoundGroup } from '../../src/core/block/types.ts';
import type { SoundSpec } from '../../src/core/audio/sound-spec.ts';

const GROUPS = [
  'STONE', 'WOOD', 'GRAVEL', 'GRASS', 'METAL',
  'GLASS', 'CLOTH', 'SAND', 'SNOW', 'LADDER',
] as const;

/** 每个音效的波形哈希。见文件头"金值怎么维护" */
const GOLDEN: Readonly<Record<string, string>> = {
  'dig/STONE': '2652190e',
  'hit/STONE': 'de55fc0e',
  'step/STONE': 'c8596d4d',
  'place/STONE': '190cf6c8',
  'dig/WOOD': '2878593b',
  'hit/WOOD': '766fcf13',
  'step/WOOD': 'a13fc5b9',
  'place/WOOD': 'efde9ddb',
  'dig/GRAVEL': '9f1cc029',
  'hit/GRAVEL': '17489165',
  'step/GRAVEL': '345860a1',
  'place/GRAVEL': '37d6e776',
  'dig/GRASS': 'd2e1ee42',
  'hit/GRASS': '6b7e44a6',
  'step/GRASS': '3633515d',
  'place/GRASS': 'cd67fea8',
  'dig/METAL': 'd3a4ece2',
  'hit/METAL': '1dd1afa4',
  'step/METAL': '1e7cf45a',
  'place/METAL': '62a90504',
  'dig/GLASS': 'a89aa56e',
  'hit/GLASS': 'e54cfed5',
  'step/GLASS': '8a5fb6be',
  'place/GLASS': 'ba25d2f7',
  'dig/CLOTH': 'f9db2d72',
  'hit/CLOTH': 'cc6f8cef',
  'step/CLOTH': 'adb8b378',
  'place/CLOTH': 'a1d50115',
  'dig/SAND': '6c0bc1b2',
  'hit/SAND': '3c5b8566',
  'step/SAND': '3825b40a',
  'place/SAND': '86ed5c58',
  'dig/SNOW': '6b233856',
  'hit/SNOW': 'fd5c8469',
  'step/SNOW': '394c2272',
  'place/SNOW': '8dcc6e87',
  'dig/LADDER': '79379d24',
  'hit/LADDER': '89c71730',
  'step/LADDER': '3786ff61',
  'place/LADDER': 'c70fb73c',
  'mob/CREEPER_HISS': '3140578a',
  'mob/EXPLODE': 'a6d62988',
  'mob/HURT': '0d80aa91',
  'mob/DEATH': '632ed6d7',
  'mob/BOW': 'f5830884',
  'ambient/CAVE_RUMBLE': '94041034',
  'ambient/CAVE_DRIP': 'e60d4881',
  'ambient/CAVE_MOAN': '19349852',
  'ambient/CAVE_FLOW': '09d8d408',
  'pitch/HURT@0.6': 'd72cf507',
  'pitch/HURT@1.8': '35fae4c0',
};

/** 把全部音效摊平成 名字 -> spec，测试里到处要用 */
function allSounds(): Map<string, { spec: SoundSpec; pitch: number }> {
  const m = new Map<string, { spec: SoundSpec; pitch: number }>();
  for (const name of GROUPS) {
    const g = SoundGroup[name];
    m.set(`dig/${name}`, { spec: digSound(g), pitch: 1 });
    m.set(`hit/${name}`, { spec: hitSound(g), pitch: 1 });
    m.set(`step/${name}`, { spec: stepSound(g), pitch: 1 });
    m.set(`place/${name}`, { spec: placeSound(g), pitch: 1 });
  }
  for (const [k, v] of Object.entries(MobSound)) m.set(`mob/${k}`, { spec: v, pitch: 1 });
  for (const [k, v] of Object.entries(AMBIENT)) m.set(`ambient/${k}`, { spec: v, pitch: 1 });
  m.set('pitch/HURT@0.6', { spec: MobSound.HURT, pitch: 0.6 });
  m.set('pitch/HURT@1.8', { spec: MobSound.HURT, pitch: 1.8 });
  return m;
}

test('每个音效的波形哈希都对得上金值', () => {
  const got: string[] = [];
  for (const [name, { spec, pitch }] of allSounds()) {
    const h = hashWaveform(renderSound(spec, pitch));
    if (GOLDEN[name] !== h) got.push(`  '${name}': '${h}',  // 金值 ${GOLDEN[name] ?? '(缺)'}`);
  }
  assert.equal(got.length, 0, `音色变了。若是故意的，把下面几行抄进 GOLDEN：\n${got.join('\n')}`);
});

test('金值表没有孤儿项 —— 删了音效要顺手删金值', () => {
  // 否则表会慢慢长成一份"曾经有过的音效"的化石记录，
  // 而它每一项看起来都还在被验证
  const live = new Set(allSounds().keys());
  const orphans = Object.keys(GOLDEN).filter((k) => !live.has(k));
  assert.deepEqual(orphans, [], `GOLDEN 里有已经不存在的音效：${orphans.join(', ')}`);
});

test('渲染是确定的 —— 同一个 spec 连渲两次逐字节相同', () => {
  // 哈希表能拦住"音色变了"，但拦不住"每次都不一样"：
  // 那种情况下第一次跑就红，看起来像金值过期，实际是随机源漏了进来
  for (const [name, { spec, pitch }] of allSounds()) {
    const a = renderSound(spec, pitch);
    const b = renderSound(spec, pitch);
    assert.deepEqual(a, b, `${name} 两次渲染不同 —— 噪声用到了 Math.random？`);
  }
});

test('没有一个音效是静音的', () => {
  // 这是最要命也最容易发生的退化：低通截止给低了、包络算反了、
  // 归一化除以 0 —— 参数表全对，播出来一片安静
  for (const [name, { spec, pitch }] of allSounds()) {
    const w = renderSound(spec, pitch);
    let peak = 0;
    let energy = 0;
    for (const s of w) {
      peak = Math.max(peak, Math.abs(s));
      energy += s * s;
    }
    assert.ok(peak > 0.02, `${name} 峰值只有 ${peak.toFixed(4)}，基本听不见`);
    assert.ok(energy / w.length > 1e-5, `${name} 能量过低，可能只有开头一个脉冲`);
  }
});

test('包络是衰减的 —— 后半段必须比前半段轻', () => {
  // 包络反了的话声音是"由轻变响"，听起来像倒放。
  // 哈希能发现它变了，但发现不了它变成了什么
  for (const [name, { spec, pitch }] of allSounds()) {
    const w = renderSound(spec, pitch);
    const half = Math.floor(w.length / 2);
    const rms = (from: number, to: number): number => {
      let e = 0;
      for (let i = from; i < to; i++) e += w[i]! * w[i]!;
      return Math.sqrt(e / Math.max(1, to - from));
    };
    assert.ok(rms(0, half) > rms(half, w.length) * 1.5,
      `${name} 的包络没有明显衰减：前 ${rms(0, half).toFixed(4)} 后 ${rms(half, w.length).toFixed(4)}`);
  }
});

test('材质之间波形互不相同 —— 参数不同而声音相同等于没做', () => {
  // 只断言参数不同是不够的：如果合成把 cutoff 忽略了，
  // 十种材质会渲染出完全一样的波形，而参数表测试照样全绿
  const hashes = new Map<string, string>();
  for (const name of GROUPS) {
    hashes.set(name, hashWaveform(renderSound(digSound(SoundGroup[name]))));
  }
  assert.equal(new Set(hashes.values()).size, GROUPS.length,
    `有材质的破坏声波形相同：${[...hashes].map(([k, v]) => `${k}=${v}`).join(' ')}`);
});

test('音高倍率真的改变波形，并且缩短时长', () => {
  const base = renderSound(MobSound.HURT, 1);
  const high = renderSound(MobSound.HURT, 1.8);
  assert.notEqual(hashWaveform(base), hashWaveform(high), '调了音高波形没变');
  // 时长由 spec 决定、不随 pitchScale 变 —— 变的是频率内容。
  // （体型缩放的时长在调用方做，不在这里）
  assert.equal(base.length, high.length);
});

test('长度等于两段里更长的那个', () => {
  for (const [name, { spec, pitch }] of allSounds()) {
    const want = Math.max(1, Math.ceil(Math.max(spec.noiseDuration, spec.toneDuration) * SAMPLE_RATE));
    assert.equal(renderSound(spec, pitch).length, want, `${name} 长度不对`);
  }
});

test('全部采样都夹在 [-1,1] 内 —— 过冲会削波爆音', () => {
  for (const [name, { spec, pitch }] of allSounds()) {
    for (const s of renderSound(spec, pitch)) {
      assert.ok(s >= -1 && s <= 1, `${name} 有越界采样 ${s}`);
      assert.ok(Number.isFinite(s), `${name} 出现了 NaN/Infinity`);
    }
  }
});

test('哈希对浮点抖动不敏感，对真实退化敏感', () => {
  // 量化到 12 位是为了跨机器稳定：Math.sin/Math.pow 不保证逐位一致，
  // 直接哈希浮点会得到一个换台机器就红的测试。
  //
  // 抖动取 1e-9。实测这个实现下 1e-8 以内一个采样都不会跨量化边界，
  // 1e-7 才会翻一个（7056 个采样里）—— 而两个引擎的 Math.sin 分歧
  // 在 1e-16 量级，留了七个数量级的余量。
  //
  // 两头都要验：量化过头的话哈希就什么都发现不了了
  const w = renderSound(MobSound.HURT);
  const jitter = Float32Array.from(w, (s) => s + 1e-9);
  assert.equal(hashWaveform(jitter), hashWaveform(w), '1e-9 的抖动不该改变哈希');

  const real = Float32Array.from(w, (s) => s * 0.9);
  assert.notEqual(hashWaveform(real), hashWaveform(w), '音量降一成属于真实变化，该被发现');

  // 哈希必须依赖整条波形，不能只看开头几个采样
  const tailChanged = Float32Array.from(w);
  tailChanged[w.length - 1] = 0.5;
  assert.notEqual(hashWaveform(tailChanged), hashWaveform(w), '改最后一个采样哈希没变');
});
