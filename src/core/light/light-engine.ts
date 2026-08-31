/**
 * 光照引擎：天光与方块光的传播、移除与增量更新。
 *
 * 两条通道，同一套 BFS，衰减规则完全一样：从某格向邻格传播时减去
 * `max(1, 邻格遮光度)`。区别只在光源怎么来：
 *   - **方块光**：发光方块自己是源（火把 14、萤石 15、岩浆 15…）
 *   - **天光**：`y >= 该列 heightmap` 的格子直接是满值，其余靠传播
 *
 * heightmap 指的是**最高挡光方块**的 y+1（遮光度 > 0 才算，玻璃不算）。
 * 这就是 MC 的 `canBlockSeeTheSky`：站在十格深的竖井底部仍是满天光，
 * 不是因为天光"垂直不衰减"，而是因为那些格子本来就直接见天。
 *
 * 我一开始把它写成了"天光垂直向下穿过透明方块不衰减"的特例，那是**错的**：
 * 既不符合 MC（树冠下的地面在 MC 里确实随深度变暗，所以大树底下会刷怪），
 * 又会让一整列 15 彼此相等，于是双队列移除时"更暗的邻居才是下游"这个判据失效。
 * 症状极隐蔽 —— 随机操作跑到第 37 次才出现 47 处偏差，且只在特定地形下显形。
 * 换成 heightmap 划分之后 BFS 内部重新严格单调，双队列的前提才真正成立。
 *
 * 增加与移除是两个独立的过程，且**移除必须先于增加**：
 * 拿走一个光源时，先把它照亮的整片区域清零（同时记下边界上更亮的格子），
 * 再从那些边界重新扩散回来。只做"增加"的话，光源没了但光还留在原地。
 *
 * 这套 increase/decrease 双队列是光照引擎唯一正确的做法，也是最容易写错的地方 ——
 * 所以 tests/core/light.test.ts 用"与全量重算逐格比对"来锁死它。
 */
import type { MutableBlockView } from '../world/block-view.ts';
import { stateId } from '../world/chunk.ts';
import { MAX_LIGHT, WORLD_HEIGHT } from '../constants.ts';

/** 光照通道 */
export const LightChannel = {
  BLOCK: 0,
  SKY: 1,
} as const;
export type LightChannel = (typeof LightChannel)[keyof typeof LightChannel];

/**
 * 位置打包成一个 number。
 *
 * 不能用位移：`z << 26` 会溢出 32 位并悄悄破坏坐标。用乘法保证精度，
 * 三个分量各留 13 位（±4096 格）足够单次光照更新的范围。
 */
const OFF = 4096;
const SPAN = 8192;
export function packLightPos(x: number, y: number, z: number): number {
  return x + OFF + (y + 1024) * SPAN + (z + OFF) * SPAN * 2048;
}
export function unpackLightX(p: number): number {
  return (p % SPAN) - OFF;
}
export function unpackLightY(p: number): number {
  return (Math.floor(p / SPAN) % 2048) - 1024;
}
export function unpackLightZ(p: number): number {
  return Math.floor(p / (SPAN * 2048)) - OFF;
}

const NEIGHBORS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

/** 光照引擎需要的方块属性 */
export interface LightTables {
  /** 遮光度：不透明 15，玻璃 0，水 3，树叶 1 */
  readonly opacity: Uint8Array;
  /** 自身发光强度 */
  readonly lightEmission: Uint8Array;
}

/** 队列项：位置 + 该位置移除前的亮度（仅移除队列用） */
interface RemovalEntry {
  pos: number;
  level: number;
}

export class LightEngine {
  private readonly world: MutableBlockView;
  private readonly tables: LightTables;

  /** 增加传播队列。用数组 + 游标，绝不用 shift()（那是 O(n)） */
  private readonly addQueue: number[] = [];
  private readonly removeQueue: RemovalEntry[] = [];
  /** 本次更新触碰到的位置，供调用方决定要重网格化哪些子区块 */
  private readonly touched = new Set<number>();
  /** seedSky 用的列高缓存，按需增长后复用，避免每个区块都新分配一次 */
  private heightCache = new Int16Array(0);
  /**
   * 是否记录 touched。
   * 服务端不需要（它按区块快照发光照），关掉能省下每格一次 Set.add ——
   * 而且忘了 drain 的话这个 Set 会无限长大。
   */
  private readonly trackTouched: boolean;

  constructor(world: MutableBlockView, tables: LightTables, trackTouched = true) {
    this.world = world;
    this.tables = tables;
    this.trackTouched = trackTouched;
  }

  private get(channel: LightChannel, x: number, y: number, z: number): number {
    return channel === LightChannel.SKY
      ? this.world.getSkyLight(x, y, z)
      : this.world.getBlockLight(x, y, z);
  }

