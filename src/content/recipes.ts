/**
 * MC 1.0 的合成表与熔炼表。
 *
 * 用字符画写配方（见 `shaped`），一眼能看出形状对不对 ——
 * 这一点比"省几行"重要得多：合成表是玩家最能察觉错误的地方，
 * 而形状写成一维数组之后没人能核对。
 *
 * 顺序有意义：`findRecipe` 取**第一个**匹配的，所以更具体的配方要排在前面。
 */
import { shaped, shapeless, type Recipe } from '../core/craft/recipe.ts';
import { createBlockRegistry, Blocks } from './blocks.ts';
import { createItemRegistry, Items } from './items.ts';

/** 一条熔炼配方 */
export interface SmeltingRecipe {
  readonly input: number;
  readonly outputId: number;
  readonly outputCount: number;
}

export interface CraftingData {
  readonly recipes: readonly Recipe[];
  readonly smelting: readonly SmeltingRecipe[];
}

/**
 * 建表。方块 id 与物品 id 同处一个数值空间（方块 1..122，物品 256..382），
 * 所以配方里可以直接混着写。
 */
export function createCraftingData(): CraftingData {
  const blocks = createBlockRegistry();
  const items = createItemRegistry();
  const B = (name: string): number => blocks.idOf(name);
  const I = (name: string): number => items.idOf(name);

  const PLANK = B(Blocks.PLANKS);
  const STICK = I(Items.STICK);
  const COBBLE = B(Blocks.COBBLESTONE);
  const IRON = I(Items.IRON_INGOT);
  const GOLD = I(Items.GOLD_INGOT);
  const DIAMOND = I(Items.DIAMOND);
  const STONE = B(Blocks.STONE);
  const REDSTONE = I(Items.REDSTONE);
  const STRING = I(Items.STRING);
  const LEATHER = I(Items.LEATHER);
  const GLASS = B(Blocks.GLASS);
  const WOOL = B(Blocks.WOOL);
  const COAL = I(Items.COAL);
  const CHARCOAL = I(Items.CHARCOAL);

  /** 一套工具：剑/镐/斧/铲/锄 */
  const toolSet = (mat: number, prefix: string): Recipe[] => [
    shaped(['M', 'M', 'S'], { M: mat, S: STICK }, I(`${prefix}_sword`)),
    shaped(['MMM', ' S ', ' S '], { M: mat, S: STICK }, I(`${prefix}_pickaxe`)),
    shaped(['MM', 'MS', ' S'], { M: mat, S: STICK }, I(`${prefix}_axe`)),
    shaped(['M', 'S', 'S'], { M: mat, S: STICK }, I(`${prefix}_shovel`)),
    shaped(['MM', ' S', ' S'], { M: mat, S: STICK }, I(`${prefix}_hoe`)),
  ];

  /** 一套盔甲 */
  const armorSet = (mat: number, prefix: string): Recipe[] => [
    shaped(['MMM', 'M M'], { M: mat }, I(`${prefix}_helmet`)),
    shaped(['M M', 'MMM', 'MMM'], { M: mat }, I(`${prefix}_chestplate`)),
    shaped(['MMM', 'M M', 'M M'], { M: mat }, I(`${prefix}_leggings`)),
    shaped(['M M', 'M M'], { M: mat }, I(`${prefix}_boots`)),
  ];

  const recipes: Recipe[] = [
    // --- 基础 ---
    shapeless([B(Blocks.LOG)], PLANK, 4),
    shaped(['P', 'P'], { P: PLANK }, STICK, 4),
    shaped(['PP', 'PP'], { P: PLANK }, B(Blocks.CRAFTING_TABLE)),
    shaped(['CCC', 'C C', 'CCC'], { C: COBBLE }, B(Blocks.FURNACE)),
    shaped(['PPP', 'P P', 'PPP'], { P: PLANK }, B(Blocks.CHEST)),
    shaped(['C', 'S'], { C: COAL, S: STICK }, B(Blocks.TORCH), 4),
    shaped(['C', 'S'], { C: CHARCOAL, S: STICK }, B(Blocks.TORCH), 4),
    shaped(['R', 'S'], { R: REDSTONE, S: STICK }, B(Blocks.REDSTONE_TORCH)),

    // --- 工具（5 套 × 5 件 = 25 条）---
    ...toolSet(PLANK, 'wooden'),
    ...toolSet(COBBLE, 'stone'),
    ...toolSet(IRON, 'iron'),
    ...toolSet(GOLD, 'golden'),
    ...toolSet(DIAMOND, 'diamond'),

    // --- 盔甲（4 套 × 4 件 = 16 条）---
    ...armorSet(LEATHER, 'leather'),
    ...armorSet(IRON, 'iron'),
    ...armorSet(GOLD, 'golden'),
    ...armorSet(DIAMOND, 'diamond'),

    // --- 建筑方块 ---
    shaped(['SSS'], { S: STONE }, B(Blocks.STONE_SLAB), 3),
    shaped(['P  ', 'PP ', 'PPP'], { P: PLANK }, B(Blocks.OAK_STAIRS), 4),
    shaped(['C  ', 'CC ', 'CCC'], { C: COBBLE }, B(Blocks.COBBLESTONE_STAIRS), 4),
    shaped(['B  ', 'BB ', 'BBB'], { B: B(Blocks.BRICKS) }, B(Blocks.BRICK_STAIRS), 4),
    shaped(['B  ', 'BB ', 'BBB'], { B: B(Blocks.STONE_BRICKS) }, B(Blocks.STONE_BRICK_STAIRS), 4),
    shaped(['SSS', 'SSS'], { S: STICK }, B(Blocks.FENCE), 2),
    shaped(['SPS', 'SPS'], { S: STICK, P: PLANK }, B(Blocks.FENCE_GATE)),
    shaped(['S S', 'SSS', 'S S'], { S: STICK }, B(Blocks.LADDER), 3),
    shaped(['GGG', 'GGG'], { G: GLASS }, B(Blocks.GLASS_PANE), 16),
    shaped(['III', 'III'], { I: IRON }, B(Blocks.IRON_BARS), 16),
    shaped(['SS', 'SS'], { S: B(Blocks.STONE) }, B(Blocks.STONE_BRICKS), 4),
    shaped(['BB', 'BB'], { B: I(Items.BRICK) }, B(Blocks.BRICKS)),
    shaped(['SS', 'SS'], { S: B(Blocks.SAND) }, B(Blocks.SANDSTONE)),
    shaped(['SS', 'SS'], { S: I(Items.SNOWBALL) }, B(Blocks.SNOW_BLOCK), 1, { mirror: false }),
    shaped(['CC', 'CC'], { C: I(Items.CLAY_BALL) }, B(Blocks.CLAY)),
    shaped(['SS', 'SS'], { S: STRING }, WOOL),
    shaped(['PPP', 'BBB', 'PPP'], { P: PLANK, B: I(Items.BOOK) }, B(Blocks.BOOKSHELF)),
    shaped(['GG', 'GG'], { G: I(Items.GLOWSTONE_DUST) }, B(Blocks.GLOWSTONE)),

    // --- 矿物压缩与还原 ---
    shaped(['III', 'III', 'III'], { I: IRON }, B(Blocks.IRON_BLOCK)),
    shaped(['GGG', 'GGG', 'GGG'], { G: GOLD }, B(Blocks.GOLD_BLOCK)),
    shaped(['DDD', 'DDD', 'DDD'], { D: DIAMOND }, B(Blocks.DIAMOND_BLOCK)),
    shapeless([B(Blocks.IRON_BLOCK)], IRON, 9),
    shapeless([B(Blocks.GOLD_BLOCK)], GOLD, 9),
    shapeless([B(Blocks.DIAMOND_BLOCK)], DIAMOND, 9),
    shaped(['NNN', 'NNN', 'NNN'], { N: I(Items.GOLD_NUGGET) }, GOLD),
    shapeless([GOLD], I(Items.GOLD_NUGGET), 9),

    // --- 红石与机关 ---
    shaped(['TTT', 'RRR', 'SSS'], { T: B(Blocks.REDSTONE_TORCH), R: REDSTONE, S: STONE },
      B(Blocks.REPEATER_BLOCK), 1, { mirror: false }),
    shaped(['S', 'C'], { S: STICK, C: COBBLE }, B(Blocks.LEVER)),
    shaped(['SS'], { S: STONE }, B(Blocks.STONE_PRESSURE_PLATE)),
    shaped(['PP'], { P: PLANK }, B(Blocks.WOODEN_PRESSURE_PLATE)),
    shapeless([STONE], B(Blocks.STONE_BUTTON)),
    shaped(['GSG', 'SGS', 'GSG'], { G: I(Items.GUNPOWDER), S: B(Blocks.SAND) }, B(Blocks.TNT)),
    shaped(['PPP', 'PDP', 'PPP'], { P: PLANK, D: DIAMOND }, B(Blocks.JUKEBOX)),
    shaped(['PPP', 'PRP', 'PPP'], { P: PLANK, R: REDSTONE }, B(Blocks.NOTE_BLOCK)),
    shaped(['CCC', 'CBC', 'CRC'], { C: COBBLE, B: I(Items.BOW), R: REDSTONE }, B(Blocks.DISPENSER)),

    // --- 交通 ---
    shaped(['I I', 'ISI', 'I I'], { I: IRON, S: STICK }, B(Blocks.RAIL), 16),
    shaped(['I I', 'III'], { I: IRON }, I(Items.MINECART)),
    shaped(['P P', 'PPP'], { P: PLANK }, I(Items.BOAT)),

    // --- 门窗与家具 ---
    shaped(['PP', 'PP', 'PP'], { P: PLANK }, I(Items.WOODEN_DOOR_ITEM)),
    shaped(['II', 'II', 'II'], { I: IRON }, I(Items.IRON_DOOR_ITEM)),
    shaped(['PPP', 'PPP'], { P: PLANK }, B(Blocks.TRAPDOOR), 2),
    shaped(['PPP', 'PPP', ' S '], { P: PLANK, S: STICK }, I(Items.SIGN), 3),
    shaped(['WWW', 'PPP'], { W: WOOL, P: PLANK }, I(Items.BED_ITEM)),
    shaped(['SSS', 'SWS', 'SSS'], { S: STICK, W: WOOL }, I(Items.PAINTING)),

    // --- 工具与器具 ---
    shaped([' I', 'I '], { I: IRON }, I(Items.SHEARS)),
    shaped(['I ', ' F'], { I: IRON, F: I(Items.FLINT) }, I(Items.FLINT_AND_STEEL)),
    shaped([' TS', 'T S', ' TS'], { T: STICK, S: STRING }, I(Items.BOW)),
    shaped(['F', 'S', 'T'], { F: I(Items.FLINT), S: STICK, T: I(Items.FEATHER) }, I(Items.ARROW), 4),
    shaped([' I ', 'IRI', ' I '], { I: IRON, R: REDSTONE }, I(Items.COMPASS)),
    shaped([' G ', 'GRG', ' G '], { G: GOLD, R: REDSTONE }, I(Items.CLOCK)),
    shaped(['  T', ' TS', 'T S'], { T: STICK, S: STRING }, I(Items.FISHING_ROD)),
    shaped(['I I', ' I '], { I: IRON }, I(Items.BUCKET)),
    shaped(['I I', 'I I', 'III'], { I: IRON }, B(Blocks.CAULDRON)),
    shaped([' B ', 'CCC'], { B: I(Items.BLAZE_ROD), C: COBBLE }, B(Blocks.BREWING_STAND)),
    shaped([' B ', 'DOD', 'OOO'], { B: I(Items.BOOK), D: DIAMOND, O: B(Blocks.OBSIDIAN) },
      B(Blocks.ENCHANTING_TABLE)),
    shaped(['G G', ' G '], { G: B(Blocks.GLASS) }, I(Items.GLASS_BOTTLE), 3),

    // --- 食物与农业 ---
    shaped(['WWW'], { W: I(Items.WHEAT) }, I(Items.BREAD)),
    shaped(['P P', ' P '], { P: PLANK }, I(Items.BOWL), 4),
    shapeless([B(Blocks.BROWN_MUSHROOM), B(Blocks.RED_MUSHROOM), I(Items.BOWL)], I(Items.MUSHROOM_STEW)),
    shaped(['MMM', 'SES', 'WWW'],
      { M: I(Items.MILK_BUCKET), S: I(Items.SUGAR), E: I(Items.EGG), W: I(Items.WHEAT) },
      I(Items.CAKE_ITEM)),
    shaped(['WCW'], { W: I(Items.WHEAT), C: I(Items.DYE) }, I(Items.COOKIE), 8),
    shapeless([I(Items.SUGAR_CANE)], I(Items.SUGAR)),
    shaped(['SSS'], { S: I(Items.SUGAR_CANE) }, I(Items.PAPER), 3),
    shaped(['P', 'P', 'P'], { P: I(Items.PAPER) }, I(Items.BOOK), 1, { mirror: false }),
    shapeless([B(Blocks.MELON)], I(Items.MELON_SLICE), 9),
    shapeless([I(Items.MELON_SLICE)], I(Items.MELON_SEEDS)),
    shapeless([B(Blocks.PUMPKIN)], I(Items.PUMPKIN_SEEDS), 4),
    shaped(['GGG', 'GAG', 'GGG'], { G: GOLD, A: I(Items.APPLE) }, I(Items.GOLDEN_APPLE)),
    shaped(['GGG', 'GMG', 'GGG'], { G: I(Items.GOLD_NUGGET), M: I(Items.MELON_SLICE) },
      I(Items.GLISTERING_MELON)),
    shaped(['MMM', 'MMM', 'MMM'], { M: I(Items.MELON_SLICE) }, B(Blocks.MELON)),
    shaped([' P ', 'PTP', ' P '], { P: B(Blocks.PUMPKIN), T: B(Blocks.TORCH) }, B(Blocks.JACK_O_LANTERN)),
    shapeless([B(Blocks.PUMPKIN), B(Blocks.TORCH)], B(Blocks.JACK_O_LANTERN)),

    // --- 酿造与末地 ---
    shapeless([I(Items.BLAZE_ROD)], I(Items.BLAZE_POWDER), 2),
    shapeless([I(Items.BLAZE_POWDER), I(Items.SLIMEBALL)], I(Items.MAGMA_CREAM)),
    shapeless([I(Items.SPIDER_EYE), I(Items.SUGAR), B(Blocks.BROWN_MUSHROOM)],
      I(Items.FERMENTED_SPIDER_EYE)),
    shapeless([I(Items.ENDER_PEARL), I(Items.BLAZE_POWDER)], I(Items.EYE_OF_ENDER)),
    shapeless([I(Items.BONE)], I(Items.BONE_MEAL), 3),
  ];

  // --- 熔炼 ---
  const smelting: SmeltingRecipe[] = [
    { input: B(Blocks.IRON_ORE), outputId: IRON, outputCount: 1 },
    { input: B(Blocks.GOLD_ORE), outputId: GOLD, outputCount: 1 },
    { input: B(Blocks.SAND), outputId: GLASS, outputCount: 1 },
    { input: B(Blocks.COBBLESTONE), outputId: STONE, outputCount: 1 },
    { input: B(Blocks.LOG), outputId: CHARCOAL, outputCount: 1 },
    { input: I(Items.CLAY_BALL), outputId: I(Items.BRICK), outputCount: 1 },
    { input: I(Items.PORKCHOP), outputId: I(Items.COOKED_PORKCHOP), outputCount: 1 },
    { input: I(Items.RAW_BEEF), outputId: I(Items.STEAK), outputCount: 1 },
    { input: I(Items.RAW_CHICKEN), outputId: I(Items.COOKED_CHICKEN), outputCount: 1 },
    { input: I(Items.RAW_FISH), outputId: I(Items.COOKED_FISH), outputCount: 1 },
    { input: B(Blocks.CACTUS), outputId: I(Items.DYE), outputCount: 1 },
    { input: B(Blocks.NETHERRACK), outputId: B(Blocks.NETHER_BRICK), outputCount: 1 },
  ];

  return { recipes, smelting };
}
