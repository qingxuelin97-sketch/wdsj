/**
 * 相机。M0 是自由飞行相机；M6 接入玩家物理后会由玩家实体驱动，但视图矩阵的构造方式不变。
 *
 * 角度约定与 MC 一致：yaw 0 朝 +Z（南），pitch 正值向下看。
 */
import * as m4 from '../core/math/mat4.ts';
import * as v3 from '../core/math/vec3.ts';
import type { InputSnapshot } from './input/input.ts';

/** 俯仰上限，留一点余量避免在正上/正下方向出现万向节退化 */
const PITCH_LIMIT = Math.PI / 2 - 0.001;

export class Camera {
  readonly position = v3.create(0, 0, 0);
  yaw = 0;
  pitch = 0;
  fovDegrees = 70;
  near = 0.05;
  far = 512;

  readonly view = m4.create();
  readonly projection = m4.create();
  readonly viewProjection = m4.create();

  /** 复用的临时向量，避免每帧分配 */
  private readonly scratchForward = v3.create();
  private readonly scratchRight = v3.create();

  setPosition(x: number, y: number, z: number): void {
    v3.set(this.position, x, y, z);
  }

  setRotation(yaw: number, pitch: number): void {
    this.yaw = yaw;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
  }

  /** 单位朝向向量。返回的是内部 scratch，调用方不要长期持有 */
  forward(): v3.Vec3 {
    return v3.fromYawPitch(this.scratchForward, this.yaw, this.pitch);
  }

  /**
   * M0 的自由飞行控制。
   * @param dt 秒
   * @param speed 格/秒
   */
  applyFreeFlight(input: InputSnapshot, dt: number, speed: number): void {
    this.yaw += input.dYaw;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch + input.dPitch));

    // 水平前向（忽略俯仰），这样抬头时按 W 仍是水平前进，与创造模式飞行一致
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    const fx = -sy;
    const fz = cy;
    // 右向 = 前 × 上
    const rx = -cy;
    const rz = -sy;

    let mx = 0;
    let mz = 0;
    if (input.forward) { mx += fx; mz += fz; }
    if (input.back) { mx -= fx; mz -= fz; }
    if (input.right) { mx += rx; mz += rz; }
    if (input.left) { mx -= rx; mz -= rz; }

    const len = Math.hypot(mx, mz);
    if (len > 0) {
      mx /= len;
      mz /= len;
    }

    const v = speed * (input.sprint ? 3 : 1) * dt;
    this.position[0]! += mx * v;
    this.position[2]! += mz * v;
    if (input.up) this.position[1]! += v;
    if (input.down || input.sneak) this.position[1]! -= v;

    // 触碰一下 scratchRight，保证它参与到类型检查里（后续 M6 会用到侧向速度）
    v3.set(this.scratchRight, rx, 0, rz);
  }

  /** 重算 view / projection / viewProjection。每帧在渲染前调用一次 */
  update(aspect: number): void {
    m4.fromCamera(this.view, this.position[0]!, this.position[1]!, this.position[2]!, this.yaw, this.pitch);
    m4.perspective(this.projection, (this.fovDegrees * Math.PI) / 180, aspect, this.near, this.far);
    m4.multiply(this.viewProjection, this.projection, this.view);
  }
}
