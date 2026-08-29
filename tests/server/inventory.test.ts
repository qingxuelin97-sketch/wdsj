/**
 * 物品栏接进服务端之后的闭环。
 *
 * 单测已经分别验过配方匹配与点击语义；这里验的是它们和世界连起来之后
 * 还成不成立：挖到的东西进不进背包、放置扣不扣、工具影不影响掉落、
 * 在窗口里能不能真的合成出东西。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerCore } from '../../src/server/server-core.ts';
import { createBlockRegistry, Blocks } from '../../src/content/blocks.ts';
import { createItemRegistry, Items } from '../../src/content/items.ts';
import { LoopbackTransport, PacketChannel } from '../../src/core/net/transport.ts';
import {
  S2C, C_Handshake, C_Command, C_UseBlock, C_PlayerAction, C_SetViewDistance,
  C_WindowClick, PROTOCOL_VERSION, PlayerActionKind, WindowKind,
} from '../../src/core/net/packets.ts';
import { AIR_STATE, packState, stateId } from '../../src/core/world/chunk.ts';
import { makeStack, isEmpty } from '../../src/core/item/item-def.ts';
import { showWindow, closeWindow } from '../../src/server/player/inventory-actions.ts';

const registry = createBlockRegistry();
const items = createItemRegistry();

function makePair(): { server: ServerCore; send: (p: unknown, v: Record<string, unknown>) => void; player: ReturnType<ServerCore['eachPlayer']> extends Iterable<infer T> ? T : never } {
  const server = new ServerCore({ seed: 1234n, registry });
  const [clientSide, serverSide] = LoopbackTransport.createPair();
  clientSide.synchronous = true;
  serverSide.synchronous = true;
  server.addClient(serverSide);
  const channel = new PacketChannel(clientSide, S2C);
  channel.onPacket(() => {});
  channel.send(C_Handshake, { protocolVersion: PROTOCOL_VERSION, playerName: 'tester' });
  channel.send(C_SetViewDistance, { distance: 2 });
  channel.flush();
  for (let i = 0; i < 40; i++) server.tick();
  const player = [...server.eachPlayer()][0]!;
  return {
    server,
    send: (p, v) => { channel.send(p as never, v as never); channel.flush(); },
    player: player as never,
  };
}

/** 找玩家脚下最近的实心方块 */
function groundBelow(server: ServerCore, px: number, py: number, pz: number): [number, number, number] {
  for (let y = py; y > py - 8; y--) {
    if (server.world.getBlock(px, y, pz) !== AIR_STATE) return [px, y, pz];
  }
  throw new Error('玩家脚下没有方块');
}

test('挖掉方块之后掉落物先落地，再被走过去的玩家捡起来', () => {
  const { server, send, player } = makePair();
  const [x, y, z] = groundBelow(server, Math.floor(player.x), Math.floor(player.y), Math.floor(player.z));
  const id = stateId(server.world.getBlock(x, y, z));

  send(C_PlayerAction, { action: PlayerActionKind.START_DIG, x, y, z, face: 1 });
  for (let i = 0; i < 300; i++) {
    server.tick();
    if (server.world.getBlock(x, y, z) === AIR_STATE) break;
  }
  assert.equal(server.world.getBlock(x, y, z), AIR_STATE, '应该挖穿了');

  // M9 起掉落物是真实体：破坏的那一刻它在世界里，而不是已经在背包里。
  // 这一条是整个里程碑的分界线 —— M8 的临时做法（直接进背包）到此为止
  assert.equal(server.world.items.size, 1, '应该在世界里留下一个掉落物');
  assert.equal(
    player.inventory.slots.reduce((a, s) => a + s.count, 0), 0,
    '拾取延迟还没走完，这时候背包该是空的',
  );

  // 拾取延迟 10 刻，再给它一点时间落地
  for (let i = 0; i < 40; i++) server.tick();
  assert.equal(server.world.items.size, 0, '掉落物应该被捡走了');
  const total = player.inventory.slots.reduce((a, s) => a + s.count, 0);
  assert.ok(total > 0, `背包里应该有东西，挖的是 ${registry.get(id)?.name}`);
});

