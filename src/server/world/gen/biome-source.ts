/**
 * 群系选择。
 *
 * 三层噪声：大陆性（陆海之分）、温度、湿度。再叠一层河流噪声在所有陆地上刻河道。
 *
 * 为什么不是简单的 if 阶梯：前作的群系选择是一串硬阈值，导致**群系边界是方块级的硬切**，
 * 地形高度在边界处直接跳变，看起来像被刀切过。这里的做法是每个群系给出自己的
 * baseHeight/heightVariation，然后对采样点周围 5×5 的群系做**加权平均**，
 * 于是高度是连续过渡的，只有地表方块是硬切（这与 MC 一致）。
 */
import { noiseFromSeed, type OctaveNoise } from '../../../core/noise/perlin.ts';
import { Biome, type BiomeTables } from '../../../content/biomes.ts';

/** 噪声频率。数值越小特征越大 */
const FREQ_CONTINENT = 0.00085;
const FREQ_TEMPERATURE = 0.0011;
const FREQ_RAINFALL = 0.0013;
const FREQ_RIVER = 0.0016;
const FREQ_HILL = 0.0042;

/** 河流噪声接近 0 的这个带宽内会被刻成河道 */
const RIVER_WIDTH = 0.055;

export class BiomeSource {
  private readonly continent: OctaveNoise;
  private readonly temperature: OctaveNoise;
  private readonly rainfall: OctaveNoise;
  private readonly river: OctaveNoise;
  private readonly hill: OctaveNoise;
  private readonly tables: BiomeTables;

  constructor(seed: bigint, tables: BiomeTables) {
    // 每种用途一个独立 salt：新增一种噪声不会打乱已有噪声的取值，
    // 否则加个特性就把整个世界的地形洗牌了
    this.continent = noiseFromSeed(seed, 0x0c07, 4);
    this.temperature = noiseFromSeed(seed, 0x7e11, 3);
    this.rainfall = noiseFromSeed(seed, 0x2a1f, 3);
    this.river = noiseFromSeed(seed, 0x21df, 2);
    this.hill = noiseFromSeed(seed, 0x41ff, 3);
    this.tables = tables;
  }

  /**
   * 大陆性：负值是海，正值是陆。
   * 一律走 stretched2 —— 裸的倍频 Perlin 分布太集中（σ≈0.18），
   * 按 [-1,1] 直觉写的阈值几乎全都不成立，整类群系会凭空消失。
   */
  continentalityAt(x: number, z: number): number {
    return this.continent.stretched2(x * FREQ_CONTINENT, z * FREQ_CONTINENT);
  }

  /** 河流强度：0 表示不在河上，1 表示河心 */
  riverAt(x: number, z: number): number {
    const n = this.river.stretched2(x * FREQ_RIVER, z * FREQ_RIVER);
    const d = Math.abs(n);
    if (d > RIVER_WIDTH) return 0;
    return 1 - d / RIVER_WIDTH;
  }

  /** 选出该列的群系 id */
  biomeAt(x: number, z: number): number {
    const cont = this.continentalityAt(x, z);
    const temp = this.temperature.stretched2(x * FREQ_TEMPERATURE, z * FREQ_TEMPERATURE);
    const rain = this.rainfall.stretched2(x * FREQ_RAINFALL, z * FREQ_RAINFALL);
    const hill = this.hill.stretched2(x * FREQ_HILL, z * FREQ_HILL);
    // 阈值按 stretched2 之后的分布设：p50=0，p5≈-0.78，p95≈+0.73
    const frozen = temp < -0.52;

    // 深海。约占 22% 的面积，接近 1.0 的海陆比
    if (cont < -0.30) return frozen ? Biome.FROZEN_OCEAN : Biome.OCEAN;

    // 蘑菇岛：极其罕见，且只在紧贴深海的窄带上生成
    if (cont > -0.30 && cont < -0.255 && rain > 0.62 && temp > 0.25) {
      return cont < -0.28 ? Biome.MUSHROOM_SHORE : Biome.MUSHROOM_ISLAND;
    }

    // 河流刻在陆地上
    if (this.riverAt(x, z) > 0 && cont > -0.26) {
      return frozen ? Biome.FROZEN_RIVER : Biome.RIVER;
    }

    // 高地：由山丘噪声决定，与温度无关。约 12%
    if (hill > 0.46) return frozen ? Biome.ICE_MOUNTAINS : Biome.EXTREME_HILLS;

    if (frozen) return Biome.ICE_PLAINS;
    if (temp < -0.30) return Biome.TAIGA;
    if (temp > 0.40 && rain < -0.20) return Biome.DESERT;
    if (rain > 0.50 && temp > 0.10) return Biome.SWAMPLAND;
    if (rain > 0.05) return Biome.FOREST;
    return Biome.PLAINS;
  }

