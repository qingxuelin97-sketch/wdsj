/**
 * 三维向量。
 *
 * 约定：所有函数都是 (out, ...) -> out 的形式，永不分配。热路径（每帧/每 tick）里调用者
 * 必须自备 scratch —— 见 docs/RULES.md 第 9 条。
 */

export type Vec3 = Float32Array;

export function create(x = 0, y = 0, z = 0): Vec3 {
  const v = new Float32Array(3);
  v[0] = x;
  v[1] = y;
  v[2] = z;
  return v;
}

export function set(out: Vec3, x: number, y: number, z: number): Vec3 {
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

export function copy(out: Vec3, a: Vec3): Vec3 {
  out[0] = a[0]!;
  out[1] = a[1]!;
  out[2] = a[2]!;
  return out;
}

export function add(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out[0] = a[0]! + b[0]!;
  out[1] = a[1]! + b[1]!;
  out[2] = a[2]! + b[2]!;
  return out;
}

export function sub(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out[0] = a[0]! - b[0]!;
  out[1] = a[1]! - b[1]!;
  out[2] = a[2]! - b[2]!;
  return out;
}

export function mul(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out[0] = a[0]! * b[0]!;
  out[1] = a[1]! * b[1]!;
  out[2] = a[2]! * b[2]!;
  return out;
}

export function scale(out: Vec3, a: Vec3, s: number): Vec3 {
  out[0] = a[0]! * s;
  out[1] = a[1]! * s;
  out[2] = a[2]! * s;
  return out;
}

/** out = a + b*s，避免临时向量 */
export function scaleAndAdd(out: Vec3, a: Vec3, b: Vec3, s: number): Vec3 {
  out[0] = a[0]! + b[0]! * s;
  out[1] = a[1]! + b[1]! * s;
  out[2] = a[2]! + b[2]! * s;
  return out;
}

export function negate(out: Vec3, a: Vec3): Vec3 {
  out[0] = -a[0]!;
  out[1] = -a[1]!;
  out[2] = -a[2]!;
  return out;
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

export function cross(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  const ax = a[0]!;
  const ay = a[1]!;
  const az = a[2]!;
  const bx = b[0]!;
  const by = b[1]!;
  const bz = b[2]!;
  out[0] = ay * bz - az * by;
  out[1] = az * bx - ax * bz;
  out[2] = ax * by - ay * bx;
  return out;
}

export function lengthSq(a: Vec3): number {
  return a[0]! * a[0]! + a[1]! * a[1]! + a[2]! * a[2]!;
}

export function length(a: Vec3): number {
  return Math.hypot(a[0]!, a[1]!, a[2]!);
}

export function distanceSq(a: Vec3, b: Vec3): number {
  const dx = a[0]! - b[0]!;
  const dy = a[1]! - b[1]!;
  const dz = a[2]! - b[2]!;
  return dx * dx + dy * dy + dz * dz;
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
}

export function normalize(out: Vec3, a: Vec3): Vec3 {
  const len = Math.hypot(a[0]!, a[1]!, a[2]!);
  if (len === 0) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    return out;
  }
  const inv = 1 / len;
  out[0] = a[0]! * inv;
  out[1] = a[1]! * inv;
  out[2] = a[2]! * inv;
  return out;
}

export function lerp(out: Vec3, a: Vec3, b: Vec3, t: number): Vec3 {
  out[0] = a[0]! + (b[0]! - a[0]!) * t;
  out[1] = a[1]! + (b[1]! - a[1]!) * t;
  out[2] = a[2]! + (b[2]! - a[2]!) * t;
  return out;
}

/** 用 4x4 矩阵变换点（含平移，按 w 除） */
export function transformMat4(out: Vec3, a: Vec3, m: Float32Array): Vec3 {
  const x = a[0]!;
  const y = a[1]!;
  const z = a[2]!;
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]! || 1;
  out[0] = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w;
  out[1] = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w;
  out[2] = (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) / w;
  return out;
}

export function equals(a: Vec3, b: Vec3, eps = 1e-6): boolean {
  return (
    Math.abs(a[0]! - b[0]!) <= eps &&
    Math.abs(a[1]! - b[1]!) <= eps &&
    Math.abs(a[2]! - b[2]!) <= eps
  );
}

/** 由偏航/俯仰（弧度）求单位朝向向量。MC 约定：yaw 绕 Y 轴，0 指向 +Z */
export function fromYawPitch(out: Vec3, yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  out[0] = -cp * Math.sin(yaw);
  out[1] = -Math.sin(pitch);
  out[2] = cp * Math.cos(yaw);
  return out;
}
