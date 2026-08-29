/**
 * 客户端的生物镜像。
 *
 * 与掉落物那套（client-entities.ts）同一个形状：只是镜像，
 * 由 S_SpawnMobs / S_MobMoves / S_DestroyEntities 驱动，位置按刻插值。
 *
 * 多出来的是**动画状态**：走路摆腿的相位、受伤闪红、苦力怕鼓起。
 * 这些全部由客户端自己按刻推进，服务端只发"在不在这个状态"的一位标志 ——
 * 每刻发一个精确的动画相位既费带宽又没必要，玩家看的是"它在走"而不是
 * "它的腿现在是 37 度"。
 */

export interface ClientMob {
  readonly entityId: number;
  readonly type: number;
  readonly variant: number;
  prevX: number; prevY: number; prevZ: number;
  x: number; y: number; z: number;
  prevYaw: number; prevHeadYaw: number;
  yaw: number; headYaw: number;
  health: number;
  /** 服务端发来的状态位：1 受伤 / 2 着火 / 4 苦力怕鼓起 / 8 正在死 */
  flags: number;
  /** 距离上一个位置包过了几刻。0 表示正在插值 */
  interp: number;
  /**
   * 走路动画的相位，随**实际水平位移**累加。
   *
   * 用位移而不是时间来驱动：站着不动的生物腿就不该动，而按时间推进的话
   * 一群站桩的怪会集体原地踏步。位移驱动还自动让快的生物迈腿更快。
   */
  walkPhase: number;
  /** 鼓起动画 0..1，客户端自己插值 */
  swell: number;
}

/** 位置的定点数精度与包里的一致 */
export class ClientMobs {
  private readonly byId = new Map<number, ClientMob>();
  /** 这一批包里刚点着引信的苦力怕，主循环取走后清空 */
  private readonly justLit: number[] = [];

  /** 取走"刚点着引信"的名单 */
  drainJustLit(): number[] {
    if (this.justLit.length === 0) return [];
    return this.justLit.splice(0, this.justLit.length);
  }

  get size(): number {
    return this.byId.size;
  }

  values(): Iterable<ClientMob> {
    return this.byId.values();
  }

  get(id: number): ClientMob | undefined {
    return this.byId.get(id);
  }

  /** S_SpawnMobs：每项 23 字节 */
  onSpawn(entries: Uint8Array, stride: number, scale: number): void {
    const view = new DataView(entries.buffer, entries.byteOffset, entries.byteLength);
    for (let o = 0; o + stride <= entries.byteLength; o += stride) {
      const id = view.getUint32(o, true);
      const x = view.getInt32(o + 6, true) / scale;
      const y = view.getInt32(o + 10, true) / scale;
      const z = view.getInt32(o + 14, true) / scale;
      const yaw = view.getInt16(o + 18, true) / 1000;
      const headYaw = view.getInt16(o + 20, true) / 1000;
      const existing = this.byId.get(id);
      if (existing !== undefined) {
        existing.x = x; existing.y = y; existing.z = z;
        existing.prevX = x; existing.prevY = y; existing.prevZ = z;
        existing.interp = 1;
        continue;
      }
      this.byId.set(id, {
        entityId: id,
        type: view.getUint8(o + 4),
        variant: view.getUint8(o + 5),
        x, y, z, prevX: x, prevY: y, prevZ: z,
        yaw, headYaw, prevYaw: yaw, prevHeadYaw: headYaw,
        health: view.getUint8(o + 22),
        flags: 0,
        interp: 1,
        walkPhase: 0,
        swell: 0,
      });
    }
  }

  /** S_MobMoves：每项 22 字节 */
  onMove(entries: Uint8Array, stride: number, scale: number): void {
    const view = new DataView(entries.buffer, entries.byteOffset, entries.byteLength);
    for (let o = 0; o + stride <= entries.byteLength; o += stride) {
      const m = this.byId.get(view.getUint32(o, true));
      if (m === undefined) continue;
      m.prevX = m.x; m.prevY = m.y; m.prevZ = m.z;
      m.prevYaw = m.yaw;
      m.prevHeadYaw = m.headYaw;
      m.x = view.getInt32(o + 4, true) / scale;
      m.y = view.getInt32(o + 8, true) / scale;
      m.z = view.getInt32(o + 12, true) / scale;
      m.yaw = view.getInt16(o + 16, true) / 1000;
      m.headYaw = view.getInt16(o + 18, true) / 1000;
      const wasSwelling = (m.flags & 4) !== 0;
      m.flags = view.getUint8(o + 20);
      // 引信刚点着的那一刻标记一下，让主循环放一声嘶声。
      // 放在这里而不是"每刻 flags 有 4 就放"：后者会在鼓起的一秒半里
      // 每刻放一次，三十声叠在一起
      if (!wasSwelling && (m.flags & 4) !== 0) this.justLit.push(m.entityId);
      m.health = view.getUint8(o + 21);
      m.interp = 0;
      // 走路相位按这一刻的水平位移推进
      m.walkPhase += Math.hypot(m.x - m.prevX, m.z - m.prevZ);
    }
  }

  onDestroy(entries: Uint8Array): void {
    const view = new DataView(entries.buffer, entries.byteOffset, entries.byteLength);
    for (let o = 0; o + 4 <= entries.byteLength; o += 4) {
      this.byId.delete(view.getUint32(o, true));
    }
  }

  /** 推进一刻。必须由固定步长的客户端刻调用 */
  tick(): void {
    for (const m of this.byId.values()) {
      if (m.interp < 1) {
        m.interp = 1;
        m.prevX = m.x; m.prevY = m.y; m.prevZ = m.z;
        m.prevYaw = m.yaw;
        m.prevHeadYaw = m.headYaw;
      }
      // 苦力怕鼓起：30 刻涨满，松开时按同样速度缩回去
      const target = (m.flags & 4) !== 0 ? 1 : 0;
      m.swell += Math.sign(target - m.swell) * (1 / 30);
      m.swell = Math.max(0, Math.min(1, m.swell));
    }
  }

  clear(): void {
    this.byId.clear();
  }

  /** 这一帧画在哪。角度要按最短弧插值，否则从 +π 转到 −π 会绕一整圈 */
  static interpolate(m: ClientMob, t: number): {
    x: number; y: number; z: number; yaw: number; headYaw: number;
  } {
    const a = Math.min(1, m.interp + t);
    return {
      x: m.prevX + (m.x - m.prevX) * a,
      y: m.prevY + (m.y - m.prevY) * a,
      z: m.prevZ + (m.z - m.prevZ) * a,
      yaw: lerpAngle(m.prevYaw, m.yaw, a),
      headYaw: lerpAngle(m.prevHeadYaw, m.headYaw, a),
    };
  }
}

/** 沿最短弧插值两个角度 */
function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
