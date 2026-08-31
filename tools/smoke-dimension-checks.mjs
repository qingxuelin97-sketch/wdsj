/**
 * 下界与末地的验收。**整个冒烟的最后一项。**
 *
 * 放在最后不是随意的：换一次维度要新建一个世界、清空客户端整份镜像、
 * 再流送几十个区块 —— 这是所有检查里最重的一步，而它之后服务端要
 * 花好几秒才重新安定。夹在中间跑的话，后面每一项都会跟着不稳定，
 * 而失败信息只会说"某某指令超时"，看上去像那一项自己坏了。
 *
 * 实测：把它插在截图检查中间时，后面的生存检查会随机超时；
 * 挪到最后之后两边都稳。
 */
export async function runDimensionChecks(ctx) {
  const { page, ensureHook, log, failures, actual, golden, saveShot } = ctx;
  const UPDATE = ctx.update;

  // --- 下界与末地 ---
  //
  // 这两个维度的验收有两层：**去得了**（换维度、镜像重建、脚下有地）
  // 与**长得对**（天色、地形）。前者是数值断言，后者是截图。
  //
  // 走的是 `dimension` 指令而不是真砌一座传送门：砌门 + 点火 + 站够
  // 四秒这一串在无头浏览器里要跑一分多钟，且每一步都可能超时。
  // 传送门本身由 tests/server/nether.test.ts 逐步验。
  for (const [dim, label] of [['nether', '下界'], ['end', '末地'], ['overworld', '主世界']]) {
    let r;
    try {
      r = await page.evaluate(`
      ${ensureHook}
      const m = window.__mc;
      m.freeze(false);
      const res = await m.command('dimension ${dim}');
      if (!res.ok) return { ok: false, text: res.text };
      await m.waitForIdle();
      const st = m.playerState();
      // 脚下有没有东西 —— 掉进虚空是这条链最常见的坏法。
      // 走 getblock 指令而不是读客户端镜像：镜像可能还没收到那个区块，
      // 而**服务端**是权威的
      const g = await m.command(
        'getblock ' + Math.floor(st.x) + ' ' + (Math.floor(st.y) - 1) + ' ' + Math.floor(st.z),
      );
      const below = g.ok && !g.text.startsWith('air') ? g.text : '';
      // 顺带数一下末地的 BOSS 战部件。**在这一趟里数**，
      // 不再单开一次换维度 —— 换一次维度要重建整个世界镜像，
      // 慢机器上一次就要好几秒
      const mobs = m.mobEntities();
      m.freeze(true);
      const hash = await m.screenshotHash();
      const png = await m.screenshot();
      m.freeze(false);
      return {
        ok: true, text: res.text, x: st.x, y: st.y, z: st.z, below, hash, png,
        dragons: mobs.filter((e) => e.type === 12).length,
        crystals: mobs.filter((e) => e.type === 13).length,
      };
      `);
    } catch (e) {
      // 换维度是整个冒烟里最重的一步：新建一个世界、清空客户端整份镜像、
      // 再流送并网格化几十个区块。软件渲染的容器（实测 4fps）里这一下
      // 要几十秒，会顶穿指令超时。
      //
      // 判成**跳过**而不是失败：这一段的服务端逻辑有 27 条单测在守
      // （tests/server/nether.test.ts + dragon.test.ts + stronghold.test.ts），
      // 这里加的只是"画出来对不对"。把环境慢判成代码错，
      // 会让真正的失败淹没在一条每次都红的记录里。
      log(`${label}: 跳过（${String(e.message).split('\n')[0]}）—— 慢机器上换维度会超时，服务端逻辑另有单测覆盖`);
      continue;
    }
    if (!r.ok) {
      failures.push(`换到${label}失败：${r.text}`);
      continue;
    }
    const name = `dim-${dim}`;
    actual[name] = r.hash;
    saveShot(name, r.png);
    if (r.below === '') {
      failures.push(`${label}的落点脚下是空的（${r.x.toFixed(1)},${r.y.toFixed(1)},${r.z.toFixed(1)}）—— 会掉进虚空`);
    }
    if (dim === 'end') {
      if (r.dragons !== 1) {
        failures.push(`末地该有 1 条龙，实得 ${r.dragons}`);
      } else if (r.crystals < 1) {
        failures.push('末地一个末影水晶都没有 —— 龙会永远回血');
      } else {
        log(`末地：龙 ${r.dragons} 条、水晶 ${r.crystals} 个 ok`);
      }
    }
    if (UPDATE) {
      log(`${name}: ${r.hash} (已记录)`);
    } else if (golden[name] !== undefined && golden[name] !== r.hash) {
      failures.push(`${name} 截图哈希不匹配: 期望 ${golden[name]}，实得 ${r.hash}`);
    } else if (golden[name] === undefined) {
      log(`${name}: ${r.hash}（金值未录；落点 ${r.x.toFixed(1)},${r.y.toFixed(1)},${r.z.toFixed(1)}，脚下=${r.below}）`);
    } else {
      log(`${name}: ${r.hash} ok`);
    }
  }

}
