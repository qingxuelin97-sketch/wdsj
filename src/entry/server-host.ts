/**
 * 内置服务端的宿主：起 worker、接线、驱动心跳、存盘往返。
 *
 * 从 client-main.ts 里分出来的（那个文件到了 729 行、越过 600 硬上限）。
 * 分界线是"和服务端 worker 打交道的一切"：三条线程的创建、
 * SharedArrayBuffer 心跳、MessagePort 传输、存盘请求的回执匹配。
 *
 * client-main 拿到的只是一个 PacketChannel 和几个函数 ——
 * 它不需要知道服务端是在 worker 里、在 node 上还是在同一条线程上。
 */
import { MessagePortTransport, PacketChannel, WebSocketTransport } from '../core/net/transport.ts';
import { S2C } from '../core/net/packets.ts';
import { STAT_BYTES, StatSlot, readStat, writeStat } from '../core/shared-stats.ts';

export interface SaveResult {
  ok: boolean;
  chunks: number;
}

export interface ServerHost {
  /** 与服务端之间的包通道 */
  readonly net: PacketChannel;
  /** 世界是否会落盘 */
  readonly persist: boolean;
  /** 叫服务端立刻存盘 / 清档，等回执 */
  requestSave(kind?: 'save' | 'wipe'): Promise<SaveResult>;
  /** 直接读共享统计槽。没有 SharedArrayBuffer 时返回 null */
  sharedStats(): { beats: number; serverTicks: number; tickCentiMs: number } | null;
  /** 页面要没了：叫停心跳线程 */
  shutdown(): void;
}

export interface ServerHostOptions {
  seed: number;
  /** 要不要落盘 */
  persist: boolean;
  /** 要不要自然生成生物 */
  spawnMobs: boolean;
  /** 要不要跑随机刻（作物生长、草蔓延） */
  randomTicks: boolean;
  /** 出错时往哪报 */
  recordError(msg: string): void;
  recordLog(msg: string): void;
}

/**
 * 连一个**独立的**多人服务端（`?server=ws://…`）。
 *
 * 返回的东西和 startServerHost 完全同型 —— client-main 不需要知道
 * 服务端是在 worker 里还是在网线那头。这正是 Transport 这层抽象的回报：
 * "多人"在客户端这边只是换一个 Transport 实现，别的一行不动。
 *
 * 存盘与共享统计在多人模式下**不可用**：存档由服务端自己管
 * （玩家没有权力叫服务端存盘），而 SharedArrayBuffer 跨不了网络。
 * 两者都返回失败/null 而不是抛异常 —— 调用方（测试钩子、F3）
 * 本来就要处理"没有"这种情况。
 */
export function connectRemoteServer(url: string): ServerHost {
  const net = new PacketChannel(new WebSocketTransport(url), S2C);
  return {
    net,
    persist: true,
    requestSave: () => Promise.resolve({ ok: false, chunks: 0 }),
    sharedStats: () => null,
    shutdown: () => { net.transport.close(); },
  };
}

