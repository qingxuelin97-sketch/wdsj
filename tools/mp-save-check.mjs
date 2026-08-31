/**
 * 独立服务端的存档验收：**关服再开服，世界还在吗。**
 *
 * 与 tests/server/persistence.test.ts 的分工：
 *   那边验的是存档逻辑本身（内存后端、同一个进程里换一个 ServerCore）；
 *   这里验的是 tools/mp-server.mjs 这条路真的接对了 —— 真文件系统、
 *   真进程退出、真重启、真 WebSocket 客户端。
 *
 * 两个维度都验：主世界与下界用**同一个区块坐标**，这是最容易出的那个
 * bug —— region 的键里不带维度的话，两边会写到同一个文件上。
 *
 * 用法：node tools/mp-save-check.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, openPage } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8126;
const CDP_PORT = 9353;
const failures = [];
const log = (m) => console.log(`[mp-save] ${m}`);

const SAVE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mpsave-'));

/** 起一个服务端，等它能应答 HTTP */
async function startServer() {
  const proc = spawn(
    process.execPath,
    [path.join(ROOT, 'tools/mp-server.mjs'), '--port', String(PORT), '--seed', '31337', '--save', SAVE_DIR],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_NO_WARNINGS: '1' } },
  );
  proc.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[server!] ${d}`));
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) return proc; } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('服务端没起来');
}

/**
 * 送 SIGINT 并等进程真的退出。
 *
 * 一定要等 —— 存盘是在退出钩子里做的，不等的话下一个服务端会在
 * 文件写到一半时打开同一个目录，读出来的东西是坏的
 */
function stopServer(proc) {
  return new Promise((resolve) => {
    proc.once('exit', resolve);
    proc.kill('SIGINT');
    setTimeout(() => { proc.kill('SIGKILL'); }, 20000);
  });
}

const READY = `
  const t0 = Date.now();
  while (!window.__mc) { if (Date.now() - t0 > 60000) return { ok: false, why: '__mc 没挂载' }; await new Promise(r => setTimeout(r, 50)); }
  let done = false;
  window.__mc.ready.then(() => { done = true; });
  while (!done && Date.now() - t0 < 60000) await new Promise(r => setTimeout(r, 100));
  if (done) window.__mc.setCanvasSize(160, 120);
  return { ok: done, why: done ? '' : 'ready 一直没兑现', errors: window.__mc.errors().slice(-4) };
`;

/** 开一个连到独立服务端的标签页 */
async function openClient(chromePort) {
  const url = `http://127.0.0.1:${PORT}/?test=smoke&server=ws://127.0.0.1:${PORT}/ws&radius=1&particles=0&mobs=0&cmdTimeout=30000`;
  const page = await openPage(chromePort, url);
  const r = await page.evaluate(READY);
  if (!r.ok) throw new Error(`标签页没就绪：${r.why}｜${(r.errors ?? []).join(' / ')}`);
  return page;
}

/** 关掉一个标签页：导航到 about:blank，让它的 WebSocket 干净地断开 */
async function closeClient(page) {
  try { await page.evaluate(`location.href = 'about:blank'; return true;`); } catch { /* 已经没了 */ }
  await new Promise((r) => setTimeout(r, 500));
}

const cmd = (page, line) => page.evaluate(`return await window.__mc.command(${JSON.stringify(line)});`);

// 主世界与下界故意用同一个区块坐标：region 键里漏了维度的话，
// 两边写到同一个文件，后写的那个赢
const SPOT = { x: 5, y: 70, z: 5 };
const NSPOT = { x: 5, y: 45, z: 5 };
const OVERWORLD_BLOCK = 'gold_block';
const NETHER_BLOCK = 'diamond_block';

