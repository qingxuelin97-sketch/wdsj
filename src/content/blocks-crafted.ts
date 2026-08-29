/**
 * 需要合成才能得到的方块，以及所有非立方体形状。
 *
 * 从 blocks.ts 里分出来的：那个文件顶到了 600 行的硬上限。
 * 分界线是"自然生成 / 玩家造出来"，正好也和 M7（形状）+ M8（合成产物）
 * 这两批新增对上。
 */
import { defineBlock } from '../core/block/block-def.ts';
import type { BlockDef } from '../core/block/block-def.ts';
import type { BlockRegistry } from '../core/registry/block-registry.ts';
import { RenderLayer, TintKind, SoundGroup, ToolKind, ToolTier, Facing } from '../core/block/types.ts';
import {
  element, slabModel, stairsModel, fenceModel, torchModel, paneModel,
  layerModel, cakeModel, doorModel, bedModel, railModel,
  type ModelElement,
} from '../core/block/block-model.ts';
import { NO_COLLISION } from '../core/math/aabb.ts';
import { Blocks, stoneLike, crossPlant } from './blocks.ts';

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

/** 压力板：贴地的一张薄片，没有碰撞体积 */
function pressurePlate(id: number, name: string, tex: string, sound: SoundGroup, tool: ToolKind): BlockDef {
  return defineBlock({
    id, name, hardness: 0.5, tool, textures: tex, opaque: false, solid: false,
    soundGroup: sound, collisionShape: NO_COLLISION,
    modelFor: () => ({ elements: [element([1, 0, 1], [15, 1, 15])] }),
  });
}

/** 楼梯：低 2 位是朝向，第 3 位是上下颠倒 */
function stairs(id: number, name: string, tex: string, sound: SoundGroup, tool: ToolKind): BlockDef {
  return defineBlock({
    id, name, hardness: 2, tool, minTier: ToolTier.WOOD,
    textures: tex, opaque: false, soundGroup: sound,
    modelFor: (meta) => stairsModel(STAIR_FACING[meta & 3]!, (meta & 4) !== 0),
  });
}

