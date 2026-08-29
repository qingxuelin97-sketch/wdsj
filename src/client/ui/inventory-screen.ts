/**
 * 容器界面的布局、绘制与命中测试。
 *
 * 布局是**数据**（一张槽位坐标表），绘制与命中测试都读同一张表 ——
 * 两边各写一套坐标是这类 UI 最经典的 bug 来源：看着点在格子上，
 * 实际点中的是旁边那格，而且只在某些格子上出错。
 *
 * 槽位编号与服务端窗口一一对应，见 server/player/player-inventory.ts 顶部。
 */
import { UiRenderer, UI_WIDTH, UI_HEIGHT } from './ui-renderer.ts';
import { WindowKind } from '../../core/net/packets.ts';
import { isEmpty, type ItemStack } from '../../core/item/item-def.ts';

/** 一个槽位在界面上的位置 */
export interface SlotRect {
  readonly index: number;
  readonly x: number;
  readonly y: number;
}

export const SLOT = 18;
const PAD = 1;

/** 玩家的 27 主存放 + 9 快捷栏，摆在面板下半部 */
function playerGrid(startIndex: number, x0: number, y0: number): SlotRect[] {
  const out: SlotRect[] = [];
  for (let i = 0; i < 27; i++) {
    out.push({ index: startIndex + i, x: x0 + (i % 9) * SLOT, y: y0 + Math.floor(i / 9) * SLOT });
  }
  for (let i = 0; i < 9; i++) {
    out.push({ index: startIndex + 27 + i, x: x0 + i * SLOT, y: y0 + 3 * SLOT + 4 });
  }
  return out;
}

/** 某种窗口的槽位表 */
export function layoutFor(kind: WindowKind, externalCount = 0): SlotRect[] {
  const px = (UI_WIDTH - 9 * SLOT) / 2;

  if (kind === WindowKind.INVENTORY) {
    const out: SlotRect[] = [];
    // 2×2 合成格与产物
    const cx = px + 5 * SLOT;
    const cy = 40;
    out.push({ index: 0, x: cx + 3 * SLOT, y: cy + SLOT / 2 });
    for (let i = 0; i < 4; i++) {
      out.push({ index: 1 + i, x: cx + (i % 2) * SLOT, y: cy + Math.floor(i / 2) * SLOT });
    }
    // 盔甲
    for (let i = 0; i < 4; i++) out.push({ index: 5 + i, x: px, y: cy + i * SLOT });
    out.push(...playerGrid(9, px, 118));
    return out;
  }

  if (kind === WindowKind.CRAFTING) {
    const out: SlotRect[] = [];
    const cx = px + 2 * SLOT;
    const cy = 36;
    out.push({ index: 0, x: cx + 4 * SLOT, y: cy + SLOT });
    for (let i = 0; i < 9; i++) {
      out.push({ index: 1 + i, x: cx + (i % 3) * SLOT, y: cy + Math.floor(i / 3) * SLOT });
    }
    out.push(...playerGrid(10, px, 118));
    return out;
  }

  // 箱子 / 熔炉：外部容器在上，玩家物品栏在下
  const out: SlotRect[] = [];
  const cols = kind === WindowKind.CHEST ? 9 : 3;
  for (let i = 0; i < externalCount; i++) {
    out.push({ index: i, x: px + (i % cols) * SLOT, y: 36 + Math.floor(i / cols) * SLOT });
  }
  out.push(...playerGrid(externalCount, px, 118));
  return out;
}

/** 命中测试：屏幕上的虚拟像素坐标落在哪个槽位里 */
export function slotAt(layout: readonly SlotRect[], x: number, y: number): number {
  for (const s of layout) {
    if (x >= s.x && x < s.x + SLOT - PAD && y >= s.y && y < s.y + SLOT - PAD) return s.index;
  }
  return -1;
}

export interface DrawContext {
  /** 物品 id -> 该画哪一层纹理 */
  iconLayer(id: number, damage: number): number;
  /** 物品 id -> 最大堆叠 */
  maxStack(id: number): number;
}

