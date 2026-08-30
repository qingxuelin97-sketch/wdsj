/**
 * 天气状态机。纯逻辑，不碰世界。
 *
 * 两条**互相独立**的计时器：下雨、打雷。各自倒数，归零就翻面，
 * 然后按新状态重新抽一个时长。雷暴不是"雨的加强版"，它是叠在雨上的
 * 第二个状态 —— 所以"打雷但没下雨"在状态上是可能的，只是表现上
 * （闪电、天色）要求两个同时成立。
 *
 * 时长全部照抄 MC 1.0：
 *
 *   | 当前 | 下一段时长（刻） | 折合真实时间 |
 *   |---|---|---|
 *   | 正在下雨 | nextInt(12000) + 12000 | 10 – 20 分钟 |
 *   | 没下雨   | nextInt(168000) + 12000 | 10 – 150 分钟 |
 *   | 正在打雷 | nextInt(12000) + 3600  | 3 – 13 分钟 |
 *   | 没打雷   | nextInt(168000) + 12000 | 10 – 150 分钟 |
 *
 * 这些数字定义的是**节奏**：晴天平均一个多小时，雨下十几分钟。
 * 调快了天气变成噪音，调慢了玩家一辈子见不到雷暴。照抄。
 *
 * 另外还有一个"强度"，每刻 ±0.01 地爬向 0 或 1，也就是**100 刻(5 秒)
 * 淡入淡出**。天不会一瞬间黑下来 —— 这 5 秒是整个天气系统里唯一
 * 让人觉得"天变了"而不是"画面切了"的东西。
 */
import { JavaRandom } from '../rng/java-random.ts';

/** 强度每刻的变化量。100 刻 = 5 秒淡入淡出 */
const STRENGTH_STEP = 0.01;

export interface WeatherSnapshot {
  readonly raining: boolean;
  readonly thundering: boolean;
  /** 0..1，平滑过渡后的雨强度。渲染与光照读这个，不读 raining */
  readonly rainStrength: number;
  /** 0..1，平滑过渡后的雷暴强度 */
  readonly thunderStrength: number;
}

export class Weather {
  raining = false;
  thundering = false;
  /** 剩余多少刻翻面。<= 0 表示"该抽一个新时长了" */
  rainTime = 0;
  thunderTime = 0;
  rainStrength = 0;
  thunderStrength = 0;

  /**
   * 推进一刻。
   *
   * @param rng 世界的共享随机源。天气必须用它而不是自己开一个 ——
   *            同一个种子、同一串操作要给出同一串天气，否则存读之后
   *            "接着玩"会和"一直玩"分叉
   */
  tick(rng: JavaRandom): void {
    this.thunderTime = advanceTimer(
      this.thunderTime, this.thundering, rng,
      12000, 3600, 168000, 12000,
      (on) => { this.thundering = on; },
    );
    this.rainTime = advanceTimer(
      this.rainTime, this.raining, rng,
      12000, 12000, 168000, 12000,
      (on) => { this.raining = on; },
    );

    this.rainStrength = ramp(this.rainStrength, this.raining);
    this.thunderStrength = ramp(this.thunderStrength, this.thundering);
  }

  snapshot(): WeatherSnapshot {
    return {
      raining: this.raining,
      thundering: this.thundering,
      rainStrength: this.rainStrength,
      // 雷暴的表现要**同时**下雨才成立：闪电只在雨天劈，天色也只在雨天压暗。
      // 状态上两者独立，表现上取交集 —— 这样"雷暴计时器在晴天走完"
      // 不会凭空让天黑一下
      thunderStrength: Math.min(this.thunderStrength, this.rainStrength),
    };
  }

  /** 立刻切到某个天气，并给一个像样的时长。指令与测试用 */
  set(raining: boolean, thundering: boolean, ticks = 12000): void {
    this.raining = raining;
    this.thundering = thundering;
    this.rainTime = ticks;
    this.thunderTime = ticks;
  }

  /** 强度直接拉到位，不等 5 秒淡入。截图回归要用 —— 它等不起 */
  snapStrength(): void {
    this.rainStrength = this.raining ? 1 : 0;
    this.thunderStrength = this.thundering ? 1 : 0;
  }
}

/**
 * 一条计时器的推进。
 *
 * 注意"归零"与"翻面"是**分两刻**做的，这是 MC 的形状：这一刻数到 0 就翻面，
 * 下一刻才发现 <= 0 而抽新时长。照抄是因为差这一刻会让计时长度整体偏移，
 * 而天气本来就没有别的可观察量能告诉你偏了。
 */
function advanceTimer(
  time: number, on: boolean, rng: JavaRandom,
  onSpread: number, onBase: number, offSpread: number, offBase: number,
  setOn: (v: boolean) => void,
): number {
  if (time <= 0) {
    return on ? rng.nextInt(onSpread) + onBase : rng.nextInt(offSpread) + offBase;
  }
  const next = time - 1;
  if (next <= 0) setOn(!on);
  return next;
}

function ramp(value: number, up: boolean): number {
  const next = up ? value + STRENGTH_STEP : value - STRENGTH_STEP;
  return Math.min(1, Math.max(0, next));
}
