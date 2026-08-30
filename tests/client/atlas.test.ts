/**
 * 图集完整性：每个被引用的贴图名都得有配方，而且画出来得是有效像素。
 *
 * 为什么要有这个测试 —— 它是被一次真实事故换来的：
 *
 * 把地形那批贴图配方从 `tile-recipes.ts` 拆进 `tile-recipes-terrain.ts` 时，
 * 按注释区块整段剪切，结果 `// --- 木材 ---` 那段里的 bookshelf 与两张
 * crafting_table 被一起剪掉、却没粘回去。三样东西都没发现：
 *
 *   - `tsc` 干净 —— 配方表是 `Record<string, Recipe>`，少几个键不是类型错误
 *   - 三个 lint 全绿 —— 分层、可擦除、行数都跟这事无关
 *   - `tools/tile-sheet.mjs` 说"262 张贴图"全部渲染成功 —— 它遍历的是
 *     **已存在的**配方，缺的那几个根本不在它的列表里，属于盲区
 *
 * 最后是无头冒烟测试里页面白屏才暴露：`buildAtlas` 抛
 * "贴图 'bookshelf' 没有配方"。那已经是一分钟一轮的最慢一环了。
 *
 * 教训与 `docs/RULES.md` 第 4 条同源：**自检的终止条件不能是
 * "我关心的那类报错没有了"**。这里的检查必须从"谁需要贴图"出发，
 * 不能从"谁有配方"出发。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBlockRegistry } from '../../src/content/blocks.ts';
import { createItemRegistry } from '../../src/content/items.ts';
import { buildAtlas, buildFaceLayerTable } from '../../src/client/render/block-textures.ts';
import { DESTROY_STAGE_NAMES, RECIPES } from '../../src/client/render/tile-recipes.ts';
import { ITEM_RECIPES } from '../../src/client/render/item-recipes.ts';
import { SKY_TILE_NAMES } from '../../src/client/render/tile-recipes-sky.ts';
import { PARTICLE_TEXTURE_NAMES } from '../../src/content/particles.ts';
import { TILE_BYTES, TILE_SIZE } from '../../src/client/render/texgen.ts';

/** 与 entry/client-main.ts 完全一致的那份名字清单 */
function allTextureNames(): string[] {
  const tables = createBlockRegistry().getTables();
  const items = createItemRegistry();
  return [
    ...tables.collectTextureNames(),
    ...DESTROY_STAGE_NAMES,
    ...items.all().map((d) => d.texture),
    'xp_orb',
    ...SKY_TILE_NAMES,
    ...PARTICLE_TEXTURE_NAMES,
  ];
}

test('每个被引用的贴图名都有配方', () => {
  // buildAtlas 缺配方时会抛，所以"不抛"本身就是断言。
  // 但要断在具体名字上，报错才有用 —— 不然只知道"图集建不起来"
  const names = allTextureNames();
  assert.doesNotThrow(() => buildAtlas(names), /没有配方/);
  const atlas = buildAtlas(names);
  for (const n of names) {
    assert.ok(atlas.index.has(n), `贴图 '${n}' 没进图集`);
  }
});

test('方块的每个面都能查到图集层号', () => {
  const tables = createBlockRegistry().getTables();
  const atlas = buildAtlas(allTextureNames());
  // 这一步在 client-main 里紧跟 buildAtlas，缺层号同样是启动即崩
  assert.doesNotThrow(() => buildFaceLayerTable(tables, atlas));
});

/**
 * 允许全透明的贴图。
 *
 * `moon_phase_4` 是**新月** —— 一个不透明像素都没有正是它该有的样子。
 * 第一版这条断言没开口子，于是它报了"贴图全透明"，看上去像月相配方坏了。
 * 这正是 `docs/HANDOFF.md` 里"先怀疑测试，再怀疑代码"说的那类：
 * 报出来像被测代码坏了，实际是断言写宽了。
 */
const MAY_BE_EMPTY = new Set(['moon_phase_4']);

