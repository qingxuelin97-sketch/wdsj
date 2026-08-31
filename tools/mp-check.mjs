/**
 * 多人验收：起一个独立服务端，开**两个真的浏览器标签页**连上去，
 * 验证它们互相看得见、一边动另一边跟着动、延迟在预算内。
 *
 * 与 tests/server/multiplayer.test.ts 的分工：
 *   那边验的是**服务端的差集逻辑**（谁该收到什么包），在 node 里逐条断言；
 *   这里验的是**整条链路真的通**（WebSocket 握手、帧编解码、
 *   客户端把出生包画成一个人）。两者少了哪一半都可能"全绿但连不上"。
 *
 * 用法：node tools/mp-check.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, openPage } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8124;
const failures = [];
const log = (m) => console.log(`[mp-check] ${m}`);

/** 等到条件成立或超时。返回是否成立 */
async function until(page, expr, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // cdp.mjs 的 evaluate 把字符串当成**异步函数体**包起来，
    // 所以这里要写 `return`，不能写一个表达式 —— 写表达式的话
    // 返回的永远是 undefined，而 undefined 是假值，
    // 表现为"每一条都超时"，看着像整个功能没做
    const ok = await page.evaluate(`try { ${expr} } catch (e) { return false; }`);
    if (ok === true) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const server = spawn(process.execPath, [path.join(ROOT, 'tools/mp-server.mjs'), '--port', String(PORT)], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_NO_WARNINGS: '1' },
});
server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
server.stderr.on('data', (d) => process.stderr.write(`[server!] ${d}`));

for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch { /* 还没起来 */ }
  await new Promise((r) => setTimeout(r, 100));
}

