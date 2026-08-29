/**
 * 客户端的掉落物镜像。
 *
 * 和区块一样，这里**只是镜像**：客户端不生成、不销毁、不移动掉落物，
 * 一切都由 S_SpawnItems / S_EntityMoves / S_DestroyEntities 驱动。
 *
 * 服务端每刻只在实体真的动了的时候发位置，落地之后就不发了。所以两次
 * 位置更新之间要**插值**，否则 20 Hz 的位置流在 144 Hz 的屏幕上是一跳一跳的。
 *
 * 插值的进度用一个**以刻为单位的计数器**，不是"每帧把 prev 拉到 current"。
 * 后者看着简单，但两种方式都会坏：每帧拉平等于没有插值；只在收包时拉，
 * 则最后一个包之后 prev 与 current 会永远不同，partialTick 每刻从 0 荡到 1，
 * 落地不动的掉落物会原地来回抖。计数器同时解决这两头 ——
 * 收到包时归零、一刻之后追平并锁死。
 */

export interface ClientItemEntity {
  readonly entityId: number;
  /** 上一次收到的位置，插值的起点 */
  prevX: number; prevY: number; prevZ: number;
  /** 最新收到的位置，插值的终点 */
  x: number; y: number; z: number;
  itemId: number;
  count: number;
  damage: number;
  /**
   * 出现之后过了多少刻。用来做上下浮动与旋转。
   *
   * 由固定步长的客户端刻驱动而不是挂钟 —— freeze() 要能把它一起停住，
   * 否则截图回归会因为掉落物转到了不同角度而每次哈希不同。
   */
  age: number;
  /** 距离上一个位置包过了几刻。0 表示正在插值，≥1 表示已经追平 */
  interp: number;
  /** 每个实体的相位偏移，免得一堆掉落物整齐划一地上下摆动 */
  phase: number;
}

export class ClientEntities {
  private readonly byId = new Map<number, ClientItemEntity>();

  get size(): number {
    return this.byId.size;
  }

  values(): Iterable<ClientItemEntity> {
    return this.byId.values();
  }

  /** S_SpawnItems：每项 20 字节 */
  onSpawn(entries: Uint8Array, stride: number, scale: number): void {
    const view = new DataView(entries.buffer, entries.byteOffset, entries.byteLength);
    for (let o = 0; o + stride <= entries.byteLength; o += stride) {
      const id = view.getUint32(o, true);
      const x = view.getInt32(o + 4, true) / scale;
      const y = view.getInt32(o + 8, true) / scale;
      const z = view.getInt32(o + 12, true) / scale;
      const existing = this.byId.get(id);
      if (existing !== undefined) {
        // 重复的出生包（比如来回走出又走进视距）只更新内容，不要把 age 清零 ——
        // 清零会让所有掉落物在玩家转身时同步"重新开始摆动"，很显眼
        existing.x = x; existing.y = y; existing.z = z;
        existing.prevX = x; existing.prevY = y; existing.prevZ = z;
        existing.interp = 1;
        continue;
      }
      this.byId.set(id, {
        entityId: id,
        x, y, z, prevX: x, prevY: y, prevZ: z,
        itemId: view.getUint16(o + 16, true),
        count: view.getUint8(o + 18),
        damage: view.getUint8(o + 19),
        age: 0,
        interp: 1,
        // 用 id 派生相位：确定性的，同一个存档同一个实体永远同一个相位
        phase: (id * 2654435761 % 1000) / 1000 * Math.PI * 2,
      });
    }
  }

  /** S_EntityMoves：每项 16 字节 */
  onMove(entries: Uint8Array, stride: number, scale: number): void {
    const view = new DataView(entries.buffer, entries.byteOffset, entries.byteLength);
    for (let o = 0; o + stride <= entries.byteLength; o += stride) {
      const e = this.byId.get(view.getUint32(o, true));
      if (e === undefined) continue;
      e.prevX = e.x; e.prevY = e.y; e.prevZ = e.z;
      e.x = view.getInt32(o + 4, true) / scale;
      e.y = view.getInt32(o + 8, true) / scale;
      e.z = view.getInt32(o + 12, true) / scale;
      e.interp = 0;
    }
  }

  /** S_DestroyEntities：每项 4 字节的 entityId */
  onDestroy(entries: Uint8Array): void {
    const view = new DataView(entries.buffer, entries.byteOffset, entries.byteLength);
    for (let o = 0; o + 4 <= entries.byteLength; o += 4) {
      this.byId.delete(view.getUint32(o, true));
    }
  }

  /**
   * 推进一刻。**必须由固定步长的客户端刻调用**，不是每帧调 ——
   * 每帧调的话浮动与旋转的速度会随帧率变化。
   */
  tick(): void {
    for (const e of this.byId.values()) {
      e.age++;
      if (e.interp < 1) {
        e.interp = 1;
        // 追平：此后 prev 与 current 相同，插值恒等于终点，实体彻底静止
        e.prevX = e.x; e.prevY = e.y; e.prevZ = e.z;
      }
    }
  }

  /** 某个实体这一帧该画在哪。partialTick 是当前刻已经走过的比例 */
  static interpolate(e: ClientItemEntity, partialTick: number): [number, number, number] {
    const t = Math.min(1, e.interp + partialTick);
    return [
      e.prevX + (e.x - e.prevX) * t,
      e.prevY + (e.y - e.prevY) * t,
      e.prevZ + (e.z - e.prevZ) * t,
    ];
  }

  clear(): void {
    this.byId.clear();
  }
}
