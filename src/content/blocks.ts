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
import {
  element, slabModel, stairsModel, fenceModel, torchModel, paneModel,
  layerModel, cakeModel, doorModel, bedModel, railModel,
  type ModelElement,
} from '../core/block/block-model.ts';
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

  // --- M7 的非立方体方块 ---
  STONE_SLAB: 'stone_slab',
  DOUBLE_STONE_SLAB: 'double_stone_slab',
  OAK_STAIRS: 'oak_stairs',
  COBBLESTONE_STAIRS: 'cobblestone_stairs',
  FENCE: 'fence',
  TORCH: 'torch',
  LADDER: 'ladder',
  GLASS_PANE: 'glass_pane',
  SNOW_LAYER: 'snow_layer',
  CAKE: 'cake',
  WOODEN_DOOR: 'wooden_door',
  TRAPDOOR: 'trapdoor',
  BED: 'bed',
  RAIL: 'rail',
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

/** 楼梯朝向：元数据低 2 位。顺序与 MC 一致 */
const STAIR_FACING: readonly Facing[] = [Facing.EAST, Facing.WEST, Facing.SOUTH, Facing.NORTH];
/** 贴墙火把的朝向：元数据 1..4 */
const TORCH_WALL: readonly Facing[] = [Facing.EAST, Facing.WEST, Facing.SOUTH, Facing.NORTH];
/** 梯子贴在哪一面 */
const LADDER_FACING: readonly Facing[] = [Facing.NORTH, Facing.SOUTH, Facing.WEST, Facing.EAST];
/** 门贴在哪一面 */
const DOOR_FACING: readonly Facing[] = [Facing.EAST, Facing.SOUTH, Facing.WEST, Facing.NORTH];

