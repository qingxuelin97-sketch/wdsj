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

/**
 * MC 的界面配色。**照抄不估** —— 与 `docs/RULES.md` 第 6 条同一条道理。
 *
 * 原来这里写的是 0.78 / 0.86 / 0.55 / 0.66 这类拍脑袋的灰度，
 * 画出来是两层平板。MC 的界面之所以一眼认得出，靠的不是灰度值本身，
 * 而是 **Windows-95 式的斜面**：外凸的面板左上白、右下深灰；
 * 内凹的槽位反过来。少了这一层，多准的灰度也还是草图。
 */
const C = {
  white: 1,
  panel: 198 / 255, // #C6C6C6 面板底
  slot: 139 / 255, // #8B8B8B 槽位底
  shadow: 85 / 255, // #555555 面板右下阴影
  slotDark: 55 / 255, // #373737 槽位左上暗边
};

/** 外凸面板：黑外框 + 左上白高光 + 右下深灰阴影 + 面板底 */
function panelRaised(ui: UiRenderer, x: number, y: number, w: number, h: number): void {
  ui.rect(x, y, w, h, 0, 0, 0, 1);
  ui.rect(x + 1, y + 1, w - 2, h - 2, C.shadow, C.shadow, C.shadow, 1);
  // 高光只铺左上两条，右下留着露出上一层的深灰
  ui.rect(x + 1, y + 1, w - 3, h - 3, C.white, C.white, C.white, 1);
  ui.rect(x + 2, y + 2, w - 4, h - 4, C.panel, C.panel, C.panel, 1);
}

/**
 * 内凹槽位，18×18。
 *
 * 尺寸正好等于 `SLOT` 的步进，所以相邻槽位严丝合缝地拼起来：
 * 前一格的右下亮边紧挨后一格的左上暗边 —— MC 那种连成一片的
 * 格子网就是这么来的，格与格之间留缝反而会散。
 */
