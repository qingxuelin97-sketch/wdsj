/**
 * 闸门测试③：退出重进，世界 / 背包 / 容器内容 / 时间完全还原。
 *
 * 与单元测试的分工：`tests/server/persistence.test.ts` 在 node 里验的是
 * ServerCore 与存档层之间的往返，用的是内存后端；这个脚本验的是**真浏览器 +
 * 真 OPFS + 真页面刷新**那条路 —— 三条 worker 线程、MessagePort、
 * 页面生命周期，全都参与。
 *
 * 单元测试过而这里挂，通常意味着接线出了问题（存盘请求没送到、
 * OPFS 写失败被吞掉、读档比客户端连上来晚了一步）。这些恰恰是
 * "代码写了但没跑通"最容易藏身的地方。
 *
 * 用法：
 *   node tools/persist-check.mjs           无头
 *   node tools/persist-check.mjs --head    有头，肉眼看
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchChrome, openPage } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8098; // 与 dev(8080) 和 smoke(8099) 都错开
const HEADLESS = !process.argv.includes('--head');
/**
 * 固定种子。存档目录按种子分，所以同一个种子跑两次会读到同一份存档。
 *
 * URL 里的 `randomTicks=0`：开着随机刻的话，两百个区块里总有草在蔓延、
 * 树苗在长大，客户端的网格化队列永远清不空，`waitForIdle` 等到超时也
 * 等不到安定。而且世界会在存盘与重读之间自己变，光照比对也就没意义了。
 */
const SEED = 20260829;
const URL_BASE = `http://127.0.0.1:${PORT}/?test=persist&seed=${SEED}&radius=2&randomTicks=0&particles=0`;

const failures = [];
function log(msg) {
  console.log(`[persist] ${msg}`);
}

/** 每段脚本自行确认 __mc 就绪 —— 刷新之后上一次的确认当然不算数 */
const ensureHook = `
  const t0 = Date.now();
  while (!window.__mc) {
    if (Date.now() - t0 > 20000) throw new Error('__mc 未挂载');
    await new Promise(r => setTimeout(r, 50));
  }
  await window.__mc.ready;
  await window.__mc.waitForIdle();
`;

