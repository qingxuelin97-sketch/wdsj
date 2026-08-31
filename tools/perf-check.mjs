/**
 * 性能验收：视距 12 下的帧率、服务端每刻耗时、以及内存是否平坦。
 *
 * ## 三个数各自说明什么
 *
 *   fps      客户端能不能跑得动。它同时受网格化、绘制批次、着色器复杂度影响，
 *            是唯一一个玩家直接感知的数。
 *   tickMs   服务端每刻花多久。**超过 50ms 就意味着世界跑不满 20 TPS**，
 *            那时候一切都会变慢，而画面上看不出任何异常。
 *   堆增长   跑十分钟内存是不是平的。不平就是泄漏，而泄漏的症状
 *            （几十分钟后开始卡）在任何短测里都看不到。
 *
 * ## 这个数在什么机器上量才算数
 *
 * **必须在真显卡上量。** CI 容器用的是 SwiftShader（纯 CPU 软件渲染），
 * 实测视距 2 就只有 4fps —— 那不是这份代码的性能，是没有 GPU 的性能。
 * 本工具在容器里跑出来的数只能用于**回归比对**（同一台机器前后对比），
 * 不能拿去对验收线。
 *
 * 用法：node tools/perf-check.mjs [--rd 12] [--minutes 1]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, openPage } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d;
};
const RD = Number(arg('rd', 12));
const MINUTES = Number(arg('minutes', 1));
const PORT = 8130;

/** 验收线。来自 docs/ROADMAP.md 的 M17 */
const TARGET_FPS = 60;
const TARGET_TICK_MS = 25;
/** 堆增长超过这个比例算不平坦 */
const HEAP_GROWTH_LIMIT = 1.35;

const failures = [];
const notes = [];
const log = (m) => console.log(`[perf] ${m}`);

const srv = spawn(process.execPath, [path.join(ROOT, 'tools/dev-server.mjs'), '--port', String(PORT)], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_NO_WARNINGS: '1' },
});
srv.stderr.on('data', (d) => process.stderr.write(`[dev!] ${d}`));
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch { /* 还没起来 */ }
  await new Promise((r) => setTimeout(r, 100));
}

