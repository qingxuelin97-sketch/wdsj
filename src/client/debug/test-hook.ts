/**
 * window.__mc —— 自动化驱动游戏的测试钩子。
 *
 * 始终编译进产物（不靠 flag 开关），因为无头跑测和 Chrome MCP 驱动都依赖它。
 *
 * 让截图回归真正可用的四条规则：
 *   1. 渲染/网格化代码禁止读挂钟（由 tools/lint-layers.mjs 强制），动画相位一律来自
 *      clock.renderTick，所以 freeze() 一停画面就完全静止；
 *   2. screenshot() 必须先 renderOnce() 再立刻 toDataURL —— preserveDrawingBuffer 是
 *      false，绘制缓冲在合成后就被清空。await nextFrame() 之后的代码跑在 rAF 回调的
 *      microtask 里（或 hidden 分支的 setTimeout 里），都在合成之前，所以安全；
 *   3. setCanvasSize 直写 canvas.width/height 绕过 devicePixelRatio，跨机器可比；
 *   4. screenshotHash() 先降到 64×64 灰度再哈希，容忍 GPU 浮点噪声但能抓住真实回归。
 *
 * 本文件目前是 M0 版本：世界操作类接口（setBlock/spawn/give…）要等 M2 服务端就位后接上。
 */
import type { Clock } from '../clock.ts';
import type { Camera } from '../camera.ts';
import type { Input } from '../input/input.ts';
import { nextFrame } from '../frame-scheduler.ts';

export interface McStats {
  fps: number;
  frameMs: number;
  renderTick: number;
  drawCalls: number;
  quads: number;
  trianglesDrawn: number;
  jsHeapMB: number;
  cameraX: number;
  cameraY: number;
  cameraZ: number;
  yaw: number;
  pitch: number;
}

export interface HostBridge {
  readonly clock: Clock;
  readonly camera: Camera;
  readonly input: Input;
  readonly canvas: HTMLCanvasElement;
  /** 立即渲染一帧（不推进时钟），供截图使用 */
  renderOnce(): void;
  /** 本帧的绘制统计 */
  drawStats(): { drawCalls: number; quads: number };
  /**
   * 锁定/解锁绘制缓冲尺寸。
   * 锁定期间主循环不得再按 CSS 尺寸×devicePixelRatio 重算 canvas.width/height，
   * 否则 setCanvasSize(640,360) 会在 dpr=1.5 的机器上被改成 960×540，
   * 截图就不再跨机器可比了。
   */
  setSizeLock(locked: boolean): void;
  /**
   * 供 waitForIdle 判断世界是否已经"安定"。
   *   dirty         还有多少子区块等着网格化
   *   chunks        当前已加载的区块数
   *   serverPending 服务端还有多少区块排队要推给本客户端
   *
   * 三者缺一不可。只看 dirty 的话，服务端刚推完一批、下一批还没到的空档里
   * dirty 恰好为 0，waitForIdle 就会提前返回，截到一个半成品世界。
   */
  idleStats(): { dirty: number; chunks: number; serverPending: number };
  /**
   * 手动推进一步模拟：服务端 tick + 一批网格化。
   *
   * 自动化必须能**主动驱动**世界，而不是靠等真实时间。服务端 tick 平时由帧率
   * 驱动，于是"跑到第几 tick"取决于机器快慢，区块加载与卸载扫描的时机随之漂移，
   * 同一份代码每次截出来的画面都不同。有了它，waitForIdle 就能在冻结状态下
   * 精确地把世界推到收敛。
   */
  pumpWorld(): void;
  /** 内部世界对象，供排查工具做状态指纹。生产代码不要用 */
  debugWorld(): unknown;
}

/** 收集未捕获错误、WebGL 错误、着色器错误，供 assertNoErrors 使用 */
const errorLog: string[] = [];
const consoleLog: string[] = [];

export function recordError(msg: string): void {
  errorLog.push(msg);
  if (errorLog.length > 200) errorLog.shift();
}

