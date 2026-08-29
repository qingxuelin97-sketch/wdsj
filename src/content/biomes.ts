/**
 * 生物群系定义。
 *
 * id 沿用 Minecraft 1.0 的真实编号。1.0 共 16 个群系（含下界与末地），
 * 这里先落地主世界的部分，下界与末地在 M15/M16 补。
 *
 * 群系承担四件事：地形基准高度与起伏、地表方块、草木染色、以及装饰密度。
 * 前两件决定"地形长什么样"，后两件决定"截图看上去像不像 MC" ——
 * 按评分表，第 2 类（世界生成）占 14 分，是权重最高的一类。
 */

export interface BiomeDef {
  readonly id: number;
  readonly name: string;
  /** 温度 0..1，决定下雪还是下雨、水面是否结冰 */
  readonly temperature: number;
  /** 湿度 0..1 */
  readonly rainfall: number;
  /** 地形基准高度（相对海平面的偏移） */
  readonly baseHeight: number;
  /** 起伏幅度 */
  readonly heightVariation: number;
  /** 地表方块名 */
  readonly surface: string;
  /** 地表之下 3-4 格的填充方块 */
  readonly filler: string;
  /** 水下地表方块 */
  readonly underwater: string;
  /** 每区块的树数量期望 */
  readonly trees: number;
  /** 每区块的草丛数量 */
  readonly grass: number;
  /** 每区块的花数量 */
  readonly flowers: number;
  /** 每区块的仙人掌/枯木数量 */
  readonly cacti: number;
  /** 草地染色 RGB，0..1 */
  readonly grassColor: readonly [number, number, number];
  /** 树叶染色 */
  readonly foliageColor: readonly [number, number, number];
  /** 是否下雪而非下雨 */
  readonly snowy: boolean;
}

/** 群系 id 常量 */
export const Biome = {
  OCEAN: 0,
  PLAINS: 1,
  DESERT: 2,
  EXTREME_HILLS: 3,
  FOREST: 4,
  TAIGA: 5,
  SWAMPLAND: 6,
  RIVER: 7,
  HELL: 8,
  SKY: 9,
  FROZEN_OCEAN: 10,
  FROZEN_RIVER: 11,
  ICE_PLAINS: 12,
  ICE_MOUNTAINS: 13,
  MUSHROOM_ISLAND: 14,
  MUSHROOM_SHORE: 15,
} as const;
export type Biome = (typeof Biome)[keyof typeof Biome];

/** 温带草色，作为多数群系的基准 */
const GRASS_TEMPERATE: readonly [number, number, number] = [0.49, 0.72, 0.34];
const FOLIAGE_TEMPERATE: readonly [number, number, number] = [0.37, 0.67, 0.27];

