/**
 * 把**别的玩家**同步给每个客户端。
 *
 * 复用生物那条链路（S_SpawnMobs / S_MobMoves / S_DestroyEntities）而不是
 * 另开一套玩家实体协议。理由很实际：那条链路已经把"谁看得见谁"这个
 * 最容易出边界 bug 的问题处理干净了（订阅差集），而玩家和生物在这件事上
 * 的规则**一模一样** —— 在我订阅的区块里、且在同一个维度里就看得见。
 *
 * 但玩家**不进** MobManager 的生物表。进了的话它们会被 AI tick、
 * 被刷怪上限计数、被 `killall` 一把清掉，而那三样都不该发生在玩家身上。
 * 所以这里只借包格式，单独走一遍差集。
 *
 * ## 与 knownMobs 共用一个集合行不行
 *
 * 不行。两边各算各的差集，共用的话后跑的那个会把前一个刚加进去的 id
 * 全判成"不在我的 seen 里"，于是每刻发一遍销毁 —— 这正是
 * ServerPlayer 上 knownItems / knownMobs 分成两个集合的原因，
 * 玩家是第三个。
 */
import type { ServerCore } from '../server-core.ts';
import type { ServerPlayer } from './server-player.ts';
import {
  S_SpawnMobs, S_MobMoves, S_DestroyEntities,
  ENTITY_POS_SCALE, SPAWN_MOB_STRIDE, MOB_MOVE_STRIDE,
} from '../../core/net/packets.ts';
import { MobType } from '../../content/mobs.ts';

/** 上一次广播过的位置，用来只发动了的那些 */
const lastSent = new WeakMap<ServerPlayer, { x: number; y: number; z: number }>();

export function broadcastPlayers(core: ServerCore): void {
  const all = [...core.eachPlayer()];
  // 单人时一个字节都不发。这条判断值得单独写一行 ——
  // 单人是绝大多数情况，而下面那两层循环是 O(玩家²)
  if (all.length < 2) {
    for (const p of all) {
      if (p.knownPlayers.size > 0) sendDestroys(p, [...p.knownPlayers]);
      p.knownPlayers.clear();
    }
    return;
  }

  for (const viewer of all) {
    const spawns: ServerPlayer[] = [];
    const moves: ServerPlayer[] = [];
    const seen = new Set<number>();

    for (const other of all) {
      if (other === viewer) continue;
      if (other.dimension !== viewer.dimension) continue;
      if (!viewer.isSubscribed(Math.floor(other.x) >> 4, Math.floor(other.z) >> 4)) continue;
      seen.add(other.entityId);
      if (viewer.knownPlayers.has(other.entityId)) {
        const last = lastSent.get(other);
        if (last === undefined
          || Math.abs(last.x - other.x) > 0.01
          || Math.abs(last.y - other.y) > 0.01
          || Math.abs(last.z - other.z) > 0.01) moves.push(other);
      } else {
        spawns.push(other);
        viewer.knownPlayers.add(other.entityId);
      }
    }

    const destroys: number[] = [];
    for (const id of viewer.knownPlayers) if (!seen.has(id)) destroys.push(id);
    for (const id of destroys) viewer.knownPlayers.delete(id);

    if (spawns.length > 0) {
      const buf = new DataView(new ArrayBuffer(spawns.length * SPAWN_MOB_STRIDE));
      spawns.forEach((p, i) => {
        const o = i * SPAWN_MOB_STRIDE;
        buf.setUint32(o, p.entityId, true);
        buf.setUint8(o + 4, MobType.PLAYER);
        buf.setUint8(o + 5, 0);
        buf.setInt32(o + 6, Math.round(p.x * ENTITY_POS_SCALE), true);
        buf.setInt32(o + 10, Math.round(p.y * ENTITY_POS_SCALE), true);
        buf.setInt32(o + 14, Math.round(p.z * ENTITY_POS_SCALE), true);
        buf.setInt16(o + 18, Math.round(p.yaw * 1000), true);
        buf.setInt16(o + 20, Math.round(p.yaw * 1000), true);
        buf.setUint8(o + 22, Math.min(255, Math.round(p.health)));
      });
      viewer.channel.send(S_SpawnMobs, { entries: new Uint8Array(buf.buffer) });
    }

    if (moves.length > 0) {
      const buf = new DataView(new ArrayBuffer(moves.length * MOB_MOVE_STRIDE));
      moves.forEach((p, i) => {
        const o = i * MOB_MOVE_STRIDE;
        buf.setUint32(o, p.entityId, true);
        buf.setInt32(o + 4, Math.round(p.x * ENTITY_POS_SCALE), true);
        buf.setInt32(o + 8, Math.round(p.y * ENTITY_POS_SCALE), true);
        buf.setInt32(o + 12, Math.round(p.z * ENTITY_POS_SCALE), true);
        buf.setInt16(o + 16, Math.round(p.yaw * 1000), true);
        buf.setInt16(o + 18, Math.round(p.yaw * 1000), true);
        // 状态位与生物同义：受伤闪红 / 着火 / （玩家没有引信）/ 死了
        let flags = 0;
        // 玩家没有 hurtTime（那是生物的闪红计时），用无敌帧代替 ——
        // 挨打之后的那 10 刻正是该闪红的时候
        if (p.vitals.invulnerable > 0) flags |= 1;
        if (p.vitals.fireTicks > 0) flags |= 2;
        if (p.health <= 0) flags |= 8;
        buf.setUint8(o + 20, flags);
        buf.setUint8(o + 21, Math.min(255, Math.max(0, Math.round(p.health))));
      });
      viewer.channel.send(S_MobMoves, { entries: new Uint8Array(buf.buffer) });
    }

    if (destroys.length > 0) sendDestroys(viewer, destroys);
  }

  for (const p of all) lastSent.set(p, { x: p.x, y: p.y, z: p.z });
}

function sendDestroys(viewer: ServerPlayer, ids: readonly number[]): void {
  const buf = new DataView(new ArrayBuffer(ids.length * 4));
  ids.forEach((id, i) => buf.setUint32(i * 4, id, true));
  viewer.channel.send(S_DestroyEntities, { entries: new Uint8Array(buf.buffer) });
}

/** 有人下线：所有认识他的人都要收到销毁包 */
export function forgetPlayer(core: ServerCore, gone: ServerPlayer): void {
  for (const viewer of core.eachPlayer()) {
    if (viewer === gone) continue;
    if (!viewer.knownPlayers.delete(gone.entityId)) continue;
    sendDestroys(viewer, [gone.entityId]);
    // 立刻 flush。下线不是在 tick 里发生的（socket 一断就走这条路），
    // 等下一次 tick 末尾统一 flush 的话，中间那 50ms 里别人屏幕上
    // 还站着一具躯壳 —— 而如果服务端正好在收尾，那就永远不发了
    viewer.channel.flush();
  }
}
