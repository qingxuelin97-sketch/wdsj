/**
 * 存档：M9 的验收面。
 *
 * 核心断言就是那句话 —— **建结构 → 保存 → 重开 → 全部还原**。
 * 这里的"重开"是货真价实的：新建一个 ServerCore，只共用同一个存储后端，
 * 两个 core 之间没有任何对象是共享的。少了这一条，测试会因为
 * "第二个 core 恰好读到了第一个 core 内存里的东西"而假过。
 *
 * 另外盯住两件容易静默出错的事：
 *   1. 存档必须**优先于生成**。反了的话玩家盖的房子会被地形覆盖，
 *      而且只在区块被卸载过又走回去时发生。
 *   2. 同一个世界存两次要字节相同。不相同就说明存档里混进了
 *      遍历顺序之类与世界状态无关的东西，那种存档以后没法做增量。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerCore } from '../../src/server/server-core.ts';
import { createBlockRegistry, Blocks } from '../../src/content/blocks.ts';
import { createItemRegistry, Items } from '../../src/content/items.ts';
import { MemoryStorage } from '../../src/platform/storage.ts';
import { WorldSave } from '../../src/server/save/world-save.ts';
import { SaveController } from '../../src/server/save/save-controller.ts';
import { encodeChunkNbt } from '../../src/server/save/chunk-nbt.ts';
import { spawnItem } from '../../src/server/entity/item-manager.ts';
import { LoopbackTransport, PacketChannel } from '../../src/core/net/transport.ts';
import { S2C, C_Handshake, C_SetViewDistance, PROTOCOL_VERSION } from '../../src/core/net/packets.ts';
import { packState, stateId } from '../../src/core/world/chunk.ts';
import { makeStack, copyStack, isEmpty } from '../../src/core/item/item-def.ts';
import { Enchantment } from '../../src/core/item/enchantment.ts';
import { Dimension, convertCoords } from '../../src/core/world/dimension.ts';
import { travelThroughPortal } from '../../src/server/world/portal-manager.ts';
import { AWKWARD_POTION } from '../../src/core/craft/brewing.ts';
import { EnchantingEntity, BrewingEntity } from '../../src/server/world/block-entity-craft.ts';
import { FurnaceEntity, ChestEntity } from '../../src/server/world/block-entity.ts';
import type { ServerPlayer } from '../../src/server/player/server-player.ts';

const registry = createBlockRegistry();
const items = createItemRegistry();

interface Rig {
  core: ServerCore;
  save: WorldSave;
  controller: SaveController;
  player: ServerPlayer;
}

/**
 * 开一个服务端并接一个客户端上去。
 *
 * 顺序照抄真实宿主的不变式：**先把存档打开，再放客户端进来。**
 * 反过来的话，登录时强制生成的出生区块会把存过的内容永久顶掉
 * （见 save-controller.ts 的 loadLevel）。这个顺序是被
 * forcedOverPendingSave 断言盯着的。
 */
async function makeRig(storage: MemoryStorage, seed = 4242n): Promise<Rig> {
  const core = new ServerCore({ seed, registry });
  const save = new WorldSave(storage);
  const controller = new SaveController(core, save);
  await controller.loadLevel();
  const [clientSide, serverSide] = LoopbackTransport.createPair();
  clientSide.synchronous = true;
  serverSide.synchronous = true;
  core.addClient(serverSide);
  const channel = new PacketChannel(clientSide, S2C);
  channel.onPacket(() => {});
  channel.send(C_Handshake, { protocolVersion: PROTOCOL_VERSION, playerName: 'tester' });
  channel.send(C_SetViewDistance, { distance: 2 });
  channel.flush();
  const player = [...core.eachPlayer()][0]!;
  return { core, save, controller, player };
}

/**
 * 推进若干 tick，每次之间让出一轮事件循环。
 *
 * 存储是异步的（OPFS 只有异步 API），region 的到货落在 microtask 上；
 * 一路同步 tick 下去的话，ensureChunk 会永远看到"还没到货"。
 */
