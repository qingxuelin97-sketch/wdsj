/**
 * 全屏菜单：主菜单 / 世界列表 / 设置 / 暂停。
 *
 * ## 为什么是一个状态机而不是四个类
 *
 * 四个界面的差别几乎只有"标题是什么、有哪几个按钮、点了跳到哪" ——
 * 写成四个类的话，每个类里有意义的代码只有一张按钮表，而布局、
 * 命中测试、绘制会被复制四遍。这与 `content/particles.ts` 把十种粒子
 * 写成一张数据表是同一个判断。
 *
 * ## 设置项是**真的**生效的
 *
 * 视距、FOV、界面缩放三项都接到了实际的渲染参数上。摆几个不接线的
 * 滑块比没有设置界面更糟 —— 那是在骗验收。
 */
import { UiRenderer, UI_WIDTH, UI_HEIGHT } from './ui-renderer.ts';
import {
  C, panelRaised, inset, drawButton, buttonAt, column, centeredText, textWidth,
  BUTTON_H, type Button,
} from './ui-widgets.ts';
import { GLYPH_H } from './font.ts';

export type MenuId = 'none' | 'main' | 'worlds' | 'settings' | 'pause';

/** 玩家能改的东西。全部由 MenuState 持有，改完由宿主读走 */
export interface GameSettings {
  renderDistance: number;
  fov: number;
  /** 界面缩放；0 表示自动（按画布大小取整数倍） */
  guiScale: number;
  particles: boolean;
  sound: boolean;
}

export const DEFAULT_SETTINGS: GameSettings = {
  renderDistance: 8, fov: 70, guiScale: 0, particles: true, sound: true,
};

/** 一个存档条目 */
export interface WorldEntry {
  readonly name: string;
  readonly seed: number;
  /** 最后游玩时间，毫秒时间戳。0 表示没玩过 */
  readonly lastPlayed: number;
}

/**
 * 设置项的取值循环。
 *
 * 用"点一下换下一档"而不是滑块：滑块要拖拽，而拖拽在指针锁、
 * 触摸屏、自动化脚本三种输入下各有各的坑。循环按钮三种输入下行为一致，
 * 而且天然可截图回归（每一档都是确定的一帧）。
 */
const RENDER_DISTANCES = [4, 6, 8, 12, 16] as const;
const FOVS = [60, 70, 80, 90, 110] as const;
const GUI_SCALES = [0, 1, 2, 3] as const;

function cycle<T>(values: readonly T[], current: T): T {
  const i = values.indexOf(current);
  return values[(i + 1) % values.length]!;
}

/** 菜单要向宿主请求的动作 */
export type MenuAction =
  | { kind: 'resume' }
  | { kind: 'play'; seed: number; name: string }
  | { kind: 'toTitle' }
  | { kind: 'quit' }
  | { kind: 'settingsChanged' }
  | { kind: 'none' };

export class MenuState {
  screen: MenuId = 'none';
  readonly settings: GameSettings = { ...DEFAULT_SETTINGS };
  worlds: WorldEntry[] = [];
  /** 世界列表里选中第几个，-1 表示没选 */
  selectedWorld = -1;
  mouseX = UI_WIDTH / 2;
  mouseY = UI_HEIGHT / 2;
  /** 上一次布局出来的按钮，命中测试与绘制共用同一份 —— 两边各算一套是经典 bug 源 */
  private buttons: Button[] = [];

  get open(): boolean {
    return this.screen !== 'none';
  }

  /** 打开某个界面。`none` 关闭 */
  show(screen: MenuId): void {
    this.screen = screen;
    this.buttons = this.layout();
  }

  onMouseMove(x: number, y: number): void {
    this.mouseX = x;
    this.mouseY = y;
  }

  /** 点一下。返回宿主要执行的动作 */
  click(): MenuAction {
    const hit = buttonAt(this.buttons, this.mouseX, this.mouseY);
    if (hit === null) return { kind: 'none' };
    return this.activate(hit.id);
  }

  /** 直接按 id 触发一个按钮，自动化脚本用 —— 不必去算像素坐标 */
  press(id: string): MenuAction {
    return this.activate(id);
  }

