import { runCraftChain, buildGallery, buildShapeRow } from './debug/scene-commands.ts';
/**
 * 服务端指令。
 *
 * 从 server-core 里分出来的：那个文件顶到了 600 行的硬上限。
 * 分界线很自然 —— 指令是**自动化与调试的入口**，不是游戏逻辑的一部分，
 * 正常游玩一条都不会走到。
 *
 * 所有指令都必须能安全地接收垃圾输入：`__mc` 与测试会往这里灌各种东西，
 * 一条坏指令把服务端打挂的话，整套自动化就瞎了。
 */
import type { ServerCore } from './server-core.ts';
import type { ServerPlayer } from './player/server-player.ts';
import { S_CommandResult, S_TimeUpdate, S_Weather } from '../core/net/packets.ts';
import { packState, stateId } from '../core/world/chunk.ts';
import { WORLD_HEIGHT } from '../core/constants.ts';
import { ARMOR_SLOTS, MAIN_SLOTS, HOTBAR_SLOTS } from './player/player-inventory.ts';
import { makeStack } from '../core/item/item-def.ts';
import { giveToPlayer, syncInventory } from './player/inventory-actions.ts';
import { damagePlayer, respawnPlayer } from './entity/combat.ts';
import { DamageKind } from './player/player-vitals.ts';
import { Dimension, convertCoords } from '../core/world/dimension.ts';
import { placeInDimension } from './world/portal-manager.ts';
import { enterTheEnd } from './world/end-portal.ts';

