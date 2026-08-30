/**
 * F3 叠层的**内容**。
 *
 * 用一个假的 UiRenderer 记下所有 rect/text 调用，于是可以在 node 里断言
 * "这一行显示了什么"，不必去看截图。
 *
 * 截图哈希能抓住"画面变了"，但抓不住"画面变得不对"—— 一个新的哈希
 * 只说明它和上次不同，不说明它现在是对的。这里补的正是那一半。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawDebugOverlay, type DebugInfo } from '../../src/client/ui/debug-overlay.ts';

interface Call { kind: 'rect' | 'text'; args: unknown[] }

/** 只实现 drawDebugOverlay 用到的两个方法 */
function fakeUi(): { calls: Call[]; ui: never } {
  const calls: Call[] = [];
  const ui = {
    rect: (...args: unknown[]) => { calls.push({ kind: 'rect', args }); },
    text: (...args: unknown[]) => { calls.push({ kind: 'text', args }); },
  };
  return { calls, ui: ui as never };
}

function info(over: Partial<DebugInfo> = {}): DebugInfo {
  return {
    fps: 60, frameMs: 16.7,
    frameSamples: [16, 17, 16, 33, 16],
    x: 10.25, y: 70.5, z: -33.75,
    yaw: 0, pitch: 0,
    standingOn: 'grass_block',
    biomeId: 1,
    skyLight: 15, blockLight: 0,
    timeOfDay: 6000, worldAge: 26000,
    rain: 0, thunder: 0,
    clientChunks: 100, serverChunks: 120,
    dirtySections: 0, meshInFlight: 0, pendingChunks: 0,
    sectionsDrawn: 300, sectionCount: 900,
    drawCalls: 380, quads: 138526,
    vramMB: 42.7, particles: 0,
    entities: 0, mobs: 0,
    serverTick: 524, serverTickMs: 0.2,
    jsHeapMB: 33,
    ...over,
  };
}

function texts(d: DebugInfo): string[] {
  const { calls, ui } = fakeUi();
  drawDebugOverlay(ui, d);
  return calls.filter((c) => c.kind === 'text').map((c) => String(c.args[0]));
}

test('该有的信息都在', () => {
  const lines = texts(info());
  const all = lines.join('\n');
  for (const needle of [
    'XYZ', 'Block', 'Chunk', 'Facing', 'Biome', 'Standing on',
    'Light', 'Time', 'Weather', 'Chunks', 'Sections', 'Mesh queue',
    'Draws', 'VRAM', 'Heap', 'Particles', 'Entities', 'Server', 'fps',
  ]) {
    assert.ok(all.includes(needle), `F3 少了「${needle}」这一项：\n${all}`);
  }
});

test('坐标取整用的是 floor 而不是 trunc —— 负坐标最容易错', () => {
  // -33.75 所在的方块是 -34，不是 -33。用 trunc（或者 |0）会得到 -33，
  // 而那一格是**隔壁**。这个错误只在世界的负半边显形
  const lines = texts(info({ x: 10.25, y: 70.5, z: -33.75 }));
  const block = lines.find((l) => l.startsWith('Block'));
  assert.equal(block, 'Block 10 70 -34');
});

test('区块坐标与区块内相对坐标 —— 负数要落在 0..15', () => {
  const lines = texts(info({ x: -1.5, y: 70, z: -17.5 }));
  const chunk = lines.find((l) => l.startsWith('Chunk '));
  // x: floor(-1.5) = -2，-2 >> 4 = -1，-2 mod 16 应当是 14 而不是 -2
  // z: floor(-17.5) = -18，-18 >> 4 = -2，-18 mod 16 = -2 -> 14
  assert.equal(chunk, 'Chunk -1 -2  rel 14 14');
});

test('朝向按 MC 的约定：yaw 0 朝 +Z 是南', () => {
  const facing = (yaw: number): string =>
    texts(info({ yaw })).find((l) => l.startsWith('Facing'))!;
  assert.match(facing(0), /south \+Z/);
  assert.match(facing(Math.PI / 2), /east -X/);
  assert.match(facing(Math.PI), /north -Z/);
  assert.match(facing(-Math.PI / 2), /west \+X/);
  // 绕一圈回来还是南 —— 负角度与超过 2π 都要能处理
  assert.match(facing(Math.PI * 2), /south \+Z/);
  assert.match(facing(-Math.PI * 4), /south \+Z/);
});

test('光照那一行同时给出总量与两个来源', () => {
  const line = texts(info({ skyLight: 4, blockLight: 13 }))
    .find((l) => l.startsWith('Light'))!;
  assert.equal(line, 'Light 13 (4 sky, 13 block)');
});

test('未知群系 id 不会崩，显示成 #id', () => {
  const line = texts(info({ biomeId: 250 })).find((l) => l.startsWith('Biome'))!;
  assert.equal(line, 'Biome #250');
});

test('拿不到堆内存时显示 n/a 而不是 -1 MB', () => {
  const line = texts(info({ jsHeapMB: -1 })).find((l) => l.startsWith('Heap'))!;
  assert.equal(line, 'Heap n/a');
});

test('帧时间直方图真的画出来了', () => {
  // 这条是被一张截图逼出来的：图上右侧那块该有直方图的地方是空的。
  // 光看哈希发现不了 —— 哈希只说"和上次不同"，不说"少画了一块"
  const { calls, ui } = fakeUi();
  drawDebugOverlay(ui, info({ frameSamples: [16, 17, 16, 33, 16, 16, 40] }));
  const rects = calls.filter((c) => c.kind === 'rect');
  // 直方图 = 一块底 + 一条基准线 + 每个采样一根条
  assert.ok(rects.length > 20, `矩形太少，直方图多半没画：${rects.length} 个`);

  // 条的宽度是 1，文字底是几十像素宽 —— 用宽度把两者分开
  const bars = rects.filter((c) => c.args[2] === 1 && Number(c.args[3]) > 1);
  assert.ok(bars.length >= 7, `该有 7 根条（7 个采样），实得 ${bars.length}`);
});

test('没有采样时不画直方图，也不崩', () => {
  const { calls, ui } = fakeUi();
  assert.doesNotThrow(() => drawDebugOverlay(ui, info({ frameSamples: [] })));
  assert.ok(calls.length > 0, '文字还是要画的');
});
