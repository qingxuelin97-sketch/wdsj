/**
 * 药水**真的作用在玩法上**了吗。
 *
 * 与 tests/core/enchanting.test.ts / tests/server/enchant-brew.test.ts 的分工：
 * 那两边验的是"配方表算得对"和"酿造台会出货"；这里验的是酿出来的东西
 * **有出口**、而且效果真的改变了某个计算 —— 血量、近战伤害、岩浆伤害、氧气。
 *
 * 这个文件的存在理由和 enchant-gameplay.test.ts 一模一样，是同一类事故的第二次：
 * M15 把整套酿造做完了（药水表、酿造台、400 刻进度，测试全绿），
 * 可是玻璃瓶灌不了水、药水喝不下去 —— 玩家能酿出一瓶迅捷药水，
 * 然后除了看着它没有任何用处。**算法对不代表接上了。**
 *
 * 所以每一条测试都盯着"接线断了会怎样"：断了的话，喝完血量不动、
 * 打怪伤害不变、泡在岩浆里照样掉血，而没有任何一处会报错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerCore } from '../../src/server/server-core.ts';
import { createBlockRegistry, Blocks } from '../../src/content/blocks.ts';
import { createItemRegistry, Items } from '../../src/content/items.ts';
import { MemoryStorage } from '../../src/platform/storage.ts';
import { WorldSave } from '../../src/server/save/world-save.ts';
import { SaveController } from '../../src/server/save/save-controller.ts';
import { LoopbackTransport, PacketChannel } from '../../src/core/net/transport.ts';
import { S2C, C_Handshake, C_SetViewDistance, C_UseBlock, PROTOCOL_VERSION } from '../../src/core/net/packets.ts';
import { packState, AIR_STATE } from '../../src/core/world/chunk.ts';
import { makeStack } from '../../src/core/item/item-def.ts';
import {
  Effect, WATER_BOTTLE, writePotion, potionPotency, readPotion, brew,
} from '../../src/core/craft/brewing.ts';
import { BrewingEntity, BREW_TICKS } from '../../src/server/world/block-entity-craft.ts';
import { onAttackEntity } from '../../src/server/entity/combat.ts';
import { POTION, MAX_HEALTH, AIR_SUPPLY_TICKS } from '../../src/core/constants.ts';
import type { ServerPlayer } from '../../src/server/player/server-player.ts';

const registry = createBlockRegistry();
const items = createItemRegistry();
const STONE = packState(registry.idOf(Blocks.STONE));

interface Rig {
  core: ServerCore;
  player: ServerPlayer;
  send: (p: unknown, v: Record<string, unknown>) => void;
}

function makeRig(core = new ServerCore({ seed: 7n, registry })): Rig {
  core.randomTicks = false;
  const [clientSide, serverSide] = LoopbackTransport.createPair();
  clientSide.synchronous = true;
  serverSide.synchronous = true;
  core.addClient(serverSide);
  const channel = new PacketChannel(clientSide, S2C);
  channel.onPacket(() => {});
  channel.send(C_Handshake, { protocolVersion: PROTOCOL_VERSION, playerName: 't' });
  channel.send(C_SetViewDistance, { distance: 2 });
  channel.flush();
  const player = [...core.eachPlayer()][0]!;
  for (let cx = -1; cx <= 1; cx++) {
    for (let cz = -1; cz <= 1; cz++) core.world.forceChunk(cx, cz);
  }
  // 一片干净的平地。地形里自带的水/岩浆会把"泡在岩浆里掉了多少血"搅浑
  for (let x = -8; x < 8; x++) {
    for (let z = -8; z < 8; z++) {
      core.world.setBlock(x, 70, z, STONE);
      for (let y = 71; y < 80; y++) core.world.setBlock(x, y, z, AIR_STATE);
    }
  }
  player.x = 0.5;
  player.y = 71;
  player.z = 0.5;
  player.onGround = true;
  player.peakY = 71;
  core.tick();
  return {
    core, player,
    send: (p, v) => { channel.send(p as never, v as never); channel.flush(); },
  };
}

/**
 * 把这件东西放到玩家**手上**。
 *
 * 不能写 `slots[selectedHotbar]` —— 那是护甲格（见 player-inventory.ts 的 held）。
 * 写错的症状是"药水完全没生效"，和接线断了一模一样。
 */
