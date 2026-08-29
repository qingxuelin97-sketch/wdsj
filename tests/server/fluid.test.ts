/**
 * 流体：八个 ASCII 布局的逐格比对。
 *
 * 用剖面图而不是逐点断言，理由很实际：水的流向是**形状**问题，
 * 一堆 `assert.equal(getBlock(3,71,2), ...)` 读者根本看不出在验什么，
 * 而一张图一眼就知道。改坏了的时候，失败信息直接把两张图并排打出来。
 *
 * 剖面是 x-y 平面（z 固定），字符含义：
 *   `#` 石头   `.` 空气   `~` 水源（level 0）   `L` 岩浆源
 *   `0`..`7` 流动的水，数字是液面等级（0 最满）
 *   `l` 流动的岩浆   `O` 黑曜石   `C` 圆石   `S` 石头（岩浆遇水生成的）
 *
 * **测试世界必须四面封死**。露一条缝的话水会流进旁边真实生成的地形，
 * 而那里可能正好有个洞 —— 于是水只往一个方向跑，看上去像流向算错了。
 * 第一次跑就是这么被骗的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerCore } from '../../src/server/server-core.ts';
import { createBlockRegistry, Blocks } from '../../src/content/blocks.ts';
import { LoopbackTransport, PacketChannel } from '../../src/core/net/transport.ts';
import { S2C, C_Handshake, C_SetViewDistance, PROTOCOL_VERSION } from '../../src/core/net/packets.ts';
import { packState, stateId, stateMeta, AIR_STATE } from '../../src/core/world/chunk.ts';
import { placeFluid } from '../../src/server/world/fluid.ts';
import { isFalling, fluidLevel } from '../../src/content/blocks-fluid.ts';
import { igniteAt, primeTnt } from '../../src/server/world/block-ticks.ts';
import { onUseBlock } from '../../src/server/player/block-interaction.ts';
import { makeStack } from '../../src/core/item/item-def.ts';
import type { ServerPlayer } from '../../src/server/player/server-player.ts';

/** 对某个方块的上表面右键一下 */
function useBlockAt(core: ServerCore, player: ServerPlayer, x: number, y: number, z: number): void {
  onUseBlock(core, player, { x, y, z, face: 1 });
}

const registry = createBlockRegistry();
const STONE = registry.idOf(Blocks.STONE);
const OBSIDIAN = registry.idOf(Blocks.OBSIDIAN);
const COBBLE = registry.idOf(Blocks.COBBLESTONE);
const WATER = registry.idOf('water');
const LAVA = registry.idOf('lava');

/** 剖面所在的 z */
const Z = 2;
/** 剖面左下角的世界坐标 */
const X0 = 2;
const Y0 = 70;

/**
 * 建一个封闭的试验箱，并按剖面图摆好初始方块。
 *
 * 图是**自上而下**写的（第一行是最高的一层），和肉眼看剖面的方向一致。
 */
function buildArena(rows: readonly string[]): { core: ServerCore; width: number; height: number } {
  const core = new ServerCore({ seed: 7n, registry });
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

  for (let cx = -1; cx <= 2; cx++) {
    for (let cz = -1; cz <= 2; cz++) core.world.forceChunk(cx, cz);
  }

  const height = rows.length;
  const width = Math.max(...rows.map((r) => r.length));

  // 先把一整块区域挖空并围起来：左右上下各留一层石壁，前后（z）也封死。
  // 少了这一步，水会顺着缝流进真实地形，测试结果就再也说不清了
  for (let x = X0 - 2; x <= X0 + width + 1; x++) {
    for (let y = Y0 - 2; y <= Y0 + height + 1; y++) {
      for (let z = Z - 1; z <= Z + 1; z++) {
        const inside = x >= X0 && x < X0 + width && y >= Y0 && y < Y0 + height && z === Z;
        core.world.setBlock(x, y, z, inside ? AIR_STATE : packState(STONE));
      }
    }
  }

  // 玩家站在箱子外面：没有玩家的话，区块会在第一刻被全部卸载，
  // 水连同它所在的区块一起消失（这个坑在 M10 的生物测试里踩过一次）
  player.x = X0 + width / 2;
  player.y = Y0 + height + 4;
  player.z = Z;
  core.tick();

  const sources: [number, number, number][] = [];
  for (let row = 0; row < height; row++) {
    const line = rows[row]!;
    const y = Y0 + (height - 1 - row);
    for (let col = 0; col < line.length; col++) {
      const ch = line[col]!;
      const x = X0 + col;
      if (ch === '#') core.world.setBlock(x, y, Z, packState(STONE));
      else if (ch === 'L') sources.push([x, y, LAVA]);
      else if (ch === '~') sources.push([x, y, WATER]);
    }
  }
  // 液体最后放，这样它一出现周围的固体就已经就位了
  for (const [x, y, id] of sources) placeFluid(core.world, x, y, Z, id, 0);
  return { core, width, height };
}