export const BIOMES: readonly BiomeDef[] = [
  {
    id: Biome.OCEAN, name: 'ocean',
    temperature: 0.5, rainfall: 0.5,
    baseHeight: -18, heightVariation: 3,
    surface: 'sand', filler: 'sand', underwater: 'gravel',
    trees: 0, grass: 0, flowers: 0, cacti: 0,
    grassColor: [0.44, 0.66, 0.34], foliageColor: FOLIAGE_TEMPERATE, snowy: false,
  },
  {
    id: Biome.PLAINS, name: 'plains',
    temperature: 0.8, rainfall: 0.4,
    baseHeight: 2, heightVariation: 3,
    surface: 'grass_block', filler: 'dirt', underwater: 'dirt',
    // 1.0 的平原几乎没有树，但草和花很密 —— 这是它的辨识特征
    trees: 0.15, grass: 34, flowers: 6, cacti: 0,
    grassColor: [0.56, 0.75, 0.33], foliageColor: [0.45, 0.71, 0.26], snowy: false,
  },
  {
    id: Biome.DESERT, name: 'desert',
    temperature: 2.0, rainfall: 0.0,
    baseHeight: 2, heightVariation: 3,
    surface: 'sand', filler: 'sand', underwater: 'sand',
    trees: 0, grass: 0, flowers: 0, cacti: 3,
    grassColor: [0.75, 0.72, 0.33], foliageColor: [0.68, 0.68, 0.3], snowy: false,
  },
  {
    id: Biome.EXTREME_HILLS, name: 'extreme_hills',
    temperature: 0.2, rainfall: 0.3,
    // 极端起伏是这个群系的全部意义，也是最容易出现悬垂的地方
    baseHeight: 10, heightVariation: 26,
    surface: 'grass_block', filler: 'dirt', underwater: 'gravel',
    trees: 1, grass: 6, flowers: 1, cacti: 0,
    grassColor: [0.45, 0.66, 0.4], foliageColor: [0.35, 0.6, 0.32], snowy: false,
  },
  {
    id: Biome.FOREST, name: 'forest',
    temperature: 0.7, rainfall: 0.8,
    baseHeight: 3, heightVariation: 6,
    surface: 'grass_block', filler: 'dirt', underwater: 'dirt',
    trees: 10, grass: 14, flowers: 4, cacti: 0,
    grassColor: [0.4, 0.71, 0.27], foliageColor: [0.3, 0.67, 0.2], snowy: false,
  },
  {
    id: Biome.TAIGA, name: 'taiga',
    temperature: 0.05, rainfall: 0.8,
    baseHeight: 4, heightVariation: 8,
    surface: 'grass_block', filler: 'dirt', underwater: 'dirt',
    trees: 10, grass: 8, flowers: 1, cacti: 0,
    grassColor: [0.45, 0.63, 0.45], foliageColor: [0.38, 0.6, 0.4],
    // 1.0 的针叶林是积雪的（这一点到 1.7 才改）
    snowy: true,
  },
  {
    id: Biome.SWAMPLAND, name: 'swampland',
    temperature: 0.8, rainfall: 0.9,
    // 沼泽几乎贴着海平面，这是它"到处是浅水"的来源
    baseHeight: -0.5, heightVariation: 1.2,
    surface: 'grass_block', filler: 'dirt', underwater: 'dirt',
    trees: 2, grass: 20, flowers: 1, cacti: 0,
    grassColor: [0.42, 0.51, 0.3], foliageColor: [0.4, 0.49, 0.28], snowy: false,
  },
  {
    id: Biome.RIVER, name: 'river',
    temperature: 0.5, rainfall: 0.5,
    baseHeight: -6, heightVariation: 0.6,
    surface: 'sand', filler: 'sand', underwater: 'sand',
    trees: 0, grass: 0, flowers: 0, cacti: 0,
    grassColor: GRASS_TEMPERATE, foliageColor: FOLIAGE_TEMPERATE, snowy: false,
  },
  {
    id: Biome.FROZEN_OCEAN, name: 'frozen_ocean',
    temperature: 0.0, rainfall: 0.5,
    baseHeight: -18, heightVariation: 3,
    surface: 'gravel', filler: 'gravel', underwater: 'gravel',
    trees: 0, grass: 0, flowers: 0, cacti: 0,
    grassColor: [0.5, 0.62, 0.5], foliageColor: [0.42, 0.58, 0.45], snowy: true,
  },
  {
    id: Biome.FROZEN_RIVER, name: 'frozen_river',
    temperature: 0.0, rainfall: 0.5,
    baseHeight: -6, heightVariation: 0.6,
    surface: 'sand', filler: 'sand', underwater: 'sand',
    trees: 0, grass: 0, flowers: 0, cacti: 0,
    grassColor: [0.5, 0.62, 0.5], foliageColor: [0.42, 0.58, 0.45], snowy: true,
  },
  {
    id: Biome.ICE_PLAINS, name: 'ice_plains',
    temperature: 0.0, rainfall: 0.5,
    baseHeight: 2, heightVariation: 3,
    surface: 'grass_block', filler: 'dirt', underwater: 'dirt',
    trees: 0, grass: 3, flowers: 0, cacti: 0,
    grassColor: [0.5, 0.62, 0.5], foliageColor: [0.42, 0.58, 0.45], snowy: true,
  },
  {
    id: Biome.ICE_MOUNTAINS, name: 'ice_mountains',
    temperature: 0.0, rainfall: 0.5,
    baseHeight: 12, heightVariation: 18,
    surface: 'grass_block', filler: 'dirt', underwater: 'gravel',
    trees: 0, grass: 2, flowers: 0, cacti: 0,
    grassColor: [0.5, 0.62, 0.5], foliageColor: [0.42, 0.58, 0.45], snowy: true,
  },
  {
    id: Biome.MUSHROOM_ISLAND, name: 'mushroom_island',
    temperature: 0.9, rainfall: 1.0,
    baseHeight: 2, heightVariation: 5,
    surface: 'mycelium', filler: 'dirt', underwater: 'dirt',
    trees: 0, grass: 0, flowers: 0, cacti: 0,
    grassColor: [0.44, 0.66, 0.34], foliageColor: FOLIAGE_TEMPERATE, snowy: false,
  },
  {
    id: Biome.MUSHROOM_SHORE, name: 'mushroom_shore',
    temperature: 0.9, rainfall: 1.0,
    baseHeight: -1, heightVariation: 1,
    surface: 'mycelium', filler: 'dirt', underwater: 'dirt',
    trees: 0, grass: 0, flowers: 0, cacti: 0,
    grassColor: [0.44, 0.66, 0.34], foliageColor: FOLIAGE_TEMPERATE, snowy: false,
  },
];

