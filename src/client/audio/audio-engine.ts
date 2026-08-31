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
 * 2. 波形由 core/audio/sound-render.ts **离线渲染**并按 spec 缓存，
 *    播放时只搭一个 BufferSource。这样只有一份波形实现（node 里可哈希），
 *    而且连续挖掘时不会每秒分配十几张节点图 —— 那会在音频线程上制造爆音。
 */
import type { SoundSpec } from '../../core/audio/sound-spec.ts';
import { renderSound } from '../../core/audio/sound-render.ts';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** spec+音高 -> 已渲染的波形。渲染一次就够，之后都是命中 */
  private readonly buffers = new Map<string, AudioBuffer>();
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
  /**
   * 播一个音。
   *
   * 波形由 `core/audio/sound-render.ts` **离线渲染**，这里只负责把它
   * 塞进一个 BufferSource 播出去。
   *
   * 原来是当场搭一张 WebAudio 节点图（噪声源 + 双二阶低通 + 两个增益包络）。
   * 换掉的理由不是性能，是**可测性**：节点图在 node 里跑不起来，
   * 于是"音效生成字节哈希稳定"这条验收根本无从做起 —— 只能断言参数表，
   * 而参数对、合成错（包络反了、噪声段没接上）照样是一片静音。
   *
   * 现在只有一份波形实现，测试哈希的就是玩家听到的那一串采样。
   * 顺带也更省：每次播放不再现搭图，只有一个 BufferSource。
   *
   * @param pan −1..1，左右声道。按声源相对玩家的方位给，能听出方块在哪一边
   */
  play(spec: SoundSpec, pan = 0, pitchScale = 1): void {
    const ctx = this.ctx;
    const master = this.master;
    if (ctx === null || master === null) return;
    if (ctx.state !== 'running') return;
    // 静音时直接不渲染也不排期。只把 master 增益归零的话，
    // 波形照样在算、节点照样在建 —— 关掉声音本该省下这些
    if (this.muted) return;

    try {
      const buf = this.bufferFor(spec, pitchScale);
      if (buf === null) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const out = ctx.createStereoPanner();
      out.pan.value = Math.max(-1, Math.min(1, pan));
      src.connect(out);
      out.connect(master);
      src.start();
      this.playCount++;
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        console.warn('[audio] 播放失败', err);
      }
    }
  }

  /**
   * 取（或渲染并缓存）一个 spec 的 AudioBuffer。
   *
   * 缓存键要带上音高倍率：生物按体型缩放音高，同一个 HURT spec
   * 在鸡和牛身上是两条不同的波形。不带的话所有生物听起来一个样，
   * 而那是最难发现的一类退化 —— 功能全在，只是"不对味"。
   *
   * 音高量化到两位小数再做键：连续的浮点会让缓存永远不命中，
   * 每次受伤都重渲染一遍。
   */
  private bufferFor(spec: SoundSpec, pitchScale: number): AudioBuffer | null {
    const ctx = this.ctx;
    if (ctx === null) return null;
    const p = Math.round(pitchScale * 100) / 100;
    const key = `${spec.noiseDuration}|${spec.cutoff}|${spec.toneStart}|${spec.toneEnd}`
      + `|${spec.toneDuration}|${spec.gain}|${p}`;
    const hit = this.buffers.get(key);
    if (hit !== undefined) return hit;
    const pcm = renderSound(spec, p, ctx.sampleRate);
    const buf = ctx.createBuffer(1, pcm.length, ctx.sampleRate);
    buf.getChannelData(0).set(pcm);
    this.buffers.set(key, buf);
    return buf;
  }
}
