/**
 * 选中、挖掘、放置 —— 玩家和世界打交道的那一层。
 *
 * 从 client-main 里搬出来的：那个文件顶到了 600 行的硬上限。
 * 那条规则的用处正在这种时候 —— 它逼着人把长出来的东西搬走，而不是继续糊。
 *
 * 一条贯穿全文的原则：**这里算出来的一切都不是权威的**。
 * 挖掘进度在本地也算一份，纯粹是为了画裂纹；破坏与否由服务端说了算。
 * 两边跑的是同一份 `core/block/breaking.ts`，所以裂纹涨满的那一刻
 * 和服务端判定破坏的那一刻基本重合，看不出延迟。
 */
import type { Camera } from '../camera.ts';
import type { ClientWorld } from '../world/client-world.ts';
import type { AudioEngine } from '../audio/audio-engine.ts';
import type { ParticleRenderer } from '../render/particle-renderer.ts';
import type { OverlayRenderer } from '../render/overlay-renderer.ts';
import type { LocalPlayer } from './local-player.ts';
import type { BlockTables } from '../../core/registry/block-tables.ts';
import type { PacketDef } from '../../core/net/schema.ts';
import { raycastBlocks, type RayHit } from '../../core/physics/raycast.ts';
import { breakProgressPerTick, crackStage } from '../../core/block/breaking.ts';
import { digSound, hitSound, placeSound } from '../../core/audio/sound-spec.ts';
import type { SoundGroup } from '../../core/block/types.ts';
import { stateId } from '../../core/world/chunk.ts';
import { C_PlayerAction, C_UseBlock, PlayerActionKind } from '../../core/net/packets.ts';
import { REACH_SURVIVAL, MS_PER_TICK } from '../../core/constants.ts';

/** 一帧里跟交互有关的输入 */
export interface InteractionInput {
  attack: boolean;
  use: boolean;
}

export interface InteractionDeps {
  camera: Camera;
  world: ClientWorld;
  tables: BlockTables;
  audio: AudioEngine;
  particles: ParticleRenderer;
  player: LocalPlayer;
  /** destroy_stage_0 在纹理数组里的层号 */
  crackLayer0: number;
  /** 方块 id × 6 面 -> 贴图层，碎屑取其中的顶面 */
  faceLayer: Uint16Array | Uint32Array;
  send(packet: PacketDef<never>, value: Record<string, unknown>): void;
  /** 可复现的随机源，粒子与音高扰动用 */
  rand(): number;
  /** 按 TintKind 索引的群系染色，每项 3 个分量。碎屑要乘它 */
  tintColors: Float32Array;
}

export class Interaction {
  private readonly d: InteractionDeps;
  /** 准星指着的方块，没指着任何东西时为 null */
  private selected: RayHit | null = null;
  /** 正在挖的格子，用来判断是不是换目标了 */
  private digTarget: { x: number; y: number; z: number } | null = null;
  /** 本地挖掘进度 0..1 */
  digProgress = 0;
  /** 上一帧右键是否按下，用于只在按下那一刻放一次 */
  private usePressed = false;
  /** 粒子按 20 Hz 推进，与物理同频 */

  constructor(deps: InteractionDeps) {
    this.d = deps;
  }

  selectedBlock(): { x: number; y: number; z: number; face: number } | null {
    const s = this.selected;
    if (s === null) return null;
    return { x: s.x, y: s.y, z: s.z, face: faceFromNormal(s.nx, s.ny, s.nz) };
  }

  update(input: InteractionInput, dtMs: number): void {
    this.updateSelection();
    this.updateDigging(input, dtMs);
    // 粒子的推进**不在这里**。
    //
    // 它原来挂在这个函数里，而这个函数只在"没开界面、没在打生物"时才被调用 ——
    // 于是打开背包的一瞬间，空中所有碎屑会僵在原地。以前只有挖方块的碎屑，
    // 那半秒钟没人看得出来；有了火把冒烟、岩浆冒泡这类**一直在冒**的粒子之后
    // 就很明显了。搬到主循环里那个固定 20Hz 的推进块，和掉落物、生物一起走。
  }

  /** 每帧重算准星指着哪一格 */
  private updateSelection(): void {
    const { camera, world } = this.d;
    const f = camera.forward();
    const p = camera.position;
    this.selected = raycastBlocks(
      world.store,
      p[0]!, p[1]!, p[2]!,
      f[0]!, f[1]!, f[2]!,
      REACH_SURVIVAL,
    );
  }

