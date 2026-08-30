/**
 * F3 调试叠层。
 *
 * 玩家价值为零，开发速度价值巨大 —— 这是从计划一开始就写下的判断，
 * 现在兑现它。查任何一个"画面不对"的问题，第一步都是看这几行数：
 * 我在哪、脚下是什么、这一格光照多少、有多少段在排队。
 *
 * 画在 canvas 里而不是 DOM 里，理由只有一个：**截图回归比对的是 canvas**。
 * 拿 DOM 画的话，"F3 截图匹配"这条验收永远是绿的，因为它比对的画面里
 * 压根没有 F3。
 *
 * 左栏是"我和世界"，右栏是"引擎在忙什么"，和 MC 的分栏一致。
 */
import type { UiRenderer } from './ui-renderer.ts';
import { UI_WIDTH } from './ui-renderer.ts';
import { GLYPH_H, textWidth } from './font.ts';
import { findBiome } from '../../content/biomes.ts';

/** 行距 */
const LINE = GLYPH_H + 2;
const MARGIN = 3;

export interface DebugInfo {
  readonly fps: number;
  readonly frameMs: number;
  /** 最近若干帧的耗时，用来画直方图 */
  readonly frameSamples: readonly number[];
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
  /** 脚下那一格的方块名，空气时为 'air' */
  readonly standingOn: string;
  readonly biomeId: number;
  readonly skyLight: number;
  readonly blockLight: number;
  readonly timeOfDay: number;
  readonly worldAge: number;
  readonly rain: number;
  readonly thunder: number;
  /** 引擎侧 */
  readonly clientChunks: number;
  readonly serverChunks: number;
  readonly dirtySections: number;
  readonly meshInFlight: number;
  readonly pendingChunks: number;
  readonly sectionsDrawn: number;
  readonly sectionCount: number;
  readonly drawCalls: number;
  readonly quads: number;
  readonly vramMB: number;
  readonly particles: number;
  readonly entities: number;
  readonly mobs: number;
  readonly serverTick: number;
  readonly serverTickMs: number;
  readonly jsHeapMB: number;
}

/** 朝向：MC 的 "facing: south (Towards positive Z)" 那一行 */
function facingOf(yaw: number): string {
  // 与 camera.ts 的约定一致：yaw 0 朝 +Z，逆时针为正
  const deg = ((yaw * 180) / Math.PI % 360 + 360) % 360;
  if (deg < 45 || deg >= 315) return 'south +Z';
  if (deg < 135) return 'east -X';
  if (deg < 225) return 'north -Z';
  return 'west +X';
}

function fmt(v: number, digits = 1): string {
  return v.toFixed(digits);
}

/**
 * 画 F3。
 *
 * **调用方要在这之后单独 flush 一次**：一屏 F3 有六七百个矩形，
 * 而 UiRenderer 的缓冲上限是 1024 —— 和物品栏挤在一批里会溢出，
 * 表现是界面画一半没了。
 */
export function drawDebugOverlay(ui: UiRenderer, d: DebugInfo): void {
  // 半透明黑底。文字直接压在世界上时，浅色地形（雪、沙）会让白字消失
  const left: string[] = [
    `${fmt(d.fps, 0)} fps  ${fmt(d.frameMs, 1)} ms`,
    `XYZ ${fmt(d.x, 2)} / ${fmt(d.y, 2)} / ${fmt(d.z, 2)}`,
    `Block ${Math.floor(d.x)} ${Math.floor(d.y)} ${Math.floor(d.z)}`,
    `Chunk ${Math.floor(d.x) >> 4} ${Math.floor(d.z) >> 4}`
      + `  rel ${((Math.floor(d.x) % 16) + 16) % 16} ${((Math.floor(d.z) % 16) + 16) % 16}`,
    `Facing ${facingOf(d.yaw)}  pitch ${fmt((d.pitch * 180) / Math.PI, 0)}`,
    `Biome ${findBiome(d.biomeId)?.name ?? `#${d.biomeId}`}`,
    `Standing on ${d.standingOn}`,
    `Light ${Math.max(d.skyLight, d.blockLight)} (${d.skyLight} sky, ${d.blockLight} block)`,
    `Time ${d.timeOfDay}  day ${Math.floor(d.worldAge / 24000)}`,
    `Weather rain ${fmt(d.rain, 2)}  thunder ${fmt(d.thunder, 2)}`,
  ];

  const right: string[] = [
    `Chunks ${d.clientChunks} / ${d.serverChunks} server`,
    `Sections ${d.sectionsDrawn} / ${d.sectionCount}`,
    `Mesh queue ${d.dirtySections}  in flight ${d.meshInFlight}`,
    `Pending push ${d.pendingChunks}`,
    `Draws ${d.drawCalls}  quads ${d.quads}`,
    `VRAM ${fmt(d.vramMB, 1)} MB`,
    `Heap ${d.jsHeapMB < 0 ? 'n/a' : `${d.jsHeapMB} MB`}`,
    `Particles ${d.particles}`,
    `Entities ${d.entities} items  ${d.mobs} mobs`,
    `Server ${d.serverTick} t  ${fmt(d.serverTickMs, 1)} ms`,
  ];

  drawColumn(ui, left, MARGIN, MARGIN, false);
  drawColumn(ui, right, UI_WIDTH - MARGIN, MARGIN, true);
  drawFrameGraph(ui, d.frameSamples, UI_WIDTH - MARGIN - 60, MARGIN + right.length * LINE + 4);
}

function drawColumn(ui: UiRenderer, lines: string[], x: number, y: number, rightAlign: boolean): void {
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    const w = textWidth(text);
    const lx = rightAlign ? x - w : x;
    const ly = y + i * LINE;
    // 每行自己一块底，而不是整栏一个大矩形 —— 短行右边不会拖一条黑尾巴
    ui.rect(lx - 1, ly - 1, w + 2, GLYPH_H + 2, 0, 0, 0, 0.45);
    ui.text(text, lx, ly, 1, 1, 1, 1, false);
  }
}

/**
 * 帧时间直方图。
 *
 * 一个数字（当前帧 16.7ms）说明不了卡不卡 —— 卡是**偶发的尖峰**，
 * 而尖峰在平均值里看不见。这条图是唯一能一眼看出"每隔一秒顿一下"的东西。
 *
 * 基准线画在 16.7ms（60fps）上：条越过它就是掉帧。
 */
function drawFrameGraph(ui: UiRenderer, samples: readonly number[], x: number, y: number): void {
  const H = 24;
  const W = 60;
  if (samples.length === 0) return;
  ui.rect(x, y, W, H, 0, 0, 0, 0.45);
  // 60fps 基准线
  const target = 1000 / 60;
  const scale = H / (target * 3);
  ui.rect(x, y + H - target * scale, W, 1, 0.4, 0.9, 0.4, 0.6);

  const n = Math.min(W, samples.length);
  const start = samples.length - n;
  for (let i = 0; i < n; i++) {
    const ms = samples[start + i]!;
    const h = Math.max(1, Math.min(H, ms * scale));
    // 超过 60fps 预算的条变红。颜色是这张图唯一需要被"读"的信息
    const over = ms > target;
    ui.rect(x + i, y + H - h, 1, h, over ? 1 : 0.55, over ? 0.4 : 0.85, 0.35, 0.9);
  }
}
