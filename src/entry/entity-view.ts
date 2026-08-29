/**
 * 实体在客户端这一侧的**表现**：怎么画、怎么被准星选中。
 *
 * 从 client-main.ts 里分出来的（那个文件到了 709 行、越过 600 硬上限）。
 * 分界线是"实体的视觉与拾取"：掉落物的方块/方片之分、生物的摆腿与染色、
 * 以及"准星指着哪只怪"。这些和世界渲染、网络、输入都没有耦合，
 * 拿出来之后 client-main 只剩下接线。
 */
import type { Camera } from '../client/camera.ts';
import type { ClientWorld } from '../client/world/client-world.ts';
import type { BlockTables } from '../core/registry/block-tables.ts';
import { ClientEntities } from '../client/entity/client-entities.ts';
import { ClientMobs } from '../client/entity/client-mobs.ts';
import type { ItemEntityRenderer } from '../client/render/item-entity-renderer.ts';
import type { MobRenderer } from '../client/render/mob-renderer.ts';
import { mobModelOf, WOOL_COLORS } from '../content/mob-models.ts';
import { MobType, mobDefOf } from '../content/mobs.ts';
import { sunBrightness } from '../core/world/day-night.ts';
import { raycastBlocks } from '../core/physics/raycast.ts';
import { REACH_SURVIVAL } from '../core/constants.ts';

export interface EntityViewDeps {
  readonly entities: ClientEntities;
  readonly mobs: ClientMobs;
  readonly itemEntityRenderer: ItemEntityRenderer;
  readonly mobRenderer: MobRenderer;
  readonly world: ClientWorld;
  readonly tables: BlockTables;
  /** 方块 id×6 -> 纹理层 */
  readonly faceLayer: Uint16Array;
  /** 物品 id -> 图标层 */
  iconLayer(id: number, damage: number): number;
}

export interface DrawParams {
  /** 当前刻已经走过的比例 */
  readonly partialTick: number;
  readonly timeOfDay: number;
  readonly cameraYaw: number;
  readonly cameraPitch: number;
}

export class EntityView {
  private readonly d: EntityViewDeps;
  /** 复用的六面纹理层数组，别每个掉落物新建一个 */
  private readonly faces: number[] = [0, 0, 0, 0, 0, 0];

  constructor(deps: EntityViewDeps) {
    this.d = deps;
  }

  /** 把这一帧的实体几何全部攒好 */
  draw(p: DrawParams): void {
    this.drawItemEntities(p);
    this.drawMobs(p);
  }

  /**
   * 把视野里的掉落物攒进 ItemEntityRenderer。
   *
   * 方块掉落物取自己六个面的贴图画成小方块，物品取图标画成朝向相机的方片 ——
   * 判据是"这个 id 在方块表里有定义吗"，与物品栏图标那条路一致。
   */
  private drawItemEntities(p: DrawParams): void {
    this.d.itemEntityRenderer.begin();
    if (this.d.entities.size === 0) return;
    // 相机的右向量与上向量，画方片时用
    const cy = Math.cos(p.cameraYaw);
    const sy = Math.sin(p.cameraYaw);
    const cp = Math.cos(p.cameraPitch);
    const sp = Math.sin(p.cameraPitch);
    const right = [cy, 0, -sy];
    const up = [sy * sp, cp, cy * sp];
    const faces = this.faces;

    for (const e of this.d.entities.values()) {
      const [x, y, z] = ClientEntities.interpolate(e, p.partialTick);
      // 亮度取所在格的光照，掉落物才会跟着环境明暗走 —— 洞里捡到的东西
      // 和地面上捡到的一样亮的话，看着很出戏
      const bx = Math.floor(x);
      const by = Math.floor(y);
      const bz = Math.floor(z);
      const sky = this.d.world.store.getSkyLight(bx, by, bz);
      const block = this.d.world.store.getBlockLight(bx, by, bz);
      const light = Math.max(0.15, Math.max(sky * sunBrightness(p.timeOfDay), block * 1.5) / 15);

      const isBlock = e.itemId > 0 && e.itemId < 256 && this.d.tables.defs[e.itemId] != null;
      if (isBlock) {
        for (let f = 0; f < 6; f++) faces[f] = this.d.faceLayer[e.itemId * 6 + f] ?? -1;
      }
      this.d.itemEntityRenderer.push({
        x, y, z,
        age: e.age + p.partialTick,
        phase: e.phase,
        faceLayers: isBlock ? faces : null,
        spriteLayer: this.d.iconLayer(e.itemId, e.damage),
        light,
      }, right, up);
    }
  }

