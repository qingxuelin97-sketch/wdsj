/**
 * 把 `window.__mc` 测试钩子接到客户端的各个部件上。
 *
 * ## 为什么单独一个文件
 *
 * `HostBridge` 有四十来个方法，全是"把某个内部状态读出来"的一行胶水。
 * 它们原来堆在 `client-main.ts` 里，占了整整一百多行 —— 而那个文件
 * 已经第七次顶到 600 行硬上限了。更要紧的是它们与主循环**没有关系**：
 * 主循环读了看不出任何时序，只会把真正的逻辑淹掉。
 *
 * 这里不改变任何行为，纯搬家：同一个对象字面量，同一个 `installTestHook`。
 *
 * ## 可变量怎么过来
 *
 * `client-main` 里有几个 `let`（尺寸锁、F3 开关、音效随机种子）钩子要写。
 * 跨模块拿不到别人的 `let`，所以它们以**回调**的形式传进来
 * （`setSizeLock` / `setDebugOverlay` / `resetRand`）。
 * 这比导出一个可变的状态对象好：谁能改什么在类型上就写明了。
 */
import { installTestHook } from '../client/debug/test-hook.ts';
import { C_PlayerAction, C_Respawn, PlayerActionKind } from '../core/net/packets.ts';
import type { Clock } from '../client/clock.ts';
import type { Camera } from '../client/camera.ts';
import type { Input } from '../client/input/input.ts';
import type { ClientEntities } from '../client/entity/client-entities.ts';
import type { ClientMobs } from '../client/entity/client-mobs.ts';
import type { MobRenderer } from '../client/render/mob-renderer.ts';
import type { ChunkRenderer } from '../client/render/chunk-renderer.ts';
import type { ParticleRenderer } from '../client/render/particle-renderer.ts';
import type { ParticleEmitters } from '../client/particle/emitters.ts';
import type { UiRenderer } from '../client/ui/ui-renderer.ts';
import type { UiController } from '../client/ui/ui-controller.ts';
import type { AudioEngine } from '../client/audio/audio-engine.ts';
import type { Interaction } from '../client/player/interaction.ts';
import type { LocalPlayer } from '../client/player/local-player.ts';
import type { ClientWorld } from '../client/world/client-world.ts';
import type { ClientSession } from './client-session.ts';
import type { ClientMeshing } from './client-meshing.ts';
import type { MenuAction } from '../client/ui/menu-screen.ts';

export interface TestHookDeps {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement;
  readonly clock: Clock;
  readonly camera: Camera;
  readonly input: Input;
  readonly world: ClientWorld;
  readonly session: ClientSession;
  readonly meshing: ClientMeshing;
  readonly renderer: ChunkRenderer;
  readonly entities: ClientEntities;
  readonly mobs: ClientMobs;
  readonly mobRenderer: MobRenderer;
  readonly particles: ParticleRenderer;
  readonly emitters: ParticleEmitters;
  readonly uiRenderer: UiRenderer;
  readonly ui: UiController;
  readonly audio: AudioEngine;
  readonly interaction: Interaction;
  readonly player: LocalPlayer;
  renderOnce(): void;
  pumpWorld(): void;
  applyMenuAction(action: MenuAction): void;
  setSizeLock(locked: boolean): void;
  setDebugOverlay(on: boolean, pinned: boolean): void;
  /** 把粒子/音效的随机源复位，供确定性重放 */
  resetRand(): void;
}

