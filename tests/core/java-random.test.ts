/**
 * JavaRandom 正确性验证。
 *
 * 策略：写一个直白到几乎不可能出错的 BigInt 参考实现（逐字照抄 JDK 规范，无任何位运算
 * 技巧），再拿它和生产用的快速实现做大规模交叉验证。快速实现把 48 位状态拆成两个 24 位
 * 半来避开 BigInt 的开销，这类优化最容易在进位和移位边界上出错，所以交叉验证覆盖了
 * 全部 next(bits) 的 bits 取值和所有派生方法。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JavaRandom } from '../../src/core/rng/java-random.ts';

const M = 0x5deece66dn;
const ADD = 0xbn;
const MASK48 = (1n << 48n) - 1n;

/** 逐字照抄 java.util.Random 规范的参考实现，只求正确不求快 */
class RefRandom {
  private seed: bigint;
  private nextG = 0;
  private haveG = false;

  constructor(seed: number | bigint) {
    this.seed = (BigInt.asUintN(64, BigInt(seed)) ^ M) & MASK48;
  }

  next(bits: number): number {
    this.seed = (this.seed * M + ADD) & MASK48;
    return Number(BigInt.asIntN(32, this.seed >> BigInt(48 - bits)));
  }

  nextInt(bound?: number): number {
    if (bound === undefined) return this.next(32);
    if ((bound & -bound) === bound) {
      return Number((BigInt(bound) * BigInt(this.next(31))) >> 31n);
    }
    let bits: number;
    let val: number;
    do {
      bits = this.next(31);
      val = bits % bound;
    } while (((bits - val + (bound - 1)) | 0) < 0);
    return val;
  }

  nextLong(): bigint {
    const hi = BigInt(this.next(32));
    const lo = BigInt(this.next(32));
    return BigInt.asIntN(64, (hi << 32n) + lo);
  }

  nextBoolean(): boolean {
    return this.next(1) !== 0;
  }

  nextFloat(): number {
    return this.next(24) / (1 << 24);
  }

  nextDouble(): number {
    return (this.next(26) * 134217728 + this.next(27)) / 9007199254740992;
  }

  nextGaussian(): number {
    if (this.haveG) {
      this.haveG = false;
      return this.nextG;
    }
    let v1: number;
    let v2: number;
    let s: number;
    do {
      v1 = 2 * this.nextDouble() - 1;
      v2 = 2 * this.nextDouble() - 1;
      s = v1 * v1 + v2 * v2;
    } while (s >= 1 || s === 0);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    this.nextG = v2 * mul;
    this.haveG = true;
    return v1 * mul;
  }
}

const SEEDS = [0, 1, 42, 1234, -1, -42, 2147483647, -2147483648, 8675309, 123456789];

test('next(bits) 对所有 bits 取值与参考实现逐位一致', () => {
  for (const seed of SEEDS) {
    for (let bits = 1; bits <= 32; bits++) {
      const a = new JavaRandom(seed);
      const b = new RefRandom(seed);
      for (let i = 0; i < 200; i++) {
        assert.equal(a.next(bits), b.next(bits), `seed=${seed} bits=${bits} i=${i}`);
      }
    }
  }
});

test('nextInt() 无参版本一致', () => {
  for (const seed of SEEDS) {
    const a = new JavaRandom(seed);
    const b = new RefRandom(seed);
    for (let i = 0; i < 2000; i++) assert.equal(a.nextInt(), b.nextInt(), `seed=${seed} i=${i}`);
  }
});

test('nextInt(bound) 覆盖 2 的幂快路径与拒绝采样路径', () => {
  // 既有 2 的幂（走 (bound*next(31))>>31 快路径），也有非 2 的幂（走 do/while 拒绝采样），
  // 还有能真正触发拒绝分支的大 bound
  const bounds = [1, 2, 3, 4, 5, 6, 7, 8, 10, 16, 17, 64, 100, 256, 1000, 3, 0x40000000, 0x40000001, 1431655765];
  for (const seed of SEEDS) {
    for (const bound of bounds) {
      const a = new JavaRandom(seed);
      const b = new RefRandom(seed);
      for (let i = 0; i < 300; i++) {
        const x = a.nextInt(bound);
        assert.equal(x, b.nextInt(bound), `seed=${seed} bound=${bound} i=${i}`);
        assert.ok(x >= 0 && x < bound, `越界 ${x} 不在 [0,${bound})`);
      }
    }
  }
});