function setHeld(player: ServerPlayer, id: number, count = 1, damage = 0): void {
  const dst = player.inventory.held;
  dst.id = id;
  dst.count = count;
  dst.damage = damage;
}

/** 一瓶药水的 damage 值 */
function potionOf(effect: number, upgraded = false): number {
  return writePotion({
    effect: effect as never, upgraded, extended: false, splash: false, awkward: false,
  });
}

/**
 * 手上拿这瓶药水，对着脚下那块石头右键。
 *
 * 走的是**真实路径** C_UseBlock -> onUseBlock -> usePotionItem，
 * 不是直接调 applyPotion —— 这个文件要证的正是"这条路通了"。
 */
function drink(r: Rig, potionDamage: number): void {
  setHeld(r.player, items.idOf(Items.POTION), 1, potionDamage);
  r.send(C_UseBlock, { x: 0, y: 70, z: 0, face: 1, hitX: 0.5, hitY: 1, hitZ: 0.5 });
}

// ---------------------------------------------------------------------------
// 出口一：玻璃瓶灌水
// ---------------------------------------------------------------------------

test('右键水：玻璃瓶变成水瓶 —— 整条酿造链的第一环', () => {
  const r = makeRig();
  r.core.world.setBlock(2, 71, 0, packState(registry.idOf(Blocks.WATER)));
  setHeld(r.player, items.idOf(Items.GLASS_BOTTLE));
  r.send(C_UseBlock, { x: 2, y: 71, z: 0, face: 1, hitX: 0.5, hitY: 1, hitZ: 0.5 });

  const held = r.player.inventory.held;
  assert.equal(held.id, items.idOf(Items.POTION), '玻璃瓶该变成一瓶药水（水瓶）');
  assert.equal(held.damage, WATER_BOTTLE, '水瓶就是 damage 为 0 的药水');
  assert.equal(held.count, 1);
});

test('对着不是水的方块点玻璃瓶，什么都不会发生', () => {
  const r = makeRig();
  setHeld(r.player, items.idOf(Items.GLASS_BOTTLE));
  r.send(C_UseBlock, { x: 0, y: 70, z: 0, face: 1, hitX: 0.5, hitY: 1, hitZ: 0.5 });
  assert.equal(r.player.inventory.held.id, items.idOf(Items.GLASS_BOTTLE), '石头灌不出水来');
});

test('一摞玻璃瓶只灌掉一个，剩下的还在手上', () => {
  const r = makeRig();
  r.core.world.setBlock(2, 71, 0, packState(registry.idOf(Blocks.WATER)));
  setHeld(r.player, items.idOf(Items.GLASS_BOTTLE), 3);
  r.send(C_UseBlock, { x: 2, y: 71, z: 0, face: 1, hitX: 0.5, hitY: 1, hitZ: 0.5 });

  const held = r.player.inventory.held;
  assert.equal(held.id, items.idOf(Items.GLASS_BOTTLE), '手上该还是玻璃瓶');
  assert.equal(held.count, 2, '一摞 3 个只该少 1 个 —— 整摞变没就是凭空吞掉两个瓶子');
  const bottled = r.player.inventory.slots.filter(
    (s) => s.id === items.idOf(Items.POTION) && s.damage === WATER_BOTTLE,
  );
  assert.equal(bottled.length, 1, '灌出来的那瓶水该进背包');
});

// ---------------------------------------------------------------------------
// 出口二：喝下去
// ---------------------------------------------------------------------------

test('喝下去：效果挂上身，瓶子变回玻璃瓶', () => {
  const r = makeRig();
  const swift = potionOf(Effect.SPEED);
  drink(r, swift);

  const held = r.player.inventory.held;
  assert.equal(held.id, items.idOf(Items.GLASS_BOTTLE), '喝完该剩一个玻璃瓶');
  assert.equal(held.damage, 0);
  assert.ok(r.player.effects.has(Effect.SPEED), '迅捷没挂上身 —— 这一口白喝了');
  assert.equal(
    r.player.effects.remainingTicks(Effect.SPEED),
    potionPotency(swift).durationTicks,
    '时长该取自药水表',
  );
});

