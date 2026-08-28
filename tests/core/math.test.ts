/**
 * 数学库验证。
 *
 * 重点在矩阵：渲染出错时"画面不对"是极难定位的症状，所以这里用代数恒等式
 * （逆矩阵、结合律、基正交性）和与 lookAt 的交叉验证把 mat4 钉死，而不是
 * 比对一堆手算出来的数字。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v3 from '../../src/core/math/vec3.ts';
import * as m4 from '../../src/core/math/mat4.ts';

/**
 * 相对+绝对混合容差。
 *
 * 全部矩阵都是 Float32Array，有效精度约 1e-7 相对误差。矩阵的平移分量量级可达几十到几百
 * （世界坐标），此时纯绝对容差要么太松（掩盖真 bug）要么太紧（把 Float32 舍入误报成失败）。
 * 这里用 max(absEps, relEps*|b|)，relEps 留了约 100 倍 Float32 精度的余量。
 */
function assertClose(a: number, b: number, absEps = 1e-5, msg = '', relEps = 1e-5): void {
  const tol = Math.max(absEps, relEps * Math.abs(b));
  assert.ok(Math.abs(a - b) <= tol, `${msg} 期望 ${b}，实得 ${a}（容差 ${tol}）`);
}

function assertMatClose(a: m4.Mat4, b: m4.Mat4, absEps = 1e-5, msg = ''): void {
  for (let i = 0; i < 16; i++) assertClose(a[i]!, b[i]!, absEps, `${msg} [${i}]`);
}

/** 一个不平凡的测试矩阵：平移+旋转+缩放的复合 */
function sampleMatrix(): m4.Mat4 {
  const m = m4.create();
  m4.translate(m, m, 3, -7, 11);
  m4.rotateY(m, m, 0.7);
  m4.rotateX(m, m, -0.4);
  m4.rotateZ(m, m, 1.9);
  m4.scale(m, m, 2, 0.5, 3);
  return m;
}

test('vec3 基本运算', () => {
  const a = v3.create(1, 2, 3);
  const b = v3.create(4, 5, 6);
  const out = v3.create();

  assert.equal(v3.dot(a, b), 32);
  assert.deepEqual(Array.from(v3.cross(out, a, b)), [-3, 6, -3]);
  assert.deepEqual(Array.from(v3.add(out, a, b)), [5, 7, 9]);
  assert.deepEqual(Array.from(v3.sub(out, b, a)), [3, 3, 3]);
  assert.deepEqual(Array.from(v3.scaleAndAdd(out, a, b, 2)), [9, 12, 15]);
  assertClose(v3.length(v3.create(3, 4, 0)), 5);
  assertClose(v3.lengthSq(a), 14);
  assertClose(v3.distance(a, b), Math.sqrt(27));

  v3.normalize(out, v3.create(0, 3, 4));
  assertClose(v3.length(out), 1);
  // 零向量归一化不得产生 NaN
  v3.normalize(out, v3.create(0, 0, 0));
  assert.deepEqual(Array.from(out), [0, 0, 0]);
});

test('vec3.fromYawPitch 是单位向量，且方向符合 MC 约定', () => {
  const out = v3.create();
  // yaw=0, pitch=0 -> 朝 +Z
  v3.fromYawPitch(out, 0, 0);
  assert.ok(v3.equals(out, v3.create(0, 0, 1)), `实得 ${Array.from(out)}`);
  // yaw=PI/2 -> 朝 -X
  v3.fromYawPitch(out, Math.PI / 2, 0);
  assert.ok(v3.equals(out, v3.create(-1, 0, 0)), `实得 ${Array.from(out)}`);
  // pitch=PI/2 -> 朝 -Y（向下看）
  v3.fromYawPitch(out, 0, Math.PI / 2);
  assert.ok(v3.equals(out, v3.create(0, -1, 0)), `实得 ${Array.from(out)}`);

  for (let yaw = -3; yaw < 3; yaw += 0.37) {
    for (let pitch = -1.5; pitch < 1.5; pitch += 0.29) {
      v3.fromYawPitch(out, yaw, pitch);
      assertClose(v3.length(out), 1, 1e-5, `yaw=${yaw} pitch=${pitch}`);
    }
  }
});

