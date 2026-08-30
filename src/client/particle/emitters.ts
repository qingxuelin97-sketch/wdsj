/**
 * 粒子发射器：什么时候、在哪里、发什么。
 *
 * 分两类，机制完全不同：
 *
 * **环境粒子**（火把冒烟、岩浆冒泡、火苗）—— 没有"事件"，它们只是
 * 世界一直在那儿冒。做法照抄 MC 的 randomDisplayTick：每刻在相机周围
 * 随机挑一批格子，挑中了就按那格是什么方块发点东西。
 *
 * 这个"随机挑"的设计值得说一句：直觉做法是遍历附近所有方块、
 * 给每个火把发一粒烟。那是 32³ = 三万格的扫描，每刻一次。
 * 随机采样把它压到几百次，代价是单个火把的冒烟节奏不均匀 ——
 * 而那恰恰更像真的。
 *
 * **事件粒子**（暴击、落水、爆炸）—— 由具体的事发触发，发一把就完了。
 *
 * 全部只跑在客户端：粒子不影响任何玩法，服务端不该知道它们存在。
 * 唯一的例外是爆炸和暴击，它们的"事件"来自服务端的包，但**粒子本身**
 * 仍然是客户端凭那个包自己发的。
 */
import type { ParticleRenderer } from '../render/particle-renderer.ts';
import { particleDef, type ParticleDef } from '../../content/particles.ts';
import type { ChunkStore } from '../../core/world/block-view.ts';
import { stateId } from '../../core/world/chunk.ts';

/** 每刻在相机周围采样多少格。MC 是 1000，这里按体积等比缩了 */
const SAMPLES_PER_TICK = 420;
/** 采样半径（格） */
const SAMPLE_RADIUS = 16;

const TORCH = 50;
const FIRE = 51;
const FLOWING_LAVA = 10;
const LAVA = 11;
const REDSTONE_TORCH = 76;

export interface EmitterDeps {
  readonly particles: ParticleRenderer;
  readonly store: ChunkStore;
  /** 贴图名 -> 图集层号 */
  layerOf(texture: string): number;
  /** 随机源。传进来而不是用 Math.random，测试里才能复现 */
  rand(): number;
}

/** 查一次层号就缓存起来。每刻几百次采样，不该每次都走 Map */
export class ParticleEmitters {
  private readonly d: EmitterDeps;
  private readonly layers = new Map<string, number>();

  constructor(d: EmitterDeps) {
    this.d = d;
  }

  private layer(def: ParticleDef): number {
    let l = this.layers.get(def.texture);
    if (l === undefined) {
      l = this.d.layerOf(def.texture);
      this.layers.set(def.texture, l);
    }
    return l;
  }

  private emit(name: string, x: number, y: number, z: number, count: number, spread = 0.25): void {
    const def = particleDef(name);
    this.d.particles.emit(def, this.layer(def), x, y, z, count, this.d.rand, spread);
  }

  // -------------------------------------------------------------------------
  // 环境粒子
  // -------------------------------------------------------------------------

  /**
   * 每刻跑一次：在相机周围随机挑格子，看看有没有会冒东西的方块。
   *
   * 相机位置取整数格。不做视锥剔除 —— 身后的火把也在冒烟，
   * 转身时才不会看到烟"刚开始冒"。几百个粒子的代价远小于那个破绽。
   */
  tickAmbient(camX: number, camY: number, camZ: number): void {
    const { store, rand } = this.d;
    const cx = Math.floor(camX);
    const cy = Math.floor(camY);
    const cz = Math.floor(camZ);

    for (let i = 0; i < SAMPLES_PER_TICK; i++) {
      const x = cx + Math.floor((rand() - 0.5) * 2 * SAMPLE_RADIUS);
      const y = cy + Math.floor((rand() - 0.5) * 2 * SAMPLE_RADIUS);
      const z = cz + Math.floor((rand() - 0.5) * 2 * SAMPLE_RADIUS);
      const id = stateId(store.getState(x, y, z));
      if (id === 0) continue;
      this.blockAmbient(id, x, y, z);
    }
  }

  /** 一格方块被采样到时冒什么 */
  private blockAmbient(id: number, x: number, y: number, z: number): void {
    const { rand } = this.d;
    switch (id) {
      case TORCH:
      case REDSTONE_TORCH: {
        // 火把顶端稍微偏上一点。整格中心的话烟是从火把腰上冒出来的
        const px = x + 0.5;
        const py = y + 0.7;
        const pz = z + 0.5;
        this.emit('smoke', px, py, pz, 1, 0.06);
        // 红石火把不着火，只冒一点红雾；普通火把才有火苗
        if (id === TORCH) this.emit('flame', px, py, pz, 1, 0.05);
        else this.emit('redstone', px, py, pz, 1, 0.06);
        return;
      }
      case FIRE:
        this.emit('large_smoke', x + rand(), y + rand() * 0.6, z + rand(), 1, 0.1);
        this.emit('flame', x + rand(), y + rand() * 0.5, z + rand(), 1, 0.08);
        return;
      case LAVA:
      case FLOWING_LAVA: {
        // 只有**顶面露天**的岩浆才冒泡。埋在地下的岩浆湖冒泡是白费 ——
        // 玩家看不见，而它照样占着粒子池的名额
        if (stateId(this.d.store.getState(x, y + 1, z)) !== 0) return;
        if (rand() > 0.12) return;
        this.emit('lava', x + rand(), y + 1, z + rand(), 1, 0.05);
        // 岩浆表面也冒烟，那是它看起来"烫"的来源
        if (rand() < 0.35) this.emit('large_smoke', x + rand(), y + 1.1, z + rand(), 1, 0.1);
        return;
      }
      default:
    }
  }

  // -------------------------------------------------------------------------
  // 事件粒子
  // -------------------------------------------------------------------------

  /** 暴击：一小把星星从目标身上散开 */
  crit(x: number, y: number, z: number): void {
    this.emit('crit', x, y, z, 8, 0.3);
  }

  /** 爆炸：一团烟球 */
  explosion(x: number, y: number, z: number, power: number): void {
    const n = Math.min(60, Math.round(12 * power));
    this.emit('explode', x, y, z, n, power * 0.4);
  }

  /** 实体入水的水花 */
  splash(x: number, y: number, z: number): void {
    this.emit('splash', x, y, z, 10, 0.3);
  }

  /** 水下气泡 */
  bubbles(x: number, y: number, z: number, count = 2): void {
    this.emit('bubble', x, y, z, count, 0.35);
  }

  /** 音符盒 */
  note(x: number, y: number, z: number): void {
    this.emit('note', x + 0.5, y + 1.2, z + 0.5, 1, 0.05);
  }
}