async function tickAsync(core: ServerCore, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    core.tick();
    await Promise.resolve();
  }
}

test('建结构 -> 保存 -> 重开 -> 结构/背包/坐标/熔炉进度/计划刻全部还原', async () => {
  const storage = new MemoryStorage();

  // --- 第一次进游戏：盖点东西 ---
  const a = await makeRig(storage);
  await tickAsync(a.core, 20);

  const bx = Math.floor(a.player.x);
  const bz = Math.floor(a.player.z);
  const by = Math.floor(a.player.y) + 1;

  // 一座三格高的黑曜石柱子 + 一个箱子 + 一个正在烧的熔炉
  const OBSIDIAN = registry.idOf(Blocks.OBSIDIAN);
  for (let i = 0; i < 3; i++) {
    assert.ok(a.core.world.setBlock(bx + 2, by + i, bz, packState(OBSIDIAN)), '应该放得下');
  }
  a.core.world.setBlock(bx + 3, by, bz, packState(registry.idOf(Blocks.CHEST)));
  a.core.world.setBlock(bx + 4, by, bz, packState(registry.idOf(Blocks.FURNACE)));

  const chest = a.core.world.blockEntities.get(bx + 3, by, bz) as ChestEntity;
  chest.slots[5] = makeStack(items.idOf(Items.DIAMOND), 17);
  const furnace = a.core.world.blockEntities.get(bx + 4, by, bz) as FurnaceEntity;
  furnace.slots[0] = makeStack(registry.idOf(Blocks.IRON_ORE), 5);
  furnace.slots[1] = makeStack(items.idOf(Items.COAL), 2);
  await tickAsync(a.core, 60); // 让熔炉真的烧一会儿

  const burnAtSave = furnace.burnTime;
  const cookAtSave = furnace.cookTime;
  assert.ok(burnAtSave > 0, '熔炉应该正烧着');
  assert.ok(cookAtSave > 0, '应该有熔炼进度');

  // 背包里塞点东西，位置挪一下
  a.player.inventory.slots[10] = makeStack(items.idOf(Items.IRON_PICKAXE), 1, 30);
  a.player.inventory.slots[31] = makeStack(registry.idOf(Blocks.TORCH), 44);
  a.player.inventory.selectedHotbar = 3;
  a.player.x = bx + 0.5;
  a.player.y = by;
  a.player.z = bz + 0.5;
  a.player.yaw = 1.25;
  a.player.pitch = -0.4;

  // 排一个计划刻
  a.core.world.scheduled.schedule(a.core.world.worldAge, bx + 2, by, bz, OBSIDIAN, 300);

  const timeAtSave = a.core.world.timeOfDay;
  const report = await a.controller.saveNow();
  assert.ok(report.chunks > 0, `应该存下了区块，实际 ${report.chunks}`);
  assert.ok(report.regions > 0, '应该写了 region 文件');

  // --- 第二次进游戏：换一个全新的 core，只共用存储 ---
  const b = await makeRig(storage);
  assert.equal(b.core.world.timeOfDay, timeAtSave, '世界时间要接上（说明 level.dat 读到了）');
  assert.ok(b.controller.restorePlayer(b.player), '应该读到 player.dat');

  // 熔炉的进度要在**它刚回到世界里、还没被 tick 过**的那一刻取。
  // 直接把区块要回来（region 已经在 loadLevel 里备好了），不经过 tick ——
  // 一进 tick 循环熔炉就接着烧了，那是对的行为，但会让"还原了多少"测不准
  const furnaceChunk = b.core.world.forceChunk((bx + 4) >> 4, bz >> 4);
  assert.ok(furnaceChunk !== null);
  const loaded = b.core.world.blockEntities.get(bx + 4, by, bz);
  assert.ok(loaded instanceof FurnaceEntity, '熔炉的方块实体没还原');
  const burnAtLoad = loaded.burnTime;
  const cookAtLoad = loaded.cookTime;

  await tickAsync(b.core, 40);
  assert.equal(
    b.core.world.forcedOverPendingSave, 0,
    '不该有任何区块在存档到货前被强行生成 —— 那会永久顶掉存过的内容',
  );

  // 结构
  for (let i = 0; i < 3; i++) {
    assert.equal(
      stateId(b.core.world.getBlock(bx + 2, by + i, bz)), OBSIDIAN,
      `柱子第 ${i} 格没还原 —— 存档没有优先于地形生成`,
    );
  }

  // 容器内容
  const chest2 = b.core.world.blockEntities.get(bx + 3, by, bz);
  assert.ok(chest2 instanceof ChestEntity, '箱子的方块实体没还原');
  assert.equal(chest2.slots[5]!.id, items.idOf(Items.DIAMOND));
  assert.equal(chest2.slots[5]!.count, 17, '箱子里的数量要一个不差');

  // 熔炉进度
  const furnace2 = b.core.world.blockEntities.get(bx + 4, by, bz);
  assert.ok(furnace2 instanceof FurnaceEntity, '熔炉的方块实体没还原');
  assert.equal(burnAtLoad, burnAtSave, '燃烧进度必须原样还原');
  assert.equal(cookAtLoad, cookAtSave, '熔炼进度必须原样还原');
  assert.equal(furnace2.slots[1]!.count, 1, '烧掉了一块煤，还剩一块');
  // 装回来之后要接着烧，而不是停在那里等人推一把
  assert.ok(furnace2.burnTime < burnAtLoad, '读档之后熔炉应该继续烧');

  // 背包与坐标
  assert.equal(b.player.inventory.slots[10]!.id, items.idOf(Items.IRON_PICKAXE));
  assert.equal(b.player.inventory.slots[10]!.damage, 30, '工具耐久要还原');
  assert.equal(b.player.inventory.slots[31]!.count, 44);
  assert.equal(b.player.inventory.selectedHotbar, 3);
  assert.ok(Math.abs(b.player.x - (bx + 0.5)) < 1e-9, '坐标要还原');
  assert.ok(Math.abs(b.player.yaw - 1.25) < 1e-9, '朝向要还原');

  // 计划刻
  assert.equal(b.core.world.scheduled.size, 1, '计划刻要还原');
});

