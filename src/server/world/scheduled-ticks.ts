/**
 * 计划刻队列。
 *
 * 有些方块不是"立刻"反应，而是"过 N 刻之后"：水每 5 刻流一格，
 * 岩浆 30 刻，中继器按档位 2/4/6/8 刻，作物随机刻生长，沙子下落要等一刻。
 * 这些都不能靠"每 tick 扫一遍全世界"实现（那是前作的做法，见计划 §3.2 坑 #9），
 * 必须有一个按时间排序的队列。
 *
 * 实现是**二叉堆**，键是 (时间, 插入序号)。用插入序号做次级键是为了确定性：
 * 同一刻到期的若干个计划刻，执行顺序必须只取决于它们被排进来的顺序，
 * 而不取决于 Map 的遍历顺序或者浮点比较的偶然结果 ——
 * 否则同一个存档读两次，水的流向可能不一样。
 *
 * 去重照抄 MC：同一个坐标 + 同一个方块 id 只留一个待办。少了这一条，
 * 一个来回震荡的红石电路会让队列指数膨胀。
 */
import { WORLD_HEIGHT } from '../../core/constants.ts';

export interface ScheduledTick {
  x: number;
  y: number;
  z: number;
  /** 排进来时的方块 id。到期时方块已经变了就取消 —— 照抄 MC */
  blockId: number;
  /** 到期的世界年龄 */
  time: number;
  /** 插入序号，用于打破同刻的平局 */
  order: number;
}

/** 坐标 + 方块 id 的去重键 */
function dedupeKey(x: number, y: number, z: number, blockId: number): string {
  return `${x},${y},${z},${blockId}`;
}

export class ScheduledTickQueue {
  private readonly heap: ScheduledTick[] = [];
  private readonly pending = new Set<string>();
  private nextOrder = 0;

  get size(): number {
    return this.heap.length;
  }

  /**
   * 排一个计划刻。
   * @param delay 多少刻之后，最小 1
   * @returns 是否真的排进去了（重复的会被丢掉）
   */
  schedule(worldAge: number, x: number, y: number, z: number, blockId: number, delay: number): boolean {
    if (y < 0 || y >= WORLD_HEIGHT) return false;
    const key = dedupeKey(x, y, z, blockId);
    if (this.pending.has(key)) return false;
    this.pending.add(key);
    this.push({ x, y, z, blockId, time: worldAge + Math.max(1, delay), order: this.nextOrder++ });
    return true;
  }

  /** 直接放一条（读存档时用，保留原来的 time 与 order） */
  restore(entry: ScheduledTick): void {
    const key = dedupeKey(entry.x, entry.y, entry.z, entry.blockId);
    if (this.pending.has(key)) return;
    this.pending.add(key);
    this.push(entry);
    if (entry.order >= this.nextOrder) this.nextOrder = entry.order + 1;
  }

  /**
   * 取出所有已到期的计划刻，按 (时间, 序号) 排好。
   *
   * 有上限：一个 tick 最多处理 `limit` 条。红石时钟或者大片流水能让
   * 到期条目在一刻内堆到几万条，全做完会让服务端停摆几百毫秒；
   * 做不完的留在队列里，下一刻接着做。
   */
  drainDue(worldAge: number, limit = 1000): ScheduledTick[] {
    const out: ScheduledTick[] = [];
    while (this.heap.length > 0 && out.length < limit) {
      const top = this.heap[0]!;
      if (top.time > worldAge) break;
      out.push(this.pop());
      this.pending.delete(dedupeKey(top.x, top.y, top.z, top.blockId));
    }
    return out;
  }

  /** 某个范围内的全部条目，存区块时用 */
  entriesIn(x0: number, z0: number, x1: number, z1: number): ScheduledTick[] {
    return this.heap
      .filter((e) => e.x >= x0 && e.x <= x1 && e.z >= z0 && e.z <= z1)
      .sort((a, b) => (a.time - b.time) || (a.order - b.order));
  }

  /** 丢掉某个范围内的全部条目，卸载区块时用 */
  removeIn(x0: number, z0: number, x1: number, z1: number): number {
    const kept = this.heap.filter((e) => !(e.x >= x0 && e.x <= x1 && e.z >= z0 && e.z <= z1));
    const removed = this.heap.length - kept.length;
    if (removed === 0) return 0;
    for (const e of this.heap) {
      if (e.x >= x0 && e.x <= x1 && e.z >= z0 && e.z <= z1) {
        this.pending.delete(dedupeKey(e.x, e.y, e.z, e.blockId));
      }
    }
    this.heap.length = 0;
    for (const e of kept) this.push(e);
    return removed;
  }

  clear(): void {
    this.heap.length = 0;
    this.pending.clear();
  }

  // --- 二叉堆 ---

  private static before(a: ScheduledTick, b: ScheduledTick): boolean {
    return a.time !== b.time ? a.time < b.time : a.order < b.order;
  }

  private push(e: ScheduledTick): void {
    const h = this.heap;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!ScheduledTickQueue.before(h[i]!, h[parent]!)) break;
      [h[i], h[parent]] = [h[parent]!, h[i]!];
      i = parent;
    }
  }

  private pop(): ScheduledTick {
    const h = this.heap;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let best = i;
        if (l < h.length && ScheduledTickQueue.before(h[l]!, h[best]!)) best = l;
        if (r < h.length && ScheduledTickQueue.before(h[r]!, h[best]!)) best = r;
        if (best === i) break;
        [h[i], h[best]] = [h[best]!, h[i]!];
        i = best;
      }
    }
    return top;
  }
}
