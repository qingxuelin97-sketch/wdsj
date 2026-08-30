/**
 * 本项目的贴图名 -> Minecraft 资源包里的贴图文件名。
 *
 * 为什么需要这张表：两边的命名不一致，而且 **MC 自己前后也不一致**。
 *
 *   - 1.0 ~ 1.4：根本没有单张贴图，全部方块挤在一张 `terrain.png` 图集里
 *   - 1.5 ~ 1.12：拆成单张，放 `textures/blocks/`，名字是 `log_oak` 这种
 *                 "类别在前、变体在后"的写法
 *   - 1.13 起：目录改成单数 `textures/block/`，名字改成 `oak_log` 这种
 *                 "变体在前"的写法（那次"扁平化"重命名动了几百个文件）
 *
 * 所以每个名字给**一串候选**，加载器按顺序试，第一个 200 的就用。
 * 找不到就退回程序化生成 —— 资源包只是覆盖层，不是必需品。
 *
 * 注意：**这张表只是文件名，仓库里不含任何 Mojang 素材。**
 * 素材由使用者自己从本地的 MC 安装里解出来并指向它，见 `docs/ART-PLAN.md`。
 */

/** 我们的名字 -> 候选文件名（不含目录与扩展名），按优先级排 */
export const PACK_NAME_CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  // 命名两边一致的就不必列，加载器会自动把"我们的名字"本身作为最后一个候选。
  // 这里只列**对不上**的。
  grass_top: ['grass_block_top', 'grass_top'],
  grass_side: ['grass_block_side', 'grass_side'],
  planks: ['oak_planks', 'planks_oak', 'wood'],
  log_side: ['oak_log', 'log_oak', 'tree_side'],
  log_top: ['oak_log_top', 'log_oak_top', 'tree_top'],
  leaves: ['oak_leaves', 'leaves_oak', 'leaves'],
  sapling: ['oak_sapling', 'sapling_oak'],
  stone_bricks: ['stone_bricks', 'stonebrick'],
  bricks: ['bricks', 'brick'],
  mossy_cobblestone: ['mossy_cobblestone', 'cobblestone_mossy'],
  nether_brick: ['nether_bricks', 'nether_brick'],
  wool: ['white_wool', 'wool_colored_white'],
  glass: ['glass'],
  tall_grass: ['short_grass', 'grass', 'tallgrass'],
  dead_bush: ['dead_bush', 'deadbush'],
  dandelion: ['dandelion', 'flower_dandelion'],
  rose: ['poppy', 'flower_rose'],
  brown_mushroom: ['brown_mushroom', 'mushroom_brown'],
  red_mushroom: ['red_mushroom', 'mushroom_red'],
  crafting_table_top: ['crafting_table_top'],
  crafting_table_side: ['crafting_table_side', 'crafting_table_front'],
  furnace_top: ['furnace_top'],
  furnace_side: ['furnace_side'],
  furnace_front: ['furnace_front', 'furnace_front_off'],
  stone_slab_top: ['smooth_stone_slab_side', 'stone_slab_top'],
  stone_slab_side: ['smooth_stone_slab_side', 'stone_slab_side'],
  bed_top: ['red_bed_top', 'bed_head_top'],
  bed_side: ['red_bed_side', 'bed_head_side'],
  door_lower: ['oak_door_bottom', 'door_wood_lower'],
  trapdoor: ['oak_trapdoor', 'trapdoor'],
  ladder: ['ladder'],
  rail: ['rail'],
  chest_top: ['chest_top'],
  chest_side: ['chest_side'],
  chest_front: ['chest_front'],
  cake_top: ['cake_top'],
  cake_side: ['cake_side'],
  cake_bottom: ['cake_bottom'],
  cactus_top: ['cactus_top'],
  cactus_side: ['cactus_side'],
  soul_sand: ['soul_sand'],
  end_stone: ['end_stone'],
  mycelium_top: ['mycelium_top'],
  mycelium_side: ['mycelium_side'],
  enchanting_table_top: ['enchanting_table_top'],
  enchanting_table_side: ['enchanting_table_side'],
  torch: ['torch', 'torch_on'],
};

/** 资源包里贴图可能落在的目录，按优先级排 */
export const PACK_DIRS: readonly string[] = [
  'assets/minecraft/textures/block',
  'assets/minecraft/textures/blocks',
  'assets/minecraft/textures/item',
  'assets/minecraft/textures/items',
  // 有些人是直接把 textures/ 解出来的，不带 assets/minecraft 前缀
  'textures/block',
  'textures/blocks',
];

/** 给一个我们的贴图名，列出所有该试的相对路径 */
export function candidatePaths(name: string): string[] {
  const names = [...(PACK_NAME_CANDIDATES[name] ?? []), name];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    if (seen.has(n)) continue;
    seen.add(n);
    for (const dir of PACK_DIRS) out.push(`${dir}/${n}.png`);
  }
  return out;
}