  /** 把视野里的生物攒进 MobRenderer */
  private drawMobs(p: DrawParams): void {
    this.d.mobRenderer.begin();
    if (this.d.mobs.size === 0) return;
    for (const m of this.d.mobs.values()) {
      const model = mobModelOf(m.type);
      if (model === null) continue;
      const at = ClientMobs.interpolate(m, p.partialTick);
      const bx = Math.floor(at.x);
      const by = Math.floor(at.y);
      const bz = Math.floor(at.z);
      const sky = this.d.world.store.getSkyLight(bx, by, bz);
      const block = this.d.world.store.getBlockLight(bx, by, bz);
      const light = Math.max(0.2, Math.max(sky * sunBrightness(p.timeOfDay), block * 1.5) / 15);
      // 走路摆动：相位来自累计位移，幅度按"这一刻走了多远"给
      const speed = Math.hypot(m.x - m.prevX, m.z - m.prevZ);
      this.d.mobRenderer.push({
        boxes: model.boxes,
        x: at.x, y: at.y, z: at.z,
        yaw: at.yaw, headYaw: at.headYaw,
        walk: m.walkPhase * 6,
        walkAmount: Math.min(1, speed * 12),
        light,
        hurt: (m.flags & 1) !== 0 ? 0.6 : 0,
        swell: m.type === MobType.CREEPER ? m.swell : 0,
        dying: (m.flags & 8) !== 0 ? 1 : 0,
        // 羊按 variant 染色，其余生物不覆盖
        bodyColor: m.type === MobType.SHEEP ? (WOOL_COLORS[m.variant & 15] ?? null) : null,
      });
    }
  }

  /**
   * 准星指着哪只生物。没有返回 −1。
   *
   * 用射线与实体盒求交，并且**只认比方块近的命中** —— 隔着墙打怪
   * 在 MC 里是不行的，而这一条不做的话，玩家会发现自己能打穿墙。
   */
  pickMob(camera: Camera, partialTick: number): number {
    const p = camera.position;
    const dir = camera.forward();
    // 先看方块挡在哪儿，作为距离上限
    const blockHit = raycastBlocks(
      this.d.world.store, p[0]!, p[1]!, p[2]!, dir[0]!, dir[1]!, dir[2]!, REACH_SURVIVAL,
    );
    let limit = blockHit === null ? REACH_SURVIVAL : blockHit.distance;
    let best = -1;
    for (const m of this.d.mobs.values()) {
      const def = mobDefOf(m.type);
      if (def === null) continue;
      const at = ClientMobs.interpolate(m, partialTick);
      // 稍微放宽一点：与服务端的触及判定一样，卡在边界上不该"点了没反应"
      const half = def.width / 2 + 0.1;
      const t = EntityView.rayBoxDistance(
        p[0]!, p[1]!, p[2]!, dir[0]!, dir[1]!, dir[2]!,
        at.x - half, at.y - 0.1, at.z - half,
        at.x + half, at.y + def.height + 0.1, at.z + half,
      );
      if (t < 0 || t > limit) continue;
      limit = t;
      best = m.entityId;
    }
    return best;
  }

  /** 射线与轴对齐盒求交，返回进入距离；不相交返回 −1 */
  private static rayBoxDistance(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number,
  ): number {
    let tMin = 0;
    let tMax = Infinity;
    const axis = (o: number, d: number, lo: number, hi: number): boolean => {
      if (Math.abs(d) < 1e-9) return o >= lo && o <= hi;
      const t1 = (lo - o) / d;
      const t2 = (hi - o) / d;
      const near = Math.min(t1, t2);
      const far = Math.max(t1, t2);
      if (near > tMin) tMin = near;
      if (far < tMax) tMax = far;
      return tMin <= tMax;
    };
    if (!axis(ox, dx, minX, maxX)) return -1;
    if (!axis(oy, dy, minY, maxY)) return -1;
    if (!axis(oz, dz, minZ, maxZ)) return -1;
    return tMin;
  }
}
