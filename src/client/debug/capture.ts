/**
 * 截图与截图哈希 —— 截图回归的取样端。
 *
 * 从 test-hook.ts 里分出来的（那个文件到了 634 行、越过 600 硬上限）。
 * 分界线很清楚：这里回答的是"怎么从一个会动的游戏里取到一张**可复现**的画面"，
 * 而 test-hook 剩下的部分回答的是"怎么驱动游戏做一件事"。
 *
 * 这一整个模块存在的理由是同一件事：**截图回归要成立，取样必须可复现**。
 * 三条规则各自堵住一种不可复现：
 *
 *   pinFrame()      堵住"时间在动"—— 冻结时钟、把 renderTick 归零、连 fps 一起冻
 *   hashImageData() 堵住"GPU 有浮点噪声"—— 降到 64×64 灰度再量化到 32 级
 *   screenshotHash()堵住"异步的活还没干完"—— 连续两帧相同才采信
 *
 * 三条都是被真实的假失败换来的，去掉任何一条都会让 CI 变成随机红。
 */
import { nextFrame } from '../frame-scheduler.ts';

/**
 * 取样需要宿主提供的东西。
 *
 * 刻意比 HostBridge 窄：取样只碰时钟、画布和两个推进函数，
 * 拿到整个宿主反而让人以为它可以顺手改世界。
 */
export interface CaptureHost {
  readonly clock: { frozen: boolean; renderTick: number; statsFrozen: boolean };
  readonly canvas: HTMLCanvasElement;
  renderOnce(): void;
  pumpWorld(): void;
}

/** FNV-1a over 灰度降采样，用于截图回归 */
export function hashImageData(data: Uint8ClampedArray, w: number, h: number, target = 64): string {
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

export interface Capture {
  /** 把画面钉死，返回还原函数。量完必须调用 */
  pinFrame(): () => void;
  /** 取一张 PNG dataURL */
  screenshot(): Promise<string>;
  /** 渲染一帧并取哈希（不做稳定性判断，内部用） */
  hashOnce(): Promise<string>;
  /** 取一张**已经稳定**的画面的哈希 */
  screenshotHash(maxTries?: number): Promise<string>;
}

export function createCapture(host: CaptureHost): Capture {
  const api: Capture = {
    /**
     * 把画面钉死：冻结时钟，并把 renderTick 归零。
     *
     * 冻结只保证"世界不再往前走"，**不**保证"画面和上次一样"。
     * 所有动画相位（云的漂移、水与岩浆的贴图帧、火、传送门、生物待机、
     * 手持晃动）都是 renderTick 的函数，而 renderTick 数的是页面加载以来的帧数 ——
     * 同一个场景，这次跑在第 812 帧截，下次在第 907 帧截，云的位置就不一样。
     *
     * 这正是加云那天暴露出来的：黄金值刚写完，紧接着重跑就有五张对不上。
     * 在此之前世界里没有任何东西会自己动，于是"冻结 = 画面确定"一直碰巧成立。
     *
     * 归零而不是随便钉一个数：0 是最容易在别处复现的相位。
     */
    pinFrame(): () => void {
      const wasFrozen = host.clock.frozen;
      const wasTick = host.clock.renderTick;
      const wasStats = host.clock.statsFrozen;
      host.clock.frozen = true;
      host.clock.renderTick = 0;
      // 连 fps 一起冻。F3 把帧率画在屏幕上，而它每帧都在变 ——
      // 不冻的话"连续两帧一样"永远不成立
      host.clock.statsFrozen = true;
      return () => {
        host.clock.frozen = wasFrozen;
        host.clock.renderTick = wasTick;
        host.clock.statsFrozen = wasStats;
      };
    },

    async screenshot(): Promise<string> {
      const unpin = api.pinFrame();
      try {
        // preserveDrawingBuffer 为 false，所以必须在同一个 rAF 里画完立刻读
        await nextFrame();
        host.renderOnce();
        return host.canvas.toDataURL('image/png');
      } finally {
        unpin();
      }
    },

    async hashOnce(): Promise<string> {
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

    /**
     * 截图哈希 —— 要求画面**已经稳定**：连续两帧哈希相同才采信。
     *
     * waitForIdle 之后偶尔还会有一两个网格结果姗姗来迟（worker 的消息要过一轮
     * 事件循环才到），落在两次截图之间就会让哈希变一下。断言"连续两帧一样"
     * 把这件事变成显式的等待，而不是碰运气 ——
     * 否则表现出来就是同一份代码十次里失败一次，最难查的那种假失败。
     *
     * **自己负责把画面钉死**（见 pinFrame），不指望调用方记得。
     *
     * 与其去每个调用点补一句 freeze，不如让这个函数自己保证它要的前提：
     * 它要的就是一个静止且可复现的画面，那就自己把画面停住，量完再还回去。
     */
    async screenshotHash(maxTries = 12): Promise<string> {
      const unpin = api.pinFrame();
      try {
        let prev = await api.hashOnce();
        for (let i = 0; i < maxTries; i++) {
          host.pumpWorld();
          const next = await api.hashOnce();
          if (next === prev) return next;
          prev = next;
        }
        throw new Error(`screenshotHash: 画面 ${maxTries} 帧内始终没稳定下来`);
      } finally {
        unpin();
      }
    },
  };
  return api;
}