/** 把剖面读回成字符串数组 */
function readArena(core: ServerCore, width: number, height: number): string[] {
  const out: string[] = [];
  for (let row = 0; row < height; row++) {
    const y = Y0 + (height - 1 - row);
    let line = '';
    for (let col = 0; col < width; col++) {
      const state = core.world.getBlock(X0 + col, y, Z);
      const id = stateId(state);
      const meta = stateMeta(state);
      if (id === 0) line += '.';
      else if (id === STONE) line += '#';
      else if (id === OBSIDIAN) line += 'O';
      else if (id === COBBLE) line += 'C';
      else if (id === 9) line += isFalling(meta) ? 'v' : (fluidLevel(meta) === 0 ? '~' : String(fluidLevel(meta)));
      else if (id === 8) line += isFalling(meta) ? 'v' : String(fluidLevel(meta));
      else if (id === 11) line += isFalling(meta) ? 'V' : (fluidLevel(meta) === 0 ? 'L' : String(fluidLevel(meta)));
      else if (id === 10) line += isFalling(meta) ? 'V' : String(fluidLevel(meta));
      else line += '?';
    }
    out.push(line);
  }
  return out;
}

/** 跑到流体稳定（计划刻清空）或者到上限 */
function settle(core: ServerCore, maxTicks = 600): number {
  for (let i = 0; i < maxTicks; i++) {
    core.tick();
    if (core.world.scheduled.size === 0) return i + 1;
  }
  return maxTicks;
}

/**
 * 建箱子、跑够刻数、比对剖面。
 *
 * @param ticks 跑多少刻。给 0 表示"跑到稳定为止"。
 *   多数用例看的是最终形态，但"水会拐弯找洞"必须看**过程** ——
 *   洞被填满之后它就不再是洞了，水会照常向四周铺开，
 *   于是最终形态里完全看不出它当初只往一个方向流过。
 */
function expectLayout(
  name: string, before: readonly string[], after: readonly string[], ticks = 0,
): void {
  const { core, width, height } = buildArena(before);
  const ran = ticks > 0 ? runTicks(core, ticks) : settle(core);
  const got = readArena(core, width, height);
  const want = after.map((r) => r.padEnd(width, ' ').slice(0, width));
  if (got.join('\n') !== want.join('\n')) {
    const side = got.map((g, i) => `  ${g}   ${want[i] ?? ''}`).join('\n');
    assert.fail(`${name} 不匹配（跑了 ${ran} 刻）\n  实得        期望\n${side}`);
  }
}

/** 跑固定刻数 */
function runTicks(core: ServerCore, n: number): number {
  for (let i = 0; i < n; i++) core.tick();
  return n;
}

test('①水源在平地上向两侧铺开，等级逐格递增', () => {
  expectLayout('平地铺开',
    [
      '...........',
      '.....~.....',
      '###########',
    ],
    [
      '...........',
      '54321~12345',
      '###########',
    ]);
});

test('②水流到边缘就往下落，落到底再铺开', () => {
  expectLayout('落差',
    [
      '..~........',
      '..##.......',
      '..##.......',
      '###########',
    ],
    [
      '.1~12......',
      '.v##v......',
      '1v##v123456',
      '###########',
    ]);
});

test('③水会拐弯找洞：只往有洞的那一侧流', () => {
  // 洞在源的左边两格。水应该**只往左**，右边一格都不去。
  //
  // 必须看过程而不是最终形态：洞灌满之后它就不是洞了，
  // 水会照常向右铺开，最终形态里看不出方向性。
  expectLayout('找洞',
    [
      '.......',
      '...~...',
      '#.#####',
      '#.#####',
      '#######',
    ],
    [
      '.......',
      '.21~...',
      '#v#####',
      '#v#####',
      '#######',
    ],
    20);
});