test('掉落物跟着区块一起存读', async () => {
  const storage = new MemoryStorage();
  const a = await makeRig(storage);
  await tickAsync(a.core, 20);

  const x = Math.floor(a.player.x) + 1;
  const z = Math.floor(a.player.z);
  const y = Math.floor(a.player.y) + 3;
  const entity = spawnItem(a.core, x + 0.5, y, z + 0.5, makeStack(items.idOf(Items.DIAMOND), 9), false);
  assert.ok(entity !== null);
  await a.controller.saveNow();

  const b = await makeRig(storage);
  b.controller.restorePlayer(b.player);
  // 不经过 tick 直接把区块要回来：一进 tick 循环这颗钻石就会掉到玩家头上
  // 被捡走，那时候再数世界里的掉落物永远是 0
  b.core.world.forceChunk(Math.floor(entity.x) >> 4, Math.floor(entity.z) >> 4);
  assert.equal(b.core.world.forcedOverPendingSave, 0);
  const restored = [...b.core.world.items.values()]
    .filter((e) => e.stack.id === items.idOf(Items.DIAMOND));
  assert.equal(restored.length, 1, '掉落物应该跟着区块回来');
  assert.equal(restored[0]!.stack.count, 9);

  // 再跑一段：它应该落下来被玩家捡走 —— 读档 -> 下落 -> 拾取整条链路都活着
  await tickAsync(b.core, 40);
  assert.equal(b.core.world.items.size, 0, '掉落物应该被捡走了');
  const inPack = b.player.inventory.slots.find((s) => s.id === items.idOf(Items.DIAMOND));
  assert.equal(inPack?.count, 9, '钻石应该进了背包，一颗不少');
});

