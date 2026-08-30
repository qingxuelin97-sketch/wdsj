/**
 * 采集 F3 要显示的一切。
 *
 * 和画它的 debug-overlay.ts 分开：这里是"从各个子系统里把数捞出来"，
 * 那边是"把数摆在屏幕上"。捞数要碰十来个对象（世界、渲染器、粒子池、
 * 实体表、会话），摆数只需要一个纯数据结构 —— 混在一起的话，
 * 想调一下版式就得把整个客户端拖进来。
 *
 * **只在 F3 开着时调**。它要查脚下方块名、群系、两种光照，
 * 每帧无脑算是白花的钱，而 F3 默认是关的。
 */
import type { Clock } from '../clock.ts';
import type { Camera } from '../camera.ts';
import type { ClientWorld } from '../world/client-world.ts';
import type { BlockRegistry } from '../../core/registry/block-registry.ts';
import type { ChunkRenderer } from '../render/chunk-renderer.ts';
import type { ParticleRenderer } from '../render/particle-renderer.ts';
import { stateId } from '../../core/world/chunk.ts';
import { EYE_HEIGHT } from '../../core/constants.ts';
import type { DebugInfo } from './debug-overlay.ts';

export interface DebugSources {
  readonly clock: Clock;
  readonly camera: Camera;
  readonly world: ClientWorld;
  readonly registry: BlockRegistry;
  readonly renderer: ChunkRenderer;
  readonly particles: ParticleRenderer;
  readonly entities: { readonly size: number };
  readonly mobs: { readonly size: number };
  readonly timeOfDay: number;
  readonly worldAge: number;
  readonly rain: number;
  readonly thunder: number;
  readonly serverChunks: number;
  readonly pendingChunks: number;
  readonly meshInFlight: number;
  readonly serverTick: number;
  readonly serverTickMs: number;
}

/**
 * 截图取样时用的固定值，替换掉那些**天生每次都不同**的遥测：
 * 帧率、堆内存、服务端刻数。
 *
 * 不替换的话 F3 的黄金图永远对不上 —— 而那不是 bug，是那几个数
 * 本来就不该一样。截图这一项要验的是"它画进 canvas 了、位置对、字认得出"，
 * 内容与格式由 tests/client/debug-overlay.test.ts 逐行断言，那边覆盖得更细。
 */
const PINNED = {
  fps: 60,
  frameMs: 16.7,
  frameSamples: [16, 17, 16, 18, 17, 16, 16, 17, 33, 16, 17, 16],
  jsHeapMB: 64,
  serverTick: 1000,
  serverTickMs: 1,
};

/**
 * @param pinned 把遥测类字段换成固定值。只有截图回归会开
 */
export function collectDebugInfo(s: DebugSources, pinned = false): DebugInfo {
  const p = s.camera.position;
  const bx = Math.floor(p[0]!);
  const bz = Math.floor(p[2]!);
  // 脚下那一格：眼睛在 1.62 高处，再往下 0.1 是为了站在方块上时读到的是
  // 脚踩的那块，而不是脚尖悬空的那格空气
  const by = Math.floor(p[1]! - EYE_HEIGHT - 0.1);
  const id = stateId(s.world.store.getState(bx, by, bz));
  const eyeY = Math.floor(p[1]!);
  return {
    fps: s.clock.fps,
    frameMs: s.clock.frameMs,
    // clock 存的是秒，图上要毫秒
    frameSamples: s.clock.frameSamples.map((dt) => dt * 1000),
    x: p[0]!, y: p[1]!, z: p[2]!,
    yaw: s.camera.yaw, pitch: s.camera.pitch,
    standingOn: id === 0 ? 'air' : (s.registry.get(id)?.name ?? `#${id}`),
    biomeId: s.world.store.getBiome(bx, bz),
    skyLight: s.world.store.getSkyLight(bx, eyeY, bz),
    blockLight: s.world.store.getBlockLight(bx, eyeY, bz),
    timeOfDay: s.timeOfDay,
    worldAge: s.worldAge,
    rain: s.rain,
    thunder: s.thunder,
    clientChunks: s.world.chunkCount,
    serverChunks: s.serverChunks,
    dirtySections: s.world.dirtyCount,
    meshInFlight: s.meshInFlight,
    pendingChunks: s.pendingChunks,
    sectionsDrawn: s.renderer.sectionsDrawn,
    sectionCount: s.renderer.sectionCount,
    drawCalls: s.renderer.drawCalls,
    quads: s.renderer.quadsDrawn,
    vramMB: s.renderer.totalBytes / 1048576,
    particles: s.particles.count,
    entities: s.entities.size,
    mobs: s.mobs.size,
    serverTick: s.serverTick,
    serverTickMs: s.serverTickMs,
    jsHeapMB: heapMB(),
    ...(pinned ? PINNED : {}),
  };
}

/** Chrome 才有 performance.memory，别的浏览器返回 -1 */
function heapMB(): number {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return mem !== undefined ? Math.round(mem.usedJSHeapSize / 1048576) : -1;
}
