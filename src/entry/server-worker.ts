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
import { WorldSave } from '../server/save/world-save.ts';
import { SaveController } from '../server/save/save-controller.ts';
import { OpfsStorage } from '../platform/storage-opfs.ts';
import { MemoryStorage, type SaveStorage } from '../platform/storage.ts';

interface StartMessage {
  kind: 'start';
  seed: number;
  port: MessagePort;
  /** 心跳来源。没有它就回落到 setTimeout */
  clockPort?: MessagePort;
  /** 共享统计槽 */
  stats?: SharedArrayBuffer;
  /** 是否落盘。测试里可以关掉，免得一次跑测污染上一次的世界 */
  persist?: boolean;
  /** 是否自然生成生物。截图回归要关掉，见 MobManager.naturalSpawning */
  spawnMobs?: boolean;
}

interface StopMessage {
  kind: 'stop';
}

/** 主线程要求立刻存盘（关页面前、或者测试钩子调的） */
interface SaveMessage {
  kind: 'save';
  requestId: number;
}

/** 主线程要求把存档清掉，用于"新建世界" */
interface WipeMessage {
  kind: 'wipe';
  requestId: number;
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
let saveController: SaveController | null = null;
/** 已经有一次存盘在飞。存盘比 tick 慢得多，不能让它们叠起来 */
let savingNow = false;
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

  // 自动存盘。跑在 tick **之外**（await 出去之后世界已经推进完了），
  // 所以不会把 tick 循环拖成异步 —— ServerCore.tick 必须保持同步
  if (saveController !== null && !savingNow && saveController.isAutosaveDue()) {
    savingNow = true;
    void saveController.saveNow().then(
      (report) => {
        savingNow = false;
        console.log(`[save] 自动存盘：${report.chunks} 个区块 / ${report.regions} 个 region`);
      },
      (err: unknown) => {
        savingNow = false;
        // 存盘失败必须喊出来。静默失败的表现是"关掉页面再进来东西没了"，
        // 而那时候已经无从查起
        console.error('[save] 自动存盘失败', err);
      },
    );
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

/** 存档后端。没有 OPFS（私密模式、非安全上下文）时退回内存，并明确说一声 */
function makeStorage(seed: number): SaveStorage {
  if (OpfsStorage.available()) return new OpfsStorage(`world-${seed}`);
  console.warn('[save] 这个环境没有 OPFS，退回内存存档 —— 刷新页面后世界不会保留');
  return new MemoryStorage();
}

/**
 * 起一个世界。
 *
 * 顺序是硬性的：**先把存档打开，再放客户端进来**。反过来的话，
 * 玩家登录时会强制生成出生区块，把存过的内容永久顶掉
 * （见 server/save/save-controller.ts 的 loadLevel）。
 */
async function start(msg: StartMessage): Promise<void> {
  const registry = createBlockRegistry();
  const core = new ServerCore({ seed: BigInt(msg.seed), registry });
  stats = msg.stats !== undefined ? new Int32Array(msg.stats) : null;
  if (msg.spawnMobs === false) {
    core.mobs.naturalSpawning = false;
    console.log('[mobs] 已按参数关闭自然生成，只有 spawn 指令能放怪');
  }

  // persist=0 时**根本不挂存档**，而不是挂一个内存后端。
  //
  // 差别不是省一点内存：挂上存档之后，区块的来源就从"生成"变成了
  // "先查存档、没有才生成"，卸载时还会连同光照一起存下来。那条路径完全正确，
  // 但它让"同一个种子跑两次"不再等价 —— 截图回归要的正是这个等价。
  if (msg.persist !== false) {
    const save = new WorldSave(makeStorage(msg.seed));
    const controller = new SaveController(core, save);
    const existed = await controller.loadLevel();
    console.log(existed
      ? `[save] 读到存档：世界年龄 ${core.world.worldAge}，时间 ${core.world.timeOfDay}`
      : '[save] 没有存档，新建世界');
    core.onPlayerReady = (player): void => {
      if (controller.restorePlayer(player)) console.log('[save] 玩家数据已还原');
    };
    saveController = controller;
  } else {
    console.log('[save] 已按参数关闭持久化，本次世界不落盘也不读盘');
  }
  server = core;

  // 世界生成搬进独立 worker。留在这条线程上时，加载期间单 tick 的
  // p50 是 96.9 ms、最大 269.6 ms —— 服务端等于在以 10 TPS 跑。
  const cores = navigator.hardwareConcurrency ?? 8;
  genPool = new GenPool(msg.seed, recommendedGenWorkers(cores));
  core.world.setProvider(genPool);

  // 存档准备好了才接客户端
  core.addClient(new MessagePortTransport(msg.port));

  if (msg.clockPort !== undefined) {
    msg.clockPort.onmessage = (): void => runTick();
    msg.clockPort.start();
    return;
  }
  console.warn('[server-worker] 没有心跳线程，回落到 setTimeout —— 后台标签页会停摆');
  nextTickAt = performance.now() + MS_PER_TICK;
  timer = setTimeout(loop, MS_PER_TICK);
}

self.onmessage = (ev: MessageEvent): void => {
  const msg = ev.data as StartMessage | StopMessage | SaveMessage | WipeMessage;

  if (msg.kind === 'start') {
    void start(msg).catch((err: unknown) => {
      console.error('[server-worker] 启动失败', err);
    });
    return;
  }

  if (msg.kind === 'save') {
    if (saveController === null) {
      self.postMessage({ kind: 'saved', requestId: msg.requestId, ok: false, chunks: 0 });
      return;
    }
    void saveController.saveNow().then(
      (report) => {
        self.postMessage({ kind: 'saved', requestId: msg.requestId, ok: true, chunks: report.chunks });
      },
      (err: unknown) => {
        console.error('[save] 存盘失败', err);
        self.postMessage({ kind: 'saved', requestId: msg.requestId, ok: false, chunks: 0 });
      },
    );
    return;
  }

  if (msg.kind === 'wipe') {
    void (async (): Promise<void> => {
      const ok = saveController !== null && await saveController.wipe();
      self.postMessage({ kind: 'wiped', requestId: msg.requestId, ok });
    })();
    return;
  }

  if (msg.kind === 'stop') {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (genPool !== null) genPool.terminate();
    genPool = null;
    server = null;
    saveController = null;
  }
};
