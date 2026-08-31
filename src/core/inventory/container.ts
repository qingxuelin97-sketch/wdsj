/**
 * 容器与点击语义。
 *
 * 所有界面（背包、工作台、熔炉、箱子）共用同一套槽位模型与点击处理，
 * 差别只在"有哪些区域、哪些槽是产物槽"。
 *
 * MC 的点击语义看着简单，实际有一堆边角：
 *   左键空手点一堆   -> 全部拿起
 *   左键持物点空槽   -> 全部放下
 *   左键持物点同类   -> 尽量合并，**放不下的留在手上**
 *   左键持物点异类   -> 交换
 *   右键空手点一堆   -> 拿一半（向上取整）
 *   右键持物点       -> 放一个
 *   Shift 左键       -> 整堆搬到"另一片区域"
 *   产物槽           -> 只能取，不能放；取走时才扣材料
 *
 * 每一条都单独写了测试。这类逻辑写错不会崩，只会让玩家偶尔丢东西 ——
 * 而"我明明有 64 个煤，怎么变成 63 个了"是永远查不出来的那种 bug。
 */
import {
  isEmpty, canMerge, cloneStack, clearStack, copyStack, emptyStack,
  type ItemStack,
} from '../item/item-def.ts';

/** 槽位区域的用途 */
export const SlotKind = {
  /** 普通存放格 */
  STORAGE: 0,
  /** 合成/熔炼的输入格 */
  INPUT: 1,
  /** 产物格：只能取不能放 */
  OUTPUT: 2,
  /** 盔甲格：只接受对应部位 */
  ARMOR: 3,
} as const;
export type SlotKind = (typeof SlotKind)[keyof typeof SlotKind];

export interface SlotRegion {
  readonly start: number;
  readonly count: number;
  readonly kind: SlotKind;
  /**
   * Shift 点击时优先搬去哪个区域（按下标）。
   * 为空表示不参与 Shift 搬运。
   */
  readonly shiftTargets: readonly number[];
}

export const ClickButton = {
  LEFT: 0,
  RIGHT: 1,
} as const;
export type ClickButton = (typeof ClickButton)[keyof typeof ClickButton];

/** 每种物品能叠多少 */
export type MaxStackFn = (id: number) => number;

export class Container {
  readonly slots: ItemStack[];
  readonly regions: readonly SlotRegion[];
  /** 鼠标上拿着的那一堆 */
  readonly cursor: ItemStack = emptyStack();
  private readonly maxStackOf: MaxStackFn;

  /**
   * 取走产物时的回调。
   * 合成/熔炼在这里扣掉材料 —— 产物是**算出来的**，不是存着的，
   * 所以扣材料必须和取走这个动作绑在一起，中间不能有窗口。
   */
  onTakeOutput: ((slot: number, taken: ItemStack) => void) | null = null;

  constructor(slotCount: number, regions: readonly SlotRegion[], maxStackOf: MaxStackFn) {
    this.slots = Array.from({ length: slotCount }, () => emptyStack());
    this.regions = regions;
    this.maxStackOf = maxStackOf;
  }

  regionOf(slot: number): SlotRegion | null {
    for (const r of this.regions) {
      if (slot >= r.start && slot < r.start + r.count) return r;
    }
    return null;
  }

  /**
   * 处理一次点击。
   * @returns 是否改变了任何东西（用于决定要不要同步给客户端）
   */
  click(slot: number, button: ClickButton, shift: boolean): boolean {
    if (slot < 0 || slot >= this.slots.length) return false;
    const region = this.regionOf(slot);
    if (region === null) return false;
    return shift ? this.shiftClick(slot, region) : this.normalClick(slot, region, button);
  }