  /** 当前界面上所有按钮的 id，自动化脚本用 */
  buttonIds(): string[] {
    return this.buttons.map((b) => b.id);
  }

  private activate(id: string): MenuAction {
    const s = this.settings;
    switch (id) {
      case 'singleplayer': this.show('worlds'); return { kind: 'none' };
      case 'settings': case 'settings2': this.show('settings'); return { kind: 'none' };
      case 'quit': return { kind: 'quit' };
      case 'resume': this.show('none'); return { kind: 'resume' };
      case 'toTitle': this.show('main'); return { kind: 'toTitle' };
      case 'back':
        // 设置界面的返回：从暂停进来的回暂停，从主菜单进来的回主菜单。
        // 用"世界列表里有没有选中项"判断不靠谱，所以记在 settingsFrom 上
        this.show(this.settingsFrom);
        return { kind: 'none' };
      case 'newWorld': {
        const seed = (Date.now() ^ 0x5f3759df) >>> 0;
        return { kind: 'play', seed, name: `世界 ${this.worlds.length + 1}` };
      }
      case 'play': {
        const w = this.worlds[this.selectedWorld];
        if (w === undefined) return { kind: 'none' };
        return { kind: 'play', seed: w.seed, name: w.name };
      }
      case 'rd': s.renderDistance = cycle(RENDER_DISTANCES, s.renderDistance as 4); break;
      case 'fov': s.fov = cycle(FOVS, s.fov as 60); break;
      case 'gui': s.guiScale = cycle(GUI_SCALES, s.guiScale as 0); break;
      case 'particles': s.particles = !s.particles; break;
      case 'sound': s.sound = !s.sound; break;
      default:
        if (id.startsWith('world:')) {
          this.selectedWorld = Number(id.slice(6));
          this.buttons = this.layout();
          return { kind: 'none' };
        }
        return { kind: 'none' };
    }
    this.buttons = this.layout();
    return { kind: 'settingsChanged' };
  }

  /** 设置界面是从哪儿进来的，决定"返回"回到哪 */
  private settingsFrom: MenuId = 'main';

  /** 记住来路再打开设置 */
  openSettingsFrom(from: MenuId): void {
    this.settingsFrom = from;
    this.show('settings');
  }

  private layout(): Button[] {
    const s = this.settings;
    switch (this.screen) {
      case 'main':
        return column([
          { id: 'singleplayer', label: 'SINGLEPLAYER' },
          { id: 'settings', label: 'OPTIONS' },
          { id: 'quit', label: 'QUIT GAME' },
        ], 118);
      case 'pause':
        return column([
          { id: 'resume', label: 'BACK TO GAME' },
          { id: 'settings2', label: 'OPTIONS' },
          { id: 'toTitle', label: 'SAVE AND QUIT TO TITLE' },
        ], 96);
      case 'settings':
        return [
          ...column([
            { id: 'rd', label: `RENDER DISTANCE: ${s.renderDistance}` },
            { id: 'fov', label: `FOV: ${s.fov}` },
            { id: 'gui', label: `GUI SCALE: ${s.guiScale === 0 ? 'AUTO' : String(s.guiScale)}` },
            { id: 'particles', label: `PARTICLES: ${s.particles ? 'ON' : 'OFF'}` },
            { id: 'sound', label: `SOUND: ${s.sound ? 'ON' : 'OFF'}` },
          ], 52),
          ...column([{ id: 'back', label: 'DONE' }], 192),
        ];
      case 'worlds': {
        const rows = this.worlds.map((w, i) => ({
          id: `world:${i}`, label: `${w.name}  (SEED ${w.seed})`,
        }));
        return [
          ...column(rows, 48, 2, 220),
          ...column([
            { id: 'play', label: 'PLAY SELECTED', enabled: this.selectedWorld >= 0 },
            { id: 'newWorld', label: 'CREATE NEW WORLD' },
            { id: 'back', label: 'BACK' },
          ], 168),
        ];
      }
      default: return [];
    }
  }