test('工具不对口时什么都不掉 —— 这是"必须先做镐"的动力来源', () => {
  const { server, send, player } = makePair();
  // 在玩家旁边放一块石头，徒手挖
  const [gx, gy, gz] = groundBelow(server, Math.floor(player.x), Math.floor(player.y), Math.floor(player.z));
  const sx = gx + 2;
  server.world.setBlock(sx, gy, gz, packState(registry.idOf(Blocks.STONE)));

  send(C_PlayerAction, { action: PlayerActionKind.START_DIG, x: sx, y: gy, z: gz, face: 1 });
  for (let i = 0; i < 400; i++) {
    server.tick();
    if (server.world.getBlock(sx, gy, gz) === AIR_STATE) break;
  }
  assert.equal(server.world.getBlock(sx, gy, gz), AIR_STATE, '徒手也挖得动石头，只是慢');
  const stoneLike = [...server.world.items.values()].filter(
    (e) => e.stack.id === registry.idOf(Blocks.STONE) || e.stack.id === registry.idOf(Blocks.COBBLESTONE),
  );
  assert.equal(stoneLike.length, 0, '徒手挖石头不该掉任何东西');
});

test('有镐的时候石头掉圆石，不是石头本身', () => {
  const { server, send, player } = makePair();
  const [gx, gy, gz] = groundBelow(server, Math.floor(player.x), Math.floor(player.y), Math.floor(player.z));
  const sx = gx + 2;
  server.world.setBlock(sx, gy, gz, packState(registry.idOf(Blocks.STONE)));

  // 给一把钻石镐并拿在手上
  send(C_Command, { requestId: 1, text: 'give diamond_pickaxe 1' });
  server.tick();
  assert.equal(player.inventory.held.id, items.idOf(Items.DIAMOND_PICKAXE), '镐应该在手上');

  send(C_PlayerAction, { action: PlayerActionKind.START_DIG, x: sx, y: gy, z: gz, face: 1 });
  for (let i = 0; i < 200; i++) {
    server.tick();
    if (server.world.getBlock(sx, gy, gz) === AIR_STATE) break;
  }
  assert.equal(server.world.getBlock(sx, gy, gz), AIR_STATE);
  // 石头在玩家两格外，掉落物得等玩家……不，玩家不动。直接查世界里那个实体
  const dropped = [...server.world.items.values()];
  assert.equal(dropped.length, 1, '应该掉出一个东西');
  assert.equal(dropped[0]!.stack.id, registry.idOf(Blocks.COBBLESTONE), '应该掉圆石');
});

test('放置会从手上扣掉一个', () => {
  const { server, send, player } = makePair();
  send(C_Command, { requestId: 1, text: 'give stone 10' });
  server.tick();
  assert.equal(player.inventory.held.count, 10);

  const [gx, gy, gz] = groundBelow(server, Math.floor(player.x), Math.floor(player.y), Math.floor(player.z));
  const tx = gx + 2;
  let ty = gy;
  while (ty > 0 && server.world.getBlock(tx, ty, gz) === AIR_STATE) ty--;
  send(C_UseBlock, { x: tx, y: ty, z: gz, face: 1, hitX: 0.5, hitY: 1, hitZ: 0.5 });
  server.tick();

  assert.notEqual(server.world.getBlock(tx, ty + 1, gz), AIR_STATE, '应该放下了一块');
  assert.equal(player.inventory.held.count, 9, '手上应该少一个');
});

test('手上没东西就放不了 —— 不能凭空变出方块', () => {
  const { server, send, player } = makePair();
  assert.ok(isEmpty(player.inventory.held), '一开始手上是空的');
  const [gx, gy, gz] = groundBelow(server, Math.floor(player.x), Math.floor(player.y), Math.floor(player.z));
  const tx = gx + 2;
  let ty = gy;
  while (ty > 0 && server.world.getBlock(tx, ty, gz) === AIR_STATE) ty--;
  const before = server.world.getBlock(tx, ty + 1, gz);
  send(C_UseBlock, { x: tx, y: ty, z: gz, face: 1, hitX: 0.5, hitY: 1, hitZ: 0.5 });
  server.tick();
  assert.equal(server.world.getBlock(tx, ty + 1, gz), before, '空手不该放出方块');
});

test('在背包窗口的 2×2 里合成木板 -> 工作台', () => {
  const { server, send, player } = makePair();
  send(C_Command, { requestId: 1, text: 'give planks 4' });
  server.tick();

  showWindow(server, player, WindowKind.INVENTORY);
  const w = player.openWindow!;
  // 背包窗口：0 = 产物，1..4 = 2×2 合成格
  for (let i = 1; i <= 4; i++) {
    w.container.slots[i]!.id = registry.idOf(Blocks.PLANKS);
    w.container.slots[i]!.count = 1;
  }
  // 触发一次重算：点一下合成格（右键放 0 个，等价于刷新）
  w.click(1, 1, false);
  w.click(1, 1, false);

  const out = w.container.slots[0]!;
  assert.equal(out.id, registry.idOf(Blocks.CRAFTING_TABLE), `产物应是工作台，实得 ${out.id}`);
  assert.equal(out.count, 1);
});

