/**
 * 执行菜单按钮。
 *
 * 从 `client-main.ts` 分出来的（那个文件第六次顶到 600 行硬上限）。
 * 分界线很清楚：菜单**决定要做什么**（`MenuAction`），这里**真的去做**。
 * 中间那层 action 值得存在 —— 少了它，`MenuState` 就得直接握着相机、
 * 网络、音频，而它是个能在 node 里单测的纯状态机，握了就不是了。
 *
 * ## 设置项必须真的接上
 *
 * 摆几个不生效的选项比没有设置界面更糟 —— 那是在骗验收。
 * 所以这里每一项都落到真实的运行时参数上，而不是只改 `settings` 里的数字。
 */
import type { Camera } from '../client/camera.ts';
import type { PacketChannel } from '../core/net/transport.ts';
import type { AudioEngine } from '../client/audio/audio-engine.ts';
import type { UiController } from '../client/ui/ui-controller.ts';
import type { ClientSession } from './client-session.ts';
import type { MenuAction } from '../client/ui/menu-screen.ts';
import { C_SetViewDistance } from '../core/net/packets.ts';
import { SECTION_SIZE } from '../core/constants.ts';

export interface MenuActionDeps {
  readonly ui: UiController;
  readonly camera: Camera;
  readonly net: PacketChannel;
  readonly audio: AudioEngine;
  readonly session: ClientSession;
  /** 视距是 client-main 的模块级变量，这里只能通过 setter 改 */
  setRenderDistance(n: number): void;
  setAmbientParticles(on: boolean): void;
}

export function runMenuAction(action: MenuAction, d: MenuActionDeps): void {
  const s = d.ui.menu.settings;
  switch (action.kind) {
    case 'settingsChanged': {
      // 视距要**同时**改相机远平面与订阅半径。
      // 只改远平面：远处的区块加载了却被裁掉，等于白加载；
      // 只改订阅半径：远处根本没数据，画面边缘是空洞。
      d.setRenderDistance(s.renderDistance);
      d.camera.far = s.renderDistance * SECTION_SIZE * 1.8;
      d.camera.fovDegrees = s.fov;
      d.net.send(C_SetViewDistance, { distance: s.renderDistance });
      d.net.flush();
      d.setAmbientParticles(s.particles);
      d.audio.setMuted(!s.sound);
      break;
    }
    case 'toTitle':
      // 退回标题：先落盘再显示主菜单。不存的话这一局白玩了。
      // `persist=0` 时（截图回归）没有存档，跳过
      if (d.session.persist) void d.session.requestSave();
      d.ui.menu.show('main');
      break;
    case 'play':
      // 单人模式下换世界要重开页面。
      //
      // 服务端 worker 持有整个世界 —— 区块、实体、计划刻队列、存档句柄。
      // 就地换种子得把这些全部拆掉重建，而漏掉任何一样都会表现为
      // "新世界里混着上一个世界的东西"，那是最难查的一类脏状态。
      // 重新加载一次页面是几百毫秒的事，换来的是绝对干净的初始态。
      location.href = `${location.pathname}?seed=${action.seed}`;
      break;
    case 'quit':
      // 浏览器里没有"退出游戏"可言（`window.close()` 只对脚本自己开的窗口有效），
      // 所以退回标题 —— 这也是网页版 MC 的做法
      d.ui.menu.show('main');
      break;
    case 'resume':
    default:
      break;
  }
}
