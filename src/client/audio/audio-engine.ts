/**
 * 程序化音效引擎。没有任何采样文件，全部现场合成。
 *
 * 两个原语拼出全部音效（参数表见 core/audio/sound-spec.ts）：
 *   噪声 → 低通 → 指数衰减包络   材质身份靠低通截止频率编码
 *   正弦 → 频率下滑 → 指数衰减    给玻璃/金属那一点"音高"
 *
 * 有两条实现上的注意：
 *
 * 1. **AudioContext 必须等用户手势之后才能启动**。浏览器会把自动创建的
 *    上下文挂成 suspended，第一次播放会静音且不报错 —— 表现是"游戏没声音"
 *    且完全查不出原因。这里在第一次指针锁定时 resume。
 * 2. 噪声缓冲**只生成一次**并复用。每次播放都新建一个 0.2 秒的缓冲，
 *    连续挖掘时每秒要分配十几个，GC 会在音频线程上制造爆音。
 */
import type { SoundSpec } from '../../core/audio/sound-spec.ts';

/** 噪声源缓冲的长度（秒）。够长就不会听出循环 */
const NOISE_SECONDS = 2;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  /** 播放失败只报一次，别把控制台刷满 */
  private warned = false;
  private muted = false;

  /** 已经播过多少个音，供自动化断言"确实响过" */
  playCount = 0;

  /**
   * 启动音频。**必须在用户手势的调用栈里**调用，否则上下文会是 suspended。
   * 重复调用是安全的。
   */
  resume(): void {
    if (this.ctx === null) {
      const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
      if (Ctor === undefined) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.6;
      this.master.connect(this.ctx.destination);

      // 一次性生成噪声源
      const len = Math.floor(this.ctx.sampleRate * NOISE_SECONDS);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      // 固定种子的 LCG：同一次运行里每次挖石头听起来一样，
      // 用 Math.random 的话音色会飘，而且没法做回归
      let seed = 0x9e3779b9;
      for (let i = 0; i < len; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        data[i] = (seed / 0x80000000) - 1;
      }
      this.noiseBuffer = buf;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master !== null) this.master.gain.value = muted ? 0 : 0.6;
  }

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /**
   * 播一个音。
   * @param pan −1..1，左右声道。按声源相对玩家的方位给，能听出方块在哪一边
   */
  play(spec: SoundSpec, pan = 0, pitchScale = 1): void {
    const ctx = this.ctx;
    const master = this.master;
    if (ctx === null || master === null || this.noiseBuffer === null) return;
    if (ctx.state !== 'running') return;

    try {
      const now = ctx.currentTime;
      const out = ctx.createStereoPanner();
      out.pan.value = Math.max(-1, Math.min(1, pan));
      out.connect(master);

      if (spec.noiseDuration > 0) {
        const src = ctx.createBufferSource();
        src.buffer = this.noiseBuffer;
        // 从缓冲的随机位置起播，避免每次都是同一段波形
        src.loop = true;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = spec.cutoff * pitchScale;
        const g = ctx.createGain();
        g.gain.setValueAtTime(spec.gain, now);
        // 指数衰减而不是线性：线性收尾会有一声"喀"的截断
        g.gain.exponentialRampToValueAtTime(0.0001, now + spec.noiseDuration);
        src.connect(lp);
        lp.connect(g);
        g.connect(out);
        src.start(now, (this.playCount * 0.137) % (NOISE_SECONDS - spec.noiseDuration - 0.01));
        src.stop(now + spec.noiseDuration);
      }

      if (spec.toneStart > 0 && spec.toneDuration > 0) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(spec.toneStart * pitchScale, now);
        osc.frequency.exponentialRampToValueAtTime(
          Math.max(20, spec.toneEnd * pitchScale), now + spec.toneDuration,
        );
        const g = ctx.createGain();
        g.gain.setValueAtTime(spec.gain * 0.7, now);
        g.gain.exponentialRampToValueAtTime(0.0001, now + spec.toneDuration);
        osc.connect(g);
        g.connect(out);
        osc.start(now);
        osc.stop(now + spec.toneDuration);
      }

      this.playCount++;
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        console.warn('[audio] 播放失败', err);
      }
    }
    void this.muted;
  }
}