export function recordLog(msg: string): void {
  consoleLog.push(msg);
  if (consoleLog.length > 500) consoleLog.shift();
}

/** FNV-1a over 灰度降采样，用于截图回归 */
function hashImageData(data: Uint8ClampedArray, w: number, h: number, target = 64): string {
  let hash = 0x811c9dc5;
  for (let ty = 0; ty < target; ty++) {
    for (let tx = 0; tx < target; tx++) {
      // 盒式降采样，把 GPU 的浮点抖动平均掉
      const x0 = Math.floor((tx * w) / target);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * w) / target));
      const y0 = Math.floor((ty * h) / target);
      const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * h) / target));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4;
          // Rec. 601 灰度
          sum += 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
          n++;
        }
      }
      // 量化到 32 级，进一步吸收噪声
      const gray = n > 0 ? Math.round(sum / n / 8) : 0;
      hash ^= gray;
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function installTestHook(host: HostBridge): void {
  let readyResolve: () => void = () => {};
  const ready = new Promise<void>((r) => {
    readyResolve = r;
  });

  const api = {
    version: 'M0',
    ready,
    /** 由主循环在第一帧画完后调用 */
    _markReady: (): void => readyResolve(),

    // --- 确定性控制 ---
    freeze(on: boolean): void {
      host.clock.frozen = on;
    },
    async step(frames: number): Promise<void> {
      host.clock.stepFrames(frames);
      await nextFrame();
    },
    setFixedTimestep(on: boolean): void {
      host.clock.fixedTimestep = on;
    },
    setCanvasSize(w: number, h: number): void {
      // 绕过 devicePixelRatio，让截图跨机器逐字节可比。
      // 必须先上锁，否则主循环下一帧就会按 CSS 尺寸×dpr 把它改回去。
      host.setSizeLock(true);
      host.canvas.width = w;
      host.canvas.height = h;
      host.canvas.style.width = `${w}px`;
      host.canvas.style.height = `${h}px`;
    },
    /** 解除尺寸锁定，恢复随窗口自适应 */
    releaseCanvasSize(): void {
      host.setSizeLock(false);
      host.canvas.style.width = '';
      host.canvas.style.height = '';
    },

    /**
     * 等世界安定下来：网格化队列清空，且区块数连续若干帧不再变化。
     *
     * 截图回归必须等这个，不能用固定 sleep —— 世界是流式加载的，
     * 看得远的视角要等更多区块到达。固定 sleep 在快的机器上够、慢的机器上不够，
     * 表现为**同一份代码时而通过时而失败**的哈希不匹配，是最难查的一类"假失败"。
     */
    async waitForIdle(timeoutMs = 30000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      let stable = 0;
      let lastChunks = -1;
      let pumps = 0;
      while (Date.now() < deadline) {
        // 主动推进，不依赖帧率 —— 这是让世界状态可复现的关键
        host.pumpWorld();
        pumps++;
        const s = host.idleStats();
        // chunks > 0 是必要的下限条件：服务端跑在自己的 Worker 里，启动要一点时间，
        // 在它开始推送之前三项统计全是 0 且纹丝不动，会被误判成"世界已就绪"，
        // 于是拿到一个空场景（实测 quads=0）。
        if (s.chunks > 0 && s.dirty === 0 && s.serverPending === 0 && s.chunks === lastChunks) {
          stable++;
          // 稳定 200 步才算安定：区块卸载扫描每 100 tick 才跑一次，
          // 少于这个数就可能在扫描之前返回，留下一批本该卸载的区块
          if (stable >= 200) return;
        } else {
          stable = 0;
          lastChunks = s.chunks;
        }
        // 每推进若干步让出一次，避免长时间独占主线程把页面卡死
        if (pumps % 64 === 0) await nextFrame();
      }
      const s = host.idleStats();
      throw new Error(
        `waitForIdle 超时 (${timeoutMs}ms)：${s.dirty} 段待网格化，${s.serverPending} 个区块待推送，${s.chunks} 个区块已加载`,
      );
    },

    // --- 相机 ---
    setCamera(x: number, y: number, z: number, yaw: number, pitch: number, fov?: number): void {
      host.camera.setPosition(x, y, z);
      host.camera.setRotation(yaw, pitch);
      if (fov !== undefined) host.camera.fovDegrees = fov;
    },
    tp(x: number, y: number, z: number, yaw?: number, pitch?: number): void {
      host.camera.setPosition(x, y, z);
      if (yaw !== undefined) host.camera.setRotation(yaw, pitch ?? host.camera.pitch);
    },

    // --- 输入合成 ---
    /**
     * 按住某个键一段时间。
     *
     * 按**墙钟**计时而不是帧数：按帧数的话，"按住 1 秒"实际等的是 60 帧，
     * 一旦真实帧率低于 60（移动中要网格化新区块时很常见）就会超时报错，
     * 而那其实是正常的性能表现，不是故障。
     */
    async press(code: string, ms = 100): Promise<void> {
      host.input.injectKeyDown(code);
      try {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) await nextFrame();
      } finally {
        host.input.injectKeyUp(code);
      }
    },

    /**
     * 采样若干帧的运行指标。
     *
     * 用帧回调而不是 setInterval：后台标签页的定时器会被节流到 1 Hz 甚至更低，
     * 采出来的曲线完全失真（实测 71 秒只采到 6 个点）。
     */
    async sampleFrames(frames: number): Promise<McStats[]> {
      const out: McStats[] = [];
      for (let i = 0; i < frames; i++) {
        await nextFrame();
        out.push(api.stats());
      }
      return out;
    },
    look(dYaw: number, dPitch: number): void {
      host.input.injectLook(dYaw, dPitch);
    },

    // --- 验证 ---
    async screenshot(): Promise<string> {
      // preserveDrawingBuffer 为 false，所以必须在同一个 rAF 里画完立刻读
      await nextFrame();
      host.renderOnce();
      return host.canvas.toDataURL('image/png');
    },
    async screenshotHash(): Promise<string> {
      await nextFrame();
      host.renderOnce();
      const w = host.canvas.width;
      const h = host.canvas.height;
      // 通过一个 2D canvas 取像素；直接 readPixels 也行，但那样要处理上下翻转
      const tmp = new OffscreenCanvas(w, h);
      const ctx = tmp.getContext('2d');
      if (ctx === null) return 'nocontext';
      ctx.drawImage(host.canvas, 0, 0);
      const img = ctx.getImageData(0, 0, w, h);
      return hashImageData(img.data, w, h);
    },
    stats(): McStats {
      const d = host.drawStats();
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      return {
        fps: Math.round(host.clock.fps * 10) / 10,
        frameMs: Math.round(host.clock.frameMs * 100) / 100,
        renderTick: host.clock.renderTick,
        drawCalls: d.drawCalls,
        quads: d.quads,
        trianglesDrawn: d.quads * 2,
        jsHeapMB: mem !== undefined ? Math.round(mem.usedJSHeapSize / 1048576) : -1,
        cameraX: Math.round(host.camera.position[0]! * 100) / 100,
        cameraY: Math.round(host.camera.position[1]! * 100) / 100,
        cameraZ: Math.round(host.camera.position[2]! * 100) / 100,
        yaw: Math.round(host.camera.yaw * 1000) / 1000,
        pitch: Math.round(host.camera.pitch * 1000) / 1000,
      };
    },
    /** 排查用：拿到客户端世界镜像。不是稳定接口 */
    _world(): unknown {
      return host.debugWorld();
    },
    logs(): string[] {
      return [...consoleLog];
    },
    errors(): string[] {
      return [...errorLog];
    },
    assertNoErrors(): void {
      if (errorLog.length > 0) {
        throw new Error(`检测到 ${errorLog.length} 条错误:\n${errorLog.join('\n')}`);
      }
    },
  };

  (globalThis as unknown as { __mc: typeof api }).__mc = api;
}
