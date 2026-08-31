/**
 * 玩家物品栏与打开的容器窗口。
 *
 * 槽位布局照抄 MC 的编号，因为**客户端与服务端必须对同一个数字有同一个理解**，
 * 而 MC 的编号是所有对照资料的共同基准：
 *
 *   背包窗口（45 格）
 *     0      合成产物
 *     1..4   2×2 合成格
 *     5..8   盔甲（头/胸/腿/脚）
 *     9..35  主存放区（3×9）
 *     36..44 快捷栏（9）
 *
 *   工作台窗口（46 格）
 *     0      合成产物
 *     1..9   3×3 合成格
 *     10..36 主存放区
 *     37..45 快捷栏
 *
 * 玩家的**主存放区与快捷栏是同一份数据**，换窗口时不搬运 ——
 * 搬运会在窗口切换的瞬间产生"东西还没到位"的窗口期，
 * 而那正是多人环境下刷物品的经典路子。
 */
import {
  Container, SlotKind, type SlotRegion, type MaxStackFn,
} from '../../core/inventory/container.ts';
import {
  emptyStack, isEmpty, cloneStack, clearStack, copyStack, makeStack,
  type ItemStack,
} from '../../core/item/item-def.ts';
import { findRecipe, type CraftGrid, type Recipe } from '../../core/craft/recipe.ts';
import { WindowKind } from '../../core/net/packets.ts';

/** 玩家永久持有的 40 格：4 盔甲 + 27 主存放 + 9 快捷栏 */
export const ARMOR_SLOTS = 4;
export const MAIN_SLOTS = 27;
export const HOTBAR_SLOTS = 9;
export const PERSISTENT_SLOTS = ARMOR_SLOTS + MAIN_SLOTS + HOTBAR_SLOTS;

/** 玩家自己的物品，与当前窗口无关 */
export class PlayerInventory {
  /** 0..3 盔甲，4..30 主存放，31..39 快捷栏 */
  readonly slots: ItemStack[] = Array.from({ length: PERSISTENT_SLOTS }, () => emptyStack());
  /** 手上拿着的那一堆，跨窗口保留 */
  readonly cursor: ItemStack = emptyStack();
  /** 当前选中的快捷栏格子 0..8 */
  selectedHotbar = 0;

  get held(): ItemStack {
    return this.slots[ARMOR_SLOTS + MAIN_SLOTS + this.selectedHotbar]!;
  }

  armorAt(i: number): ItemStack {
    return this.slots[i]!;
  }
}

/**
 * 一个打开着的窗口。
 *
 * 窗口自己**不存**玩家的物品，它的槽位是玩家物品栏的**视图** ——
 * 每次同步时按映射抄进抄出。这样切窗口不需要搬东西，
 * 也就不存在"搬到一半"的中间状态。
 */
export class Window {
  readonly kind: WindowKind;
  readonly container: Container;
  /** 窗口槽位 -> 玩家物品栏槽位。−1 表示这一格是窗口自己的（合成格、产物、箱子） */
  private readonly mapping: number[];
  /** 合成格在窗口里的起点与边长 */
  private readonly craftStart: number;
  private readonly craftSize: number;
  private readonly recipes: readonly Recipe[];
  private readonly inv: PlayerInventory;
  /** 箱子/熔炉这类外部容器的数据，由调用方提供 */
  readonly external: ItemStack[] | null;

  constructor(
    kind: WindowKind,
    inv: PlayerInventory,
    recipes: readonly Recipe[],
    maxStackOf: MaxStackFn,
    external: ItemStack[] | null = null,
  ) {
    this.kind = kind;
    this.inv = inv;
    this.recipes = recipes;
    this.external = external;

    const layout = buildLayout(kind, external?.length ?? 0);
    this.mapping = layout.mapping;
    this.craftStart = layout.craftStart;
    this.craftSize = layout.craftSize;
    this.container = new Container(layout.mapping.length, layout.regions, maxStackOf);
    this.container.onTakeOutput = (): void => this.consumeCraftingInputs();
    this.pullFromPlayer();
  }

  /** 把玩家物品栏与外部容器的内容抄进窗口 */
  pullFromPlayer(): void {
    for (let i = 0; i < this.mapping.length; i++) {
      const src = this.mapping[i]!;
      if (src >= 0) copyStack(this.inv.slots[src]!, this.container.slots[i]!);
      else if (src <= -100 && this.external !== null) {
        copyStack(this.external[-src - 100]!, this.container.slots[i]!);
      }
    }
    copyStack(this.inv.cursor, this.container.cursor);
    this.refreshOutput();
  }

