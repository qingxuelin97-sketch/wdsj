/**
 * 生物的每刻驱动：AI、物理、伤害、死亡掉落、与客户端的同步。
 *
 * 同步策略与掉落物完全一致（见 item-manager.ts）：**玩家认识一只生物，
 * 当且仅当它所在的区块被这个玩家订阅了。** 每刻按订阅集重算差集，
 * 多出来的发出生包、少掉的发销毁包。一句话的规则，省掉一整类
 * "实体跨区块时谁该收到什么"的边界 bug。
 */
import type { ServerCore } from '../server-core.ts';
import type { ServerPlayer } from '../player/server-player.ts';
import { Mob } from './mob.ts';
import { installGoals } from './mob-factory.ts';
import { PathFinder } from './pathfind.ts';
import { MOBS, MobCategory, mobDefOf, type MobDef } from '../../content/mobs.ts';
import type { MobCtx, TargetRef } from './goal.ts';
import { spawnBlockDrop, spawnXpOrbs } from './item-manager.ts';
import { makeStack, isEmpty } from '../../core/item/item-def.ts';
import { raycastBlocks } from '../../core/physics/raycast.ts';
import {
  S_SpawnMobs, S_MobMoves, S_DestroyEntities,
  ENTITY_POS_SCALE, SPAWN_MOB_STRIDE, MOB_MOVE_STRIDE,
} from '../../core/net/packets.ts';
import { isDaytime } from '../../core/world/day-night.ts';
import { WORLD_HEIGHT } from '../../core/constants.ts';

/** 一个世界里最多几只敌对生物 */
export const HOSTILE_CAP = 70;
/** 最多几只动物 */
export const PASSIVE_CAP = 15;
/** 敌对生物要离玩家多远才能刷 */
const MIN_SPAWN_DISTANCE = 24;
/** 超过这个距离就直接消失（MC 是 128） */
const DESPAWN_DISTANCE = 128;
/** 敌对生物能在多暗的地方刷 */
const MAX_SPAWN_LIGHT = 7;
/** 每多少刻尝试一次生成 */
const SPAWN_INTERVAL = 20;
/** 一轮最多尝试几个位置 */
const SPAWN_ATTEMPTS = 24;
/** 角色转向的最大距离平方，用于视线检查 */
const SIGHT_RANGE = 64;

export class MobManager {
  private readonly core: ServerCore;
  readonly mobs = new Map<number, Mob>();
  private readonly pathfinder = new PathFinder();
  /** 上一刻广播过位置的生物，用来只发动了的那些 */
  private readonly lastSent = new Map<number, { x: number; y: number; z: number }>();

  /** 上一刻 AI 花了多少毫秒 —— 由宿主填，ServerCore 自己不读挂钟 */
  lastAiMs = 0;
  /**
   * 自然生成的开关。
   *
   * 截图回归必须关掉：野生的怪会走进画面，于是同一个种子同一个机位
   * 每次截出来都不一样 —— 而失败信息只会说"哈希不匹配"，看上去像渲染坏了。
   * 关掉之后 `spawn` 指令照常可用，测试要什么怪就自己放什么怪。
   */
  naturalSpawning = true;

  constructor(core: ServerCore) {
    this.core = core;
  }

  get count(): number {
    return this.mobs.size;
  }

  countOf(category: MobCategory): number {
    let n = 0;
    for (const m of this.mobs.values()) if (m.def.category === category) n++;
    return n;
  }

  /** 造一只生物并放进世界 */
  spawn(def: MobDef, x: number, y: number, z: number): Mob {
    const mob = new Mob(this.core.world.allocEntityId(), def, x, y, z,
      this.core.world.random.nextDouble() * Math.PI * 2);
    installGoals(mob, (name) => this.core.items.idOf(name));
    if (def.name === 'sheep') mob.variant = this.core.world.random.nextInt(16);
    this.mobs.set(mob.entityId, mob);
    return mob;
  }

  /** 按名字生成，供指令与测试使用 */
  spawnByName(name: string, x: number, y: number, z: number): Mob | null {
    const def = MOBS.find((m) => m.name === name);
    if (def === undefined) return null;
    return this.spawn(def, x, y, z);
  }

  /** 某个区块里的生物，存盘用 */
  inChunk(cx: number, cz: number): Mob[] {
    const out: Mob[] = [];
    for (const m of this.mobs.values()) {
      if ((Math.floor(m.x) >> 4) === cx && (Math.floor(m.z) >> 4) === cz) out.push(m);
    }
    return out;
  }

