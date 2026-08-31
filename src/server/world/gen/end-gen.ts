/**
 * 末地地形生成。
 *
 * 末地在 MC 1.0 里只有**一座主岛**（外岛与末地城是 1.9 才有的），
 * 悬在虚空里、四面是断崖、地面是末地石。它的地形很简单，
 * 但简单本身就是设计：整个维度只有一件事要做，地形不该分散注意力。
 *
 * ## 岛的形状怎么来的
 *
 * MC 用一个二维"岛屿因子"：离原点越远越低，再叠上噪声让边缘参差。
 * 超过一定距离直接归零 —— 于是外面是纯粹的虚空，掉下去就没了。
 * 这里照做，半径取 MC 的量级（约 90 格实心 + 一圈参差的边）。
 *
 * ## 黑曜石柱
 *
 * 岛上立着若干根顶着末影水晶的黑曜石柱。它们是龙战的核心机制
 * （龙会飞去水晶那里回血），所以柱子的位置必须是**确定的** ——
 * 按世界种子生成，同一个世界每次进来柱子都在原地。
 */
import { Chunk, ChunkSection, packState, AIR_STATE } from '../../../core/world/chunk.ts';
import { CHUNK_SIZE, WORLD_HEIGHT, SECTIONS_PER_COLUMN } from '../../../core/constants.ts';
import type { BlockRegistry } from '../../../core/registry/block-registry.ts';
import { noiseFromSeed, type OctaveNoise } from '../../../core/noise/perlin.ts';
import { JavaRandom } from '../../../core/rng/java-random.ts';
import { Blocks } from '../../../content/blocks.ts';
import type { WorldGenerator } from './generator.ts';

/** 主岛地面的基准高度。MC 的末地地面大致在这一带 */
export const END_GROUND_Y = 64;
/** 主岛实心部分的半径（格） */
export const END_ISLAND_RADIUS = 90;
/** 玩家从主世界过来时的落点。MC 固定在原点附近 */
export const END_ARRIVAL = { x: 0.5, y: END_GROUND_Y + 2, z: 0.5 };
/** 黑曜石柱的根数 */
export const END_PILLAR_COUNT = 10;
/** 柱子围成的圈的半径 */
const PILLAR_RING_RADIUS = 43;

export interface EndPillar {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly height: number;
}

/**
 * 十根柱子的位置。**纯函数，只依赖种子** —— 龙战逻辑与地形生成
 * 都要知道水晶在哪，两边各算一遍必然漂移，所以只有这一处。
 */
export function endPillars(seed: bigint): EndPillar[] {
  const rand = new JavaRandom(BigInt.asIntN(64, seed ^ 0x454e4450n));
  const out: EndPillar[] = [];
  for (let i = 0; i < END_PILLAR_COUNT; i++) {
    // 均匀分布在一个圈上，再各自抖一点 —— 完全均匀的话
    // 站在中间会看出这是个正十边形
    const angle = (i / END_PILLAR_COUNT) * Math.PI * 2;
    const r = PILLAR_RING_RADIUS + rand.nextInt(9) - 4;
    out.push({
      x: Math.round(Math.cos(angle) * r),
      z: Math.round(Math.sin(angle) * r),
      radius: 2 + rand.nextInt(3),
      height: 30 + rand.nextInt(30),
    });
  }
  return out;
}

export class EndGenerator implements WorldGenerator {
  readonly seed: bigint;
  private readonly shape: OctaveNoise;
  private readonly rough: OctaveNoise;
  private readonly pillars: EndPillar[];
  private readonly st: Record<string, number>;

  constructor(seed: bigint, registry: BlockRegistry) {
    this.seed = seed;
    this.shape = noiseFromSeed(seed, 0x454e4431, 3);
    this.rough = noiseFromSeed(seed, 0x454e4432, 2);
    this.pillars = endPillars(seed);
    const s = (name: string): number => packState(registry.idOf(name));
    this.st = {
      endStone: s(Blocks.END_STONE),
      obsidian: s(Blocks.OBSIDIAN),
      bedrock: s(Blocks.BEDROCK),
    };
  }

  /** 这个维度的黑曜石柱，供龙战放水晶 */
  getPillars(): readonly EndPillar[] {
    return this.pillars;
  }