async function waitForServer(url, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // 还没起来
    }
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
    cwd: ROOT,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stderr.on('data', (d) => process.stderr.write(`[dev] ${d}`));
  await waitForServer(`http://127.0.0.1:${PORT}/`, 10000);

  log(`启动 Chrome (headless=${HEADLESS})`);
  // 同一个 Chrome 实例里重新打开页面即可 —— OPFS 存在 profile 里，
  // 而 launchChrome 的临时 profile 在整个进程生命周期内是稳定的
  chrome = await launchChrome({ port: 9335, headless: HEADLESS });

  // ---- 第一次进入：清掉旧存档，从零开始 ----
  page = await openPage(9335, URL_BASE);
  log('第一个标签页已打开，等 __mc');
  const first = await page.evaluate(`
    ${ensureHook}
    const m = window.__mc;
    // 上一次跑留下的存档必须先清掉，否则这次的"新世界"其实是上次的旧世界
    await m.wipeSave();
    return { ok: true };
  `);
  if (first.ok !== true) failures.push('清档失败');
  page.close();

  // 清完档要重新加载一次，让服务端从干净的存档起世界
  page = await openPage(9335, URL_BASE);

  const built = await page.evaluate(`
    ${ensureHook}
    const m = window.__mc;
    const s = m.stats();
    const bx = Math.round(s.cameraX) + 3;
    const bz = Math.round(s.cameraZ);
    const by = Math.round(s.cameraY) - 1;

    // 盖一座三格高的黑曜石柱 + 一个箱子 + 一个熔炉
    const plan = [
      [bx, by, 'obsidian'], [bx, by + 1, 'obsidian'], [bx, by + 2, 'obsidian'],
    ];
    for (const [x, y, name] of plan) await m.setBlock(x, y, bz, name);
    await m.setBlock(bx + 1, by, bz, 'chest');
    await m.setBlock(bx + 2, by, bz, 'furnace');
    // 一支火把，好让"方块光"这一项有非零值可比
    await m.setBlock(bx + 4, by, bz, 'torch');

    // 背包里放点东西
    await m.command('give diamond 17');
    await m.command('give iron_pickaxe 1');
    // 时间钉在一个好认的值上
    await m.setTime(15000);

    await m.waitForIdle();
    const read = async (x, y, z) => (await m.command('getblock ' + x + ' ' + y + ' ' + z)).text;
    const blocks = [
      await read(bx, by, bz), await read(bx, by + 1, bz), await read(bx, by + 2, bz),
      await read(bx + 1, by, bz), await read(bx + 2, by, bz),
    ];
    // 光照也要记下来。读档时光照是**从存档里原样装回去**的、不重新播种，
    // 所以它是最容易悄悄不一致的一项：错了也不报错，只是天暗了一点
    const light = async (x, y, z) => (await m.command('light ' + x + ' ' + y + ' ' + z)).text;
    // 四个点要落在**不同的光照状态**上，否则这条断言等于没测：
    // 露天 / 深地下 / 火把旁 / 实心方块内部
    const lights = [
      await light(bx, by + 3, bz),
      await light(bx, 20, bz),
      await light(bx + 5, by, bz),
      await light(bx, by, bz),
    ];
    const save = await m.saveWorld();
    return { bx, by, bz, save, blocks, lights, time: m.timeOfDay() };
  `);
  log(`盖好了：柱子在 ${built.bx},${built.by},${built.bz}，存盘 ${JSON.stringify(built.save)}`);
  if (built.save.ok !== true) failures.push(`存盘失败: ${JSON.stringify(built.save)}`);
  if (built.save.chunks <= 0) failures.push(`存盘没写下任何区块: ${JSON.stringify(built.save)}`);
  const wanted = ['obsidian', 'obsidian', 'obsidian', 'chest', 'furnace'];
  if (built.blocks.join(',') !== wanted.join(',')) {
    failures.push(`盖的时候就没放对：期望 ${wanted.join(',')}，实得 ${built.blocks.join(',')}`);
  }

  // ---- 关掉页面，重新进 ----
  page.close();
  log('页面已关闭，重新加载');
  page = await openPage(9335, URL_BASE);

  const reloaded = await page.evaluate(`
    ${ensureHook}
    const m = window.__mc;
    const bx = ${built.bx}, by = ${built.by}, bz = ${built.bz};
    // 结构可能在视距边缘，先把相机挪过去把那一片读进来
    m.setCamera(bx, by + 6, bz - 6, 0, 0.5, 70);
    await m.waitForIdle();
    const read = async (x, y, z) => (await m.command('getblock ' + x + ' ' + y + ' ' + z)).text;
    const light = async (x, y, z) => (await m.command('light ' + x + ' ' + y + ' ' + z)).text;
    return {
      blocks: [
        await read(bx, by, bz), await read(bx, by + 1, bz), await read(bx, by + 2, bz),
        await read(bx + 1, by, bz), await read(bx + 2, by, bz),
      ],
      lights: [
        await light(bx, by + 3, bz),
        await light(bx, 20, bz),
        await light(bx + 5, by, bz),
        await light(bx, by, bz),
      ],
      time: m.timeOfDay(),
      errors: m.errors(),
      logs: m.logs().filter((l) => l.includes('[save]')),
    };
  `);
  for (const l of reloaded.logs) log(`  page: ${l}`);

  // --- 结构 ---
  for (let i = 0; i < built.blocks.length; i++) {
    if (reloaded.blocks[i] !== built.blocks[i]) {
      failures.push(
        `第 ${i} 个方块没还原：存之前 ${built.blocks[i]}，重进之后 ${reloaded.blocks[i]}`,
      );
    }
  }

  // --- 光照 ---
  for (let i = 0; i < built.lights.length; i++) {
    if (reloaded.lights[i] !== built.lights[i]) {
      failures.push(
        `第 ${i} 个采样点的光照没还原：存之前 ${built.lights[i]}，重进之后 ${reloaded.lights[i]}`,
      );
    }
  }
  // 采样点必须真的落在不同的光照状态上，否则这条断言等于没测
  if (new Set(built.lights).size < 3) {
    failures.push(`采样点没选出差异（${built.lights.join(' ')}），光照这条断言等于没测`);
  }

  // --- 时间 ---
  // 世界在两次之间还跑了几秒，所以只要求"接得上"而不是完全相等：
  // 从 15000 起，跑了 t 刻就该是 15000+t，不该回到 0 也不该是别的什么值
  const drift = (reloaded.time - built.time + 24000) % 24000;
  if (drift > 3000) {
    failures.push(`世界时间没接上：存的时候 ${built.time}，重进之后 ${reloaded.time}（差 ${drift} 刻）`);
  } else {
    log(`世界时间接上了：${built.time} -> ${reloaded.time}（走了 ${drift} 刻）`);
  }

  if (reloaded.errors.length > 0) {
    failures.push(`重进之后页面报了 ${reloaded.errors.length} 条错误: ${reloaded.errors.join(' | ')}`);
  }
  if (page.exceptions.length > 0) {
    failures.push(`未捕获异常: ${page.exceptions.join(' | ')}`);
  }

  if (failures.length === 0) log(`结构、光照(${built.lights.join(' ')})与时间全部还原`);
} catch (err) {
  failures.push(String(err && err.stack ? err.stack : err));
} finally {
  if (page !== null) page.close();
  if (chrome !== null) await chrome.close();
  if (serverProc !== null) serverProc.kill();
}

if (failures.length > 0) {
  console.error(`\n[persist] 失败 ${failures.length} 项:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('[persist] 闸门测试③ 通过');
