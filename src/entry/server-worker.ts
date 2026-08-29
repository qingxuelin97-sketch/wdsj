/**
 * 内置服务端的 Worker 宿主。
 *
 * ServerCore 本身不含任何 Worker / DOM / 定时器依赖，这个文件是它的**宿主**之一：
 * 负责建立 MessagePort 传输、驱动 tick 循环、把统计报回主线程。
 * 另外两个宿主是 node 专用服务器（M17）和测试里的手动 tick。
 *
 * 把服务端搬到这里的直接动因是性能：世界生成在主线程时，玩家一移动就要生成新区块
 * （22 ms/区块），实测帧率从静止的 60 掉到移动时的 19。搬进 Worker 后主线程只剩
 * 渲染与网格化派发。
 *
 * tick 由 clock-worker 敲进来（见那个文件顶部的说明）：worker 里的 setTimeout
 * 在后台标签页会被彻底掐死，实测前台 20.0 TPS、后台 0。
 * 没有 SharedArrayBuffer（未跨源隔离）时回落到 setTimeout，并明确记一条日志 ——
 * 静默降级会让"后台世界不动"变成一个查不出根因的怪现象。
 */
import { ServerCore } from '../server/server-core.ts';
import type { ChunkProvider } from '../server/world/chunk-provider.ts';
import { recommendedGenWorkers, genQueueDepth } from '../server/world/gen-pool-shape.ts';
import { decodeChunk } from '../core/world/chunk-codec.ts';
import { chunkKey, type Chunk } from '../core/world/chunk.ts';
import { createBlockRegistry } from '../content/blocks.ts';
import { MessagePortTransport } from '../core/net/transport.ts';
import { MS_PER_TICK } from '../core/constants.ts';
import { StatSlot, writeStat } from '../core/shared-stats.ts';

interface StartMessage {
  kind: 'start';
  seed: number;
  port: MessagePort;
  /** 心跳来源。没有它就回落到 setTimeout */
  clockPort?: MessagePort;
  /** 共享统计槽 */
  stats?: SharedArrayBuffer;
}

interface StopMessage {
  kind: 'stop';
}

/**
 * gen worker 池，实现 ChunkProvider。
 *
 * 派单用轮询而不是"谁空给谁"：生成耗时几乎恒定（同一份噪声、同样的地形算法），
 * 轮询就已经均衡，还省掉了维护空闲队列的状态。
 */
class GenPool implements ChunkProvider {
  private readonly workers: Worker[] = [];
  private readonly pending = new Set<number>();
  private readonly done: Chunk[] = [];
  private next = 0;
  private readonly depth: number;

  constructor(seed: number, count: number) {
    this.depth = genQueueDepth(count);
    for (let i = 0; i < count; i++) {
      const w = new Worker(new URL('./gen-worker.ts', import.meta.url).href, {
        type: 'module',
        name: `gen${i}`,
      });
      w.onmessage = (ev: MessageEvent): void => {
        const m = ev.data as { kind: string; cx: number; cz: number; blob: Uint8Array };
        if (m.kind !== 'chunk') return;
        this.pending.delete(chunkKey(m.cx, m.cz));
        this.done.push(decodeChunk(m.cx, m.cz, m.blob));
      };
      w.onerror = (ev: ErrorEvent): void => {
        // 生成 worker 挂掉必须喊出来：静默的话表现为"地形加载到一半就不动了"，
        // 而那时候已经完全看不出根因
        console.error(`[gen-worker] ${ev.message}`);
      };
      w.postMessage({ kind: 'start', seed });
      this.workers.push(w);
    }
  }

  get inFlight(): number {
    return this.pending.size;
  }

  request(cx: number, cz: number): boolean {
    const key = chunkKey(cx, cz);
    if (this.pending.has(key)) return true; // 已经在途，别重复下单
    if (this.pending.size >= this.depth) return false;
    this.pending.add(key);
    const w = this.workers[this.next % this.workers.length]!;
    this.next++;
    w.postMessage({ kind: 'gen', cx, cz });
    return true;
  }

  drain(): Chunk[] {
    if (this.done.length === 0) return [];
    return this.done.splice(0, this.done.length);
  }

  terminate(): void {
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
  }
}

let server: ServerCore | null = null;
let stats: Int32Array | null = null;
let genPool: GenPool | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/** 下一次 tick 的目标时刻，用它做漂移校正而不是固定间隔 */
let nextTickAt = 0;

/** 跑一个 tick 并记录耗时 */
function runTick(): void {
  if (server === null) return;
  const started = performance.now();
  try {
    server.tick();
  } catch (err) {
    // tick 抛异常时不能静默停摆 —— 那会表现为"世界忽然不动了"且毫无线索
    console.error('[server-worker] tick 抛出异常', err);
    throw err;
  }
  server.lastTickMs = performance.now() - started;
  if (stats !== null) {
    writeStat(stats, StatSlot.SERVER_TICKS, server.tickCount);
    writeStat(stats, StatSlot.SERVER_TICK_CENTIMS, Math.round(server.lastTickMs * 100));
  }
}

/** 没有心跳线程时的兜底：自校正的 setTimeout 循环 */
function loop(): void {
  if (server === null) return;
  runTick();

  // 自校正：按目标时刻推进，而不是每次 +50ms。
  // 后者会把每次的调度延迟累积起来，跑久了 TPS 会持续偏低。
  nextTickAt += MS_PER_TICK;
  const now = performance.now();
  let delay = nextTickAt - now;
  if (delay < -MS_PER_TICK * 10) {
    // 落后太多就放弃追赶，重新对齐。硬追会让服务端连续跑几十个 tick，
    // 表现为一次长卡顿之后世界"快进"。
    nextTickAt = now + MS_PER_TICK;
    delay = MS_PER_TICK;
  }
  timer = setTimeout(loop, Math.max(0, delay));
}

self.onmessage = (ev: MessageEvent): void => {
  const msg = ev.data as StartMessage | StopMessage;

  if (msg.kind === 'start') {
    const registry = createBlockRegistry();
    server = new ServerCore({ seed: BigInt(msg.seed), registry });
    server.addClient(new MessagePortTransport(msg.port));
    stats = msg.stats !== undefined ? new Int32Array(msg.stats) : null;

    // 世界生成搬进独立 worker。留在这条线程上时，加载期间单 tick 的
    // p50 是 96.9 ms、最大 269.6 ms —— 服务端等于在以 10 TPS 跑。
    const cores = navigator.hardwareConcurrency ?? 8;
    genPool = new GenPool(msg.seed, recommendedGenWorkers(cores));
    server.world.setProvider(genPool);

    if (msg.clockPort !== undefined) {
      msg.clockPort.onmessage = (): void => runTick();
      msg.clockPort.start();
      return;
    }
    console.warn('[server-worker] 没有心跳线程，回落到 setTimeout —— 后台标签页会停摆');
    nextTickAt = performance.now() + MS_PER_TICK;
    timer = setTimeout(loop, MS_PER_TICK);
    return;
  }

  if (msg.kind === 'stop') {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (genPool !== null) genPool.terminate();
    genPool = null;
    server = null;
  }
};