  /** 把窗口里的内容写回玩家物品栏与外部容器 */
  pushToPlayer(): void {
    for (let i = 0; i < this.mapping.length; i++) {
      const dst = this.mapping[i]!;
      if (dst >= 0) copyStack(this.container.slots[i]!, this.inv.slots[dst]!);
      else if (dst <= -100 && this.external !== null) {
        copyStack(this.container.slots[i]!, this.external[-dst - 100]!);
      }
    }
    copyStack(this.container.cursor, this.inv.cursor);
  }

  /** 处理一次点击并同步 */
  click(slot: number, button: 0 | 1, shift: boolean): boolean {
    // **先把外面的现状抄进来再点。**
    //
    // 窗口是打开那一刻的一份快照，而 pushToPlayer 会把整份快照写回去。
    // 两个人开着同一个箱子时，这就是一台复制机：A 拿走一整堆钻石
    // （箱子被写成空），B 随后点一下，B 那份还停在"箱子里有 64 颗"的快照上，
    // 整份写回去 —— 箱子又满了，而 A 手上那 64 颗还在。实测凭空多出 64 颗。
    //
    // 服务端是单线程的，一次只处理一个点击，所以"点之前重读一遍"
    // 就足以把它变成正确的读-改-写。顺带也接上了另一件事：
    // 窗口开着的时候捡到的东西，现在也能立刻在窗口里看到
    this.pullFromPlayer();
    const changed = this.container.click(slot, button, shift);
    if (!changed) return false;
    this.refreshOutput();
    this.pushToPlayer();
    return true;
  }

  /** 关闭窗口：合成格里的东西还给玩家，还不下的返回给调用方丢地上 */
  close(): ItemStack[] {
    // 和 click 同一个理由：这份窗口是打开那一刻的快照，而下面的
    // pushToPlayer 会把整份写回去。关窗前不重读的话，**开着窗口期间
    // 外面发生的任何变化都会被这份旧快照抹掉** —— 最典型的是附魔台：
    // 花三十级附完魔，按一下 Esc，附魔连同等级一起没了
    this.pullFromPlayer();
    const dropped: ItemStack[] = [];
    if (this.craftSize > 0) {
      for (let i = 0; i < this.craftSize * this.craftSize; i++) {
        const s = this.container.slots[this.craftStart + i]!;
        if (isEmpty(s)) continue;
        const left = this.container.addItem(s, this.playerRegionIndex());
        if (left > 0) dropped.push(makeStack(s.id, left, s.damage));
        clearStack(s);
      }
    }
    if (!isEmpty(this.container.cursor)) {
      const left = this.container.addItem(this.container.cursor, this.playerRegionIndex());
      if (left > 0) dropped.push(makeStack(this.container.cursor.id, left, this.container.cursor.damage));
      clearStack(this.container.cursor);
    }
    this.pushToPlayer();
    return dropped;
  }

  /** 主存放区在 regions 里的下标 */
  private playerRegionIndex(): number {
    return this.container.regions.findIndex((r) => r.kind === SlotKind.STORAGE);
  }

  /** 按当前合成格重算产物槽 */
  private refreshOutput(): void {
    if (this.craftSize === 0) return;
    const grid: CraftGrid = {
      size: this.craftSize,
      slots: this.container.slots.slice(this.craftStart, this.craftStart + this.craftSize * this.craftSize),
    };
    const out = this.container.slots[0]!;
    const result = findRecipe(this.recipes, grid);
    if (result === null) {
      clearStack(out);
    } else {
      out.id = result.id;
      out.count = result.count;
      out.damage = result.damage;
    }
  }

  /**
   * 取走产物时，每格材料各消耗一个。
   *
   * 不是"按配方扣"而是"每个非空格扣一个" —— 这正是 MC 的做法，
   * 也是唯一和"平移/镜像匹配"自洽的做法：配方可能是镜像匹配上的，
   * 按配方的图样去扣会扣错格子。
   */
  private consumeCraftingInputs(): void {
    if (this.craftSize === 0) return;
    for (let i = 0; i < this.craftSize * this.craftSize; i++) {
      const s = this.container.slots[this.craftStart + i]!;
      if (isEmpty(s)) continue;
      s.count--;
      if (s.count <= 0) clearStack(s);
    }
    this.refreshOutput();
  }