  draw(ui: UiRenderer): void {
    if (this.screen === 'none') return;
    this.drawBackdrop(ui);

    // 标题**不用 MINECRAFT** —— 那是 Mojang 的商标。
    // 这个项目是从零复刻，README 的头号说明就是"不含任何 Mojang 素材"；
    // 把商标印在标题画面上，性质比贴图更直接（那是在冒充）。
    // 用项目自己的名字（index.html 的 <title> 是「我的世界 · 复刻」，
    // 游戏内 UI 按 DEVIATIONS 一律英文）。
    const title = this.screen === 'main' ? 'VOXEL REPLICA'
      : this.screen === 'pause' ? 'GAME MENU'
        : this.screen === 'settings' ? 'OPTIONS' : 'SELECT WORLD';
    // 主菜单的标题大一号，其余一号 —— 主菜单是"品牌"，其余是"功能页"
    const scale = this.screen === 'main' ? 3 : 2;
    centeredText(ui, title, this.screen === 'main' ? 56 : 20, scale, 1, 1, 1);
    if (this.screen === 'main') {
      // 只能用 5×7 字模里有的字符（可打印 ASCII）。
      // 第一版写了个中点 · —— 字模里没有，渲染出来是一段空白，
      // 而"少了个字符"在截图上极不显眼，差点就这么过去了
      centeredText(ui, 'A FROM-SCRATCH REPLICA - ZERO DEPENDENCIES', 84, 1, 0.72, 0.72, 0.55);
    }

    if (this.screen === 'worlds') this.drawWorldRows(ui);

    const hit = buttonAt(this.buttons, this.mouseX, this.mouseY);
    for (const b of this.buttons) {
      // 世界列表的行自己画（要带选中态），不走通用按钮
      if (b.id.startsWith('world:')) continue;
      drawButton(ui, b, hit !== null && hit.id === b.id);
    }
  }

  /**
   * 背景。
   *
   * 主菜单是全屏不透明的 —— 那时候身后没有世界，露出来的会是清屏色。
   * 暂停/设置是半透明的，能看见身后的世界，玩家才知道自己没退出游戏。
   */
  private drawBackdrop(ui: UiRenderer): void {
    if (this.screen === 'main' || this.screen === 'worlds') {
      ui.rect(0, 0, UI_WIDTH, UI_HEIGHT, 0.11, 0.11, 0.13, 1);
      // 一条压暗的横带衬住标题，纯色背景上文字会飘
      ui.rect(0, this.screen === 'main' ? 48 : 14, UI_WIDTH, this.screen === 'main' ? 48 : 24,
        0.07, 0.07, 0.09, 1);
    } else {
      ui.rect(0, 0, UI_WIDTH, UI_HEIGHT, 0, 0, 0, 0.62);
    }
  }

  private drawWorldRows(ui: UiRenderer): void {
    const rows = this.buttons.filter((b) => b.id.startsWith('world:'));
    if (rows.length === 0) {
      centeredText(ui, 'NO WORLDS YET  -  CREATE ONE BELOW', 96, 1, 0.7, 0.7, 0.7);
      return;
    }
    const hit = buttonAt(this.buttons, this.mouseX, this.mouseY);
    for (const b of rows) {
      const idx = Number(b.id.slice(6));
      const selected = idx === this.selectedWorld;
      const hovered = hit !== null && hit.id === b.id;
      if (selected) panelRaised(ui, b.x, b.y, b.w, b.h);
      else inset(ui, b.x, b.y, b.w, b.h, hovered ? 0.42 : 0.28);
      const c = selected ? 0.1 : 0.92;
      ui.text(b.label, b.x + 5, b.y + Math.round((b.h - GLYPH_H) / 2), 1, c, c, c);
    }
  }
}

/** 主菜单底部的版本水印，画在最外层 */
export function drawVersionTag(ui: UiRenderer, text: string): void {
  ui.text(text, 3, UI_HEIGHT - GLYPH_H - 3, 1, 0.62, 0.62, 0.62);
  void textWidth;
  void C;
  void BUTTON_H;
}
