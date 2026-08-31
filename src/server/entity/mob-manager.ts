/**
 * 生物的每刻驱动：AI、物理、伤害、死亡掉落、与客户端的同步。
 *
 * 同步策略与掉落物完全一致（见 item-manager.ts）：**玩家认识一只生物，
 * 当且仅当它所在的区块被这个玩家订阅了。** 每刻按订阅集重算差集，
 * 多出来的发出生包、少掉的发销毁包。一句话的规则，省掉一整类
 * "实体跨区块时谁该收到什么"的边界 bug。
 */
import type { ServerCore } from '../server-core.ts';
import { Dimension, isDimension } from '../../core/world/dimension.ts';
import { extraLootFor } from '../player/enchant-apply.ts';
import type { ServerPlayer } from '../player/server-player.ts';
import { Mob } from './mob.ts';
import { installGoals } from './mob-factory.ts';
import { PathFinder } from './pathfind.ts';
import { MOBS, MobCategory, MobType, mobDefOf, type MobDef } from '../../content/mobs.ts';
import type { ServerWorld } from '../world/server-world.ts';
import { aimFireball, tickFireball } from './ghast.ts';
import { trySpawn, standable } from './mob-spawning.ts';
import { tickEnderEye } from '../world/end-portal.ts';
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

/** 超过这个距离就直接消失（MC 是 128） */
const DESPAWN_DISTANCE = 128;
/** 每多少刻尝试一次生成 */
const SPAWN_INTERVAL = 20;
/** 角色转向的最大距离平方，用于视线检查 */
const SIGHT_RANGE = 64;

export class MobManager {
  /** 公开给 mob-spawning：生成逻辑要问世界、注册表与在线玩家 */
  readonly core: ServerCore;
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
  spawn(def: MobDef, x: number, y: number, z: number, dimension = 0): Mob {
    const mob = new Mob(this.core.world.allocEntityId(), def, x, y, z,
      this.core.world.random.nextDouble() * Math.PI * 2);
    mob.dimension = dimension;
    installGoals(mob, (name) => this.core.items.idOf(name));
    if (def.name === 'sheep') mob.variant = this.core.world.random.nextInt(16);
    this.mobs.set(mob.entityId, mob);
    return mob;
  }

  /** 按名字生成，供指令与测试使用 */
  spawnByName(name: string, x: number, y: number, z: number, dimension = 0): Mob | null {
    const def = MOBS.find((m) => m.name === name);
    if (def === undefined) return null;
    return this.spawn(def, x, y, z, dimension);
  }

