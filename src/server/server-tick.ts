/**
 * 一个服务端刻里发生什么，按什么顺序。
 *
 * 从 server-core.ts 里分出来的（那个文件到了 612 行、越过 600 硬上限），
 * 但这个文件的价值不只是腾地方：**顺序本身就是设计**。
 *
 * 每一步为什么排在这个位置，下面逐条写了理由。改动顺序前先读那些理由 ——
 * 它们大多是被具体的 bug 换来的（方块变更晚一刻广播、光照没算完就推送、
 * 熔炉点火赶不上这一刻的光照）。
 */
import type { ServerCore } from './server-core.ts';
import { S_BlockUpdate, S_TimeUpdate, S_ServerStats, S_Weather, S_Lightning } from '../core/net/packets.ts';
import { chunkKey } from '../core/world/chunk.ts';
import { Dimension } from '../core/world/dimension.ts';
import type { ServerPlayer } from './player/server-player.ts';
import { advanceDigging } from './player/block-interaction.ts';
import { tickBlockEntities } from './world/block-entity-tick.ts';
import { runScheduledTick } from './world/block-ticks.ts';
import { runRandomTicks } from './world/random-ticks.ts';
import { runWeatherTick } from './world/weather-tick.ts';
import { tickItems, broadcastItems } from './entity/item-manager.ts';
import { tickArrows } from './entity/combat.ts';
import { tickVitals } from './player/player-vitals.ts';
import { broadcastPlayers } from './player/player-sync.ts';
import { tickPortal } from './world/portal-manager.ts';
import { tickEndPortal } from './world/end-portal.ts';
import { tickDragonFight } from './entity/dragon.ts';
import type { ServerWorld } from './world/server-world.ts';

