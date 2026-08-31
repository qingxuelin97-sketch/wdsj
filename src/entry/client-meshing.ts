/**
 * 网格化的派发端：谁该被重做、一帧派几个、结果回来怎么收。
 *
 * 从 client-main.ts 里分出来的（那个文件第五次顶到 600 行硬上限）。
 * 真正的网格化算法在 client/mesh/mesher.ts，跑在 worker 里；
 * 这里只管**调度**，是那条流水线在主线程这一侧的全部。
 *
 * 两条纪律写在这里，因为它们只有在调度这一层才成立：
 *
 * 1. **回来的结果要验 rev**（规约第 11 条）。玩家快速挖放时同一段会连续
 *    产生任务，worker 回来的顺序不保证 —— 旧结果必须丢弃，否则会把过期的
 *    网格盖到新状态上。症状是"挖掉的方块又出现了"，而且只在手快时出现。
 *
 * 2. **在飞任务要有上限**。玩家一路跑起来时脏段会源源不断地产生，
 *    不封顶的话队列能堆到几千，而那些任务回来时对应的区块多半已经卸载了。
 */
import type { Camera } from '../client/camera.ts';
import type { ClientWorld, SectionCoord } from '../client/world/client-world.ts';
import type { ChunkRenderer } from '../client/render/chunk-renderer.ts';
import { MeshWorkerPool, recommendedMeshWorkers } from '../client/mesh/mesh-worker-pool.ts';
import type { MesherTables, MeshResult } from '../client/mesh/mesher.ts';
import { extractPaddedNeighborhood } from '../core/world/chunk-codec.ts';

/**
 * 每帧最多**派发**几个网格化任务。
 * 派发本身很便宜（一次 5832 项的复制 + postMessage），真正的计算在 worker 里，
 * 所以这个数可以比同步版本大得多。
 */
const MESH_DISPATCH_PER_FRAME = 6;
/** 在飞任务的上限，避免玩家快速移动时把队列堆到几千 */
const MAX_IN_FLIGHT = 48;

export interface MeshingDeps {
  readonly world: ClientWorld;
  readonly camera: Camera;
  readonly renderer: ChunkRenderer;
  readonly tables: MesherTables;
  readonly workerScriptUrl: string;
  /** 覆盖 worker 数量，来自 URL 的 ?meshWorkers= */
  readonly workerCount?: number | undefined;
  log(msg: string): void;
}

export class ClientMeshing {
  readonly pool: MeshWorkerPool;
  /** 至今完成了多少段。F3 与冒烟检查读它 */
  meshedTotal = 0;

  private readonly d: MeshingDeps;
  private readonly dirtyBatch: SectionCoord[] = [];

  constructor(d: MeshingDeps) {
    this.d = d;
    this.pool = new MeshWorkerPool(d.tables, {
      scriptUrl: d.workerScriptUrl,
      workers: d.workerCount ?? recommendedMeshWorkers(),
    });
    d.log(`[mesh] ${this.pool.workerCount} 个网格 worker`);

    this.pool.setResultHandler((result) => {
      // 区块已经不在了（卸载、或者换维度整份镜像被清空）就直接丢。
      //
      // 不丢的话，换维度之后上一批在飞的网格会**照样上传** ——
      // 表现是新维度里浮着几片旧维度的地形。revs 已经被清空，
      // 所以那道"rev 过期"的闸门在这种情况下拦不住它们
      if (!d.world.store.hasChunk(result.cx, result.cz)) {
        this.pool.noteDiscarded();
        return;
      }
      const currentRev = d.world.revOf(result.cx, result.cy, result.cz);
      if (result.rev < currentRev) {
        this.pool.noteDiscarded();
        return;
      }
      // 排队，不当场传。
      //
      // 正常游玩时结果是零零散散到的，当场传没问题；但**换维度**那一下
      // 几百个子区块会在几帧里全部回来，每个都要建 VAO/VBO/EBO 并上传 ——
      // 软件渲染下那一串足以把主线程占住几十秒，连网络回调都跑不上，
      // 表现是"指令超时"，而实际上服务端早就回过话了。
      this.uploadQueue.push(result);
    });
  }

  /** 等着上传的网格结果。见 setResultHandler 里的理由 */
  private readonly uploadQueue: MeshResult[] = [];

  /**
   * 每帧最多上传几个子区块。
   *
   * 12 是按"一帧的预算"取的：一次上传三个缓冲区，软件渲染下约 1-2 ms，
   * 12 个就是十几毫秒 —— 掉一点帧但不会卡住。给大了换维度会卡，
   * 给小了正常游玩时地形跟不上脚步。
   */
  private static readonly UPLOADS_PER_FRAME = 12;

  /** 把排队的网格传上去。每帧调一次 */
  flushUploads(): void {
    const n = Math.min(this.uploadQueue.length, ClientMeshing.UPLOADS_PER_FRAME);
    for (let i = 0; i < n; i++) {
      const result = this.uploadQueue[i]!;
      if (!this.d.world.store.hasChunk(result.cx, result.cz)) continue;
      if (result.layers.length > 0) this.d.renderer.upload(result);
      else this.d.renderer.remove(result.cx, result.cy, result.cz);
      this.meshedTotal++;
    }
    this.uploadQueue.splice(0, n);
  }

  /** 还有多少网格等着上传。waitForIdle 要看它 */
  get pendingUploads(): number {
    return this.uploadQueue.length;
  }

  /** 把队列清空。换维度时用 —— 里面全是上一个维度的东西 */
  clearUploads(): void {
    this.uploadQueue.length = 0;
  }

  /** 把脏的子区块派发给 worker 池 */
  dispatch(): void {
    const { world, camera, renderer } = this.d;
    if (this.pool.pendingJobs >= MAX_IN_FLIGHT) return;
    const budget = Math.min(MESH_DISPATCH_PER_FRAME, MAX_IN_FLIGHT - this.pool.pendingJobs);
    const p = camera.position;
    world.takeDirty(budget, p[0]!, p[1]!, p[2]!, this.dirtyBatch);
    for (const { cx, cy, cz } of this.dirtyBatch) {
      if (!world.hasContent(cx, cy, cz)) {
        renderer.remove(cx, cy, cz);
        continue;
      }
      const buffers = this.pool.acquireBuffers();
      extractPaddedNeighborhood(
        (x, y, z) => world.store.getState(x, y, z),
        (x, y, z) => (world.store.getSkyLight(x, y, z) << 4) | world.store.getBlockLight(x, y, z),
        (x, z) => world.store.getBiome(x, z),
        cx, cy, cz,
        buffers.blocks, buffers.light, buffers.biomes,
      );
      // 缓冲的所有权转移给 worker，之后不能再碰
      this.pool.submit(cx, cy, cz, world.revOf(cx, cy, cz), buffers);
    }
  }
}
