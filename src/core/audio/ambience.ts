/**
 * 环境音与背景音乐。**纯数据 + 纯调度，不碰 WebAudio。**
 *
 * MC 1.0 的听觉环境由两样东西撑起来：
 *
 *   1. **洞穴环境音** —— 在地下、光线暗的地方，每隔很久随机来一声
 *      遥远的低沉响动。它没有任何玩法作用，纯粹制造"这里不安全"的感觉，
 *      而这恰恰是下矿最重要的体验。
 *   2. **背景音乐** —— 稀疏、缓慢、大量留白。MC 的音乐特点是**很久才响一次**，
 *      而不是一直垫着；一直垫着会让人很快关掉。
 *
 * ## 为什么调度也放在 core
 *
 * "什么时候该响"是可以逐刻断言的（间隔、概率、触发条件），
 * 而"响出来是什么"由 sound-render 负责。两者都在 core，于是整条链
 * 在 node 里可测 —— 只有最后"交给 WebAudio 播"那一步在 client。
 *
 * 时间用**刻**而不是挂钟：与全项目一致，`freeze()` 才停得住，
 * 而且同一个种子跑两次事件序列相同。
 */
import type { SoundSpec } from './sound-spec.ts';

/**
 * 洞穴环境音。
 *
 * 都是长、闷、几乎没有音调的声音 —— 有明确音高的话会听成"有东西在唱歌"，
 * 那是恐怖片不是矿洞。
 */
export const AMBIENT: Readonly<Record<string, SoundSpec>> = {
  /** 远处的塌方 */
  CAVE_RUMBLE: { noiseDuration: 2.2, cutoff: 220, toneStart: 0, toneEnd: 0, toneDuration: 0, gain: 0.30 },
  /** 水滴落进积水 */
  CAVE_DRIP: { noiseDuration: 0.05, cutoff: 3200, toneStart: 900, toneEnd: 1500, toneDuration: 0.09, gain: 0.16 },
  /** 说不清是什么的一声闷响 —— MC 的 cave13 那一类 */
  CAVE_MOAN: { noiseDuration: 1.6, cutoff: 340, toneStart: 70, toneEnd: 52, toneDuration: 1.4, gain: 0.22 },
  /** 地下水流 */
  CAVE_FLOW: { noiseDuration: 1.8, cutoff: 900, toneStart: 0, toneEnd: 0, toneDuration: 0, gain: 0.14 },
};

export type AmbientId = keyof typeof AMBIENT;
const AMBIENT_IDS = Object.keys(AMBIENT) as AmbientId[];

/**
 * 环境音触发条件与节奏，照 MC 的量级取。
 *
 * MC 的洞穴音间隔非常长（分钟量级）。给短了会从"氛围"变成"吵"，
 * 而那种烦躁很难归因到具体某个数上 —— 玩家只会说"听着累"。
 */
export const AMBIENT_MIN_INTERVAL_TICKS = 20 * 45; // 至少 45 秒
export const AMBIENT_RANGE_TICKS = 20 * 120; // 再加 0..120 秒
/** 天光高于这个值就不算"地下"了 */
export const AMBIENT_MAX_SKYLIGHT = 4;
/** 高于这个 Y 不放洞穴音 —— 地表的暗处是夜晚，不是洞穴 */
export const AMBIENT_MAX_Y = 56;

/**
 * 背景音乐：一小段程序化的旋律。
 *
 * 不做采样音乐（那要音频文件，与零依赖冲突），而是用同一个 `tone` 原语
 * 弹一串音符。**五声音阶**是关键 —— 任意顺序都不会难听，
 * 于是随机挑音符也能听得下去，不必手写旋律。
 *
 * 音符很长、衰减很慢，听起来像钢琴的余韵而不是电子游戏的哔哔声。
 */
const PENTATONIC = [0, 2, 4, 7, 9] as const;
/** A3。低八度听着才"远"，高了会抢戏 */
const MUSIC_ROOT_HZ = 220;

/** 第 n 个半音的频率 */
function semitone(n: number): number {
  return MUSIC_ROOT_HZ * Math.pow(2, n / 12);
}

/** 一个音符：什么时候弹、弹什么 */
export interface MusicNote {
  /** 相对于这段音乐开头的偏移，单位刻 */
  readonly atTick: number;
  readonly spec: SoundSpec;
}

