/**
 * 方块内容表。
 *
 * id 沿用 Minecraft 1.0 的真实数值（空气 0 … 龙蛋 122），这样对照原版时不需要换算，
 * 也让"1:1 复刻"这件事在数据层就是字面意义的。
 *
 * M1 先落地基础方块，后续里程碑逐步补齐到 1.0 的约 110 种。
 * 需要行为的方块（熔炉、箱子、门、流体、红石…）在各自的里程碑里补 hooks。
 */
import { FRICTION_ICE } from '../core/constants.ts';
import { defineBlock } from '../core/block/block-def.ts';
import type { BlockDef } from '../core/block/block-def.ts';
import { BlockRegistry } from '../core/registry/block-registry.ts';
import { ModelKind, RenderLayer, TintKind, SoundGroup, ToolKind, ToolTier, Facing } from '../core/block/types.ts';
import { NO_COLLISION } from '../core/math/aabb.ts';

/** 方块名常量，代码里一律用它引用方块，不写裸字符串 */
export const Blocks = {
  AIR: 'air',
  STONE: 'stone',
  GRASS_BLOCK: 'grass_block',
  DIRT: 'dirt',
  COBBLESTONE: 'cobblestone',
  PLANKS: 'planks',
  SAPLING: 'sapling',
  BEDROCK: 'bedrock',
  SAND: 'sand',
  GRAVEL: 'gravel',
  GOLD_ORE: 'gold_ore',
  IRON_ORE: 'iron_ore',
  COAL_ORE: 'coal_ore',
  LOG: 'log',
  LEAVES: 'leaves',
  GLASS: 'glass',
  LAPIS_ORE: 'lapis_ore',
  LAPIS_BLOCK: 'lapis_block',
  SANDSTONE: 'sandstone',
  WOOL: 'wool',
  DANDELION: 'dandelion',
  ROSE: 'rose',
  BROWN_MUSHROOM: 'brown_mushroom',
  RED_MUSHROOM: 'red_mushroom',
  GOLD_BLOCK: 'gold_block',
  IRON_BLOCK: 'iron_block',
  BRICKS: 'bricks',
  BOOKSHELF: 'bookshelf',
  MOSSY_COBBLESTONE: 'mossy_cobblestone',
  OBSIDIAN: 'obsidian',
  DIAMOND_ORE: 'diamond_ore',
  DIAMOND_BLOCK: 'diamond_block',
  CRAFTING_TABLE: 'crafting_table',
  FURNACE: 'furnace',
  REDSTONE_ORE: 'redstone_ore',
  SNOW_BLOCK: 'snow_block',
  ICE: 'ice',
  CLAY: 'clay',
  NETHERRACK: 'netherrack',
  SOUL_SAND: 'soul_sand',
  GLOWSTONE: 'glowstone',
  STONE_BRICKS: 'stone_bricks',
  MYCELIUM: 'mycelium',
  END_STONE: 'end_stone',
  TALL_GRASS: 'tall_grass',
  DEAD_BUSH: 'dead_bush',
} as const;
export type BlockName = (typeof Blocks)[keyof typeof Blocks];

/** 石质全立方体的共同参数，避免每个矿石重复写一遍 */
function stoneLike(id: number, name: string, hardness: number, texture: string, minTier: ToolTier): BlockDef {
  return defineBlock({
    id,
    name,
    hardness,
    tool: ToolKind.PICKAXE,
    minTier,
    textures: texture,
    soundGroup: SoundGroup.STONE,
  });
}

/** 十字形植物：无碰撞、cutout 渲染、随机刻 */
// tint 必须显式标注类型：只写默认值的话 TS 会把参数推断成字面量类型 0，
// 之后传 TintKind.GRASS 就报"1 不能赋给 0"。
function crossPlant(id: number, name: string, texture: string, tint: TintKind = TintKind.NONE): BlockDef {
  return defineBlock({
    id,
    name,
    hardness: 0,
    modelKind: ModelKind.CROSS,
    textures: texture,
    renderLayer: RenderLayer.CUTOUT,
    tint,
    opaque: false,
    solid: false,
    replaceable: true,
    collisionShape: NO_COLLISION,
    soundGroup: SoundGroup.GRASS,
    randomTick: true,
    flammability: 60,
  });
}

