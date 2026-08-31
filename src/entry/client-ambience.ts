/**
 * 环境音与背景音乐的驱动。
 *
 * 从 `client-main.ts` 分出来的（那个文件第七次顶到 600 行硬上限）。
 * 调度逻辑本身在 `core/audio/ambience.ts`（纯的、可单测），
 * 这里只做两件事：**按服务端刻推进**，以及把结果交给 WebAudio。
 *
 * ## 为什么按服务端刻而不是按帧
 *
 * 按帧走的话，帧率一变节奏就变 —— 60fps 的机器上洞穴音一分钟响一次，
 * 6fps 的机器上要十分钟。而且 `freeze()` 停住的是渲染，服务端照常跑，
 * 截图回归期间会一直有声音在排期。
 *
 * 这与"渲染代码禁止读挂钟"（RULES 第 4 条）是同一条纪律的另一面：
 * **任何有节奏的东西都必须挂在某个刻上**，不能挂在帧或挂钟上。
 */
import { AmbienceScheduler } from '../core/audio/ambience.ts';
import { mulberry32 } from '../core/rng/mulberry.ts';
import type { AudioEngine } from '../client/audio/audio-engine.ts';

export interface AmbienceDeps {
  readonly audio: AudioEngine;
  /** 玩家所在方块坐标 */
  playerBlock(): { x: number; y: number; z: number };
  /** 某一格的天光等级 */
  skyLightAt(x: number, y: number, z: number): number;
}

export class ClientAmbience {
  private readonly scheduler: AmbienceScheduler;
  private lastTick = -1;
  private readonly d: AmbienceDeps;

  constructor(d: AmbienceDeps) {
    this.d = d;
    // 固定种子，不用 Math.random —— 同一个种子跑两次事件序列相同，
    // 否则音频回归无从做起
    this.scheduler = new AmbienceScheduler(mulberry32(0x51ed270b));
  }

  /** 每帧调，内部按刻去重 */
  update(serverTick: number): void {
    if (serverTick === this.lastTick) return;
    this.lastTick = serverTick;
    const p = this.d.playerBlock();
    for (const spec of this.scheduler.tick(serverTick, p.y, this.d.skyLightAt(p.x, p.y, p.z))) {
      this.d.audio.play(spec, 0, 1);
    }
  }
}