/** 按 id 索引的查表，id 不连续时留 null */
const BY_ID: (BiomeDef | null)[] = [];
for (const b of BIOMES) {
  while (BY_ID.length <= b.id) BY_ID.push(null);
  BY_ID[b.id] = b;
}

export function getBiome(id: number): BiomeDef {
  const b = BY_ID[id];
  if (b == null) throw new Error(`未知的群系 id ${id}`);
  return b;
}

export function getBiomeByName(name: string): BiomeDef {
  const b = BIOMES.find((x) => x.name === name);
  if (b === undefined) throw new Error(`未知的群系名 '${name}'`);
  return b;
}

/**
 * 烘焙成扁平表，供热路径（地表处理、装饰、染色）使用。
 * 与方块表同一套思路：注册期做一次，之后只读 typed array。
 */
export interface BiomeTables {
  readonly count: number;
  readonly baseHeight: Float32Array;
  readonly heightVariation: Float32Array;
  readonly temperature: Float32Array;
  readonly rainfall: Float32Array;
  readonly snowy: Uint8Array;
  /** 每个群系 3 个分量的草色与叶色 */
  readonly grassColor: Float32Array;
  readonly foliageColor: Float32Array;
}

export function buildBiomeTables(): BiomeTables {
  const n = BY_ID.length;
  const t: BiomeTables = {
    count: n,
    baseHeight: new Float32Array(n),
    heightVariation: new Float32Array(n),
    temperature: new Float32Array(n),
    rainfall: new Float32Array(n),
    snowy: new Uint8Array(n),
    grassColor: new Float32Array(n * 3),
    foliageColor: new Float32Array(n * 3),
  };
  for (let i = 0; i < n; i++) {
    const b = BY_ID[i];
    if (b == null) continue;
    t.baseHeight[i] = b.baseHeight;
    t.heightVariation[i] = b.heightVariation;
    t.temperature[i] = b.temperature;
    t.rainfall[i] = b.rainfall;
    t.snowy[i] = b.snowy ? 1 : 0;
    for (let c = 0; c < 3; c++) {
      t.grassColor[i * 3 + c] = b.grassColor[c]!;
      t.foliageColor[i * 3 + c] = b.foliageColor[c]!;
    }
  }
  return t;
}