test('从酿造台拿出来的药水喝得下去 —— M15 缺的就是这一步', () => {
  const r = makeRig();
  const w = r.core.world;
  w.setBlock(2, 71, 0, packState(registry.idOf(Blocks.BREWING_STAND)));
  const stand = w.blockEntities.get(2, 71, 0);
  assert.ok(stand instanceof BrewingEntity);
  // 水瓶 -> 粗制 -> 迅捷，全程走真的酿造台
  stand.slots[0] = makeStack(items.idOf(Items.POTION), 1, WATER_BOTTLE);
  for (const ingredient of [Items.NETHER_WART, Items.SUGAR]) {
    stand.slots[3] = makeStack(items.idOf(ingredient), 1);
    for (let i = 0; i < BREW_TICKS + 2; i++) r.core.tick();
  }
  const brewed = stand.slots[0]!.damage;
  assert.equal(readPotion(brewed).effect, Effect.SPEED, '酿造台该出一瓶迅捷');

  drink(r, brewed);
  assert.ok(r.player.effects.has(Effect.SPEED), '酿出来的药水喝了没反应 —— 出口还是断的');
});

test('水瓶喝得下去，只是什么效果都没有', () => {
  const r = makeRig();
  drink(r, WATER_BOTTLE);
  assert.equal(r.player.inventory.held.id, items.idOf(Items.GLASS_BOTTLE));
  assert.equal(r.player.effects.size, 0, '水瓶不该挂任何效果');
});

// ---------------------------------------------------------------------------
// 效果真的改变了某个计算
// ---------------------------------------------------------------------------

test('治疗药水真的回血，增强的回一倍', () => {
  const r = makeRig();
  r.player.vitals.health = 4;
  drink(r, potionOf(Effect.HEALING));
  assert.equal(r.player.vitals.health, 4 + POTION.instantAmount, '治疗 I 该回 6 点');

  r.player.vitals.health = 4;
  drink(r, potionOf(Effect.HEALING, true));
  assert.equal(r.player.vitals.health, 4 + POTION.instantAmount * 2, '治疗 II 该回 12 点');

  // 回不过上限
  r.player.vitals.health = MAX_HEALTH;
  drink(r, potionOf(Effect.HEALING));
  assert.equal(r.player.vitals.health, MAX_HEALTH);
});

test('伤害药水真的掉血，而且穿一身钻甲也挡不住', () => {
  const r = makeRig();
  // 整套钻甲：物理伤害能减 80%，而魔法伤害**穿甲**
  for (const [slot, name] of [
    [0, 'diamond_helmet'], [1, 'diamond_chestplate'],
    [2, 'diamond_leggings'], [3, 'diamond_boots'],
  ] as const) {
    const dst = r.player.inventory.armorAt(slot);
    dst.id = items.idOf(name);
    dst.count = 1;
  }
  r.player.vitals.health = MAX_HEALTH;
  drink(r, potionOf(Effect.HARMING));
  assert.equal(
    r.player.vitals.health, MAX_HEALTH - POTION.instantAmount,
    '伤害药水该照扣 6 点 —— 被护甲挡下来的话这瓶药对披甲的人就是摆设',
  );
});

test('中毒按间隔掉血，但**毒不死人**', () => {
  const r = makeRig();
  r.player.vitals.hunger = 10;   // 关掉自然回血，免得把毒的效果抵消掉
  r.player.vitals.health = MAX_HEALTH;
  drink(r, potionOf(Effect.POISON));

  for (let i = 0; i < POTION.poisonInterval; i++) r.core.tick();
  assert.equal(
    r.player.vitals.health, MAX_HEALTH - 1,
    `中毒该每 ${POTION.poisonInterval} 刻掉 1 点血`,
  );

  // 1.0 的规则：毒最低留 1 血
  r.player.vitals.health = 1;
  for (let i = 0; i < POTION.poisonInterval * 6; i++) r.core.tick();
  assert.equal(r.player.vitals.health, 1, '中毒把人毒死了 —— 1.0 里毒最低留 1 血');
  assert.equal(r.player.vitals.dead, false);
});

test('再生按间隔回血', () => {
  const r = makeRig();
  // 饥饿压到自然回血的门槛以下，回的血才只可能来自药水
  r.player.vitals.hunger = 10;
  r.player.vitals.health = 10;
  drink(r, potionOf(Effect.REGENERATION));

  for (let i = 0; i < POTION.regenInterval - 2; i++) r.core.tick();
  assert.equal(r.player.vitals.health, 10, '还没到间隔就回血了');
  for (let i = 0; i < 3; i++) r.core.tick();
  assert.equal(r.player.vitals.health, 11, `再生该每 ${POTION.regenInterval} 刻回 1 点`);
});