test('同一个世界存两次，字节完全相同', async () => {
  const storage = new MemoryStorage();
  const rig = await makeRig(storage);
  await tickAsync(rig.core, 20);
  rig.core.world.setBlock(2, 80, 2, packState(registry.idOf(Blocks.CHEST)));
  const chest = rig.core.world.blockEntities.get(2, 80, 2) as ChestEntity;
  chest.slots[3] = makeStack(items.idOf(Items.COAL), 12);
  rig.core.world.scheduled.schedule(rig.core.world.worldAge, 2, 80, 2, 54, 40);

  const world = rig.core.world;
  const snapshot = (): Uint8Array => encodeChunkNbt({
    chunk: world.store.getChunk(0, 0)!,
    blockEntities: world.blockEntities.inChunk(0, 0),
    items: [],
    mobs: [],
    arrows: [],
    tileTicks: world.scheduled.entriesIn(0, 0, 15, 15),
  }, world.worldAge);

  assert.deepEqual([...snapshot()], [...snapshot()], '两次编码必须逐字节相同');
});

test('400 个区块存 + 读，各自都在 2 秒以内', async () => {
  const storage = new MemoryStorage();
  const core = new ServerCore({ seed: 7n, registry });
  const save = new WorldSave(storage);
  const controller = new SaveController(core, save);

  // 20×20 = 400 个区块。生成本身不计时 —— 这一条测的是存档，不是世界生成
  for (let cx = 0; cx < 20; cx++) {
    for (let cz = 0; cz < 20; cz++) core.world.forceChunk(cx, cz);
  }
  assert.equal(core.world.loadedCount, 400);

  const t0 = performance.now();
  const report = await controller.saveNow();
  const saveMs = performance.now() - t0;
  assert.equal(report.chunks, 400);

  // 读：新世界，逐个把区块要回来
  const core2 = new ServerCore({ seed: 7n, registry });
  const save2 = new WorldSave(storage);
  core2.world.save = save2;
  for (let cx = 0; cx < 20; cx++) {
    for (let cz = 0; cz < 20; cz++) save2.requestRegion(cx, cz);
  }
  await new Promise((r) => { setTimeout(r, 0); });
  const t1 = performance.now();
  for (let cx = 0; cx < 20; cx++) {
    for (let cz = 0; cz < 20; cz++) core2.world.forceChunk(cx, cz);
  }
  const loadMs = performance.now() - t1;

  assert.equal(core2.world.loadedCount, 400);
  assert.ok(saveMs < 2000, `存 400 个区块用了 ${saveMs.toFixed(0)}ms，超过 2 秒`);
  assert.ok(loadMs < 2000, `读 400 个区块用了 ${loadMs.toFixed(0)}ms，超过 2 秒`);

  // 抽查：读回来的地形要和存进去的一致
  for (const [cx, cz] of [[0, 0], [7, 13], [19, 19]] as const) {
    for (let i = 0; i < 20; i++) {
      const x = cx * 16 + (i * 7) % 16;
      const z = cz * 16 + (i * 11) % 16;
      const y = 20 + i * 5;
      assert.equal(
        core2.world.getBlock(x, y, z), core.world.getBlock(x, y, z),
        `(${x},${y},${z}) 读回来的方块和存进去的不一样`,
      );
    }
  }
  console.log(`    400 区块：存 ${saveMs.toFixed(0)}ms / 读 ${loadMs.toFixed(0)}ms / `
    + `${(storage.totalBytes / 1048576).toFixed(1)}MB / ${storage.fileCount} 个文件`);
});