/** 把这一批全部注册进去 */
export function registerCraftedBlocks(r: BlockRegistry): void {
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

  // ---------------------------------------------------------------------
  // M8 批：合成产物、容器，以及后续里程碑要用到的方块
  //
  // 先把方块登记进来，行为（红石信号、酿造、附魔）分别在 M13/M15 接。
  // 现在形状与掉落是对的 —— 这已经足够让一百多条合成配方成立，
  // 而配方表是 M8 的验收本体。
  // ---------------------------------------------------------------------
  r.register(defineBlock({
    id: 54, name: Blocks.CHEST, hardness: 2.5, tool: ToolKind.AXE,
    textures: { up: 'chest_top', down: 'chest_top', north: 'chest_front', side: 'chest_side' },
    opaque: false, soundGroup: SoundGroup.WOOD, hasBlockEntity: true, flammability: 20,
  }));
  r.register(defineBlock({
    id: 46, name: Blocks.TNT, hardness: 0,
    textures: { up: 'tnt_top', down: 'tnt_bottom', side: 'tnt_side' }, soundGroup: SoundGroup.GRASS,
  }));
  r.register(defineBlock({
    id: 84, name: Blocks.JUKEBOX, hardness: 2, tool: ToolKind.AXE,
    textures: { up: 'jukebox_top', down: 'jukebox_side', side: 'jukebox_side' },
    soundGroup: SoundGroup.WOOD, hasBlockEntity: true,
  }));
  r.register(defineBlock({
    id: 25, name: Blocks.NOTE_BLOCK, hardness: 0.8, tool: ToolKind.AXE,
    textures: 'note_block', soundGroup: SoundGroup.WOOD, hasBlockEntity: true,
  }));
  r.register(defineBlock({
    id: 23, name: Blocks.DISPENSER, hardness: 3.5, tool: ToolKind.PICKAXE,
    textures: { up: 'furnace_top', down: 'furnace_top', north: 'dispenser_front', side: 'furnace_side' },
    hasBlockEntity: true,
  }));
  r.register(defineBlock({
    id: 69, name: Blocks.LEVER, hardness: 0.5, textures: 'lever',
    renderLayer: RenderLayer.CUTOUT, opaque: false, solid: false, collisionShape: NO_COLLISION,
    soundGroup: SoundGroup.WOOD,
    modelFor: () => ({ elements: [element([6, 0, 6], [10, 10, 10], [0, 1, 2, 3, 4, 5], false)] }),
  }));
  r.register(pressurePlate(70, Blocks.STONE_PRESSURE_PLATE, 'stone', SoundGroup.STONE, ToolKind.PICKAXE));
  r.register(pressurePlate(72, Blocks.WOODEN_PRESSURE_PLATE, 'planks', SoundGroup.WOOD, ToolKind.AXE));
  r.register(defineBlock({
    id: 77, name: Blocks.STONE_BUTTON, hardness: 0.5, tool: ToolKind.PICKAXE, textures: 'stone',
    opaque: false, solid: false, soundGroup: SoundGroup.STONE, collisionShape: NO_COLLISION,
    modelFor: () => ({ elements: [element([5, 6, 0], [11, 10, 2])] }),
  }));
  r.register(defineBlock({
    id: 76, name: Blocks.REDSTONE_TORCH, hardness: 0, textures: 'redstone_torch',
    renderLayer: RenderLayer.CUTOUT, opaque: false, solid: false, lightEmission: 7,
    soundGroup: SoundGroup.WOOD, collisionShape: NO_COLLISION,
    modelFor: (meta) => torchModel(meta === 0 ? null : TORCH_WALL[(meta - 1) & 3]!),
  }));
  r.register(defineBlock({
    id: 93, name: Blocks.REPEATER_BLOCK, hardness: 0, textures: 'repeater_block',
    renderLayer: RenderLayer.CUTOUT, opaque: false, solid: false, soundGroup: SoundGroup.WOOD,
    collisionShape: NO_COLLISION,
    modelFor: () => ({ elements: [element([0, 0, 0], [16, 2, 16])] }),
  }));
  r.register(defineBlock({
    id: 63, name: Blocks.SIGN_POST, hardness: 1, tool: ToolKind.AXE, textures: 'planks',
    renderLayer: RenderLayer.CUTOUT, opaque: false, solid: false, soundGroup: SoundGroup.WOOD,
    hasBlockEntity: true, collisionShape: NO_COLLISION,
    modelFor: () => ({ elements: [
      element([7, 0, 7], [9, 9, 9], [0, 1, 2, 3, 4, 5], false),
      element([0, 9, 7], [16, 16, 9]),
    ] }),
  }));
  r.register(defineBlock({
    id: 71, name: Blocks.IRON_DOOR, hardness: 5, tool: ToolKind.PICKAXE, minTier: ToolTier.WOOD,
    textures: 'iron_door_block', renderLayer: RenderLayer.CUTOUT, opaque: false,
    soundGroup: SoundGroup.METAL,
    modelFor: (meta) => doorModel(DOOR_FACING[meta & 3]!, (meta & 4) !== 0),
  }));
  r.register(defineBlock({
    id: 101, name: Blocks.IRON_BARS, hardness: 5, tool: ToolKind.PICKAXE, minTier: ToolTier.WOOD,
    textures: 'iron_bars', renderLayer: RenderLayer.CUTOUT, opaque: false, soundGroup: SoundGroup.METAL,
    modelFor: (meta) => paneModel([(meta & 1) !== 0, (meta & 2) !== 0, (meta & 4) !== 0, (meta & 8) !== 0]),
  }));
  r.register(defineBlock({
    id: 103, name: Blocks.MELON, hardness: 1, tool: ToolKind.AXE,
    textures: { up: 'melon_top', down: 'melon_top', side: 'melon_side' }, soundGroup: SoundGroup.WOOD,
  }));
  r.register(defineBlock({
    id: 86, name: Blocks.PUMPKIN, hardness: 1, tool: ToolKind.AXE,
    textures: { up: 'pumpkin_top', down: 'pumpkin_top', north: 'pumpkin_face', side: 'pumpkin_side' },
    soundGroup: SoundGroup.WOOD,
  }));
  r.register(defineBlock({
    id: 91, name: Blocks.JACK_O_LANTERN, hardness: 1, tool: ToolKind.AXE, lightEmission: 15,
    textures: { up: 'pumpkin_top', down: 'pumpkin_top', north: 'jack_o_lantern_face', side: 'pumpkin_side' },
    soundGroup: SoundGroup.WOOD,
  }));
  r.register(defineBlock({
    id: 117, name: Blocks.BREWING_STAND, hardness: 0.5, tool: ToolKind.PICKAXE,
    textures: 'brewing_stand', renderLayer: RenderLayer.CUTOUT, opaque: false, solid: false,
    lightEmission: 1, hasBlockEntity: true, collisionShape: NO_COLLISION,
    modelFor: () => ({ elements: [
      element([7, 0, 7], [9, 14, 9], [0, 1, 2, 3, 4, 5], false),
      element([2, 0, 2], [14, 2, 14]),
    ] }),
  }));
  r.register(defineBlock({
    id: 118, name: Blocks.CAULDRON, hardness: 2, tool: ToolKind.PICKAXE, minTier: ToolTier.WOOD,
    textures: { up: 'cauldron_top', down: 'cauldron_bottom', side: 'cauldron_side' },
    opaque: false, soundGroup: SoundGroup.METAL,
    // 空心：一个底 + 四面壁。模型系统让"空心"和"实心"一样便宜
    modelFor: () => ({ elements: [
      element([0, 0, 0], [16, 3, 16]),
      element([0, 3, 0], [2, 16, 16]), element([14, 3, 0], [16, 16, 16]),
      element([2, 3, 0], [14, 16, 2]), element([2, 3, 14], [14, 16, 16]),
    ] }),
  }));
  r.register(defineBlock({
    id: 116, name: Blocks.ENCHANTING_TABLE, hardness: 5, tool: ToolKind.PICKAXE, minTier: ToolTier.WOOD,
    textures: { up: 'enchanting_table_top', down: 'obsidian', side: 'enchanting_table_side' },
    opaque: false, hasBlockEntity: true,
    modelFor: () => ({ elements: [element([0, 0, 0], [16, 12, 16])] }),
  }));
  r.register(defineBlock({
    id: 19, name: Blocks.SPONGE, hardness: 0.6, textures: 'sponge', soundGroup: SoundGroup.GRASS,
  }));
  r.register(stairs(108, Blocks.BRICK_STAIRS, 'bricks', SoundGroup.STONE, ToolKind.PICKAXE));
  r.register(stairs(109, Blocks.STONE_BRICK_STAIRS, 'stone_bricks', SoundGroup.STONE, ToolKind.PICKAXE));
  r.register(defineBlock({
    id: 107, name: Blocks.FENCE_GATE, hardness: 2, tool: ToolKind.AXE, textures: 'planks',
    opaque: false, soundGroup: SoundGroup.WOOD, flammability: 20,
    modelFor: (meta) => ((meta & 4) !== 0
      ? { elements: [element([0, 5, 7], [2, 16, 9]), element([14, 5, 7], [16, 16, 9])] }
      : { elements: [element([0, 5, 7], [16, 16, 9])] }),
  }));
  r.register(stoneLike(112, Blocks.NETHER_BRICK, 2, 'nether_brick', ToolTier.WOOD));
  r.register(defineBlock({
    id: 81, name: Blocks.CACTUS, hardness: 0.4,
    textures: { up: 'cactus_top', down: 'cactus_top', side: 'cactus_side' },
    opaque: false, soundGroup: SoundGroup.CLOTH, randomTick: true,
    modelFor: () => ({ elements: [element([1, 0, 1], [15, 16, 15])] }),
  }));
  r.register(crossPlant(83, Blocks.SUGAR_CANE_BLOCK, 'sugar_cane_block'));
  r.register(defineBlock({
    id: 111, name: Blocks.LILY_PAD, hardness: 0, textures: 'lily_pad',
    renderLayer: RenderLayer.CUTOUT, opaque: false, solid: false, tint: TintKind.FOLIAGE,
    collisionShape: NO_COLLISION,
    modelFor: () => ({ elements: [element([0, 0, 0], [16, 1, 16], [-1, 1, -1, -1, -1, -1], false)] }),
  }));
  r.register(defineBlock({
    id: 106, name: Blocks.VINES, hardness: 0.2, textures: 'vines',
    renderLayer: RenderLayer.CUTOUT, opaque: false, solid: false, tint: TintKind.FOLIAGE,
    collisionShape: NO_COLLISION,
    modelFor: () => ({ elements: [element([0, 0, 0], [16, 16, 1], [-1, -1, -1, 3, -1, -1], false)] }),
  }));
  r.register(defineBlock({
    id: 60, name: Blocks.FARMLAND, hardness: 0.6, tool: ToolKind.SHOVEL,
    textures: { up: 'farmland', down: 'dirt', side: 'dirt' },
    opaque: false, soundGroup: SoundGroup.GRASS, randomTick: true,
    modelFor: () => ({ elements: [element([0, 0, 0], [16, 15, 16])] }),
  }));
  r.register(crossPlant(59, Blocks.WHEAT_CROP, 'wheat_crop'));
  r.register(defineBlock({
    id: 62, name: Blocks.LIT_FURNACE, hardness: 3.5, tool: ToolKind.PICKAXE, lightEmission: 13,
    textures: { up: 'furnace_top', down: 'furnace_top', north: 'furnace_front_lit', side: 'furnace_side' },
    hasBlockEntity: true,
  }));
  r.register(crossPlant(115, Blocks.NETHER_WART_BLOCK, 'nether_wart_block'));
}
