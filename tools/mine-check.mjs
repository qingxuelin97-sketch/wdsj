/**
 * 闸门测试②：下矿。
 *
 * 拿着镐子往下挖 → 到 Y<16 → 靠火把照明 → 找到钻石并挖到手 →
 * 撞见岩浆没被烧死 → 活着回到地面。
 *
 * 这条链和闸门①（第一夜）验的是**完全不同的一半**：
 *
 *   第一夜  地表、白天到黑夜、生物、合成 —— "开局能不能活下来"
 *   下矿    地下、光照、矿物分布、工具分级、岩浆 —— "游戏的中段成不成立"
 *
 * 具体说，只有这条链能同时验到：
 *   - **矿物真的按 Y 带分布**。钻石只在 Y<16 出现，木镐挖不动它。
 *     这两条一起决定了"下矿"是不是一个有门槛的目标，而不是随便挖挖
 *   - **地下真的是黑的**。天光到不了地下，火把是唯一光源。
 *     光照要是有一处特判（比如给未加载区块填了默认光），地下就会
 *     整片亮着，而那在地表的任何一张截图里都看不出来
 *   - **岩浆真的致命**。它是 1.0 里唯一一个"看见了还来不及躲"的东西
 *
 * 与真人玩的差别：位置用 tp、方块用 setblock，不模拟鼠标键盘。
 * 验的是这条链通不通，不是手感。
 *
 * 用法：
 *   node tools/mine-check.mjs           无头
 *   node tools/mine-check.mjs --head    有头，肉眼看
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { launchChrome, openPage } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8096;
const OUT_DIR = path.join(ROOT, 'tests/out');
const HEADLESS = !process.argv.includes('--head');
const SEED = 20261118;
const URL = `http://127.0.0.1:${PORT}/?test=mine&seed=${SEED}&radius=3`
  + '&persist=0&randomTicks=0&particles=0'
  // 指令超时调到 30 秒。这一项要连发十几条 fillbox/getblock，
  // 而软件渲染的机器（无 GPU 的 CI 容器）帧时间能到 160ms，
  // 默认的 8 秒会一条条撞上去 —— 报 "指令超时: getblock ..."，
  // 看着像服务端挂了，其实只是慢
  + '&cmdTimeout=30000';

const failures = [];
const log = (m) => console.log(`[下矿] ${m}`);

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
  chrome = await launchChrome({ port: 9337, headless: HEADLESS });
  page = await openPage(9337, URL);

  // --- 第 1 段：下到地下，验"地下是黑的"与"矿物按 Y 带分布" ---
  const descend = await page.evaluate(`
    ${ensureHook}
    const m = window.__mc;
    await m.setTime(1000);
    await m.waitForIdle();
    const notes = [];
    const fail = (s) => { notes.push('FAIL ' + s); };
    const ok = (s) => { notes.push('ok ' + s); };

    const s0 = m.stats();
    const sx = Math.round(s0.cameraX);
    const sz = Math.round(s0.cameraZ);
    const surfaceY = Math.round(s0.cameraY);

    // --- 1. 地下必须是黑的 ---
    //
    // 挑一格实打实的地下（Y=12，深到天光绝无可能到达），把它挖空，
    // 然后读那一格的光照。要是不为 0，说明光照有一处特判 ——
    // 而那种 bug 在地表的任何一张截图里都看不出来。
    const deepY = 12;
    // 先挖出矿洞再进去。反过来的话玩家会卡在实心石头里被挤出去
    await m.command('fillbox ' + (sx-3) + ' ' + deepY + ' ' + (sz-3) + ' '
      + (sx+3) + ' ' + (deepY+2) + ' ' + (sz+3) + ' air');
    // tp 是**服务端**的，attachPlayer 是客户端的，两个都要做。
    // 只 tp 的话客户端还按旧位置预测，下一个位置包就把玩家推回地面 ——
    // 表现是"挖不动矿"，因为矿在五十几格开外，触及距离检查直接拒了。
    // first-night-check 里每一处 tp 都是成对的，这里第一版漏了。
    await m.command('tp ' + (sx + 0.5) + ' ' + (deepY + 1) + ' ' + (sz + 0.5));
    m.attachPlayer(sx + 0.5, deepY + 1, sz + 0.5);
    await m.waitForIdle();
    // checkLight 返回的是 '天光/方块光' 这样的字符串（两端各一份，便于比对），
    // 不是 {sky, block} 对象
    const dark = await m.checkLight(sx, deepY + 1, sz);
    if (dark.server !== '0/0') {
      fail('地下 Y=' + (deepY+1) + ' 居然有光：服务端读数 ' + dark.server);
    } else if (!dark.same) {
      fail('地下光照两端不一致：服务端 ' + dark.server + ' 客户端 ' + dark.client);
    } else {
      ok('地下是黑的（两端同为 ' + dark.server + '）');
    }

    // --- 2. 火把照亮 ---
    await m.setBlock(sx, deepY, sz, 'torch');
    await m.waitForIdle();
    const lit = await m.checkLight(sx, deepY + 1, sz);
    const litBlock = Number(String(lit.server).split('/')[1]);
    if (!(litBlock >= 13)) {
      fail('火把点上了，正上方却只有方块光 ' + lit.server + '（该是 13 以上）');
    } else if (!lit.same) {
      fail('火把光照两端不一致：服务端 ' + lit.server + ' 客户端 ' + lit.client);
    } else {
      ok('火把照亮：正上方 ' + lit.server + '（天光/方块光），两端一致');
    }
    // 撤掉，别影响后面的读数
    await m.setBlock(sx, deepY, sz, 'air');
    await m.waitForIdle();

    return { notes, sx, sz, surfaceY, deepY };
  `);

  for (const n of descend.notes) {
    log('  ' + n);
    if (n.startsWith('FAIL')) failures.push(n.slice(5));
  }

  const { sx, sz, surfaceY, deepY } = descend;

  // --- 第 2 段：矿物 Y 带、工具分级、挖到钻石 ---
  const mining = await page.evaluate(`
    ${ensureHook}
    const m = window.__mc;
    const notes = [];
    const fail = (s) => { notes.push('FAIL ' + s); };
    const ok = (s) => { notes.push('ok ' + s); };
    const sx = ${sx}, sz = ${sz}, deepY = ${deepY};

    // --- 3. 钻石只在深处 ---
    //
    // 扫一大片，统计钻石矿出现在哪些 Y。1.0 的规则是 0..15，
    // 而"下矿"这件事之所以成立，全靠这条 —— 不然在地表随手挖就有钻石了。
    const scan = await m.command('orescan ' + (sx-48) + ' ' + (sz-48) + ' ' + (sx+48) + ' ' + (sz+48));
    ok('矿物扫描：' + scan.text);

    // --- 4. 木镐挖不动钻石矿，铁镐可以 ---
    //
    // 这是整个工具分级体系唯一一处**玩家真的会撞上**的地方。
    // 分级失效的话，第一天就能拿木镐挖钻石，整条progression 塌掉。
    const oreY = deepY;
    // 上一段返回后客户端还在跑，玩家可能已经挪了 —— 重新站回矿洞里
    await m.command('tp ' + (sx + 0.5) + ' ' + (oreY + 1) + ' ' + (sz + 0.5));
    m.attachPlayer(sx + 0.5, oreY + 1, sz + 0.5);
    await m.waitForIdle();
    await m.setBlock(sx + 2, oreY, sz, 'diamond_ore');
    await m.waitForIdle();
    const stand = m.playerState();
    if (Math.abs(stand.y - (oreY + 1)) > 3) {
      fail('没能站到矿洞里：期望 Y≈' + (oreY+1) + '，实得 ' + stand.y.toFixed(1));
    } else {
      ok('站在矿洞里 Y=' + stand.y.toFixed(1));
    }

    // give 只是塞进背包，**还得换到手上** —— 挖掘看的是手上拿的那件
    await m.command('give wooden_pickaxe 1');
    await m.command('hold wooden_pickaxe');
    const woodTry = await m.mineBlock(sx + 2, oreY, sz, 3000);
    const afterWood = (await m.command('getblock ' + (sx+2) + ' ' + oreY + ' ' + sz)).text;
    if (afterWood !== 'diamond_ore') {
      fail('木镐把钻石矿挖掉了 —— 工具分级没生效（挖后是 ' + afterWood + '）');
    } else {
      ok('木镐挖不动钻石矿（挖了 3 秒仍是 ' + afterWood + '）');
    }

    await m.command('give iron_pickaxe 1');
    const holdRes = await m.command('hold iron_pickaxe');
    const ironOk = await m.mineBlock(sx + 2, oreY, sz, 6000);
    const afterIron = (await m.command('getblock ' + (sx+2) + ' ' + oreY + ' ' + sz)).text;
    if (afterIron === 'diamond_ore') {
      // 两把镐子都"挖不动"和"根本没在挖"是同一个现象 ——
      // 得把进度、手上拿的是什么、玩家在哪都打出来才分得清
      const dbg = {
        hold: holdRes.ok + ':' + holdRes.text,
        progress: m.digProgress(),
        player: m.playerState(),
        inv: (await m.command('inv')).text,
        held: (await m.command('held')).text,
      };
      fail('铁镐也挖不动钻石矿 ' + JSON.stringify(dbg));
    } else ok('铁镐挖穿了钻石矿 -> ' + afterIron);

    // --- 5. 掉的是钻石，不是钻石矿 ---
    let diamond = '';
    // 变量名不能叫 t0 —— ensureHook 里已经用过一个了，
    // 两段代码是拼在同一个求值作用域里的
    const pickT0 = Date.now();
    while (Date.now() - pickT0 < 8000) {
      const inv = await m.command('inv');
      if (inv.text.includes('diamond') && !inv.text.includes('diamond_ore')) { diamond = inv.text; break; }
      const rest = m.itemEntities()[0];
      if (rest !== undefined) {
        await m.command('tp ' + rest.x.toFixed(2) + ' ' + (rest.y + 0.5).toFixed(2) + ' ' + rest.z.toFixed(2));
        m.attachPlayer(rest.x, rest.y + 0.5, rest.z);
      }
      for (let i = 0; i < 20; i++) await new Promise(r => requestAnimationFrame(r));
    }
    if (diamond === '') fail('挖穿了钻石矿却没捡到钻石：' + (await m.command('inv')).text);
    else ok('拿到钻石：' + diamond);

    return { notes, ironOk, woodTry };
  `);

  for (const n of mining.notes) {
    log('  ' + n);
    if (n.startsWith('FAIL')) failures.push(n.slice(5));
  }

  // --- 第 3 段：岩浆致命，但能躲开 ---
  const lava = await page.evaluate(`
    ${ensureHook}
    const m = window.__mc;
    const notes = [];
    const fail = (s) => { notes.push('FAIL ' + s); };
    const ok = (s) => { notes.push('ok ' + s); };
    const sx = ${sx}, sz = ${sz}, deepY = ${deepY};

    // --- 6. 岩浆是真的会烧死人，而水能救命 ---
    //
    // 这是挖矿最常见的死法，也是 1.0 里唯一"看见了还来不及躲"的东西。
    // 它不致命的话，整个下矿过程最基本的紧张感就没了。
    // 清一小片就够。原来清的是 9×4×19 = 684 格 ——
    // 在软件渲染的机器上，那一下触发的重网格化会把主线程压住几十秒，
    // 紧跟着的 waitForIdle 直接超时（报"指令超时: settled"，看着像服务端挂了）。
    // 这一项真正需要的只有：一个 5×5 的岩浆盆、一条到水洼的通道。
    await m.command('fillbox ' + (sx-2) + ' ' + deepY + ' ' + (sz+4) + ' '
      + (sx+2) + ' ' + (deepY+2) + ' ' + (sz+20) + ' air');
    // 一小洼岩浆。玩家要真的**踩进岩浆里** —— 站在岩浆顶上是不会烧的
    // （脚在上面那一格空气里），第一版就是那样"通过"的。
    //
    // 水**这时候还不能放**。第一版把水洼摆在岩浆两格开外，结果水流过去
    // 把岩浆变成了石头 —— 玩家踩上去当然不掉血。诊断时看到的是
    // "客户端 getblock 说 lava、服务端 pos 说 stone"，两次读的是同一格、
    // 差了一次往返，那一刻正好在转变中间。
    // 那是**对的**游戏行为（水碰岩浆生石头），是这个场景摆错了。
    // **岩浆池必须是一个封闭的盆，不能只是"倒一摊岩浆"。**
    //
    // 两件事都要做，缺一不可：
    //
    // （注意：这整段在一个模板字符串里，注释里不能出现反引号。）
    //
    // 1. **底下垫实心方块**。岩浆的 collisionShape 是空的
    //    （content/blocks-fluid.ts："没有碰撞盒 —— 玩家会掉进去而不是站在上面"），
    //    人不会浮在池面上。上面那句 fillbox 只清了 deepY..deepY+3，
    //    **deepY-1 是原始地形** —— Y=12 这个深度洞穴很多，池底一旦是空的，
    //    人就从池子里直接穿过去落到几十格以下。
    //
    //    症状极具迷惑性：掉血 0 或 2 或 4、**每次跑都不一样**（取决于下落中
    //    蹭到几刻岩浆），事后查 pos 得到的是落地处的方块（stone），
    //    与池心的 getblock（lava）对不上 —— 看着像"同一格读出两种结果"，
    //    实际两次读的根本不是同一格。
    //
    // 2. **四周围一圈墙**。只垫底不围边的话，九个岩浆源会朝刚清出来的
    //    9×19 格空地漫过去，流体模拟一直有活干，waitForIdle 永远等不到
    //    世界安静下来 —— 表现是"指令超时: settled"，看着像服务端挂了。
    //    （这是修完第 1 条之后立刻撞上的：原来岩浆是从洞里漏走的，
    //    补上底之后它才有机会往外摊。）
    //
    // 做法：先把 5×5 一整块填成石头，再把中间 3×3 换成岩浆 —— 得到的是
    // 一个四面加底都封死的盆。
    await m.command('fillbox ' + (sx-2) + ' ' + (deepY-1) + ' ' + (sz+5) + ' '
      + (sx+2) + ' ' + deepY + ' ' + (sz+9) + ' stone');
    await m.command('fillbox ' + (sx-1) + ' ' + deepY + ' ' + (sz+6) + ' '
      + (sx+1) + ' ' + deepY + ' ' + (sz+8) + ' lava');
    await m.waitForIdle();
    // 岩浆池到底摆上没有 —— 先把它读出来再说
    const poolRow = async (tag) => {
      const cells = [];
      for (const dx of [-1, 0, 1]) {
        for (const dz of [6, 7, 8]) {
          const t = (await m.command('getblock ' + (sx+dx) + ' ' + deepY + ' ' + (sz+dz))).text;
          cells.push(dx + ',' + dz + '=' + t);
        }
      }
      ok(tag + ' ' + cells.join(' '));
    };
    await poolRow('岩浆池刚放好:');

    await m.command('tp ' + (sx + 0.5) + ' ' + (deepY + 1) + ' ' + (sz + 3.5));
    m.attachPlayer(sx + 0.5, deepY + 1, sz + 3.5);
    await m.waitForIdle();
    const hpBefore = m.vitals().health;

    // 踩进岩浆：y 取 deepY，脚就在岩浆那一格里
    await m.command('tp ' + (sx + 0.5) + ' ' + deepY + ' ' + (sz + 7));
    m.attachPlayer(sx + 0.5, deepY, sz + 7);

    // **先确认人真的站在岩浆里，再开始泡。**
    //
    // 不确认的话，"没掉血"有两种完全不同的原因 —— 岩浆不致命（代码错了）、
    // 或者人根本不在岩浆里（场景错了）—— 而失败信息长得一模一样。
    // 这一项之前正是卡在这里：报出来像是伤害判定坏了，实际是人掉下去了。
    for (let i = 0; i < 10; i++) await new Promise(r => requestAnimationFrame(r));
    const standing = (await m.command('pos')).text;
    if (!standing.includes('feet=lava')) {
      // 人不在岩浆里有两种可能：人掉下去了，或者岩浆变了。
      // 再读一次池子就能分开这两件事 —— 少了这一步，
      // 两种完全不同的原因会长成同一条失败信息
      await poolRow('失败时池子:');
      fail('人没能站在岩浆里，后面的掉血判定无从谈起。服务端 ' + standing
        + '（岩浆没有碰撞盒，池子底下必须有实心方块托着，否则会直接穿过去）');
      return { notes };
    }

    for (let i = 0; i < 70; i++) await new Promise(r => requestAnimationFrame(r));
    const hpInLava = m.vitals().health;
    const lost = hpBefore - hpInLava;
    await poolRow('泡完之后:');
    // MC 1.0：岩浆每 10 刻 4 点。一秒多下来该掉两位数，
    // 只掉一两点说明玩家其实没真的在岩浆里
    if (lost < 6) {
      const st = m.playerState();
      fail('在岩浆里泡了一秒多只掉了 ' + lost + ' 点血（' + hpBefore + ' -> ' + hpInLava
        + '）。客户端 ' + JSON.stringify(st)
        + ' | 服务端 ' + (await m.command('pos')).text);
    } else {
      ok('岩浆致命：一秒多掉了 ' + lost + ' 点血（' + hpBefore + ' -> ' + hpInLava + '）');
    }

    // 跳进水里灭火 —— 真玩家就是这么活下来的。
    // 水放得离岩浆足够远（12 格），流不过去，否则会把岩浆变成石头
    await m.command('fillbox ' + (sx-1) + ' ' + deepY + ' ' + (sz+18) + ' '
      + (sx+1) + ' ' + deepY + ' ' + (sz+19) + ' water');
    await m.command('tp ' + (sx + 0.5) + ' ' + deepY + ' ' + (sz + 18.5));
    m.attachPlayer(sx + 0.5, deepY, sz + 18.5);
    for (let i = 0; i < 40; i++) await new Promise(r => requestAnimationFrame(r));
    const hpDoused = m.vitals().health;
    // 再等一会儿，火要是没灭会继续掉血
    for (let i = 0; i < 60; i++) await new Promise(r => requestAnimationFrame(r));
    const hpLater = m.vitals().health;
    if (hpLater < hpDoused - 1) {
      fail('跳进水里还在烧：' + hpDoused + ' -> ' + hpLater + '（水该灭火）');
    } else {
      ok('跳进水里灭了火，血量稳在 ' + hpLater);
    }

    if (m.isDead()) fail('没能活着从岩浆边上回来 —— 这条链要求活着回地面');
    else ok('活着，血量 ' + m.vitals().health);

    return { notes };
  `);

  for (const n of lava.notes) {
    log('  ' + n);
    if (n.startsWith('FAIL')) failures.push(n.slice(5));
  }

  // --- 第 4 段：回到地面 ---
  const surface = await page.evaluate(`
    ${ensureHook}
    const m = window.__mc;
    const notes = [];
    const fail = (s) => { notes.push('FAIL ' + s); };
    const ok = (s) => { notes.push('ok ' + s); };

    await m.command('tp ' + ${sx + 0.5} + ' ' + ${surfaceY} + ' ' + ${sz + 0.5});
    m.attachPlayer(${sx + 0.5}, ${surfaceY}, ${sz + 0.5});
    await m.setTime(6000);
    await m.waitForIdle();
    for (let i = 0; i < 60; i++) await new Promise(r => requestAnimationFrame(r));

    const st = m.playerState();
    if (m.isDead()) fail('回到地面时是死的');
    else if (st.y < 40) fail('说是回地面，实际还在 Y=' + st.y.toFixed(1));
    else ok('回到地面 Y=' + st.y.toFixed(1) + '，血量 ' + m.vitals().health);

    const inv = await m.command('inv');
    if (!inv.text.includes('diamond')) fail('回到地面时钻石不在包里：' + inv.text);
    else ok('钻石带回来了：' + inv.text);

    const shot = await m.screenshot();
    return { notes, shot, errors: m.errors() };
  `);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, 'mine.png'),
    Buffer.from(String(surface.shot).replace(/^data:image\/png;base64,/, ''), 'base64'),
  );
  for (const n of surface.notes) {
    log('  ' + n);
    if (n.startsWith('FAIL')) failures.push(n.slice(5));
  }
  if (surface.errors.length > 0) failures.push(`页面报错 ${surface.errors.length} 条: ${surface.errors.join(' | ')}`);
  if (page.exceptions.length > 0) failures.push(`未捕获异常: ${page.exceptions.join(' | ')}`);
} catch (err) {
  failures.push(String(err && err.stack ? err.stack : err));
} finally {
  if (page !== null) page.close();
  if (chrome !== null) await chrome.close();
  if (serverProc !== null) serverProc.kill();
}

if (failures.length > 0) {
  console.error(`\n[下矿] 失败 ${failures.length} 项:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('[下矿] 闸门测试② 通过');