  private updateDigging(input: InteractionInput, dtMs: number): void {
    const { world, tables, audio, player, rand } = this.d;
    const sel = this.selected;

    if (!input.attack || sel === null) {
      this.stopDigging();
    } else {
      const t = this.digTarget;
      const changed = t === null || t.x !== sel.x || t.y !== sel.y || t.z !== sel.z;
      if (changed) {
        // 换目标了：先告诉服务端放弃旧的，再开新的。
        // 不发 CANCEL 的话服务端会一直挂着上一格的进度
        this.stopDigging();
        this.digTarget = { x: sel.x, y: sel.y, z: sel.z };
        this.digProgress = 0;
        this.d.send(C_PlayerAction as never, {
          action: PlayerActionKind.START_DIG, x: sel.x, y: sel.y, z: sel.z, face: 0,
        });
      }
      const id = stateId(world.store.getState(sel.x, sel.y, sel.z));
      // 按真实经过的时间累加，而不是按帧 —— 否则帧率高的机器挖得快
      const ticks = dtMs / MS_PER_TICK;
      const before = this.digProgress;
      this.digProgress = Math.min(1, before + breakProgressPerTick(tables, id, null, player.body.onGround) * ticks);
      // 每跨过一格进度就"哒"一声。按固定时间间隔发的话，挖软方块时会太密
      if (Math.floor(before * 10) !== Math.floor(this.digProgress * 10)) {
        audio.play(hitSound(this.soundGroupOf(id)), this.panOf(sel.x, sel.z), 0.9 + rand() * 0.2);
      }
    }

    // 右键放置：只在按下的那一帧触发一次，否则按住会连放一整排
    if (input.use && !this.usePressed && sel !== null) {
      const id = stateId(world.store.getState(sel.x, sel.y, sel.z));
      audio.play(placeSound(this.soundGroupOf(id)), this.panOf(sel.x, sel.z));
      this.d.send(C_UseBlock as never, {
        x: sel.x, y: sel.y, z: sel.z,
        face: faceFromNormal(sel.nx, sel.ny, sel.nz),
        hitX: 0.5, hitY: 0.5, hitZ: 0.5,
      });
    }
    this.usePressed = input.use;
  }

  stopDigging(): void {
    const t = this.digTarget;
    if (t === null) return;
    this.d.send(C_PlayerAction as never, {
      action: PlayerActionKind.CANCEL_DIG, x: t.x, y: t.y, z: t.z, face: 0,
    });
    this.digTarget = null;
    this.digProgress = 0;
  }

  /**
   * 某个方块被破坏了。
   *
   * 由 S_BlockUpdate 驱动而不是本地挖掘逻辑，这样**别人**挖的方块
   * 也一样有碎屑和声音 —— 多人时这一条是"世界是活的"的主要来源。
   */
  onBlockBroken(x: number, y: number, z: number, oldId: number): void {
    const { particles, audio, faceLayer, rand, tables, tintColors } = this.d;
    // 草/树叶的贴图是灰度的，颜色靠群系染色 —— 碎屑必须乘上同一份颜色
    const tint = tables.tint[oldId] ?? 0;
    const t: [number, number, number] = [
      tintColors[tint * 3] ?? 1, tintColors[tint * 3 + 1] ?? 1, tintColors[tint * 3 + 2] ?? 1,
    ];
    particles.burst(x, y, z, faceLayer[oldId * 6 + 1] ?? 0, rand, t);
    audio.play(digSound(this.soundGroupOf(oldId)), this.panOf(x, z), 0.95 + rand() * 0.1);
  }

  /** 选中框与裂纹，画在世界之上 */
  renderOverlay(overlay: OverlayRenderer, texture: WebGLTexture): void {
    const sel = this.selected;
    if (sel === null) return;
    const vp = this.d.camera.viewProjection;
    overlay.drawOutline(vp, sel.x, sel.y, sel.z);
    const t = this.digTarget;
    if (t !== null && this.digProgress > 0) {
      overlay.drawCrack(vp, t.x, t.y, t.z, crackStage(this.digProgress), texture, this.d.crackLayer0);
    }
  }

  private soundGroupOf(id: number): SoundGroup {
    return (this.d.tables.soundGroup[id] ?? 0) as SoundGroup;
  }

  /**
   * 声源相对玩家的左右方位，−1..1。
   * 只做左右不做前后：前后靠音量已经够了，加 HRTF 反而会让近处的声音发虚。
   */
  private panOf(bx: number, bz: number): number {
    const cam = this.d.camera;
    const dx = bx + 0.5 - cam.position[0]!;
    const dz = bz + 0.5 - cam.position[2]!;
    const right = -Math.cos(cam.yaw) * dx - Math.sin(cam.yaw) * dz;
    const len = Math.hypot(dx, dz) || 1;
    return Math.max(-1, Math.min(1, right / len));
  }
}

/** 法线转成 Facing 编号，与服务端的 FACE_NORMALS 一致 */
export function faceFromNormal(nx: number, ny: number, nz: number): number {
  if (ny < 0) return 0;
  if (ny > 0) return 1;
  if (nz < 0) return 2;
  if (nz > 0) return 3;
  if (nx < 0) return 4;
  return 5;
}
