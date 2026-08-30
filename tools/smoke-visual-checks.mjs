/**
 * 冒烟检查里**以截图为断言**的那几项：方块陈列阵、形状近景、
 * 网格收敛、萤石夜景、粒子。
 *
 * 从 smoke-checks.mjs 里分出来的（那个文件到了 602 行、越过 600 硬上限）。
 * 分界线是"断言的是什么"：
 *   smoke-checks.mjs      —— 断言的是**数值与状态**（走了多远、掉了几个、
 *                            界面开没开），截图只是顺带存一张
 *   这里                  —— 断言的**就是那张图**，逐像素哈希比对
 *
 * 分开的实际好处是纪律：这一类检查每一项都会往世界里加东西（摆一阵方块、
 * 搭个平台、点一片火把），而它们**必须把世界还原回去**，否则后面每一张
 * 黄金图都会被上一项污染。放在一起时这条纪律很容易被忘掉 ——
 * 粒子那一项就是这么连累了网格收敛与萤石夜景两项的。
 */

export async function runVisualChecks(ctx) {
  const { page, ensureHook, spawnPos, log, failures, actual, golden, saveShot } = ctx;
  const UPDATE = ctx.update;
  const SPAWN = spawnPos;
  void SPAWN;

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
}
