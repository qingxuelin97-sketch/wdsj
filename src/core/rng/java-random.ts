/**
 * java.util.Random 的位级精确复刻。
 *
 * Minecraft 的世界生成、矿脉、结构、掉落全部建立在它上面，所以这里必须与 JDK 逐位一致，
 * 而不是"某个线性同余发生器"。规范见 JDK 的 java.util.Random 文档：
 *   seed 是 48 位；next(bits) = (seed = seed*0x5DEECE66D + 0xB mod 2^48) >>> (48-bits)
 *
 * JS 没有 48 位整数，BigInt 又太慢（世界生成每秒要调用数百万次）。这里把 48 位状态拆成
 * 两个 24 位半，用双精度浮点做乘法 —— 所有中间结果都 < 2^53，因此精确无误差。
 * 正确性由 tests/core/java-random.test.ts 里的 BigInt 参考实现交叉验证。
 */

const MULT_HI = 0x5de; //  0x5DEECE66D >> 24        = 1502
const MULT_LO = 0xece66d; //  0x5DEECE66D & 0xFFFFFF   = 15525485
const ADDEND = 0xb;
const MASK24 = 0xffffff;
const POW24 = 0x1000000; // 2^24

export class JavaRandom {
  /** 种子高 24 位 */
  private hi = 0;
  /** 种子低 24 位 */
  private lo = 0;
  /** nextGaussian 的配对缓存 */
  private nextGaussianCache = 0;
  private haveNextGaussian = false;

  constructor(seed?: number | bigint) {
    this.setSeed(seed ?? Date.now());
  }

  /**
   * 与 Java 的 setSeed 一致：实际存储的是 (seed ^ 0x5DEECE66D) & ((1<<48)-1)。
   * 接受 number（|seed| < 2^53 时精确）或 bigint（任意 64 位种子，取低 48 位）。
   */
  setSeed(seed: number | bigint): void {
    let s: bigint = typeof seed === 'bigint' ? seed : BigInt(Math.trunc(seed));
    // Java 的 long 是 64 位有符号，先规约到 64 位再取低 48 位
    s = BigInt.asUintN(64, s);
    s = (s ^ 0x5deece66dn) & 0xffffffffffffn;
    this.hi = Number(s >> 24n);
    this.lo = Number(s & 0xffffffn);
    this.haveNextGaussian = false;
    this.nextGaussianCache = 0;
  }

  /** 当前 48 位种子（主要给测试与存档用） */
  getSeed(): bigint {
    return (BigInt(this.hi) << 24n) | BigInt(this.lo);
  }

  /**
   * JDK 的 protected int next(int bits)。
   * 返回值是有符号 32 位整数（bits=32 时可能为负）。
   */
  next(bits: number): number {
    // 48 位乘加，拆成两个 24 位半。
    // (hi*2^24 + lo) * (MH*2^24 + ML) + C  mod 2^48
    //   = (hi*ML + lo*MH)*2^24 + lo*ML + C   （hi*MH*2^48 项被模掉）
    const lo = this.lo * MULT_LO + ADDEND; // < 2^48，精确
    const carry = Math.floor(lo / POW24);
    const newLo = lo - carry * POW24; // = lo mod 2^24
    // hi*ML + lo*MH < 2^24*2^24 * 2 = 2^49，精确
    const hiSum = this.hi * MULT_LO + this.lo * MULT_HI + carry;
    const newHi = hiSum % POW24;

    this.hi = newHi;
    this.lo = newLo;

    const shift = 48 - bits;
    if (shift >= 24) {
      // 只需要高半部分
      return (newHi >>> (shift - 24)) | 0;
    }
    // 拼接：高半左移 + 低半右移。24-shift <= 8，所以 newHi*2^(24-shift) < 2^32，精确
    return ((newHi * (1 << (24 - shift))) + (newLo >>> shift)) | 0;
  }

  /** 均匀分布的有符号 32 位整数 */
  nextInt(): number;
  /** [0, bound) 上的均匀整数，bound 必须为正 */
  nextInt(bound: number): number;
  nextInt(bound?: number): number {
    if (bound === undefined) return this.next(32);
    if (bound <= 0) throw new RangeError('bound must be positive');

    // 2 的幂走快路径（Java 原文如此，不能简化成取模，否则序列不同）
    if ((bound & -bound) === bound) {
      return Math.floor((bound * this.next(31)) / 0x80000000);
    }
    // 拒绝采样，剔除会造成偏斜的尾巴
    let bits: number;
    let val: number;
    do {
      bits = this.next(31);
      val = bits % bound;
    } while (((bits - val + (bound - 1)) | 0) < 0);
    return val;
  }

  /** 均匀分布的有符号 64 位整数 */
  nextLong(): bigint {
    const hi = BigInt(this.next(32));
    const lo = BigInt(this.next(32));
    return BigInt.asIntN(64, (hi << 32n) + lo);
  }

  nextBoolean(): boolean {
    return this.next(1) !== 0;
  }

  /** [0,1) 单精度 */
  nextFloat(): number {
    return this.next(24) / (1 << 24);
  }

  /** [0,1) 双精度 */
  nextDouble(): number {
    // (next(26) << 27 + next(27)) * 2^-53
    return (this.next(26) * 134217728 + this.next(27)) / 9007199254740992;
  }

  /** 标准正态分布，Marsaglia 极坐标法（与 JDK 同一算法、同一配对缓存语义） */
  nextGaussian(): number {
    if (this.haveNextGaussian) {
      this.haveNextGaussian = false;
      return this.nextGaussianCache;
    }
    let v1: number;
    let v2: number;
    let s: number;
    do {
      v1 = 2 * this.nextDouble() - 1;
      v2 = 2 * this.nextDouble() - 1;
      s = v1 * v1 + v2 * v2;
    } while (s >= 1 || s === 0);
    const multiplier = Math.sqrt((-2 * Math.log(s)) / s);
    this.nextGaussianCache = v2 * multiplier;
    this.haveNextGaussian = true;
    return v1 * multiplier;
  }

  /** 快照/恢复，供存档与确定性重放使用 */
  saveState(): { hi: number; lo: number; g: number; hasG: boolean } {
    return { hi: this.hi, lo: this.lo, g: this.nextGaussianCache, hasG: this.haveNextGaussian };
  }

  restoreState(st: { hi: number; lo: number; g: number; hasG: boolean }): void {
    this.hi = st.hi;
    this.lo = st.lo;
    this.nextGaussianCache = st.g;
    this.haveNextGaussian = st.hasG;
  }
}

/** 便捷构造，等价于 new JavaRandom(seed) */
export function javaRandom(seed: number | bigint): JavaRandom {
  return new JavaRandom(seed);
}