test('mat4 单位元与结合律', () => {
  const id = m4.create();
  const a = sampleMatrix();
  const out = m4.create();

  assertMatClose(m4.multiply(out, id, a), a, 1e-5, 'I*a');
  assertMatClose(m4.multiply(out, a, id), a, 1e-5, 'a*I');

  const b = m4.create();
  m4.rotateZ(b, b, 0.3);
  m4.translate(b, b, 1, 2, 3);
  const c = m4.create();
  m4.scale(c, c, 1.5, 2.5, 0.5);

  const ab = m4.multiply(m4.create(), a, b);
  const bc = m4.multiply(m4.create(), b, c);
  const left = m4.multiply(m4.create(), ab, c);
  const right = m4.multiply(m4.create(), a, bc);
  assertMatClose(left, right, 1e-3, '(ab)c == a(bc)');
});

test('mat4.invert 与原矩阵相乘得单位阵', () => {
  const a = sampleMatrix();
  const inv = m4.invert(m4.create(), a);
  assert.ok(inv !== null, 'sampleMatrix 应可逆');
  const prod = m4.multiply(m4.create(), a, inv!);
  assertMatClose(prod, m4.create(), 1e-3, 'a * a^-1');

  // 奇异矩阵返回 null
  const singular = m4.create();
  m4.scale(singular, singular, 1, 0, 1);
  assert.equal(m4.invert(m4.create(), singular), null);
});

test('mat4.transpose 自反', () => {
  const a = sampleMatrix();
  const t = m4.transpose(m4.create(), a);
  const tt = m4.transpose(m4.create(), t);
  assertMatClose(tt, a, 1e-6, 'transpose 两次');
  // 原地转置也要正确
  const inPlace = m4.copy(m4.create(), a);
  m4.transpose(inPlace, inPlace);
  assertMatClose(inPlace, t, 1e-6, '原地转置');
});

test('perspective 把近/远平面映射到 -1 / +1', () => {
  const near = 0.1;
  const far = 1000;
  const p = m4.perspective(m4.create(), Math.PI / 3, 16 / 9, near, far);
  const out = v3.create();

  // 相机看向 -Z，所以近平面上的点是 z = -near
  v3.transformMat4(out, v3.create(0, 0, -near), p);
  assertClose(out[2]!, -1, 1e-4, '近平面 -> -1');
  v3.transformMat4(out, v3.create(0, 0, -far), p);
  assertClose(out[2]!, 1, 1e-3, '远平面 -> +1');
  // 中心点保持在中心
  assertClose(out[0]!, 0, 1e-6);
  assertClose(out[1]!, 0, 1e-6);
});

test('ortho 把包围盒映射到 NDC 立方体', () => {
  const o = m4.ortho(m4.create(), -2, 2, -1, 1, 0.5, 10);
  const out = v3.create();
  v3.transformMat4(out, v3.create(-2, -1, -0.5), o);
  assertClose(out[0]!, -1, 1e-5, 'left');
  assertClose(out[1]!, -1, 1e-5, 'bottom');
  assertClose(out[2]!, -1, 1e-5, 'near');
  v3.transformMat4(out, v3.create(2, 1, -10), o);
  assertClose(out[0]!, 1, 1e-5, 'right');
  assertClose(out[1]!, 1, 1e-5, 'top');
  assertClose(out[2]!, 1, 1e-5, 'far');
});