export function wireTestHook(d: TestHookDeps): void {
  const { session, world, meshing } = d;
  const net = session.net;
  const stats = session.stats;
  installTestHook({
    clock: d.clock, camera: d.camera, input: d.input, canvas: d.canvas,
    renderOnce: d.renderOnce,
    saveWorld: () => session.requestSave('save'),
    wipeSave: () => session.requestSave('wipe'),
    itemEntities: () => [...d.entities.values()].map((e) => ({
      id: e.entityId, x: e.x, y: e.y, z: e.z, item: e.itemId, count: e.count,
    })),
    mobEntities: () => [...d.mobs.values()].map((m) => ({
      id: m.entityId, type: m.type, x: m.x, y: m.y, z: m.z, health: m.health,
    })),
    mobVerts: () => d.mobRenderer.lastVerts,
    isDead: () => d.ui.dead,
    vitals: () => ({
      health: d.ui.vitals.health, hunger: d.ui.vitals.hunger,
      air: d.ui.vitals.air, xpLevel: d.ui.vitals.xpLevel,
    }),
    respawn: () => { net.send(C_Respawn, {}); net.flush(); },
    sendAction: (kind, x, y, z) => {
      net.send(C_PlayerAction, {
        action: kind === 'start-dig' ? PlayerActionKind.START_DIG : PlayerActionKind.CANCEL_DIG,
        x, y, z, face: 1,
      });
      net.flush();
    },
    drawStats: () => ({ drawCalls: d.renderer.drawCalls, quads: d.renderer.quadsDrawn }),
    setSizeLock: d.setSizeLock,
    idleStats: () => ({
      // 在飞的网格化任务也算"未安定"——否则会在结果还没回来时就判定世界已就绪
      dirty: world.dirtyCount + meshing.pool.pendingJobs,
      chunks: world.chunkCount,
      serverPending: stats.pendingChunks,
    }),
    pumpWorld: d.pumpWorld,
    command: (text) => session.command(text),
    sharedStats: () => session.sharedStats(),
    timeOfDay: () => session.timeOfDay,
    remeshCount: () => world.remeshCount,
    mirrorInfo: (x: number, y: number, z: number) => ({
      light: `${world.store.getSkyLight(x, y, z)}/${world.store.getBlockLight(x, y, z)}`,
      height: world.store.getHeight(x, z),
      loaded: world.store.isLoaded(x, z),
    }),
    debugWorld: () => world,
    remeshAll: () => world.markAllDirty(),
    detachCamera: () => { d.player.mode = 'detached'; },
    attachPlayer: (x: number, y: number, z: number) => {
      d.player.mode = 'physics';
      d.player.teleport(x, y, z);
      d.camera.setPosition(x, y + d.player.eyeHeight, z);
    },
    playerState: () => ({
      x: d.player.body.x, y: d.player.body.y, z: d.player.body.z,
      onGround: d.player.body.onGround, mode: d.player.mode,
      ticks: d.player.physicsTicks,
    }),
    selectedBlock: () => d.interaction.selectedBlock(),
    digProgress: () => d.interaction.digProgress,
    audioStats: () => ({ ready: d.audio.ready, plays: d.audio.playCount }),
    startAudio: () => d.audio.resume(),
    particleCount: () => d.particles.count,
    setDebugOverlay: (on: boolean, pinned = false) => d.setDebugOverlay(on, pinned),
    stepParticles: (ticks, burst, burstTicks = 6) => stepParticles(d, ticks, burst, burstTicks),
    uiQuads: () => d.uiRenderer.lastQuads,
    uiOpen: () => d.ui.open,
    showMenu: (screen: string) => { d.ui.menu.show(screen as 'none'); },
    menuScreen: () => d.ui.menu.screen,
    menuButtons: () => d.ui.menu.buttonIds(),
    pressMenu: (id: string) => { d.applyMenuAction(d.ui.menu.press(id)); },
    pixelAt: (x: number, y: number) => {
      const buf = new Uint8Array(4);
      // readPixels 的原点在**左下角**，和屏幕坐标相反
      d.gl.readPixels(x, d.canvas.height - 1 - y, 1, 1, d.gl.RGBA, d.gl.UNSIGNED_BYTE, buf);
      return [buf[0]!, buf[1]!, buf[2]!, buf[3]!];
    },
  });
}

/**
 * 确定性地推进粒子系统若干刻。
 *
 * 截图回归需要一片**可复现**的粒子。正常路径下粒子由主循环按真实耗时
 * 推进，跑了多少刻取决于机器多快 —— 同一个场景两次截出来的烟不在一个地方。
 *
 * 这个钩子把随机源复位再跑固定刻数，走的是**和正常路径同一份**发射器
 * 与物理，所以它验的是真东西，不是一个专门给测试看的假象。
 */
function stepParticles(
  d: TestHookDeps,
  ticks: number,
  burst: readonly [number, number, number, number] | undefined,
  burstTicks: number,
): void {
  d.particles.clear();
  d.resetRand();
  const step = (): void => {
    d.emitters.tickAmbient(d.camera.position[0]!, d.camera.position[1]!, d.camera.position[2]!);
    d.particles.update();
  };
  for (let i = 0; i < ticks; i++) step();
  // 爆炸放在**最后**才发，然后只再跑几刻。
  //
  // 一开始就发是没用的：爆炸粒子只活二十来刻，等 150 刻的环境积累跑完，
  // 它们早没了 —— 表现是"加了爆炸粒子数一点没变"。
  //
  // 为什么要有它：环境粒子那条路是**稀疏**的（每刻在 32³ 里挑 420 格，
  // 一根火把十几刻才轮到一次），数值上验得了、截图上几乎看不见。
  // 爆炸是事件那条路，一次三十几粒挤在一起，才是能用眼睛验收的证据。
  if (burst !== undefined) {
    d.emitters.explosion(burst[0], burst[1], burst[2], burst[3]);
    for (let i = 0; i < burstTicks; i++) step();
  }
}
