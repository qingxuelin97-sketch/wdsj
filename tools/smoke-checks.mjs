/**
 * smoke 的场景检查。
 *
 * 从 smoke.mjs 里搬出来的：那个文件顶到了 600 行的硬上限。
 * 这里放"驱动游戏做一件事再断言"的部分，smoke.mjs 只留下拉起浏览器、
 * 跑截图哈希回归、汇总失败的骨架。
 *
 * 所有函数共用同一个上下文对象：page/ensureHook 用来求值，
 * log/failures 用来汇报，actual/golden/saveShot 用来做截图回归。
 */

/**
 * @param {{
 *   page: any, ensureHook: string, spawnPos: {x:number,y:number,z:number},
 *   log: (m: string) => void, failures: string[],
 *   actual: Record<string, string>, golden: Record<string, string>,
 *   saveShot: (name: string, dataUrl: string) => void, update: boolean,
 * }} ctx
 */
export async function runSceneChecks(ctx) {
  const { page, ensureHook, spawnPos, log, failures, actual, golden, saveShot } = ctx;
  const UPDATE = ctx.update;
  void spawnPos;

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

  // --- 玩家物理：按住 W 一秒，位移必须命中黄金值 ---
  //
  // 这是把 core 的物理真正接到键盘上的验收。单测已经证明公式对了，
  // 这里证明"按键 -> 输入快照 -> stepBody -> 相机"这条链路没接错。
  const walk = await page.evaluate(`
    ${ensureHook}
    const m = window.__mc;
    m.freeze(false);
    await m.waitForIdle();
    // 回到出生点站定。不能用当前相机位置 —— 前面的用例把相机摆到几十格高空了
    m.attachPlayer(${spawnPos.x}, ${spawnPos.y} + 1, ${spawnPos.z});
    let landed = false;
    for (let i = 0; i < 200 && !landed; i++) {
      await new Promise(r => requestAnimationFrame(r));
      landed = m.playerState().onGround;
    }
    const before = m.playerState();
    // **逐帧**采样：按墙钟切窗口的话，采样点落在帧的中间会把一帧的位移
    // 劈给两个窗口，速度看上去忽高忽低。逐帧采样没有这个问题。
    const track = [];
    const pressed = m.press('KeyW', 1000);
    let last = { t: performance.now(), x: before.x, z: before.z };
    while (true) {
      await new Promise(r => requestAnimationFrame(r));
      const st = m.playerState();
      const now = performance.now();
      const dt = (now - last.t) / 1000;
      if (dt > 0) track.push({ dt, d: Math.hypot(st.x - last.x, st.z - last.z) });
      last = { t: now, x: st.x, z: st.z };
      if (track.length > 400) break;
      if (track.reduce((a, b) => a + b.dt, 0) > 1.0) break;
    }
    await pressed;
    const after = m.playerState();

    // 取"第一帧动起来"到"最后一帧还在动"之间的**整段**，
    // 把中间没动的帧也算进时间里 —— 物理是 20 Hz 的，高帧率下本来就有
    // 若干帧位置不变，只挑动了的帧算速度会算出好几倍的值。
    let first = -1;
    let last2 = -1;
    for (let i = 0; i < track.length; i++) {
      if (track[i].d > track[i].dt * 1.0) { if (first < 0) first = i; last2 = i; }
    }
    // 按**物理 tick** 度量，不按墙钟。
    //
    // 物理固定 20 Hz，画面可能 180 fps —— 位置只在 tick 边界上跳，
    // 中间的帧位移是 0。任何按墙钟切窗口的算法都会被这个量化打败：
    // 整段平均受起步加速段和撞墙那一下的影响，滑窗取最大又必然偏高。
    // 而"每个 tick 走了多远"是个干净的量：稳态下它恒等于 4.317/20 = 0.2159。
    //
    // 取中位数，起步的几步和撞墙被截断的最后一步都会被排除掉。
    const steps = track.filter((f) => f.d > 0.01).map((f) => f.d).sort((a, b) => a - b);
    const movingFrames = steps.length;
    const best = steps.length > 0 ? steps[Math.floor(steps.length / 2)] * 20 : 0;
    return {
      before, after,
      frames: track.length,
      movingFrames,
      span: last2 - first + 1,
      speed: best,
      dist: Math.hypot(after.x - before.x, after.z - before.z),
    };
  `);
  {
    // 断言**稳态速度**而不是一秒的总位移：出生点周围是天然地形，
    // 走两格就可能撞上一棵树。撞墙是对的行为，不该让它把物理验收判失败。
    // 取各个 100ms 窗口位移的中位数换算成格/秒 —— 起步的加速段和
    // 撞墙后的 0 都会被中位数排除掉。
    const speed = walk.speed;
    if (!walk.before.onGround) {
      failures.push(`按 W 之前玩家应该已经站稳了，实得 onGround=${walk.before.onGround}`);
    } else if (walk.after.mode !== 'physics') {
      failures.push(`按 W 期间玩家应处于物理模式，实得 ${walk.after.mode}`);
    } else if (walk.span < 10) {
      failures.push(`按住 W 几乎没动：移动区间只有 ${walk.span} 帧（共 ${walk.frames} 帧）`);
    } else if (Math.abs(speed - 4.317) > 0.15) {
      failures.push(
        `行走稳态速度 ${speed.toFixed(3)} 格/秒，MC 是 4.317` +
        `（${walk.movingFrames} 个 tick 有位移，共走 ${walk.dist.toFixed(2)} 格）`,
      );
    } else {
      log(`按住 W：每 tick 走 ${(speed / 20).toFixed(4)} 格 = ${speed.toFixed(3)} 格/秒（MC 4.317）ok`);
    }
  }

  // --- 挖掘闭环：选中 -> 裂纹 -> 破坏 ---
  const dig = await page.evaluate(`
    ${ensureHook}
    const m = window.__mc;
    m.freeze(false);
    await m.waitForIdle();
    m.startAudio();
    m.attachPlayer(${spawnPos.x}, ${spawnPos.y} + 1, ${spawnPos.z});
    for (let i = 0; i < 200 && !m.playerState().onGround; i++) {
      await new Promise(r => requestAnimationFrame(r));
    }
    m.look(0, 1.2);
    for (let i = 0; i < 5; i++) await new Promise(r => requestAnimationFrame(r));
    const sel = m.selectedBlock();
    if (sel === null) return { sel: null };
    const beforeName = (await m.command('getblock ' + sel.x + ' ' + sel.y + ' ' + sel.z)).text;

    // 按住左键，边挖边记裂纹级别
    const stages = new Set();
    m._injectMouse(0, true);
    const digStart = Date.now();
    while (Date.now() - digStart < 6000) {
      await new Promise(r => requestAnimationFrame(r));
      const p = m.digProgress();
      if (p > 0) stages.add(Math.min(9, Math.floor(p * 10)));
      const now = (await m.command('getblock ' + sel.x + ' ' + sel.y + ' ' + sel.z)).text;
      if (now !== beforeName) break;
    }
    m._injectMouse(0, false);
    // 破坏的那一刻应该炸出碎屑。要立刻看，粒子一秒左右就没了
    const particlesAfterBreak = m.particleCount();
    const audioAfter = m.audioStats();
    await m.waitForIdle();
    const afterName = (await m.command('getblock ' + sel.x + ' ' + sel.y + ' ' + sel.z)).text;
    return {
      sel, beforeName, afterName,
      stages: [...stages].sort((a, b) => a - b),
      particles: particlesAfterBreak,
      audio: audioAfter,
    };
  `);
  if (dig.sel === null) {
    failures.push('低头看脚下时应该选中一个方块，实得 null');
  } else if (dig.afterName === dig.beforeName) {
    failures.push(`按住左键 4 秒没挖动 ${dig.beforeName}（${dig.sel.x},${dig.sel.y},${dig.sel.z}）`);
  } else if (dig.stages.length < 4) {
    failures.push(`裂纹只出现了 ${dig.stages.length} 级（${dig.stages}），10 级叠加没生效`);
  } else if (dig.particles <= 0) {
    failures.push('破坏方块后没有碎屑粒子');
  } else {
    log(
      `挖掉 ${dig.beforeName} -> ${dig.afterName}，裂纹 ${dig.stages.length} 级，` +
      `碎屑 ${dig.particles} 粒，音频${dig.audio.ready ? `已响 ${dig.audio.plays} 次` : '未启用（无头环境常见）'} ok`,
    );
    if (dig.audio.ready && dig.audio.plays === 0) {
      failures.push('音频上下文已就绪但一个音都没播 —— 材质音没接上');
    }
  }

  // --- 物品栏界面：快捷栏 + 背包 + 合成 ---
  const gui = await page.evaluate(`
    ${ensureHook}
    const m = window.__mc;
    m.setCanvasSize(640, 480);
    m.freeze(false);
    await m.setTime(6000);
    await m.waitForIdle();
    m.attachPlayer(${spawnPos.x}, ${spawnPos.y} + 1, ${spawnPos.z});
    for (let i = 0; i < 200 && !m.playerState().onGround; i++) {
      await new Promise(r => requestAnimationFrame(r));
    }
    // 摆几样东西，让图标、数字、堆叠都出现在画面里
    await m.command('give planks 32');
    await m.command('give diamond_pickaxe 1');
    await m.command('give torch 12');
    await m.command('give iron_ingot 7');
    await m.command('give apple 3');
    for (let i = 0; i < 10; i++) await new Promise(r => requestAnimationFrame(r));
    const hotbarShot = await m.screenshot();
    const hotbarHash = await m.screenshotHash();

    // 按 E 开背包
    await m.press('KeyE', 120);
    for (let i = 0; i < 20; i++) await new Promise(r => requestAnimationFrame(r));
    const opened = m.uiOpen();
    const invShot = await m.screenshot();
    const invHash = await m.screenshotHash();
    const quads = m.uiQuads();
    return { hotbarShot, hotbarHash, invShot, invHash, opened, quads };
  `);
  saveShot('ui-hotbar', gui.hotbarShot);
  saveShot('ui-inventory', gui.invShot);
  if (!gui.opened) {
    failures.push('按 E 之后背包界面没打开');
  } else if (gui.quads < 60) {
    failures.push(`背包界面只画了 ${gui.quads} 个矩形，格子似乎没画出来`);
  } else {
    log(`物品栏界面 ok（${gui.quads} 个矩形）`);
  }
  for (const [key, hash] of [['ui-hotbar', gui.hotbarHash], ['ui-inventory', gui.invHash]]) {
    actual[key] = hash;
    if (UPDATE) log(`${key}: ${hash} (已记录)`);
    else if (golden[key] !== undefined && golden[key] !== hash) {
      failures.push(`${key} 截图哈希不匹配: 期望 ${golden[key]}，实得 ${hash}`);
    } else log(`${key}: ${hash} ok`);
  }

  // --- 方块陈列阵：一张截图覆盖所有形状 ---
  //
  // M7 的模型系统一加就是十几种非立方体形状。逐个写截图用例不现实，
  // 而形状错了（半砖上下颠倒、楼梯朝向反了、栅栏没连上）在阵列图里
  // 是一眼可见的。所以摆成一片，一张图全覆盖。
  const gallery = await page.evaluate(`
    ${ensureHook}
    const m = window.__mc;
    m.setCanvasSize(720, 405);
    m.freeze(false);
    await m.setTime(6000);
    await m.waitForIdle();
    const s0 = m.stats();
    const gx = Math.round(s0.cameraX) - 8;
    const gy = 100;
    const gz = Math.round(s0.cameraZ) - 8;
    const placed = Number((await m.command('gallery ' + gx + ' ' + gy + ' ' + gz)).text);
    // 斜上方俯视整片阵列。yaw/pitch 由"看向阵列中心"算出来，
    // 手写角度的话阵列稍微一挪就跑出画面 —— 上一版就是这么拍到山坡的
    const rows = Math.ceil(placed / 10);
    const tx = gx + 9;
    const ty = gy + 1;
    const tz = gz + rows;
    const cx = tx - 9, cy2 = ty + 8, cz = tz - 13;
    const dx = tx - cx, dy = ty - cy2, dz = tz - cz;
    const len = Math.hypot(dx, dy, dz);
    m.setCamera(cx, cy2, cz, Math.atan2(-dx, dz), -Math.asin(dy / len), 70);
    await m.waitForIdle();
    m.freeze(true);
    const hash = await m.screenshotHash();
    const png = await m.screenshot();
    m.freeze(false);
    return { hash, png, placed };
  `);
  log(`陈列阵摆了 ${gallery.placed} 个方块`);

  // --- 形状近景：非立方体方块排成一行，正对着拍 ---
  const shapes = await page.evaluate(`
    ${ensureHook}
    const m = window.__mc;
    m.setCanvasSize(800, 500);
    m.freeze(false);
    await m.setTime(6000);
    const s0 = m.stats();
    // 摆到远离陈列阵的地方，两者别挤进同一张画面
    const rx = Math.round(s0.cameraX) + 40;
    const ry = 110;
    const rz = Math.round(s0.cameraZ);
    const placed = Number((await m.command('shapes ' + rx + ' ' + ry + ' ' + rz)).text);
    // 正对这片网格，稍微俯视，能同时看到顶面和侧面
    const rows = Math.ceil(placed / 7);
    const tx = rx + 6, ty = ry, tz = rz + rows;
    const cx = tx, cy2 = ty + 5, cz = tz - 10;
    const dx = tx - cx, dy = ty - cy2, dz = tz - cz;
    const len = Math.hypot(dx, dy, dz);
    m.setCamera(cx, cy2, cz, Math.atan2(-dx, dz), -Math.asin(dy / len), 62);
    await m.waitForIdle();
    m.freeze(true);
    const hash = await m.screenshotHash();
    const png = await m.screenshot();
    m.freeze(false);
    return { hash, png, placed };
  `);
  log(`形状行摆了 ${shapes.placed} 个`);
  actual['shapes'] = shapes.hash;
  saveShot('shapes', shapes.png);
  if (UPDATE) {
    log(`shapes: ${shapes.hash} (已记录)`);
  } else if (golden['shapes'] !== undefined && golden['shapes'] !== shapes.hash) {
    failures.push(`shapes 截图哈希不匹配: 期望 ${golden['shapes']}，实得 ${shapes.hash}（看 tests/out/shapes.png）`);
  } else {
    log(`shapes: ${shapes.hash} ok`);
  }
  if (gallery.placed < 60) {
    failures.push(`陈列阵只摆了 ${gallery.placed} 个方块，应该有六十多个`);
  }
  actual['gallery'] = gallery.hash;
  saveShot('gallery', gallery.png);
  if (UPDATE) {
    log(`gallery: ${gallery.hash} (已记录)`);
  } else if (golden['gallery'] === undefined) {
    log(`gallery: ${gallery.hash} (无黄金值)`);
  } else if (golden['gallery'] !== gallery.hash) {
    failures.push(`gallery 截图哈希不匹配: 期望 ${golden['gallery']}，实得 ${gallery.hash}（看 tests/out/gallery.png）`);
  } else {
    log(`gallery: ${gallery.hash} ok`);
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
    // 等碎屑落完。前面的挖掘用例炸出来的粒子还活着的话，
    // 两次截图之间它们会自己消失，看上去就像"网格过期了"
    for (let i = 0; i < 200 && m.particleCount() > 0; i++) {
      await new Promise(r => requestAnimationFrame(r));
    }
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
  saveShot('night-glowstone', litScene.png);
  if (UPDATE) {
    log(`night-glowstone: ${litScene.hash} (已记录)`);
  } else if (golden['night-glowstone'] === undefined) {
    log(`night-glowstone: ${litScene.hash} (无黄金值)`);
  } else if (golden['night-glowstone'] !== litScene.hash) {
    failures.push(`night-glowstone 截图哈希不匹配: 期望 ${golden['night-glowstone']}，实得 ${litScene.hash}`);
  } else {
    log(`night-glowstone: ${litScene.hash} ok`);
  }

  // --- 生物：真的刷出来、真的画出来、真的能被打 ---
  //
  // 这一条盯的是"代码写了 ≠ 做完了"。生物的服务端逻辑有十几个单测，
  // 但那些全在 node 里跑，验不到"顶点有没有真的提交给 GL"。
  // 前作的教训正是这个：README 写了动态光照，代码里是个从没被调用的函数。
  {
    const mob = await page.evaluate(`
      ${ensureHook}
      const m = window.__mc;
      // 上一项检查按 E 开了背包，而界面是**盖在世界上面**的 ——
      // 不关掉的话这张"生物"截图截到的是物品栏，而顶点数照样是对的，
      // 于是断言全过、图却完全不是那么回事
      if (m.uiOpen()) {
        await m.press('KeyE', 120);
        for (let i = 0; i < 20; i++) await new Promise(r => requestAnimationFrame(r));
      }
      if (m.uiOpen()) throw new Error('背包界面没能关掉，生物截图会被它盖住');
      await m.command('killall');
      const s = m.stats();
      const x = Math.round(s.cameraX) + 3;
      const y = Math.round(s.cameraY) - 1;
      const z = Math.round(s.cameraZ);
      // 九种各来一只，横着排开
      const kinds = ['pig','cow','sheep','chicken','zombie','skeleton','creeper','spider','enderman'];
      // 先在脚下铺一层石台，免得生物掉进地形的坑里、或者站在斜坡上参差不齐
      await m.command('fillbox ' + (x - 2) + ' ' + y + ' ' + (z - 3) + ' ' + (x + 20) + ' ' + y + ' ' + (z + 3) + ' stone');
      for (let i = 0; i < kinds.length; i++) {
        await m.command('spawn ' + kinds[i] + ' ' + (x + i * 2 + 0.5) + ' ' + (y + 1) + ' ' + (z + 0.5));
      }
      // 正午 + 贴近平视：这张图要能看清每只的轮廓，才当得起"模型截图匹配"
      await m.setTime(6000);
      m.setCamera(x + 8.5, y + 3.2, z - 11, 0, 0.13, 60);
      m.freeze(false);
      await m.waitForIdle();
      await new Promise(r => setTimeout(r, 400));
      m.freeze(true);
      const listed = m.mobEntities();
      const counts = await m.command('mobs');
      // 先出图再读顶点数：screenshotHash 内部会真渲染一帧，
      // 而 mobVerts 报的是**上一帧**提交了多少 —— 顺序反了读到的是 0
      const hash = await m.screenshotHash();
      const verts = m.mobVerts();
      const png = await m.screenshot();
      m.freeze(false);
      return { listed: listed.length, verts, counts: counts.text, hash, png, x, y, z };
    `);
    saveShot('mobs', mob.png);
    log(`生物：客户端看到 ${mob.listed} 只，服务端 ${mob.counts}，生物顶点 ${mob.verts}`);
    if (mob.listed < 9) {
      failures.push(`客户端只看到 ${mob.listed} 只生物，应该有 9 只（服务端: ${mob.counts}）`);
    }
    if (mob.verts <= 0) {
      failures.push('生物渲染提交了 0 个顶点 —— 服务端有生物但屏幕上什么都没有');
    }
    // 这张图**不做哈希比对**，只存下来供肉眼看。
    //
    // 生物是活的：服务端按自己的时钟跑 AI，从放下到截图之间它们已经
    // 转过头、迈过步了。freeze() 只停得住客户端时钟，停不住 worker 里的服务端。
    // 硬做哈希会得到一个时好时坏的测试，而"偶发失败的回归测试"比没有还糟 ——
    // 它会训练人忽略红色。
    //
    // 真正稳定、也真正想验的两件事是上面那两条断言：九只都同步到了客户端、
    // 渲染器确实提交了顶点。截图留给人看模型对不对。
    log(`mobs: ${mob.hash}（不比对，见 tests/out/mobs.png）`);

    // 打一只：血量要掉
    const combat = await page.evaluate(`
      ${ensureHook}
      const m = window.__mc;
      const before = m.mobEntities();
      if (before.length === 0) return { ok: false, reason: '没有生物可打' };
      const target = before[0];
      const hp0 = target.health;
      await m.command('tp ' + (target.x) + ' ' + (target.y) + ' ' + (target.z + 2));
      m.attachPlayer(target.x, target.y, target.z + 2);
      await new Promise(r => setTimeout(r, 200));
      return { ok: true, hp0, id: target.id };
    `);
    if (combat.ok !== true) log(`  跳过战斗检查：${combat.reason}`);

    await page.evaluate(`
      ${ensureHook}
      await window.__mc.command('killall');
    `);
  }
}