  /**
   * 收下一只从存档里读出来的生物。
   *
   * 目标要重新装：AI 目标带着运行状态（走到路径的第几个点、引信涨到多少），
   * 那些都是**这一次运行**的东西，不该跨存档保留。存下来的只有位置、
   * 血量、着火时间这些真正属于世界状态的东西。
   */
  adopt(mob: Mob): void {
    installGoals(mob, (name) => this.core.items.idOf(name));
    this.mobs.set(mob.entityId, mob);
  }

  removeAll(name?: string): number {
    let n = 0;
    for (const [id, mob] of this.mobs) {
      if (name !== undefined && mob.def.name !== name) continue;
      this.mobs.delete(id);
      this.destroyed.push(id);
      n++;
    }
    return n;
  }

  /** 本刻消失的实体 id，供广播 */
  private readonly destroyed: number[] = [];

  // -------------------------------------------------------------------------
  // 每刻
  // -------------------------------------------------------------------------

  tick(): void {
    const world = this.core.world;
    // 天气要参与判据：雷暴天的白天天光低到能刷怪、僵尸也不烧。
    // 这是 MC 的行为，也是雷暴之所以让人紧张的全部原因 ——
    // 少传这两个参数，天气就只剩画面效果
    const w = world.weather.snapshot();
    const day = isDaytime(world.timeOfDay, w.rainStrength, w.thunderStrength);

    if (this.naturalSpawning && world.worldAge % SPAWN_INTERVAL === 0) this.trySpawn(day);

    for (const mob of [...this.mobs.values()]) {
      // 区块卸载了就把生物也收走：留着的话它会在一个不存在的世界里
      // 一路掉到 y<-8 然后"摔死"，掉落物撒在没人看得见的地方
      if (!world.isLoaded(Math.floor(mob.x) >> 4, Math.floor(mob.z) >> 4)) {
        this.forget(mob);
        continue;
      }

      if (mob.alive) {
        const ctx = this.makeCtx(mob, day);
        mob.goals.tick(ctx);
      }

      const head = mob.headBlock();
      const skyLight = world.store.getSkyLight(head.x, head.y, head.z);
      mob.tickPhysicsAndVitals(world.store, world.tables, skyLight, day);

      if (mob.removed) {
        this.dropLoot(mob);
        this.forget(mob);
      }
    }

    this.broadcast();
  }

  /** 把一只生物从世界里拿掉（不掉落） */
  private forget(mob: Mob): void {
    this.mobs.delete(mob.entityId);
    this.lastSent.delete(mob.entityId);
    this.destroyed.push(mob.entityId);
  }