export function runServerTick(core: ServerCore): void {
  core.tickCount++;
  // 主世界推进昼夜；其余维度只跟着涨 worldAge。
  //
  // 下界与末地没有天光，昼夜在那里没有任何后果，但 worldAge 是
  // 计划刻队列的时间轴 —— 不涨的话，下界里的水/岩浆/沙子会**永远**
  // 停在原地，而且症状是"下界的流体不动"，很难联想到时间上
  core.world.advanceTime();
  for (const w of core.loadedWorlds()) {
    if (w !== core.world) w.advanceTimeOnly();
    w.resetGenerationBudget();
    // 先收下 gen worker 这一轮送到的区块，再决定要不要下新单
    w.intakeGenerated();
  }

  // 挖掘进度：服务端自己算，每 tick 推进一步。
  //
  // 必须排在下面 drainChanges 之前 —— 否则这一 tick 破坏的方块要等到
  // **下一** tick 才广播出去，玩家会看到挖穿后方块还杵在那里闪一下。
  for (const player of core.eachPlayer()) advanceDigging(core, player);

  // 区块流水线：先生成，再算光照，最后才推送。
  // 顺序不能颠倒 —— 先推送的话客户端拿到的是光照全 0 的区块。
  const prepared: { player: ServerPlayer; world: ServerWorld; keys: number[] }[] = [];
  for (const player of core.eachPlayer()) {
    const w = core.worldOf(player.dimension);
    player.updateSubscriptions(w);
    const keys = player.prepareChunks(w);
    if (keys.length > 0) prepared.push({ player, world: w, keys });
  }

  // 计划刻：流体流动、沙子下落、火蔓延、TNT 引爆。
  //
  // 排在方块实体之前，因为它们改的是**方块**，而方块变更要赶上
  // 这一刻的光照重算与广播；排在挖掘之后，因为挖掉一格会当场排出
  // 一批新的计划刻（周围的水要重新流），那些该在下一刻才跑
  runScheduledTicks(core);

  // 随机刻：作物生长、草蔓延、树苗成树、雪冰融化。
  // 与计划刻分开：计划刻是"我知道 N 刻之后要做什么"，
  // 随机刻是"这件事迟早会发生但没人知道什么时候"
  if (core.randomTicks) {
    for (const w of core.loadedWorlds()) runRandomTicks(w);
  }

  // 天气：状态机推进 + 闪电/积雪。
  //
  // 挂在 randomTicks 这个开关下面，和随机刻同进退。理由一样：
  // 截图回归要的是"同一个种子跑两次得到同一个世界"，而一场雨会点着树、
  // 铺上雪 —— 那是真正的世界变更，两次跑到的时刻不同结果就不同
  if (core.randomTicks) {
    core.world.weather.tick(core.world.random);
    for (const s of runWeatherTick(core.world)) {
      for (const player of core.eachPlayer()) {
        if (!player.isSubscribed(s.x >> 4, s.z >> 4)) continue;
        player.channel.send(S_Lightning, { x: s.x, y: s.y, z: s.z });
      }
    }
    broadcastWeather(core);
  }

  // 方块实体（熔炉）。排在挖掘之后、光照之前：熔炉点火会换方块 id，
  // 那是一次真正的方块变更，得赶上这一刻的光照与广播
  tickBlockEntities(core);

  // 玩家的生存状态：环境伤害、饥饿、回血。
  // vitalsCtx.world 要指到**这个玩家所在的**世界 —— 固定指主世界的话，
  // 下界里的玩家会按主世界同坐标的方块判断"是不是泡在水里"
  for (const player of core.eachPlayer()) {
    core.setVitalsWorld(core.worldOf(player.dimension));
    tickVitals(player, player.vitals, core.vitalsCtx);
  }

  // 传送门：站够时间就走。排在生存之后 —— 传送会换掉玩家的世界，
  // 这一刻剩下的步骤都该看到新的那个
  for (const player of core.eachPlayer()) {
    tickPortal(core, player);
    tickEndPortal(core, player);
  }

  // 掉落物：物理、合并、拾取。**每个维度各推各的** ——
  // 只推主世界的话，玩家在下界挖的矿会永远悬在原地不动，也不会被捡起来
  for (const w of core.loadedWorlds()) tickItems(core, w);

  // 生物：AI、物理、生成、同步
  core.mobs.tick();
  // 龙战排在生物之后：龙的位置这一刻已经算完了，
  // 治疗与俯冲判定要看的是新位置
  tickDragonFight(core);
  tickArrows(core);
  // 别的玩家。与生物同一条链路，但单独走一遍差集（见 player-sync.ts）
  broadcastPlayers(core);

  // 光照重算（M4 会换成局部增量）
  for (const w of core.loadedWorlds()) w.updateLighting();

  for (const entry of prepared) entry.player.sendPreparedChunks(entry.world, entry.keys);

  // 方块变更广播 —— 只发给**同一维度里**订阅了对应区块的玩家。
  // 不看维度的话，主世界挖一格会在下界的同名坐标上也变成空气
  for (const w of core.loadedWorlds()) {
    const changes = w.drainChanges();
    if (changes.length === 0) continue;
    for (const player of core.eachPlayer()) {
      if (player.dimension !== w.dimension) continue;
      for (const c of changes) {
        if (!player.isSubscribed(c.x >> 4, c.z >> 4)) continue;
        player.channel.send(S_BlockUpdate, { x: c.x, y: c.y, z: c.z, state: c.state });
      }
    }
  }

  // 掉落物的出生 / 移动 / 销毁
  for (const w of core.loadedWorlds()) broadcastItems(core, w, w.drainUnloadedItems());

  // 服务端状态：每 tick 都发。它很小（10 字节），但让主线程随时知道
  // 服务端还有多少活没干完 —— 这是 waitForIdle 判定世界安定的必要依据。
  const pending = core.pendingChunkCount();
  const loaded = core.world.loadedCount;
  for (const player of core.eachPlayer()) {
    player.channel.send(S_ServerStats, {
      tick: core.tickCount,
      pendingChunks: Math.min(65535, pending),
      loadedChunks: Math.min(65535, loaded),
      tickMicros: Math.min(65535, Math.round(core.lastTickMs * 100)),
    });
  }

  // 时间同步
  if (core.tickCount % core.timeSyncInterval === 0) {
    for (const player of core.eachPlayer()) {
      player.channel.send(S_TimeUpdate, {
        worldAge: BigInt(core.world.worldAge),
        timeOfDay: BigInt(core.world.timeOfDay),
      });
    }
  }

  // 卸载没人看的区块。
  //
  // 每 tick 都做，不做成"每 100 tick 一次"。原因不是性能而是**确定性**：
  // 周期性任务会让世界在某个 tick 突然少掉一批区块，而截图恰好落在
  // 那一下的前面还是后面，取决于机器快慢 —— 同一份代码截出来的画面
  // 时而多两个区块时而少两个。实测就是这么在 skyline 上飘的：
  // 连拍六张，第五张开始哈希变了。
  //
  // 保留范围本来就取视距 +2，有滞回，每 tick 扫不会造成反复卸载重建；
  // 代价是几百次距离比较，相对生成一个区块的 11.6 ms 可以忽略。
  unloadDistantChunks(core);

  // 每 tick 一次 flush：一个 tick 内产生的所有包合成一条消息发出
  for (const player of core.eachPlayer()) player.channel.flush();
}


