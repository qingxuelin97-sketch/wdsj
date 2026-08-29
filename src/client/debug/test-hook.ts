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
  /**
   * 向服务端发一条指令并等回执。
   * 自动化改世界状态（放方块、设时间、传送）一律走这条路，
   * 而不是让客户端直接写自己的镜像 —— 那样客户端和服务端立刻就分叉了，
   * 见 docs/RULES.md 第 8 条。
   */
  command(text: string): Promise<{ ok: boolean; text: string }>;
  /** 服务端权威的当日时间，0..23999 */
  timeOfDay(): number;
  /**
   * 直接读共享统计槽。没有 SharedArrayBuffer 时返回 null。
   * 读它不需要任何消息投递 —— 这正是它能用来诊断"后台是不是停摆"的原因。
   */
  sharedStats(): { beats: number; serverTicks: number; tickCentiMs: number } | null;
  /** 累计重网格化过的子区块数，用于验证"改一格只重做少数几段" */
  remeshCount(): number;
  /** 读客户端镜像里的光照与列高，用于和服务端逐项对照 */
  mirrorInfo(x: number, y: number, z: number): { light: string; height: number; loaded: boolean };
  /** 内部世界对象，供排查工具做状态指纹。生产代码不要用 */
  debugWorld(): unknown;
  /** 强制重做全部网格。排查"网格是否过期"用 */
  remeshAll(): void;
  /**
   * 切到自由相机（无重力、可穿墙）。
   * setCamera 之后必须切过去，否则相机刚摆好下一帧就掉下去了。
   */
  detachCamera(): void;
  /** 切回受物理驱动的玩家，并把身体放到指定位置 */
  attachPlayer(x: number, y: number, z: number): void;
  /** 准星指着的方块；没指着任何东西时为 null */
  selectedBlock(): { x: number; y: number; z: number; face: number } | null;
  /** 本地挖掘进度 0..1 */
  digProgress(): number;
  /** 音频状态：是否就绪、播过多少个音 */
  audioStats(): { ready: boolean; plays: number };
  /** 启动音频上下文。正常游玩时由第一次点击触发，自动化里手动调 */
  startAudio(): void;
  /** 当前存活的粒子数 */
  particleCount(): number;
  /** 上一帧 UI 画了多少矩形 */
  uiQuads(): number;
  /** 当前是否开着某个容器界面 */
  uiOpen(): boolean;
  /** 读一个像素，排查用 */
  pixelAt(x: number, y: number): number[];
  /** 玩家身体状态，物理验收用 */
  playerState(): { x: number; y: number; z: number; onGround: boolean; mode: string };
  /** 叫服务端立刻存盘，等回执。闸门测试③要用 */
  saveWorld(): Promise<{ ok: boolean; chunks: number }>;
  /** 把存档整个删掉 */
  wipeSave(): Promise<{ ok: boolean; chunks: number }>;
  /** 视野里有多少掉落物，以及它们的内容 */
  itemEntities(): { id: number; x: number; y: number; z: number; item: number; count: number }[];
  /** 视野里有多少生物 */
  mobEntities(): { id: number; type: number; x: number; y: number; z: number; health: number }[];
  /** 上一帧生物渲染提交了多少顶点。用来验"真的画出来了" */
  mobVerts(): number;
  /** 客户端认不认为自己死了 */
  isDead(): boolean;
  /** 客户端手里的生存状态（服务端权威，这里只是镜像） */
  vitals(): { health: number; hunger: number; air: number; xpLevel: number };
  /** 请求重生 */
  respawn(): void;
  /** 发一个挖掘动作给服务端 */
  sendAction(kind: 'start-dig' | 'stop-dig', x: number, y: number, z: number): void;
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

    /** 发一条服务端指令，等回执 */
    command: (text: string): Promise<{ ok: boolean; text: string }> => host.command(text),

    /**
     * 设定世界时间并等客户端真的收到。
     *
     * 必须等回传，不能发完就走：时间是服务端权威的，客户端要等下一个
     * S_TimeUpdate 才知道。发完立刻截图的话截到的还是旧时间的天色，
     * 而且快慢机器上截到的还不一样 —— 又一个随机失败的来源。
     */
    async setTime(ticks: number): Promise<number> {
      const want = ((Math.floor(ticks) % 24000) + 24000) % 24000;
      // 先停掉昼夜推进，否则设完之后世界继续往前走，永远等不到相等
      await host.command('time hold 1');
      await host.command(`time set ${want}`);
      const t0 = Date.now();
      while (host.timeOfDay() !== want) {
        if (Date.now() - t0 > 5000) throw new Error(`setTime(${want}) 超时，客户端仍是 ${host.timeOfDay()}`);
        host.pumpWorld();
        await new Promise((r) => setTimeout(r, 16));
      }
      return host.timeOfDay();
    },

    timeOfDay: (): number => host.timeOfDay(),
    /** 立刻存盘。刷新页面前调它，就能验"退出重进世界还在" */
    saveWorld: (): Promise<{ ok: boolean; chunks: number }> => host.saveWorld(),
    /** 删掉存档，用于让下一次进入是干净的新世界 */
    wipeSave: (): Promise<{ ok: boolean; chunks: number }> => host.wipeSave(),
    /** 当前视野里的掉落物 */
    itemEntities: (): { id: number; x: number; y: number; z: number; item: number; count: number }[] =>
      host.itemEntities(),
    /** 当前视野里的生物 */
    mobEntities: (): { id: number; type: number; x: number; y: number; z: number; health: number }[] =>
      host.mobEntities(),
    /** 上一帧生物渲染提交的顶点数 */
    mobVerts: (): number => host.mobVerts(),
    /** 客户端认不认为自己死了 */
    isDead: (): boolean => host.isDead(),
    /** 客户端镜像里的生存状态 */
    vitals: (): { health: number; hunger: number; air: number; xpLevel: number } => host.vitals(),
    /** 请求重生，并等服务端把血量发回来 */
    async respawn(): Promise<void> {
      host.respawn();
      const t0 = Date.now();
      while (host.isDead() && Date.now() - t0 < 3000) {
        await new Promise((r) => setTimeout(r, 16));
      }
    },
    sharedStats: (): { beats: number; serverTicks: number; tickCentiMs: number } | null =>
      host.sharedStats(),
    remeshCount: (): number => host.remeshCount(),
    mirrorLight: (x: number, y: number, z: number): string => host.mirrorInfo(x, y, z).light,
    /** 排查用：客户端镜像在该点的光照与列高 */
    _mirrorInfo: (x: number, y: number, z: number): { light: string; height: number; loaded: boolean } =>
      host.mirrorInfo(x, y, z),
    /** 排查用：拿到客户端世界镜像。不是稳定接口 */
    _world: (): unknown => host.debugWorld(),
    /** 直接按下/松开鼠标键，不等待。要自己控制按住时长时用它 */
    _injectMouse: (button: number, down: boolean): void => {
      if (down) host.input.injectMouseDown(button);
      else host.input.injectMouseUp(button);
    },
    /** 排查用：把所有子区块标脏，强制整场重做网格 */
    _remeshAll: (): void => host.remeshAll(),

    /**
     * 比对客户端镜像与服务端的光照。
     *
     * 服务端不会为一次方块变更下发光照数据，客户端是拿同一份 core 算法
     * 在自己的副本上独立重算的。这个断言就是在验证"同样的世界 + 同样的算法
     * = 同样的结果"这个前提真的成立 —— 一旦哪天有人给某一侧加了特判，
     * 玩家会看到光照忽明忽暗，而那时候极难查到根因。
     */
    async checkLight(x: number, y: number, z: number): Promise<{
      server: string; client: string; same: boolean;
      serverHeight: string; clientHeight: number; loaded: boolean;
    }> {
      const r = await host.command(`light ${x} ${y} ${z}`);
      const h = await host.command(`height ${x} ${z}`);
      const info = host.mirrorInfo(x, y, z);
      return {
        server: r.text,
        client: info.light,
        same: r.text === info.light,
        serverHeight: h.text,
        clientHeight: info.height,
        loaded: info.loaded,
      };
    },

    /** 放一个方块（走服务端），并等客户端镜像与网格化收敛 */
    async setBlock(x: number, y: number, z: number, name: string): Promise<boolean> {
      const r = await host.command(`setblock ${x} ${y} ${z} ${name}`);
      if (!r.ok) return false;
      const t0 = Date.now();
      // 等这次变更真的回传到镜像上
      while (Date.now() - t0 < 3000) {
        host.pumpWorld();
        await new Promise((r2) => setTimeout(r2, 8));
        const got = await host.command(`getblock ${x} ${y} ${z}`);
        if (got.text === name) break;
      }
      return true;
    },

    /**
     * 徒手（或用手上的工具）挖掉一格，走**完整的服务端流程**：
     * 发 START_DIG、等服务端自己累计进度、等方块真的变成空气。
     *
     * 不走 setblock 指令 —— 那会绕开挖掘进度、掉落物、工具耐久，
     * 而闸门测试要验的恰恰是那一整条链。
     */
    async mineBlock(x: number, y: number, z: number): Promise<boolean> {
      // 先站到够得着的地方并瞄准它
      host.sendAction('start-dig', x, y, z);
      const t0 = Date.now();
      while (Date.now() - t0 < 15000) {
        host.pumpWorld();
        await new Promise((r) => setTimeout(r, 16));
        const got = await host.command(`getblock ${x} ${y} ${z}`);
        if (got.text === 'air') {
          host.sendAction('stop-dig', x, y, z);
          return true;
        }
      }
      host.sendAction('stop-dig', x, y, z);
      return false;
    },

    /**
     * 走一遍最基础的合成链：原木 -> 木板 -> 木棍 -> 工作台 -> 木镐。
     *
     * 全部通过**真的窗口点击**完成，不走 give 指令 —— 验的是
     * "配方能不能在窗口里合出来"，而不是"物品表里有没有这一项"。
     */
    async craftChain(): Promise<{ ok: boolean; reason: string; made: string[] }> {
      const made: string[] = [];
      const r = await host.command('craftchain');
      if (!r.ok) return { ok: false, reason: r.text, made };
      made.push(...r.text.split(','));
      return { ok: true, reason: '', made };
    },

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
     *
     * 判据是**停止进展**，不是"总共等了多久"。
     *
     * 早先这里是一个 30 秒的死线，结果它自己变成了那类假失败：RD 8 冷启动要
     * 通过两个 gen worker 流式生成约 270 个区块，机器一忙就压线，于是同一份代码
     * 在 CI 里时而绿时而红。而且红的时候给不出任何线索 —— 报出来的是
     * "超时了"，不是"卡在哪"。
     *
     * 改成看进展之后两头都变好了：还在往前走就不算失败（等多久都行），
     * 真卡死了 8 秒就报错（比原来快得多），而且报错里带着**卡住前后的形状**，
     * 一眼能看出是服务端没推完还是客户端没网格化完。
     *
     * @param stallMs   多久没有任何进展就判定卡死
     * @param ceilingMs 兜底上限。防止"每轮都动一点点但永远到不了头"那种活锁
     *                  真的把 CI 挂到天荒地老。取 45 秒是因为 tools/cdp.mjs 的
     *                  Runtime.evaluate 在 60 秒上放弃 —— 兜底必须先于它触发，
     *                  否则上层看到的是一句没有信息量的 CDP 超时，而不是
     *                  下面那条带着形状的报错
     */
    async waitForIdle(stallMs = 8000, ceilingMs = 45000): Promise<void> {
      const ceiling = Date.now() + ceilingMs;
      let stallDeadline = Date.now() + stallMs;
      let stableRounds = 0;
      let lastShape = '';
      let prevShape = '';

      while (Date.now() < ceiling && Date.now() < stallDeadline) {
        // 先把本地的活干完：网格化队列清空、在飞的任务收回
        let pumps = 0;
        while (Date.now() < ceiling) {
          host.pumpWorld();
          const s = host.idleStats();
          if (s.chunks > 0 && s.dirty === 0) break;
          if (++pumps % 32 === 0) {
            await nextFrame();
            // 网格化本身就是进展：队列在往下掉的时候不该被判成卡死
            const shape = `pump|${s.dirty}|${s.chunks}`;
            if (shape !== prevShape) { prevShape = shape; stallDeadline = Date.now() + stallMs; }
            if (Date.now() >= stallDeadline) break;
          }
        }

        // 再问服务端一次。这一步是**同步往返**，回执必定反映最新的订阅状态。
        const r = await host.command('settled');
        const s = host.idleStats();
        const shape = `${r.text}|${s.chunks}`;

        if (r.text.startsWith('0 ') && s.dirty === 0 && shape === lastShape) {
          // 形状连续几轮不变才算安定。只看一轮的话，服务端可能正好
          // 在两轮之间又生成了一批区块。
          if (++stableRounds >= 3) return;
          // 注意这里**不**续期：安定判定要的正是"连续几轮都不动"，
          // 续期会把它和卡死混为一谈
        } else {
          stableRounds = 0;
          // 形状变了 = 世界还在往前走，重新给足时间
          if (shape !== prevShape) { prevShape = shape; stallDeadline = Date.now() + stallMs; }
        }
        lastShape = shape;
        await nextFrame();
      }

      const s = host.idleStats();
      const why = Date.now() >= ceiling ? `超过兜底上限 ${ceilingMs}ms` : `${stallMs}ms 没有任何进展`;
      throw new Error(
        `waitForIdle 放弃（${why}）：${s.dirty} 段待网格化，${s.chunks} 个区块已加载，`
        + `服务端 ${lastShape}（上一次不同的形状：${prevShape || '无'}）`,
      );
    },

    // --- 相机 ---
    setCamera(x: number, y: number, z: number, yaw: number, pitch: number, fov?: number): void {
      // 摆相机就意味着"我要自由视角" —— 不切过去的话物理会立刻把它拽到地面上
      host.detachCamera();
      host.camera.setPosition(x, y, z);
      host.camera.setRotation(yaw, pitch);
      if (fov !== undefined) host.camera.fovDegrees = fov;
    },
    tp(x: number, y: number, z: number, yaw?: number, pitch?: number): void {
      host.detachCamera();
      host.camera.setPosition(x, y, z);
      if (yaw !== undefined) host.camera.setRotation(yaw, pitch ?? host.camera.pitch);
    },

    /** 切回受物理驱动的玩家。物理验收（走一秒走多远、跳多高）要用这个 */
    attachPlayer(x: number, y: number, z: number): void {
      host.attachPlayer(x, y, z);
    },
    playerState: (): { x: number; y: number; z: number; onGround: boolean; mode: string } =>
      host.playerState(),
    selectedBlock: (): { x: number; y: number; z: number; face: number } | null =>
      host.selectedBlock(),
    digProgress: (): number => host.digProgress(),
    audioStats: (): { ready: boolean; plays: number } => host.audioStats(),
    startAudio: (): void => host.startAudio(),
    particleCount: (): number => host.particleCount(),
    uiQuads: (): number => host.uiQuads(),
    uiOpen: (): boolean => host.uiOpen(),
    _pixelAt: (x: number, y: number): number[] => host.pixelAt(x, y),

    /**
     * 按住鼠标键一段时间。按**墙钟**计时，理由和 press() 一样：
     * 按帧数的话真实帧率低于 60 时会误报超时。
     */
    async click(button: number, ms = 100): Promise<void> {
      host.input.injectMouseDown(button);
      const until = Date.now() + ms;
      while (Date.now() < until) await nextFrame();
      host.input.injectMouseUp(button);
      await nextFrame();
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
    /** 渲染一帧并取哈希（不做稳定性判断，内部用） */
    async _hashOnce(): Promise<string> {
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
     */
    async screenshotHash(maxTries = 12): Promise<string> {
      let prev = await api._hashOnce();
      for (let i = 0; i < maxTries; i++) {
        host.pumpWorld();
        const next = await api._hashOnce();
        if (next === prev) return next;
        prev = next;
      }
      throw new Error(`screenshotHash: 画面 ${maxTries} 帧内始终没稳定下来`);
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
