/**
 * 下界地形生成。
 *
 * ## 与主世界完全不同的一件事：两头夹
 *
 * 主世界是"从地面往上长"——一条高度线，线下是石头线上是空气。
 * 下界不是。它是一个**被上下基岩夹住的洞穴系统**：地板和天花板
 * 各自起伏，中间的空腔就是能走的地方。所以这里的密度场是 3D 的，
 * 而且在 y=0 与 y=127 附近被强行推向"实心"。
 *
 * 照抄这个结构而不是"把主世界的石头换成地狱岩"，是因为下界的
 * 空间感全部来自它：抬头能看到岩浆瀑布挂在天花板上、
 * 走两步地面就断成一道深渊 —— 这些都是"两头夹"的直接结果。
 *
 * ## 岩浆海
 *
 * y=31 以下全是岩浆（MC 1.0 的岩浆海面就在 31）。它不是装饰：
 * 下界的全部紧张感来自"脚下随时是岩浆"，海面高度给错一格，
 * 整个维度的手感就变了。
 *
 * ## 为什么没有装饰阶段
 *
 * 下界的"装饰"（火、萤石簇、灵魂沙滩）都只依赖自身坐标附近的地形，
 * 不像树冠那样要跨区块。所以不需要主世界那套两阶段缓存 ——
 * 一个区块自己就能生成完，这也让下界的生成明显更快。
 */
import { Chunk, ChunkSection, packState, AIR_STATE } from '../../../core/world/chunk.ts';
import { CHUNK_SIZE, WORLD_HEIGHT, SECTIONS_PER_COLUMN } from '../../../core/constants.ts';
import type { BlockRegistry } from '../../../core/registry/block-registry.ts';
import { noiseFromSeed, type OctaveNoise } from '../../../core/noise/perlin.ts';
import { JavaRandom } from '../../../core/rng/java-random.ts';
import { Blocks } from '../../../content/blocks.ts';
import type { WorldGenerator } from './generator.ts';

/** 岩浆海的水平面。MC 1.0 就是 31 */
export const NETHER_LAVA_LEVEL = 31;
/** 顶上多少格是基岩天花板（带起伏） */
const CEILING_BAND = 5;
/** 底下多少格是基岩地板 */
const FLOOR_BAND = 5;

export class NetherGenerator implements WorldGenerator {
  readonly seed: bigint;
  /** 主密度场：决定哪里是实心 */
  private readonly density: OctaveNoise;
  /** 地板与天花板各自的起伏 */
  private readonly floor: OctaveNoise;
  private readonly ceiling: OctaveNoise;
  /** 萤石簇与灵魂沙滩的分布 */
  private readonly patch: OctaveNoise;
  private readonly st: Record<string, number>;

  constructor(seed: bigint, registry: BlockRegistry) {
    this.seed = seed;
    // salt 与主世界的错开，否则同一个种子下两个维度的地形会**长得一样**
    this.density = noiseFromSeed(seed, 0x4e455448, 4);
    this.floor = noiseFromSeed(seed, 0x4e455449, 3);
    this.ceiling = noiseFromSeed(seed, 0x4e45544a, 3);
    this.patch = noiseFromSeed(seed, 0x4e45544b, 2);
    const s = (name: string): number => packState(registry.idOf(name));
    this.st = {
      netherrack: s(Blocks.NETHERRACK),
      lava: s(Blocks.LAVA),
      bedrock: s(Blocks.BEDROCK),
      soulSand: s(Blocks.SOUL_SAND),
      gravel: s(Blocks.GRAVEL),
      glowstone: s(Blocks.GLOWSTONE),
      fire: s(Blocks.FIRE),
    };
  }