const chrome = await launchChrome({ port: 9351, headless: true });
const url = `http://127.0.0.1:${PORT}/?test=smoke&server=ws://127.0.0.1:${PORT}/ws&radius=1&particles=0&cmdTimeout=30000`;
let a = null;
let b = null;
try {
  // **一个一个开**，不要两个一起等。
  //
  // 软件渲染下两个标签页会抢同一颗 CPU，同时启动时各自要建一套
  // 382 张的图集、初始化 GL、再流送区块 —— 谁也跑不动，
  // 表现是两边的指令全部超时。先让 A 就绪并把画布缩到 160×120，
  // 再开 B，两边就都跑得动了。
  //
  // 缩画布不是"为了让测试过"：这里验的是**多人链路**，
  // 渲染性能由 perf-check 单独验。
  const ready = `
    const t0 = Date.now();
    while (!window.__mc) { if (Date.now() - t0 > 60000) return { ok: false, why: '__mc 没挂载' }; await new Promise(r => setTimeout(r, 50)); }
    let done = false;
    window.__mc.ready.then(() => { done = true; });
    while (!done && Date.now() - t0 < 60000) await new Promise(r => setTimeout(r, 100));
    if (done) window.__mc.setCanvasSize(160, 120);
    return {
      ok: done,
      why: done ? '' : 'ready 一直没兑现',
      logs: window.__mc.logs().slice(-6),
      errors: window.__mc.errors().slice(-4),
    };
  `;
  a = await openPage(9351, url);
  const ra = await a.evaluate(ready);
  if (!ra.ok) failures.push(`A 没能就绪：${ra.why}｜${(ra.errors ?? []).join(' / ')}`);
  b = await openPage(9351, url);
  const rb = await b.evaluate(ready);
  if (!rb.ok) failures.push(`B 没能就绪：${rb.why}｜${(rb.errors ?? []).join(' / ')}`);
  if (ra.ok && rb.ok) log('两个标签页都连上了');

  // 各自站开一点，免得挤在同一格里
  await a.evaluate(`window.__mc.attachPlayer(4, 80, 4); return true;`);
  await b.evaluate(`window.__mc.attachPlayer(10, 80, 10); return true;`);

  // 互相看得见：type 14 是 PLAYER
  const seeEach = await until(a, `return window.__mc.mobEntities().some(e => e.type === 14)`)
    && await until(b, `return window.__mc.mobEntities().some(e => e.type === 14)`);
  if (!seeEach) {
    failures.push('两个标签页互相看不见 —— 玩家同步没通');
  } else {
    log('互相看得见 ok');
  }

  // 往返延迟：指令发出到回执回来。多人的预算是 100ms。
  //
  // **先等世界安定**。刚 attachPlayer 完服务端正在生成一片新区块，
  // 一个 tick 就要一两百毫秒，这时候量到的是"服务端忙不忙"
  // 而不是"网络多快" —— 实测忙的时候 950ms，安定之后 50ms。
  for (const p of [a, b]) {
    await p.evaluate('await window.__mc.waitForIdle(); return true;').catch(() => {});
  }
  const latency = await a.evaluate(`
    const m = window.__mc;
    const samples = [];
    for (let i = 0; i < 12; i++) {
      const t = performance.now();
      await m.command('pos');
      samples.push(performance.now() - t);
    }
    samples.sort((x, y) => x - y);
    return { median: samples[6], max: samples[samples.length - 1] };
  `);
  log(`指令往返：中位 ${latency.median.toFixed(1)}ms 最大 ${latency.max.toFixed(1)}ms`);
  if (latency.median > 100) {
    failures.push(`往返延迟中位 ${latency.median.toFixed(1)}ms，预算是 100ms`);
  }


  // 一边动，另一边要跟着看到位置变化，并测**往返延迟**
  if (seeEach) {
    const r = await a.evaluate(`
      const before = window.__mc.mobEntities().find(e => e.type === 14);
      return { x: before ? before.x : null };
    `);
    // 用 attachPlayer 而不是 tp 指令。
    //
    // tp 改的是**服务端**记的位置，而客户端每帧都在把自己相机的位置
    // 报上去 —— 下一帧就把服务端拽回原处了。表现是"tp 了但没动"。
    // attachPlayer 动的是客户端的身体，位置这才真的会被报上去
    await b.evaluate(`window.__mc.attachPlayer(30, 80, 30); return true;`);
    const moved = await until(a, `
      const e = window.__mc.mobEntities().find(x => x.type === 14);
      return e !== undefined && Math.abs(e.x - 30) < 2;
    `, 15000);
    if (!moved) failures.push('B 移动之后 A 没看到它动 —— 移动包没通');
    else log('一边动另一边跟着动 ok（起点 ' + r.x + '）');
  }

  // 一边放方块，另一边要看得见
  await a.evaluate(`await window.__mc.command('setblock 12 80 12 glowstone'); return true;`);
  const sawBlock = await until(b, `
    return (await window.__mc.command('getblock 12 80 12')).text === 'glowstone';
  `, 15000);
  if (!sawBlock) failures.push('A 放的方块 B 看不到');
  else log('一边放方块另一边看得见 ok');

  // 一边关掉，另一边不该留下躯壳。
  //
  // CdpSession.close() 只断调试连接，标签页还开着 —— 要真的关掉页面
  // 才会触发 WebSocket 的 close，服务端那边才会走 removePlayer
  // 把页面导航走。CdpSession.close() 只断调试连接、标签页还开着，
  // 而 window.close() 对不是脚本打开的页面无效 ——
  // 只有真的离开这个文档，WebSocket 才会关，服务端才会走 removePlayer
  await b.send('Page.navigate', { url: 'about:blank' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1000));
  b.close();
  const gone = await until(a, `return window.__mc.mobEntities().every(e => e.type !== 14)`, 15000);
  if (!gone) failures.push('B 关掉了 A 那边还留着一具躯壳');
  else log('下线之后躯壳消失 ok');
  b = null;
} catch (e) {
  failures.push(`异常：${String(e.message).split('\n')[0]}`);
}

for (const p of [a, b]) {
  if (p === null) continue;
  for (const ex of p.exceptions.slice(0, 3)) console.log('页面异常:', ex.split('\n')[0]);
}
await chrome.close();
server.kill();

if (failures.length > 0) {
  console.log(`\n[mp-check] 失败 ${failures.length} 项:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\n[mp-check] 全部通过');
process.exit(0);