/** 画一个容器界面 */
export function drawWindow(
  ui: UiRenderer,
  kind: WindowKind,
  layout: readonly SlotRect[],
  slots: readonly ItemStack[],
  cursor: ItemStack,
  hovered: number,
  ctx: DrawContext,
  mouseX: number,
  mouseY: number,
): void {
  // 半透明的暗色底，让背后的世界还看得见一点 —— 与 MC 一致
  ui.rect(0, 0, UI_WIDTH, UI_HEIGHT, 0, 0, 0, 0.55);

  // 面板
  const px = (UI_WIDTH - 9 * SLOT) / 2;
  const panelTop = 24;
  // 高度要正好包住最后一行快捷栏（y=118+3*18+4=176，加一格 18 到 194）
  const panelH = 176;
  ui.rect(px - 8, panelTop, 9 * SLOT + 16, panelH, 0.78, 0.78, 0.78, 1);
  ui.rect(px - 6, panelTop + 2, 9 * SLOT + 12, panelH - 4, 0.86, 0.86, 0.86, 1);

  for (const s of layout) {
    // 槽位：凹陷感靠一圈深边
    ui.rect(s.x, s.y, SLOT - PAD, SLOT - PAD, 0.55, 0.55, 0.55, 1);
    ui.rect(s.x + 1, s.y + 1, SLOT - PAD - 2, SLOT - PAD - 2, 0.66, 0.66, 0.66, 1);

    const stack = slots[s.index];
    if (stack === undefined || isEmpty(stack)) continue;
    const layer = ctx.iconLayer(stack.id, stack.damage);
    if (layer >= 0) ui.sprite(s.x + 1, s.y + 1, 16, 16, layer);
    if (stack.count > 1) ui.number(stack.count, s.x + 17, s.y + 10, 1);
  }

  // 悬停高亮
  const hit = layout.find((s) => s.index === hovered);
  if (hit !== undefined) ui.rect(hit.x, hit.y, SLOT - PAD, SLOT - PAD, 1, 1, 1, 0.35);

  // 手上拿着的那一堆跟着鼠标走
  if (!isEmpty(cursor)) {
    const layer = ctx.iconLayer(cursor.id, cursor.damage);
    if (layer >= 0) ui.sprite(mouseX - 8, mouseY - 8, 16, 16, layer);
    if (cursor.count > 1) ui.number(cursor.count, mouseX + 8, mouseY + 1, 1);
  }
}

/** 画快捷栏（不开界面时也一直显示） */
export function drawHotbar(
  ui: UiRenderer,
  slots: readonly ItemStack[],
  hotbarStart: number,
  selected: number,
  ctx: DrawContext,
): void {
  const w = 9 * SLOT + 4;
  const x0 = (UI_WIDTH - w) / 2;
  const y0 = UI_HEIGHT - SLOT - 6;
  ui.rect(x0, y0, w, SLOT + 4, 0.1, 0.1, 0.1, 0.6);

  for (let i = 0; i < 9; i++) {
    const sx = x0 + 2 + i * SLOT;
    const sy = y0 + 2;
    ui.rect(sx, sy, SLOT - PAD, SLOT - PAD, 0.35, 0.35, 0.35, 0.7);
    const stack = slots[hotbarStart + i];
    if (stack !== undefined && !isEmpty(stack)) {
      const layer = ctx.iconLayer(stack.id, stack.damage);
      if (layer >= 0) ui.sprite(sx + 1, sy + 1, 16, 16, layer);
      if (stack.count > 1) ui.number(stack.count, sx + 17, sy + 10, 1);
    }
    if (i === selected) {
      // 选中框：四条边，别用实心叠加 —— 那样会把图标压暗
      const t = 1;
      ui.rect(sx - 1, sy - 1, SLOT + 1, t, 1, 1, 1, 0.9);
      ui.rect(sx - 1, sy + SLOT - 1, SLOT + 1, t, 1, 1, 1, 0.9);
      ui.rect(sx - 1, sy - 1, t, SLOT + 1, 1, 1, 1, 0.9);
      ui.rect(sx + SLOT - 1, sy - 1, t, SLOT + 1, 1, 1, 1, 0.9);
    }
  }
}

/** 准星 */
export function drawCrosshair(ui: UiRenderer): void {
  const cx = UI_WIDTH / 2;
  const cy = UI_HEIGHT / 2;
  ui.rect(cx - 5, cy - 0.5, 10, 1, 1, 1, 1, 0.75);
  ui.rect(cx - 0.5, cy - 5, 1, 10, 1, 1, 1, 0.75);
}