  private set(channel: LightChannel, x: number, y: number, z: number, level: number): void {
    if (channel === LightChannel.SKY) this.world.setSkyLight(x, y, z, level);
    else this.world.setBlockLight(x, y, z, level);
    if (this.trackTouched) this.touched.add(packLightPos(x, y, z));
  }

  private opacityAt(x: number, y: number, z: number): number {
    const id = stateId(this.world.getState(x, y, z));
    if (id === 0) return 0;
    return this.tables.opacity[id] ?? MAX_LIGHT;
  }

  /** 取出并清空本次更新触碰到的位置 */
  drainTouched(): number[] {
    const out = [...this.touched];
    this.touched.clear();
    return out;
  }

  /**
   * 累计处理过多少个队列条目。
   *
   * 性能测试断言的是**它**，不是挂钟时间：挂钟会被同时跑的别的测试
   * 拖慢（实测同一段代码独占时 0.38 ms、和 2 万刻的生存压力测试
   * 抢 CPU 时 4.7 ms，差十二倍），而这个计数只取决于算法做了多少活。
   * 算法退化它一定涨，机器忙它一动不动。
   */
  workUnits = 0;

  get touchedCount(): number {
    return this.touched.size;
  }

  /**
   * 播一个光源，让它向外扩散。
   *
   * 即使该格**已经**是这个亮度也要入队 —— 它照样得往外传。
   * 天光尤其如此：地表之上的格子按隐含规则本来就是满值，
   * 若因"值没变"而跳过入队，悬崖背面、屋檐下这些要靠横向渗透的地方
   * 就一格光都收不到。
   */
  addSource(channel: LightChannel, x: number, y: number, z: number, level: number): void {
    if (level <= 0) return;
    if (level > this.get(channel, x, y, z)) this.set(channel, x, y, z, level);
    else if (level < this.get(channel, x, y, z)) return;
    this.addQueue.push(packLightPos(x, y, z));
  }

  /** 把某个位置的光标记为需要移除 */
  removeSource(channel: LightChannel, x: number, y: number, z: number): void {
    const level = this.get(channel, x, y, z);
    if (level === 0) return;
    this.set(channel, x, y, z, 0);
    this.removeQueue.push({ pos: packLightPos(x, y, z), level });
  }

  /**
   * 跑完队列。
   *
   * 顺序不能颠倒：先移除、再增加。移除过程会把"比自己亮"的邻居收集成新的增加源，
   * 于是被清空的区域会从周围重新被照亮 —— 这正是拿走一支火把后周围恢复正常的原理。
   */
  propagate(channel: LightChannel): void {
    this.processRemovals(channel);
    this.processAdditions(channel);
  }

  private processRemovals(channel: LightChannel): void {
    let head = 0;
    while (head < this.removeQueue.length) {
      const entry = this.removeQueue[head++]!;
      this.workUnits++;
      const x = unpackLightX(entry.pos);
      const y = unpackLightY(entry.pos);
      const z = unpackLightZ(entry.pos);

      for (const [dx, dy, dz] of NEIGHBORS) {
        const nx = x + dx;
        const ny = y + dy;
        const nz = z + dz;
        if (ny < 0 || ny >= WORLD_HEIGHT) continue;
        if (!this.world.isLoaded(nx, nz)) continue;

        const neighborLevel = this.get(channel, nx, ny, nz);
        if (neighborLevel === 0) continue;

        if (neighborLevel < entry.level) {
          // 这份光是从被移除的格子传过来的 -> 一并清掉，继续往外扩
          this.set(channel, nx, ny, nz, 0);
          this.removeQueue.push({ pos: packLightPos(nx, ny, nz), level: neighborLevel });
        } else {
          // 这份光另有来源且更亮 -> 它会成为重新照亮这片区域的种子
          this.addQueue.push(packLightPos(nx, ny, nz));
        }
      }
    }
    this.removeQueue.length = 0;
  }

  private processAdditions(channel: LightChannel): void {
    let head = 0;
    while (head < this.addQueue.length) {
      const pos = this.addQueue[head++]!;
      this.workUnits++;
      const x = unpackLightX(pos);
      const y = unpackLightY(pos);
      const z = unpackLightZ(pos);
      const level = this.get(channel, x, y, z);
      if (level <= 1) continue;

      for (const [dx, dy, dz] of NEIGHBORS) {
        const nx = x + dx;
        const ny = y + dy;
        const nz = z + dz;
        if (ny < 0 || ny >= WORLD_HEIGHT) continue;
        if (!this.world.isLoaded(nx, nz)) continue;

        const op = this.opacityAt(nx, ny, nz);
        if (op >= MAX_LIGHT) continue; // 不透光方块内部不存在光

        const next = level - Math.max(1, op);
        if (next <= 0) continue;
        if (next <= this.get(channel, nx, ny, nz)) continue;

        this.set(channel, nx, ny, nz, next);
        this.addQueue.push(packLightPos(nx, ny, nz));
      }
    }
    this.addQueue.length = 0;
  }