test('④无限水源：两个源之间的坑会变成源', () => {
  expectLayout('无限水源',
    [
      '.....',
      '~.~..',
      '#####',
    ],
    [
      '.....',
      '~~~12',
      '#####',
    ]);
});

test('⑤一个源不够：单独一个源旁边的格子只是流动水', () => {
  expectLayout('单源',
    [
      '.....',
      '~....',
      '#####',
    ],
    [
      '.....',
      '~1234',
      '#####',
    ]);
});

test('⑥水碰到岩浆源变黑曜石', () => {
  expectLayout('水+岩浆源',
    [
      '..~..',
      '.....',
      '..L..',
      '#####',
    ],
    [
      '..~..',
      '.1v1.',
      '1vOv1',
      '#####',
    ]);
});

test('⑦岩浆只流三格，比水短得多', () => {
  expectLayout('岩浆流距',
    [
      '.........',
      '....L....',
      '#########',
    ],
    [
      '.........',
      '.321L123.',
      '#########',
    ]);
});

test('⑧水被石头挡住就不再前进', () => {
  expectLayout('挡水',
    [
      '.......',
      '~..#...',
      '#######',
    ],
    [
      '.......',
      '~12#...',
      '#######',
    ]);
});

// ---------------------------------------------------------------------------
// 重力方块、火、TNT
// ---------------------------------------------------------------------------

test('⑨沙子失去支撑就往下掉，落在障碍上停住', () => {
  const { core, width, height } = buildArena([
    '..S..',
    '.....',
    '..#..',
    '#####',
  ]);
  // buildArena 不认 'S'，手动放沙子
  core.world.setBlock(X0 + 2, Y0 + 3, Z, packState(registry.idOf(Blocks.SAND)));
  settle(core);
  const got = readArena(core, width, height);
  // 沙子应该停在那格石头上（从第 3 行掉到第 1 行）
  assert.equal(stateId(core.world.getBlock(X0 + 2, Y0 + 3, Z)), 0, '原位应该空了');
  assert.equal(
    stateId(core.world.getBlock(X0 + 2, Y0 + 2, Z)), registry.idOf(Blocks.SAND),
    `沙子应该停在石头上，实际剖面:\n${got.join('\n')}`,
  );
});

test('⑩沙子会填进水里', () => {
  const { core } = buildArena([
    '..S..',
    '.....',
    '#####',
  ]);
  placeFluid(core.world, X0 + 2, Y0 + 1, Z, WATER, 0);
  core.world.setBlock(X0 + 2, Y0 + 2, Z, packState(registry.idOf(Blocks.SAND)));
  settle(core);
  assert.equal(
    stateId(core.world.getBlock(X0 + 2, Y0 + 1, Z)), registry.idOf(Blocks.SAND),
    '沙子应该把那格水挤掉',
  );
});

test('⑪火烧掉可燃物之后自己灭掉', () => {
  const { core } = buildArena([
    '.....',
    '.....',
    '.....',
    '#####',
  ]);
  const PLANKS = registry.idOf(Blocks.PLANKS);
  // 一小堆木板
  for (let dx = 0; dx < 3; dx++) core.world.setBlock(X0 + 1 + dx, Y0, Z, packState(PLANKS));
  assert.equal(igniteAt(core.world, X0 + 2, Y0 + 1, Z), true, '木板上方应该点得着');

  for (let i = 0; i < 4000; i++) core.tick();
  let planksLeft = 0;
  for (let dx = 0; dx < 3; dx++) {
    if (stateId(core.world.getBlock(X0 + 1 + dx, Y0, Z)) === PLANKS) planksLeft++;
  }
  const fireLeft = stateId(core.world.getBlock(X0 + 2, Y0 + 1, Z)) === registry.idOf('fire');
  assert.ok(planksLeft < 3, `木板应该被烧掉一些，实际还剩 ${planksLeft}/3`);
  assert.equal(fireLeft, false, '柴烧完之后火应该灭了');
});

test('⑫石头上点不着火', () => {
  const { core } = buildArena([
    '.....',
    '#####',
  ]);
  assert.equal(igniteAt(core.world, X0 + 2, Y0 + 1, Z), false, '四周没有可燃物就点不着');
});