let chrome = null;
let server = null;
try {
  chrome = await launchChrome({ port: CDP_PORT, headless: true });

  // --- 第一回：盖东西 ---
  server = await startServer();
  let page = await openClient(CDP_PORT);
  log('第一回：连上了');

  await cmd(page, `tp ${SPOT.x} ${SPOT.y + 2} ${SPOT.z}`);
  await page.evaluate('await window.__mc.waitForIdle(); return true;').catch(() => {});
  const put1 = await cmd(page, `setblock ${SPOT.x} ${SPOT.y} ${SPOT.z} ${OVERWORLD_BLOCK}`);
  log(`主世界放置：${JSON.stringify(put1)}`);

  // 去下界，在同一个区块坐标上放另一种方块
  const dim = await cmd(page, 'dimension nether');
  log(`换维度：${JSON.stringify(dim)}`);
  await page.evaluate('await window.__mc.waitForIdle(); return true;').catch(() => {});
  const put2 = await cmd(page, `setblock ${NSPOT.x} ${NSPOT.y} ${NSPOT.z} ${NETHER_BLOCK}`);
  log(`下界放置：${JSON.stringify(put2)}`);
  const check2 = await cmd(page, `getblock ${NSPOT.x} ${NSPOT.y} ${NSPOT.z}`);
  if (!String(check2.text ?? check2).includes(NETHER_BLOCK)) {
    failures.push(`下界那格当场就不对：${JSON.stringify(check2)}`);
  }

  // 回主世界，确认刚才那格还在（同坐标不同维度，不该互相覆盖）
  await cmd(page, 'dimension overworld');
  await page.evaluate('await window.__mc.waitForIdle(); return true;').catch(() => {});
  const check1 = await cmd(page, `getblock ${SPOT.x} ${SPOT.y} ${SPOT.z}`);
  if (!String(check1.text ?? check1).includes(OVERWORLD_BLOCK)) {
    failures.push(`主世界那格在同一次会话里就被下界顶掉了：${JSON.stringify(check1)}`);
  }

  await closeClient(page);
  await stopServer(server);
  server = null;
  log('第一回：服务端已退出（退出钩子应该存过盘了）');

  const files = fs.readdirSync(SAVE_DIR, { recursive: true }).map(String);
  log(`存档目录：${files.join(' ')}`);
  if (!files.some((f) => f.includes('level.dat'))) failures.push('没写 level.dat');
  if (!files.some((f) => f.replace(/\\/g, '/').startsWith('region/'))) {
    failures.push('没写主世界的 region');
  }
  if (!files.some((f) => f.replace(/\\/g, '/').startsWith('DIM-1/region/'))) {
    failures.push('没写下界的 region —— 下界的东西一个字都没存下来');
  }

  // --- 第二回：同一个目录重新开服 ---
  server = await startServer();
  page = await openClient(CDP_PORT);
  log('第二回：连上了');
  await page.evaluate('await window.__mc.waitForIdle(); return true;').catch(() => {});

  const back1 = await cmd(page, `getblock ${SPOT.x} ${SPOT.y} ${SPOT.z}`);
  if (String(back1.text ?? back1).includes(OVERWORLD_BLOCK)) {
    log('主世界那格还在 ok');
  } else {
    failures.push(`主世界盖的东西没还原：${JSON.stringify(back1)}`);
  }

  await cmd(page, 'dimension nether');
  await page.evaluate('await window.__mc.waitForIdle(); return true;').catch(() => {});
  const back2 = await cmd(page, `getblock ${NSPOT.x} ${NSPOT.y} ${NSPOT.z}`);
  if (String(back2.text ?? back2).includes(NETHER_BLOCK)) {
    log('下界那格还在 ok');
  } else {
    failures.push(`下界盖的东西没还原：${JSON.stringify(back2)}`);
  }

  await closeClient(page);
} catch (e) {
  failures.push(`异常：${e && e.stack ? e.stack : e}`);
} finally {
  if (server !== null) await stopServer(server);
  if (chrome !== null) await chrome.close();
  fs.rmSync(SAVE_DIR, { recursive: true, force: true });
}

console.log('');
if (failures.length === 0) {
  console.log('[mp-save] 独立服务端存档验收通过');
} else {
  console.log(`[mp-save] 失败 ${failures.length} 项:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
