/**
 * 后台标签页的 TPS 验收。
 *
 * 内置服务端必须在标签页切到后台时照常跑。浏览器会把后台页面的定时器掐死 ——
 * 实测改造前前台 20.0 TPS、后台 **0**（30 秒里一个 tick 都没有）。
 * 那意味着切出去泡杯茶回来，作物没长、熔炉没烧、怪没动。
 *
 * 解法见 src/entry/clock-worker.ts：单开一条线程睡在 Atomics.wait 上敲拍子。
 *
 * 读数走**共享统计槽**而不是指令往返。这一点很关键：节流会同时掐死问和答，
 * 用消息去问状态只能得到一个超时，分不清是服务端停了还是客户端没在听。
 * 读共享槽是一条内存指令，不需要对方的事件循环转起来。
 *
 * 用法：
 *   node tools/bg-tps.mjs           默认观测 60 秒
 *   node tools/bg-tps.mjs 10        观测 10 秒（CI 用，够抓住彻底停摆）
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchChrome, openPage } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8096;
const WINDOW_MS = Number(process.argv[2] ?? 60) * 1000;
/** 20 TPS 的下限。留一点余量给采样边界，但不能松到放过"掉一半"这种回退 */
const MIN_TPS = 19;

function log(msg) {
  console.log(`[bg-tps] ${msg}`);
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const READ = `
  while (!window.__mc) await new Promise(r => setTimeout(r, 50));
  await window.__mc.ready;
  return JSON.stringify(window.__mc.sharedStats());
`;

async function main() {
  const failures = [];
  let devServer = null;
  let chrome = null;
  let game = null;
  let other = null;

  try {
    devServer = spawn(process.execPath, [path.join(ROOT, 'tools/dev-server.mjs'), '--port', String(PORT)], {
      stdio: 'ignore',
    });
    if (!(await waitForServer(`http://127.0.0.1:${PORT}/`, 10000))) {
      throw new Error('dev-server 没起来');
    }
    chrome = await launchChrome({ headless: true });
    game = await openPage(chrome.port, `http://127.0.0.1:${PORT}/?test=smoke&seed=1234&radius=2`);

    const read = async () => JSON.parse(String(await game.evaluate(READ)));

    await game.evaluate(`
      while (!window.__mc) await new Promise(r => setTimeout(r, 50));
      await window.__mc.ready;
      await window.__mc.waitForIdle();
      return 1;
    `);

    const probe = await read();
    if (probe === null) {
      failures.push('没有共享统计槽 —— 说明没有跨源隔离，服务端回落到了 setTimeout 心跳');
      throw new Error('无 SharedArrayBuffer');
    }

    // 前台基准
    let a = await read();
    let t0 = Date.now();
    await new Promise((r) => setTimeout(r, 5000));
    let b = await read();
    const fgTps = (b.serverTicks - a.serverTicks) / ((Date.now() - t0) / 1000);
    log(`前台 ${fgTps.toFixed(2)} TPS`);
    if (fgTps < MIN_TPS) failures.push(`前台就没到 20 TPS（${fgTps.toFixed(2)}）`);

    // 再开一个标签页并置于最前，把游戏页压到后台
    other = await openPage(chrome.port, 'about:blank');
    await other.send('Page.bringToFront', {});
    log(`游戏页转入后台，观测 ${WINDOW_MS / 1000} 秒 ...`);

    a = await read();
    t0 = Date.now();
    await new Promise((r) => setTimeout(r, WINDOW_MS));
    b = await read();
    const secs = (Date.now() - t0) / 1000;
    const beatRate = (b.beats - a.beats) / secs;
    const tps = (b.serverTicks - a.serverTicks) / secs;
    log(`后台 ${tps.toFixed(2)} TPS（心跳 ${beatRate.toFixed(2)}/s，观测 ${secs.toFixed(1)} 秒）`);
    log(`     tick ${a.serverTicks} -> ${b.serverTicks}`);

    if (beatRate < MIN_TPS) {
      failures.push(`心跳线程本身被挂起了：${beatRate.toFixed(2)}/s —— Atomics.wait 也没能顶住`);
    } else if (tps < MIN_TPS) {
      failures.push(`心跳在跳但服务端没跟上：${tps.toFixed(2)} TPS —— 卡在消息投递`);
    }
  } catch (err) {
    failures.push(String(err && err.stack ? err.stack : err));
  } finally {
    if (other !== null) other.close();
    if (game !== null) game.close();
    if (chrome !== null) await chrome.close();
    if (devServer !== null) devServer.kill();
  }

  if (failures.length > 0) {
    console.log(`\n[bg-tps] 失败 ${failures.length} 项:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  log('通过：后台标签页的 TPS 没有掉');
}

await main();