  generate(cx: number, cz: number): Chunk {
    const blocks = new Uint16Array(CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT);
    const at = (x: number, y: number, z: number): number => (y * CHUNK_SIZE + z) * CHUNK_SIZE + x;

    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const wx = cx * CHUNK_SIZE + lx;
        const wz = cz * CHUNK_SIZE + lz;
        this.column(blocks, at, lx, lz, wx, wz);
      }
    }

    // 装饰：萤石簇挂在天花板下、火苗点在地面上。
    // 用按区块播种的随机源，不用世界的那一个 —— 生成必须与
    // "这个区块什么时候被加载"无关
    const rand = new JavaRandom(BigInt.asIntN(64,
      (BigInt(cx) * 341873128712n + BigInt(cz) * 132897987541n) ^ this.seed));
    this.decorate(blocks, at, rand);

    return this.pack(cx, cz, blocks);
  }

  /** 生成一列 */
  private column(
    blocks: Uint16Array,
    at: (x: number, y: number, z: number) => number,
    lx: number, lz: number, wx: number, wz: number,
  ): void {
    // 地板与天花板的起伏：各 ±6 格
    const floorTop = FLOOR_BAND + Math.round((this.floor.stretched2(wx * 0.02, wz * 0.02) + 1) * 3);
    const ceilBase = WORLD_HEIGHT - CEILING_BAND
      - Math.round((this.ceiling.stretched2(wx * 0.022, wz * 0.022) + 1) * 3);

    for (let y = 0; y < WORLD_HEIGHT; y++) {
      let state = AIR_STATE;
      if (y === 0 || y >= WORLD_HEIGHT - 1) {
        state = this.st['bedrock']!;
      } else if (y < floorTop || y > ceilBase) {
        // 上下两条带里是**基岩混地狱岩**：纯基岩太规整，
        // 一眼看出是"生成器画的线"；MC 的下界顶底也是这种参差
        state = y < floorTop - 2 || y > ceilBase + 2 ? this.st['bedrock']! : this.st['netherrack']!;
      } else {
        // 中间靠 3D 密度场决定实心/空腔。
        //
        // Y 方向的频率比水平高（0.055 vs 0.031）：各向同性的噪声会长出
        // 一堆圆球形空腔，而下界的洞是**扁的**、横向铺开的
        const d = this.density.noise3(wx * 0.031, y * 0.055, wz * 0.031);
        // 越靠近上下边界越容易实心，中间最空 —— 这就是"两头夹"。
        //
        // toEdge 是到最近一条边的距离，所以偏置要**随它减小**：
        // 写成 min(toEdge/14,1) 的话中间反而最实，整个下界会变成
        // 一块 9% 空气的实心砖（第一版就是这么错的，实测走不进去）
        const toEdge = Math.min(y - floorTop, ceilBase - y);
        const bias = (1 - Math.min(1, toEdge / 16)) * 0.34;
        state = d + bias > 0.02 ? this.st['netherrack']! : AIR_STATE;
      }
      if (state === AIR_STATE && y <= NETHER_LAVA_LEVEL) state = this.st['lava']!;
      blocks[at(lx, y, lz)] = state;
    }

    // 地表替换：暴露在空腔里的地狱岩，按噪声换成灵魂沙或砂砾。
    // 一整个维度只有一种方块的话，走十分钟就会觉得"这地方是假的"
    const p = this.patch.stretched2(wx * 0.045, wz * 0.045);
    if (p > 0.55 || p < -0.62) {
      const surface = p > 0 ? this.st['soulSand']! : this.st['gravel']!;
      for (let y = NETHER_LAVA_LEVEL + 1; y < WORLD_HEIGHT - CEILING_BAND; y++) {
        if (blocks[at(lx, y, lz)] !== this.st['netherrack']!) continue;
        if (blocks[at(lx, y + 1, lz)] !== AIR_STATE) continue;
        blocks[at(lx, y, lz)] = surface;
        if (blocks[at(lx, y - 1, lz)] === this.st['netherrack']!) blocks[at(lx, y - 1, lz)] = surface;
      }
    }
  }

  /** 萤石簇与地面上的火 */
  private decorate(
    blocks: Uint16Array,
    at: (x: number, y: number, z: number) => number,
    rand: JavaRandom,
  ): void {
    // 萤石：挂在天花板下面的一小团。
    // 它是下界唯一的光源，密度直接决定这个维度是"幽暗"还是"漆黑"
    for (let i = 0; i < 8; i++) {
      const x = rand.nextInt(CHUNK_SIZE);
      const z = rand.nextInt(CHUNK_SIZE);
      const y0 = NETHER_LAVA_LEVEL + 20 + rand.nextInt(WORLD_HEIGHT - NETHER_LAVA_LEVEL - 32);
      // 往上找到天花板
      let y = y0;
      while (y < WORLD_HEIGHT - CEILING_BAND && blocks[at(x, y, z)] === AIR_STATE) y++;
      if (y >= WORLD_HEIGHT - CEILING_BAND) continue;
      // 从那里往下垂一小串
      const drop = 1 + rand.nextInt(4);
      for (let d = 1; d <= drop; d++) {
        const yy = y - d;
        if (yy <= NETHER_LAVA_LEVEL || blocks[at(x, yy, z)] !== AIR_STATE) break;
        // 越往下越细：只有第一格必放，后面按概率
        if (d > 1 && rand.nextInt(3) === 0) break;
        blocks[at(x, yy, z)] = this.st['glowstone']!;
      }
    }

    // 火：地面上零星几簇永不熄灭的火。
    // 下界的火在 MC 里是**永久**的（地狱岩上），这里生成时就摆好
    for (let i = 0; i < 6; i++) {
      const x = rand.nextInt(CHUNK_SIZE);
      const z = rand.nextInt(CHUNK_SIZE);
      for (let y = NETHER_LAVA_LEVEL + 2; y < WORLD_HEIGHT - CEILING_BAND - 1; y++) {
        if (blocks[at(x, y, z)] !== AIR_STATE) continue;
        if (blocks[at(x, y - 1, z)] !== this.st['netherrack']!) continue;
        if (rand.nextInt(4) !== 0) break;
        blocks[at(x, y, z)] = this.st['fire']!;
        break;
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

  /**
   * 下界的默认落脚点：原点附近第一个"脚下实心、头顶两格空"的地方。
   *
   * 与主世界不同，这里不挑群系也不管高度 —— 下界没有"宜居"可言，
   * 能站住就是全部要求。
   */
  findSpawn(): { x: number; y: number; z: number } {
    for (let r = 0; r < 8; r++) {
      for (let i = 0; i < 8; i++) {
        const angle = (i / 8) * Math.PI * 2;
        const cx = Math.round(Math.cos(angle) * r);
        const cz = Math.round(Math.sin(angle) * r);
        const chunk = this.generate(cx, cz);
        const found = firstStandable(chunk);
        if (found !== null) {
          return { x: cx * CHUNK_SIZE + found.x + 0.5, y: found.y, z: cz * CHUNK_SIZE + found.z + 0.5 };
        }
      }
    }
    return { x: 0.5, y: NETHER_LAVA_LEVEL + 10, z: 0.5 };
  }
}

/** 在一个区块里找第一个能站的位置。找不到返回 null */
function firstStandable(chunk: Chunk): { x: number; y: number; z: number } | null {
  for (let y = NETHER_LAVA_LEVEL + 2; y < WORLD_HEIGHT - CEILING_BAND - 2; y++) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        if (chunk.getState(x, y - 1, z) === AIR_STATE) continue;
        if (chunk.getState(x, y, z) !== AIR_STATE) continue;
        if (chunk.getState(x, y + 1, z) !== AIR_STATE) continue;
        return { x, y, z };
      }
    }
  }
  return null;
}
