/**
 * 地表处理：把裸露的石头换成群系的地表方块，铺基岩，撒雪。
 *
 * 关键点是"暴露判定"要在**竖直方向逐格**做，而不是只处理最高那一格 ——
 * 地形有悬垂和洞穴，一列里可能有好几处独立的地表（洞顶、拱下、悬崖面），
 * 只处理最高点会让洞里露出一片没铺草的裸石头。
 */
import { JavaRandom } from '../../../core/rng/java-random.ts';
import { noiseFromSeed, type OctaveNoise } from '../../../core/noise/perlin.ts';
import { CHUNK_SIZE, WORLD_HEIGHT, SEA_LEVEL, BEDROCK_LAYERS } from '../../../core/constants.ts';
import type { BiomeTables } from '../../../content/biomes.ts';

/** RNG salt。一律在文件顶部定义为命名常量，不在调用处拼字面量 */
const SALT_SURFACE = 0x5face1n;

/** 地表处理需要的方块状态 */
export interface SurfaceStates {
  air: number;
  stone: number;
  water: number;
  ice: number;
  bedrock: number;
  snowLayer: number;
  /**
   * 是否放置雪层方块。
   *
   * MC 的雪层是 1/8 格高的薄片，铺在地表上而**不改变**地形轮廓。
   * 在 M7 的方块模型系统就位之前，我们只有整格的雪块，铺上去等于给整个雪原
   * 抬高一格并抹平所有细节 —— 画面上就是一片纯白，什么都看不出来。
   * 所以 M2-M6 期间只结冰不铺雪，M7 补上 snow_layer 模型后再打开。
   */
  enableSnowLayer: boolean;
  /** 按群系 id 索引的地表 / 填充 / 水下方块状态 */
  surfaceByBiome: Uint16Array;
  fillerByBiome: Uint16Array;
  underwaterByBiome: Uint16Array;
}

export class SurfaceBuilder {
  private readonly seed: bigint;
  private readonly depthNoise: OctaveNoise;
  private readonly tables: BiomeTables;

  constructor(seed: bigint, tables: BiomeTables) {
    this.seed = seed;
    // 让地表层厚度有起伏，避免"处处正好 4 格土"的机械感
    this.depthNoise = noiseFromSeed(seed, 0x5f4c, 3);
    this.tables = tables;
  }

  /**
   * @param blocks 整列方块，(y*16+z)*16+x
   * @param biomes 每列的群系 id，长度 256
   */
  apply(cx: number, cz: number, blocks: Uint16Array, biomes: Uint8Array, s: SurfaceStates): void {
    const rng = new JavaRandom(
      this.seed ^ (BigInt(cx) * 341873128712n + BigInt(cz) * 132897987541n + SALT_SURFACE),
    );

    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const wx = cx * CHUNK_SIZE + x;
        const wz = cz * CHUNK_SIZE + z;
        const biome = biomes[z * CHUNK_SIZE + x]!;
        const surface = s.surfaceByBiome[biome]!;
        const filler = s.fillerByBiome[biome]!;
        const underwater = s.underwaterByBiome[biome]!;
        const snowy = this.tables.snowy[biome] === 1;

        // 地表层厚度 3..6，随位置起伏
        const depth = 3 + Math.round((this.depthNoise.noise2(wx * 0.07, wz * 0.07) + 1) * 1.5);

        // remaining > 0 表示正在铺填充层
        let remaining = 0;
        let placedSurface = false;

        for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
          const idx = (y * CHUNK_SIZE + z) * CHUNK_SIZE + x;
          const state = blocks[idx]!;

          if (state === s.air || state === s.water) {
            // 遇到空隙就重置，下一段实心会被当成新的地表
            remaining = 0;
            placedSurface = false;
            continue;
          }
          if (state !== s.stone) continue; // 别动已经放好的矿脉等

          if (!placedSurface) {
            // 这一格是暴露面
            if (y >= SEA_LEVEL - 1) {
              blocks[idx] = surface;
            } else {
              // 水面以下用群系的水下地表（沙/沙砾）
              blocks[idx] = underwater;
            }
            placedSurface = true;
            remaining = depth;
          } else if (remaining > 0) {
            blocks[idx] = y >= SEA_LEVEL - 1 ? filler : underwater;
            remaining--;
          }
        }

        // --- 雪与冰 ---
        if (snowy) {
          const topY = this.highestSolid(blocks, x, z, s);
          if (topY >= 0) {
            const topIdx = (topY * CHUNK_SIZE + z) * CHUNK_SIZE + x;
            if (blocks[topIdx] === s.water) {
              blocks[topIdx] = s.ice; // 水面结冰
            } else if (s.enableSnowLayer && topY + 1 < WORLD_HEIGHT) {
              const aboveIdx = ((topY + 1) * CHUNK_SIZE + z) * CHUNK_SIZE + x;
              if (blocks[aboveIdx] === s.air) blocks[aboveIdx] = s.snowLayer;
            }
          }
        }

        // --- 基岩：底层实心，往上随机化，形成 MC 那种参差的底 ---
        for (let y = 0; y < BEDROCK_LAYERS; y++) {
          const idx = (y * CHUNK_SIZE + z) * CHUNK_SIZE + x;
          if (y === 0 || rng.nextInt(BEDROCK_LAYERS) >= y) blocks[idx] = s.bedrock;
        }
      }
    }
  }

  /** 该列最高的非空气方块（水也算，用于结冰判断） */
  private highestSolid(blocks: Uint16Array, x: number, z: number, s: SurfaceStates): number {
    for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
      const state = blocks[(y * CHUNK_SIZE + z) * CHUNK_SIZE + x]!;
      if (state !== s.air) return y;
    }
    return -1;
  }
}
