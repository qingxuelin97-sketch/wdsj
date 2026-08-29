/**
 * 服务端的心跳源。
 *
 * 为什么要单开一个线程只为了数拍子：**浏览器会把后台标签页的定时器掐死**。
 * 实测把游戏页切到后台，服务端 worker 里的 `setTimeout` 循环直接停摆 ——
 * 30 秒内一个 tick 都没跑（指令往返 8 秒超时，连一次 flush 都没做到）。
 * 前台是 20.0 TPS，后台是 0。对一个"内置服务端"来说这意味着切出去泡杯茶回来，
 * 世界还停在原地：作物没长、熔炉没烧、怪没动。
 *
 * `Atomics.wait` 不是定时器，是让线程真的睡在一个 futex 上，不受节流影响。
 * 但它会**阻塞整条线程**，所以不能放在服务端 worker 里 —— 那样 MessagePort
 * 的消息永远等不到事件循环，客户端的包一个也收不到。
 *
 * 于是拆成两条线程：这条只负责睡觉和敲鼓，服务端 worker 保持事件驱动。
 * 跨线程 postMessage 不是定时器，同样不受节流。
 */
import { MS_PER_TICK } from '../core/constants.ts';
import { StatSlot, writeStat } from '../core/shared-stats.ts';

interface StartMessage {
  kind: 'start';
  /** 敲鼓敲给谁 */
  port: MessagePort;
  /** 共享统计槽，见 core/shared-stats.ts */
  control: SharedArrayBuffer;
  /** 每拍毫秒数，默认 50 */
  intervalMs?: number;
}

self.onmessage = (ev: MessageEvent): void => {
  const msg = ev.data as StartMessage;
  if (msg.kind !== 'start') return;

  const ctrl = new Int32Array(msg.control);
  const port = msg.port;
  const interval = msg.intervalMs ?? MS_PER_TICK;
  let beat = 0;
  let nextAt = performance.now() + interval;

  // 这是个死循环，跑在自己的线程上，不会挡住任何人
  for (;;) {
    const now = performance.now();
    let delay = nextAt - now;

    if (delay > 0) {
      // 睡在 futex 上。ctrl[0] 仍是 0 就一直睡到超时；
      // 主线程要停的时候会写 1 再 notify，于是立刻醒。
      Atomics.wait(ctrl, StatSlot.CLOCK_STOP, 0, delay);
    }
    if (Atomics.load(ctrl, StatSlot.CLOCK_STOP) !== 0) return;

    // 自校正：按目标时刻推进，不是每次 +50ms。
    // 后者会把每次的调度延迟累积起来，跑久了 TPS 持续偏低。
    nextAt += interval;
    const after = performance.now();
    if (nextAt < after - interval * 10) {
      // 落后太多就重新对齐。硬追会让服务端连跑几十个 tick，
      // 表现成一次长卡顿之后世界"快进"。
      nextAt = after + interval;
    }

    beat++;
    // 先写共享槽再敲鼓：主线程读这个槽不需要任何消息投递，
    // 于是"心跳还在不在跳"和"服务端有没有收到"能分开诊断
    writeStat(ctrl, StatSlot.CLOCK_BEATS, beat);
    port.postMessage(beat);
  }
};