test('力量真的加近战伤害，虚弱真的打不动', () => {
  const hit = (setup: (p: ServerPlayer) => void): number => {
    const r = makeRig();
    const mob = r.core.mobs.spawnByName('zombie', r.player.x + 1, r.player.y, r.player.z, r.player.dimension);
    assert.ok(mob !== null);
    setup(r.player);
    setHeld(r.player, items.idOf(Items.DIAMOND_SWORD));
    const before = mob.health;
    onAttackEntity(r.core, r.player, { entityId: mob.entityId } as never);
    return before - mob.health;
  };

  const plain = hit(() => { /* 不喝药 */ });
  assert.equal(plain, 7, '钻石剑的基础伤害');

  const strong = hit((p) => { p.effects.add(Effect.STRENGTH, 200, 0); });
  assert.equal(strong, 7 + POTION.strengthBonus, `力量 I 该打出 ${7 + POTION.strengthBonus}，实得 ${strong}`);

  const stronger = hit((p) => { p.effects.add(Effect.STRENGTH, 200, 1); });
  assert.equal(stronger, 7 + POTION.strengthBonus * 2, '力量 II 该翻倍');

  const weak = hit((p) => { p.effects.add(Effect.WEAKNESS, 200, 0); });
  assert.equal(weak, 7 - POTION.weaknessPenalty, `虚弱该减 ${POTION.weaknessPenalty} 点，实得 ${weak}`);
});

test('虚弱下空手打不动怪 —— 伤害归零的那一下整个不成立', () => {
  const r = makeRig();
  const mob = r.core.mobs.spawnByName('zombie', r.player.x + 1, r.player.y, r.player.z, r.player.dimension)!;
  r.player.effects.add(Effect.WEAKNESS, 200, 0);
  setHeld(r.player, 0, 0);   // 空手：1 点伤害，减 2 之后是负的
  const before = mob.health;
  onAttackEntity(r.core, r.player, { entityId: mob.entityId } as never);
  assert.equal(mob.health, before, '空手 + 虚弱不该掉血');
});

test('抗火：泡在岩浆里不掉血，但人照样在烧', () => {
  /** 在岩浆池里泡 40 刻，返回掉了多少血 */
  const soak = (fireproof: boolean): { lost: number; burning: boolean } => {
    const r = makeRig();
    const LAVA = registry.idOf(Blocks.LAVA);
    for (let x = -1; x <= 1; x++) {
      for (let z = -1; z <= 1; z++) {
        r.core.world.setBlock(x, 70, z, STONE);       // 池底，托住人
        r.core.world.setBlock(x, 71, z, packState(LAVA));
      }
    }
    r.player.x = 0.5; r.player.y = 71; r.player.z = 0.5;
    r.player.vitals.health = MAX_HEALTH;
    r.player.vitals.hunger = 10;
    if (fireproof) drink(r, potionOf(Effect.FIRE_RESISTANCE));
    for (let i = 0; i < 40; i++) r.core.tick();
    return { lost: MAX_HEALTH - r.player.vitals.health, burning: r.player.vitals.fireTicks > 0 };
  };

  const bare = soak(false);
  assert.ok(bare.lost > 0, '没喝药泡在岩浆里就该掉血（对照组不成立的话下面那条毫无意义）');

  const potion = soak(true);
  assert.equal(potion.lost, 0, `抗火药水该把岩浆伤害挡掉，实际掉了 ${potion.lost}`);
  assert.ok(potion.burning, '抗火只挡伤害，人照样着火 —— 与 MC 一致');
});

test('水下呼吸：泡在水里氧气不掉', () => {
  const soak = (breathing: boolean): number => {
    const r = makeRig();
    const WATER = registry.idOf(Blocks.WATER);
    for (let y = 71; y <= 74; y++) {
      for (let x = -1; x <= 1; x++) {
        for (let z = -1; z <= 1; z++) r.core.world.setBlock(x, y, z, packState(WATER));
      }
    }
    r.player.x = 0.5; r.player.y = 72; r.player.z = 0.5;
    if (breathing) drink(r, potionOf(Effect.WATER_BREATHING));
    r.player.vitals.air = AIR_SUPPLY_TICKS;
    for (let i = 0; i < 60; i++) r.core.tick();
    return r.player.vitals.air;
  };

  assert.ok(soak(false) < AIR_SUPPLY_TICKS, '没喝药在水里该憋气（对照组）');
  assert.equal(soak(true), AIR_SUPPLY_TICKS, '水下呼吸该让氧气一点都不掉');
});

