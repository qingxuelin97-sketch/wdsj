/**
 * 洞穴与峡谷雕刻。
 *
 * 用真正的 perlin worm：从一个起点出发，方向被噪声持续扰动，一路雕刻球体。
 * 前作的所谓 worm 其实是**单段直线胶囊**（ga/Caves.ts:61-81），产生的是一截截
 * 互不相连的短管，而不是能走通的洞穴网络 —— 那是占位实现，不是洞穴。
 *
 * 跨区块一致性用"邻域裁剪"：每个区块独立推导周围 ±8 区块里所有可能波及它的洞穴，
 * 只把落在自己范围内的部分雕掉。于是不需要 proto-chunk 暂存，也不依赖生成顺序。
 * 代价是一条跨 4 个区块的洞穴被算了 4 次 —— 很便宜，值得。
 */
import { JavaRandom } from '../../../core/rng/java-random.ts';
import { noiseFromSeed, type OctaveNoise } from '../../../core/noise/perlin.ts';
import { CHUNK_SIZE, WORLD_HEIGHT, SEA_LEVEL, RAVINE_CHANCE } from '../../../core/constants.ts';

/** 检查多远范围内的区块是否有洞穴会波及本区块 */
const CAVE_RANGE = 8;
/** 每个区块生成洞穴系统的概率 */
const CAVE_CHANCE = 1 / 7;
/** 一个洞穴系统里的隧道条数上限 */
const MAX_TUNNELS = 4;

/** RNG salt。提成命名常量，避免在调用处写魔法数字 */
const SALT_CAVE = 0xca7e;
const SALT_RAVINE = 0x2af1;

/**
 * 便宜的整数 hash，用来在建 JavaRandom **之前**先筛掉绝大多数区块。
 *
 * 洞穴要检查 17×17=289 个邻域区块，峡谷再检查 13×13=169 个。若每个都先构造
 * JavaRandom（内含 BigInt 乘法与异或），单是这一步就占掉每区块几十毫秒。
 * 用整数 hash 预筛后只有约 1/7 的区块需要真正建 RNG。
 */
