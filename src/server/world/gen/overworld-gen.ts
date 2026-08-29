/**
 * 主世界生成器：把各阶段串成一条流水线。
 *
 *   1. 密度场      3D 噪声 -> 石头/水，产生悬垂与峭壁
 *   2. 雕刻        洞穴（perlin worm）与峡谷
 *   3. 矿脉        按 1.0 的 Y 带表撒矿
 *   4. 地表        群系地表方块、基岩、雪与冰
 *   5. 装饰        树、草、花、仙人掌（需要邻居的地形阶段就绪）
 *
 * 阶段 1-4 只依赖自身坐标，结果被缓存成"地形阶段"；阶段 5 要读 3×3 邻域，
 * 所以生成一个区块时会顺带把周围 8 个区块的地形阶段算出来并缓存。
 * 这是 MC 的两阶段做法，也是"树冠能跨区块而不被切平"的前提。
 */
import { Chunk, ChunkSection, packState, AIR_STATE } from '../../../core/world/chunk.ts';
import { CHUNK_SIZE, WORLD_HEIGHT, SECTIONS_PER_COLUMN, SEA_LEVEL } from '../../../core/constants.ts';
import type { BlockRegistry } from '../../../core/registry/block-registry.ts';
import { buildBiomeTables, getBiome, BIOMES, Biome, type BiomeDef, type BiomeTables } from '../../../content/biomes.ts';
import { BiomeSource } from './biome-source.ts';
import { TerrainGen } from './terrain-gen.ts';
import { CaveCarver, type CarveTarget } from './caves.ts';
import { OreGen } from './ores.ts';
import { SurfaceBuilder, type SurfaceStates } from './surface.ts';
import { Decorator, type DecorAccess, type DecorStates } from './decorator.ts';

const COLUMN_VOLUME = CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT;

/** 地形阶段的产物 */
interface TerrainStage {
  blocks: Uint16Array;
  biomes: Uint8Array;
}

/** 缓存多少个区块的地形阶段。3×3 邻域 + 余量 */
const TERRAIN_CACHE_LIMIT = 96;

export class OverworldGenerator {
  readonly seed: bigint;
  private readonly biomeSource: BiomeSource;
  private readonly biomeTables: BiomeTables;
  private readonly terrain: TerrainGen;
  private readonly caves: CaveCarver;
  private readonly ores: OreGen;
  private readonly surface: SurfaceBuilder;
  private readonly decorator: Decorator;

  private readonly stageCache = new Map<string, TerrainStage>();
  /** 出生点缓存。它是世界的固有属性，搜索一次即可 */
  private spawnCache: { x: number; y: number; z: number } | null = null;
  private readonly surfaceStates: SurfaceStates;
  private readonly decorStates: DecorStates;
  private readonly st: Record<string, number>;
  /** 可被洞穴雕掉、可被矿脉替换的方块集合 */
  private readonly carvable = new Set<number>();