/** 梯子：贴在某一面的一层薄片，只画朝屋里的那一面 */
function ladderElement(facing: Facing): ModelElement {
  const t = 2;
  switch (facing) {
    case Facing.NORTH: return element([0, 0, 0], [16, 16, t], [-1, -1, -1, 3, -1, -1], false);
    case Facing.SOUTH: return element([0, 0, 16 - t], [16, 16, 16], [-1, -1, 2, -1, -1, -1], false);
    case Facing.WEST: return element([0, 0, 0], [t, 16, 16], [-1, -1, -1, -1, -1, 5], false);
    default: return element([16 - t, 0, 0], [16, 16, 16], [-1, -1, -1, -1, 4, -1], false);
  }
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

  // ---------------------------------------------------------------------
  // 非立方体方块（M7）
  //
  // 这一批全部靠 modelFor：形状由元数据算出来，碰撞盒由模型推导，
  // mesher 一行分支都不用加。加一种新形状 = 写一个返回 BlockModel 的函数。
  // ---------------------------------------------------------------------

  // 半砖：元数据最低位是"上半砖还是下半砖"
  r.register(defineBlock({
    id: 44, name: Blocks.STONE_SLAB, hardness: 2, tool: ToolKind.PICKAXE, minTier: ToolTier.WOOD,
    textures: { up: 'stone_slab_top', down: 'stone_slab_top', side: 'stone_slab_side' },
    opaque: false, soundGroup: SoundGroup.STONE,
    modelFor: (meta) => slabModel((meta & 1) === 0),
  }));
  r.register(defineBlock({
    id: 43, name: Blocks.DOUBLE_STONE_SLAB, hardness: 2, tool: ToolKind.PICKAXE, minTier: ToolTier.WOOD,
    textures: { up: 'stone_slab_top', down: 'stone_slab_top', side: 'stone_slab_side' },
    soundGroup: SoundGroup.STONE,
  }));

  // 楼梯：低 2 位是朝向，第 3 位是上下颠倒
  const stairs = (id: number, name: string, tex: string, sound: SoundGroup, tool: ToolKind): BlockDef =>
    defineBlock({
      id, name, hardness: 2, tool, minTier: ToolTier.WOOD,
      textures: tex, opaque: false, soundGroup: sound,
      modelFor: (meta) => stairsModel(STAIR_FACING[meta & 3]!, (meta & 4) !== 0),
    });
  r.register(stairs(53, Blocks.OAK_STAIRS, 'planks', SoundGroup.WOOD, ToolKind.AXE));
  r.register(stairs(67, Blocks.COBBLESTONE_STAIRS, 'cobblestone', SoundGroup.STONE, ToolKind.PICKAXE));

  // 栅栏：元数据低 4 位是 N/S/W/E 四个方向的连接
  r.register(defineBlock({
    id: 85, name: Blocks.FENCE, hardness: 2, tool: ToolKind.AXE,
    textures: 'planks', opaque: false, soundGroup: SoundGroup.WOOD, flammability: 20,
    modelFor: (meta) => fenceModel([(meta & 1) !== 0, (meta & 2) !== 0, (meta & 4) !== 0, (meta & 8) !== 0]),
  }));

  // 火把：元数据 0 = 立地，1..4 = 贴在某一侧的墙上
  r.register(defineBlock({
    id: 50, name: Blocks.TORCH, hardness: 0, textures: 'torch',
    renderLayer: RenderLayer.CUTOUT, opaque: false, solid: false, lightEmission: 14,
    soundGroup: SoundGroup.WOOD, collisionShape: NO_COLLISION,
    modelFor: (meta) => torchModel(meta === 0 ? null : TORCH_WALL[(meta - 1) & 3]!),
  }));

  r.register(defineBlock({
    id: 65, name: Blocks.LADDER, hardness: 0.4, tool: ToolKind.AXE,
    textures: 'ladder', renderLayer: RenderLayer.CUTOUT, opaque: false, solid: false,
    soundGroup: SoundGroup.LADDER, collisionShape: NO_COLLISION,
    modelFor: (meta) => ({ elements: [ladderElement(LADDER_FACING[meta & 3]!)] }),
  }));

  r.register(defineBlock({
    id: 102, name: Blocks.GLASS_PANE, hardness: 0.3,
    textures: 'glass', renderLayer: RenderLayer.CUTOUT, opaque: false,
    soundGroup: SoundGroup.GLASS,
    modelFor: (meta) => paneModel([(meta & 1) !== 0, (meta & 2) !== 0, (meta & 4) !== 0, (meta & 8) !== 0]),
  }));

  // 雪层：元数据是层数 0..7，每层 2/16 格高
  r.register(defineBlock({
    id: 78, name: Blocks.SNOW_LAYER, hardness: 0.1, tool: ToolKind.SHOVEL,
    textures: 'snow', opaque: false, soundGroup: SoundGroup.SNOW, replaceable: true,
    modelFor: (meta) => layerModel(((meta & 7) + 1) * 2),
  }));

  r.register(defineBlock({
    id: 92, name: Blocks.CAKE, hardness: 0.5,
    textures: { up: 'cake_top', down: 'cake_bottom', side: 'cake_side' },
    opaque: false, soundGroup: SoundGroup.CLOTH,
    modelFor: (meta) => cakeModel(meta & 7),
  }));

  // 门：低 2 位朝向，第 3 位开合
  r.register(defineBlock({
    id: 64, name: Blocks.WOODEN_DOOR, hardness: 3, tool: ToolKind.AXE,
    textures: 'door_lower', renderLayer: RenderLayer.CUTOUT, opaque: false,
    soundGroup: SoundGroup.WOOD,
    modelFor: (meta) => doorModel(DOOR_FACING[meta & 3]!, (meta & 4) !== 0),
  }));

  r.register(defineBlock({
    id: 96, name: Blocks.TRAPDOOR, hardness: 3, tool: ToolKind.AXE,
    textures: 'trapdoor', renderLayer: RenderLayer.CUTOUT, opaque: false,
    soundGroup: SoundGroup.WOOD,
    // 关着是贴地的一片，开着是贴墙的一片
    modelFor: (meta) => ((meta & 4) === 0
      ? layerModel(3)
      : doorModel(DOOR_FACING[meta & 3]!, false)),
  }));

  r.register(defineBlock({
    id: 26, name: Blocks.BED, hardness: 0.2,
    textures: { up: 'bed_top', down: 'planks', side: 'bed_side' },
    opaque: false, soundGroup: SoundGroup.CLOTH,
    modelFor: () => bedModel(),
  }));

  r.register(defineBlock({
    id: 66, name: Blocks.RAIL, hardness: 0.7, tool: ToolKind.PICKAXE,
    textures: 'rail', renderLayer: RenderLayer.CUTOUT, opaque: false, solid: false,
    soundGroup: SoundGroup.METAL, collisionShape: NO_COLLISION,
    modelFor: () => railModel(),
  }));

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
