/**
 * 界面状态机：什么时候显示哪个界面、鼠标点在哪、点了要发什么包。
 *
 * 一条硬规矩：**客户端不自己改物品栏**。点了就发包，等服务端把整份内容
 * 发回来再显示。单人模式下往返是微秒级，本地预测换不来任何可感知的收益，
 * 却会引入"客户端以为合成了、服务端说没有"这类极难查的分叉 ——
 * 而物品的分叉在多人环境里就是刷物品漏洞。
 */
import { UiRenderer, UI_WIDTH, UI_HEIGHT } from './ui-renderer.ts';
import {
  layoutFor, slotAt, drawWindow, drawHotbar, drawCrosshair, drawFurnaceProgress,
  drawVitals, drawDeathScreen, drawEnchantOffers, enchantRowAt, drawBrewProgress,
  type SlotRect, type DrawContext,
} from './inventory-screen.ts';
import { WindowKind } from '../../core/net/packets.ts';
import { emptyStack, cloneStack, type ItemStack } from '../../core/item/item-def.ts';
import { MenuState, drawVersionTag, type MenuAction } from './menu-screen.ts';
import { decodeEnchantSummary, rememberEnchantSummary } from './item-enchant.ts';

/** 玩家永久持有的槽位数，与服务端一致 */
const PERSISTENT_SLOTS = 40;
const HOTBAR_START = 31;

export class UiController {
  /** 当前打开的窗口。null 表示只有快捷栏 */
  windowKind: WindowKind | null = null;
  windowId = 0;
  /** 服务端发来的完整槽位内容，最后一格是手上拿着的 */
  slots: ItemStack[] = Array.from({ length: PERSISTENT_SLOTS + 1 }, () => emptyStack());
  private layout: SlotRect[] = [];
  /** 鼠标在虚拟像素坐标系里的位置 */
  mouseX = UI_WIDTH / 2;
  mouseY = UI_HEIGHT / 2;
  hovered = -1;
  selectedHotbar = 0;
  /** 熔炉的火焰与箭头进度。只有熔炉窗口用得上 */
  readonly progress = { burnTime: 0, burnTotal: 0, cookTime: 0 };
  /**
   * 附魔台的三个报价。服务端权威 —— 客户端**不自己算**，
   * 与物品栏同一条规矩：算两遍必然漂移，而漂移的表现是
   * "点了 30 级那一行，扣的是 27 级"
   */
  enchantOffers: [number, number, number] = [0, 0, 0];
  /** 鼠标停在第几行报价上。-1 = 不在任何一行 */
  enchantHover = -1;
  /** 酿造进度（倒计时）与总时长 */
  readonly brew = { time: 0, total: 400 };
  /** 生存状态。服务端权威，客户端只画 */
  readonly vitals = { health: 20, maxHealth: 20, hunger: 20, air: 20, xpLevel: 0, xpProgress: 0 };
  /** 死了没。死了就画死亡界面并挡住输入 */
  dead = false;
  /**
   * 全屏菜单（主菜单 / 世界列表 / 设置 / 暂停）。
   *
   * 与容器窗口是**两套东西**：容器窗口盖在世界上、世界照常跑；
   * 菜单则要挡住全部输入。合成一个状态机的话，
   * "开着箱子时按 Esc 该关箱子还是该开暂停"这类判断会散到各处。
   */
  readonly menu = new MenuState();
  /** 版本水印，主菜单右下角 */
  versionTag = '';

  get open(): boolean {
    return this.windowKind !== null;
  }

  /** 菜单开着时，世界输入（走路、挖方块）全部屏蔽 */
  get menuOpen(): boolean {
    return this.menu.open;
  }

  /**
   * 按 Esc。返回 true 表示这一下被界面吃掉了。
   *
   * 顺序有讲究：先关容器窗口，再开暂停菜单。反过来的话
   * "开着箱子按 Esc" 会直接弹出暂停菜单，而箱子还开着盖在下面。
   */
  onEscape(): boolean {
    if (this.menu.open) {
      if (this.menu.screen === 'pause') { this.menu.show('none'); return true; }
      if (this.menu.screen === 'settings') { this.menu.press('back'); return true; }
      if (this.menu.screen === 'worlds') { this.menu.show('main'); return true; }
      return true;  // 主菜单：Esc 不做事，但也不能穿透到世界
    }
    if (this.open) return false;  // 让调用方走关窗口那条路
    this.menu.show('pause');
    return true;
  }

  /** 菜单里点一下 */
  menuClick(): MenuAction {
    return this.menu.click();
  }

  get cursorStack(): ItemStack {
    return this.slots[this.slots.length - 1] ?? emptyStack();
  }

  /** 不开界面时，快捷栏读的是玩家物品栏的后 9 格 */
  private get hotbarStart(): number {
    if (this.windowKind === null) return HOTBAR_START;
    // 开着界面时，槽位表是窗口视图，快捷栏在最后 9 格（不含手上那格）
    return this.slots.length - 1 - 9;
  }

  onOpenWindow(windowId: number, kind: WindowKind, externalCount: number): void {
    this.windowKind = kind;
    this.windowId = windowId;
    this.layout = layoutFor(kind, externalCount);
  }

  onCloseWindow(): void {
    this.windowKind = null;
    this.layout = [];
    this.progress.burnTime = 0;
    this.progress.burnTotal = 0;
    this.progress.cookTime = 0;
  }

  /** 熔炉的燃烧与熔炼进度 */
  onWindowProgress(windowId: number, burnTime: number, burnTotal: number, cookTime: number): void {
    if (windowId !== this.windowId) return;
    this.progress.burnTime = burnTime;
    this.progress.burnTotal = burnTotal;
    this.progress.cookTime = cookTime;
  }

