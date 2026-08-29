/**
 * Perlin 改进噪声，结构与 Minecraft 的 NoiseGeneratorPerlin / NoiseGeneratorOctaves 对齐。
 *
 * 关键点：置换表由 JavaRandom 用 Fisher-Yates 洗出来，而且洗牌方式与 MC 一致
 * （`int j = rand.nextInt(256 - i) + i`）。这保证同一个世界种子每次都生成同一个世界。
 *
 * 非目标：与真正的 Minecraft 逐格一致的地形。那需要精确复刻每一次 RNG 调用的顺序，
 * 是个无底洞。我们要的是"同种子 -> 同世界"和"看起来就是 MC 的地形"。见 docs/DEVIATIONS.md。
 */
import { JavaRandom } from '../rng/java-random.ts';

/** 6t^5 - 15t^4 + 10t^3，一阶二阶导在端点都为 0 */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(t: number, a: number, b: number): number {
  return a + t * (b - a);
}

/** MC / Ken Perlin 的梯度函数：用 hash 低 4 位从 12 条棱边里选一条 */
function grad(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

/** 单层 Perlin 噪声 */
export class PerlinNoise {
  /** 512 项置换表（前 256 项重复一遍，省掉取模） */
  private readonly perm = new Uint8Array(512);
  readonly xOffset: number;
  readonly yOffset: number;
  readonly zOffset: number;

  constructor(rand: JavaRandom) {
    // 与 MC 一致：先取三个偏移，再洗置换表。顺序不能换，换了同种子就生成不同世界。
    this.xOffset = rand.nextDouble() * 256;
    this.yOffset = rand.nextDouble() * 256;
    this.zOffset = rand.nextDouble() * 256;

    for (let i = 0; i < 256; i++) this.perm[i] = i;
    for (let i = 0; i < 256; i++) {
      const j = rand.nextInt(256 - i) + i;
      const tmp = this.perm[i]!;
      this.perm[i] = this.perm[j]!;
      this.perm[j] = tmp;
      this.perm[i + 256] = this.perm[i]!;
    }
  }

  /** 三维噪声，值域约 [-1, 1] */
  noise3(x: number, y: number, z: number): number {
    const px = x + this.xOffset;
    const py = y + this.yOffset;
    const pz = z + this.zOffset;

    const xi = Math.floor(px) & 255;
    const yi = Math.floor(py) & 255;
    const zi = Math.floor(pz) & 255;
    const xf = px - Math.floor(px);
    const yf = py - Math.floor(py);
    const zf = pz - Math.floor(pz);

    const u = fade(xf);
    const v = fade(yf);
    const w = fade(zf);

    const p = this.perm;
    const a = p[xi]! + yi;
    const aa = p[a]! + zi;
    const ab = p[a + 1]! + zi;
    const b = p[xi + 1]! + yi;
    const ba = p[b]! + zi;
    const bb = p[b + 1]! + zi;

    return lerp(
      w,
      lerp(
        v,
        lerp(u, grad(p[aa]!, xf, yf, zf), grad(p[ba]!, xf - 1, yf, zf)),
        lerp(u, grad(p[ab]!, xf, yf - 1, zf), grad(p[bb]!, xf - 1, yf - 1, zf)),
      ),
      lerp(
        v,
        lerp(u, grad(p[aa + 1]!, xf, yf, zf - 1), grad(p[ba + 1]!, xf - 1, yf, zf - 1)),
        lerp(u, grad(p[ab + 1]!, xf, yf - 1, zf - 1), grad(p[bb + 1]!, xf - 1, yf - 1, zf - 1)),
      ),
    );
  }

  /** 二维噪声（在 y=0 平面上取样） */
  noise2(x: number, z: number): number {
    return this.noise3(x, 0, z);
  }
}

/**
 * 多层倍频噪声。第 i 层的频率是 2^i，振幅是 1/2^i。
 * 返回值已按振幅总和归一化到约 [-1, 1]。
 */
export class OctaveNoise {
  private readonly layers: PerlinNoise[];
  /** 1 / 各层振幅之和，用于归一化 */
  private readonly normalizer: number;

  constructor(rand: JavaRandom, octaves: number) {
    if (octaves < 1) throw new RangeError('octaves 必须 >= 1');
    this.layers = [];
    let ampSum = 0;
    let amp = 1;
    for (let i = 0; i < octaves; i++) {
      this.layers.push(new PerlinNoise(rand));
      ampSum += amp;
      amp *= 0.5;
    }
    this.normalizer = 1 / ampSum;
  }

  get octaveCount(): number {
    return this.layers.length;
  }

  noise3(x: number, y: number, z: number): number {
    let total = 0;
    let freq = 1;
    let amp = 1;
    for (let i = 0; i < this.layers.length; i++) {
      total += this.layers[i]!.noise3(x * freq, y * freq, z * freq) * amp;
      freq *= 2;
      amp *= 0.5;
    }
    return total * this.normalizer;
  }

  noise2(x: number, z: number): number {
    let total = 0;
    let freq = 1;
    let amp = 1;
    for (let i = 0; i < this.layers.length; i++) {
      total += this.layers[i]!.noise2(x * freq, z * freq) * amp;
      freq *= 2;
      amp *= 0.5;
    }
    return total * this.normalizer;
  }

  /**
   * 分布拉伸后的二维噪声，值域近似铺满 [-1, 1]。
   *
   * 为什么需要它：倍频归一化之后，Perlin 的实际分布非常集中 ——
   * 实测 σ≈0.18，p5≈-0.30，p95≈+0.28，极值也只到 ±0.6。
   * 如果按"值域是 [-1,1]"的直觉去写阈值（比如 `n > 0.42` 表示"高地"），
   * 那个条件实际上几乎永远不成立，结果就是**整类地形凭空消失**，
   * 而且症状是"世界看起来单调"，很难联想到是阈值的问题。
   *
   * 这里按实测标准差把分布拉开，之后阈值可以按 [-1,1] 的直觉来设，
   * 且 0 仍然对应中位数。
   */
  stretched2(x: number, z: number): number {
    const n = this.noise2(x, z);
    // 1/0.38 ≈ 2.6，让 p95 落在 0.73 附近，两端再夹紧
    const s = n * 2.6;
    return s < -1 ? -1 : s > 1 ? 1 : s;
  }

  /**
   * 脊状噪声：把噪声折叠成 1-|n| 再平方，产生山脊线。
   * 主要用于山地地形，值域 [0, 1]。
   */
  ridged2(x: number, z: number): number {
    let total = 0;
    let freq = 1;
    let amp = 1;
    for (let i = 0; i < this.layers.length; i++) {
      const n = 1 - Math.abs(this.layers[i]!.noise2(x * freq, z * freq));
      total += n * n * amp;
      freq *= 2;
      amp *= 0.5;
    }
    return total * this.normalizer;
  }
}

/**
 * 由世界种子派生一组互相独立的噪声。
 *
 * salt 让每种用途（地形/温度/湿度/洞穴/…）拿到不同的噪声，但仍完全由世界种子决定。
 * 用 JavaRandom(seed ^ salt) 而不是共用一个 rand 顺序取，是为了让新增一种噪声不会
 * 打乱其它噪声的取值 —— 否则加一个特性就会把整个世界的地形洗牌。
 */
export function noiseFromSeed(seed: bigint | number, salt: number, octaves: number): OctaveNoise {
  const s = typeof seed === 'bigint' ? seed : BigInt(Math.trunc(seed));
  return new OctaveNoise(new JavaRandom(BigInt.asIntN(64, s ^ BigInt(salt))), octaves);
}