  private normalClick(slot: number, region: SlotRegion, button: ClickButton): boolean {
    const target = this.slots[slot]!;
    const cursor = this.cursor;

    // --- 产物格：只能取 ---
    if (region.kind === SlotKind.OUTPUT) {
      if (isEmpty(target)) return false;
      // 手上有东西时，只有能合并才拿得走
      if (!isEmpty(cursor)) {
        if (!canMerge(cursor, target)) return false;
        const max = this.maxStackOf(cursor.id);
        if (cursor.count + target.count > max) return false;
        cursor.count += target.count;
      } else {
        copyStack(target, cursor);
      }
      const taken = cloneStack(target);
      clearStack(target);
      this.onTakeOutput?.(slot, taken);
      return true;
    }

    // --- 空手 ---
    if (isEmpty(cursor)) {
      if (isEmpty(target)) return false;
      if (button === ClickButton.LEFT) {
        copyStack(target, cursor);
        clearStack(target);
      } else {
        // 右键拿一半，向上取整 —— 单个物品右键会整个拿走，这是 MC 的行为。
        // 走 copyStack 而不是逐字段抄，是为了把附魔一起带上：
        // 附了魔的东西只有一件，右键就是整件拿走
        const half = Math.ceil(target.count / 2);
        copyStack(target, cursor);
        cursor.count = half;
        target.count -= half;
        if (target.count <= 0) clearStack(target);
      }
      return true;
    }

    // --- 手上有东西 ---
    if (button === ClickButton.RIGHT) {
      // 放一个
      if (isEmpty(target)) {
        copyStack(cursor, target);
        target.count = 1;
        cursor.count--;
        if (cursor.count <= 0) clearStack(cursor);
        return true;
      }
      if (!canMerge(cursor, target)) return false;
      if (target.count >= this.maxStackOf(target.id)) return false;
      target.count++;
      cursor.count--;
      if (cursor.count <= 0) clearStack(cursor);
      return true;
    }

    // 左键
    if (isEmpty(target)) {
      copyStack(cursor, target);
      clearStack(cursor);
      return true;
    }
    if (canMerge(cursor, target)) {
      const max = this.maxStackOf(target.id);
      const room = max - target.count;
      if (room <= 0) return false;
      const move = Math.min(room, cursor.count);
      target.count += move;
      cursor.count -= move;
      // 放不下的**留在手上**，不是凭空消失
      if (cursor.count <= 0) clearStack(cursor);
      return true;
    }
    // 异类：交换
    const tmp = cloneStack(target);
    copyStack(cursor, target);
    copyStack(tmp, cursor);
    return true;
  }

  /** Shift 点击：整堆搬到另一片区域 */
  private shiftClick(slot: number, region: SlotRegion): boolean {
    const src = this.slots[slot]!;
    if (isEmpty(src)) return false;
    if (region.shiftTargets.length === 0) return false;

    const before = src.count;
    if (region.kind === SlotKind.OUTPUT) {
      // 产物槽 Shift 点击：一次只搬当前这一份，材料照样要扣
      const taken = cloneStack(src);
      for (const ti of region.shiftTargets) {
        this.moveInto(src, this.regions[ti]!);
        if (isEmpty(src)) break;
      }
      if (src.count < before) {
        taken.count = before - src.count;
        clearStack(src);
        this.onTakeOutput?.(slot, taken);
        return true;
      }
      return false;
    }

    for (const ti of region.shiftTargets) {
      this.moveInto(src, this.regions[ti]!);
      if (isEmpty(src)) break;
    }
    return src.count !== before;
  }

  /**
   * 把一堆尽量塞进某个区域。**先找同类补满，再找空格** ——
   * 顺序反过来的话，Shift 点一堆煤会先占掉一个空格，
   * 而不是补满已有的那半格，几次之后背包就被同一种东西铺满了。
   */
  private moveInto(src: ItemStack, region: SlotRegion): void {
    const max = this.maxStackOf(src.id);
    for (let i = 0; i < region.count && !isEmpty(src); i++) {
      const dst = this.slots[region.start + i]!;
      if (isEmpty(dst) || !canMerge(src, dst)) continue;
      const room = max - dst.count;
      if (room <= 0) continue;
      const move = Math.min(room, src.count);
      dst.count += move;
      src.count -= move;
      if (src.count <= 0) clearStack(src);
    }
    for (let i = 0; i < region.count && !isEmpty(src); i++) {
      const dst = this.slots[region.start + i]!;
      if (!isEmpty(dst)) continue;
      // 走 copyStack 而不是逐字段抄 —— 附魔要跟着搬。
      // Shift 点击整堆搬走走的就是这里，逐字段抄的话
      // 一次 Shift 点击就能把一把锋利 V 变成普通剑
      const move = Math.min(max, src.count);
      copyStack(src, dst);
      dst.count = move;
      src.count -= move;
      if (src.count <= 0) clearStack(src);
    }
  }

  /**
   * 往容器里塞东西（拾取掉落物用）。
   * @returns 塞不下的数量
   */
  addItem(stack: ItemStack, regionIndex = 0): number {
    const region = this.regions[regionIndex];
    if (region === undefined) return stack.count;
    const work = cloneStack(stack);
    this.moveInto(work, region);
    return work.count;
  }

  /** 某种物品一共有多少 */
  countOf(id: number): number {
    let n = 0;
    for (const s of this.slots) if (!isEmpty(s) && s.id === id) n += s.count;
    return n;
  }

  clear(): void {
    for (const s of this.slots) clearStack(s);
    clearStack(this.cursor);
  }
}
