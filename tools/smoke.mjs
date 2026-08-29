/**
 * 无头冒烟测试：拉起真 Chrome，加载游戏，驱动 __mc 做断言，存截图。
 *
 * 这是长跑期间"代码写了 ≠ 做完了"的主要防线：每次提交前跑一遍，确认页面真的能渲染、
 * 没有未捕获异常、截图哈希与黄金值一致。
 *
 * 用法:
 *   node tools/smoke.mjs                 跑断言，与黄金哈希比对
 *   UPDATE_GOLDEN=1 node tools/smoke.mjs 重新生成黄金哈希
 *   node tools/smoke.mjs --head          有头模式，方便肉眼看
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchChrome, openPage } from './cdp.mjs';
import { runSceneChecks } from './smoke-checks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8099; // 与开发用的 8080 错开，避免和正在跑的 dev-server 抢端口
const GOLDEN_PATH = path.join(ROOT, 'tests/screenshots/hashes.json');
const OUT_DIR = path.join(ROOT, 'tests/out');
const UPDATE = process.env['UPDATE_GOLDEN'] === '1';
const HEADLESS = !process.argv.includes('--head');

/**
 * 每个用例：固定种子 + 固定相机 + 固定画布，保证可复现。
 * 覆盖面要分散：远景看整体地形与雾，近景看方块贴图与 AO，
 * 树冠看 cutout 透明与群系染色，俯视看地形轮廓。
 */
/**
 * 相机位置写成**相对出生点**的偏移。世界由种子生成，出生点会随生成器调整而变，
 * 写死绝对坐标的话每次调参都要重录一遍黄金值，而且很容易录到"相机埋在山里"的画面。
 */
/**
 * 每个用例都**必须**钉死时间。
 *
 * 不钉的话，画面里的天色与光照取决于"截图那一刻世界跑到了第几 tick"，
 * 而那取决于加载花了多久 —— 机器快慢、这一版加载优化没优化，都会改变它。
 * 表现是一整批哈希毫无道理地集体变化，看上去像渲染坏了。
 * 实际排查过程：世界数据逐格相同、mesher 顶点字节 1007 段全等、
 * 绘制顺序也有确定的次级键，最后才发现变的是 timeOfDay。
 */
const DEFAULT_TIME = 6000; // 正午
const CASES = [
  { name: 'overview', offset: [0, 34, -40], look: [0, 0.42], fov: 72, size: [640, 360] },
  { name: 'ground', offset: [0, 2, -8], look: [0, 0.08], fov: 70, size: [640, 360] },
  { name: 'skyline', offset: [-30, 18, -30], look: [-0.78, 0.20], fov: 70, size: [640, 360] },
  { name: 'topdown', offset: [0, 70, 0], look: [0, 1.45], fov: 70, size: [640, 360] },
  // 昼夜四相：同一个机位，只有时间不同。
  // 0 清晨 / 6000 正午 / 13000 日落后 / 18000 午夜。
  // 四张哈希必须互不相同 —— 相同就说明昼夜根本没接上渲染。
  { name: 'day-0000', offset: [0, 18, -34], look: [0, 0.30], fov: 72, size: [640, 360], time: 0 },
  { name: 'day-6000', offset: [0, 18, -34], look: [0, 0.30], fov: 72, size: [640, 360], time: 6000 },
  { name: 'day-13000', offset: [0, 18, -34], look: [0, 0.30], fov: 72, size: [640, 360], time: 13000 },
  { name: 'day-18000', offset: [0, 18, -34], look: [0, 0.30], fov: 72, size: [640, 360], time: 18000 },
];

