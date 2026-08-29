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
  layoutFor, slotAt, drawWindow, drawHotbar, drawCrosshair,
  type SlotRect, type DrawContext,
} from './inventory-screen.ts';
import { WindowKind } from '../../core/net/packets.ts';
import { emptyStack, cloneStack, type ItemStack } from '../../core/item/item-def.ts';

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

  get open(): boolean {
    return this.windowKind !== null;
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
  }

  /** 界面里点了一下。返回要发给服务端的包内容，没点中返回 null */
  click(button: 0 | 1, shift: boolean): { windowId: number; slot: number; button: number; shift: boolean } | null {
    if (!this.open || this.hovered < 0) return null;
    return { windowId: this.windowId, slot: this.hovered, button, shift };
  }

  draw(ui: UiRenderer, ctx: DrawContext): void {
    ui.begin();
    if (this.open) {
      drawWindow(
        ui, this.windowKind!, this.layout, this.slots, this.cursorStack,
        this.hovered, ctx, this.mouseX, this.mouseY,
      );
    } else {
      drawCrosshair(ui);
    }
    drawHotbar(ui, this.slots, this.hotbarStart, this.selectedHotbar, ctx);
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
  for (let i = 0; i < view.length; i += 3) {
    out.push({ id: view[i]!, count: view[i + 1]!, damage: view[i + 2]! });
  }
  return out;
}

void cloneStack;
void UI_HEIGHT;