  /**
   * 该列的地形基准高度与起伏幅度。
   *
   * 对 5×5 邻域的群系做加权平均，让群系边界处的地形高度**连续过渡**而不是硬跳。
   * 这一步是"地形看上去像 MC"和"像被刀切过"的分界线。
   *
   * 单点版本，只在零散查询时用。批量场景（地形网格）走 fillBiomeGrid +
   * heightParamsFromGrid —— 那里相邻采样点的 5×5 邻域是完全重合的，
   * 逐点算等于把同一个 biomeAt 重复算 25 遍。
   */
  heightParamsAt(x: number, z: number, out: { base: number; variation: number }): void {
    let baseSum = 0;
    let varSum = 0;
    let weightSum = 0;
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        // 采样间隔 4 格，5×5 邻域覆盖 ±8 格，足够抹平边界又不至于糊掉群系特征
        const id = this.biomeAt(x + dx * 4, z + dz * 4);
        // 高斯型权重，中心权重最大
        const w = 1 / (1 + dx * dx + dz * dz);
        baseSum += this.tables.baseHeight[id]! * w;
        varSum += this.tables.heightVariation[id]! * w;
        weightSum += w;
      }
    }
    out.base = baseSum / weightSum;
    out.variation = varSum / weightSum;
  }

  /**
   * 批量算一片群系网格。
   *
   * @param originX/originZ 网格左下角的世界坐标
   * @param step  采样间隔（格）
   * @param n     网格边长（点数）
   * @param out   长度 n*n 的输出
   *
   * 地形生成时每个密度网格点都要一个 5×5 的群系邻域做加权平均，而相邻网格点的
   * 采样点是同一批。先把扩展后的网格一次算好，625 次 biomeAt 就降到 81 次。
   */
  fillBiomeGrid(originX: number, originZ: number, step: number, n: number, out: Uint8Array): void {
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        out[iz * n + ix] = this.biomeAt(originX + ix * step, originZ + iz * step);
      }
    }
  }

  /**
   * 从预算好的群系网格里取某点的高度参数。
   * (gx,gz) 是该点在网格里的下标，函数会读它周围 5×5 的邻域。
   */
  heightParamsFromGrid(
    grid: Uint8Array, n: number, gx: number, gz: number,
    out: { base: number; variation: number },
  ): void {
    let baseSum = 0;
    let varSum = 0;
    let weightSum = 0;
    for (let dz = -2; dz <= 2; dz++) {
      const sz = gz + dz;
      if (sz < 0 || sz >= n) continue;
      for (let dx = -2; dx <= 2; dx++) {
        const sx = gx + dx;
        if (sx < 0 || sx >= n) continue;
        const id = grid[sz * n + sx]!;
        const w = 1 / (1 + dx * dx + dz * dz);
        baseSum += this.tables.baseHeight[id]! * w;
        varSum += this.tables.heightVariation[id]! * w;
        weightSum += w;
      }
    }
    out.base = baseSum / weightSum;
    out.variation = varSum / weightSum;
  }
}
