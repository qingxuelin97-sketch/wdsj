/**
 * 一局游戏的"连接"那一面：起服务端、发指令、以及**服务端权威的世界状态**。
 *
 * 从 client-main.ts 里分出来的（那个文件第四次顶到 600 行硬上限）。
 * 挑这一块是因为它的闭包足迹最小 —— 只要 URL 参数和两个日志回调，
 * 不碰 GL、不碰输入、不碰渲染。剩下的部分（包处理、测试钩子、主循环）
 * 各自闭包着二三十个局部变量，硬拆出去只会换来一个没有类型的 deps 大袋子，
 * 那比长文件更糟。
 *
 * 这里的每一个字段都有同一条纪律：**它们是服务端说了算的，客户端只读**。
 * 时间、天气都不许在这一侧推进 —— 自己推进的话，客户端会和服务端慢慢分叉，
 * 而症状是"天黑的时刻不对"这种没人查得动的问题。
 */
import { startServerHost, connectRemoteServer, type SaveResult } from './server-host.ts';
import { C_Command } from '../core/net/packets.ts';
import type { PacketChannel } from '../core/net/transport.ts';

export interface SessionOptions {
  readonly seed: number;
  readonly params: URLSearchParams;
  recordError(msg: string): void;
  recordLog(msg: string): void;
}

export interface ServerStats {
  tick: number;
  pendingChunks: number;
  loadedChunks: number;
  tickMs: number;
}

/** 服务端权威的天气，0..1 */
export interface WeatherState {
  rain: number;
  thunder: number;
}

export class ClientSession {
  readonly net: PacketChannel;
  /** 指令回执的超时上限，见 command() 的注释。`?cmdTimeout=` 可调 */
  private readonly commandTimeoutMs: number;
  private readonly host: ReturnType<typeof startServerHost>;

  /** 服务端权威的当日时间，0..23999。渲染只读它，绝不自己推进 */
  timeOfDay = 0;
  /** 服务端权威的世界年龄。月相按天走，要用它而不是当日时间 */
  worldAge = 0;
  /** 服务端最近一次上报的状态。主线程读不到 worker 内部，只能靠它 */
  readonly stats: ServerStats = { tick: 0, pendingChunks: 0, loadedChunks: 0, tickMs: 0 };
  readonly weather: WeatherState = { rain: 0, thunder: 0 };
  /** 玩家的登录包到了没有 */
  spawned = false;
  /** 连的是独立服务端（多人）还是内置 worker（单人） */
  readonly multiplayer: boolean;
  /**
   * 玩家在哪个维度：-1 下界 / 0 主世界 / 1 末地。
   *
   * 渲染只读它，绝不自己改 —— 与 timeOfDay 同理，维度是服务端权威的。
   * 客户端自己切的话，会出现"画着下界的天，脚下是主世界的地"。
   */
  dimension = 0;

  /** 未回执的指令，按 requestId 索引 */
  private readonly commandWaiters = new Map<number, (r: { ok: boolean; text: string }) => void>();
  private nextCommandId = 1;

