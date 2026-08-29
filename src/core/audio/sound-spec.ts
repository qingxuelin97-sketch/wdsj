/**
 * 音效的**参数**表 —— 纯数据，不碰 WebAudio。
 *
 * 放在 core 而不是 client，是为了让它可以被单测逐项断言。
 * 音频合成本身没法在 node 里跑，但"石头的破坏声该是什么样"是一张表，
 * 表错了就是所有材质听起来一个样，而那是最容易悄悄发生的退化。
 *
 * 整套音效只有两个原语：
 *   tone(f0 → f1, 指数衰减)   —— 有音高的部分，玻璃的"叮"、木头的"梆"
 *   noise(时长, 低通截止)      —— 无音高的部分，石头的"咔"、沙子的"沙"
 *
 * **材质身份几乎完全由低通截止频率编码**：
 *   羊毛 400 / 泥土 600 / 石头 800 / 木头 1500 / 玻璃 5000
 * 这一条是整套音效能用几十行覆盖全游戏的原因 —— 不需要几十个采样文件，
 * 只需要一个数。
 */
import { SoundGroup } from '../block/types.ts';

/** 一个音效的合成参数 */
export interface SoundSpec {
  /** 噪声段时长（秒） */
  noiseDuration: number;
  /** 噪声的低通截止（Hz）。材质身份主要在这里 */
  cutoff: number;
  /** 音调段起始频率（Hz）。0 表示没有音调段 */
  toneStart: number;
  /** 音调段结束频率 */
  toneEnd: number;
  /** 音调段时长（秒） */
  toneDuration: number;
  /** 整体音量 0..1 */
  gain: number;
}

/** 按 SoundGroup 索引的破坏声 */
const DIG: Record<number, SoundSpec> = {
  [SoundGroup.STONE]: { noiseDuration: 0.18, cutoff: 800, toneStart: 160, toneEnd: 90, toneDuration: 0.07, gain: 0.35 },
  [SoundGroup.WOOD]: { noiseDuration: 0.16, cutoff: 1500, toneStart: 260, toneEnd: 130, toneDuration: 0.09, gain: 0.32 },
  [SoundGroup.GRAVEL]: { noiseDuration: 0.22, cutoff: 1100, toneStart: 0, toneEnd: 0, toneDuration: 0, gain: 0.30 },
  [SoundGroup.GRASS]: { noiseDuration: 0.20, cutoff: 600, toneStart: 0, toneEnd: 0, toneDuration: 0, gain: 0.28 },
  [SoundGroup.METAL]: { noiseDuration: 0.14, cutoff: 3000, toneStart: 520, toneEnd: 380, toneDuration: 0.12, gain: 0.30 },
  [SoundGroup.GLASS]: { noiseDuration: 0.10, cutoff: 5000, toneStart: 1400, toneEnd: 900, toneDuration: 0.14, gain: 0.30 },
  [SoundGroup.CLOTH]: { noiseDuration: 0.16, cutoff: 400, toneStart: 0, toneEnd: 0, toneDuration: 0, gain: 0.24 },
  [SoundGroup.SAND]: { noiseDuration: 0.22, cutoff: 900, toneStart: 0, toneEnd: 0, toneDuration: 0, gain: 0.26 },
  [SoundGroup.SNOW]: { noiseDuration: 0.18, cutoff: 700, toneStart: 0, toneEnd: 0, toneDuration: 0, gain: 0.22 },
  [SoundGroup.LADDER]: { noiseDuration: 0.14, cutoff: 1600, toneStart: 300, toneEnd: 200, toneDuration: 0.07, gain: 0.28 },
};

/** 破坏声：挖穿的那一下 */
export function digSound(group: SoundGroup): SoundSpec {
  return DIG[group] ?? DIG[SoundGroup.STONE]!;
}

/**
 * 挖掘过程中的"哒哒"声，每 4 tick 一次。
 * 比破坏声更短更轻，否则连续播放会糊成一片噪音。
 */
export function hitSound(group: SoundGroup): SoundSpec {
  const base = digSound(group);
  return {
    ...base,
    noiseDuration: base.noiseDuration * 0.45,
    toneDuration: base.toneDuration * 0.45,
    gain: base.gain * 0.45,
  };
}

/** 脚步声：比破坏声更闷、更短 */
export function stepSound(group: SoundGroup): SoundSpec {
  const base = digSound(group);
  return {
    ...base,
    noiseDuration: base.noiseDuration * 0.5,
    // 脚步比破坏更闷：截止再压低一档
    cutoff: base.cutoff * 0.6,
    toneStart: base.toneStart * 0.5,
    toneEnd: base.toneEnd * 0.5,
    toneDuration: base.toneDuration * 0.5,
    gain: base.gain * 0.5,
  };
}

/** 放置声：等同于破坏声，音量略低 —— 与 MC 一致 */
export function placeSound(group: SoundGroup): SoundSpec {
  const base = digSound(group);
  return { ...base, gain: base.gain * 0.8 };
}