test('没有一张贴图是全透明或纯黑的', () => {
  // 空贴图不会让任何东西报错，只会在画面上变成一块看不见的洞或者一块黑斑，
  // 而那要肉眼看截图才发现。配方写错（比如只 clear 了没画东西）就是这个症状
  const names = allTextureNames();
  const atlas = buildAtlas(names);
  for (const name of names) {
    if (MAY_BE_EMPTY.has(name)) continue;
    const at = atlas.index.get(name)!* TILE_BYTES;
    let visible = 0;
    let bright = 0;
    for (let i = 0; i < TILE_BYTES; i += 4) {
      if (atlas.data[at + i + 3]! > 8) {
        visible++;
        if (atlas.data[at + i]! + atlas.data[at + i + 1]! + atlas.data[at + i + 2]! > 24) bright++;
      }
    }
    assert.ok(visible > 0, `贴图 '${name}' 一个不透明像素都没有`);
    assert.ok(bright > 0, `贴图 '${name}' 的可见像素全是纯黑`);
  }
});

test('贴图生成是确定的：同一个名字跑两次逐字节相同', () => {
  // 图集的层号与内容都进了截图黄金哈希。生成一旦不确定，
  // 黄金值就会无缘无故地漂，而且看上去像渲染坏了
  const names = allTextureNames();
  assert.deepEqual(buildAtlas(names).data, buildAtlas(names).data);
});

test('资源包覆盖层能顶掉配方生成的像素', () => {
  const names = ['stone', 'dirt'];
  const magenta = new Uint8Array(TILE_BYTES);
  for (let i = 0; i < TILE_BYTES; i += 4) {
    magenta[i] = 255; magenta[i + 1] = 0; magenta[i + 2] = 255; magenta[i + 3] = 255;
  }
  const atlas = buildAtlas(names, new Map([['stone', magenta]]));
  const stoneAt = atlas.index.get('stone')! * TILE_BYTES;
  const dirtAt = atlas.index.get('dirt')! * TILE_BYTES;
  assert.equal(atlas.data[stoneAt], 255, 'stone 该被覆盖成品红');
  assert.equal(atlas.data[stoneAt + 1], 0);
  // 没给覆盖的那张必须还是程序化生成的，不能被顺带清掉
  const dirtIsProcedural = atlas.data[dirtAt]! !== 255 || atlas.data[dirtAt + 1]! !== 0;
  assert.ok(dirtIsProcedural, 'dirt 没给覆盖，应该还是配方画的');
});

test('尺寸不对的覆盖贴图被忽略，退回配方', () => {
  // 资源包里混进一张 8×8 的图不该让整个图集错位 —— 那会表现为
  // "从某一层开始所有方块的贴图都串了"，极难往回追
  const wrong = new Uint8Array(8 * 8 * 4).fill(255);
  const atlas = buildAtlas(['stone'], new Map([['stone', wrong]]));
  assert.equal(atlas.data.length, TILE_BYTES);
  assert.equal(atlas.tileSize, TILE_SIZE);
  const allWhite = atlas.data.every((v, i) => (i % 4 === 3 ? true : v === 255));
  assert.ok(!allWhite, '尺寸不对的覆盖不该被采用');
});

test('方块配方与物品配方不能同名', () => {
  // `buildAtlas` 里是 `RECIPES[name] ?? ITEM_RECIPES[name]` —— 方块优先。
  // 一旦有同名，那件物品会**静默地**拿到方块的贴图，而且不会走
  // 物品专属的轮廓/体积处理。表现是"某件物品的图标莫名其妙变成了一个方块面"，
  // 没有任何报错，只能靠肉眼在物品栏里发现。
  //
  // 现在的命名靠 `_item` 后缀避开（door_item / bed_item / cake_item），
  // 但那只是约定，没有任何东西强制它 —— 所以在这里钉死。
  const blocks = new Set(Object.keys(RECIPES));
  const dup = Object.keys(ITEM_RECIPES).filter((k) => blocks.has(k));
  assert.deepEqual(dup, [], `物品配方与方块配方同名: ${dup.join(', ')}（物品那份会被静默忽略）`);
});