  /** 供网络同步：窗口全部槽位 + 手上那一堆 */
  snapshot(): ItemStack[] {
    return [...this.container.slots.map(cloneStack), cloneStack(this.container.cursor)];
  }
}

interface Layout {
  mapping: number[];
  regions: SlotRegion[];
  craftStart: number;
  craftSize: number;
}

/**
 * 各种窗口的槽位布局。
 *
 * mapping[i] 的含义：
 *   ≥0    映射到玩家物品栏的第几格
 *   −1    窗口自己的临时格（合成格、产物）
 *   ≤−100 映射到外部容器的第 (−v−100) 格
 */
function buildLayout(kind: WindowKind, externalCount: number): Layout {
  const ARMOR = 0;
  const MAIN = ARMOR_SLOTS;
  const HOT = ARMOR_SLOTS + MAIN_SLOTS;

  const playerTail = (offset: number): { mapping: number[]; regions: SlotRegion[] } => {
    const mapping: number[] = [];
    for (let i = 0; i < MAIN_SLOTS; i++) mapping.push(MAIN + i);
    for (let i = 0; i < HOTBAR_SLOTS; i++) mapping.push(HOT + i);
    return {
      mapping,
      regions: [
        { start: offset, count: MAIN_SLOTS, kind: SlotKind.STORAGE, shiftTargets: [] },
        { start: offset + MAIN_SLOTS, count: HOTBAR_SLOTS, kind: SlotKind.STORAGE, shiftTargets: [] },
      ],
    };
  };

  if (kind === WindowKind.CRAFTING || kind === WindowKind.INVENTORY) {
    const size = kind === WindowKind.CRAFTING ? 3 : 2;
    const craftCells = size * size;
    const mapping: number[] = [-1]; // 0 = 产物
    for (let i = 0; i < craftCells; i++) mapping.push(-1);
    const armorStart = mapping.length;
    if (kind === WindowKind.INVENTORY) for (let i = 0; i < ARMOR_SLOTS; i++) mapping.push(ARMOR + i);
    const tailStart = mapping.length;
    const tail = playerTail(tailStart);
    mapping.push(...tail.mapping);

    const regions: SlotRegion[] = [
      { start: 0, count: 1, kind: SlotKind.OUTPUT, shiftTargets: [] },
      { start: 1, count: craftCells, kind: SlotKind.INPUT, shiftTargets: [] },
    ];
    if (kind === WindowKind.INVENTORY) {
      regions.push({ start: armorStart, count: ARMOR_SLOTS, kind: SlotKind.ARMOR, shiftTargets: [] });
    }
    regions.push(...tail.regions);
    // Shift 的去向：产物与合成格 -> 主存放/快捷栏；主存放 <-> 快捷栏
    const mainIdx = regions.length - 2;
    const hotIdx = regions.length - 1;
    return {
      mapping,
      craftStart: 1,
      craftSize: size,
      regions: regions.map((r, i) => {
        if (i === 0 || i === 1) return { ...r, shiftTargets: [hotIdx, mainIdx] };
        if (i === mainIdx) return { ...r, shiftTargets: [hotIdx] };
        if (i === hotIdx) return { ...r, shiftTargets: [mainIdx] };
        return r;
      }),
    };
  }

  // 箱子 / 熔炉：外部容器在前，玩家物品栏在后
  const mapping: number[] = [];
  for (let i = 0; i < externalCount; i++) mapping.push(-100 - i);
  const tailStart = mapping.length;
  const tail = playerTail(tailStart);
  mapping.push(...tail.mapping);
  const kindOf = kind === WindowKind.FURNACE ? SlotKind.INPUT : SlotKind.STORAGE;
  const regions: SlotRegion[] = [
    { start: 0, count: externalCount, kind: kindOf, shiftTargets: [] },
    ...tail.regions,
  ];
  const mainIdx = 1;
  const hotIdx = 2;
  return {
    mapping,
    craftStart: 0,
    craftSize: 0,
    regions: [
      { ...regions[0]!, shiftTargets: [mainIdx, hotIdx] },
      { ...regions[1]!, shiftTargets: [0] },
      { ...regions[2]!, shiftTargets: [0] },
    ],
  };
}
