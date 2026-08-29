/**
 * 天光传播。
 *
 * 两步：
 *   1. 垂直柱 —— 从世界顶往下，遇到不透光方块归零，遇到半透明按 opacity 衰减
 *   2. 水平泛洪 —— BFS 让光绕过悬崖、渗进洞口与树冠
 *
 * 第 2 步是"洞口附近有渐变的光"和"洞口是一条纯黑的边"的分界线。
 * 只做第 1 步的话，任何被上方遮住的格子都是绝对的 0，画面上是刺眼的硬边。
 *
 * M4 会在此基础上补方块光（火把）与增量更新（放/挖一格后只重算局部）。
 * 现在这一版是全量重算，只在区块批量加载后跑一次。
 */
import type { ChunkStore } from '../../core/world/block-view.ts';
import { stateId, type Chunk } from '../../core/world/chunk.ts';
import { CHUNK_SIZE, WORLD_HEIGHT, MAX_LIGHT } from '../../core/constants.ts';

/**
 * 位置打包。
 * 不能用位移：z << 26 会溢出 32 位并悄悄破坏坐标。用乘法保证精度。
 * （这是前作留下的一条注释，值得照抄 —— 它救过一次很难查的 bug。）
 */
function packPos(x: number, y: number, z: number): number {
  return x + 4096 + (y + 1024) * 8192 + (z + 4096) * 8192 * 2048;
}
function unpackX(p: number): number {
  return (p % 8192) - 4096;
}
function unpackY(p: number): number {
  return (Math.floor(p / 8192) % 2048) - 1024;
}
function unpackZ(p: number): number {
  return Math.floor(p / (8192 * 2048)) - 4096;
}

const NEIGHBORS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

/**
 * 重算天光。
 *
 * @param opacity 按方块 id 索引的遮光度表
 * @param only    只处理这些区块（不传则全量）。
 *
 * **必须传 only。** 全量重算的代价是"已加载区块数 × 32768 格"，渲染距离 6 时
 * 每次就是 370 万格；若每帧有新区块到达就跑一次，主线程会被直接卡死
 * （实测浏览器 45 秒无响应）。传入新加载的区块即可 —— 新区块只会让周围**变亮**，
 * 而泛洪本身就能把光扩散进邻居。
 *
 * 让光**变暗**的情况（放置一个不透明方块）需要"移除传播"，那是 M4 的内容，
 * 见 docs/DEVIATIONS.md。
 */
export function computeSkyLight(store: ChunkStore, opacity: Uint8Array, only?: Iterable<Chunk>): void {
  // 用数组 + 游标当队列。绝不能用 shift()，那是 O(n)，
  // 泛洪队列动辄几十万项时会直接卡死。
  const queue: number[] = [];

  // --- 第 1 步：垂直柱 ---
  const targets = only ?? store.chunkValues();
  for (const chunk of targets) {
    const baseX = chunk.cx * CHUNK_SIZE;
    const baseZ = chunk.cz * CHUNK_SIZE;
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const wx = baseX + x;
        const wz = baseZ + z;
        // 四个水平邻居里最高的地表。只有 y 低于它，光才可能需要横向渗过去；
        // 高于它的格子四周全是开阔天空，早就是满值了。
        const maxNeighborHeight = Math.max(
          store.getHeight(wx + 1, wz), store.getHeight(wx - 1, wz),
          store.getHeight(wx, wz + 1), store.getHeight(wx, wz - 1),
        );

        let level = MAX_LIGHT;
        for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
          const id = stateId(chunk.getState(x, y, z));
          if (id !== 0) {
            const op = opacity[id] ?? MAX_LIGHT;
            level = Math.max(0, level - Math.max(1, op));
          }
          if (level === 0) break;
          const section = chunk.sections[y >> 4];
          if (section != null) section.setSkyLight(x, y & 15, z, level);

          // 入队条件很关键。
          //
          // 把每个有光的格子都当种子，一个区块就是三万多个，十几个区块就是几十万，
          // BFS 光是出队检查邻居就足以把服务端拖到 1 TPS（实测）。
          //
          // 实际上开阔地带的格子四周也都是满值，往外传播不会改变任何东西。
          // 只有当某个水平邻居的地表比自己高时（即那一侧是暗的），
          // 这个格子才真正需要作为传播源。
          if (level > 1 && y < maxNeighborHeight) queue.push(packPos(wx, y, wz));
        }
      }
    }
  }

  // --- 第 2 步：水平泛洪 ---
  let head = 0;
  while (head < queue.length) {
    const pos = queue[head++]!;
    const x = unpackX(pos);
    const y = unpackY(pos);
    const z = unpackZ(pos);
    const level = store.getSkyLight(x, y, z);
    if (level <= 1) continue;

    for (const [dx, dy, dz] of NEIGHBORS) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (ny < 0 || ny >= WORLD_HEIGHT) continue;
      if (!store.isLoaded(nx, nz)) continue;

      const nid = stateId(store.getState(nx, ny, nz));
      const op = nid === 0 ? 0 : (opacity[nid] ?? MAX_LIGHT);
      // 不透光方块内部没有光可言
      if (op >= MAX_LIGHT) continue;

      const next = level - Math.max(1, op);
      if (next <= store.getSkyLight(nx, ny, nz)) continue;
      store.setSkyLight(nx, ny, nz, next);
      if (next > 1) queue.push(packPos(nx, ny, nz));
    }

    // 队列已消费的部分定期清掉，避免大世界时数组无限增长占内存
    if (head > 1 << 16) {
      queue.splice(0, head);
      head = 0;
    }
  }
}