  /**
   * 方块变更后更新两条光照通道。
   *
   * @param oldEmission 变更前该位置的发光强度
   * @param newEmission 变更后的发光强度
   * @param oldOpacity  变更前该位置的遮光度。新的遮光度直接从世界读。
   */
  onBlockChanged(
    x: number, y: number, z: number,
    oldEmission: number, newEmission: number,
    oldOpacity: number,
  ): void {
    // --- 方块光 ---
    if (oldEmission > 0) this.removeSource(LightChannel.BLOCK, x, y, z);
    else {
      // 不是光源，但方块变了（比如放了块石头挡住光），把该位置的光清掉再让周围补回来
      this.removeSource(LightChannel.BLOCK, x, y, z);
    }
    if (newEmission > 0) this.addSource(LightChannel.BLOCK, x, y, z, newEmission);
    // 让四周的光重新渗进来
    this.seedFromNeighbors(LightChannel.BLOCK, x, y, z);
    this.propagate(LightChannel.BLOCK);

    // --- 天光 ---
    // 遮光度没变就什么都不用做：空气换火把、石头换泥土都属于这一类，
    // 它们不影响天光的任何一格。
    if (this.opacityAt(x, y, z) !== oldOpacity) {
      this.updateSkyForChange(x, y, z, oldOpacity);
    }
  }

  /** 把某点的六个邻居加入增加队列，让它们把光渗回来 */
  private seedFromNeighbors(channel: LightChannel, x: number, y: number, z: number): void {
    for (const [dx, dy, dz] of NEIGHBORS) {
      const ny = y + dy;
      if (ny < 0 || ny >= WORLD_HEIGHT) continue;
      if (!this.world.isLoaded(x + dx, z + dz)) continue;
      if (this.get(channel, x + dx, ny, z + dz) > 1) {
        this.addQueue.push(packLightPos(x + dx, ny, z + dz));
      }
    }
  }

  /**
   * 该列的天光 heightmap：最高**挡光**方块的 y+1。y >= 它的格子直接见天。
   *
   * 注意和 `Chunk.getHeight`（最高非空气方块）不是一回事 ——
   * 玻璃、火把这类遮光度为 0 的方块不该挡住天光，否则玻璃屋顶下面会变黑。
   *
   * @param overrideY  把这一格的遮光度替换成 overrideOpacity 再算（传 -1 表示不替换）。
   *                   用来在方块已经写进世界之后，反推"变更前"的高度。
   */
  private skyHeightAt(x: number, z: number, overrideY = -1, overrideOpacity = 0): number {
    const top = Math.max(this.world.getHeight(x, z) - 1, overrideY);
    for (let y = Math.min(top, WORLD_HEIGHT - 1); y >= 0; y--) {
      const op = y === overrideY ? overrideOpacity : this.opacityAt(x, y, z);
      if (op > 0) return y + 1;
    }
    return 0;
  }

  /**
   * 方块变更后更新天光。
   *
   * 只有两种情况需要动：
   *   - heightmap 升高（挡光的方块放到了列顶之上）：[oldH, newH) 从"直接见天"
   *     变成"被遮"，逐格移除，移除传播会把下方连带清掉再从四周补回来
   *   - heightmap 降低（挖掉了列顶的挡光方块）：[newH, oldH) 变成直接见天，给满值
   * 除此之外（在地表以下改方块）heightmap 不变，只需处理变更点自身。
   */
  private updateSkyForChange(x: number, y: number, z: number, oldOpacity: number): void {
    const oldH = this.skyHeightAt(x, z, y, oldOpacity);
    const newH = this.skyHeightAt(x, z);

    if (newH > oldH) {
      for (let cy = oldH; cy < newH; cy++) this.removeSource(LightChannel.SKY, x, cy, z);
    } else if (newH < oldH) {
      // 这一段现在全部直接见天，按定义遮光度都是 0
      for (let cy = newH; cy < oldH; cy++) this.addSource(LightChannel.SKY, x, cy, z, MAX_LIGHT);
    }

    // 变更点自身在 heightmap 以下时，它的遮光度变了，原有的光要清掉再让四周渗回来
    if (y < newH) this.removeSource(LightChannel.SKY, x, y, z);
    this.seedFromNeighbors(LightChannel.SKY, x, y, z);
    this.propagate(LightChannel.SKY);
  }

