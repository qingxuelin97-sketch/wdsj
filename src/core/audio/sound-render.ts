/**
 * 把 `SoundSpec` 渲染成 PCM 波形。**纯函数，不碰 WebAudio。**
 *
 * ## 为什么要有它
 *
 * M14 的验收标准里有一条"音效生成字节哈希稳定"。在此之前音效是靠
 * WebAudio 的节点图当场合成的 —— 那东西在 node 里跑不起来，
 * 于是只能断言参数表（"石头的截止是 800"），断不了**真正发出来的声音**。
 * 参数对而合成错（包络反了、噪声段没接上）照样是一片静音，
 * 而那种退化没有任何测试拦得住。
 *
 * 把波形做成纯函数之后：
 *   - node 里能逐字节哈希，音色一旦漂移立刻报
 *   - 引擎改成"预渲染成 AudioBuffer 再播"，**只有一份实现**
 *     （两份实现迟早会分叉，而分叉出来的症状是"测试全绿但听着不对"）
 *   - 顺带更省：每次播放不再现搭一张节点图
 *
 * ## 确定性
 *
 * 噪声用固定种子的 LCG，不用 `Math.random` —— 同一个 spec 渲染两次
 * 必须逐字节相同，否则哈希无从谈起，玩家听到的音色也会每次都飘。
 */
import type { SoundSpec } from './sound-spec.ts';

/** 采样率。44100 是 WebAudio 的常见默认值，固定下来哈希才稳定 */
export const SAMPLE_RATE = 44100;

/**
 * 一阶低通。
 *
 * 材质身份几乎完全由截止频率编码（见 sound-spec.ts），所以这个滤波器
 * 是整套音效的核心。一阶就够 —— 更高阶只会让"石头 vs 木头"的区别
 * 更微妙，而我们要的恰恰是**明显**。
 */
function lowpass(samples: Float32Array, cutoffHz: number, sampleRate: number): void {
  // RC 低通的离散形式：alpha = dt / (RC + dt)
  const rc = 1 / (2 * Math.PI * Math.max(20, cutoffHz));
  const dt = 1 / sampleRate;
  const alpha = dt / (rc + dt);
  let prev = 0;
  for (let i = 0; i < samples.length; i++) {
    prev += alpha * (samples[i]! - prev);
    samples[i] = prev;
  }
}

/**
 * 指数衰减包络。
 *
 * 用指数而不是线性：线性衰减听起来像"被掐断"，而真实世界里
 * 一切碰撞声都是指数衰减的。这一条是"像音效"与"像蜂鸣器"的分界。
 */
function decay(t: number, duration: number): number {
  if (duration <= 0) return 0;
  const x = t / duration;
  if (x >= 1) return 0;
  // e^-5 ≈ 0.0067，到时长末尾基本听不见了
  return Math.exp(-5 * x);
}

/**
 * 渲染一个音效。
 *
 * @param pitchScale 音高倍率。生物按体型缩放音高时用（鸡尖、牛闷），
 *                   同时也会缩短时长 —— 真实世界里小东西的声音也更短
 */
export function renderSound(
  spec: SoundSpec, pitchScale = 1, sampleRate = SAMPLE_RATE,
): Float32Array {
  const total = Math.max(spec.noiseDuration, spec.toneDuration);
  const len = Math.max(1, Math.ceil(total * sampleRate));
  const out = new Float32Array(len);

  // --- 噪声段 ---
  if (spec.noiseDuration > 0) {
    const n = Math.min(len, Math.ceil(spec.noiseDuration * sampleRate));
    const noise = new Float32Array(n);
    // 固定种子的 LCG。种子里掺进截止频率，于是不同材质的噪声**样式**
    // 也不同 —— 全用同一段噪声的话，石头和沙子只是同一个声音的两种滤波
    let seed = (0x9e3779b9 ^ Math.round(spec.cutoff)) >>> 0;
    for (let i = 0; i < n; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      noise[i] = (seed / 0x80000000) - 1;
    }
    lowpass(noise, spec.cutoff * pitchScale, sampleRate);
    // 低通把幅度压掉不少，补回来 —— 不补的话截止低的材质（羊毛）几乎无声
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(noise[i]!));
    const norm = peak > 1e-6 ? 1 / peak : 1;
    for (let i = 0; i < n; i++) {
      out[i]! += noise[i]! * norm * decay(i / sampleRate, spec.noiseDuration) * spec.gain;
    }
  }

  // --- 音调段 ---
  if (spec.toneStart > 0 && spec.toneDuration > 0) {
    const n = Math.min(len, Math.ceil(spec.toneDuration * sampleRate));
    const f0 = spec.toneStart * pitchScale;
    const f1 = Math.max(20, spec.toneEnd * pitchScale);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      // 频率按指数插值（听觉是对数的，线性插值听起来是"先快后慢"）
      const f = f0 * Math.pow(f1 / f0, t / spec.toneDuration);
      phase += (2 * Math.PI * f) / sampleRate;
      out[i]! += Math.sin(phase) * decay(t, spec.toneDuration) * spec.gain;
    }
  }

  // 夹到 [-1,1]。两段叠加后可能过冲，不夹的话播放时会削波爆音
  for (let i = 0; i < len; i++) {
    out[i] = Math.max(-1, Math.min(1, out[i]!));
  }
  return out;
}

/**
 * 波形的 32 位哈希。测试用 —— 音色一旦漂移这个数就变。
 *
 * 量化到 12 位再哈希：不同机器上的浮点尾数可能差一两个 ulp
 * （`Math.sin`/`Math.pow` 不保证逐位一致），直接哈希浮点会得到一个
 * 换台机器就红的测试。12 位精度远高于耳朵能分辨的，
 * 却足以让"包络反了""噪声没接上"这类真实退化露出来。
 */
export function hashWaveform(samples: Float32Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < samples.length; i++) {
    const q = Math.round(samples[i]! * 2048) | 0;
    h ^= q & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (q >> 8) & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
