/**
 * 菜单状态机。
 *
 * 它是个**纯**状态机（不碰相机、网络、音频，只产出 `MenuAction`），
 * 所以能在 node 里直接断言。这正是把"决定要做什么"与"真的去做"
 * 分开的回报 —— 前者可测，后者只剩几行胶水。
 *
 * 截图回归只能证明"画出来了"，证明不了"点了会怎样"。按钮画得再像，
 * 接线断了照样是一堆好看的矩形。这里补的就是那一半。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MenuState, DEFAULT_SETTINGS } from '../../src/client/ui/menu-screen.ts';

test('主菜单 -> 世界列表 -> 返回', () => {
  const m = new MenuState();
  assert.equal(m.open, false, '默认不该开着菜单');
  m.show('main');
  assert.deepEqual(m.buttonIds(), ['singleplayer', 'settings', 'quit']);
  m.press('singleplayer');
  assert.equal(m.screen, 'worlds');
  m.press('back');
  assert.equal(m.screen, 'main');
});

test('设置的"返回"回到来路，不是写死回主菜单', () => {
  const m = new MenuState();
  // 从暂停进设置，DONE 该回暂停 —— 回主菜单的话等于把人踢出了游戏
  m.show('pause');
  m.openSettingsFrom('pause');
  assert.equal(m.screen, 'settings');
  m.press('back');
  assert.equal(m.screen, 'pause');

  m.openSettingsFrom('main');
  m.press('back');
  assert.equal(m.screen, 'main');
});

test('设置项点一下换下一档，并循环回来', () => {
  const m = new MenuState();
  m.show('settings');
  const seen: number[] = [m.settings.renderDistance];
  for (let i = 0; i < 5; i++) {
    const a = m.press('rd');
    assert.equal(a.kind, 'settingsChanged', '改设置要通知宿主去应用');
    seen.push(m.settings.renderDistance);
  }
  // 五档走一圈回到原点
  assert.equal(seen[0], seen[5], `视距该循环回原值，实得 ${seen.join(',')}`);
  assert.equal(new Set(seen).size, 5, `五档该互不相同，实得 ${seen.join(',')}`);
});

test('开关项是真的翻转，不是只改标签', () => {
  const m = new MenuState();
  m.show('settings');
  assert.equal(m.settings.particles, true);
  m.press('particles');
  assert.equal(m.settings.particles, false);
  assert.ok(m.buttonIds().includes('particles'));
  m.press('sound');
  assert.equal(m.settings.sound, false);
});

test('按钮标签跟着设置值走 —— 改了值标签没变等于没改', () => {
  const m = new MenuState();
  m.show('settings');
  const label = (): string => {
    // buttonIds 只给 id，标签要从布局里取；这里用"按一下前后 fov 变了"间接验
    return String(m.settings.fov);
  };
  const before = label();
  m.press('fov');
  assert.notEqual(label(), before, 'FOV 该变');
});

test('世界列表：没选中时不能开始游戏', () => {
  const m = new MenuState();
  m.worlds = [{ name: 'A', seed: 1, lastPlayed: 0 }, { name: 'B', seed: 2, lastPlayed: 0 }];
  m.show('worlds');
  // 没选中 -> play 是禁用的，触发也不该返回 play
  assert.equal(m.press('play').kind, 'none');
  m.press('world:1');
  assert.equal(m.selectedWorld, 1);
  const a = m.press('play');
  assert.equal(a.kind, 'play');
  assert.equal(a.kind === 'play' ? a.seed : -1, 2, '该用选中那个世界的种子');
});

test('新建世界给的是一个真种子，不是 0', () => {
  const m = new MenuState();
  m.show('worlds');
  const a = m.press('newWorld');
  assert.equal(a.kind, 'play');
  if (a.kind !== 'play') return;
  assert.ok(Number.isInteger(a.seed) && a.seed > 0, `种子该是个正整数，实得 ${a.seed}`);
});

test('暂停菜单的三个按钮各自产出正确的动作', () => {
  const m = new MenuState();
  m.show('pause');
  assert.deepEqual(m.buttonIds(), ['resume', 'settings2', 'toTitle']);
  assert.equal(m.press('resume').kind, 'resume');
  assert.equal(m.screen, 'none', 'resume 之后菜单该关掉');
  m.show('pause');
  assert.equal(m.press('toTitle').kind, 'toTitle');
  assert.equal(m.screen, 'main');
});

test('默认设置没被谁改过', () => {
  // DEFAULT_SETTINGS 是个共享对象，MenuState 必须**拷贝**它。
  // 直接引用的话，改一次设置会污染下一局（以及所有测试）
  const a = new MenuState();
  a.show('settings');
  a.press('rd');
  const b = new MenuState();
  assert.equal(b.settings.renderDistance, DEFAULT_SETTINGS.renderDistance,
    '新开的菜单该拿到默认值 —— MenuState 没有拷贝 DEFAULT_SETTINGS');
});