  constructor(o: SessionOptions) {
    const { params } = o;
    this.commandTimeoutMs = Number(params.get('cmdTimeout') ?? 8000);
    // `?server=ws://…` 连独立多人服务端；不给就在 worker 里起一个内置的。
    //
    // 客户端这边的差别到此为止 —— 下面所有代码拿到的都是同一个
    // ServerHost 接口。这正是 Transport 那层抽象的回报
    const remote = params.get('server');
    this.host = remote !== null && remote !== ''
      ? connectRemoteServer(remote)
      : startServerHost({
      seed: o.seed,
      // 截图回归必须关掉存档：存了的话"同一个种子跑两次"会得到不同的世界 ——
      // 第二次读的是第一次留下的状态，包括玩家走过的位置与挖掉的方块
      persist: params.get('persist') !== '0',
      // 同理：野生的怪会走进画面，让同一个机位每次截出来都不一样
      spawnMobs: params.get('mobs') !== '0',
      // 随机刻也一样，而且更隐蔽：草会蔓延、树苗会长大，两百个区块里
      // 总有东西在变，客户端的网格化队列因此永远清不空。
      // 天气也挂在这个开关下 —— 一场雨会点着树、铺上雪，那是真正的世界变更
      randomTicks: params.get('randomTicks') !== '0',
      recordError: o.recordError,
      recordLog: o.recordLog,
    });
    this.multiplayer = remote !== null && remote !== '';
    this.net = this.host.net;

    /** 页面关闭时叫停心跳线程 —— 它睡在 futex 上，不主动叫醒就会一直跑 */
    self.addEventListener('pagehide', () => {
      this.host.shutdown();
    });

    /**
     * 关页面前存一次盘。
     *
     * 用 visibilitychange 而不是 beforeunload：手机浏览器与某些桌面场景根本
     * 不触发 beforeunload，而 visibilitychange 是唯一可靠的"页面要没了"信号。
     * 存盘本身是异步的、可能来不及跑完 —— 所以它只是自动存盘之外的一层保险，
     * 真正的保障是每 30 秒一次的自动存盘。
     */
    self.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && this.host.persist) void this.host.requestSave();
    });
  }

  get persist(): boolean {
    return this.host.persist;
  }

  requestSave(mode?: 'save' | 'wipe'): Promise<SaveResult> {
    return this.host.requestSave(mode);
  }

  /**
   * 服务端 worker 通过 SharedArrayBuffer 上报的心跳统计。
   * 后台标签页的 TPS 检查靠它 —— 那时包还在发但主线程的 rAF 早停了
   */
  sharedStats(): { beats: number; serverTicks: number; tickCentiMs: number } | null {
    return this.host.sharedStats();
  }

  /**
   * 发一条指令给服务端，等回执。超时会 reject，避免测试永远挂着。
   *
   * 超时值可以用 `?cmdTimeout=30000` 调大。默认 8 秒在真 GPU 上绰绰有余，
   * 但在**软件渲染**（SwiftShader、无 GPU 的 CI 容器）上帧时间能到 160 ms，
   * 而回执要等主循环泵一次包队列 —— 大批量 fillbox 之后连着发十来条
   * getblock，就会一条条撞上这个上限。
   *
   * 表现是 `指令超时: getblock ...`，看着像服务端挂了，实际只是慢。
   * 这类"环境慢导致的假失败"在本项目里已经出现过好几次
   * （裂纹采样、生物截图），每次都花时间查过才发现不是代码的问题。
   */
  command(text: string): Promise<{ ok: boolean; text: string }> {
    const requestId = this.nextCommandId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.commandWaiters.delete(requestId);
        reject(new Error(`指令超时: ${text}（上限 ${this.commandTimeoutMs}ms，`
          + '慢机器可用 ?cmdTimeout=30000 调大）'));
      }, this.commandTimeoutMs);
      this.commandWaiters.set(requestId, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.net.send(C_Command, { requestId, text });
      // **立刻 flush**，不等下一帧。
      //
      // 原来靠主循环的 sendPlayerPosition 顺带 flush，那有两个问题：
      // 一是白搭上一帧的延迟（多人的往返预算只有 100ms，而一帧
      // 在慢机器上就有 250ms）；二是主循环有若干条提前返回的分支
      // （开着菜单、死亡界面、还没 spawn），走到那些分支时指令
      // 会一直躺在出缓冲里，表现是"指令超时"而服务端根本没收到。
      this.net.flush();
    });
  }

  /** 指令回执到了。由包处理那边调 */
  onCommandResult(requestId: number, ok: boolean, text: string): void {
    const pending = this.commandWaiters.get(requestId);
    if (pending === undefined) return;
    this.commandWaiters.delete(requestId);
    pending({ ok, text });
  }
}
