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
import { runSimChecks } from './smoke-sim-checks.mjs';
import { runVisualChecks } from './smoke-visual-checks.mjs';

export async function runSceneChecks(ctx) {
  const { page, ensureHook, spawnPos, log, failures, actual, golden, saveShot } = ctx;
  const UPDATE = ctx.update;
  /** 出生点。需要一个**稳定**参照系的检查用它，不要用当前相机位置 */
  const SPAWN = spawnPos;

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

    // 按住左键，边挖边记裂纹级别。
    //
    // 采样与"挖穿了没有"的查询**必须解耦**。原来两件事在同一个循环里，
    // 而查询是一次服务端往返（好几帧）—— 于是采样频率由网络延迟决定，
    // 而不是由帧率决定：快的时候记到 10 级，慢的时候只记到 3 级，
    // 同一份代码时绿时红。而报出来的是"10 级叠加没生效"，
    // 听起来像裂纹功能坏了。
    //
    // 现在每帧采一次进度（纯本地，很便宜），每 10 帧才去问一次服务端。
    const stages = new Set();
    m._injectMouse(0, true);
    const digStart = Date.now();
    for (let i = 0; Date.now() - digStart < 6000; i++) {
      await new Promise(r => requestAnimationFrame(r));
      const p = m.digProgress();
      if (p > 0) stages.add(Math.min(9, Math.floor(p * 10)));
      if (i % 10 === 9) {
        const now = (await m.command('getblock ' + sel.x + ' ' + sel.y + ' ' + sel.z)).text;
        if (now !== beforeName) break;
      }
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
  } else if (dig.stages.length < 8) {
    // 门槛拉到 8：每帧采样的话 10 级基本都能采到，采不到 8 级说明
    // 要么裂纹级数算错了，要么采样又被什么东西拖慢了
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
    await m.command('weather clear');
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

    // 截图前把相机**钉到一个整数位置**上。
    //
    // 这一段是让玩家自己落到地面上的，落点每次会差几厘米：dt 用的是真实
    // 耗时，落地要几帧取决于机器当时多快；服务端的位置校正也会顺手推一下。
    // 在天上还没有云的时候这无所谓 —— 差几厘米，64x64 灰度图上一个像素都不变。
    // 有了云之后就不行了：云的 uv 直接取自相机的世界坐标，几厘米的平移
    // 会让整片天空的渐变整体挪一点，哈希每次都不同。
    //
    // 这里要验的是**界面**，不是玩家落在哪，所以直接钉死。
    const st = m.playerState();
    m.tp(Math.round(st.x), Math.round(st.y * 4) / 4, Math.round(st.z), 0, 0);
    // 把前面几项检查留在世界里的掉落物清掉。
    // 它们会浮动，而浮动相位跟真实耗时走 —— 留一颗在画面里，
    // 这张图的哈希就每次都不一样（挖方块那项检查掉的那块土就是这么来的）
    await m.command('killall items');
    for (let i = 0; i < 5; i++) await new Promise(r => requestAnimationFrame(r));
    const hotbarShot = await m.screenshot();
    const hotbarHash = await m.screenshotHash();

    // 按 E 开背包
    await m.press('KeyE', 120);
    for (let i = 0; i < 20; i++) await new Promise(r => requestAnimationFrame(r));
    const opened = m.uiOpen();
    const invShot = await m.screenshot();
    const invHash = await m.screenshotHash();
    const quads = m.uiQuads();

    // **把界面关掉再走**。
    //
    // 界面是盖在整个世界上面的：不关的话，后面每一项检查截到的都是
    // 这块面板，而不是它们各自想看的东西。方块陈列阵与形状近景那两张图
    // 一直是这样 —— 断言照过，图却完全不是那么回事。
    // 每项检查都该把自己改过的全局状态还回去
    await m.press('KeyE', 120);
    for (let i = 0; i < 20; i++) await new Promise(r => requestAnimationFrame(r));
    const closed = !m.uiOpen();
    return { hotbarShot, hotbarHash, invShot, invHash, opened, quads, closed };
  `);
  saveShot('ui-hotbar', gui.hotbarShot);
  saveShot('ui-inventory', gui.invShot);
  if (gui.closed !== true) {
    failures.push('再按一次 E 之后背包界面没关掉 —— 它会盖住后面所有检查的截图');
  }
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

  await runVisualChecks(ctx);

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
    await m.command('weather clear');
    await m.waitForIdle();
    // 萤石放在**出生点**旁边的地面上。
    //
    // 坐标必须取自 SPAWN，不能取自 m.stats() 的当前相机 ——
    // 这一项跑在一长串检查之后，相机停在哪完全取决于上一项干了什么。
    // 原来写的是当前相机，于是黄金值其实是"上一项恰好把相机留在那儿"
    // 烘出来的：加了 F3 检查（它把相机移回出生点）之后立刻就对不上了，
    // 而报出来的是"萤石夜景变了"，看着像光照坏了。
    //
    // 这个文件开头就写着"需要稳定参照系的检查用 SPAWN，不要用当前相机位置"。
    const gx = Math.round(${SPAWN.x}) + 2;
    const gz = Math.round(${SPAWN.z}) + 2;
    const gy = Math.round(${SPAWN.y}) - 1;
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

  // --- 世界模拟层的检查（流体、生物）搬到了 smoke-sim-checks.mjs ---
  // --- 粒子：火把冒烟、岩浆冒泡 ---
  //
  // 这一项验的是**环境粒子**那条路 —— 没有任何"事件"触发它们，
  // 它们只是世界一直在那儿冒。做法是每刻在相机周围随机采样几百格，
  // 采到火把就冒烟、采到露天岩浆就冒泡（见 client/particle/emitters.ts）。
  //
  // 用 stepParticles 而不是"跑一会儿"：粒子由主循环按真实耗时推进，
  // 跑了多少刻取决于机器多快，两次截出来的烟根本不在一个地方。
  // 那个钩子把随机源复位再跑固定刻数，走的是和正常路径**同一份**
  // 发射器与物理，所以验的是真东西。
  const parts = await page.evaluate(`
    ${ensureHook}
    const m = window.__mc;
    m.setCanvasSize(640, 360);
    m.freeze(false);
    await m.setTime(18000);
    await m.command('weather clear');
    await m.waitForIdle();
    // 搭在**离出生点 200 格**的地方。就地搭的话这片平台、这些火把、
    // 尤其是会流的岩浆会留在世界里，后面每一张黄金图都被它改掉 ——
    // 第一版就是这样，连累了网格收敛与萤石夜景两项检查。
    //
    // 基准同样取 SPAWN 而不是当前相机：取相机的话，这片平台盖在哪
    // 取决于上一项检查把相机留在了哪，黄金值就绑死在检查的**顺序**上。
    // 插一项新检查进去就会让这张图无端变掉。
    const bx = Math.round(${SPAWN.x}) + 200;
    const bz = Math.round(${SPAWN.z}) + 200;
    const by = 80;

    // **先把相机搬过去，等区块加载完，再动手建。**
    // 200 格外的区块根本没加载，setBlock 会直接返回 false ——
    // 而那表现为"一根火把都没插上"，看着像放置坏了
    m.setCamera(bx, by + 2.2, bz - 8, 0, 0.12, 70);
    await m.waitForIdle();

    // 一片平台，插一排火把
    await m.command('fillbox ' + (bx-5) + ' ' + (by-1) + ' ' + (bz-5) + ' '
      + (bx+5) + ' ' + (by-1) + ' ' + (bz+5) + ' stone');
    await m.command('fillbox ' + (bx-5) + ' ' + by + ' ' + (bz-5) + ' '
      + (bx+5) + ' ' + (by+5) + ' ' + (bz+5) + ' air');
    let torches = 0;
    for (let dx = -4; dx <= 4; dx += 2) {
      for (let dz = -2; dz <= 4; dz += 2) {
        if (await m.setBlock(bx + dx, by, bz + dz, 'torch')) torches++;
      }
    }
    // 岩浆坐在一个四面封死、只露顶的坑里 —— 露天才冒泡，封死才不会流出去
    await m.setBlock(bx, by - 1, bz - 4, 'lava');
    await m.waitForIdle();

    // 凑近看。远景里 12 粒烟只有几个像素，截图当"证据"是空的 ——
    // 断言说粒子存在，图上却什么也看不见，那和没验证一样
    m.setCamera(bx - 1.2, by + 1.4, bz - 3.2, 0.35, 0.05, 55);
    await m.waitForIdle();
    m.freeze(true);

    // 跑够刻数让烟飘起来。
    //
    // 采样是**稀疏**的（每刻在 32³ 的盒子里随机挑 420 格），单根火把大约
    // 十几刻才轮到一次 —— MC 也是这么稀疏的，那正是烟一缕一缕而不是
    // 一根柱子的原因。所以要么跑久一点，要么多插几根火把，这里两样都做了。
    // 环境粒子 + 一次爆炸。前者数值上验稀疏采样那条路，
    // 后者在图上留下看得见的一团烟
    m.stepParticles(150, [bx, by + 1.2, bz - 1, 3]);
    const count = m.particleCount();
    m.stepParticles(150);
    const ambientOnly = m.particleCount();
    m.stepParticles(150, [bx, by + 1.2, bz - 1, 3]);
    const hash = await m.screenshotHash();
    const png = await m.screenshot();

    // 再跑一次同样的刻数，应当得到**一模一样**的画面 ——
    // 这是"粒子可复现"的直接证据，不是间接推断
    m.stepParticles(150, [bx, by + 1.2, bz - 1, 3]);
    const hash2 = await m.screenshotHash();

    m.freeze(false);
    return { count, ambientOnly, hash, hash2, png, torches };
  `);

  if (parts.ambientOnly < 5) {
    failures.push(
      `环境粒子太少：${parts.torches} 根火把跑了 150 刻只有 ${parts.ambientOnly} 粒`,
    );
  } else if (parts.hash !== parts.hash2) {
    failures.push(`粒子不可复现：同样跑 40 刻，两次得到 ${parts.hash} 与 ${parts.hash2}`);
  } else {
    log(`粒子：环境 ${parts.ambientOnly} 粒（${parts.torches} 根火把）`
      + ` + 爆炸后共 ${parts.count} 粒，重跑同刻数哈希一致`);
  }
  saveShot('particles', parts.png);
  actual['particles'] = parts.hash;
  if (!UPDATE && golden['particles'] !== undefined && golden['particles'] !== parts.hash) {
    failures.push(`particles 截图哈希不匹配: 期望 ${golden['particles']}，实得 ${parts.hash}`);
  } else {
    log(`particles: ${parts.hash}${golden['particles'] === undefined ? ' (无黄金值)' : ' ok'}`);
  }

  await runSimChecks(ctx);
}
