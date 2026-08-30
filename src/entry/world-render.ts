/**
 * 一帧世界的绘制：状态、顺序、以及它们为什么是这个顺序。
 *
 * 从 client-main.ts 里分出来的（那个文件到了 613 行、越过 600 硬上限）。
 * 分界线是"这一帧怎么画出来"：清屏、天空色与雾、不透明世界、实体、
 * 粒子、准星与界面。client-main 那边只剩接线。
 *
 * 顺序不是随意的：
 *   世界（含半透明层，内部已按距离排序）在最前，深度缓冲由它建立
 *   实体与粒子在世界之后，它们要被地形正确遮挡
 *   界面在最后且关深度测试 —— 它永远盖在一切之上
 */
import type { Camera } from '../client/camera.ts';
import type { Frustum } from '../core/math/frustum.ts';
import type { Shader } from '../client/gl/shader.ts';
import type { ChunkRenderer } from '../client/render/chunk-renderer.ts';
import { ANIM_FRAMES } from '../client/render/block-textures.ts';
import type { ItemEntityRenderer } from '../client/render/item-entity-renderer.ts';
import type { MobRenderer } from '../client/render/mob-renderer.ts';
import type { ParticleRenderer } from '../client/render/particle-renderer.ts';
import type { OverlayRenderer } from '../client/render/overlay-renderer.ts';
import type { UiRenderer } from '../client/ui/ui-renderer.ts';
import type { UiController } from '../client/ui/ui-controller.ts';
import type { DrawContext } from '../client/ui/inventory-screen.ts';
import type { Interaction } from '../client/player/interaction.ts';
import type { EntityView } from './entity-view.ts';
import type { SkyRenderer } from '../client/render/sky-renderer.ts';
import type { WeatherRenderer } from '../client/render/weather-renderer.ts';
import { skyColor, sunBrightness } from '../core/world/day-night.ts';
import { SECTION_SIZE } from '../core/constants.ts';
import type { ChunkStore } from '../core/world/block-view.ts';
import { drawDebugOverlay, type DebugInfo } from '../client/ui/debug-overlay.ts';

/** 闪电闪白多少帧。6 帧 ≈ 100ms，再长就成了"天亮了" */
const LIGHTNING_FLASH_FRAMES = 6;

export interface FrameDeps {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement;
  readonly camera: Camera;
  readonly frustum: Frustum;
  readonly shader: Shader;
  readonly renderer: ChunkRenderer;
  readonly tintColors: Float32Array;
  readonly texture: WebGLTexture;
  /** 图集里动画帧区的起点层号与组数，见 block-textures.ts */
  readonly anim: { start: number; groups: number };
  readonly renderDistance: number;
  readonly timeOfDay: number;
  readonly entityView: EntityView;
  readonly itemEntityRenderer: ItemEntityRenderer;
  readonly mobRenderer: MobRenderer;
  readonly particles: ParticleRenderer;
  readonly interaction: Interaction;
  readonly overlay: OverlayRenderer;
  readonly ui: UiController;
  readonly uiRenderer: UiRenderer;
  readonly uiCtx: DrawContext;
  readonly entityPartialTick: number;
  readonly sky: SkyRenderer;
  readonly skyLayers: {
    sun: number; clouds: number; moons: readonly number[];
    rain: number; snow: number;
  };
  /** 服务端权威的世界年龄。月相按天走，要用它而不是当日时间 */
  readonly worldAge: number;
  /** 渲染刻。云的漂移由它驱动，freeze() 之后要停住 */
  readonly renderTick: number;
  readonly rain: number;
  readonly thunder: number;
  readonly weatherRenderer: WeatherRenderer;
  /** 最近一次闪电所在的渲染刻，-1 表示没有 */
  readonly lightningFlashTick: number;
  /** 客户端的世界镜像。雨要按列查群系与地面高度 */
  readonly store: ChunkStore;
  /** F3 的内容。null = 不画 */
  readonly debug: DebugInfo | null;
}