  /** 死亡掉落 */
  private dropLoot(mob: Mob): void {
    if (mob.health > 0) return; // 是被卸载而不是被打死的
    const rng = this.core.world.random;
    const burned = mob.fireTicks > 0;
    for (const entry of mob.def.loot) {
      if (entry.chance < 1 && rng.nextDouble() > entry.chance) continue;
      const count = entry.min + rng.nextInt(entry.max - entry.min + 1);
      if (count <= 0) continue;
      const name = burned && entry.cooked !== undefined ? entry.cooked : entry.item;
      const id = this.core.items.idOf(name);
      if (id <= 0) continue;
      spawnBlockDrop(this.core, Math.floor(mob.x), Math.floor(mob.y), Math.floor(mob.z), makeStack(id, count));
    }
    // 经验：MC 里敌对生物给 5 点、动物给 1-3 点
    if (mob.def.xp > 0) {
      spawnXpOrbs(this.core, mob.x, mob.y + 0.5, mob.z, mob.def.xp);
    }
    // 羊掉自己颜色的羊毛，不走战利品表
    if (mob.def.name === 'sheep') {
      const wool = this.core.registry.idOf('wool');
      if (wool > 0) {
        spawnBlockDrop(
          this.core, Math.floor(mob.x), Math.floor(mob.y), Math.floor(mob.z),
          makeStack(wool, 1, mob.variant),
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // AI 上下文
  // -------------------------------------------------------------------------

  private makeCtx(mob: Mob, day: boolean): MobCtx {
    const world = this.core.world;
    return {
      mob,
      world: world.store,
      tables: world.tables,
      rng: world.random,
      pathfinder: this.pathfinder,
      worldAge: world.worldAge,
      isDay: day,
      nearestPlayer: (range) => this.nearestPlayer(mob, range),
      playerById: (id) => this.playerRef(id),
      canSee: (target) => this.canSee(mob, target),
      attack: (target, damage) => this.attackPlayer(mob, target, damage),
      explode: (m, power) => this.core.explode(m.x, m.y, m.z, power, m.entityId),
      shootArrow: (m, target) => this.core.shootArrow(m, target),
      teleportRandomly: (m) => this.teleportRandomly(m),
    };
  }

  private playerRef(id: number): TargetRef | null {
    for (const p of this.core.eachPlayer()) {
      if (p.entityId !== id) continue;
      return this.refOf(p);
    }
    return null;
  }

  private refOf(p: ServerPlayer): TargetRef {
    const held = p.inventory.held;
    return {
      entityId: p.entityId,
      x: p.x, y: p.y, z: p.z,
      eyeY: p.y + 1.62,
      heldItemId: isEmpty(held) ? 0 : held.id,
      alive: p.health > 0,
    };
  }

  private nearestPlayer(mob: Mob, range: number): TargetRef | null {
    let best: ServerPlayer | null = null;
    let bestSq = range * range;
    for (const p of this.core.eachPlayer()) {
      if (p.health <= 0) continue;
      const dx = p.x - mob.x;
      const dy = p.y - mob.y;
      const dz = p.z - mob.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestSq) {
        bestSq = d;
        best = p;
      }
    }
    return best === null ? null : this.refOf(best);
  }

  /** 从生物眼睛到目标眼睛有没有实心方块挡着 */
  private canSee(mob: Mob, target: TargetRef): boolean {
    const dx = target.x - mob.x;
    const dy = target.eyeY - mob.eyeY;
    const dz = target.z - mob.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > SIGHT_RANGE) return false;
    if (dist < 1e-6) return true;
    const hit = raycastBlocks(
      this.core.world.store,
      mob.x, mob.eyeY, mob.z,
      dx / dist, dy / dist, dz / dist,
      dist,
    );
    return hit === null;
  }

  private attackPlayer(mob: Mob, target: TargetRef, damage: number): void {
    for (const p of this.core.eachPlayer()) {
      if (p.entityId !== target.entityId) continue;
      this.core.damagePlayer(p, damage, mob.x, mob.z);
      return;
    }
  }

  /**
   * 末影人传送：在 ±32 格内随机找一个能站的地方。
   * 找不到就原地不动 —— MC 也是这样，传送是会失败的。
   */
  private teleportRandomly(mob: Mob): boolean {
    const world = this.core.world;
    const rng = world.random;
    for (let attempt = 0; attempt < 16; attempt++) {
      const x = Math.floor(mob.x) + rng.nextInt(65) - 32;
      const z = Math.floor(mob.z) + rng.nextInt(65) - 32;
      if (!world.isLoaded(x >> 4, z >> 4)) continue;
      for (let y = Math.min(WORLD_HEIGHT - 3, Math.floor(mob.y) + 16); y > 1; y--) {
        if (!this.standable(x, y, z, mob.def)) continue;
        mob.body.x = x + 0.5;
        mob.body.y = y;
        mob.body.z = z + 0.5;
        mob.body.vx = 0;
        mob.body.vy = 0;
        mob.body.vz = 0;
        return true;
      }
    }
    return false;
  }

  /** 这一格能不能站一只这么大的生物 */
  private standable(x: number, y: number, z: number, def: MobDef): boolean {
    const world = this.core.world;
    const tables = world.tables;
    const solidAt = (bx: number, by: number, bz: number): boolean => {
      const id = world.getBlock(bx, by, bz) & 0xfff;
      return id !== 0 && (tables.solid[id] ?? 0) !== 0;
    };
    if (!solidAt(x, y - 1, z)) return false;
    const top = Math.ceil(def.height);
    for (let oy = 0; oy < top; oy++) {
      if (y + oy >= WORLD_HEIGHT) return false;
      if (solidAt(x, y + oy, z)) return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // 生成
  // -------------------------------------------------------------------------

  /**
   * 试着刷一批生物。
   *
   * 规则照抄 1.0 的可观察部分：敌对生物要方块光 ≤7、离玩家 >24 格、
   * 在已加载区块里、脚下站得住；动物只在白天的草地上刷。
   * 上限分开算（敌对 70 / 动物 15）—— 合在一起算的话，天黑之后动物会被
   * 挤得刷不出来，而 MC 里两者互不影响。
   */
  private trySpawn(day: boolean): void {
    const world = this.core.world;
    const rng = world.random;
    const players = [...this.core.eachPlayer()];
    if (players.length === 0) return;

    let hostiles = this.countOf(MobCategory.HOSTILE);
    let passives = this.countOf(MobCategory.PASSIVE);
    if (hostiles >= HOSTILE_CAP && passives >= PASSIVE_CAP) return;

    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
      // 上限要在**循环里**复查。只在进循环前查一次的话，一轮 24 次尝试
      // 全成功就会一次性超出上限 24 只，而且越接近上限超得越多
      const wantHostile = hostiles < HOSTILE_CAP;
      const wantPassive = passives < PASSIVE_CAP;
      if (!wantHostile && !wantPassive) return;
      const anchor = players[rng.nextInt(players.length)]!;
      // 在玩家周围 24..48 格的环带里挑点。太近了会当着面刷出来，
      // 太远了在视距外白刷一批然后立刻超距消失
      const angle = rng.nextDouble() * Math.PI * 2;
      const dist = MIN_SPAWN_DISTANCE + rng.nextInt(24);
      const x = Math.floor(anchor.x + Math.cos(angle) * dist);
      const z = Math.floor(anchor.z + Math.sin(angle) * dist);
      if (!world.isLoaded(x >> 4, z >> 4)) continue;

      const surface = world.store.getHeight(x, z);
      if (surface <= 0 || surface >= WORLD_HEIGHT - 2) continue;

      // 敌对：从地表往下找一个够暗的落脚点（洞里也能刷）
      if (wantHostile) {
        const y = this.findHostileSpot(x, z, surface, rng.nextInt(Math.max(1, surface)));
        if (y > 0 && this.farEnough(x, y, z, players)) {
          const def = HOSTILE_POOL[rng.nextInt(HOSTILE_POOL.length)]!;
          if (this.standable(x, y, z, def)) {
            this.spawn(def, x + 0.5, y, z + 0.5);
            hostiles++;
            continue;
          }
        }
      }

      // 动物：白天、地表、草方块上
      if (wantPassive && day) {
        const y = surface;
        const below = world.getBlock(x, y - 1, z) & 0xfff;
        if (below === this.core.registry.idOf('grass_block') && this.farEnough(x, y, z, players)) {
          const def = PASSIVE_POOL[rng.nextInt(PASSIVE_POOL.length)]!;
          if (this.standable(x, y, z, def)) {
            this.spawn(def, x + 0.5, y, z + 0.5);
            passives++;
          }
        }
      }
    }
  }

  /** 从某个高度往下找第一个够暗、站得住的位置 */
  private findHostileSpot(x: number, z: number, surface: number, startOffset: number): number {
    const world = this.core.world;
    const from = Math.min(surface, Math.max(2, startOffset + 2));
    for (let y = from; y > 1; y--) {
      if (world.store.getBlockLight(x, y, z) > MAX_SPAWN_LIGHT) continue;
      if (world.store.getSkyLight(x, y, z) > MAX_SPAWN_LIGHT) continue;
      const below = world.getBlock(x, y - 1, z) & 0xfff;
      if (below === 0) continue;
      if ((world.getBlock(x, y, z) & 0xfff) !== 0) continue;
      if ((world.getBlock(x, y + 1, z) & 0xfff) !== 0) continue;
      return y;
    }
    return -1;
  }

  private farEnough(x: number, y: number, z: number, players: readonly ServerPlayer[]): boolean {
    for (const p of players) {
      const dx = p.x - x;
      const dy = p.y - y;
      const dz = p.z - z;
      if (dx * dx + dy * dy + dz * dz < MIN_SPAWN_DISTANCE * MIN_SPAWN_DISTANCE) return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // 同步
  // -------------------------------------------------------------------------

  private broadcast(): void {
    // 超距的先清掉，免得白发一轮出生包再发销毁包
    this.despawnDistant();

    for (const player of this.core.eachPlayer()) {
      const spawns: Mob[] = [];
      const moves: Mob[] = [];
      const seen = new Set<number>();

      for (const mob of this.mobs.values()) {
        if (!player.isSubscribed(Math.floor(mob.x) >> 4, Math.floor(mob.z) >> 4)) continue;
        seen.add(mob.entityId);
        if (player.knownMobs.has(mob.entityId)) {
          const last = this.lastSent.get(mob.entityId);
          if (last === undefined
            || Math.abs(last.x - mob.x) > 0.01
            || Math.abs(last.y - mob.y) > 0.01
            || Math.abs(last.z - mob.z) > 0.01) moves.push(mob);
        } else {
          spawns.push(mob);
          player.knownMobs.add(mob.entityId);
        }
      }

      const destroys: number[] = [];
      for (const id of player.knownMobs) {
        if (!seen.has(id)) destroys.push(id);
      }
      for (const id of this.destroyed) {
        if (player.knownMobs.has(id)) destroys.push(id);
      }
      for (const id of destroys) player.knownMobs.delete(id);

      if (spawns.length > 0) {
        const buf = new DataView(new ArrayBuffer(spawns.length * SPAWN_MOB_STRIDE));
        spawns.forEach((m, i) => {
          const o = i * SPAWN_MOB_STRIDE;
          buf.setUint32(o, m.entityId, true);
          buf.setUint8(o + 4, m.def.type);
          buf.setUint8(o + 5, m.variant);
          buf.setInt32(o + 6, Math.round(m.x * ENTITY_POS_SCALE), true);
          buf.setInt32(o + 10, Math.round(m.y * ENTITY_POS_SCALE), true);
          buf.setInt32(o + 14, Math.round(m.z * ENTITY_POS_SCALE), true);
          buf.setInt16(o + 18, Math.round(m.yaw * 1000), true);
          buf.setInt16(o + 20, Math.round(m.headYaw * 1000), true);
          buf.setUint8(o + 22, Math.min(255, m.health));
        });
        player.channel.send(S_SpawnMobs, { entries: new Uint8Array(buf.buffer) });
      }

      if (moves.length > 0) {
        const buf = new DataView(new ArrayBuffer(moves.length * MOB_MOVE_STRIDE));
        moves.forEach((m, i) => {
          const o = i * MOB_MOVE_STRIDE;
          buf.setUint32(o, m.entityId, true);
          buf.setInt32(o + 4, Math.round(m.x * ENTITY_POS_SCALE), true);
          buf.setInt32(o + 8, Math.round(m.y * ENTITY_POS_SCALE), true);
          buf.setInt32(o + 12, Math.round(m.z * ENTITY_POS_SCALE), true);
          buf.setInt16(o + 16, Math.round(m.yaw * 1000), true);
          buf.setInt16(o + 18, Math.round(m.headYaw * 1000), true);
          // 状态位：受伤闪红 / 着火 / 苦力怕在鼓
          let flags = 0;
          if (m.hurtTime > 0) flags |= 1;
          if (m.fireTicks > 0) flags |= 2;
          if (m.fuse >= 0) flags |= 4;
          if (m.deathTicks >= 0) flags |= 8;
          buf.setUint8(o + 20, flags);
          buf.setUint8(o + 21, Math.min(255, m.health));
        });
        player.channel.send(S_MobMoves, { entries: new Uint8Array(buf.buffer) });
      }

      if (destroys.length > 0) {
        const buf = new DataView(new ArrayBuffer(destroys.length * 4));
        destroys.forEach((id, i) => buf.setUint32(i * 4, id, true));
        player.channel.send(S_DestroyEntities, { entries: new Uint8Array(buf.buffer) });
      }
    }

    for (const mob of this.mobs.values()) {
      this.lastSent.set(mob.entityId, { x: mob.x, y: mob.y, z: mob.z });
    }
    this.destroyed.length = 0;
  }

  /** 离所有玩家都超过 128 格的直接消失 */
  private despawnDistant(): void {
    const players = [...this.core.eachPlayer()];
    if (players.length === 0) return;
    for (const mob of [...this.mobs.values()]) {
      let nearest = Infinity;
      for (const p of players) {
        const d = Math.hypot(p.x - mob.x, p.y - mob.y, p.z - mob.z);
        if (d < nearest) nearest = d;
      }
      if (nearest > DESPAWN_DISTANCE) this.forget(mob);
    }
  }
}

/** 敌对生物的生成池。末影人在 1.0 里比较少见，这里靠重复次数控制比例 */
const HOSTILE_POOL: readonly MobDef[] = [
  mobDefOf(4)!, mobDefOf(4)!, mobDefOf(4)!,   // 僵尸 ×3
  mobDefOf(5)!, mobDefOf(5)!, mobDefOf(5)!,   // 骷髅 ×3
  mobDefOf(6)!, mobDefOf(6)!,                 // 苦力怕 ×2
  mobDefOf(7)!, mobDefOf(7)!,                 // 蜘蛛 ×2
  mobDefOf(8)!,                               // 末影人 ×1
];

const PASSIVE_POOL: readonly MobDef[] = [
  mobDefOf(0)!, mobDefOf(1)!, mobDefOf(2)!, mobDefOf(3)!,
];