/**
 * 生成一段背景音乐。
 *
 * @param rand 0..1 的随机源。传同一个序列会得到同一段曲子 ——
 *             音乐也必须是确定的，否则截图/音频回归都无从做起
 */
export function composePhrase(rand: () => number, notes = 8): MusicNote[] {
  const out: MusicNote[] = [];
  let tick = 0;
  let octave = 0;
  for (let i = 0; i < notes; i++) {
    const degree = PENTATONIC[Math.floor(rand() * PENTATONIC.length)]!;
    // 偶尔跳一个八度，一直在同一个八度里绕会很快显得单调
    if (rand() < 0.25) octave = rand() < 0.5 ? 0 : 1;
    const f = semitone(degree + octave * 12);
    out.push({
      atTick: tick,
      spec: {
        noiseDuration: 0, cutoff: 2000,
        // 结束频率略低于起始：一点点下滑，听着像拨弦的余韵
        toneStart: f, toneEnd: f * 0.995,
        toneDuration: 1.6 + rand() * 1.2,
        gain: 0.11 + rand() * 0.05,
      },
    });
    // 音符间距不均。等距的话会立刻听成节拍器
    tick += Math.round(14 + rand() * 26);
  }
  return out;
}

/** 两段音乐之间的间隔，照 MC 的量级：很久才响一次 */
export const MUSIC_MIN_GAP_TICKS = 20 * 150;
export const MUSIC_RANGE_TICKS = 20 * 300;

/**
 * 环境音与音乐的调度器。**纯逻辑** —— 只回答"这一刻该响什么"，
 * 不负责播。
 */
export class AmbienceScheduler {
  private nextAmbientTick = 0;
  private nextMusicTick = 0;
  private phrase: MusicNote[] = [];
  private phraseStart = 0;
  private phraseCursor = 0;

  private readonly rand: () => number;

  constructor(rand: () => number) {
    // 参数属性（`constructor(private readonly rand)`）在本项目里不能用 ——
    // tsconfig 开了 erasableSyntaxOnly，而参数属性是要生成代码的语法。
    // 开发期靠 Node 现场剥离类型跑，剥不掉的语法直接就崩了
    this.rand = rand;
    // 开局不要立刻响。刚进游戏就来一段音乐会显得很突兀
    this.nextAmbientTick = AMBIENT_MIN_INTERVAL_TICKS;
    this.nextMusicTick = MUSIC_MIN_GAP_TICKS;
  }

  /**
   * 推进一刻，返回这一刻要播的音效（可能有多个：环境音 + 音符）。
   *
   * @param tick     当前刻
   * @param y        玩家所在高度
   * @param skyLight 玩家脚下的天光等级
   */
  tick(tick: number, y: number, skyLight: number): SoundSpec[] {
    const out: SoundSpec[] = [];

    // 洞穴环境音：地下 + 暗
    if (tick >= this.nextAmbientTick) {
      if (y < AMBIENT_MAX_Y && skyLight <= AMBIENT_MAX_SKYLIGHT) {
        const id = AMBIENT_IDS[Math.floor(this.rand() * AMBIENT_IDS.length)]!;
        out.push(AMBIENT[id]!);
      }
      // 条件不满足也要往后推，否则一出洞就攒了一堆待播的音，
      // 下次进洞会连着响好几声
      this.nextAmbientTick = tick + AMBIENT_MIN_INTERVAL_TICKS
        + Math.floor(this.rand() * AMBIENT_RANGE_TICKS);
    }

    // 背景音乐
    if (this.phrase.length === 0 && tick >= this.nextMusicTick) {
      this.phrase = composePhrase(this.rand);
      this.phraseStart = tick;
      this.phraseCursor = 0;
    }
    while (this.phraseCursor < this.phrase.length
      && tick - this.phraseStart >= this.phrase[this.phraseCursor]!.atTick) {
      out.push(this.phrase[this.phraseCursor]!.spec);
      this.phraseCursor++;
    }
    if (this.phrase.length > 0 && this.phraseCursor >= this.phrase.length) {
      this.phrase = [];
      this.nextMusicTick = tick + MUSIC_MIN_GAP_TICKS
        + Math.floor(this.rand() * MUSIC_RANGE_TICKS);
    }
    return out;
  }
}
