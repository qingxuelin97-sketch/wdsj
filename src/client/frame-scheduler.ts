/**
 * 帧调度。
 *
 * 为什么不直接用 requestAnimationFrame：标签页不可见时 Chrome 完全不派发 rAF
 * （实测后台标签页 500 ms 内 0 帧）。自动化验证跑在后台标签页里，所有等待帧推进的
 * 测试钩子都会就此挂死。
 *
 * 所以这里做成可退化的调度器：可见时走 rAF（与显示器同步、省电），不可见时退化为
 * setTimeout。后台的帧率不重要，能推进就行 —— 自动化能跑通比省那点电重要。
 *
 * 注意这与服务端时钟是两回事：服务端 tick 用 SharedArrayBuffer + Atomics.wait，
 * 从根子上免疫标签页节流（见 M5）。这里解决的只是客户端渲染帧。
 */

/** 不可见时的兜底帧间隔（毫秒） */
const HIDDEN_FRAME_MS = 16;

export type FrameCallback = (nowMs: number) => void;

/**
 * 后台心跳。
 *
 * 光把 rAF 换成 setTimeout 是不够的：Chrome 对**后台标签页的定时器同样节流到 1 Hz**，
 * 实测 400 ms 内一帧都推不动。而 dedicated worker 里的定时器不受主线程标签页可见性节流，
 * 所以用一个只发心跳的极小 worker 来驱动后台帧。
 *
 * worker 源码内联成 blob，避免多一个入口文件；blob: 是同源的，COEP require-corp 下可用。
 */
let heartbeat: Worker | null = null;
const pendingCallbacks: FrameCallback[] = [];

function flushPending(): void {
  if (pendingCallbacks.length === 0) return;
  const batch = pendingCallbacks.splice(0, pendingCallbacks.length);
  const now = performance.now();
  for (const cb of batch) cb(now);
}

function ensureHeartbeat(): void {
  if (heartbeat !== null) return;
  const src = `let t=null;onmessage=e=>{if(e.data==='start'){if(t===null)t=setInterval(()=>postMessage(0),${HIDDEN_FRAME_MS});}else if(e.data==='stop'){if(t!==null){clearInterval(t);t=null;}}};`;
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  try {
    heartbeat = new Worker(url);
    heartbeat.onmessage = flushPending;
    heartbeat.postMessage('start');
  } catch {
    // worker 起不来就退回定时器：后台会被节流到 1 Hz，但至少不会彻底卡死
    heartbeat = null;
    setInterval(flushPending, HIDDEN_FRAME_MS);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 调度下一帧。
 * 可见时走 rAF（与显示器同步、省电），不可见时走 worker 心跳。
 * 这是客户端除 Clock 之外唯一允许读挂钟的地方。
 */
export function scheduleFrame(cb: FrameCallback): void {
  if (typeof document !== 'undefined' && document.hidden) {
    ensureHeartbeat();
    pendingCallbacks.push(cb);
  } else {
    requestAnimationFrame(cb);
  }
}

/** await 一帧。测试钩子里的所有等待都走这里，才不会在后台标签页挂死。 */
export function nextFrame(): Promise<number> {
  return new Promise((resolve) => scheduleFrame(resolve));
}

/**
 * 等待若干帧。
 * @param n 帧数
 */
export async function waitFrames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await nextFrame();
}

/**
 * 带超时的条件等待，供自动化使用。
 * 超时会抛错而不是静默返回 —— 静默超时会让"测试通过"变成谎言。
 */
export async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) {
      throw new Error(`waitUntil 超时 (${timeoutMs}ms): ${description}`);
    }
    await nextFrame();
  }
}