test('效果到点自动消失，那一刻加成也跟着没', () => {
  const r = makeRig();
  const mob = r.core.mobs.spawnByName('zombie', r.player.x + 1, r.player.y, r.player.z, r.player.dimension)!;
  mob.health = 200;
  setHeld(r.player, items.idOf(Items.DIAMOND_SWORD));
  r.player.effects.add(Effect.STRENGTH, 5, 0);

  const swing = (): number => {
    const before = mob.health;
    mob.invulnerable = 0;   // 绕开无敌帧，这里量的是伤害不是节奏
    onAttackEntity(r.core, r.player, { entityId: mob.entityId } as never);
    return before - mob.health;
  };
  assert.equal(swing(), 7 + POTION.strengthBonus, '这会儿力量还在');

  for (let i = 0; i < 6; i++) r.core.tick();
  assert.equal(r.player.effects.size, 0, '5 刻的效果过了 6 刻还挂在身上 —— 没人给它扣时间');
  assert.equal(swing(), 7, '效果没了伤害就该回到基础值');
});

// ---------------------------------------------------------------------------
// 存盘
// ---------------------------------------------------------------------------

test('药水效果跟着 player.dat 存读 —— 退出重进不该白喝一瓶', async () => {
  const storage = new MemoryStorage();

  const first = new ServerCore({ seed: 7n, registry });
  const controller = new SaveController(first, new WorldSave(storage));
  await controller.loadLevel();
  const r = makeRig(first);
  drink(r, potionOf(Effect.FIRE_RESISTANCE, true));
  const left = r.player.effects.remainingTicks(Effect.FIRE_RESISTANCE);
  assert.ok(left > 0);
  await controller.saveNow();

  // 换一个 core 从盘上读回来，两个 core 之间不共享任何对象
  const second = new ServerCore({ seed: 7n, registry });
  const controller2 = new SaveController(second, new WorldSave(storage));
  assert.ok(await controller2.loadLevel(), '该读到存档');
  const r2 = makeRig(second);
  // 宿主（entry/server-worker.ts）在登录处理里调这一步，测试里手动补上
  assert.ok(controller2.restorePlayer(r2.player), '应该读到 player.dat');
  assert.ok(
    r2.player.effects.has(Effect.FIRE_RESISTANCE),
    '读档之后抗火没了 —— 玩家那瓶药是真的白喝了',
  );
  const after = r2.player.effects.remainingTicks(Effect.FIRE_RESISTANCE);
  assert.equal(after, left, `剩余时间该接着走：存的 ${left}，读回 ${after}`);
  assert.equal(r2.player.effects.amplifierOf(Effect.FIRE_RESISTANCE), 1, '增强的等级也要存下来');
});

// ---------------------------------------------------------------------------
// 顺带钉住一条与酿造表的接缝：酿出来的每一种药水都得有人认
// ---------------------------------------------------------------------------

test('主料能酿出来的每一种效果，喝下去都有反应', () => {
  const r = makeRig();
  const awkward = brew(WATER_BOTTLE, 'nether_wart');
  assert.ok(awkward !== null);
  for (const ingredient of ['sugar', 'magma_cream', 'spider_eye', 'glistering_melon', 'blaze_powder', 'ghast_tear']) {
    const damage = brew(awkward, ingredient);
    assert.ok(damage !== null, `${ingredient} 该酿得出东西`);
    r.player.effects.clear();
    r.player.vitals.health = 10;
    drink(r, damage);
    const info = readPotion(damage);
    // 瞬间生效的（治疗）不进状态表，改的是血量；其余的该留下一条效果
    const landed = potionPotency(damage).durationTicks === 0
      ? r.player.vitals.health !== 10
      : r.player.effects.has(info.effect);
    assert.ok(landed, `${ingredient} 酿的药水喝下去没有任何反应`);
  }
});
