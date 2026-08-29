/**
 * 跨线程共享的统计槽。
 *
 * 一小块 SharedArrayBuffer，各线程往自己的槽里写计数，任何线程随时能读。
 * 存在的理由是**它不经过消息**：读一个槽是一条内存指令，不需要对方的事件循环
 * 转起来，也就不受后台标签页节流的影响。
 *
 * 诊断"后台世界不动了"这类问题时这一点是决定性的 —— 靠 postMessage 问状态
 * 的话，节流会同时掐死问和答，你只能看到一个超时，分不清是谁停了。
 */
export const StatSlot = {
  /** 主线程写 1 表示叫停心跳线程 */
  CLOCK_STOP: 0,
  /** 心跳线程敲了多少拍 */
  CLOCK_BEATS: 1,
  /** 服务端跑了多少 tick */
  SERVER_TICKS: 2,
  /** 服务端上一个 tick 的耗时，单位 1/100 ms */
  SERVER_TICK_CENTIMS: 3,
} as const;
export type StatSlot = (typeof StatSlot)[keyof typeof StatSlot];

export const STAT_SLOT_COUNT = 16;
export const STAT_BYTES = STAT_SLOT_COUNT * 4;

export function readStat(stats: Int32Array, slot: StatSlot): number {
  return Atomics.load(stats, slot);
}

export function writeStat(stats: Int32Array, slot: StatSlot, value: number): void {
  Atomics.store(stats, slot, value);
}
