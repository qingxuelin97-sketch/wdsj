/**
 * 视锥剔除。
 *
 * 用 Gribb-Hartmann 法直接从 viewProjection 矩阵里提取六个裁剪平面 ——
 * 不需要单独维护相机的近远平面参数，改 FOV 或渲染距离时不会忘了同步。
 *
 * 平面方程存成 (a,b,c,d)，点在平面正侧的判据是 a*x+b*y+c*z+d >= 0。
 */

export class Frustum {
  /** 6 个平面 × 4 个系数，预分配，每帧原地更新 */
  private readonly planes = new Float32Array(24);

  /**
   * 从列主序的 viewProjection 矩阵更新六个平面。
   * 平面顺序：左 右 下 上 近 远。
   */
  update(m: Float32Array): void {
    const m0 = m[0]!, m1 = m[1]!, m2 = m[2]!, m3 = m[3]!;
    const m4 = m[4]!, m5 = m[5]!, m6 = m[6]!, m7 = m[7]!;
    const m8 = m[8]!, m9 = m[9]!, m10 = m[10]!, m11 = m[11]!;
    const m12 = m[12]!, m13 = m[13]!, m14 = m[14]!, m15 = m[15]!;
    const p = this.planes;

    // 左 = row3 + row0
    p[0] = m3 + m0; p[1] = m7 + m4; p[2] = m11 + m8; p[3] = m15 + m12;
    // 右 = row3 - row0
    p[4] = m3 - m0; p[5] = m7 - m4; p[6] = m11 - m8; p[7] = m15 - m12;
    // 下 = row3 + row1
    p[8] = m3 + m1; p[9] = m7 + m5; p[10] = m11 + m9; p[11] = m15 + m13;
    // 上 = row3 - row1
    p[12] = m3 - m1; p[13] = m7 - m5; p[14] = m11 - m9; p[15] = m15 - m13;
    // 近 = row3 + row2
    p[16] = m3 + m2; p[17] = m7 + m6; p[18] = m11 + m10; p[19] = m15 + m14;
    // 远 = row3 - row2
    p[20] = m3 - m2; p[21] = m7 - m6; p[22] = m11 - m10; p[23] = m15 - m14;

    // 归一化，这样平面到点的距离才有几何意义（做球体测试时需要）
    for (let i = 0; i < 6; i++) {
      const o = i * 4;
      const len = Math.hypot(p[o]!, p[o + 1]!, p[o + 2]!);
      if (len === 0) continue;
      const inv = 1 / len;
      p[o] = p[o]! * inv;
      p[o + 1] = p[o + 1]! * inv;
      p[o + 2] = p[o + 2]! * inv;
      p[o + 3] = p[o + 3]! * inv;
    }
  }

  /**
   * 包围盒是否可能可见。
   * 用"最正 n 点"判据：只要某个平面把整个盒子都排除在外，就一定不可见。
   * 这会产生少量假阳性（角落情况），但绝不会误剔可见物，正是剔除想要的偏向。
   */
  intersectsAabb(
    minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number,
  ): boolean {
    const p = this.planes;
    for (let i = 0; i < 6; i++) {
      const o = i * 4;
      const a = p[o]!;
      const b = p[o + 1]!;
      const c = p[o + 2]!;
      const d = p[o + 3]!;
      // 取盒子在该平面法线方向上最远的那个角
      const px = a >= 0 ? maxX : minX;
      const py = b >= 0 ? maxY : minY;
      const pz = c >= 0 ? maxZ : minZ;
      if (a * px + b * py + c * pz + d < 0) return false;
    }
    return true;
  }
}