function log(msg) {
  console.log(`[smoke] ${msg}`);
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function main() {
  let serverProc = null;
  let chrome = null;
  let page = null;
  const failures = [];

  try {
    // --- 起一个自己的 dev-server，不依赖外部状态 ---
    log(`启动 dev-server :${PORT}`);
    serverProc = spawn(process.execPath, [path.join(ROOT, 'tools/dev-server.mjs'), '--port', String(PORT)], {
      cwd: ROOT,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    const serverLogs = [];
    serverProc.stdout.on('data', (d) => serverLogs.push(String(d)));
    serverProc.stderr.on('data', (d) => serverLogs.push(String(d)));

    if (!(await waitForServer(`http://127.0.0.1:${PORT}/`, 10000))) {
      throw new Error(`dev-server 未能启动:\n${serverLogs.join('')}`);
    }

    log(`启动 Chrome (headless=${HEADLESS})`);
    chrome = await launchChrome({ port: 9333, headless: HEADLESS });
    log(`Chrome ${chrome.version['Browser']}`);

    page = await openPage(9333, `http://127.0.0.1:${PORT}/?test=smoke&seed=1234&radius=2`);

    // --- 等游戏就绪 ---
    const boot = await page.evaluate(`
      const t0 = Date.now();
      while (!window.__mc) {
        if (Date.now() - t0 > 15000) throw new Error('__mc 15 秒内未挂载');
        await new Promise(r => setTimeout(r, 50));
      }
      await window.__mc.ready;
      return { version: window.__mc.version, logs: window.__mc.logs() };
    `);
    log(`__mc ${boot.version} 就绪`);
    for (const l of boot.logs) log(`  page: ${l}`);

    // --- 基本健康检查 ---
    // 每段脚本都自行确认 __mc 就绪：CDP 的多次 evaluate 之间页面可能已经变了，
    // 依赖"上一次确认过"是不成立的
    const ensureHook = `
      const t0 = Date.now();
      while (!window.__mc) {
        if (Date.now() - t0 > 15000) throw new Error('__mc 未挂载');
        await new Promise(r => setTimeout(r, 50));
      }
      await window.__mc.ready;
    `;

    const health = await page.evaluate(`
      ${ensureHook}
      const m = window.__mc;
      // 等世界流式加载与网格化收敛。用 waitForIdle 而不是固定 sleep：
      // 固定 sleep 在快机器上够、慢机器上不够，会造成时而通过时而失败的假失败。
      await m.waitForIdle();
      const s = m.stats();
      return { stats: s, errors: m.errors() };
    `);
    log(`fps=${health.stats.fps} quads=${health.stats.quads} draws=${health.stats.drawCalls}`);
    const spawnPos = { x: health.stats.cameraX, y: health.stats.cameraY, z: health.stats.cameraZ };
    log(`出生点 ${spawnPos.x.toFixed(1)} ${spawnPos.y.toFixed(1)} ${spawnPos.z.toFixed(1)}`);

    if (health.errors.length > 0) {
      failures.push(`页面报告了 ${health.errors.length} 条错误: ${health.errors.join(' | ')}`);
    }
    if (health.stats.quads <= 0) {
      failures.push(`没有生成任何几何（quads=${health.stats.quads}），场景是空的`);
    }
    if (page.exceptions.length > 0) {
      failures.push(`未捕获异常: ${page.exceptions.join(' | ')}`);
    }

    // --- 截图哈希回归 ---
    const golden = fs.existsSync(GOLDEN_PATH) ? JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) : {};
    const actual = {};
    fs.mkdirSync(OUT_DIR, { recursive: true });

    for (const c of CASES) {
      // 一次求值里同时拿哈希和图，保证存下来的 PNG 就是被哈希的那一张画面。
      // 不用 CDP 的 Page.captureScreenshot：它截的是整个视口（含 HUD 的 DOM 和
      // canvas 之外的黑边），与 screenshotHash 取的 canvas 内容对不上，
      // 回归失败时看到的图就不是真正比对的图。
      const shot = await page.evaluate(`
        ${ensureHook}
        const m = window.__mc;
        m.setCanvasSize(${c.size[0]}, ${c.size[1]});
        await m.setTime(${c.time ?? DEFAULT_TIME});
        m.setCamera(
          ${spawnPos.x} + ${c.offset[0]}, ${spawnPos.y} + ${c.offset[1]}, ${spawnPos.z} + ${c.offset[2]},
          ${c.look[0]}, ${c.look[1]}, ${c.fov}
        );
        // 移动后必须等新视野里的段全部补齐，否则截到的是半成品
        m.freeze(false);
        await m.waitForIdle();
        m.freeze(true);
        await new Promise(r => setTimeout(r, 60));
        const hash = await m.screenshotHash();
        const png = await m.screenshot();
        m.freeze(false);
        return { hash, png };
      `);
      const hash = shot.hash;
      actual[c.name] = hash;
      fs.writeFileSync(
        path.join(OUT_DIR, `${c.name}.png`),
        Buffer.from(String(shot.png).replace(/^data:image\/png;base64,/, ''), 'base64'),
      );

      if (UPDATE) {
        log(`${c.name}: ${hash} (已记录)`);
      } else if (golden[c.name] === undefined) {
        log(`${c.name}: ${hash} (无黄金值，跳过比对 —— 用 UPDATE_GOLDEN=1 生成)`);
      } else if (golden[c.name] !== hash) {
        failures.push(`${c.name} 截图哈希不匹配: 期望 ${golden[c.name]}，实得 ${hash}（看 tests/out/${c.name}.png）`);
      } else {
        log(`${c.name}: ${hash} ok`);
      }
    }

    // --- 各用例的哈希必须互不相同，否则说明 setCamera / setTime 根本没生效 ---
    const uniq = new Set(CASES.map((c) => actual[c.name]));
    if (uniq.size !== CASES.length) {
      failures.push(`${CASES.length} 个用例只产生了 ${uniq.size} 个不同哈希，setCamera/setTime 可能未生效`);
    }
    const dayHashes = CASES.filter((c) => c.time !== undefined).map((c) => actual[c.name]);
    if (new Set(dayHashes).size !== dayHashes.length) {
      failures.push(`昼夜四相有重复哈希 ${dayHashes.join(' ')} —— 时间没有驱动渲染`);
    }

    // 场景检查搬到了 smoke-checks.mjs —— 这个文件顶到了 600 行硬上限。
    // 那条规则的用处正在这种时候：它逼着人把长出来的东西搬走。
    await runSceneChecks({
      page, ensureHook, spawnPos, log, failures, actual, golden,
      saveShot: (name, dataUrl) => fs.writeFileSync(
        path.join(OUT_DIR, `${name}.png`),
        Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ''), 'base64'),
      ),
      update: UPDATE,
    });

    if (UPDATE) {
      fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
      fs.writeFileSync(GOLDEN_PATH, `${JSON.stringify(actual, null, 2)}
`, 'utf8');
      log(`黄金哈希已写入 ${path.relative(ROOT, GOLDEN_PATH)}`);
    }

  } catch (err) {
    failures.push(String(err && err.stack ? err.stack : err));
  } finally {
    if (page !== null) page.close();
    if (chrome !== null) await chrome.close();
    if (serverProc !== null) serverProc.kill();
  }

  if (failures.length > 0) {
    console.error(`\n[smoke] 失败 ${failures.length} 项:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  log('全部通过');
  process.exit(0);
}

void main();