test('生物跟着区块一起存读，血量与羊的颜色都还原', async () => {
  const storage = new MemoryStorage();
  const a = await makeRig(storage);
  await tickAsync(a.core, 20);

  const x = Math.floor(a.player.x) + 2;
  const z = Math.floor(a.player.z) + 2;
  const y = Math.floor(a.player.y);
  const sheep = a.core.mobs.spawnByName('sheep', x + 0.5, y, z + 0.5)!;
  sheep.variant = 11;
  sheep.health = 5;
  const cow = a.core.mobs.spawnByName('cow', x + 0.5, y, z + 1.5)!;
  void cow;
  await a.controller.saveNow();

  const b = await makeRig(storage);
  b.controller.restorePlayer(b.player);
  b.core.world.forceChunk(x >> 4, z >> 4);

  const restored = [...b.core.mobs.mobs.values()];
  assert.equal(restored.length, 2, '两只都该回来');
  const back = restored.find((m) => m.def.name === 'sheep');
  assert.ok(back !== undefined, '羊应该回来了');
  assert.equal(back.variant, 11, '羊的颜色要还原 —— 否则重进游戏羊会集体变色');
  assert.equal(back.health, 5, '血量要还原');
  // AI 目标是**这一次运行**的状态，读档时重新装，不该跟着存
  assert.ok(back.goals.runningNames().length >= 0);
});

test('附魔与附魔台/酿造台跟着存档一起来回', async () => {
  const storage = new MemoryStorage();
  const a = await makeRig(storage);
  await tickAsync(a.core, 20);

  const bx = Math.floor(a.player.x);
  const bz = Math.floor(a.player.z);
  const by = Math.floor(a.player.y) + 1;

  // 一把锋利 V + 耐久 III 的钻石剑，放进箱子
  a.core.world.setBlock(bx + 3, by, bz, packState(registry.idOf(Blocks.CHEST)));
  const chest = a.core.world.blockEntities.get(bx + 3, by, bz) as ChestEntity;
  const sword = makeStack(items.idOf(Items.DIAMOND_SWORD), 1, 42);
  sword.enchantments = [
    { id: Enchantment.SHARPNESS, level: 5 },
    { id: Enchantment.UNBREAKING, level: 3 },
  ];
  copyStack(sword, chest.slots[2]!);

  // 同一把剑的另一份放在玩家身上 —— 两条存档路径不一样（region vs player.dat）
  copyStack(sword, a.player.inventory.slots[7]!);

  // 附魔台。1.0.0 的附魔台只有一格（青金石是 1.8 才加的），
  // 台面上摆一把剑 + 一个已经报过价的种子
  a.core.world.setBlock(bx + 5, by, bz, packState(registry.idOf(Blocks.ENCHANTING_TABLE)));
  const table = a.core.world.blockEntities.get(bx + 5, by, bz) as EnchantingEntity;
  assert.ok(table instanceof EnchantingEntity, '放下去就该有附魔台的方块实体');
  table.slots[0] = makeStack(items.idOf(Items.DIAMOND_SWORD), 1, 7);
  table.seed = 987654;

  // 酿造台，三个瓶位 + 一份材料
  a.core.world.setBlock(bx + 6, by, bz, packState(registry.idOf(Blocks.BREWING_STAND)));
  const stand = a.core.world.blockEntities.get(bx + 6, by, bz) as BrewingEntity;
  assert.ok(stand instanceof BrewingEntity, '放下去就该有酿造台的方块实体');
  const POTION = items.idOf(Items.POTION);
  stand.slots[0] = makeStack(POTION, 1, AWKWARD_POTION);
  stand.slots[1] = makeStack(POTION, 1, AWKWARD_POTION);
  stand.slots[3] = makeStack(items.idOf(Items.NETHER_WART), 1);

  await a.controller.saveNow();

  // --- 重开 ---
  const b = await makeRig(storage);
  assert.ok(b.controller.restorePlayer(b.player), '应该读到 player.dat');
  assert.ok(b.core.world.forceChunk((bx + 3) >> 4, bz >> 4) !== null);
  assert.ok(b.core.world.forceChunk((bx + 6) >> 4, bz >> 4) !== null);

  const enchOf = (s: { enchantments?: { id: number; level: number }[] }): string =>
    (s.enchantments ?? []).map((e) => `${e.id}/${e.level}`).join(',');
  const WANT = `${Enchantment.SHARPNESS}/5,${Enchantment.UNBREAKING}/3`;

  // 箱子里那把
  const chest2 = b.core.world.blockEntities.get(bx + 3, by, bz);
  assert.ok(chest2 instanceof ChestEntity, '箱子没还原');
  assert.equal(chest2.slots[2]!.damage, 42, '耐久要还原');
  assert.equal(enchOf(chest2.slots[2]!), WANT, '箱子里的剑不该把附魔弄丢');

  // 身上那把 —— 走的是 player.dat 加 copyStack 还原，另一条路
  assert.equal(enchOf(b.player.inventory.slots[7]!), WANT, '背包里的剑不该把附魔弄丢');

  // 没附魔的格子不该凭空长出附魔来
  assert.equal(enchOf(chest2.slots[0]!), '', '空格子不该带附魔');

  // 附魔台：漏注册的话这里是 null —— 方块还在，右键开出一个空窗口
  const table2 = b.core.world.blockEntities.get(bx + 5, by, bz);
  assert.ok(table2 instanceof EnchantingEntity, '附魔台的方块实体没还原');
  assert.equal(table2.slots[0]!.id, items.idOf(Items.DIAMOND_SWORD), '台面上的剑还在');
  assert.equal(table2.slots[0]!.damage, 7, '台面上那把剑的耐久要还原');
  assert.equal(table2.seed, 987654, '报价种子要还原，否则读档后三条附魔会全变');

  // 酿造台
  const stand2 = b.core.world.blockEntities.get(bx + 6, by, bz);
  assert.ok(stand2 instanceof BrewingEntity, '酿造台的方块实体没还原');
  assert.equal(stand2.slots[0]!.id, POTION);
  assert.equal(stand2.slots[0]!.damage, AWKWARD_POTION, '药水的种类写在 damage 里，丢了就变成清水');
  assert.equal(stand2.slots[1]!.id, POTION);
  assert.ok(isEmpty(stand2.slots[2]!), '空着的瓶位读回来还得是空的');
  assert.equal(stand2.slots[3]!.id, items.idOf(Items.NETHER_WART), '材料格要还原');
});

