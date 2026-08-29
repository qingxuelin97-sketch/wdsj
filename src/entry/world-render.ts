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
import type { ItemEntityRenderer } from '../client/render/item-entity-renderer.ts';
import type { MobRenderer } from '../client/render/mob-renderer.ts';
import type { ParticleRenderer } from '../client/render/particle-renderer.ts';
import type { OverlayRenderer } from '../client/render/overlay-renderer.ts';
import type { UiRenderer } from '../client/ui/ui-renderer.ts';
import type { UiController } from '../client/ui/ui-controller.ts';
import type { DrawContext } from '../client/ui/inventory-screen.ts';
import type { Interaction } from '../client/player/interaction.ts';
import type { EntityView } from './entity-view.ts';
import { skyColor, sunBrightness } from '../core/world/day-night.ts';
import { SECTION_SIZE } from '../core/constants.ts';

export interface FrameDeps {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement;
  readonly camera: Camera;
  readonly frustum: Frustum;
  readonly shader: Shader;
  readonly renderer: ChunkRenderer;
  readonly tintColors: Float32Array;
  readonly texture: WebGLTexture;
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
  const sky = skyColor(d.timeOfDay);
  gl.clearColor(sky.r, sky.g, sky.b, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  d.camera.update(w / Math.max(1, h));
  d.frustum.update(d.camera.viewProjection);

  d.shader.use();
  d.shader.setMat4('uViewProj', d.camera.viewProjection);
  d.shader.setFloat('uSunBrightness', sunBrightness(d.timeOfDay));
  d.shader.setVec3('uFogColor', sky.r, sky.g, sky.b);
  d.shader.setVec3('uCameraPos', d.camera.position[0]!, d.camera.position[1]!, d.camera.position[2]!);
  d.shader.setFloat('uFogStart', d.renderDistance * SECTION_SIZE * 0.65);
  d.shader.setFloat('uFogEnd', d.renderDistance * SECTION_SIZE * 1.05);
  d.shader.setInt('uAtlas', 0);
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

  // 界面画在最后，且用**虚拟像素**坐标系（见 d.ui-d.renderer.ts）
  d.ui.draw(d.uiRenderer, d.uiCtx);
  d.uiRenderer.flush(d.texture);
}
