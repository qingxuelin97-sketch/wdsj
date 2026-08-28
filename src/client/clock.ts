/**
 * 渲染时钟。
 *
 * 这是全客户端唯一允许读挂钟的地方。渲染与网格化代码一律禁止调用 performance.now() /
 * Date.now()（由 tools/lint-layers.mjs 强制），所有动画相位 —— 水/岩浆/火/传送门的贴图帧、
 * 云漂移、太阳角度、生物待机、手持晃动 —— 都必须从 renderTick 派生。
 *
 * 这样 freeze() 一停，画面就完全静止，截图才可逐帧复现，回归测试才能成立。
 */

export class Clock {
  /** 渲染帧计数。freeze 时不再前进 */
  renderTick = 0;
  /** 上一帧的真实间隔（秒），已做上限截断 */
  dt = 0;
  /** 冻结开关，由 __mc.freeze() 控制 */
  frozen = false;
  /** 固定步长模式：每帧固定推进 1/60 秒，忽略真实耗时。用于可复现的自动化跑测 */
  fixedTimestep = false;

  private lastMs = 0;
  private started = false;
  private frameTimes: number[] = [];
  private fpsValue = 0;

  /** 每帧调用一次。nowMs 由调用方从 rAF 传入，这样时钟本身也不隐式依赖挂钟 */
  advance(nowMs: number): void {
    if (!this.started) {
      this.started = true;
      this.lastMs = nowMs;
      return;
    }
    const rawDt = (nowMs - this.lastMs) / 1000;
    this.lastMs = nowMs;

    // 统计 fps 用真实耗时，即使处于冻结状态也要统计
    this.frameTimes.push(rawDt);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
    let sum = 0;
    for (const t of this.frameTimes) sum += t;
    this.fpsValue = sum > 0 ? this.frameTimes.length / sum : 0;

    if (this.frozen) {
      this.dt = 0;
      return;
    }
    // 截断长间隔：切标签页回来时不应该让世界瞬移
    this.dt = this.fixedTimestep ? 1 / 60 : Math.min(rawDt, 0.1);
    this.renderTick++;
  }

  /** 冻结状态下手动推进若干帧，供自动化脚本逐帧驱动 */
  stepFrames(n: number): void {
    this.renderTick += n;
  }

  get fps(): number {
    return this.fpsValue;
  }

  get frameMs(): number {
    return this.fpsValue > 0 ? 1000 / this.fpsValue : 0;
  }

  /** 动画相位：给定周期（帧数），返回 [0,1) */
  phase(periodFrames: number): number {
    return (this.renderTick % periodFrames) / periodFrames;
  }
}