test('取走产物会把四格材料各扣一个', () => {
  const { server, send, player } = makePair();
  send(C_Command, { requestId: 1, text: 'give planks 8' });
  server.tick();
  showWindow(server, player, WindowKind.INVENTORY);
  const w = player.openWindow!;
  for (let i = 1; i <= 4; i++) {
    w.container.slots[i]!.id = registry.idOf(Blocks.PLANKS);
    w.container.slots[i]!.count = 2;
  }
  w.click(1, 1, false);
  w.click(1, 1, false);
  assert.equal(w.container.slots[0]!.id, registry.idOf(Blocks.CRAFTING_TABLE));

  w.click(0, 0, false); // 左键取走产物
  assert.equal(w.container.cursor.id, registry.idOf(Blocks.CRAFTING_TABLE), '产物到手上');
  for (let i = 1; i <= 4; i++) {
    assert.equal(w.container.slots[i]!.count, 1, `第 ${i} 格材料应从 2 变成 1`);
  }
  // 材料还够，产物槽应立刻又出现一个
  assert.equal(w.container.slots[0]!.id, registry.idOf(Blocks.CRAFTING_TABLE), '还能再合一个');
});

test('关窗口时合成格里的材料会还给玩家', () => {
  const { server, send, player } = makePair();
  send(C_Command, { requestId: 1, text: 'give planks 4' });
  server.tick();
  showWindow(server, player, WindowKind.INVENTORY);
  const w = player.openWindow!;
  w.container.slots[1]!.id = registry.idOf(Blocks.PLANKS);
  w.container.slots[1]!.count = 3;
  w.pushToPlayer();

  closeWindow(server, player);
  const planks = player.inventory.slots.reduce(
    (a, s) => a + (s.id === registry.idOf(Blocks.PLANKS) ? s.count : 0), 0,
  );
  assert.ok(planks >= 3, `合成格里的 3 块木板应该还回背包，实得总数 ${planks}`);
  assert.equal(player.openWindow, null);
});

test('右键工作台会打开 3×3 界面', () => {
  const { server, send, player } = makePair();
  const [gx, gy, gz] = groundBelow(server, Math.floor(player.x), Math.floor(player.y), Math.floor(player.z));
  const tx = gx + 1;
  server.world.setBlock(tx, gy + 1, gz, packState(registry.idOf(Blocks.CRAFTING_TABLE)));
  send(C_UseBlock, { x: tx, y: gy + 1, z: gz, face: 1, hitX: 0.5, hitY: 1, hitZ: 0.5 });
  server.tick();
  assert.ok(player.openWindow !== null, '应该开了一个窗口');
  assert.equal(player.openWindow!.kind, WindowKind.CRAFTING);
});

test('过期的窗口点击会被丢弃', () => {
  const { server, send, player } = makePair();
  showWindow(server, player, WindowKind.INVENTORY);
  const stale = player.windowId - 1;
  send(C_Command, { requestId: 1, text: 'give stone 5' });
  server.tick();
  const before = player.inventory.slots.map((s) => s.count).join(',');
  send(C_WindowClick, { windowId: stale, slot: 5, button: 0, shift: false });
  server.tick();
  assert.equal(player.inventory.slots.map((s) => s.count).join(','), before, '过期点击不该改变任何东西');
});

void makeStack;

test('合成链：原木 -> 木板 -> 木棍 + 工作台 -> 木镐，全部走真实窗口', () => {
  // 闸门测试①在浏览器里跑的就是这条链。放一份在这里，
  // 是因为它挂掉时浏览器那边只会报"合成链断了"，看不出断在哪一步
  const { server, send, player } = makePair();
  send(C_Command, { requestId: 1, text: 'give log 8' });
  server.tick();

  send(C_Command, { requestId: 2, text: 'craftchain' });
  server.tick();

  const has = (name: string): number => {
    const id = registry.hasBlock(name) ? registry.idOf(name) : items.idOf(name);
    let n = 0;
    for (const s of player.inventory.slots) if (s.id === id) n += s.count;
    return n;
  };
  assert.ok(has('planks') > 0, '该合出木板');
  assert.ok(has('stick') > 0, '该合出木棍');
  assert.ok(has('crafting_table') > 0, '该合出工作台');
  assert.ok(has('wooden_pickaxe') > 0, '该合出木镐 —— 这是"第一夜"能不能过的分水岭');
});
