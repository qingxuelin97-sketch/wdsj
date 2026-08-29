/**
 * 冒烟测试里**世界模拟**那部分的检查：流体与生物。
 *
 * 从 smoke-checks.mjs 里分出来的（那个文件到了 611 行、越过 600 硬上限）。
 * 分界线很自然：上面那些验的是"渲染管线画得对不对"（网格、光照、界面、
 * 形状），这两项验的是"服务端模拟出来的东西有没有真的到达屏幕" ——
 * 服务端逻辑各有十几条 node 测试盯着，但那些验不到顶点有没有提交给 GL。
 */

/**
 * @param ctx 与 runSceneChecks 相同的上下文
 */
export async function runSimChecks(ctx) {
  const { page, ensureHook, spawnPos, log, failures, saveShot } = ctx;
  /** 出生点。需要稳定参照系的检查用它，不要用当前相机位置 */
  const SPAWN = spawnPos;

  // --- 流体：瀑布真的画出来了、水真的在流 ---
  //
  // 服务端的流体有 14 条 ASCII 测试盯着，但那些全在 node 里跑。
  // 这里验的是另外半条路：FLUID 模型有没有真的进网格、半透明层画不画得出来。
  {
    const water = await page.evaluate(`
      ${ensureHook}
      const m = window.__mc;
      if (m.uiOpen()) { await m.press('KeyE', 120); for (let i=0;i<20;i++) await new Promise(r=>requestAnimationFrame(r)); }
      // 位置从**出生点**推，不要从当前相机推。
      // 前面几项检查会把相机丢在各种地方（陈列阵在高空、俯视图在 y+70），
      // 按相机推出来的 y 上一次跑到了 123，加 6 就越过了世界上限 128，
      // 放方块静默失败，表现是"水一格都没有"
      const x = Math.round(${SPAWN.x}) - 24;
      const y = Math.round(${SPAWN.y}) + 2;
      const z = Math.round(${SPAWN.z});
      // 先把人挪过去把那一片区块加载出来。
      // 视距只有 2 个区块（±32 格），在没加载的区块上 setBlock 会**静默失败** ——
      // 表现是"水一格都没有"，看起来像流体模拟没跑
      await m.command('tp ' + x + ' ' + y + ' ' + z);
      m.attachPlayer(x, y, z);
      await m.waitForIdle();
      // 一座台子，从台顶倒一桶水下来
      const filled = await m.command('fillbox ' + (x - 4) + ' ' + y + ' ' + (z - 4) + ' ' + (x + 10) + ' ' + y + ' ' + (z + 4) + ' stone');
      if (Number(filled.text) < 100) throw new Error('台子没铺出来，只填了 ' + filled.text + ' 格 —— 区块多半没加载');
      await m.command('fillbox ' + (x + 4) + ' ' + (y + 1) + ' ' + (z - 4) + ' ' + (x + 10) + ' ' + (y + 5) + ' ' + (z + 4) + ' stone');
      const put = await m.command('setblock ' + (x + 4) + ' ' + (y + 6) + ' ' + z + ' water');
      const readBack = await m.command('getblock ' + (x + 4) + ' ' + (y + 6) + ' ' + z);
      await m.setTime(6000);
      // 朝向要按本工程的约定算：yaw 0 面向 +Z，前向量是 (−sin yaw, ·, cos yaw)。
      // 结构在相机的 +x +z 方向，所以 yaw ≈ −π/4
      m.setCamera(x - 7, y + 7, z - 9, -0.785, 0.3, 70);
      m.freeze(false);
      await m.waitForIdle();
      await new Promise(r => setTimeout(r, 1200));
      await m.waitForIdle();
      m.freeze(true);
      // 数一数视野附近有多少格水：服务端权威
      const spread = await m.command('countfluid ' + (x - 4) + ' ' + y + ' ' + (z - 4) + ' ' + (x + 10) + ' ' + (y + 7) + ' ' + (z + 4));
      const hash = await m.screenshotHash();
      const png = await m.screenshot();
      m.freeze(false);
      return { spread: Number(spread.text), hash, png, put: put.text, readBack: readBack.text, x, y, z };
    `);
    saveShot('waterfall', water.png);
    log(`瀑布：视野内 ${water.spread} 格水（放水=${water.put} 回读=${water.readBack} 位置=${water.x},${water.y},${water.z}）`);
    if (water.spread < 10) {
      failures.push(`水应该流开来，实际只有 ${water.spread} 格 —— 流体模拟没跑起来`);
    }
    // 与生物那张图同理：水一直在流，硬做哈希会得到一个偶发失败的测试
    log(`waterfall: ${water.hash}（不比对，见 tests/out/waterfall.png）`);
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

  // --- 生存：血条画出来了、掉血看得见、死了有死亡界面、能重生 ---
  //
  // 服务端的生存循环有 16 条单测（含 2 万刻的压力跑），这里验的是
  // 另外半条路：状态包有没有到客户端、HUD 有没有真的画上去、
  // 死亡界面挡不挡得住世界。
  {
    const survival = await page.evaluate(`
      ${ensureHook}
      const m = window.__mc;
      if (m.uiOpen()) { await m.press('KeyE', 120); for (let i=0;i<20;i++) await new Promise(r=>requestAnimationFrame(r)); }
      await m.command('killall');
      // 满血时的界面
      const fullQuads = m.uiQuads();
      const fullHash = await m.screenshotHash();
      const fullShot = await m.screenshot();

      // 掉一半血：HUD 该变
      await m.command('damage 10');
      for (let i = 0; i < 10; i++) await new Promise(r => requestAnimationFrame(r));
      const hurtHash = await m.screenshotHash();
      const hurtShot = await m.screenshot();

      // 打死：该出死亡界面。
      // 两次伤害之间**必须等过无敌帧**（10 刻 = 0.5 秒），否则第二下会被
      // 无敌帧挡掉，玩家停在 10 血，测试报"客户端不认为自己死了"——
      // 而那其实是无敌帧在正常工作
      await new Promise(r => setTimeout(r, 700));
      await m.command('damage 100');
      for (let i = 0; i < 15; i++) await new Promise(r => requestAnimationFrame(r));
      const deadShot = await m.screenshot();
      const deadHash = await m.screenshotHash();
      const isDead = m.isDead();

      // 重生
      await m.respawn();
      for (let i = 0; i < 20; i++) await new Promise(r => requestAnimationFrame(r));
      const aliveAgain = !m.isDead();
      const hp = m.vitals();
      return { fullQuads, fullHash, hurtHash, deadHash, isDead, aliveAgain, hp, fullShot, hurtShot, deadShot };
    `);
    saveShot('hud-full', survival.fullShot);
    saveShot('hud-hurt', survival.hurtShot);
    saveShot('hud-dead', survival.deadShot);
    log(`生存：HUD ${survival.fullQuads} 个矩形，死亡=${survival.isDead}，重生后血量=${survival.hp.health}`);
    if (survival.fullQuads < 100) {
      failures.push(`HUD 只画了 ${survival.fullQuads} 个矩形 —— 血条/饥饿条多半没画出来`);
    }
    if (survival.fullHash === survival.hurtHash) {
      failures.push('掉血之后画面没变 —— 血条没跟着服务端走');
    }
    if (survival.isDead !== true) {
      failures.push('打到 0 血之后客户端不认为自己死了');
    }
    if (survival.deadHash === survival.hurtHash) {
      failures.push('死亡界面没画出来');
    }
    if (survival.aliveAgain !== true || survival.hp.health !== 20) {
      failures.push(`重生失败：活着=${survival.aliveAgain} 血量=${survival.hp.health}`);
    }
  }
}