  constructor(seed: bigint, registry: BlockRegistry) {
    this.seed = seed;
    this.biomeTables = buildBiomeTables();
    this.biomeSource = new BiomeSource(seed, this.biomeTables);
    this.terrain = new TerrainGen(seed, this.biomeSource);
    this.caves = new CaveCarver(seed);
    this.surface = new SurfaceBuilder(seed, this.biomeTables);
    this.decorator = new Decorator(seed);

    const s = (name: string): number => packState(registry.idOf(name));
    this.st = {
      air: AIR_STATE,
      stone: s('stone'),
      // 海平面以下填的是**静止水**（id 9）而不是流动水：生成出来的海本来
      // 就是稳定的，用流动水的话每一格都会排一条计划刻，一个区块几千条，
      // 加载一片海就把队列撑爆了
      water: s('water'),
      ice: s('ice'),
      lava: s('lava'),
      bedrock: s('bedrock'),
      grassBlock: s('grass_block'),
      dirt: s('dirt'),
      sand: s('sand'),
      gravel: s('gravel'),
      snowBlock: s('snow_block'),
      mycelium: s('mycelium'),
      log: s('log'),
      leaves: s('leaves'),
      tallGrass: s('tall_grass'),
      dandelion: s('dandelion'),
      rose: s('rose'),
      brownMushroom: s('brown_mushroom'),
      redMushroom: s('red_mushroom'),
      deadBush: s('dead_bush'),
    };

    this.ores = new OreGen(seed, OreGen.defaultEntries((name) => s(name)));

    // 洞穴与矿脉只动这些方块，绝不碰基岩、水、已放置的装饰
    for (const name of ['stone', 'dirt', 'grass_block', 'sand', 'gravel', 'snow_block', 'mycelium']) {
      this.carvable.add(s(name));
    }

    const n = this.biomeTables.count;
    const surfaceByBiome = new Uint16Array(n);
    const fillerByBiome = new Uint16Array(n);
    const underwaterByBiome = new Uint16Array(n);
    for (const b of BIOMES) {
      surfaceByBiome[b.id] = s(b.surface);
      fillerByBiome[b.id] = s(b.filler);
      underwaterByBiome[b.id] = s(b.underwater);
    }

    this.surfaceStates = {
      air: this.st['air']!, stone: this.st['stone']!, water: this.st['water']!,
      ice: this.st['ice']!, bedrock: this.st['bedrock']!, snowLayer: this.st['snowBlock']!,
      // M7 补上 snow_layer 的 1/8 高模型后改成 true
      enableSnowLayer: false,
      surfaceByBiome, fillerByBiome, underwaterByBiome,
    };

    this.decorStates = {
      air: this.st['air']!, water: this.st['water']!,
      grassBlock: this.st['grassBlock']!, dirt: this.st['dirt']!, sand: this.st['sand']!,
      mycelium: this.st['mycelium']!, log: this.st['log']!, leaves: this.st['leaves']!,
      tallGrass: this.st['tallGrass']!, dandelion: this.st['dandelion']!, rose: this.st['rose']!,
      brownMushroom: this.st['brownMushroom']!, redMushroom: this.st['redMushroom']!,
      deadBush: this.st['deadBush']!, snowLayer: this.st['snowBlock']!,
    };
  }

  /** 该列的群系 */
  biomeAt(wx: number, wz: number): BiomeDef {
    return getBiome(this.biomeSource.biomeAt(wx, wz));
  }

