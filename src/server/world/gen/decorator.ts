/**
 * 地表装饰：树、草丛、花、仙人掌、甘蔗。
 *
 * 装饰必须能跨区块写入（树冠常常压到邻居头上），所以走 MC 的两阶段做法：
 * 先把 3×3 邻域的**地形阶段**全部生成好，再对中心区块做装饰，
 * 写入时由 DecorAccess 裁剪到目标区块。
 *
 * 每个区块用自己的确定性 RNG，于是"这个区块长几棵树、长在哪"只取决于它自己的坐标，
 * 与玩家先走到哪一块完全无关。
 */
import { JavaRandom } from '../../../core/rng/java-random.ts';
import { CHUNK_SIZE, WORLD_HEIGHT, SEA_LEVEL } from '../../../core/constants.ts';
import type { BiomeDef } from '../../../content/biomes.ts';

const SALT_DECOR = 0xdec04an;

/** 装饰阶段用到的方块状态 */
export interface DecorStates {
  air: number;
  water: number;
  grassBlock: number;
  dirt: number;
  sand: number;
  mycelium: number;
  log: number;
  leaves: number;
  tallGrass: number;
  dandelion: number;
  rose: number;
  brownMushroom: number;
  redMushroom: number;
  deadBush: number;
  snowLayer: number;
}

/**
 * 装饰阶段的世界访问。
 * get 能读到邻居区块（地形阶段已就绪），set 只写目标区块内的格子。
 */
export interface DecorAccess {
  get(wx: number, wy: number, wz: number): number;
  /** 越界写入会被静默丢弃 —— 这正是"裁剪"的含义 */
  set(wx: number, wy: number, wz: number, state: number): void;
}

export class Decorator {
  private readonly seed: bigint;

  constructor(seed: bigint) {
    this.seed = seed;
  }