  /** 某个区块里的生物，存盘用 */
  inChunk(cx: number, cz: number, dimension = 0): Mob[] {
    const out: Mob[] = [];
    for (const m of this.mobs.values()) {
      if (m.dimension !== dimension) continue;
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
    for (const world of this.core.loadedWorlds()) this.tickWorld(world);
    this.broadcast();
  }

  /** 一个维度里的生物。按维度分开跑：拿错世界会让下界的怪读主世界的方块 */
  private tickWorld(world: ServerWorld): void {
    // 天气要参与判据：雷暴天的白天天光低到能刷怪、僵尸也不烧。
    // 这是 MC 的行为，也是雷暴之所以让人紧张的全部原因 ——
    // 少传这两个参数，天气就只剩画面效果
    const w = world.weather.snapshot();
    const day = isDaytime(world.timeOfDay, w.rainStrength, w.thunderStrength);

    if (this.naturalSpawning && world.worldAge % SPAWN_INTERVAL === 0) trySpawn(this, day, world);

    for (const mob of [...this.mobs.values()]) {
      if (mob.dimension !== world.dimension) continue;
      // 火球没有 AI，走自己的一条短路径：飞、撞、炸
      if (mob.def.type === MobType.FIREBALL) {
        this.tickFireball(mob, world);
        continue;
      }
      // 扔出去的末影之眼：飞一段，然后消失
      if (mob.def.type === MobType.ENDER_EYE) {
        mob.tickPhysicsAndVitals(world.store, world.tables, 15, true);
        if (mob.removed || tickEnderEye(mob)) this.forget(mob);
        continue;
      }
      // 区块卸载了就把生物也收走：留着的话它会在一个不存在的世界里
      // 一路掉到 y<-8 然后"摔死"，掉落物撒在没人看得见的地方。
      // 常驻的（BOSS 战部件）除外 —— 见 MobDef.persistent
      if (!mob.def.persistent
        && !world.isLoaded(Math.floor(mob.x) >> 4, Math.floor(mob.z) >> 4)) {
        this.forget(mob);
        continue;
      }

      if (mob.alive) {
        const ctx = this.makeCtx(mob, day, world);
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
  }

  /** 把一只生物从世界里拿掉（不掉落） */
  private forget(mob: Mob): void {
    this.mobs.delete(mob.entityId);
    this.lastSent.delete(mob.entityId);
    this.destroyed.push(mob.entityId);
  }

  /**
   * 龙死时撒的那一大堆经验。
   *
   * 单独一个入口是因为龙死在 dragon.ts 里处理（它死后还要放传送门），
   * 走不到 dropLoot 那条路；而 12000 点经验要拆成几十个球，
   * 那段拆分逻辑只此一份。
   */
  giveDragonXp(world: ServerWorld, x: number, y: number, z: number, amount: number): void {
    spawnXpOrbs(this.core, world, x, y, z, amount);
  }

  /** 死亡掉落 */
  private dropLoot(mob: Mob): void {
    if (mob.health > 0) return; // 是被卸载而不是被打死的
    // 掉在**这只怪所在的**维度里。用 core.world 的话，在下界打死的猪人
    // 会把猪排掉进主世界的同一个坐标上 —— 打的人什么都没捡到
    // isDimension 这一道是因为 Mob.dimension 是裸 number（实体是从存档
    // 读回来的，值可能是任何东西）。坏值退回主世界，总好过 worldOf
    // 拿到 undefined 的维度定义当场炸掉整个 tick
    const world = this.core.worldOf(isDimension(mob.dimension) ? mob.dimension : Dimension.OVERWORLD);
    const rng = world.random;
    const burned = mob.fireTicks > 0;
    for (const entry of mob.def.loot) {
      if (entry.chance < 1 && rng.nextDouble() > entry.chance) continue;
      // 抢夺：每一条各摇一次额外件数。逐条摇是原版的做法 ——
      // 摇一次给所有条目共用的话，抢夺会变成"要么全爆要么全不爆"
      const bonus = extraLootFor(mob.lootingLevel, (n) => rng.nextInt(n));
      const count = entry.min + rng.nextInt(entry.max - entry.min + 1) + bonus;
      if (count <= 0) continue;
      const name = burned && entry.cooked !== undefined ? entry.cooked : entry.item;
      const id = this.core.items.idOf(name);
      if (id <= 0) continue;
      spawnBlockDrop(this.core, world, Math.floor(mob.x), Math.floor(mob.y), Math.floor(mob.z), makeStack(id, count));
    }
    // 经验：MC 里敌对生物给 5 点、动物给 1-3 点
    if (mob.def.xp > 0) {
      spawnXpOrbs(this.core, world, mob.x, mob.y + 0.5, mob.z, mob.def.xp);
    }
    // 羊掉自己颜色的羊毛，不走战利品表
    if (mob.def.name === 'sheep') {
      const wool = this.core.registry.idOf('wool');
      if (wool > 0) {
        spawnBlockDrop(
          this.core, world, Math.floor(mob.x), Math.floor(mob.y), Math.floor(mob.z),
          makeStack(wool, 1, mob.variant),
        );
      }
    }
  }

  /** 火球的一刻：飞、撞、炸。实现在 entity/ghast.ts */
  private tickFireball(mob: Mob, world: ServerWorld): void {
    if (tickFireball(this.core, mob, world, this.mobs.values())) this.forget(mob);
  }

  /**
   * 玩家打了一颗火球：按玩家的视线方向重新瞄准，并换主人。
   *
   * @returns 是不是真的击回了一颗火球
   */
  deflectFireball(entityId: number, dirX: number, dirY: number, dirZ: number, byId: number): boolean {
    const mob = this.mobs.get(entityId);
    if (mob === undefined || mob.def.type !== MobType.FIREBALL) return false;
    aimFireball(mob, byId, dirX, dirY, dirZ);
    // 年龄清零：不清的话一颗快到寿命的火球刚打回去就自己没了
    mob.age = 0;
    return true;
  }

  /** 恶魂开火 */
  shootFireball(ghast: Mob, target: TargetRef): void {
    const def = mobDefOf(MobType.FIREBALL);
    if (def === null) return;
    // 从恶魂前方一点出生，别在自己身体里
    const dx = target.x - ghast.x;
    const dy = target.eyeY - (ghast.y + ghast.def.eyeHeight);
    const dz = target.z - ghast.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    const d = ghast.def.width / 2 + 1;
    const ball = this.spawn(
      def,
      ghast.x + (dx / len) * d,
      ghast.y + ghast.def.eyeHeight + (dy / len) * d,
      ghast.z + (dz / len) * d,
      ghast.dimension,
    );
    aimFireball(ball, ghast.entityId, dx, dy, dz);
  }

  private makeCtx(mob: Mob, day: boolean, world = this.core.world): MobCtx {
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
      // world 一定要传。漏了的话苦力怕在下界炸出来的坑开在**主世界**的
      // 同一个坐标上 —— 玩家这边什么都没发生（没坑、没特效），
      // 而主世界那边有人的房子被炸了
      explode: (m, power) => this.core.explode(m.x, m.y, m.z, power, m.entityId, world),
      shootArrow: (m, target) => this.core.shootArrow(m, target),
      shootFireball: (m, target) => this.shootFireball(m, target),
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
    // 末影人要传送到**它自己所在的**维度里去。读 core.world 的话，
    // 下界的末影人会按主世界的地形找落点 —— 找到的坐标在下界多半是实心的，
    // 表现是它闪一下然后卡在岩石里
    const world = this.core.worldOf(isDimension(mob.dimension) ? mob.dimension : Dimension.OVERWORLD);
    const rng = world.random;
    for (let attempt = 0; attempt < 16; attempt++) {
      const x = Math.floor(mob.x) + rng.nextInt(65) - 32;
      const z = Math.floor(mob.z) + rng.nextInt(65) - 32;
      if (!world.isLoaded(x >> 4, z >> 4)) continue;
      for (let y = Math.min(WORLD_HEIGHT - 3, Math.floor(mob.y) + 16); y > 1; y--) {
        if (!standable(world, x, y, z, mob.def)) continue;
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
        // 维度要先过一道。订阅集按**区块坐标**算，而三个维度的区块坐标
        // 是重叠的 —— 不过滤的话，从末地回到主世界之后，末影龙和十颗
        // 末影水晶会挂在主世界出生点的天上
        if (mob.dimension !== player.dimension) continue;
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
        // 只算**同一个维度**的玩家。三个维度的坐标是重叠的 ——
        // 不判这一句的话，一个站在主世界原点的玩家会把下界原点的怪
        // 永远钉在内存里（它"离玩家 0 格"），而下界那边其实一个人都没有
        if (p.dimension !== mob.dimension) continue;
        const d = Math.hypot(p.x - mob.x, p.y - mob.y, p.z - mob.z);
        if (d < nearest) nearest = d;
      }
      if (!mob.def.persistent && nearest > DESPAWN_DISTANCE) this.forget(mob);
    }
  }
}