test('fromCamera 与 lookAt 一致 —— 交叉验证相机基', () => {
  // 注意：不能直接逐元素比对两个矩阵的平移列。lookAt 的输入 center 必须由 eye+forward
  // 构造并存进 Float32Array，它内部再做 eye-center 减回来 —— 这是典型的灾难性抵消：
  // 64+0.3 在 Float32 下的 ulp 是 7.6e-6，减回来 forward 的绝对误差就被放大到约 4e-6，
  // 再乘以 eye 分量 64，平移列的误差可达 2.6e-4。那是测试构造的误差，不是矩阵的错。
  //
  // 所以这里只对不受 eye 影响的旋转部分做紧比对，平移语义交给下面的等价点变换来验证。
  const eye = v3.create();
  const fwd = v3.create();
  const center = v3.create();
  const up = v3.create();
  const viaCamera = m4.create();
  const viaLookAt = m4.create();

  for (const [x, y, z] of [[0, 0, 0], [10, 64, -30], [-5.5, 2.25, 7.75]] as const) {
    for (let yaw = -3; yaw < 3.2; yaw += 0.53) {
      for (let pitch = -1.4; pitch < 1.4; pitch += 0.47) {
        const label = `pos=${[x, y, z]} yaw=${yaw.toFixed(2)} pitch=${pitch.toFixed(2)}`;
        v3.set(eye, x, y, z);
        v3.fromYawPitch(fwd, yaw, pitch);
        v3.add(center, eye, fwd);
        // 与 fromCamera 内部一致的上方向
        const cy = Math.cos(yaw), sy = Math.sin(yaw);
        const cp = Math.cos(pitch), sp = Math.sin(pitch);
        v3.set(up, -sy * sp, cp, cy * sp);

        m4.fromCamera(viaCamera, x, y, z, yaw, pitch);
        m4.lookAt(viaLookAt, eye, center, up);

        // 旋转部分：3x3 块，不含平移，可用紧容差
        for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) {
          assertClose(viaCamera[i]!, viaLookAt[i]!, 1e-5, `${label} 旋转[${i}]`);
        }
        assert.equal(viaCamera[15], 1, `${label} [15]`);

        // 平移语义：两个矩阵把同一批世界点变换到同一处
        const pa = v3.create();
        const pb = v3.create();
        for (const p of [v3.create(x, y, z), v3.create(x + 3, y - 2, z + 8), v3.create(0, 0, 0)]) {
          v3.transformMat4(pa, p, viaCamera);
          v3.transformMat4(pb, p, viaLookAt);
          for (let k = 0; k < 3; k++) assertClose(pa[k]!, pb[k]!, 1e-3, `${label} 点变换[${k}]`);
        }
      }
    }
  }
});

test('fromCamera 的旋转部分是正交阵，且把相机位置映到原点', () => {
  const m = m4.fromCamera(m4.create(), 12, -3, 40, 0.9, -0.35);
  // 三个基向量互相正交且为单位长
  const r = v3.create(m[0]!, m[4]!, m[8]!);
  const u = v3.create(m[1]!, m[5]!, m[9]!);
  const b = v3.create(m[2]!, m[6]!, m[10]!);
  assertClose(v3.length(r), 1, 1e-5, '|right|');
  assertClose(v3.length(u), 1, 1e-5, '|up|');
  assertClose(v3.length(b), 1, 1e-5, '|back|');
  assertClose(v3.dot(r, u), 0, 1e-5, 'right·up');
  assertClose(v3.dot(r, b), 0, 1e-5, 'right·back');
  assertClose(v3.dot(u, b), 0, 1e-5, 'up·back');

  const out = v3.create();
  v3.transformMat4(out, v3.create(12, -3, 40), m);
  assert.ok(v3.equals(out, v3.create(0, 0, 0), 1e-4), `相机位置应映到原点，实得 ${Array.from(out)}`);
});

test('translate/scale/rotate 与逐点变换语义一致', () => {
  const out = v3.create();
  const m = m4.create();
  m4.translate(m, m, 5, 6, 7);
  v3.transformMat4(out, v3.create(1, 2, 3), m);
  assert.ok(v3.equals(out, v3.create(6, 8, 10)), `平移 实得 ${Array.from(out)}`);

  m4.identity(m);
  m4.scale(m, m, 2, 3, 4);
  v3.transformMat4(out, v3.create(1, 1, 1), m);
  assert.ok(v3.equals(out, v3.create(2, 3, 4)), `缩放 实得 ${Array.from(out)}`);

  // 绕 Y 转 90 度：+X 轴 -> -Z 轴
  m4.identity(m);
  m4.rotateY(m, m, Math.PI / 2);
  v3.transformMat4(out, v3.create(1, 0, 0), m);
  assert.ok(v3.equals(out, v3.create(0, 0, -1), 1e-5), `rotateY 实得 ${Array.from(out)}`);
});