  /**
   * 播种一片区域里所有发光方块的方块光。区块刚加载完时调用一次。
   * 坐标是闭区间的世界坐标。
   */
  seedBlockLight(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    defer = false,
  ): void {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (!this.world.isLoaded(x, z)) continue;
        for (let y = y0; y <= y1; y++) {
          const id = stateId(this.world.getState(x, y, z));
          if (id === 0) continue;
          const emission = this.tables.lightEmission[id] ?? 0;
          if (emission > 0) this.addSource(LightChannel.BLOCK, x, y, z, emission);
        }
      }
    }
    if (!defer) this.propagate(LightChannel.BLOCK);
  }

  /**
   * 从 heightmap 播种整片区域的天光。区块刚加载完时调用一次。
   * 坐标是闭区间的世界坐标。
   */
  seedSky(x0: number, z0: number, x1: number, z1: number, topY = WORLD_HEIGHT, defer = false): void {
    this.markLightReady(x0, z0, x1, z1);

    // 先把区域**外扩一圈**的列高算好缓存起来。
    // 下面每一列都要看四个邻居的列高，不缓存的话同一列会被重复算四遍
    // （一个区块一千多次 skyHeightAt，每次都是一趟区块查找加一段向下扫描）。
    const w = x1 - x0 + 3;
    const d = z1 - z0 + 3;
    if (this.heightCache.length < w * d) this.heightCache = new Int16Array(w * d);
    const hs = this.heightCache;
    const at = (x: number, z: number): number => hs[(z - z0 + 1) * w + (x - x0 + 1)]!;
    for (let z = z0 - 1; z <= z1 + 1; z++) {
      for (let x = x0 - 1; x <= x1 + 1; x++) {
        hs[(z - z0 + 1) * w + (x - x0 + 1)] = this.world.isLoaded(x, z) ? this.skyHeightAt(x, z) : 0;
      }
    }

    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (!this.world.isLoaded(x, z)) continue;
        const h = at(x, z);

        // 只有"某个水平邻居的地表比自己高"的格子才值得当传播源。
        //
        // 这不是可有可无的优化。开阔地带四周本来就都是满值，把它们全部入队
        // 只会让 BFS 空转 —— 每出一个格子还要检查六个邻居。一个区块地表以上
        // 有一万五千格，九个区块就是十几万，M3 那次正是这样把服务端拖到 1 TPS 的。
        const limit = Math.max(at(x + 1, z), at(x - 1, z), at(x, z + 1), at(x, z - 1));

        // topY 之上没有任何已分配的子区块，读出来就是隐含的满天光，
        // 不必真的写一遍（见 Chunk.implicitSkyLight）
        for (let y = h; y < topY; y++) {
          this.set(LightChannel.SKY, x, y, z, MAX_LIGHT);
          if (y < limit) this.addQueue.push(packLightPos(x, y, z));
        }
      }
    }

    // 区域外一圈也要当种子。
    //
    // 新区块的暗处（悬垂下、峭壁背面）要靠**已经加载好的邻居**把光横向送进来。
    // 只播自己的话，邻居若是上一个 tick 就算完了的，它那份光永远不会再动一次，
    // 新区块紧贴边界的阴影里就会留下一条突兀的黑边。
    for (let z = z0 - 1; z <= z1 + 1; z++) {
      for (let x = x0 - 1; x <= x1 + 1; x++) {
        if (x > x0 - 1 && x < x1 + 1 && z > z0 - 1 && z < z1 + 1) continue;
        if (!this.world.isLoaded(x, z)) continue;
        // 与之相邻的内圈那一列；只播两者列高较大者以下的部分，
        // 再往上两边都是满值，传过去不改变任何东西
        const nx = Math.min(x1, Math.max(x0, x));
        const nz = Math.min(z1, Math.max(z0, z));
        const limit = Math.max(at(x, z), at(nx, nz));
        for (let y = 0; y < limit; y++) {
          if (this.world.getSkyLight(x, y, z) > 1) this.addQueue.push(packLightPos(x, y, z));
        }
      }
    }

    // defer: 调用方要一次播多个区块再统一扩散。
    // 逐块扩散的话，相邻的新区块会一轮轮地互相灌光，同样的格子要走好几遍。
    if (!defer) this.propagate(LightChannel.SKY);
  }

  /** 标记这片区域的光照已经建立，此后新分配的子区块按隐含值预置天光 */
  /**
   * 只标"这片区域的光照已建立"，不播任何种。
   *
   * 没有天光的维度（下界、末地）用它代替 seedSky —— 那里读到的
   * 隐含天光（地表以上 15、以下 0）本来就是对的，而真去跑一遍
   * 播种会在末地那种"薄板悬在虚空里"的地形上炸开（见 ServerWorld）。
   */
  markLightReady(x0: number, z0: number, x1: number, z1: number): void {
    for (let z = z0; z <= z1; z += 16) {
      for (let x = x0; x <= x1; x += 16) this.world.markLightReady(x, z);
    }
    this.world.markLightReady(x1, z1);
  }
}
