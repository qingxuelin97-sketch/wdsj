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

    // --- 改一格方块只能引起少数几段重网格化 ---
    //
    // 这是光照增量更新的**性能**验收点。全量重算也能得到正确画面，
    // 但代价是每次放方块都重做几十上百段，帧率会肉眼可见地一顿。
    //
    // 分两种情形，因为它们的合理上界本来就不同：
    //   地下埋一格 —— 四周全是石头，光照本来就是 0，改动纯局部，上界很紧
    //   空中放一格 —— 挡住天光，整列的阴影一路落到地面，天然会波及整根柱子
    const remesh = await page.evaluate(`
      ${ensureHook}
      const m = window.__mc;
      m.freeze(false);
      await m.waitForIdle();
      const s0 = m.stats();
      const x = Math.round(s0.cameraX), z = Math.round(s0.cameraZ);

      // 情形一：地下深处（周围都是实心，光照全 0）
      const buried = { y: 24 };
      const before1 = m.remeshCount();
      buried.ok = await m.setBlock(x, buried.y, z, 'glowstone');
      await m.waitForIdle();
      buried.delta = m.remeshCount() - before1;

      // 情形二：地表之上的空气里放一块石头，挡住天光
      const airY = Math.round(s0.cameraY) + 3;
      const before2 = m.remeshCount();
      const ok2 = await m.setBlock(x, airY, z, 'stone');
      await m.waitForIdle();
      const airDelta = m.remeshCount() - before2;

      // 把刚放的两块撤掉 —— 否则它们会飘在后面每一张截图里
      await m.setBlock(x, buried.y, z, 'stone');
      await m.setBlock(x, airY, z, 'air');
      await m.waitForIdle();

      return { buried, airY, ok2, airDelta };
    `);
    if (!remesh.buried.ok || !remesh.ok2) {
      failures.push('setblock 失败');
    } else {
      // 地下一格：只该动它所在的段和贴着边界的几个邻居
      if (remesh.buried.delta > 4) {
        failures.push(`地下放一格萤石引起了 ${remesh.buried.delta} 段重网格化（上限 4）`);
      } else {
        log(`地下放一格萤石 -> ${remesh.buried.delta} 段重网格化 ok`);
      }
      // 空中一格：整列阴影，8 段 + 边界邻居，但绝不该扩散到全场
      if (remesh.airDelta > 24) {
        failures.push(`空中放一格石头引起了 ${remesh.airDelta} 段重网格化（上限 24）——光照脏化范围失控`);
      } else {
        log(`空中放一格石头 -> ${remesh.airDelta} 段重网格化（整列阴影）ok`);
      }
    }

    // --- 网格必须是"已收敛"的：强制整场重做，画面不能变 ---
    //
    // 这一条抓的是"过期网格"：某个段在邻居还不存在（或已经卸载）时算过一次，
    // 之后再没被重做过。它不会报错、不会掉帧，只是画面上多一片墙或少一片墙，
    // 而且只在特定的加载顺序下出现。
    // 实测这条断言一上来就抓到了两个：区块到达时不重做**斜角**邻居，
    // 以及区块卸载时完全不重做邻居（视距边缘会看穿世界）。
    const converged = await page.evaluate(`
      ${ensureHook}
      const m = window.__mc;
      m.setCanvasSize(640, 360);
      m.freeze(false);
      await m.setTime(6000);
      await m.waitForIdle();
      m.freeze(true);
      const before = await m.screenshotHash();
      m.freeze(false);
      m._remeshAll();
      await m.waitForIdle();
      m.freeze(true);
      const after = await m.screenshotHash();
      m.freeze(false);
      return { before, after };
    `);
    if (converged.before !== converged.after) {
      failures.push(
        `强制重做网格后画面变了：${converged.before} -> ${converged.after}` +
        ' —— 说明有段的网格是过期的（邻居到达或卸载后没被重做）',
      );
    } else {
      log(`网格已收敛：重做前后同为 ${converged.before}`);
    }

    // --- 方块光场景：夜里放一块萤石 ---
    //
    // 前面的昼夜四相只验证了天光。方块光要单独看，因为它走的是另一条
    // 着色路径（暖色曲线），而且只有在天光被压暗时才看得出来 ——
    // 白天满天光会把它整个盖掉。
    const litScene = await page.evaluate(`
      ${ensureHook}
      const m = window.__mc;
      m.setCanvasSize(640, 360);
      m.freeze(false);
      await m.setTime(18000);
      await m.waitForIdle();
      const s0 = m.stats();
      // 萤石放在出生点旁边的地面上
      const gx = Math.round(s0.cameraX) + 2;
      const gz = Math.round(s0.cameraZ) + 2;
      const gy = Math.round(s0.cameraY) - 1;
      await m.setBlock(gx, gy, gz, 'glowstone');

      // 相机摆到斜后方，算出真正对准萤石的 yaw/pitch。
      // 约定见 src/client/camera.ts：yaw 0 朝 +Z，pitch 正值向下看，
      // 前向量是 (-cos(p)sin(y), -sin(p), cos(p)cos(y))。
      const cx2 = gx - 5, cy2 = gy + 3, cz2 = gz - 6;
      const dx = gx - cx2, dy = gy - cy2, dz = gz - cz2;
      const len = Math.hypot(dx, dy, dz);
      const yaw = Math.atan2(-dx, dz);
      const pitch = -Math.asin(dy / len);
      m.setCamera(cx2, cy2, cz2, yaw, pitch, 70);
      await m.waitForIdle();
      m.freeze(true);
      await new Promise(r => setTimeout(r, 60));
      const hash = await m.screenshotHash();
      const png = await m.screenshot();
      m.freeze(false);

      // 光照**数值**断言。截图只能说明"看着像"，数值才能说明算对了。
      const checks = {
        self: await m.checkLight(gx, gy, gz),
        near: await m.checkLight(gx + 1, gy, gz),
        far:  await m.checkLight(gx + 5, gy, gz),
        out:  await m.checkLight(gx + 16, gy, gz),
      };
      return { hash, png, checks, gx, gy, gz };
    `);
    {
      const c = litScene.checks;
      for (const [name, v] of Object.entries(c)) {
        if (!v.same) {
          failures.push(
            `光照镜像不一致 ${name}: 服务端光 ${v.server} 客户端光 ${v.client}` +
            ` | 列高 服${v.serverHeight} 客${v.clientHeight} | 客户端已加载=${v.loaded}`,
          );
        }
      }
      const blockOf = (v) => Number(String(v.server).split('/')[1]);
      // 萤石发光 15，紧邻一格衰减到 14，五格外 10，十六格外必须已经归零
      if (blockOf(c.self) !== 15) failures.push(`萤石自身方块光应为 15，实得 ${c.self.server}`);
      if (blockOf(c.near) !== 14) failures.push(`萤石旁一格方块光应为 14，实得 ${c.near.server}`);
      if (blockOf(c.far) !== 10) failures.push(`萤石外五格方块光应为 10，实得 ${c.far.server}`);
      if (blockOf(c.out) !== 0) failures.push(`萤石外十六格方块光应为 0，实得 ${c.out.server}`);
      log(`萤石光照 自身${c.self.server} 邻格${c.near.server} 五格${c.far.server} 十六格${c.out.server}（镜像一致）`);
    }
    actual['night-glowstone'] = litScene.hash;
    fs.writeFileSync(
      path.join(OUT_DIR, 'night-glowstone.png'),
      Buffer.from(String(litScene.png).replace(/^data:image\/png;base64,/, ''), 'base64'),
    );
    if (UPDATE) {
      log(`night-glowstone: ${litScene.hash} (已记录)`);
    } else if (golden['night-glowstone'] === undefined) {
      log(`night-glowstone: ${litScene.hash} (无黄金值)`);
    } else if (golden['night-glowstone'] !== litScene.hash) {
      failures.push(`night-glowstone 截图哈希不匹配: 期望 ${golden['night-glowstone']}，实得 ${litScene.hash}`);
    } else {
      log(`night-glowstone: ${litScene.hash} ok`);
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