/** 建立并冻结方块注册表 */
export function createBlockRegistry(): BlockRegistry {
  const r = new BlockRegistry();

  // --- 空气 ---
  r.register(
    defineBlock({
      id: 0,
      name: Blocks.AIR,
      hardness: -1,
      modelKind: ModelKind.NONE,
      textures: '',
      opaque: false,
      solid: false,
      replaceable: true,
      collisionShape: NO_COLLISION,
    }),
  );

  // --- 地形 ---
  r.register(stoneLike(1, Blocks.STONE, 1.5, 'stone', ToolTier.WOOD));
  r.register(
    defineBlock({
      id: 2,
      name: Blocks.GRASS_BLOCK,
      hardness: 0.6,
      tool: ToolKind.SHOVEL,
      textures: { up: 'grass_top', down: 'dirt', side: 'grass_side' },
      tint: TintKind.GRASS,
      // 只染顶面：侧面贴图下半是泥土，整块染色会把泥土也染绿
      tintFaces: 1 << Facing.UP,
      soundGroup: SoundGroup.GRASS,
      randomTick: true,
    }),
  );
  r.register(
    defineBlock({ id: 3, name: Blocks.DIRT, hardness: 0.5, tool: ToolKind.SHOVEL, textures: 'dirt', soundGroup: SoundGroup.GRASS }),
  );
  r.register(stoneLike(4, Blocks.COBBLESTONE, 2, 'cobblestone', ToolTier.WOOD));
  r.register(
    defineBlock({ id: 5, name: Blocks.PLANKS, hardness: 2, tool: ToolKind.AXE, textures: 'planks', soundGroup: SoundGroup.WOOD, flammability: 20 }),
  );
  r.register(crossPlant(6, Blocks.SAPLING, 'sapling'));
  r.register(
    defineBlock({ id: 7, name: Blocks.BEDROCK, hardness: -1, blastResistance: 18000000, textures: 'bedrock' }),
  );
  r.register(
    defineBlock({ id: 12, name: Blocks.SAND, hardness: 0.5, tool: ToolKind.SHOVEL, textures: 'sand', soundGroup: SoundGroup.SAND }),
  );
  r.register(
    defineBlock({ id: 13, name: Blocks.GRAVEL, hardness: 0.6, tool: ToolKind.SHOVEL, textures: 'gravel', soundGroup: SoundGroup.GRAVEL }),
  );

  // --- 矿石。Y 带分布见 core/constants.ts 的 ORE_DISTRIBUTION ---
  r.register(stoneLike(14, Blocks.GOLD_ORE, 3, 'gold_ore', ToolTier.IRON));
  r.register(stoneLike(15, Blocks.IRON_ORE, 3, 'iron_ore', ToolTier.STONE));
  r.register(stoneLike(16, Blocks.COAL_ORE, 3, 'coal_ore', ToolTier.WOOD));
  r.register(stoneLike(21, Blocks.LAPIS_ORE, 3, 'lapis_ore', ToolTier.STONE));
  r.register(stoneLike(56, Blocks.DIAMOND_ORE, 3, 'diamond_ore', ToolTier.IRON));
  r.register(
    defineBlock({
      id: 73,
      name: Blocks.REDSTONE_ORE,
      hardness: 3,
      tool: ToolKind.PICKAXE,
      minTier: ToolTier.IRON,
      textures: 'redstone_ore',
      randomTick: true,
    }),
  );

  // --- 树木 ---
  r.register(
    defineBlock({
      id: 17,
      name: Blocks.LOG,
      hardness: 2,
      tool: ToolKind.AXE,
      textures: { up: 'log_top', down: 'log_top', side: 'log_side' },
      soundGroup: SoundGroup.WOOD,
      flammability: 5,
    }),
  );
  r.register(
    defineBlock({
      id: 18,
      name: Blocks.LEAVES,
      hardness: 0.2,
      tool: ToolKind.SHEARS,
      textures: 'leaves',
      renderLayer: RenderLayer.CUTOUT,
      tint: TintKind.FOLIAGE,
      opaque: false,
      opacity: 1,
      // 树叶之间**不**剔除共面：剔了会看穿树冠出现空洞。玻璃则相反。
      cullSameType: false,
      soundGroup: SoundGroup.GRASS,
      randomTick: true,
      flammability: 30,
    }),
  );

  // --- 建筑 ---
  r.register(
    defineBlock({
      id: 20,
      name: Blocks.GLASS,
      hardness: 0.3,
      textures: 'glass',
      renderLayer: RenderLayer.CUTOUT,
      opaque: false,
      opacity: 0,
      // 玻璃之间剔除共面，否则一堵玻璃墙内部全是看不见但要画的面
      cullSameType: true,
      soundGroup: SoundGroup.GLASS,
    }),
  );
  r.register(stoneLike(22, Blocks.LAPIS_BLOCK, 3, 'lapis_block', ToolTier.STONE));
  r.register(stoneLike(24, Blocks.SANDSTONE, 0.8, 'sandstone', ToolTier.WOOD));
  r.register(
    defineBlock({ id: 35, name: Blocks.WOOL, hardness: 0.8, tool: ToolKind.SHEARS, textures: 'wool', soundGroup: SoundGroup.CLOTH, flammability: 30 }),
  );
  r.register(stoneLike(41, Blocks.GOLD_BLOCK, 3, 'gold_block', ToolTier.IRON));
  r.register(stoneLike(42, Blocks.IRON_BLOCK, 5, 'iron_block', ToolTier.STONE));
  r.register(stoneLike(45, Blocks.BRICKS, 2, 'bricks', ToolTier.WOOD));
  r.register(
    defineBlock({ id: 47, name: Blocks.BOOKSHELF, hardness: 1.5, tool: ToolKind.AXE, textures: { up: 'planks', down: 'planks', side: 'bookshelf' }, soundGroup: SoundGroup.WOOD, flammability: 30 }),
  );
  r.register(stoneLike(48, Blocks.MOSSY_COBBLESTONE, 2, 'mossy_cobblestone', ToolTier.WOOD));
  r.register(
    defineBlock({ id: 49, name: Blocks.OBSIDIAN, hardness: 50, tool: ToolKind.PICKAXE, minTier: ToolTier.DIAMOND, blastResistance: 6000, textures: 'obsidian' }),
  );
  r.register(stoneLike(57, Blocks.DIAMOND_BLOCK, 5, 'diamond_block', ToolTier.IRON));
  r.register(
    defineBlock({ id: 58, name: Blocks.CRAFTING_TABLE, hardness: 2.5, tool: ToolKind.AXE, textures: { up: 'crafting_table_top', down: 'planks', side: 'crafting_table_side' }, soundGroup: SoundGroup.WOOD, flammability: 20 }),
  );
  r.register(
    defineBlock({ id: 61, name: Blocks.FURNACE, hardness: 3.5, tool: ToolKind.PICKAXE, textures: { up: 'furnace_top', down: 'furnace_top', north: 'furnace_front', side: 'furnace_side' }, hasBlockEntity: true }),
  );
  r.register(stoneLike(98, Blocks.STONE_BRICKS, 1.5, 'stone_bricks', ToolTier.WOOD));

  // --- 其它自然方块 ---
  r.register(
    defineBlock({ id: 79, name: Blocks.ICE, hardness: 0.5, slipperiness: FRICTION_ICE, tool: ToolKind.PICKAXE, textures: 'ice', renderLayer: RenderLayer.TRANSLUCENT, opaque: false, opacity: 3, cullSameType: true, soundGroup: SoundGroup.GLASS, randomTick: true }),
  );
  r.register(
    defineBlock({ id: 80, name: Blocks.SNOW_BLOCK, hardness: 0.2, tool: ToolKind.SHOVEL, textures: 'snow', soundGroup: SoundGroup.SNOW }),
  );
  r.register(
    defineBlock({ id: 82, name: Blocks.CLAY, hardness: 0.6, tool: ToolKind.SHOVEL, textures: 'clay', soundGroup: SoundGroup.GRAVEL }),
  );
  r.register(stoneLike(87, Blocks.NETHERRACK, 0.4, 'netherrack', ToolTier.WOOD));
  r.register(
    defineBlock({ id: 88, name: Blocks.SOUL_SAND, hardness: 0.5, tool: ToolKind.SHOVEL, textures: 'soul_sand', soundGroup: SoundGroup.SAND }),
  );
  r.register(
    defineBlock({ id: 89, name: Blocks.GLOWSTONE, hardness: 0.3, textures: 'glowstone', lightEmission: 15, soundGroup: SoundGroup.GLASS }),
  );
  r.register(
    defineBlock({ id: 110, name: Blocks.MYCELIUM, hardness: 0.6, tool: ToolKind.SHOVEL, textures: { up: 'mycelium_top', down: 'dirt', side: 'mycelium_side' }, soundGroup: SoundGroup.GRASS, randomTick: true }),
  );
  r.register(stoneLike(121, Blocks.END_STONE, 3, 'end_stone', ToolTier.WOOD));

  // --- 植物 ---
  r.register(crossPlant(31, Blocks.TALL_GRASS, 'tall_grass', TintKind.GRASS));
  r.register(crossPlant(32, Blocks.DEAD_BUSH, 'dead_bush'));
  r.register(crossPlant(37, Blocks.DANDELION, 'dandelion'));
  r.register(crossPlant(38, Blocks.ROSE, 'rose'));
  r.register(crossPlant(39, Blocks.BROWN_MUSHROOM, 'brown_mushroom'));
  r.register(crossPlant(40, Blocks.RED_MUSHROOM, 'red_mushroom'));

  r.freeze();
  return r;
}
