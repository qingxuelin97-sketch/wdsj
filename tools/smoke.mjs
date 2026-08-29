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
const CASES = [
  { name: 'overview', camera: [-14, 52, -14, -Math.PI * 0.25, 0.38], size: [640, 360] },
  { name: 'house', camera: [3, 41, -3, -0.55, 0.22], size: [640, 360] },
  { name: 'trees', camera: [-20, 44, 6, -1.35, 0.12], size: [640, 360] },
  { name: 'topdown', camera: [8, 78, 8, 0, 1.45], size: [640, 360] },
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
    const health = await page.evaluate(`
      const m = window.__mc;
      await new Promise(r => setTimeout(r, 600));
      const s = m.stats();
      return { stats: s, errors: m.errors() };
    `);
    log(`fps=${health.stats.fps} quads=${health.stats.quads} draws=${health.stats.drawCalls}`);

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
        const m = window.__mc;
        m.setCanvasSize(${c.size[0]}, ${c.size[1]});
        m.setCamera(${c.camera.join(', ')});
        m.freeze(true);
        await new Promise(r => setTimeout(r, 120));
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

    // --- 三个用例的哈希必须互不相同，否则说明 setCamera 根本没生效 ---
    const uniq = new Set(Object.values(actual));
    if (uniq.size !== CASES.length) {
      failures.push(`${CASES.length} 个视角只产生了 ${uniq.size} 个不同哈希，setCamera 可能未生效`);
    }

    if (UPDATE) {
      fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
      fs.writeFileSync(GOLDEN_PATH, `${JSON.stringify(actual, null, 2)}\n`, 'utf8');
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