  /**
   * 装饰一个区块。会遍历 3×3 邻域，让邻居区块的树也能把树冠伸进来。
   * @param biomeAt 由世界坐标取群系定义
   */
  decorate(cx: number, cz: number, access: DecorAccess, biomeAt: (wx: number, wz: number) => BiomeDef, s: DecorStates): void {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        this.decorateFrom(cx + dx, cz + dz, access, biomeAt, s);
      }
    }
  }

  /** 生成源区块 (ox,oz) 的装饰，写入被 access 裁剪到目标区块 */
  private decorateFrom(ox: number, oz: number, access: DecorAccess, biomeAt: (wx: number, wz: number) => BiomeDef, s: DecorStates): void {
    const rng = new JavaRandom(
      this.seed ^ (BigInt(ox) * 341873128712n + BigInt(oz) * 132897987541n + SALT_DECOR),
    );
    const baseX = ox * CHUNK_SIZE;
    const baseZ = oz * CHUNK_SIZE;
    // 用区块中心的群系决定装饰密度，与 MC 一致（避免一个区块里密度来回跳）
    const biome = biomeAt(baseX + 8, baseZ + 8);

    // --- 树 ---
    // 小数部分用一次 roll 决定要不要多长一棵，这样 0.15 棵/区块这种密度也能表达
    let treeCount = Math.floor(biome.trees);
    if (rng.nextFloat() < biome.trees - treeCount) treeCount++;
    for (let i = 0; i < treeCount; i++) {
      const wx = baseX + rng.nextInt(CHUNK_SIZE);
      const wz = baseZ + rng.nextInt(CHUNK_SIZE);
      const y = this.groundAt(access, wx, wz, s);
      if (y < 0) continue;
      const ground = access.get(wx, y, wz);
      if (ground !== s.grassBlock && ground !== s.dirt) continue;
      if (biome.name === 'taiga') this.placeSpruce(access, wx, y + 1, wz, s, rng);
      else this.placeOak(access, wx, y + 1, wz, s, rng);
    }

    // --- 草丛 ---
    for (let i = 0; i < biome.grass; i++) {
      const wx = baseX + rng.nextInt(CHUNK_SIZE);
      const wz = baseZ + rng.nextInt(CHUNK_SIZE);
      const y = this.groundAt(access, wx, wz, s);
      if (y < 0) continue;
      const ground = access.get(wx, y, wz);
      if (ground !== s.grassBlock && ground !== s.mycelium) continue;
      if (access.get(wx, y + 1, wz) !== s.air) continue;
      access.set(wx, y + 1, wz, s.tallGrass);
    }

    // --- 花与蘑菇 ---
    for (let i = 0; i < biome.flowers; i++) {
      const wx = baseX + rng.nextInt(CHUNK_SIZE);
      const wz = baseZ + rng.nextInt(CHUNK_SIZE);
      const y = this.groundAt(access, wx, wz, s);
      if (y < 0) continue;
      if (access.get(wx, y, wz) !== s.grassBlock) continue;
      if (access.get(wx, y + 1, wz) !== s.air) continue;
      const roll = rng.nextInt(10);
      const plant = roll < 5 ? s.dandelion : roll < 8 ? s.rose : roll < 9 ? s.brownMushroom : s.redMushroom;
      access.set(wx, y + 1, wz, plant);
    }

    // --- 仙人掌与枯木（沙漠） ---
    for (let i = 0; i < biome.cacti; i++) {
      const wx = baseX + rng.nextInt(CHUNK_SIZE);
      const wz = baseZ + rng.nextInt(CHUNK_SIZE);
      const y = this.groundAt(access, wx, wz, s);
      if (y < 0 || access.get(wx, y, wz) !== s.sand) continue;
      if (rng.nextInt(4) === 0) {
        if (access.get(wx, y + 1, wz) === s.air) access.set(wx, y + 1, wz, s.deadBush);
      }
    }
  }

  /** 找该列最高的实心地面（跳过水与空气），返回 y；找不到返回 -1 */
  private groundAt(access: DecorAccess, wx: number, wz: number, s: DecorStates): number {
    for (let y = WORLD_HEIGHT - 2; y >= 1; y--) {
      const state = access.get(wx, y, wz);
      if (state === s.air || state === s.water) continue;
      // 只在水面附近及以上种东西
      return y >= SEA_LEVEL - 1 ? y : -1;
    }
    return -1;
  }

  /** 橡树：4-6 格树干 + 两层宽两层窄的树冠 */
  private placeOak(access: DecorAccess, wx: number, wy: number, wz: number, s: DecorStates, rng: JavaRandom): void {
    const height = 4 + rng.nextInt(3);
    // 先确认上方有空间，避免树穿进悬垂地形里
    for (let i = 0; i < height + 2; i++) {
      if (access.get(wx, wy + i, wz) !== s.air) return;
    }
    for (let i = 0; i < height; i++) access.set(wx, wy + i, wz, s.log);

    const top = wy + height - 1;
    for (let dy = -2; dy <= 1; dy++) {
      const radius = dy <= -1 ? 2 : 1;
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx === 0 && dz === 0 && dy <= 0) continue; // 给树干让位
          // 削掉四个角，让树冠是圆的而不是方的
          if (Math.abs(dx) === radius && Math.abs(dz) === radius && (radius > 1 ? rng.nextBoolean() : true)) continue;
          const y = top + dy;
          if (access.get(wx + dx, y, wz + dz) === s.air) access.set(wx + dx, y, wz + dz, s.leaves);
        }
      }
    }
  }

  /** 云杉：细高的圆锥形，针叶林的标志 */
  private placeSpruce(access: DecorAccess, wx: number, wy: number, wz: number, s: DecorStates, rng: JavaRandom): void {
    const height = 6 + rng.nextInt(4);
    for (let i = 0; i < height + 1; i++) {
      if (access.get(wx, wy + i, wz) !== s.air) return;
    }
    for (let i = 0; i < height; i++) access.set(wx, wy + i, wz, s.log);

    // 从下往上一圈圈收窄，每两层换一次半径，形成锥形
    const leafBottom = wy + 1 + rng.nextInt(2);
    let radius = 0;
    for (let y = wy + height; y >= leafBottom; y--) {
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dz * dz > radius * radius + 1) continue;
          if (dx === 0 && dz === 0 && y < wy + height) continue;
          if (access.get(wx + dx, y, wz + dz) === s.air) access.set(wx + dx, y, wz + dz, s.leaves);
        }
      }
      // 每两层加宽一次，到 2 就封顶
      if ((wy + height - y) % 2 === 1 && radius < 2) radius++;
      else if (radius >= 2 && rng.nextInt(3) === 0) radius = 1;
    }
  }
}
