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
 * tick 时钟目前用 setTimeout 自校正。Worker 里的定时器不受主线程标签页可见性节流，
 * 已经够用；M5 会换成 SharedArrayBuffer + Atomics.wait，那样连浏览器整体降频时
 * 也能守住 20 TPS。
 */
import { ServerCore } from '../server/server-core.ts';
import { createBlockRegistry } from '../content/blocks.ts';
import { MessagePortTransport } from '../core/net/transport.ts';
import { MS_PER_TICK } from '../core/constants.ts';

interface StartMessage {
  kind: 'start';
  seed: number;
  port: MessagePort;
}

interface StopMessage {
  kind: 'stop';
}

let server: ServerCore | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/** 下一次 tick 的目标时刻，用它做漂移校正而不是固定间隔 */
let nextTickAt = 0;

function loop(): void {
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
    nextTickAt = performance.now() + MS_PER_TICK;
    timer = setTimeout(loop, MS_PER_TICK);
    return;
  }

  if (msg.kind === 'stop') {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    server = null;
  }
};
