/**
 * 网格化 worker 池。
 *
 * mesh worker 是**完全无状态**的：它收到一份自包含的 18³ 邻域快照，算完就还回来，
 * 自己不持有任何世界数据。这是整个 worker 拓扑里最大的一处简化 —— 代价只是主线程
 * 每个任务多做一次 5832 次的复制循环（约 20 微秒）。
 *
 * 三个必须做对的地方：
 *   1. **缓冲区回收**：任务的输入缓冲随结果一起还回来，进空闲池复用。
 *      不这么做的话，每个任务分配约 18 KB，滚动加载时每秒几十次，GC 压力会体现在帧时间上。
 *   2. **rev 校验**：玩家快速挖放时同一个子区块会连续产生任务，回来的顺序不保证。
 *      rev 比当前小的结果直接丢弃（docs/RULES.md 第 11 条）。
 *   3. **Transferable**：输入与输出的 ArrayBuffer 都走转移而非结构化克隆复制。
 */
import type { ModelTables } from '../../core/registry/model-tables.ts';
import { PADDED_VOLUME, PADDED_AREA, type MeshResult, type MesherTables } from './mesher.ts';
import { MAX_WORKERS_TOTAL } from '../../core/constants.ts';

/** 发给 worker 的任务 */
export interface WorkerJobMessage {
  readonly kind: 'job';
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly rev: number;
  blocks: ArrayBuffer;
  light: ArrayBuffer;
  biomes: ArrayBuffer;
}

/** worker 初始化时下发的方块表。只传一次 */
export interface WorkerInitMessage {
  readonly kind: 'init';
  readonly tables: {
    modelKind: ArrayBuffer;
    renderLayer: ArrayBuffer;
    tint: ArrayBuffer;
    tintFaces: ArrayBuffer;
    fullCube: ArrayBuffer;
    cullSameType: ArrayBuffer;
    opaque: ArrayBuffer;
    faceLayer: ArrayBuffer;
  };
  /**
   * 模型表。直接传对象而不是逐字段拆成 ArrayBuffer ——
   * typed array 本身就能被结构化克隆，拆开只是多写几十行还容易漏字段。
   * 一个 worker 只收一次，约 200 KB。
   */
  readonly models: ModelTables;
}

/** worker 回传的结果 */
export interface WorkerResultMessage {
  readonly kind: 'result';
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly rev: number;
  readonly layers: { layer: number; vertices: ArrayBuffer; indices: ArrayBuffer; quadCount: number }[];
  /** 输入缓冲原样还回来，进空闲池复用 */
  readonly recycled: { blocks: ArrayBuffer; light: ArrayBuffer; biomes: ArrayBuffer };
}

/** 一组可复用的任务缓冲 */
interface JobBuffers {
  blocks: Uint16Array;
  light: Uint8Array;
  biomes: Uint8Array;
}

export interface MeshPoolOptions {
  /** worker 数量。默认按 CPU 核数推算并卡上限 */
  workers?: number;
  /** worker 脚本 URL */
  scriptUrl: string;
}

/**
 * 按核数决定网格 worker 数量。
 *
 * 上限 4，且总 worker 数不超过 6 —— 本机空闲内存只有约 4.4 GB，
 * 每个 worker 的 V8 堆基线加上任务缓冲要几十 MB，开太多会先撞内存墙而不是变快。
 */
export function recommendedMeshWorkers(): number {
  const cores = (globalThis.navigator?.hardwareConcurrency ?? 8) as number;
  return Math.min(4, Math.max(1, (cores - 4) >> 2));
}

export class MeshWorkerPool {
  private readonly workers: Worker[] = [];
  /** 每个 worker 当前有多少任务在飞，用于挑最闲的那个 */
  private readonly inFlight: number[] = [];
  /** 空闲缓冲池 */
  private readonly freeBuffers: JobBuffers[] = [];
  private onResult: ((result: MeshResult) => void) | null = null;
  private disposed = false;

  /** 统计 */
  jobsDispatched = 0;
  jobsCompleted = 0;
  jobsDiscarded = 0;
  buffersAllocated = 0;

