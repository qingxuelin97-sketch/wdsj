/**
 * 极简 Chrome DevTools Protocol 客户端。零依赖。
 *
 * Node 24 自带全局 WebSocket，所以驱动一个真 Chrome 不需要 Puppeteer —— 这正是本项目
 * 能在"不装任何包"的前提下做无头截图回归的原因。
 *
 * 只实现够用的部分：启动/关闭浏览器、开标签页、Runtime.evaluate（支持 await）、
 * 截图、读 console。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 在常见位置里找 chrome.exe */
/**
 * 一条 CDP 命令等多久。
 *
 * 60 秒在有真显卡的机器上绰绰有余，但闸门①把"等世界安定 + 打木头 + 合成 +
 * 搭掩体"塞在**同一个** evaluate 里，软件渲染下（4fps）这一条就要一两分钟。
 * 超时的表现是"CDP Runtime.evaluate 超时"，看着像页面挂了，
 * 实际上它跑得好好的，只是慢。所以给它一个环境变量：
 *
 *   CDP_TIMEOUT_MS=300000 node tools/first-night-check.mjs
 */
export const CDP_TIMEOUT_MS = Number(process.env['CDP_TIMEOUT_MS'] ?? 60000);

export function findChrome() {
  const candidates = [
    process.env['CHROME_PATH'],
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`Chrome 调试端口 ${port} 在 ${timeoutMs}ms 内没有就绪`);
}

/**
 * 启动一个无头 Chrome。
 *
 * 用独立的临时 user-data-dir，避免碰用户的真实浏览器配置；
 * 退出时删掉。
 */
export async function launchChrome({ port = 9333, headless = true, timeoutMs = 20000 } = {}) {
  const exe = findChrome();
  if (exe === null) throw new Error('找不到 chrome.exe，可用环境变量 CHROME_PATH 指定');

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-smoke-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--window-size=1280,720',
    // WebGL 相关：优先真 GPU，不行退回 SwiftShader，否则无头下拿不到 WebGL2
    '--use-angle=d3d11',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new');

  // shell:false —— 项目路径含中文，绝不能经 cmd.exe 转发
  const proc = spawn(exe, args, { shell: false, stdio: 'ignore', detached: false });
  let version;
  try {
    version = await waitForPort(port, timeoutMs);
  } catch (err) {
    proc.kill();
    throw err;
  }

  return {
    proc,
    port,
    version,
    async close() {
      try {
        proc.kill();
      } catch {
        // 已经退出
      }
      // 给它一点时间释放文件句柄，然后清理临时 profile
      await new Promise((r) => setTimeout(r, 300));
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        // Windows 上偶尔还占着，留给系统临时目录清理
      }
    },
  };
}

/** 一个 CDP 会话（对应一个标签页） */
export class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.consoleMessages = [];
    this.exceptions = [];
    /** method -> resolve[]，供 waitForEvent 使用 */
    this.eventWaiters = new Map();

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p !== undefined) {
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
          else p.resolve(msg.result);
        }
        return;
      }
      const waiters = this.eventWaiters.get(msg.method);
      if (waiters !== undefined && waiters.length > 0) {
        this.eventWaiters.set(msg.method, []);
        for (const w of waiters) w(msg.params);
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args ?? [])
          .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? a.type)))
          .join(' ');
        this.consoleMessages.push({ level: msg.params.type, text });
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.exceptions.push(d.exception?.description ?? d.text ?? 'unknown exception');
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP ${method} 超时（${CDP_TIMEOUT_MS}ms）`));
        }
      }, CDP_TIMEOUT_MS);
    });
  }

  /** 等一个 CDP 事件 */
  waitForEvent(method, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const list = this.eventWaiters.get(method) ?? [];
      const timer = setTimeout(() => reject(new Error(`等待事件 ${method} 超时`)), timeoutMs);
      list.push((params) => {
        clearTimeout(timer);
        resolve(params);
      });
      this.eventWaiters.set(method, list);
    });
  }

  /**
   * 在页面里求值。表达式可以用顶层 await。
   * 返回值会被 JSON 序列化后带回来。
   *
   * 导航刚发生时执行上下文可能还没建立，CDP 会回 "Cannot find default execution context"。
   * 这不是页面的错，是竞态，所以这里对该错误做有限重试。
   */
  async evaluate(expression, { retries = 20, retryDelayMs = 150 } = {}) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await this.send('Runtime.evaluate', {
          expression: `(async () => { ${expression} })()`,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
        });
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        if (attempt < retries && /execution context/i.test(msg)) {
          await new Promise((r) => setTimeout(r, retryDelayMs));
          continue;
        }
        throw err;
      }
      if (res.exceptionDetails) {
        const d = res.exceptionDetails;
        throw new Error(`页面求值抛出异常: ${d.exception?.description ?? d.text}`);
      }
      return res.result?.value;
    }
  }

  /** 截图并写盘，返回文件路径 */
  async screenshot(filePath) {
    const res = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(res.data, 'base64'));
    return filePath;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // 已经关了
    }
  }
}

/**
 * 打开标签页并建立 CDP 会话。
 *
 * 顺序很重要：先开 about:blank 建好会话并 enable 域，再 Page.navigate 并等 load 事件。
 * 如果直接用 /json/new?<url> 开目标页，连上 WebSocket 时页面可能正在导航，
 * 执行上下文还没建立，第一个 Runtime.evaluate 就会报 "Cannot find default execution context"。
 */
export async function openPage(port, url) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  if (!res.ok) throw new Error(`创建标签页失败: ${res.status} ${await res.text()}`);
  const target = await res.json();

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
  });

  const session = new CdpSession(ws);
  await session.send('Runtime.enable');
  await session.send('Page.enable');

  const loaded = session.waitForEvent('Page.loadEventFired', 30000);
  await session.send('Page.navigate', { url });
  await loaded;
  // load 事件之后 module script 可能仍在执行，调用方还要自己等 __mc 挂载
  return session;
}