const chrome = await launchChrome({ port: 9354, headless: true });
let page = null;
try {
  page = await openPage(9354, `http://127.0.0.1:${PORT}/?seed=1234&radius=${RD}&particles=1&cmdTimeout=60000`);
  const boot = await page.evaluate(`
    const t0 = Date.now();
    while (!window.__mc) { if (Date.now() - t0 > 90000) return { ok: false }; await new Promise(r => setTimeout(r, 50)); }
    await window.__mc.ready;
    return { ok: true, bootMs: Date.now() - t0, gpu: window.__mc.logs().find(l => l.includes('GPU')) ?? '' };
  `);
  if (!boot.ok) throw new Error('客户端没起来');
  log(`就绪用了 ${(boot.bootMs / 1000).toFixed(1)}s｜${boot.gpu}`);

  // 先把世界推到安定：加载期的帧率不代表稳态。
  //
  // 等不到也照样往下走 —— 软件渲染下网格化跟不上，世界可能一直
  // 安定不了，但那时候量到的"边加载边跑"的帧率反而更接近真实游玩。
  // 把它记成一条注，别当成失败：这个工具是来量性能的，不是来验收敛的
  const settled = await page.evaluate(`
    try { await window.__mc.waitForIdle(); return true; } catch (e) { return false; }
  `);
  if (settled) log('世界已安定，开始采样');
  else {
    notes.push('世界没能在 45 秒内安定（软件渲染下网格化跟不上），采样期仍在加载');
    log('世界没安定，照样采样（见末尾的注）');
  }

  const samples = [];
  const totalMs = MINUTES * 60_000;
  const step = Math.max(2000, Math.min(15_000, Math.round(totalMs / 20)));
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    const s = await page.evaluate(`
      // 页面可能在采样期间崩掉（软件渲染 + 内存受限的容器上跑十分钟
      // 确实会）。**这本身就是一条要报出来的结果**，所以不能让它
      // 变成一个看不懂的 "Cannot read properties of undefined"
      if (!window.__mc) return { dead: true };
      // 走一小段路，静止不动量出来的帧率没有意义 —— 网格化与区块流送
      // 是最大的开销，而站着不动这两样都不发生
      await window.__mc.press('KeyW', ${Math.min(step - 500, 3000)});
      const st = window.__mc.stats();
      const sh = window.__mc.sharedStats();
      return {
        fps: st.fps, frameMs: st.frameMs, heapMB: st.jsHeapMB,
        quads: st.quads, draws: st.drawCalls,
        tickCentiMs: sh === null ? -1 : sh.tickCentiMs,
      };
    `);
    if (s.dead === true) {
      failures.push(`页面在第 ${Math.round((totalMs - (deadline - Date.now())) / 1000)} 秒崩溃或重载了`
        + `（已采到 ${samples.length} 个样本）`);
      break;
    }
    samples.push(s);
    await new Promise((r) => setTimeout(r, 500));
  }

  if (samples.length === 0) throw new Error('一个样本都没采到');
  const med = (xs) => {
    const a = [...xs].sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)] ?? 0;
  };
  const fps = med(samples.map((s) => s.fps));
  const tickMs = med(samples.filter((s) => s.tickCentiMs >= 0).map((s) => s.tickCentiMs / 100));
  const heap0 = med(samples.slice(0, Math.max(1, Math.floor(samples.length / 4))).map((s) => s.heapMB));
  const heap1 = med(samples.slice(-Math.max(1, Math.floor(samples.length / 4))).map((s) => s.heapMB));
  const growth = heap0 > 0 ? heap1 / heap0 : 1;

  log(`视距 ${RD}：fps 中位 ${fps.toFixed(1)}（线 ${TARGET_FPS}）`);
  log(`服务端每刻 ${tickMs < 0 ? '（没有 SAB，量不到）' : tickMs.toFixed(2) + 'ms'}（线 ${TARGET_TICK_MS}ms）`);
  log(`堆：起 ${heap0.toFixed(1)}MB -> 末 ${heap1.toFixed(1)}MB（×${growth.toFixed(2)}，线 ×${HEAP_GROWTH_LIMIT}）`);
  log(`绘制：${med(samples.map((s) => s.draws))} 次 / ${med(samples.map((s) => s.quads))} 个面`);

  // 软件渲染下帧率不作数：那量的是没有 GPU 的性能，不是这份代码的性能
  const software = (boot.gpu ?? '').includes('SwiftShader') || (boot.gpu ?? '').includes('llvmpipe');
  if (software) {
    notes.push(`跑在软件渲染上（${boot.gpu}），帧率不计入验收 —— 要在真显卡上重测`);
  } else if (fps < TARGET_FPS) {
    failures.push(`视距 ${RD} 只有 ${fps.toFixed(1)}fps，线是 ${TARGET_FPS}`);
  }
  if (tickMs >= 0 && tickMs > TARGET_TICK_MS && !software) {
    failures.push(`服务端每刻 ${tickMs.toFixed(2)}ms，线是 ${TARGET_TICK_MS}ms`);
  }
  if (growth > HEAP_GROWTH_LIMIT) {
    failures.push(`堆涨了 ${((growth - 1) * 100).toFixed(0)}%（${heap0.toFixed(1)} -> ${heap1.toFixed(1)}MB）—— 可能有泄漏`);
  }
} catch (e) {
  failures.push(`异常：${String(e.message).split('\n')[0]}`);
}

if (page !== null) {
  for (const ex of page.exceptions.slice(0, 3)) console.log('页面异常:', ex.split('\n')[0]);
}
await chrome.close();
srv.kill();

for (const n of notes) console.log(`[perf] 注：${n}`);
if (failures.length > 0) {
  console.log(`\n[perf] 失败 ${failures.length} 项:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\n[perf] 全部通过');
process.exit(0);