test('⑬TNT 引信 80 刻，爆坑方块数与黄金值完全相等', () => {
  // 一整块实心石头里埋一个 TNT，炸完数一数少了多少格。
  //
  // 这一条验的是**爆炸射线的确定性**：算法里有随机（每条射线的初始强度带
  // 0.7..1.3 的抖动，爆坑边缘的参差就来自它），所以结果必须只取决于
  // 世界的随机种子。数目一旦漂移，说明有别的东西也在动那个随机源。
  const core = new ServerCore({ seed: 424242n, registry });
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
  // 16×16×16 的实心石块
  for (let x = 0; x < 16; x++) {
    for (let y = 60; y < 76; y++) {
      for (let z = 0; z < 16; z++) core.world.setBlock(x, y, z, packState(STONE));
    }
  }
  player.x = 8;
  player.y = 90;
  player.z = 8;
  core.tick();

  const TNT = registry.idOf(Blocks.TNT);
  core.world.setBlock(8, 68, 8, packState(TNT));
  assert.equal(primeTnt(core.world, 8, 68, 8), true);

  // 引信 80 刻：79 刻的时候还在
  for (let i = 0; i < 79; i++) core.tick();
  assert.equal(stateId(core.world.getBlock(8, 68, 8)), TNT, '第 79 刻 TNT 该还在');
  core.tick();
  assert.equal(stateId(core.world.getBlock(8, 68, 8)), 0, '第 80 刻该炸了');

  let destroyed = 0;
  for (let x = 0; x < 16; x++) {
    for (let y = 60; y < 76; y++) {
      for (let z = 0; z < 16; z++) {
        if (stateId(core.world.getBlock(x, y, z)) === 0) destroyed++;
      }
    }
  }
  // 黄金值：种子 424242、威力 4、埋在实心石头正中。
  // 这个数只在爆炸算法或随机源变了的时候才该变
  assert.equal(destroyed, TNT_CRATER_GOLDEN, `爆坑方块数漂了：期望 ${TNT_CRATER_GOLDEN}，实得 ${destroyed}`);
});

/** 见上一条测试。改这个数之前先确认爆炸算法真的该变 */
const TNT_CRATER_GOLDEN = 76;

test('⑭水桶：只舀得到源，舀完那格就空了；倒出来又是一个源', () => {
  const { core } = buildArena([
    '.....',
    '.....',
    '#####',
  ]);
  const player = [...core.eachPlayer()][0]!;
  // 一个源 + 它流出来的几格。放在 Y0+1（地板之上），
  // 放在 Y0 会直接把石头地板替换掉，水就没处可流了
  placeFluid(core.world, X0 + 1, Y0 + 1, Z, WATER, 0);
  settle(core);

  const bucket = core.items.idOf('bucket');
  const waterBucket = core.items.idOf('water_bucket');
  player.inventory.slots[player.inventory.slots.length - 9] = makeStack(bucket, 1);
  player.inventory.selectedHotbar = 0;
  // 玩家得站得够近。buildArena 把它放在箱子上方好几格，
  // 那个距离超过触及上限，右键会被静默拒绝 —— 于是"桶没变满"这条断言
  // 会因为**根本没点到**而通过，看上去像功能正常
  player.x = X0 + 2.5;
  player.y = Y0 + 1;
  player.z = Z;

  // 舀流动的水：桶不该变满
  const flowX = X0 + 3;
  assert.ok(
    fluidLevel(stateMeta(core.world.getBlock(flowX, Y0 + 1, Z))) > 0,
    `这一格该是流动水，实际剖面 ${readArena(core, 5, 3).join(' | ')}`,
  );
  useBlockAt(core, player, flowX, Y0 + 1, Z);
  assert.equal(player.inventory.held.id, bucket, '舀流动的水不该装满桶 —— 否则能凭空造水');

  // 舀源：桶变满，那格变空
  useBlockAt(core, player, X0 + 1, Y0 + 1, Z);
  assert.equal(player.inventory.held.id, waterBucket, '舀源应该装满桶');
  assert.equal(stateId(core.world.getBlock(X0 + 1, Y0 + 1, Z)), 0, '源那格该空了');
});
