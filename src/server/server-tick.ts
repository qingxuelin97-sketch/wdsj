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
import { S_BlockUpdate, S_TimeUpdate, S_ServerStats } from '../core/net/packets.ts';
import { chunkKey } from '../core/world/chunk.ts';
import type { ServerPlayer } from './player/server-player.ts';
import { advanceDigging } from './player/block-interaction.ts';
import { tickBlockEntities } from './world/block-entity-tick.ts';
import { runScheduledTick } from './world/block-ticks.ts';
import { runRandomTicks } from './world/random-ticks.ts';
import { tickItems, broadcastItems } from './entity/item-manager.ts';
import { tickArrows } from './entity/combat.ts';
import { tickVitals } from './player/player-vitals.ts';

export function runServerTick(core: ServerCore): void {
  core.tickCount++;
  core.world.advanceTime();
  core.world.resetGenerationBudget();
  // 先收下 gen worker 这一轮送到的区块，再决定要不要下新单
  core.world.intakeGenerated();

  // 挖掘进度：服务端自己算，每 tick 推进一步。
  //
  // 必须排在下面 drainChanges 之前 —— 否则这一 tick 破坏的方块要等到
  // **下一** tick 才广播出去，玩家会看到挖穿后方块还杵在那里闪一下。
  for (const player of core.eachPlayer()) advanceDigging(core, player);

  // 区块流水线：先生成，再算光照，最后才推送。
  // 顺序不能颠倒 —— 先推送的话客户端拿到的是光照全 0 的区块。
  const prepared: { player: ServerPlayer; keys: number[] }[] = [];
  for (const player of core.eachPlayer()) {
    player.updateSubscriptions(core.world);
    const keys = player.prepareChunks(core.world);
    if (keys.length > 0) prepared.push({ player, keys });
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
  if (core.randomTicks) runRandomTicks(core.world);

  // 方块实体（熔炉）。排在挖掘之后、光照之前：熔炉点火会换方块 id，
  // 那是一次真正的方块变更，得赶上这一刻的光照与广播
  tickBlockEntities(core);

  // 玩家的生存状态：环境伤害、饥饿、回血
  for (const player of core.eachPlayer()) {
    tickVitals(player, player.vitals, core.vitalsCtx);
  }

  // 掉落物：物理、合并、拾取
  tickItems(core);

  // 生物：AI、物理、生成、同步
  core.mobs.tick();
  tickArrows(core);

  // 光照重算（M4 会换成局部增量）
  core.world.updateLighting();

  for (const entry of prepared) entry.player.sendPreparedChunks(core.world, entry.keys);

  // 方块变更广播 —— 只发给订阅了对应区块的玩家
  const changes = core.world.drainChanges();
  if (changes.length > 0) {
    for (const player of core.eachPlayer()) {
      for (const c of changes) {
        if (!player.isSubscribed(c.x >> 4, c.z >> 4)) continue;
        player.channel.send(S_BlockUpdate, { x: c.x, y: c.y, z: c.z, state: c.state });
      }
    }
  }

  // 掉落物的出生 / 移动 / 销毁
  broadcastItems(core, core.world.drainUnloadedItems());

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
  const due = core.world.scheduled.drainDue(core.world.worldAge);
  for (const t of due) {
    runScheduledTick(
      core.world, t.x, t.y, t.z, t.blockId,
      (x, y, z, power) => { core.explode(x, y, z, power); },
    );
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
  const keep = new Set<number>();
  for (const player of core.eachPlayer()) {
    const cx = player.chunkX;
    const cz = player.chunkZ;
    const r = player.viewDistance + 2;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > r * r) continue;
        keep.add(chunkKey(cx + dx, cz + dz));
      }
    }
  }
  const doomed: [number, number][] = [];
  for (const chunk of core.world.store.chunkValues()) {
    if (!keep.has(chunk.key)) doomed.push([chunk.cx, chunk.cz]);
  }
  for (const [cx, cz] of doomed) core.world.unloadChunk(cx, cz);
}
