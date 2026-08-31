/**
 * 每帧的界面输入处理：边沿触发、死亡界面、快捷栏、格子点击。
 *
 * 从 client-main.ts 里分出来的一块，理由不只是行数：这块代码的复杂度
 * 全部来自**状态**（上一帧的四个按键），而不是逻辑。把那四个 `prev*`
 * 关进一个类，client-main 的主循环就只剩"这一帧做什么"，读起来是一条
 * 直线；散在模块顶层时它们和渲染、网格化、实体推进的变量混在一起，
 * 谁在什么时候写它们要一行行找。
 *
 * 边沿触发这件事本身值得强调一次：这些按键全部要用"这一帧按下、上一帧
 * 没按"来判定。写成电平触发的话，按住 E 会每帧开一次背包 —— 而且这种
 * bug 在自动化测试里不一定看得出来（press('e', 50) 只跨三帧，症状很轻）。
 */
import type { PacketChannel } from '../core/net/transport.ts';
import type { InputSnapshot } from '../client/input/input.ts';
import type { UiController } from '../client/ui/ui-controller.ts';
import type { MenuAction } from '../client/ui/menu-screen.ts';
import {
  C_PlayerAction, C_WindowClick, C_CloseWindow, C_HeldSlot, C_Respawn,
  PlayerActionKind,
} from '../core/net/packets.ts';

export interface FrameInputDeps {
  readonly net: PacketChannel;
  readonly ui: UiController;
  /** 指针在画布上的位置与画布尺寸，每帧现取（画布会被 setCanvasSize 改） */
  pointer(): { x: number; y: number; w: number; h: number };
  /** 菜单里点了按钮。宿主负责真正执行（改视距、退回标题、退出……） */
  onMenuAction(action: MenuAction): void;
}

export class FrameInput {
  /** 上一帧的按键状态，用来做边沿触发 */
  private prevInventory = false;
  private prevEscape = false;
  private prevAttack = false;
  private prevUse = false;
  /** 上一帧世界交互里的左键状态。和 prevAttack 是两个：界面开着时
   *  prevAttack 会被格子点击消费掉，而世界交互那一路需要自己的历史 */
  private prevAttackWorld = false;

  private readonly d: FrameInputDeps;

  constructor(d: FrameInputDeps) { this.d = d; }

  /**
   * 死了：只接受"重生"。
   *
   * 死亡界面挡住整个世界，输入也全部截住。让玩家在死亡界面里还能挖方块
   * 会让死亡完全没有分量，而"分量"正是这套生存循环唯一想产生的东西。
   *
   * @returns true 表示这一帧到此为止，调用方应该只渲染然后返回
   */
  handleDeath(snap: InputSnapshot): boolean {
    if (!this.d.ui.dead) return false;
    if ((snap.attack && !this.prevAttack) || (snap.use && !this.prevUse) || snap.inventory) {
      this.d.net.send(C_Respawn, {});
    }
    this.prevAttack = snap.attack;
    this.prevUse = snap.use;
    this.prevInventory = snap.inventory;
    return true;
  }

  /**
   * 菜单（主菜单 / 暂停 / 设置 / 世界列表）。
   *
   * 返回 true 表示这一帧被菜单吃掉了，调用方应该只渲染然后返回 ——
   * 与 `handleDeath` 同一个约定。菜单开着时走路、挖方块、开背包
   * 全部不该生效，而这一条不放在这里的话，会散成十几处 `if (!menu.open)`。
   */
  handleMenu(snap: InputSnapshot): boolean {
    const { ui } = this.d;
    // Esc 的处理顺序：容器窗口优先于菜单，见 UiController.onEscape
    if (snap.escape && !this.prevEscape) {
      if (ui.open) {
        this.d.net.send(C_CloseWindow, { windowId: ui.windowId });
        ui.onCloseWindow();
      } else {
        ui.onEscape();
      }
    }
    this.prevEscape = snap.escape;
    if (!ui.menuOpen) return false;

    const p = this.d.pointer();
    ui.onMouseMove(p.x, p.y, p.w, p.h);
    if (snap.attack && !this.prevAttack) this.d.onMenuAction(ui.menuClick());
    this.prevAttack = snap.attack;
    this.prevUse = snap.use;
    this.prevInventory = snap.inventory;
    return true;
  }

  /** 界面开关、快捷栏、以及界面开着时的格子点击 */
  handleUi(snap: InputSnapshot): void {
    const { net, ui } = this.d;

    if (snap.inventory && !this.prevInventory) {
      if (ui.open) {
        net.send(C_CloseWindow, { windowId: ui.windowId });
        ui.onCloseWindow();
      } else {
        net.send(C_PlayerAction, {
          action: PlayerActionKind.OPEN_INVENTORY, x: 0, y: 0, z: 0, face: 0,
        });
      }
    }
    this.prevInventory = snap.inventory;

    // 数字键切快捷栏
    if (snap.hotbarKey >= 0 && snap.hotbarKey !== ui.selectedHotbar) {
      ui.selectedHotbar = snap.hotbarKey;
      net.send(C_HeldSlot, { slot: snap.hotbarKey });
    }

    // 界面开着时鼠标用来点格子，不动相机也不挖方块
    if (ui.open) {
      const p = this.d.pointer();
      ui.onMouseMove(p.x, p.y, p.w, p.h);
      if (snap.attack && !this.prevAttack) {
        const click = ui.click(0, snap.sneak);
        if (click !== null) net.send(C_WindowClick, click);
      }
      if (snap.use && !this.prevUse) {
        const click = ui.click(1, snap.sneak);
        if (click !== null) net.send(C_WindowClick, click);
      }
    }
    this.prevAttack = snap.attack;
    this.prevUse = snap.use;
  }

  /** 这一帧左键是否刚在世界里按下（用于"打生物而不是挖方块"的判定） */
  attackPressedInWorld(snap: InputSnapshot): boolean {
    return snap.attack && !this.prevAttackWorld;
  }

  /** 世界交互处理完后调一次，推进它自己那份历史 */
  endWorldFrame(snap: InputSnapshot): void {
    this.prevAttackWorld = snap.attack;
  }
}