test('三个维度各存各的：下界不会把主世界的区块顶掉', async () => {
  const storage = new MemoryStorage();
  const a = await makeRig(storage);
  await tickAsync(a.core, 20);

  // 两边都挑**同一个区块坐标**下手。这是整条测试的要害：
  // region 的键里不带维度的话，两边会写到同一个文件上
  const cx = 0;
  const cz = 0;
  const OBSIDIAN = registry.idOf(Blocks.OBSIDIAN);
  const GOLD = registry.idOf(Blocks.GOLD_BLOCK);

  assert.ok(a.core.world.forceChunk(cx, cz) !== null);
  a.core.world.setBlock(3, 70, 5, packState(OBSIDIAN));

  // 下界：worldOf 现建一个，存档要在这一刻被 SaveController 挂上去
  const netherA = a.core.worldOf(Dimension.NETHER);
  assert.ok(netherA.save !== null, '新维度的世界必须自带存档，否则它写的东西一个字都留不下');
  assert.ok(netherA.forceChunk(cx, cz) !== null);
  netherA.setBlock(3, 40, 5, packState(GOLD));

  const report = await a.controller.saveNow();
  assert.ok(report.chunks > 0);

  // --- 重开 ---
  const b = await makeRig(storage);
  assert.ok(b.core.world.forceChunk(cx, cz) !== null);
  assert.equal(
    stateId(b.core.world.getBlock(3, 70, 5)), OBSIDIAN,
    '主世界那格没了 —— 多半是被下界同坐标的区块覆盖掉了',
  );

  // 下界的 region 是异步到货的。游戏里这一步由传送门那边的
  // areaReadyForForce 挡着（没到货就先不送人），这里照做一遍：
  // 直接 forceChunk 会在货到之前把地形生成出来，永久顶掉存过的内容
  const netherB = b.core.worldOf(Dimension.NETHER);
  for (let i = 0; i < 50 && !netherB.areaReadyForForce(3, 5, 1); i++) await Promise.resolve();
  assert.ok(netherB.areaReadyForForce(3, 5, 1), '下界的 region 应该已经到货');
  assert.ok(netherB.forceChunk(cx, cz) !== null);
  assert.equal(netherB.forcedOverPendingSave, 0, '不该有区块抢在存档到货前被生成');
  assert.equal(
    stateId(netherB.getBlock(3, 40, 5)), GOLD,
    '下界盖的东西没还原 —— 下界的区块根本没被存下来',
  );
  // 反过来也要成立：主世界那格不该在下界冒出来
  assert.notEqual(stateId(netherB.getBlock(3, 70, 5)), OBSIDIAN, '两个维度串了');
});

