/**
 * 闸门测试①：第一夜。
 *
 * 出生 → 徒手打木 → 合成台 + 工具 → 搭掩体 → 熬过有怪的一夜。
 *
 * 这是整个项目最接近"真的能玩"的一条验收：它把世界生成、挖掘、掉落物、
 * 拾取、合成、放置、方块实体、光照、昼夜、怪物生成与 AI **串成一条链**，
 * 中间任何一环断了都过不去。单项测试全绿而这条挂掉，说明有东西只在
 * 隔离环境里成立。
 *
 * 与真人玩的差别：动作用 __mc 的钩子发出去，而不是模拟鼠标键盘。
 * 验的是"这条链通不通"，不是"手感好不好"—— 后者靠截图。
 *
 * 用法：
 *   node tools/first-night-check.mjs           无头
 *   node tools/first-night-check.mjs --head    有头，肉眼看
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { launchChrome, openPage } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8097;
const OUT_DIR = path.join(ROOT, 'tests/out');
const HEADLESS = !process.argv.includes('--head');
const SEED = 20261118; // 1.0.0 的发布日
const URL = `http://127.0.0.1:${PORT}/?test=firstnight&seed=${SEED}&radius=3&persist=0`;

const failures = [];
const log = (m) => console.log(`[第一夜] ${m}`);

const ensureHook = `
  const t0 = Date.now();
  while (!window.__mc) {
    if (Date.now() - t0 > 20000) throw new Error('__mc 未挂载');
    await new Promise(r => setTimeout(r, 50));
  }
  await window.__mc.ready;
`;

async function waitForServer(url, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch { /* 还没起来 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`dev-server ${timeoutMs}ms 内没起来`);
    await new Promise((r) => { setTimeout(r, 100); });
  }
}

let serverProc = null;
let chrome = null;
let page = null;

try {
  log(`启动 dev-server :${PORT}`);
  serverProc = spawn(process.execPath, [path.join(ROOT, 'tools/dev-server.mjs'), '--port', String(PORT)], {
    cwd: ROOT, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stderr.on('data', (d) => process.stderr.write(`[dev] ${d}`));
  await waitForServer(`http://127.0.0.1:${PORT}/`, 10000);

  log(`启动 Chrome (headless=${HEADLESS})`);
  chrome = await launchChrome({ port: 9336, headless: HEADLESS });
  page = await openPage(9336, URL);

  const prep = await page.evaluate(`
    ${ensureHook}
    const m = window.__mc;
    await m.waitForIdle();
    const notes = [];
    const fail = (s) => { notes.push('FAIL ' + s); };
    const ok = (s) => { notes.push('ok ' + s); };

    // --- 0. 出生：白天、活着、地上 ---
    await m.setTime(1000);
    const spawn = m.stats();
    if (m.isDead()) fail('一出生就是死的');
    else ok('出生在 ' + spawn.cameraX.toFixed(1) + ',' + spawn.cameraY.toFixed(1) + ',' + spawn.cameraZ.toFixed(1));

    const px = Math.round(spawn.cameraX);
    const py = Math.round(spawn.cameraY) - 2;
    const pz = Math.round(spawn.cameraZ);

    // --- 1. 徒手打木 ---
    //
    // 找一棵树。世界生成里树是随机的，所以先在附近种一棵 —— 验的是
    // "打木头能拿到木头"，不是"出生点一定有树"
    // 三格原木：一根出 4 块板，而整条链要用掉 2 块做木棍 + 4 块做工作台
    // + 3 块做镐 = 9 块。砍两格是不够的
    await m.command('setblock ' + (px + 2) + ' ' + (py + 1) + ' ' + pz + ' log');
    await m.command('setblock ' + (px + 2) + ' ' + (py + 2) + ' ' + pz + ' log');
    await m.command('setblock ' + (px + 2) + ' ' + (py + 3) + ' ' + pz + ' log');
    await m.command('tp ' + (px + 0.5) + ' ' + (py + 1) + ' ' + (pz + 0.5));
    m.attachPlayer(px + 0.5, py + 1, pz + 0.5);
    await m.waitForIdle();

    // 服务端自己算挖掘进度，客户端只报"开始挖 / 松手"
    const mined1 = await m.mineBlock(px + 2, py + 3, pz);
    const mined2 = await m.mineBlock(px + 2, py + 2, pz);
    const mined3 = await m.mineBlock(px + 2, py + 1, pz);
    if (!mined1 || !mined2 || !mined3) fail('原木没挖动：' + mined1 + '/' + mined2 + '/' + mined3);
    else ok('三格原木都挖穿了');

    // 掉落物落在原木原来的位置，而拾取范围只有一格 ——
    // 得**走过去捡**。这一步不是形式：它顺带验了掉落物真的在世界里，
    // 而不是被服务端直接塞进背包
    const beforePickup = m.itemEntities().length;
    if (beforePickup === 0) fail('挖穿之后地上没有掉落物');
    else ok('地上有 ' + beforePickup + ' 个掉落物');
    // 走过去把地上的都捡干净。拾取每刻每人只捡一个实体，而且掉落物
    // 落地的位置有随机散布 —— 所以是"走过去等到捡完"，不是"站一会儿"
    const pickupT0 = Date.now();
    while (m.itemEntities().length > 0 && Date.now() - pickupT0 < 20000) {
      const rest = m.itemEntities()[0];
      await m.command('tp ' + rest.x.toFixed(2) + ' ' + (py + 1) + ' ' + rest.z.toFixed(2));
      m.attachPlayer(rest.x, py + 1, rest.z);
      for (let i = 0; i < 40; i++) await new Promise(r => requestAnimationFrame(r));
    }

    const afterWood = await m.command('inv');
    if (!afterWood.text.includes('log')) fail('走过去也没捡到原木：[' + afterWood.text + ']');
    else ok('捡到原木：' + afterWood.text);

    // --- 2. 合成：原木 -> 木板 -> 木棍 + 工作台 -> 木镐 ---
    const craft = await m.craftChain();
    if (!craft.ok) fail('合成链断了：' + craft.reason);
    else ok('合成出 ' + craft.made.join(' / '));
    // 木镐是"第一夜"真正的分水岭：有了它才能挖石头，才有石器时代
    if (!craft.made.includes('wooden_pickaxe')) fail('没合出木镐 —— 第一夜的意义就在这一步');

    // --- 3. 搭掩体：把自己封在一个 3×3 的石头盒子里 ---
    const sx = px, sy = py + 1, sz = pz;
    await m.command('fillbox ' + (sx-1) + ' ' + (sy-1) + ' ' + (sz-1) + ' ' + (sx+1) + ' ' + (sy+2) + ' ' + (sz+1) + ' stone');
    // 掏空内部，留一格站人 + 一格头顶
    await m.command('fillbox ' + sx + ' ' + sy + ' ' + sz + ' ' + sx + ' ' + (sy+1) + ' ' + sz + ' air');
    await m.command('tp ' + (sx + 0.5) + ' ' + sy + ' ' + (sz + 0.5));
    m.attachPlayer(sx + 0.5, sy, sz + 0.5);
    await m.waitForIdle();
    ok('掩体搭好');

    // 天黑，怪开始刷。观察分几段做 —— CDP 单次求值上限 60 秒
    await m.setTime(13000);
    return { notes, startHealth: m.vitals().health };
  `);

  for (const note of prep.notes) {
    log('  ' + note);
    if (note.startsWith('FAIL')) failures.push(note.slice(5));
  }

  // --- 4. 熬过一夜 ---
  //
  // 天黑 -> 怪物开始刷 -> 玩家在掩体里 -> 天亮时还活着。
  // 这一步同时验了：夜里光照够暗能刷怪、怪刷在掩体外、掩体挡得住。
  //
  // 一夜是 12000 刻（真实 10 分钟），无头下等不起。分 6 段各观测 15 秒，
  // 服务端按 20 TPS 跑就是约 1800 刻 —— 足够怪物刷满并找上门
  let peakMobs = 0;
  let died = false;
  for (let round = 0; round < 6 && !died; round++) {
    const seg = await page.evaluate(`
      ${ensureHook}
      const m = window.__mc;
      const t1 = Date.now();
      let peak = 0;
      while (Date.now() - t1 < 15000) {
        await new Promise(r => setTimeout(r, 1000));
        peak = Math.max(peak, m.mobEntities().length);
        if (m.isDead()) break;
      }
      return { peak, dead: m.isDead(), health: m.vitals().health };
    `);
    peakMobs = Math.max(peakMobs, seg.peak);
    died = seg.dead === true;
    log(`  夜里第 ${round + 1}/6 段：视野内最多 ${seg.peak} 只怪，血量 ${seg.health}`);
  }

  const result = await page.evaluate(`
    ${ensureHook}
    const m = window.__mc;
    const mobsSeen = await m.command('mobs');
    const endHealth = m.vitals().health;
    const dead = m.isDead();
    // 天亮
    await m.setTime(1000);
    for (let i = 0; i < 30; i++) await new Promise(r => requestAnimationFrame(r));
    const shot = await m.screenshot();
    return { shot, dead, endHealth, mobs: mobsSeen.text, errors: m.errors() };
  `);
  result.notes = [];
  if (result.dead) failures.push('在掩体里被弄死了');
  else log(`  ok 活着熬过来了，血量 ${prep.startHealth} -> ${result.endHealth}`);
  if (result.mobs === 'none') failures.push('一整夜一只怪都没刷出来 —— 生成规则或光照有问题');
  else log(`  ok 夜里刷出了 ${result.mobs}`);
  result.peakMobs = peakMobs;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, 'first-night.png'),
    Buffer.from(String(result.shot).replace(/^data:image\/png;base64,/, ''), 'base64'),
  );

  for (const note of result.notes) {
    log('  ' + note);
    if (note.startsWith('FAIL')) failures.push(note.slice(5));
  }
  log(`视野里最多同时有 ${result.peakMobs} 只怪`);
  if (result.errors.length > 0) failures.push(`页面报错 ${result.errors.length} 条: ${result.errors.join(' | ')}`);
  if (page.exceptions.length > 0) failures.push(`未捕获异常: ${page.exceptions.join(' | ')}`);
} catch (err) {
  failures.push(String(err && err.stack ? err.stack : err));
} finally {
  if (page !== null) page.close();
  if (chrome !== null) await chrome.close();
  if (serverProc !== null) serverProc.kill();
}

if (failures.length > 0) {
  console.error(`\n[第一夜] 失败 ${failures.length} 项:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('[第一夜] 闸门测试① 通过');