export function drawWorldFrame(d: FrameDeps): void {
  const gl = d.gl;

  const w = d.canvas.width;
  const h = d.canvas.height;
  gl.viewport(0, 0, w, h);
  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  gl.frontFace(gl.CCW);
  // 天空色随昼夜变化，雾色跟着天空走 —— 远处的地形才不会在夜里浮出一层白边
  // 天空色带上天气：雨天去饱和 + 压暗，雷暴更甚。
  // 闪电劈下的那几帧整片天空刷白 —— 这是雷暴唯一一个"吓人"的瞬间，
  // 而它只值 6 帧
  const flashFrames = d.lightningFlashTick >= 0 ? d.renderTick - d.lightningFlashTick : 999;
  const flash = flashFrames >= 0 && flashFrames < LIGHTNING_FLASH_FRAMES
    ? 1 - flashFrames / LIGHTNING_FLASH_FRAMES
    : 0;
  const base = skyColor(d.timeOfDay, d.rain, d.thunder);
  const sky = flash > 0
    ? {
      r: base.r + (1 - base.r) * flash * 0.85,
      g: base.g + (1 - base.g) * flash * 0.85,
      b: base.b + (1 - base.b) * flash * 0.85,
    }
    : base;
  gl.clearColor(sky.r, sky.g, sky.b, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  d.camera.update(w / Math.max(1, h));
  d.frustum.update(d.camera.viewProjection);

  // 天空排在世界之前、且不写深度。地形随后覆盖它，天空自然只出现在
  // 没有方块的地方 —— 不需要任何"哪里是天"的判断
  d.sky.render({
    viewProj: d.camera.viewProjection,
    cameraX: d.camera.position[0]!,
    cameraY: d.camera.position[1]!,
    cameraZ: d.camera.position[2]!,
    timeOfDay: d.timeOfDay,
    worldAge: d.worldAge,
    renderTick: d.renderTick,
    rain: Math.min(1, d.rain + d.thunder * 0.5),
    texture: d.texture,
    sunLayer: d.skyLayers.sun,
    moonLayers: d.skyLayers.moons,
    cloudLayer: d.skyLayers.clouds,
    renderDistance: d.renderDistance,
  });

  d.shader.use();
  d.shader.setMat4('uViewProj', d.camera.viewProjection);
  // 世界的光照亮度也要跟着天气走 —— 天暗了地面却不暗的话，
  // 雨看起来像贴在画面上的一层滤镜
  d.shader.setFloat('uSunBrightness', Math.min(1, sunBrightness(d.timeOfDay, d.rain, d.thunder) + flash * 0.7));
  d.shader.setVec3('uFogColor', sky.r, sky.g, sky.b);
  d.shader.setVec3('uCameraPos', d.camera.position[0]!, d.camera.position[1]!, d.camera.position[2]!);
  d.shader.setFloat('uFogStart', d.renderDistance * SECTION_SIZE * 0.65);
  d.shader.setFloat('uFogEnd', d.renderDistance * SECTION_SIZE * 1.05);
  d.shader.setInt('uAtlas', 0);
  // 贴图动画：水/岩浆/火换帧。
  //
  // 相位来自 renderTick 而不是挂钟 —— `freeze()` 一停 renderTick 不动，
  // 这一帧就钉住了，截图回归照样成立。项目里每一个"会让画面自己变"的
  // 东西都栽过这条（存档、野怪、随机刻、环境粒子，四次），这次一开始就接对。
  //
  // 除以 4：16 帧一圈，60 fps 下约 1.07 秒走完，与 MC 的水流速度同量级。
  // 直接用 renderTick 的话一圈只有 0.27 秒，水会像开了快进
  d.shader.setUint('uAnimStart', d.anim.start);
  d.shader.setUint('uAnimFrames', ANIM_FRAMES);
  d.shader.setUint('uAnimFrame', Math.floor(d.renderTick / 4) % ANIM_FRAMES);
  const tintLoc = d.shader.loc('uTintColors[0]');
  if (tintLoc !== null) gl.uniform3fv(tintLoc, d.tintColors);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, d.texture);
  d.renderer.render(d.shader, d.frustum, d.camera.position[0]!, d.camera.position[1]!, d.camera.position[2]!);

  d.entityView.draw({
    partialTick: d.entityPartialTick,
    timeOfDay: d.timeOfDay,
    cameraYaw: d.camera.yaw,
    cameraPitch: d.camera.pitch,
  });
  d.itemEntityRenderer.render(d.camera.viewProjection, d.texture);
  d.mobRenderer.render(d.camera.viewProjection);
  d.particles.render(d.camera.viewProjection, d.camera.yaw, d.camera.pitch, d.texture);
  d.interaction.renderOverlay(d.overlay, d.texture);

  // 雨雪排在最后一个世界元素：它是半透明的，要能被地形遮挡（深度测试开着），
  // 但不该遮挡别的半透明物件，所以自己不写深度
  d.weatherRenderer.render({
    viewProj: d.camera.viewProjection,
    cameraX: d.camera.position[0]!,
    cameraY: d.camera.position[1]!,
    cameraZ: d.camera.position[2]!,
    cameraYaw: d.camera.yaw,
    rain: d.rain,
    renderTick: d.renderTick,
    store: d.store,
    texture: d.texture,
    rainLayer: d.skyLayers.rain,
    snowLayer: d.skyLayers.snow,
    brightness: Math.max(0.25, sunBrightness(d.timeOfDay, d.rain, d.thunder)),
  });

  // 界面画在最后，且用**虚拟像素**坐标系（见 client/ui/ui-renderer.ts）
  d.ui.draw(d.uiRenderer, d.uiCtx);
  d.uiRenderer.flush(d.texture);

  // F3 **单独一批**。
  //
  // 一屏 F3 有六七百个矩形，而 UiRenderer 的缓冲上限是 1024 —— 和物品栏
  // 挤在同一批里会溢出，表现是界面画一半没了，而且只在开着背包按 F3 时出现。
  if (d.debug !== null) {
    drawDebugOverlay(d.uiRenderer, d.debug);
    d.uiRenderer.flush(d.texture);
  }
}