function slotInset(ui: UiRenderer, x: number, y: number): void {
  ui.rect(x, y, SLOT, SLOT, C.slotDark, C.slotDark, C.slotDark, 1);
  ui.rect(x + 1, y + 1, SLOT - 1, SLOT - 1, C.white, C.white, C.white, 1);
  ui.rect(x + 1, y + 1, SLOT - 2, SLOT - 2, C.slot, C.slot, C.slot, 1);
}

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
  panelRaised(ui, px - 8, panelTop, 9 * SLOT + 16, panelH);

  for (const s of layout) {
    slotInset(ui, s.x, s.y);

    const stack = slots[s.index];
    if (stack === undefined || isEmpty(stack)) continue;
    const layer = ctx.iconLayer(stack.id, stack.damage);
    if (layer >= 0) ui.sprite(s.x + 1, s.y + 1, 16, 16, layer);
    if (stack.count > 1) ui.number(stack.count, s.x + 17, s.y + 10, 1);
  }

  // 悬停高亮
  const hit = layout.find((s) => s.index === hovered);
  // 高亮只盖 16×16 的内容区，不盖斜面 —— 盖住斜面槽位就"平"了
  if (hit !== undefined) ui.rect(hit.x + 1, hit.y + 1, SLOT - 2, SLOT - 2, 1, 1, 1, 0.35);

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
  // 快捷栏是压在世界上的，不能像容器面板那样用不透明的浅灰 ——
  // 那会在画面底部糊掉一整条。MC 用的是半透明深色 + 一圈亮边
  ui.rect(x0 - 1, y0 - 1, w + 2, SLOT + 6, 0, 0, 0, 0.55);
  ui.rect(x0, y0, w, SLOT + 4, 0.55, 0.55, 0.55, 0.45);
  ui.rect(x0 + 1, y0 + 1, w - 2, SLOT + 2, 0.13, 0.13, 0.13, 0.72);

  for (let i = 0; i < 9; i++) {
    const sx = x0 + 2 + i * SLOT;
    const sy = y0 + 2;
    // 槽位之间的分隔靠一条暗边 + 一条亮边，与容器界面同一套斜面语言
    ui.rect(sx, sy, SLOT, SLOT, 0.09, 0.09, 0.09, 0.55);
    ui.rect(sx + 1, sy + 1, SLOT - 1, SLOT - 1, 0.68, 0.68, 0.68, 0.30);
    ui.rect(sx + 1, sy + 1, SLOT - 2, SLOT - 2, 0.31, 0.31, 0.31, 0.55);
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

/**
 * 熔炉的火焰与箭头。
 *
 * 位置从**槽位表**推出来，不另写一套坐标：布局一旦改了，进度条会跟着走。
 * 这和 layoutFor / slotAt 共用一张表是同一条理由（见文件顶部）。
 *
 * 形状用纯色矩形画：火焰是一列从下往上长的橙块，箭头是一条从左往右长的白条。
 * 为了两个指示器去烘两张贴图不划算，而且纯色块在任何缩放下都清晰。
 */
export function drawFurnaceProgress(
  ui: UiRenderer,
  layout: readonly SlotRect[],
  progress: { burnTime: number; burnTotal: number; cookTime: number },
): void {
  const input = layout.find((s) => s.index === 0);
  const fuel = layout.find((s) => s.index === 1);
  const output = layout.find((s) => s.index === 2);
  if (input === undefined || fuel === undefined || output === undefined) return;

  // 火焰：夹在输入格与燃料格之间，从下往上烧完
  const burn = progress.burnTotal > 0
    ? Math.max(0, Math.min(1, progress.burnTime / progress.burnTotal))
    : 0;
  const fx = fuel.x + 3;
  const fy = fuel.y - 14;
  ui.rect(fx, fy, 12, 12, 0.25, 0.25, 0.25, 0.6);
  if (burn > 0) {
    const h = Math.round(12 * burn);
    ui.rect(fx, fy + (12 - h), 12, h, 1, 0.62, 0.12, 1);
  }

  // 箭头：从输入格指向产物格，按熔炼进度从左往右长
  const cook = Math.max(0, Math.min(1, progress.cookTime / FURNACE_COOK_TICKS));
  const ax = input.x + SLOT + 4;
  const ay = input.y + SLOT / 2 - 2;
  const aw = output.x - ax - 4;
  if (aw <= 0) return;
  ui.rect(ax, ay, aw, 5, 0.35, 0.35, 0.35, 0.7);
  if (cook > 0) ui.rect(ax, ay, Math.round(aw * cook), 5, 0.95, 0.95, 0.95, 1);
}

/** 一次熔炼多少刻。与 server/world/block-entity.ts 的 SMELT_TICKS 一致 */
const FURNACE_COOK_TICKS = 200;

/** 准星 */
export function drawCrosshair(ui: UiRenderer): void {
  const cx = UI_WIDTH / 2;
  const cy = UI_HEIGHT / 2;
  ui.rect(cx - 5, cy - 0.5, 10, 1, 1, 1, 1, 0.75);
  ui.rect(cx - 0.5, cy - 5, 1, 10, 1, 1, 1, 0.75);
}

/**
 * 生存状态条：血、饥饿、氧气、经验。
 *
 * 摆位照抄 MC：血在快捷栏左上、饥饿在右上、氧气在饥饿之上、
 * 经验条横跨快捷栏正上方。这不是审美偏好 —— 玩家的余光是按位置找信息的，
 * 摆错地方等于没有。
 *
 * 图形用纯色小方块拼，和数字点阵同一套理由：为几个图标去烘贴图不划算，
 * 而且纯色块在任何缩放下都清晰。心形用"两个小方块 + 一个尖"近似。
 */
export function drawVitals(
  ui: UiRenderer,
  v: { health: number; maxHealth: number; hunger: number; air: number; xpLevel: number; xpProgress: number },
): void {
  const w = 9 * SLOT + 4;
  const x0 = (UI_WIDTH - w) / 2;
  const barY = UI_HEIGHT - SLOT - 6;

  // --- 经验条：快捷栏正上方一条细带 ---
  const xpY = barY - 8;
  ui.rect(x0, xpY, w, 4, 0.12, 0.12, 0.12, 0.8);
  if (v.xpProgress > 0) {
    ui.rect(x0 + 1, xpY + 1, (w - 2) * (v.xpProgress / 255), 2, 0.45, 0.92, 0.20, 1);
  }
  if (v.xpLevel > 0) {
    // 等级数字压在经验条中间，绿色 —— MC 也是这样
    ui.number(v.xpLevel, UI_WIDTH / 2 + 6, xpY - 6, 1, 0.5, 1, 0.4);
  }

  // --- 血：10 颗心，每颗两点 ---
  const rowY = xpY - 11;
  for (let i = 0; i < 10; i++) {
    const hx = x0 + i * 8;
    // 底槽
    heart(ui, hx, rowY, 0.16, 0.16, 0.16, 0.85);
    const filled = v.health - i * 2;
    if (filled >= 2) heart(ui, hx, rowY, 0.85, 0.12, 0.12, 1);
    else if (filled >= 1) halfHeart(ui, hx, rowY, 0.85, 0.12, 0.12);
  }

  // --- 饥饿：10 个鸡腿，右对齐 ---
  for (let i = 0; i < 10; i++) {
    const hx = x0 + w - 8 - i * 8;
    ui.rect(hx, rowY, 7, 7, 0.16, 0.16, 0.16, 0.85);
    const filled = v.hunger - i * 2;
    if (filled >= 2) ui.rect(hx + 1, rowY + 1, 5, 5, 0.72, 0.45, 0.16, 1);
    else if (filled >= 1) ui.rect(hx + 1, rowY + 1, 2, 5, 0.72, 0.45, 0.16, 1);
  }

  // --- 氧气：只在水下（air < 20）时画，在饥饿之上 ---
  if (v.air < 20) {
    for (let i = 0; i < 10; i++) {
      if (v.air <= i * 2) continue;
      const hx = x0 + w - 8 - i * 8;
      ui.rect(hx + 1, rowY - 9, 5, 5, 0.35, 0.72, 0.95, 1);
    }
  }
}

/** 一颗心：两个方块加一个下尖 */
function heart(ui: UiRenderer, x: number, y: number, r: number, g: number, b: number, a: number): void {
  ui.rect(x, y, 3, 3, r, g, b, a);
  ui.rect(x + 4, y, 3, 3, r, g, b, a);
  ui.rect(x, y + 2, 7, 2, r, g, b, a);
  ui.rect(x + 1, y + 4, 5, 1, r, g, b, a);
  ui.rect(x + 2, y + 5, 3, 1, r, g, b, a);
}

/** 半颗心：只画左半边 */
function halfHeart(ui: UiRenderer, x: number, y: number, r: number, g: number, b: number): void {
  ui.rect(x, y, 3, 3, r, g, b, 1);
  ui.rect(x, y + 2, 4, 2, r, g, b, 1);
  ui.rect(x + 1, y + 4, 2, 1, r, g, b, 1);
  ui.rect(x + 2, y + 5, 1, 1, r, g, b, 1);
}

/**
 * 死亡界面。
 *
 * 一层暗红的罩子 + 一行字。真正重要的是它**挡住了世界** ——
 * 死亡要有分量，而"画面照常、只是不能动"完全没有分量。
 */
export function drawDeathScreen(ui: UiRenderer): void {
  ui.rect(0, 0, UI_WIDTH, UI_HEIGHT, 0.45, 0.02, 0.02, 0.6);
  // "你死了"用点阵数字画不出来，改成一个醒目的图形：一颗碎掉的心
  const cx = UI_WIDTH / 2 - 12;
  const cy = UI_HEIGHT / 2 - 26;
  heart(ui, cx, cy, 0.55, 0.08, 0.08, 1);
  heart(ui, cx + 16, cy, 0.55, 0.08, 0.08, 1);
  // 一条提示带，宽度暗示"按键重生"
  ui.rect(UI_WIDTH / 2 - 60, UI_HEIGHT / 2 + 6, 120, 14, 0.15, 0.15, 0.15, 0.9);
  ui.rect(UI_WIDTH / 2 - 58, UI_HEIGHT / 2 + 8, 116, 10, 0.35, 0.35, 0.35, 0.9);
}
