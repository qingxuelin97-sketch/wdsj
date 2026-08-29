/**
 * 本地玩家：把键鼠输入喂给 core 的物理，再把结果写进相机。
 *
 * 物理走的是 `core/physics/entity-physics.ts` —— 和服务端模拟、生物 AI
 * 是同一段代码。客户端**不重写**一份"差不多的"物理，那是漂移的开始。
 *
 * 两种模式：
 *   physics  正常游玩，有重力、碰撞、跳跃
 *   detached 自由相机，穿墙、无重力。截图回归与调试用 ——
 *            `__mc.setCamera` 会自动切到这个模式，否则相机刚摆好就掉下去了。
 */
import type { Camera } from '../camera.ts';
import type { InputSnapshot } from '../input/input.ts';
import type { BlockView } from '../../core/world/block-view.ts';
import {
  makeBody, emptyInput, stepBody,
  type Body, type MoveInput, type PhysicsTables,
} from '../../core/physics/entity-physics.ts';
import {
  EYE_HEIGHT, EYE_HEIGHT_SNEAK, MS_PER_TICK, PLAYER_HEIGHT,
} from '../../core/constants.ts';

/** 俯仰角上限，略小于 90° —— 正好 90° 会让视图矩阵退化 */
const PITCH_LIMIT = Math.PI / 2 - 1e-3;
/** 一帧最多补几个物理 tick。卡顿之后不要一次性把欠账全补上，那会瞬移 */
const MAX_CATCHUP_TICKS = 5;

export type PlayerMode = 'physics' | 'detached';

export class LocalPlayer {
  readonly body: Body;
  mode: PlayerMode = 'physics';
  /** 累积的时间，够一个 tick 就跑一步物理 */
  private accumulatorMs = 0;
  /**
   * 上一 tick 结束时的位置。
   *
   * 物理固定 20 Hz，而画面可能跑 120 fps —— 直接把身体位置喂给相机的话，
   * 每 6 帧才动一次，看上去就是 20 fps 的卡顿。MC 的做法是按 partialTick
   * 在上一 tick 与当前 tick 之间插值，这里照做。
   */
  private prevX = 0;
  private prevY = 0;
  private prevZ = 0;
  private readonly input: MoveInput = emptyInput();

  constructor(x: number, y: number, z: number) {
    this.body = makeBody(x, y, z);
  }

  /** 眼睛高度，潜行时略低 */
  get eyeHeight(): number {
    return this.input.sneak ? EYE_HEIGHT_SNEAK : EYE_HEIGHT;
  }

  /** 直接放到某个位置（传送 / 出生），并清空速度 */
  teleport(x: number, y: number, z: number): void {
    this.body.x = x;
    this.body.y = y;
    this.body.z = z;
    this.body.vx = 0;
    this.body.vy = 0;
    this.body.vz = 0;
    this.body.onGround = false;
    this.accumulatorMs = 0;
    this.prevX = x;
    this.prevY = y;
    this.prevZ = z;
  }

  /**
   * 推进一帧。
   *
   * 物理按**固定 20 Hz** 跑，与服务端同频。用可变的帧间隔直接积分的话，
   * 跳跃高度会随帧率变化 —— 高帧率跳得低、低帧率跳得高，而这正是
   * "手感说不出哪里怪"的经典来源。
   *
   * @param dtMs 距上一帧的毫秒数
   */
  update(
    camera: Camera,
    input: InputSnapshot,
    world: BlockView,
    tables: PhysicsTables,
    dtMs: number,
  ): void {
    // 视角始终跟鼠标走，两种模式都一样
    camera.yaw += input.dYaw;
    camera.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, camera.pitch + input.dPitch));

    if (this.mode === 'detached') {
      // 自由相机：位置由外部（测试钩子或自由飞行）决定，这里只同步身体
      this.body.x = camera.position[0]!;
      this.body.y = camera.position[1]! - EYE_HEIGHT;
      this.body.z = camera.position[2]!;
      this.accumulatorMs = 0;
      return;
    }

    this.body.yaw = camera.yaw;
    this.input.forward = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
    this.input.strafe = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    this.input.jump = input.up;
    this.input.sneak = input.sneak;
    // 只有真的在往前走才算疾跑，站着按 Ctrl 不该加速
    this.input.sprint = input.sprint && this.input.forward > 0 && !input.sneak;

    this.accumulatorMs += dtMs;
    let steps = 0;
    while (this.accumulatorMs >= MS_PER_TICK && steps < MAX_CATCHUP_TICKS) {
      this.prevX = this.body.x;
      this.prevY = this.body.y;
      this.prevZ = this.body.z;
      stepBody(world, tables, this.body, this.input);
      this.accumulatorMs -= MS_PER_TICK;
      steps++;
    }
    if (steps === MAX_CATCHUP_TICKS) {
      // 欠账太多就直接丢掉，别一次补十几步 —— 那会表现为一次明显的瞬移
      this.accumulatorMs = 0;
    }

    // 按 partialTick 插值，画面才不会是 20 Hz 的一顿一顿
    const alpha = Math.min(1, this.accumulatorMs / MS_PER_TICK);
    camera.setPosition(
      this.prevX + (this.body.x - this.prevX) * alpha,
      this.prevY + (this.body.y - this.prevY) * alpha + this.eyeHeight,
      this.prevZ + (this.body.z - this.prevZ) * alpha,
    );
  }

  /** 玩家碰撞盒的顶部世界坐标，供调试面板显示 */
  get headY(): number {
    return this.body.y + PLAYER_HEIGHT;
  }
}