  /** 地形阶段（含雕刻、矿脉、地表），带缓存 */
  private terrainStageOf(cx: number, cz: number): TerrainStage {
    const key = `${cx},${cz}`;
    const cached = this.stageCache.get(key);
    if (cached !== undefined) return cached;

    const blocks = new Uint16Array(COLUMN_VOLUME);
    const biomes = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);

    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        biomes[z * CHUNK_SIZE + x] = this.biomeSource.biomeAt(cx * CHUNK_SIZE + x, cz * CHUNK_SIZE + z);
      }
    }

    this.terrain.generateColumn(cx, cz, blocks, this.st['stone']!, this.st['water']!);

    const target: CarveTarget = {
      blocks, cx, cz,
      isCarvable: (state) => this.carvable.has(state),
      airState: this.st['air']!,
      lavaState: this.st['lava']!,
    };
    this.caves.carve(target);

    this.ores.populate(cx, cz, blocks, (state) => state === this.st['stone']);
    this.surface.apply(cx, cz, blocks, biomes, this.surfaceStates);

    const stage: TerrainStage = { blocks, biomes };
    this.stageCache.set(key, stage);
    // 简单的 FIFO 淘汰：地形阶段的访问模式是滑动窗口，不值得上 LRU
    if (this.stageCache.size > TERRAIN_CACHE_LIMIT) {
      const oldest = this.stageCache.keys().next();
      if (!oldest.done) this.stageCache.delete(oldest.value);
    }
    return stage;
  }

  /** 生成一个完整区块 */
  generate(cx: number, cz: number): Chunk {
    // 先确保 3×3 邻域的地形阶段就绪，装饰才能跨区块写
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) this.terrainStageOf(cx + dx, cz + dz);
    }
    const center = this.terrainStageOf(cx, cz);

    const baseX = cx * CHUNK_SIZE;
    const baseZ = cz * CHUNK_SIZE;
    const access: DecorAccess = {
      get: (wx, wy, wz) => {
        if (wy < 0 || wy >= WORLD_HEIGHT) return AIR_STATE;
        const stage = this.terrainStageOf(wx >> 4, wz >> 4);
        return stage.blocks[(wy * CHUNK_SIZE + (wz & 15)) * CHUNK_SIZE + (wx & 15)]!;
      },
      set: (wx, wy, wz, state) => {
        // 裁剪：只写目标区块内的格子，越界的静默丢弃
        if (wy < 0 || wy >= WORLD_HEIGHT) return;
        const lx = wx - baseX;
        const lz = wz - baseZ;
        if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE) return;
        center.blocks[(wy * CHUNK_SIZE + lz) * CHUNK_SIZE + lx] = state;
      },
    };

    this.decorator.decorate(cx, cz, access, (wx, wz) => this.biomeAt(wx, wz), this.decorStates);

    return this.packChunk(cx, cz, center);
  }

  /** 把整列的扁平数组切成 Chunk 的子区块 */
  private packChunk(cx: number, cz: number, stage: TerrainStage): Chunk {
    const chunk = new Chunk(cx, cz);
    chunk.biomes.set(stage.biomes);

    for (let sy = 0; sy < SECTIONS_PER_COLUMN; sy++) {
      let hasBlocks = false;
      const states = new Uint16Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        const wy = sy * CHUNK_SIZE + ly;
        for (let z = 0; z < CHUNK_SIZE; z++) {
          for (let x = 0; x < CHUNK_SIZE; x++) {
            const v = stage.blocks[(wy * CHUNK_SIZE + z) * CHUNK_SIZE + x]!;
            if (v === AIR_STATE) continue;
            states[(ly << 8) | (z << 4) | x] = v;
            hasBlocks = true;
          }
        }
      }
      if (hasBlocks) chunk.sections[sy] = new ChunkSection(states);
    }

    chunk.recomputeHeightmap();
    return chunk;
  }

  /**
   * 找一个适合出生的位置：温带陆地、在海平面之上、上方有空间。
   *
   * 与 MC 一致，出生点限定在少数几个"宜居"群系里。不加这个限制的话，
   * 玩家有相当概率被扔进一望无际的雪原或沙漠，第一印象会很糟。
   */
  findSpawn(): { x: number; y: number; z: number } {
    if (this.spawnCache !== null) return this.spawnCache;
    const preferred = new Set<number>([Biome.PLAINS, Biome.FOREST, Biome.TAIGA, Biome.SWAMPLAND]);
    // 两轮：先只认宜居群系，找不到再放宽到任意陆地
    for (const strict of [true, false]) {
      const found = this.searchSpawn(preferred, strict);
      if (found !== null) {
        this.spawnCache = found;
        return found;
      }
    }
    this.spawnCache = { x: 0.5, y: SEA_LEVEL + 2, z: 0.5 };
    return this.spawnCache;
  }

  private searchSpawn(preferred: Set<number>, strict: boolean): { x: number; y: number; z: number } | null {
    for (let r = 0; r < 96; r++) {
      for (let i = 0; i < 12; i++) {
        const angle = (i / 12) * Math.PI * 2 + r * 0.7;
        const x = Math.round(Math.cos(angle) * r * 16);
        const z = Math.round(Math.sin(angle) * r * 16);
        if (strict && !preferred.has(this.biomeSource.biomeAt(x, z))) continue;
        const stage = this.terrainStageOf(x >> 4, z >> 4);
        const lx = x & 15;
        const lz = z & 15;
        for (let y = WORLD_HEIGHT - 2; y > SEA_LEVEL; y--) {
          const here = stage.blocks[(y * CHUNK_SIZE + lz) * CHUNK_SIZE + lx]!;
          const above = stage.blocks[((y + 1) * CHUNK_SIZE + lz) * CHUNK_SIZE + lx]!;
          if (here !== AIR_STATE && here !== this.st['water'] && above === AIR_STATE) {
            return { x: x + 0.5, y: y + 1, z: z + 0.5 };
          }
        }
      }
    }
    return null;
  }

  /** 清空地形阶段缓存，释放内存 */
  clearCache(): void {
    this.stageCache.clear();
  }
}