function fastHash(x: number, z: number, salt: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(z, 0x165667b1) ^ Math.imul(salt, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** hash 转 [0,1) */
function hashUnit(x: number, z: number, salt: number): number {
  return fastHash(x, z, salt) / 4294967296;
}

export interface CarveTarget {
  /** 整列方块，下标 (y*16+z)*16+x */
  readonly blocks: Uint16Array;
  readonly cx: number;
  readonly cz: number;
  /** 判断某个状态是否可被雕掉（石头、泥土、沙砾等，但不含基岩与水） */
  isCarvable(state: number): boolean;
  /** 雕空后写入的状态：水面以下保留水，否则空气 */
  airState: number;
  lavaState: number;
}

export class CaveCarver {
  private readonly seed: bigint;
  private readonly dirNoise: OctaveNoise;

  constructor(seed: bigint) {
    this.seed = seed;
    // 2 倍频：这条噪声只用来平滑地扰动隧道方向，不需要多少细节层次。
    // 3 倍频时每步要 6 次 Perlin 调用，而一次区块生成有上万步 ——
    // 实测洞穴占掉整个生成流程的 66%，是首要的优化点。
    // 不用 1 倍频是因为倍频越少标准差越大（实测 1 倍频 σ 明显高于 3 倍频），
    // 扰动过强会让隧道很快钻出 y 范围，洞穴总量反而掉下去。
    this.dirNoise = noiseFromSeed(seed, 0x5ca4, 2);
  }

  /** 区块专属的确定性 RNG */
  private chunkRandom(cx: number, cz: number, salt: number): JavaRandom {
    return new JavaRandom(
      this.seed ^ (BigInt(cx) * 341873128712n + BigInt(cz) * 132897987541n + BigInt(salt)),
    );
  }

  /** 对一列区块施加所有会波及它的洞穴与峡谷 */
  carve(target: CarveTarget): void {
    for (let dz = -CAVE_RANGE; dz <= CAVE_RANGE; dz++) {
      for (let dx = -CAVE_RANGE; dx <= CAVE_RANGE; dx++) {
        const ox = target.cx + dx;
        const oz = target.cz + dz;
        this.carveFromChunk(ox, oz, target);
      }
    }
    // 峡谷范围更大但更稀有，单独一轮
    for (let dz = -6; dz <= 6; dz++) {
      for (let dx = -6; dx <= 6; dx++) {
        this.carveRavineFrom(target.cx + dx, target.cz + dz, target);
      }
    }
  }

  /** 若 (ox,oz) 区块有洞穴起点，雕刻它波及 target 的部分 */
  private carveFromChunk(ox: number, oz: number, target: CarveTarget): void {
    // 先用整数 hash 预筛，绝大多数区块在这里就返回了，不必付 BigInt 的代价
    if (hashUnit(ox, oz, SALT_CAVE) > CAVE_CHANCE) return;
    const rng = this.chunkRandom(ox, oz, SALT_CAVE);

    const tunnels = 1 + rng.nextInt(MAX_TUNNELS);
    for (let t = 0; t < tunnels; t++) {
      const startX = ox * CHUNK_SIZE + rng.nextInt(CHUNK_SIZE);
      const startZ = oz * CHUNK_SIZE + rng.nextInt(CHUNK_SIZE);
      // 洞穴主要分布在 y 8..60，深处更密
      const startY = 8 + rng.nextInt(52);
      const length = 40 + rng.nextInt(120);
      const baseRadius = 1.4 + rng.nextFloat() * 1.9;
      let yaw = rng.nextFloat() * Math.PI * 2;
      let pitch = (rng.nextFloat() - 0.5) * 0.5;
      this.walkTunnel(target, startX, startY, startZ, yaw, pitch, baseRadius, length, rng);

      // 20% 的隧道会分叉一条更短的支路，让洞穴系统有分支结构
      if (rng.nextFloat() < 0.2) {
        yaw += (rng.nextFloat() - 0.5) * 2;
        pitch = (rng.nextFloat() - 0.5) * 0.6;
        this.walkTunnel(target, startX, startY, startZ, yaw, pitch, baseRadius * 0.75, length >> 1, rng);
      }
    }
  }

  /**
   * 走一条隧道。方向被噪声持续扰动，这才是"worm"的意思。
   * 每步先做包围盒剔除，绝大多数步与当前区块无关，能立刻跳过。
   */
  private walkTunnel(
    target: CarveTarget,
    x0: number, y0: number, z0: number,
    yaw0: number, pitch0: number,
    baseRadius: number, length: number,
    rng: JavaRandom,
  ): void {
    // 整条隧道的粗剔除：每步最多移动 1 格，所以它绝不可能跑出起点 length+radius 之外。
    // 不做这一步的话，即使隧道离目标区块很远，也要把 40-160 步全部走完才发现白走。
    const targetCX = target.cx * CHUNK_SIZE + CHUNK_SIZE / 2;
    const targetCZ = target.cz * CHUNK_SIZE + CHUNK_SIZE / 2;
    const reach = length + baseRadius * 2 + CHUNK_SIZE;
    if (Math.abs(x0 - targetCX) > reach || Math.abs(z0 - targetCZ) > reach) return;

    let x = x0;
    let y = y0;
    let z = z0;
    let yaw = yaw0;
    let pitch = pitch0;
    // 噪声采样的相位，让每条隧道的扰动序列不同
    const phase = rng.nextFloat() * 1000;

    const minX = target.cx * CHUNK_SIZE - 8;
    const maxX = minX + CHUNK_SIZE + 16;
    const minZ = target.cz * CHUNK_SIZE - 8;
    const maxZ = minZ + CHUNK_SIZE + 16;

    for (let step = 0; step < length; step++) {
      // 方向扰动：用噪声而不是纯随机，这样路径是平滑的曲线而不是布朗运动
      yaw += this.dirNoise.noise2(phase + step * 0.08, 0) * 0.35;
      pitch += this.dirNoise.noise2(0, phase + step * 0.11) * 0.22;
      // 让隧道整体偏向水平，否则会打成一堆竖井
      pitch *= 0.82;

      const cp = Math.cos(pitch);
      x += Math.cos(yaw) * cp;
      y += Math.sin(pitch);
      z += Math.sin(yaw) * cp;

      // 触到上下边界时**反弹**而不是终止。
      // 直接 break 会让相当一部分隧道半途而废，洞穴总量和连通性都掉一截；
      // 反弹则让它沿着边界继续延伸，更像真实的洞穴系统。
      if (y < 6) {
        y = 6;
        pitch = Math.abs(pitch);
      } else if (y > 96) {
        y = 96;
        pitch = -Math.abs(pitch);
      }

      // 半径随位置起伏，形成宽窄相间的洞道与偶尔的大厅
      const widen = 1 + this.dirNoise.noise2(phase * 0.5, step * 0.04) * 0.8;
      const radius = baseRadius * Math.max(0.5, widen);

      if (x + radius < minX || x - radius > maxX || z + radius < minZ || z - radius > maxZ) continue;
      this.carveSphere(target, x, y, z, radius);
    }
  }

  /** 在指定位置雕一个球，只写落在当前区块内的格子 */
  private carveSphere(target: CarveTarget, cxp: number, cyp: number, czp: number, radius: number): void {
    const baseX = target.cx * CHUNK_SIZE;
    const baseZ = target.cz * CHUNK_SIZE;
    const r2 = radius * radius;
    // 垂直方向压扁一点，洞穴看起来更像被水侵蚀出来的
    const ry = radius * 0.78;

    const x0 = Math.max(0, Math.floor(cxp - radius) - baseX);
    const x1 = Math.min(CHUNK_SIZE - 1, Math.ceil(cxp + radius) - baseX);
    const z0 = Math.max(0, Math.floor(czp - radius) - baseZ);
    const z1 = Math.min(CHUNK_SIZE - 1, Math.ceil(czp + radius) - baseZ);
    const y0 = Math.max(1, Math.floor(cyp - ry));
    const y1 = Math.min(WORLD_HEIGHT - 1, Math.ceil(cyp + ry));

    for (let y = y0; y <= y1; y++) {
      const dy = (y + 0.5 - cyp) / 0.78;
      const dy2 = dy * dy;
      if (dy2 > r2) continue;
      for (let z = z0; z <= z1; z++) {
        const dz = baseZ + z + 0.5 - czp;
        const dz2 = dz * dz;
        if (dy2 + dz2 > r2) continue;
        for (let x = x0; x <= x1; x++) {
          const dx = baseX + x + 0.5 - cxp;
          if (dx * dx + dy2 + dz2 > r2) continue;
          const i = (y * CHUNK_SIZE + z) * CHUNK_SIZE + x;
          const state = target.blocks[i]!;
          if (!target.isCarvable(state)) continue;
          // 深处的洞穴底部积岩浆，与 MC 一致
          target.blocks[i] = y <= 10 ? target.lavaState : target.airState;
        }
      }
    }
  }

  /**
   * 峡谷：一条又长又窄的竖直裂缝，宽度随高度变化，底部窄顶部宽。
   * 1.0 里大约每 50 个区块一条，是暴露矿脉和岩浆的主要方式之一。
   */
  private carveRavineFrom(ox: number, oz: number, target: CarveTarget): void {
    if (hashUnit(ox, oz, SALT_RAVINE) > RAVINE_CHANCE) return;
    const rng = this.chunkRandom(ox, oz, SALT_RAVINE);

    const startX = ox * CHUNK_SIZE + rng.nextInt(CHUNK_SIZE);
    const startZ = oz * CHUNK_SIZE + rng.nextInt(CHUNK_SIZE);
    const topY = 20 + rng.nextInt(48);
    const depth = 18 + rng.nextInt(28);
    const length = 60 + rng.nextInt(60);
    let yaw = rng.nextFloat() * Math.PI * 2;
    const phase = rng.nextFloat() * 1000;

    let x = startX;
    let z = startZ;
    const baseX = target.cx * CHUNK_SIZE;
    const baseZ = target.cz * CHUNK_SIZE;
    const minX = target.cx * CHUNK_SIZE - 12;
    const maxX = minX + CHUNK_SIZE + 24;
    const minZ = target.cz * CHUNK_SIZE - 12;
    const maxZ = minZ + CHUNK_SIZE + 24;

    for (let step = 0; step < length; step++) {
      yaw += this.dirNoise.noise2(phase + step * 0.05, 500) * 0.18;
      x += Math.cos(yaw);
      z += Math.sin(yaw);
      if (x < minX || x > maxX || z < minZ || z > maxZ) continue;

      // 沿长度方向两端收窄，中段最宽
      const along = step / length;
      const taper = Math.sin(along * Math.PI);
      const halfWidth = (1.2 + this.dirNoise.noise2(step * 0.1, phase) * 1.4) * taper;
      if (halfWidth <= 0.4) continue;

      // 先按最大可能宽度做一次水平剔除，避免为整段 y（可能 46 层）逐层调用 carveSphere
      const maxW = halfWidth * 1.25;
      if (x + maxW < baseX || x - maxW > baseX + CHUNK_SIZE ||
          z + maxW < baseZ || z - maxW > baseZ + CHUNK_SIZE) continue;

      for (let y = topY - depth; y <= topY; y++) {
        // 越靠上越宽，形成 V 形剖面
        const vertical = (y - (topY - depth)) / depth;
        const w = halfWidth * (0.35 + vertical * 0.9);
        this.carveSphere(target, x, y, z, w);
      }
    }
    void SEA_LEVEL;
  }
}