  constructor(tables: MesherTables, opts: MeshPoolOptions) {
    const count = Math.min(opts.workers ?? recommendedMeshWorkers(), MAX_WORKERS_TOTAL - 2);
    for (let i = 0; i < Math.max(1, count); i++) {
      const worker = new Worker(opts.scriptUrl, { type: 'module', name: `mesh-${i}` });
      worker.onmessage = (ev: MessageEvent): void => this.handleResult(i, ev.data as WorkerResultMessage);
      worker.onerror = (ev: ErrorEvent): void => {
        console.error(`[mesh-worker ${i}] ${ev.message}`);
      };
      // 方块表每个 worker 一份副本。它是只读的，冻结后不再变化，
      // 所以复制一次比每个任务都带上便宜得多。
      const init: WorkerInitMessage = {
        kind: 'init',
        tables: {
          modelKind: copyBuffer(tables.modelKind),
          renderLayer: copyBuffer(tables.renderLayer),
          tint: copyBuffer(tables.tint),
          tintFaces: copyBuffer(tables.tintFaces),
          fullCube: copyBuffer(tables.fullCube),
          cullSameType: copyBuffer(tables.cullSameType),
          opaque: copyBuffer(tables.opaque),
          faceLayer: copyBuffer(tables.faceLayer),
        },
        models: tables.models,
      };
      worker.postMessage(init);
      this.workers.push(worker);
      this.inFlight.push(0);
    }
  }

  get workerCount(): number {
    return this.workers.length;
  }

  /** 当前在飞的任务总数 */
  get pendingJobs(): number {
    let n = 0;
    for (const c of this.inFlight) n += c;
    return n;
  }

  setResultHandler(cb: (result: MeshResult) => void): void {
    this.onResult = cb;
  }

  /** 借一组缓冲填任务数据。用完由 submit 转移走，结果回来时自动归还 */
  acquireBuffers(): JobBuffers {
    const reused = this.freeBuffers.pop();
    if (reused !== undefined) return reused;
    this.buffersAllocated++;
    return {
      blocks: new Uint16Array(PADDED_VOLUME),
      light: new Uint8Array(PADDED_VOLUME),
      biomes: new Uint8Array(PADDED_AREA),
    };
  }

  /**
   * 提交任务。缓冲的所有权转移给 worker，调用后不得再访问它们。
   */
  submit(cx: number, cy: number, cz: number, rev: number, buffers: JobBuffers): void {
    if (this.disposed) return;
    // 挑在飞任务最少的 worker，简单但在这种同质任务上效果很好
    let target = 0;
    for (let i = 1; i < this.inFlight.length; i++) {
      if (this.inFlight[i]! < this.inFlight[target]!) target = i;
    }

    const msg: WorkerJobMessage = {
      kind: 'job', cx, cy, cz, rev,
      blocks: buffers.blocks.buffer as ArrayBuffer,
      light: buffers.light.buffer as ArrayBuffer,
      biomes: buffers.biomes.buffer as ArrayBuffer,
    };
    this.workers[target]!.postMessage(msg, [msg.blocks, msg.light, msg.biomes]);
    this.inFlight[target]!++;
    this.jobsDispatched++;
  }

  private handleResult(workerIndex: number, msg: WorkerResultMessage): void {
    this.inFlight[workerIndex]!--;
    this.jobsCompleted++;

    // 输入缓冲回池
    this.freeBuffers.push({
      blocks: new Uint16Array(msg.recycled.blocks),
      light: new Uint8Array(msg.recycled.light),
      biomes: new Uint8Array(msg.recycled.biomes),
    });

    if (this.onResult === null) return;
    this.onResult({
      cx: msg.cx, cy: msg.cy, cz: msg.cz, rev: msg.rev,
      layers: msg.layers.map((l) => ({
        layer: l.layer as 0 | 1 | 2,
        vertices: new Uint32Array(l.vertices),
        indices: new Uint32Array(l.indices),
        quadCount: l.quadCount,
      })),
      visibilityMask: 0,
    });
  }

  /** 记一次因 rev 过期而被丢弃的结果，仅用于统计 */
  noteDiscarded(): void {
    this.jobsDiscarded++;
  }

  dispose(): void {
    this.disposed = true;
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
    this.inFlight.length = 0;
    this.freeBuffers.length = 0;
  }
}

/** 复制一份 typed array 的底层缓冲，供 postMessage 使用 */
function copyBuffer(arr: Uint8Array | Uint16Array): ArrayBuffer {
  return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;
}