  /** 服务端发来的整份槽位内容 */
  onWindowItems(windowId: number, stacks: ItemStack[]): void {
    // windowId 0 表示"没开窗口时的玩家物品栏"
    if (windowId !== 0 && this.windowKind !== null && windowId !== this.windowId) return;
    this.slots = stacks;
  }

  /** 鼠标移动（界面打开时用绝对坐标，不用指针锁的增量） */
  onMouseMove(clientX: number, clientY: number, canvasW: number, canvasH: number): void {
    const scale = Math.min(canvasW / UI_WIDTH, canvasH / UI_HEIGHT);
    const offX = (canvasW - UI_WIDTH * scale) / 2;
    const offY = (canvasH - UI_HEIGHT * scale) / 2;
    this.mouseX = (clientX - offX) / scale;
    this.mouseY = (clientY - offY) / scale;
    this.hovered = this.open ? slotAt(this.layout, this.mouseX, this.mouseY) : -1;
    this.enchantHover = this.windowKind === WindowKind.ENCHANTING
      ? enchantRowAt(this.mouseX, this.mouseY) : -1;
    this.menu.onMouseMove(this.mouseX, this.mouseY);
  }

  /** 界面里点了一下。返回要发给服务端的包内容，没点中返回 null */
  click(button: 0 | 1, shift: boolean): { windowId: number; slot: number; button: number; shift: boolean } | null {
    if (!this.open || this.hovered < 0) return null;
    return { windowId: this.windowId, slot: this.hovered, button, shift };
  }

  /**
   * 点在附魔台的某一行报价上了吗。返回行号，没点中返回 -1。
   *
   * 与 click() 分开：报价不是槽位，走的是另一个包（C_EnchantSelect）。
   * 塞进 click 的返回值里的话，"slot" 这个字段会同时表示两种东西
   */
  clickEnchantRow(): number {
    if (this.windowKind !== WindowKind.ENCHANTING) return -1;
    return this.enchantHover;
  }

  /** 服务端发来的附魔报价 */
  onEnchantOffers(windowId: number, a: number, b: number, c: number): void {
    if (windowId !== this.windowId) return;
    this.enchantOffers = [a, b, c];
  }

  /**
   * 画这一帧的界面。
   *
   * @param renderTick 渲染帧号，附魔光效的相位靠它。**必须**是 `clock.renderTick`
   *   而不是任何形式的挂钟或自己数的帧数（规约第 4 条）—— 否则 `__mc.freeze()`
   *   停不住画面，截图取样等不到"连续两帧一样"。
   *   由 entry/world-render.ts 一路传进来。
   */
  draw(ui: UiRenderer, ctx: DrawContext, renderTick: number): void {
    ui.begin();
    if (this.open) {
      drawWindow(
        ui, this.windowKind!, this.layout, this.slots, this.cursorStack,
        this.hovered, ctx, this.mouseX, this.mouseY, renderTick,
      );
      if (this.windowKind === WindowKind.FURNACE) {
        drawFurnaceProgress(ui, this.layout, this.progress);
      } else if (this.windowKind === WindowKind.ENCHANTING) {
        drawEnchantOffers(ui, this.enchantOffers, this.vitals.xpLevel, this.enchantHover);
      } else if (this.windowKind === WindowKind.BREWING) {
        // 酿造进度借用 cookTime 那一格 —— 酿造台不烧煤，
        // burnTime/burnTotal 在这个窗口里没有意义
        drawBrewProgress(ui, this.layout, this.progress.cookTime, this.brew.total);
      }
    } else {
      drawCrosshair(ui);
    }
    // 菜单开着时不画 HUD。暂停界面的背景是半透明的（要让人看见
    // 自己没退出游戏），快捷栏会从底下透出来，看着像界面画漏了。
    // MC 也是暂停时收起 HUD 的
    if (!this.menu.open) {
      drawHotbar(ui, this.slots, this.hotbarStart, this.selectedHotbar, ctx, renderTick);
      // 生存状态画在快捷栏之上。开着容器界面时不画 —— 那时候面板已经
      // 盖住了那一片，两者叠在一起会糊成一团
      if (!this.open) drawVitals(ui, this.vitals);
      if (this.dead) drawDeathScreen(ui);
    }
    // 菜单画在**最后**：它要盖住包括快捷栏与死亡界面在内的一切
    if (this.menu.open) {
      this.menu.draw(ui);
      if (this.menu.screen === 'main' && this.versionTag !== '') {
        drawVersionTag(ui, this.versionTag);
      }
    }
  }

  /** 界面缩放：把设计分辨率整数倍地放到画布上，像素才不会糊 */
  static scaleFor(canvasW: number, canvasH: number): number {
    return Math.max(1, Math.min(canvasW / UI_WIDTH, canvasH / UI_HEIGHT));
  }
}

/** 从网络包里解出槽位数组 */
export function decodeSlots(bytes: Uint8Array): ItemStack[] {
  const view = new Int32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const out: ItemStack[] = [];
  // 每格四个 int32，第四个是附魔摘要：低 8 位条数、次 8 位主附魔 id、
  // 再 8 位等级。见 server 的 syncInventory
  for (let i = 0; i + 3 < view.length; i += 4) {
    const stack: ItemStack = { id: view[i]!, count: view[i + 1]!, damage: view[i + 2]! };
    const summary = decodeEnchantSummary(view[i + 3]!);
    if (summary !== null) {
      // ItemStack 只装得下"有哪几条"，装不下"一共几条" ——
      // 总条数记在旁挂表里，界面画提示条时要用。见 item-enchant.ts
      stack.enchantments = [{ id: summary.id, level: summary.level }];
      rememberEnchantSummary(stack, summary);
    }
    out.push(stack);
  }
  return out;
}

void cloneStack;
void UI_HEIGHT;