export function handleCommand(
core: ServerCore,
player: ServerPlayer,
value: Record<string, unknown>,
): void {
  const requestId = value['requestId'] as number;
  const text = String(value['text'] ?? '');
  const reply = (ok: boolean, msg: string): void => {
    player.channel.send(S_CommandResult, { requestId, ok, text: msg });
  };

  const parts = text.trim().split(/\s+/);
  const cmd = parts[0] ?? '';
  /**
   * 指令一律作用在**发起者所在的**世界上。
   *
   * 固定用 world 的话，站在下界打 setblock 会往主世界放方块，
   * 而玩家眼前什么都不会发生 —— 那是最难归因的一种"指令没反应"。
   */
  const world = core.worldOf(player.dimension);
  try {
    switch (cmd) {
      case 'setblock': {
        const [, sx, sy, sz, blockName] = parts;
        const state = packState(core.registry.idOf(String(blockName)));
        const ok = world.setBlock(Number(sx), Number(sy), Number(sz), state);
        reply(ok, ok ? 'ok' : '区块未加载');
        return;
      }
      case 'getblock': {
        const [, sx, sy, sz] = parts;
        const state = world.getBlock(Number(sx), Number(sy), Number(sz));
        const id = state & 0xfff;
        reply(true, core.registry.get(id)?.name ?? `未知(${id})`);
        return;
      }
      case 'tp': {
        const [, sx, sy, sz] = parts;
        player.x = Number(sx);
        player.y = Number(sy);
        player.z = Number(sz);
        player.resetSubscriptions();
        reply(true, 'ok');
        return;
      }
      /**
       * `dimension <overworld|nether|end>` —— 直接换维度，供自动化验收。
       *
       * 不走传送门：截图回归要的是"到那边去"，而砌一座门、点火、
       * 站够 4 秒这一串在无头浏览器里要跑一分多钟，且每一步都可能超时。
       * 传送门本身由 tests/server/nether.test.ts 逐步验。
       */
      case 'dimension': {
        const [, name] = parts;
        const to = name === 'nether' ? Dimension.NETHER
          : name === 'end' ? Dimension.END
            : name === 'overworld' ? Dimension.OVERWORLD : null;
        if (to === null) {
          reply(false, '用法: dimension <overworld|nether|end>');
          return;
        }
        if (to === Dimension.END) {
          // 存档还在读就如实说，别假装送到了 —— 自动化验收会照着回复往下走
          if (!enterTheEnd(core, player)) {
            reply(false, '存档还在读，再试一次');
            return;
          }
          reply(true, 'end');
          return;
        }
        const dest = core.worldOf(to);
        const target = convertCoords(player.dimension, to, player.x, player.z);
        // 同理：抢在存档到货前 force 出来的地形会把存过的内容永久顶掉
        if (!dest.areaReadyForForce(target.x, target.z, 0)) {
          reply(false, '存档还在读，再试一次');
          return;
        }
        dest.forceChunk(target.x >> 4, target.z >> 4);
        const y = dest.groundHeightAt(target.x, target.z);
        placeInDimension(core, player, to, { x: target.x, y, z: target.z, axis: 'x' });
        reply(true, `${name} ${target.x} ${y} ${target.z}`);
        return;
      }
      /** `say <文本>` —— 发给所有人。多人模式下唯一的交流手段 */
      case 'say': {
        const said = parts.slice(1).join(' ');
        if (said === '') {
          reply(false, '用法: say <文本>');
          return;
        }
        core.broadcastChat(`<${player.name}> ${said}`);
        reply(true, 'ok');
        return;
      }
      case 'time': {
        const [, sub, val] = parts;
        if (sub === 'set') {
          world.timeOfDay = ((Number(val) % 24000) + 24000) % 24000;
        } else if (sub === 'hold') {
          world.daylightCycle = val !== '1' && val !== 'true';
        }
        // 立刻回传一次，不等下一个同步周期 —— 自动化就是靠这个知道设定生效了
        for (const p of core.eachPlayer()) {
          p.channel.send(S_TimeUpdate, {
            worldAge: BigInt(world.worldAge),
            timeOfDay: BigInt(world.timeOfDay),
          });
        }
        reply(true, String(world.timeOfDay));
        return;
      }
      case 'light': {
        const [, sx, sy, sz] = parts;
        const x = Number(sx), y = Number(sy), z = Number(sz);
        reply(true, `${world.store.getSkyLight(x, y, z)}/${world.store.getBlockLight(x, y, z)}`);
        return;
      }
      case 'hold': {
        // `hold <槽位 0..8>` 或 `hold <物品名>`
        //
        // give 只是把东西放进背包，**不会**换到手上 —— 而挖掘看的是手上
        // 拿的那件。自动化里"给一把铁镐然后去挖钻石矿"因此会拿着上一把
        // 木镐去挖，表现为"铁镐也挖不动钻石矿"，看着像工具分级坏了。
        const [, which] = parts;
        const inv = player.inventory;
        if (/^\d+$/.test(String(which))) {
          inv.selectedHotbar = Math.max(0, Math.min(8, Number(which)));
          reply(true, String(inv.selectedHotbar));
          return;
        }
        // 按名字找：在快捷栏里挑出第一格装着它的
        const wantId = core.registry.hasBlock(String(which))
          ? core.registry.idOf(String(which))
          : core.items.idOf(String(which));
        for (let i = 0; i < HOTBAR_SLOTS; i++) {
          const st = inv.slots[ARMOR_SLOTS + MAIN_SLOTS + i];
          if (st !== undefined && st.id === wantId && st.count > 0) {
            inv.selectedHotbar = i;
            syncInventory(core, player);
            reply(true, String(i));
            return;
          }
        }
        reply(false, `快捷栏里没有 ${String(which)}`);
        return;
      }
      case 'pos': {
        // 服务端眼里玩家在哪、脚下与头顶各是什么。
        //
        // 存在的理由：客户端的 playerState() 是**客户端预测**的位置，
        // 而伤害、触及距离这些判定全部用服务端的位置。两者不一致时，
        // 症状是"我明明站在岩浆里却不掉血"，而光看客户端永远查不出来。
        const fy = Math.floor(player.y);
        const nameAt = (x: number, y: number, z: number): string => {
          const id = stateId(world.getBlock(x, y, z));
          return id === 0 ? 'air' : (core.registry.get(id)?.name ?? `#${id}`);
        };
        const bx = Math.floor(player.x);
        const bz = Math.floor(player.z);
        // y 打到 6 位小数：判定用的是 Math.floor(y)，而 toFixed(2) 会把
        // 11.999999 显示成 "12.00" —— 正好把最要命的那种差别藏起来
        // **把 floor 后的整数也打出来**，不能只打小数位。
        //
        // 原来只打 y.toFixed(6)，理由是"toFixed(2) 会把 11.999999 显示成 12.00"。
        // 方向对，但没解决问题：toFixed(6) 一样会**四舍五入** ——
        // 11.9999996 照样显示成 "12.000000"，而判定用的 Math.floor 得到的是 11。
        // 于是"服务端说我在 12，脚下却是 12 下面那格的方块"，
        // 看着像同一格读出两种结果。真正该打的是判定实际用的那个整数。
        // body= 是**伤害判定实际看的那一串格子**（从 floor(y+0.01) 扫到
        // 头顶）。只打 feet= 会骗人：站在岩浆池底上时 y 是 11.9999996，
        // feet 读到的是池底那块石头，而人整个泡在岩浆里 ——
        // 闸门②卡了很久就是因为诊断信息本身与判定对不上
        const y0 = Math.floor(player.y + 0.01);
        const y1 = Math.floor(player.y + 1.8 - 0.01);
        const body: string[] = [];
        for (let y = y0; y <= y1; y++) body.push(nameAt(bx, y, bz));
        reply(true, `${player.x.toFixed(2)},${player.y.toFixed(6)},${player.z.toFixed(2)}`
          + ` blk=${bx},${fy},${bz}`
          + ` feet=${nameAt(bx, fy, bz)} head=${nameAt(bx, Math.floor(player.y + 1.62), bz)}`
          + ` body=${body.join('/')}`
          + ` hp=${player.vitals.health} fire=${player.vitals.fireTicks}`);
        return;
      }
      case 'held': {
        // 手上拿的是什么。诊断用 —— give 与 hold 是两件事
        const st = player.inventory.held;
        const nm = st.count === 0 ? 'empty'
          : (core.registry.get(st.id)?.name ?? core.items.get(st.id)?.name ?? `#${st.id}`);
        reply(true, `slot=${player.inventory.selectedHotbar} ${nm}x${st.count}`);
        return;
      }
      case 'orescan': {
        // `orescan x0 z0 x1 z1` —— 统计一片区域里各种矿的 Y 分布。
        //
        // 存在的理由是闸门②：整个"下矿"玩法建立在矿物按 Y 带分布上 ——
        // 钻石只在 Y<16，所以往下挖才是一个有意义的目标。这条规则错了
        // 游戏照样能跑，只是"挖矿"这件事失去了全部结构，而那在任何
        // 截图或单项测试里都看不出来。
        const [, ax, az, bx, bz] = parts;
        const x0 = Math.min(Number(ax), Number(bx));
        const x1 = Math.max(Number(ax), Number(bx));
        const z0 = Math.min(Number(az), Number(bz));
        const z1 = Math.max(Number(az), Number(bz));
        if (!Number.isFinite(x0) || !Number.isFinite(z1)) { reply(false, '用法: orescan x0 z0 x1 z1'); return; }
        const ores: Record<string, { min: number; max: number; n: number }> = {};
        for (let x = x0; x <= x1; x++) {
          for (let z = z0; z <= z1; z++) {
            if (!world.isLoaded(x >> 4, z >> 4)) continue;
            for (let y = 0; y < WORLD_HEIGHT; y++) {
              const id = stateId(world.getBlock(x, y, z));
              if (id === 0) continue;
              const name = core.registry.get(id)?.name ?? '';
              if (!name.endsWith('_ore')) continue;
              const e = ores[name] ?? { min: 999, max: -1, n: 0 };
              e.min = Math.min(e.min, y);
              e.max = Math.max(e.max, y);
              e.n++;
              ores[name] = e;
            }
          }
        }
        const out = Object.entries(ores).sort()
          .map(([k, v]) => `${k}=${v.n}@${v.min}-${v.max}`);
        reply(true, out.length === 0 ? 'none' : out.join(' '));
        return;
      }
      case 'weather': {
        // `weather clear|rain|thunder [刻数]`
        //
        // 强度直接拉到位（snapStrength），不等那 5 秒淡入 ——
        // 自动化脚本设完天气紧接着就要截图，等淡入等不起，
        // 而且"等多久算够"又是一个会飘的判断
        const [, mode, ticks] = parts;
        const w = world.weather;
        const dur = ticks === undefined ? 12000 : Number(ticks);
        if (mode === 'clear') w.set(false, false, dur);
        else if (mode === 'rain') w.set(true, false, dur);
        else if (mode === 'thunder') w.set(true, true, dur);
        else {
          const s = w.snapshot();
          reply(true, `${s.raining ? 'rain' : 'clear'}${s.thundering ? '+thunder' : ''} `
            + `${s.rainStrength.toFixed(2)}/${s.thunderStrength.toFixed(2)} `
            + `rainTime=${w.rainTime} thunderTime=${w.thunderTime}`);
          return;
        }
        w.snapStrength();
        // 让下一刻必定广播出去 —— 否则量化后的值恰好没变时收不到包
        core.lastSentRain = -1;
        for (const p of core.eachPlayer()) {
          p.channel.send(S_Weather, {
            rain: Math.round(w.snapshot().rainStrength * 100),
            thunder: Math.round(w.snapshot().thunderStrength * 100),
          });
        }
        reply(true, 'ok');
        return;
      }
      case 'settled': {
        // 自动化用：一次**同步**的服务端状态查询。
        //
        // 不能用 S_ServerStats 代替 —— 那是每隔若干 tick 才发一次的，
        // 相机刚移动完时客户端手里还是移动**之前**的那份统计，
        // 会读到"没有待推送区块"而误判世界已就绪，然后在截图中途
        // 才把新区块补上。指令走的是包队列，服务端处理它时
        // 必定已经处理完了之前的移动包，所以结果一定是新鲜的。
        reply(true, `${player.pendingCount} ${player.subscribedCount} ${world.loadedCount}`);
        return;
      }
      case 'gallery': {
        // 把每一种方块摆成一个阵列，供单张截图回归。
        //
        // 在服务端一次性搭好，而不是让客户端发几十条 setblock ——
        // 那样每条都是一次往返，顺序还会受调度影响，截图就不确定了。
        const [, gx, gy, gz] = parts;
        const ox = Number(gx);
        const oy = Number(gy);
        const oz = Number(gz);
        reply(true, String(buildGallery(core, ox, oy, oz)));
        return;
      }
      case 'shapes': {
        // 只摆非立方体方块，排成一行，供近距离截图。
        // 大阵列图里每个方块只有二十来像素，看不出楼梯朝向反没反。
        const [, sx2, sy2, sz2] = parts;
        reply(true, String(buildShapeRow(core, Number(sx2), Number(sy2), Number(sz2))));
        return;
      }
      case 'fillbox': {
        // 在服务端一次性填一片，而不是让客户端发几百条 setblock ——
        // 那样每一条都要走一轮消息往返，一个 20×20 的平台要几百帧才铺完
        const [, ax, ay, az, bx, by, bz, blockName] = parts;
        const state = packState(core.registry.idOf(String(blockName)));
        let filled = 0;
        for (let x = Math.min(Number(ax), Number(bx)); x <= Math.max(Number(ax), Number(bx)); x++) {
          for (let y = Math.min(Number(ay), Number(by)); y <= Math.max(Number(ay), Number(by)); y++) {
            for (let z = Math.min(Number(az), Number(bz)); z <= Math.max(Number(az), Number(bz)); z++) {
              if (world.setBlock(x, y, z, state)) filled++;
            }
          }
        }
        reply(true, String(filled));
        return;
      }
      case 'countfluid': {
        // 数一数某个立方体里有多少格流体。冒烟测试用它验"水真的流开了"
        const [, ax, ay, az, bx2, by2, bz2] = parts;
        let n = 0;
        for (let x = Math.min(Number(ax), Number(bx2)); x <= Math.max(Number(ax), Number(bx2)); x++) {
          for (let y = Math.min(Number(ay), Number(by2)); y <= Math.max(Number(ay), Number(by2)); y++) {
            for (let z = Math.min(Number(az), Number(bz2)); z <= Math.max(Number(az), Number(bz2)); z++) {
              const id = world.getBlock(x, y, z) & 0xfff;
              if (id >= 8 && id <= 11) n++;
            }
          }
        }
        reply(true, String(n));
        return;
      }
      case 'craftchain': {
        // 闸门测试①用：走一遍最基础的合成链，**全部通过真实的窗口点击**。
        //
        // 不走 give 指令：那只验了"物品表里有这一项"，而这里要验的是
        // "配方在窗口里真的能合出来" —— 摆位、镜像归一化、产物槽、
        // 取走产物时扣材料，整条路都要走一遍。
        const made = runCraftChain(core, player);
        reply(made.length >= 3, made.join(','));
        return;
      }
      case 'respawn': {
        respawnPlayer(core, player);
        reply(true, 'ok');
        return;
      }
      case 'vitals': {
        const v = player.vitals;
        reply(true, `${v.health} ${v.hunger} ${Math.round(v.saturation)} ${player.xp.level}`);
        return;
      }
      case 'damage': {
        // 自动化用：直接扣血，走的是和生物攻击同一条路径（含护甲与死亡处理）
        const [, amount] = parts;
        damagePlayer(core, player, Number(amount ?? 1), player.x + 1, player.z, DamageKind.PHYSICAL);
        reply(true, String(player.vitals.health));
        return;
      }
      case 'spawn': {
        // 自动化与调试用：在指定位置放一只生物
        const [, kind, sx, sy, sz] = parts;
        const x = sx === undefined ? player.x : Number(sx);
        const y = sy === undefined ? player.y : Number(sy);
        const z = sz === undefined ? player.z : Number(sz);
        // 刷在玩家**所在的**维度里。不传的话默认主世界 ——
        // 在下界打这条指令等于什么都没发生（怪刷去了主世界，这边看不见）
        const mob = core.mobs.spawnByName(String(kind), x, y, z, player.dimension);
        reply(mob !== null, mob === null ? `没有这种生物: ${String(kind)}` : String(mob.entityId));
        return;
      }
      case 'killall': {
        // `killall`        清掉生物 + 掉落物 + 箭
        // `killall <种类>` 只清那一种生物
        // `killall items`  只清掉落物
        //
        // 掉落物一定要能清：它们会**上下浮动**，而位置是按 20 Hz 的
        // 累加器插值出来的，累加器吃的是真实耗时。于是一颗遗留在画面里的
        // 掉落物就足以让那一张截图的哈希每次都不一样 —— 表现是某个检查
        // 无缘无故地闪，而它自己什么都没做错，是上一个检查挖方块留下的。
        const [, kind] = parts;
        if (kind === 'items') {
          const n = world.items.size;
          world.items.clear();
          reply(true, String(n));
          return;
        }
        const n = core.mobs.removeAll(kind === undefined ? undefined : String(kind));
        if (kind === undefined) {
          world.items.clear();
          core.arrows.clear();
        }
        reply(true, String(n));
        return;
      }
      case 'mobs': {
        // 当前有多少只，各是什么。断言用
        const counts = new Map<string, number>();
        for (const m of core.mobs.mobs.values()) {
          counts.set(m.def.name, (counts.get(m.def.name) ?? 0) + 1);
        }
        const parts2 = [...counts.entries()].sort().map(([k, v]) => `${k}=${v}`);
        reply(true, parts2.length === 0 ? 'none' : parts2.join(' '));
        return;
      }
      case 'explode': {
        const [, sx, sy, sz, power] = parts;
        core.explode(Number(sx), Number(sy), Number(sz), Number(power ?? 3));
        reply(true, 'ok');
        return;
      }
      /**
       * `give <名字|id> [数量] [附魔]` —— 直接把东西塞进背包。
       *
       * 附魔写成 `id:等级` 用逗号隔开，例如 `give diamond_sword 1 16:5,34:3`
       * （锋利 V + 耐久 III）。附魔的 id 见 core/item/enchantment.ts。
       *
       * 有这一条才能在自动化里验附魔：走附魔台的话要先攒三十级、
       * 摆书架、还得碰运气摇到想要的那一条，验收脚本没法那么玩
       */
      case 'give': {
        const [, what, howMany, ench] = parts;
        const name = String(what);
        const id = core.items.get(0) !== undefined && /^\d+$/.test(name)
          ? Number(name)
          : (core.registry.hasBlock(name) ? core.registry.idOf(name) : core.items.idOf(name));
        const count = Math.max(1, Math.min(640, Number(howMany ?? 1)));
        const stack = makeStack(id, count);
        if (ench !== undefined && ench !== '') {
          const list: { id: number; level: number }[] = [];
          for (const part of ench.split(',')) {
            const [eid, lvl] = part.split(':');
            const n = Number(eid);
            const l = Number(lvl ?? 1);
            if (!Number.isFinite(n) || !Number.isFinite(l)) continue;
            list.push({ id: n, level: Math.max(1, Math.min(5, l)) });
          }
          if (list.length > 0) stack.enchantments = list;
        }
        const left = giveToPlayer(core, player, stack);
        syncInventory(core, player);
        reply(true, `${count - left}`);
        return;
      }
      case 'inv': {
        // 打印背包内容，供断言。
        //
        // 报**名字**而不是裸 id：断言写成 `includes('log')` 是自然的，
        // 而写成 `includes('17')` 既难读又会误命中（117、170 都含 "17"）。
        // 闸门测试①最初就是因为这个报了一次假失败 —— 背包里明明有原木，
        // 但输出是 "31:17x1"，断言找不到 "log"
        const inv = player.inventory;
        const nameOf = (id: number): string =>
          core.registry.get(id)?.name ?? core.items.get(id)?.name ?? `#${id}`;
        const out = inv.slots
          .map((s2, i) => (s2.count > 0 ? `${i}:${nameOf(s2.id)}x${s2.count}` : ''))
          .filter((x) => x !== '')
          .join(',');
        reply(true, out);
        return;
      }
      case 'held': {
        const h = player.inventory.held;
        reply(true, h.count > 0 ? `${h.id}x${h.count}` : 'empty');
        return;
      }
      case 'height': {
        const [, sx, sz] = parts;
        reply(true, String(world.store.getHeight(Number(sx), Number(sz))));
        return;
      }
      case 'stats':
        reply(true, JSON.stringify(core.stats()));
        return;
      default:
        reply(false, `未知指令: ${cmd}`);
    }
  } catch (err) {
    reply(false, err instanceof Error ? err.message : String(err));
  }
}

/**
 * 搭一个方块陈列阵。
 *
 * 每一列放一种方块，带元数据的方块横向排开它的几个代表状态 ——
 * 半砖的上下、楼梯的四个朝向、栅栏的连接、雪层的厚度。
 * 一张截图就能覆盖"所有形状"，而形状错了在截图里是一眼可见的。
 *
 * @returns 摆了多少个方块
 */
/**
 * 原木 -> 木板 -> 木棍 + 工作台 -> 木镐。
 *
 * 每一步都开一个真的窗口、把材料摆进合成格、再从产物槽取走。
 * 返回成功做出来的东西的名字。
 */

// 场景搭建（合成链 / 陈列阵 / 形状行）搬到了 debug/scene-commands.ts —— 见那里的注释