/**
 * 跑掉这一刻到期的计划刻。
 *
 * 有上限（队列的 drainDue 默认 1000 条）：一片大水或者一个红石时钟能让
 * 到期条目在一刻里堆到几万，全做完会让服务端停摆几百毫秒。做不完的留在
 * 队列里下一刻接着做 —— 表现是水流得慢一点，而不是整个世界卡一下。
 */
function runScheduledTicks(core: ServerCore): void {
  for (const w of core.loadedWorlds()) {
    const due = w.scheduled.drainDue(w.worldAge);
    for (const t of due) {
      runScheduledTick(
        w, t.x, t.y, t.z, t.blockId,
        (x, y, z, power) => { core.explode(x, y, z, power, -1, w); },
      );
    }
  }
}

/**
 * 卸载没有任何玩家需要的区块。
 *
 * 必须有这一步：prepareChunks 会连同 3×3 邻域一起生成（为了让天光收敛），
 * 那些邻域区块从来没被"订阅"过，光靠订阅差集永远清不掉它们 ——
 * 服务端会一直往上堆区块，跑久了就是内存泄漏。
 *
 * 保留范围取视距 +2：比玩家实际能看到的略大一圈，这样在边界来回走动时
 * 不会反复卸载又重新生成（那比多留几个区块贵得多）。
 */
function unloadDistantChunks(core: ServerCore): void {
  // 保留集按**维度**分开算。合成一个集合的话，主世界玩家脚下的区块
  // 会保住下界同坐标的区块，于是去过一次下界就再也不卸载了
  const keep = new Map<number, Set<number>>();
  for (const player of core.eachPlayer()) {
    let set = keep.get(player.dimension);
    if (set === undefined) {
      set = new Set<number>();
      keep.set(player.dimension, set);
    }
    const cx = player.chunkX;
    const cz = player.chunkZ;
    const r = player.viewDistance + 2;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > r * r) continue;
        set.add(chunkKey(cx + dx, cz + dz));
      }
    }
  }
  for (const w of core.loadedWorlds()) {
    const set = keep.get(w.dimension) ?? EMPTY_KEYS;
    const doomed: [number, number][] = [];
    for (const chunk of w.store.chunkValues()) {
      if (!set.has(chunk.key)) doomed.push([chunk.cx, chunk.cz]);
    }
    // 每刻最多卸这么多。
    //
    // 加维度之前这个上限不需要：玩家一步只跨一个区块，一刻要卸的
    // 从来不超过几十个。换维度之后**整个上一个维度**的几百个区块
    // 会在同一刻全部到期，而卸载要走存档写入与方块实体清理 ——
    // 实测那一下能让服务端停摆几秒，表现是"换到末地时指令超时"。
    //
    // 与 generationQuota 同一个道理：配额不改变总工作量，只决定它怎么摊。
    const limit = Math.min(doomed.length, UNLOAD_PER_TICK);
    for (let i = 0; i < limit; i++) {
      const d = doomed[i]!;
      w.unloadChunk(d[0], d[1]);
    }
  }
}

/** 没有玩家的维度，保留集是空的 —— 里面的区块全部卸掉 */
const EMPTY_KEYS: ReadonlySet<number> = new Set<number>();

/** 每刻最多卸载几个区块。见 unloadDistantChunks 里的理由 */
const UNLOAD_PER_TICK = 24;

/**
 * 天气变了才广播。
 *
 * 强度每刻都在 ±0.01 地爬，量化到 0..100 之后大约每刻都会变一档 ——
 * 但那只在淡入淡出的那 5 秒里发生，其余时间一个包都不发。
 * 每刻无脑发的话，一个静止的世界也会持续吐包，而它 99.9% 的时间
 * 携带的是同一个数。
 */
function broadcastWeather(core: ServerCore): void {
  const w = core.world.weather.snapshot();
  const rain = Math.round(w.rainStrength * 100);
  const thunder = Math.round(w.thunderStrength * 100);
  if (rain === core.lastSentRain && thunder === core.lastSentThunder) return;
  core.lastSentRain = rain;
  core.lastSentThunder = thunder;
  for (const player of core.eachPlayer()) {
    // 天气是**主世界的**。下界与末地不下雨也不打雷（MC 1.0 就是这样），
    // 无差别广播的话主世界一下雨，末地的天上也开始落雨点
    const inOverworld = player.dimension === Dimension.OVERWORLD;
    player.channel.send(S_Weather, {
      rain: inOverworld ? rain : 0,
      thunder: inOverworld ? thunder : 0,
    });
  }
}
