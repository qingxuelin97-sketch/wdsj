/**
 * 矿脉生成。
 *
 * 形状用 MC 的算法：沿一条随机短线段生成一串半径正弦变化的椭球，
 * 得到的是紧实、略带延展的矿团 —— 而不是随机游走的蚯蚓，也不是噪声阈值的薄壳。
 * 前作用的是"每体素 3D 噪声过阈值"（D:\minecraft\terrain.js:220-243），
 * 产出的是弯曲的矿石片，且每个石头体素都要付一次 simplex 调用。
 *
 * Y 带严格照 core/constants.ts 的 ORE_DISTRIBUTION 表。
 * "Y=11 挖矿"这条元游戏必须成立，它是免费的（纯数据），却复刻了整个挖矿玩法。
 */
import { JavaRandom } from '../../../core/rng/java-random.ts';
import { CHUNK_SIZE, WORLD_HEIGHT, ORE_DISTRIBUTION, type OreSpec } from '../../../core/constants.ts';

export interface OreEntry {
  /** 要放置的方块状态 */
  readonly state: number;
  readonly spec: OreSpec;
  /** 每种矿石一个 salt，保证互相独立 */
  readonly salt: number;
}

/** 矿脉只替换这些方块（石头、下界岩等），不会挖穿空气或水 */
export type ReplaceTest = (state: number) => boolean;

export class OreGen {
  private readonly seed: bigint;
  private readonly entries: readonly OreEntry[];

  constructor(seed: bigint, entries: readonly OreEntry[]) {
    this.seed = seed;
    this.entries = entries;
  }

  /**
   * 按名字组装矿脉表。
   * @param stateOf 由方块名取状态值
   */
  static defaultEntries(stateOf: (name: string) => number): OreEntry[] {
    const map: [string, string, number][] = [
      // [矿石方块名, ORE_DISTRIBUTION 的键, salt]
      ['dirt', 'dirt', 0xd147],
      ['gravel', 'gravel', 0x9a41],
      ['coal_ore', 'coal', 0xc0a1],
      ['iron_ore', 'iron', 0x1204],
      ['gold_ore', 'gold', 0x901d],
      ['redstone_ore', 'redstone', 0x2ed5],
      ['diamond_ore', 'diamond', 0xd1a3],
      ['lapis_ore', 'lapis', 0x1a25],
    ];
    return map.map(([block, key, salt]) => ({
      state: stateOf(block),
      spec: ORE_DISTRIBUTION[key as keyof typeof ORE_DISTRIBUTION],
      salt,
    }));
  }

  /** 往一列区块里撒矿脉 */
  populate(cx: number, cz: number, blocks: Uint16Array, canReplace: ReplaceTest): void {
    for (const entry of this.entries) {
      const rng = new JavaRandom(
        this.seed ^ (BigInt(cx) * 341873128712n + BigInt(cz) * 132897987541n + BigInt(entry.salt)),
      );
      const { size, count, minY, maxY, triangularPeak } = entry.spec;
      for (let i = 0; i < count; i++) {
        const x = cx * CHUNK_SIZE + rng.nextInt(CHUNK_SIZE);
        const z = cz * CHUNK_SIZE + rng.nextInt(CHUNK_SIZE);
        const y = triangularPeak === undefined
          ? minY + rng.nextInt(maxY - minY + 1)
          // 三角分布：两个均匀分布相加，峰值落在中点。青金石就是这种分布
          : minY + rng.nextInt(triangularPeak - minY + 1) + rng.nextInt(maxY - triangularPeak + 1);
        this.placeVein(blocks, cx, cz, x, y, z, size, entry.state, canReplace, rng);
      }
    }
  }

  /**
   * 放一条矿脉。
   * 沿一条随机方向的短线段推进，每步雕一个半径按正弦变化的椭球 ——
   * 两端细、中间粗，这正是 MC 矿脉的形状。
   */
  private placeVein(
    blocks: Uint16Array,
    cx: number, cz: number,
    ox: number, oy: number, oz: number,
    size: number, state: number,
    canReplace: ReplaceTest,
    rng: JavaRandom,
  ): void {
    const angle = rng.nextFloat() * Math.PI;
    const spread = size / 8;
    const x1 = ox + Math.sin(angle) * spread;
    const x2 = ox - Math.sin(angle) * spread;
    const z1 = oz + Math.cos(angle) * spread;
    const z2 = oz - Math.cos(angle) * spread;
    const y1 = oy + rng.nextInt(3) - 2;
    const y2 = oy + rng.nextInt(3) - 2;

    const baseX = cx * CHUNK_SIZE;
    const baseZ = cz * CHUNK_SIZE;

    for (let i = 0; i < size; i++) {
      const t = size <= 1 ? 0.5 : i / (size - 1);
      const px = x1 + (x2 - x1) * t;
      const py = y1 + (y2 - y1) * t;
      const pz = z1 + (z2 - z1) * t;
      // 正弦包络：两端收细
      const radius = ((Math.sin((i * Math.PI) / size) + 1) * rng.nextFloat() * size) / 16 + 1;
      const r2 = radius * radius;

      const xa = Math.max(0, Math.floor(px - radius) - baseX);
      const xb = Math.min(CHUNK_SIZE - 1, Math.ceil(px + radius) - baseX);
      const za = Math.max(0, Math.floor(pz - radius) - baseZ);
      const zb = Math.min(CHUNK_SIZE - 1, Math.ceil(pz + radius) - baseZ);
      const ya = Math.max(1, Math.floor(py - radius));
      const yb = Math.min(WORLD_HEIGHT - 1, Math.ceil(py + radius));

      for (let y = ya; y <= yb; y++) {
        const dy = y + 0.5 - py;
        const dy2 = dy * dy;
        if (dy2 > r2) continue;
        for (let z = za; z <= zb; z++) {
          const dz = baseZ + z + 0.5 - pz;
          const dz2 = dz * dz;
          if (dy2 + dz2 > r2) continue;
          for (let x = xa; x <= xb; x++) {
            const dx = baseX + x + 0.5 - px;
            if (dx * dx + dy2 + dz2 > r2) continue;
            const idx = (y * CHUNK_SIZE + z) * CHUNK_SIZE + x;
            if (!canReplace(blocks[idx]!)) continue;
            blocks[idx] = state;
          }
        }
      }
    }
  }
}