  generate(cx: number, cz: number): Chunk {
    const blocks = new Uint16Array(CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT);
    const at = (x: number, y: number, z: number): number => (y * CHUNK_SIZE + z) * CHUNK_SIZE + x;

    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const wx = cx * CHUNK_SIZE + lx;
        const wz = cz * CHUNK_SIZE + lz;
        const t = this.thickness(wx, wz);
        if (t <= 0) continue;
        // 岛是一块**板**：从地面往下 t 格，上面是空的。
        // 不做"从 0 填到地面"是关键 —— 末地的悬浮感全在这里，
        // 填到底的话它就只是一个海拔 64 的普通世界
        const top = END_GROUND_Y + Math.round(this.rough.stretched2(wx * 0.05, wz * 0.05) * 2);
        for (let y = Math.max(1, top - t); y <= top; y++) {
          blocks[at(lx, y, lz)] = this.st['endStone']!;
        }
      }
    }

    this.carvePillars(blocks, at, cx, cz);
    return this.pack(cx, cz, blocks);
  }

  /**
   * 这一列的岛有多厚。0 表示虚空。
   *
   * 距离衰减用平方而不是线性：线性的话岛会是一个规整的圆锥，
   * 而 MC 的末地主岛中间厚、边缘**很快**变薄，最后断成崖。
   */
  private thickness(wx: number, wz: number): number {
    const d = Math.hypot(wx, wz);
    if (d > END_ISLAND_RADIUS * 1.35) return 0;
    const falloff = 1 - (d / END_ISLAND_RADIUS) ** 2;
    const n = this.shape.stretched2(wx * 0.014, wz * 0.014) * 0.35;
    const v = falloff + n;
    if (v <= 0) return 0;
    return Math.max(1, Math.round(v * 26));
  }

  /** 把落在这个区块里的黑曜石柱立起来 */
  private carvePillars(
    blocks: Uint16Array,
    at: (x: number, y: number, z: number) => number,
    cx: number, cz: number,
  ): void {
    const baseX = cx * CHUNK_SIZE;
    const baseZ = cz * CHUNK_SIZE;
    for (const p of this.pillars) {
      // 快速排除：柱子离这个区块太远就不看了
      if (p.x + p.radius < baseX - 1 || p.x - p.radius > baseX + CHUNK_SIZE) continue;
      if (p.z + p.radius < baseZ - 1 || p.z - p.radius > baseZ + CHUNK_SIZE) continue;
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const dx = baseX + lx - p.x;
          const dz = baseZ + lz - p.z;
          if (dx * dx + dz * dz > p.radius * p.radius) continue;
          const top = END_GROUND_Y + p.height;
          for (let y = END_GROUND_Y - 6; y <= top; y++) {
            if (y < 1 || y >= WORLD_HEIGHT) continue;
            blocks[at(lx, y, lz)] = this.st['obsidian']!;
          }
          // 柱顶铺一层基岩，水晶就坐在上面 —— 与 MC 一致，
          // 而且它让"玩家拆柱子"这件事必须从侧面下手
          if (top + 1 < WORLD_HEIGHT) blocks[at(lx, top + 1, lz)] = this.st['bedrock']!;
        }
      }
    }
  }

  private pack(cx: number, cz: number, blocks: Uint16Array): Chunk {
    const chunk = new Chunk(cx, cz);
    for (let sy = 0; sy < SECTIONS_PER_COLUMN; sy++) {
      let has = false;
      const states = new Uint16Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        const wy = sy * CHUNK_SIZE + ly;
        for (let z = 0; z < CHUNK_SIZE; z++) {
          for (let x = 0; x < CHUNK_SIZE; x++) {
            const v = blocks[(wy * CHUNK_SIZE + z) * CHUNK_SIZE + x]!;
            if (v === AIR_STATE) continue;
            states[(ly << 8) | (z << 4) | x] = v;
            has = true;
          }
        }
      }
      if (has) chunk.sections[sy] = new ChunkSection(states);
    }
    chunk.recomputeHeightmap();
    return chunk;
  }

  /** 末地的落点固定在原点上方 —— 与 MC 一致，玩家总是从那里出现 */
  findSpawn(): { x: number; y: number; z: number } {
    return { ...END_ARRIVAL };
  }
}