test('nextLong / nextBoolean / nextFloat / nextDouble 一致', () => {
  for (const seed of SEEDS) {
    const a = new JavaRandom(seed);
    const b = new RefRandom(seed);
    for (let i = 0; i < 500; i++) {
      assert.equal(a.nextLong(), b.nextLong(), `nextLong seed=${seed} i=${i}`);
      assert.equal(a.nextBoolean(), b.nextBoolean(), `nextBoolean seed=${seed} i=${i}`);
      assert.equal(a.nextFloat(), b.nextFloat(), `nextFloat seed=${seed} i=${i}`);
      assert.equal(a.nextDouble(), b.nextDouble(), `nextDouble seed=${seed} i=${i}`);
    }
  }
});

test('nextGaussian 一致（含配对缓存语义）', () => {
  for (const seed of SEEDS) {
    const a = new JavaRandom(seed);
    const b = new RefRandom(seed);
    for (let i = 0; i < 500; i++) {
      assert.equal(a.nextGaussian(), b.nextGaussian(), `seed=${seed} i=${i}`);
    }
  }
});

test('混合调用序列一致 —— 捕捉状态泄漏', () => {
  // 单一方法重复调用不足以暴露状态相关的 bug；这里按伪随机顺序混着调
  for (const seed of SEEDS) {
    const a = new JavaRandom(seed);
    const b = new RefRandom(seed);
    const picker = new RefRandom(seed ^ 0x9e3779b9);
    for (let i = 0; i < 3000; i++) {
      switch (picker.nextInt(7)) {
        case 0: assert.equal(a.nextInt(), b.nextInt(), `i=${i}`); break;
        case 1: assert.equal(a.nextInt(100), b.nextInt(100), `i=${i}`); break;
        case 2: assert.equal(a.nextLong(), b.nextLong(), `i=${i}`); break;
        case 3: assert.equal(a.nextBoolean(), b.nextBoolean(), `i=${i}`); break;
        case 4: assert.equal(a.nextFloat(), b.nextFloat(), `i=${i}`); break;
        case 5: assert.equal(a.nextDouble(), b.nextDouble(), `i=${i}`); break;
        default: assert.equal(a.nextGaussian(), b.nextGaussian(), `i=${i}`); break;
      }
    }
  }
});

test('setSeed 重置状态（含 gaussian 缓存）', () => {
  const r = new JavaRandom(1234);
  r.nextGaussian(); // 让缓存里存下配对值
  const first = [r.nextInt(), r.nextInt(), r.nextInt()];
  r.setSeed(1234);
  r.nextGaussian();
  assert.deepEqual([r.nextInt(), r.nextInt(), r.nextInt()], first);

  // 重置后应与全新实例完全一致
  const fresh = new JavaRandom(999);
  const reused = new JavaRandom(1);
  reused.setSeed(999);
  for (let i = 0; i < 100; i++) assert.equal(reused.nextInt(), fresh.nextInt());
});

test('saveState / restoreState 往返', () => {
  const r = new JavaRandom(4242);
  for (let i = 0; i < 37; i++) r.nextInt();
  r.nextGaussian();
  const st = r.saveState();
  const expected = [r.nextGaussian(), r.nextDouble(), r.nextInt(1000), r.nextLong()];
  r.restoreState(st);
  assert.deepEqual([r.nextGaussian(), r.nextDouble(), r.nextInt(1000), r.nextLong()], expected);
});

test('bigint 种子（64 位）也能精确处理', () => {
  const seeds = [0n, -1n, 1234567890123456789n, -8675309876543210n, (1n << 47n) + 12345n];
  for (const seed of seeds) {
    const a = new JavaRandom(seed);
    const b = new RefRandom(seed);
    for (let i = 0; i < 500; i++) assert.equal(a.nextInt(), b.nextInt(), `seed=${seed} i=${i}`);
  }
});

test('已知的 JDK 输出锚点', () => {
  // 独立于上面的参考实现 —— 如果两个实现同时写错了同一处，这些外部已知值会抓住。
  assert.equal(new JavaRandom(0).nextInt(), -1155484576);
  assert.equal(new JavaRandom(42).nextInt(), -1170105035);
});