export function startServerHost(opts: ServerHostOptions): ServerHost {
  const serverWorker = new Worker(new URL('./server-worker.ts', import.meta.url).href, {
    type: 'module',
    name: 'server',
  });
  serverWorker.onerror = (ev: ErrorEvent): void => {
    console.error(`[server-worker] ${ev.message}`);
    opts.recordError(`服务端 worker 错误: ${ev.message}`);
  };
  const channel = new MessageChannel();

  const persist = opts.persist;
  const spawnMobs = opts.spawnMobs;
  const randomTicks = opts.randomTicks;
  const seed = opts.seed;

  /** 存盘请求的回执，按 requestId 对上 */
  let nextSaveRequest = 1;
  const saveWaiters = new Map<number, (r: { ok: boolean; chunks: number }) => void>();

  serverWorker.addEventListener('message', (ev: MessageEvent) => {
    const m = ev.data as { kind?: string; requestId?: number; ok?: boolean; chunks?: number };
    if (m.kind !== 'saved' && m.kind !== 'wiped') return;
    const waiter = saveWaiters.get(m.requestId ?? -1);
    if (waiter === undefined) return;
    saveWaiters.delete(m.requestId!);
    waiter({ ok: m.ok === true, chunks: m.chunks ?? 0 });
  });

  /** 叫服务端立刻存盘，等它回执 */
  function requestSave(kind: 'save' | 'wipe' = 'save'): Promise<{ ok: boolean; chunks: number }> {
    const requestId = nextSaveRequest++;
    return new Promise((resolve) => {
      saveWaiters.set(requestId, resolve);
      serverWorker.postMessage({ kind, requestId });
      // 超时兜底：worker 挂了的话不能让调用方永远挂着
      setTimeout(() => {
        if (saveWaiters.delete(requestId)) resolve({ ok: false, chunks: 0 });
      }, 10000);
    });
  }

  // 心跳线程。
  //
  // 后台标签页会把 worker 里的 setTimeout 掐死 —— 实测前台 20.0 TPS、后台 0，
  // 世界完全停摆。所以另起一条线程专门睡在 Atomics.wait 上敲拍子；
  // 它阻塞的是自己，服务端 worker 仍然是事件驱动的，MessagePort 照收。
  // 需要 SharedArrayBuffer，也就是需要跨源隔离（dev-server 已经带上 COOP/COEP）。
  let clockWorker: Worker | null = null;
  let clockControl: Int32Array | null = null;
  const clockPorts = new MessageChannel();

  if (typeof SharedArrayBuffer === 'function' && self.crossOriginIsolated) {
    clockWorker = new Worker(new URL('./clock-worker.ts', import.meta.url).href, {
      type: 'module',
      name: 'clock',
    });
    clockWorker.onerror = (ev: ErrorEvent): void => {
      console.error(`[clock-worker] ${ev.message}`);
      opts.recordError(`心跳 worker 错误: ${ev.message}`);
    };
    const control = new SharedArrayBuffer(STAT_BYTES);
    clockControl = new Int32Array(control);
    clockWorker.postMessage(
      { kind: 'start', port: clockPorts.port1, control },
      [clockPorts.port1],
    );
    serverWorker.postMessage(
      { kind: 'start', seed, port: channel.port2, clockPort: clockPorts.port2, stats: control, persist, spawnMobs, randomTicks },
      [channel.port2, clockPorts.port2],
    );
  } else {
    // 没有跨源隔离就退回 setTimeout。必须说出来：静默降级的话，
    // "切到后台世界就不动了"会变成一个查不出根因的怪现象。
    console.warn('[clock] 无 SharedArrayBuffer（未跨源隔离），服务端回落到 setTimeout 心跳');
    opts.recordLog('[clock] 无 SAB，回落 setTimeout 心跳：后台标签页 TPS 会掉到 0');
    serverWorker.postMessage({ kind: 'start', seed, port: channel.port2, persist, spawnMobs, randomTicks }, [channel.port2]);
  }


  /**
   * 关页面前存一次盘。
   *
   * 用 visibilitychange 而不是 beforeunload：手机浏览器与某些桌面场景根本
   * 不触发 beforeunload，而 visibilitychange 是唯一可靠的"页面要没了"信号。
   * 存盘本身是异步的、可能来不及跑完 —— 所以它只是自动存盘之外的一层保险，
   * 真正的保障是每 30 秒一次的自动存盘。
   */
  self.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && persist) void requestSave();
  });

  return {
    net: new PacketChannel(new MessagePortTransport(channel.port1), S2C),
    persist,
    requestSave,
    sharedStats: () => (clockControl === null ? null : {
      beats: readStat(clockControl, StatSlot.CLOCK_BEATS),
      serverTicks: readStat(clockControl, StatSlot.SERVER_TICKS),
      tickCentiMs: readStat(clockControl, StatSlot.SERVER_TICK_CENTIMS),
    }),
    /** 心跳线程睡在 futex 上，不主动叫醒它就会一直跑下去 */
    shutdown: () => {
      if (clockControl === null) return;
      writeStat(clockControl, StatSlot.CLOCK_STOP, 1);
      Atomics.notify(clockControl, StatSlot.CLOCK_STOP);
    },
  };
}