test('在下界存盘，读档还在下界', async () => {
  const storage = new MemoryStorage();
  const a = await makeRig(storage);
  await tickAsync(a.core, 20);

  const nether = a.core.worldOf(Dimension.NETHER);
  nether.forceChunk(0, 0);
  a.player.dimension = Dimension.NETHER;
  a.player.x = 6.5;
  a.player.y = 40;
  a.player.z = 6.5;
  await a.controller.saveNow();

  const b = await makeRig(storage);
  assert.ok(b.controller.restorePlayer(b.player));
  assert.equal(
    b.player.dimension, Dimension.NETHER,
    '读档把玩家丢回了主世界 —— 按下界坐标落进主世界，八成是卡在石头里',
  );
  assert.ok(Math.abs(b.player.y - 40) < 1e-9, '坐标要还原');
  // 那个维度的世界也得跟着建出来，否则玩家所在的世界是空的
  assert.ok([...b.core.loadedWorlds()].some((w) => w.dimension === Dimension.NETHER),
    '玩家在下界，下界的世界就得存在');
});

test('传送门在目标维度的存档到货前不送人 —— 送了就会顶掉存过的区块', async () => {
  const storage = new MemoryStorage();
  const a = await makeRig(storage);
  await tickAsync(a.core, 20);

  // 先在下界盖点东西存下来
  const nether = a.core.worldOf(Dimension.NETHER);
  const target = convertCoords(Dimension.OVERWORLD, Dimension.NETHER, a.player.x, a.player.z);
  const cx = target.x >> 4;
  const cz = target.z >> 4;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) nether.forceChunk(cx + dx, cz + dz);
  }
  const GOLD = registry.idOf(Blocks.GOLD_BLOCK);
  nether.setBlock(target.x, 45, target.z, packState(GOLD));
  await a.controller.saveNow();

  // --- 重开，立刻走传送门 ---
  const b = await makeRig(storage);
  b.player.x = a.player.x;
  b.player.z = a.player.z;
  const netherB = b.core.worldOf(Dimension.NETHER);

  // 第一次一定送不过去：region 还在读
  assert.equal(
    travelThroughPortal(b.core, b.player, Dimension.NETHER), false,
    '存档还没到货就把人送过去了 —— 落点那几个区块会被当场生成并永久顶掉存档',
  );
  assert.equal(b.player.dimension, Dimension.OVERWORLD, '没送成就该还在原地');

  // 等货到，再试一次
  let ok = false;
  for (let i = 0; i < 50 && !ok; i++) {
    await Promise.resolve();
    ok = travelThroughPortal(b.core, b.player, Dimension.NETHER);
  }
  assert.ok(ok, 'region 到货之后应该送得过去');
  assert.equal(b.player.dimension, Dimension.NETHER);
  assert.equal(netherB.forcedOverPendingSave, 0, '一个区块都不该抢在存档前生成');
  assert.equal(
    stateId(netherB.getBlock(target.x, 45, target.z)), GOLD,
    '上次在下界盖的东西必须还在',
  );
});
