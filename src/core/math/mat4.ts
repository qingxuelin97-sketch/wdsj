/**
 * 4x4 矩阵，列主序（与 WebGL 的 uniformMatrix4fv 直接对接，transpose 恒为 false）。
 *
 * 存储布局（下标）：
 *   0  4  8  12
 *   1  5  9  13
 *   2  6  10 14
 *   3  7  11 15
 *
 * 与 vec3 一样：(out, ...) -> out，永不分配。
 */

export type Mat4 = Float32Array;

export function create(): Mat4 {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

export function identity(out: Mat4): Mat4 {
  out.fill(0);
  out[0] = 1;
  out[5] = 1;
  out[10] = 1;
  out[15] = 1;
  return out;
}

export function copy(out: Mat4, a: Mat4): Mat4 {
  out.set(a);
  return out;
}

/** out = a * b（先应用 b，再应用 a） */
export function multiply(out: Mat4, a: Mat4, b: Mat4): Mat4 {
  const a00 = a[0]!, a01 = a[1]!, a02 = a[2]!, a03 = a[3]!;
  const a10 = a[4]!, a11 = a[5]!, a12 = a[6]!, a13 = a[7]!;
  const a20 = a[8]!, a21 = a[9]!, a22 = a[10]!, a23 = a[11]!;
  const a30 = a[12]!, a31 = a[13]!, a32 = a[14]!, a33 = a[15]!;

  for (let i = 0; i < 4; i++) {
    const b0 = b[i * 4]!;
    const b1 = b[i * 4 + 1]!;
    const b2 = b[i * 4 + 2]!;
    const b3 = b[i * 4 + 3]!;
    out[i * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  }
  return out;
}

export function translate(out: Mat4, a: Mat4, x: number, y: number, z: number): Mat4 {
  if (out !== a) out.set(a);
  out[12] = a[0]! * x + a[4]! * y + a[8]! * z + a[12]!;
  out[13] = a[1]! * x + a[5]! * y + a[9]! * z + a[13]!;
  out[14] = a[2]! * x + a[6]! * y + a[10]! * z + a[14]!;
  out[15] = a[3]! * x + a[7]! * y + a[11]! * z + a[15]!;
  return out;
}

export function scale(out: Mat4, a: Mat4, x: number, y: number, z: number): Mat4 {
  out[0] = a[0]! * x; out[1] = a[1]! * x; out[2] = a[2]! * x; out[3] = a[3]! * x;
  out[4] = a[4]! * y; out[5] = a[5]! * y; out[6] = a[6]! * y; out[7] = a[7]! * y;
  out[8] = a[8]! * z; out[9] = a[9]! * z; out[10] = a[10]! * z; out[11] = a[11]! * z;
  out[12] = a[12]!; out[13] = a[13]!; out[14] = a[14]!; out[15] = a[15]!;
  return out;
}

export function rotateX(out: Mat4, a: Mat4, rad: number): Mat4 {
  const s = Math.sin(rad);
  const c = Math.cos(rad);
  const a10 = a[4]!, a11 = a[5]!, a12 = a[6]!, a13 = a[7]!;
  const a20 = a[8]!, a21 = a[9]!, a22 = a[10]!, a23 = a[11]!;
  if (out !== a) {
    out[0] = a[0]!; out[1] = a[1]!; out[2] = a[2]!; out[3] = a[3]!;
    out[12] = a[12]!; out[13] = a[13]!; out[14] = a[14]!; out[15] = a[15]!;
  }
  out[4] = a10 * c + a20 * s; out[5] = a11 * c + a21 * s;
  out[6] = a12 * c + a22 * s; out[7] = a13 * c + a23 * s;
  out[8] = a20 * c - a10 * s; out[9] = a21 * c - a11 * s;
  out[10] = a22 * c - a12 * s; out[11] = a23 * c - a13 * s;
  return out;
}

export function rotateY(out: Mat4, a: Mat4, rad: number): Mat4 {
  const s = Math.sin(rad);
  const c = Math.cos(rad);
  const a00 = a[0]!, a01 = a[1]!, a02 = a[2]!, a03 = a[3]!;
  const a20 = a[8]!, a21 = a[9]!, a22 = a[10]!, a23 = a[11]!;
  if (out !== a) {
    out[4] = a[4]!; out[5] = a[5]!; out[6] = a[6]!; out[7] = a[7]!;
    out[12] = a[12]!; out[13] = a[13]!; out[14] = a[14]!; out[15] = a[15]!;
  }
  out[0] = a00 * c - a20 * s; out[1] = a01 * c - a21 * s;
  out[2] = a02 * c - a22 * s; out[3] = a03 * c - a23 * s;
  out[8] = a00 * s + a20 * c; out[9] = a01 * s + a21 * c;
  out[10] = a02 * s + a22 * c; out[11] = a03 * s + a23 * c;
  return out;
}

export function rotateZ(out: Mat4, a: Mat4, rad: number): Mat4 {
  const s = Math.sin(rad);
  const c = Math.cos(rad);
  const a00 = a[0]!, a01 = a[1]!, a02 = a[2]!, a03 = a[3]!;
  const a10 = a[4]!, a11 = a[5]!, a12 = a[6]!, a13 = a[7]!;
  if (out !== a) {
    out[8] = a[8]!; out[9] = a[9]!; out[10] = a[10]!; out[11] = a[11]!;
    out[12] = a[12]!; out[13] = a[13]!; out[14] = a[14]!; out[15] = a[15]!;
  }
  out[0] = a00 * c + a10 * s; out[1] = a01 * c + a11 * s;
  out[2] = a02 * c + a12 * s; out[3] = a03 * c + a13 * s;
  out[4] = a10 * c - a00 * s; out[5] = a11 * c - a01 * s;
  out[6] = a12 * c - a02 * s; out[7] = a13 * c - a03 * s;
  return out;
}

/** 右手系透视投影，深度映射到 [-1,1]（WebGL 约定） */
export function perspective(out: Mat4, fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[11] = -1;
  const nf = 1 / (near - far);
  out[10] = (far + near) * nf;
  out[14] = 2 * far * near * nf;
  return out;
}

export function ortho(out: Mat4, left: number, right: number, bottom: number, top: number, near: number, far: number): Mat4 {
  out.fill(0);
  const lr = 1 / (left - right);
  const bt = 1 / (bottom - top);
  const nf = 1 / (near - far);
  out[0] = -2 * lr;
  out[5] = -2 * bt;
  out[10] = 2 * nf;
  out[12] = (left + right) * lr;
  out[13] = (top + bottom) * bt;
  out[14] = (far + near) * nf;
  out[15] = 1;
  return out;
}

/** 由眼点/目标/上方向构造视图矩阵 */
export function lookAt(out: Mat4, eye: Float32Array, center: Float32Array, up: Float32Array): Mat4 {
  const ex = eye[0]!, ey = eye[1]!, ez = eye[2]!;
  let zx = ex - center[0]!;
  let zy = ey - center[1]!;
  let zz = ez - center[2]!;
  let len = Math.hypot(zx, zy, zz);
  if (len === 0) {
    return identity(out);
  }
  len = 1 / len;
  zx *= len; zy *= len; zz *= len;

  const ux = up[0]!, uy = up[1]!, uz = up[2]!;
  let xx = uy * zz - uz * zy;
  let xy = uz * zx - ux * zz;
  let xz = ux * zy - uy * zx;
  len = Math.hypot(xx, xy, xz);
  if (len === 0) {
    xx = 0; xy = 0; xz = 0;
  } else {
    len = 1 / len;
    xx *= len; xy *= len; xz *= len;
  }

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * ex + xy * ey + xz * ez);
  out[13] = -(yx * ex + yy * ey + yz * ez);
  out[14] = -(zx * ex + zy * ey + zz * ez);
  out[15] = 1;
  return out;
}

/**
 * 由相机位置与偏航/俯仰直接构造视图矩阵。
 * MC 约定：yaw 0 朝 +Z，向右为正；pitch 正值向下看。
 */
export function fromCamera(out: Mat4, x: number, y: number, z: number, yaw: number, pitch: number): Mat4 {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  // 前 = (-sin yaw * cos pitch, -sin pitch, cos yaw * cos pitch)，与 vec3.fromYawPitch 一致
  const fx = -sy * cp, fy = -sp, fz = cy * cp;
  // 右 = 前 × 上 = (-cos yaw, 0, -sin yaw)
  // 注意符号：面朝南(+Z)时右手指向西(-X)，所以 x 分量是 -cos yaw 而非 +cos yaw。
  // 符号写反不会破坏正交性，只会让画面左右镜像，必须靠与 lookAt 的交叉验证才能发现。
  const rx = -cy, ry = 0, rz = -sy;
  // 上 = 右 × 前
  const ux = -sy * sp, uy = cp, uz = cy * sp;
  // 视图矩阵的基是世界基的转置，第三列取 -前
  out[0] = rx; out[1] = ux; out[2] = -fx; out[3] = 0;
  out[4] = ry; out[5] = uy; out[6] = -fy; out[7] = 0;
  out[8] = rz; out[9] = uz; out[10] = -fz; out[11] = 0;
  out[12] = -(rx * x + ry * y + rz * z);
  out[13] = -(ux * x + uy * y + uz * z);
  out[14] = fx * x + fy * y + fz * z;
  out[15] = 1;
  return out;
}

export function transpose(out: Mat4, a: Mat4): Mat4 {
  if (out === a) {
    let t: number;
    t = a[1]!; out[1] = a[4]!; out[4] = t;
    t = a[2]!; out[2] = a[8]!; out[8] = t;
    t = a[3]!; out[3] = a[12]!; out[12] = t;
    t = a[6]!; out[6] = a[9]!; out[9] = t;
    t = a[7]!; out[7] = a[13]!; out[13] = t;
    t = a[11]!; out[11] = a[14]!; out[14] = t;
    return out;
  }
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) out[i * 4 + j] = a[j * 4 + i]!;
  return out;
}

/** 求逆；奇异矩阵返回 null 并保持 out 不变 */
export function invert(out: Mat4, a: Mat4): Mat4 | null {
  const a00 = a[0]!, a01 = a[1]!, a02 = a[2]!, a03 = a[3]!;
  const a10 = a[4]!, a11 = a[5]!, a12 = a[6]!, a13 = a[7]!;
  const a20 = a[8]!, a21 = a[9]!, a22 = a[10]!, a23 = a[11]!;
  const a30 = a[12]!, a31 = a[13]!, a32 = a[14]!, a33 = a[15]!;

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (det === 0) return null;
  det = 1 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}
