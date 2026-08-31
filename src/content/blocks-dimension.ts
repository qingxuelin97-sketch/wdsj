/**
 * 下界与末地专有的方块。
 *
 * 单独一个文件，不是因为 blocks-crafted 满了（它 318 行还有余量），
 * 而是因为**这一批的共同点是"属于哪个维度"，不是"怎么得到"**。
 * 传送门方块和末地传送门框架谁也合成不出来，塞进"合成产物"里
 * 会让那个文件的分界线失效。
 *
 * 其中三个方块（下界传送门、末地传送门、龙蛋）在 MC 里都有
 * "碰到会发生事情"的行为，那些行为不在这里 —— 这里只有形状、
 * 材质与硬度。行为在 server/world/portal-manager.ts 与方块钩子里。
 */
import { defineBlock } from '../core/block/block-def.ts';
import type { BlockRegistry } from '../core/registry/block-registry.ts';
import { RenderLayer, SoundGroup, ToolKind, ToolTier } from '../core/block/types.ts';
import { element } from '../core/block/block-model.ts';
import { NO_COLLISION } from '../core/math/aabb.ts';
import { Blocks } from './blocks.ts';

export function registerDimensionBlocks(r: BlockRegistry): void {
  /**
   * 下界传送门。
   *
   * `hardness: -1` = 挖不动（和基岩一样）。MC 里门是能被打掉的，
   * 但打掉的方式是**破坏框架**或用水，不是对着紫色挖 ——
   * 给它一个正的硬度的话，玩家会站在门里一边被传送一边挖门。
   *
   * 自己发 11 级光：门在漆黑的下界里是唯一的路标，不亮的话
   * 走出去二十格就再也找不回来了。
   */
  r.register(defineBlock({
    id: 90, name: Blocks.NETHER_PORTAL, hardness: -1,
    textures: 'nether_portal',
    renderLayer: RenderLayer.TRANSLUCENT, opaque: false, solid: false,
    lightEmission: 11, collisionShape: NO_COLLISION,
    soundGroup: SoundGroup.GLASS,
    // 薄片。朝向由元数据低 1 位给：0 = 沿 X 展开，1 = 沿 Z
    modelFor: (meta) => ({
      elements: [(meta & 1) === 0
        ? element([0, 0, 6], [16, 16, 10], [-1, -1, 2, 3, -1, -1], false)
        : element([6, 0, 0], [10, 16, 16], [-1, -1, -1, -1, 4, 5], false)],
    }),
  }));

  /**
   * 末地传送门框架。上表面可以嵌一颗末影之眼（元数据第 3 位）。
   *
   * 挖不动：要塞里那十二块框架是激活末地的唯一途径，能挖的话
   * 玩家会把它们搬回家，而"搬回家"在 MC 里是做不到的。
   */
  r.register(defineBlock({
    id: 120, name: Blocks.END_PORTAL_FRAME, hardness: -1,
    textures: { up: 'end_portal_frame_top', down: 'end_stone', side: 'end_portal_frame_side' },
    opaque: false, lightEmission: 1, soundGroup: SoundGroup.STONE,
    modelFor: (meta) => ({
      elements: (meta & 4) !== 0
        // 嵌了眼：主体 13 格高，上面再顶一小块
        ? [element([0, 0, 0], [16, 13, 16]), element([4, 13, 4], [12, 16, 12])]
        : [element([0, 0, 0], [16, 13, 16])],
    }),
  }));

  /**
   * 末地传送门本体：一张贴在框架内的黑色平面，踩上去就走。
   *
   * 和下界门不同，它**没有厚度** —— MC 里它是一张 y=0.75 的平板，
   * 玩家是"落进去"而不是"走进去"。
   */
  r.register(defineBlock({
    id: 119, name: Blocks.END_PORTAL, hardness: -1,
    textures: 'end_portal',
    renderLayer: RenderLayer.TRANSLUCENT, opaque: false, solid: false,
    lightEmission: 15, collisionShape: NO_COLLISION, soundGroup: SoundGroup.GLASS,
    modelFor: () => ({ elements: [element([0, 0, 0], [16, 12, 16], [-1, 1, -1, -1, -1, -1], false)] }),
  }));

  /**
   * 龙蛋。杀龙之后落在出口传送门上，是通关的**唯一**纪念品。
   *
   * MC 里点它会瞬移走，这里同样接了钩子（见 block-hooks）。
   * 不接的话它就只是一个漂亮的方块，而那个恶作剧正是它的全部内容。
   */
  r.register(defineBlock({
    id: 122, name: Blocks.DRAGON_EGG, hardness: 3, tool: ToolKind.PICKAXE, minTier: ToolTier.WOOD,
    textures: 'dragon_egg', opaque: false, lightEmission: 1, soundGroup: SoundGroup.STONE,
    // 蛋形：底宽顶窄的四段
    modelFor: () => ({ elements: [
      element([1, 0, 1], [15, 1, 15]),
      element([2, 1, 2], [14, 8, 14]),
      element([3, 8, 3], [13, 13, 13]),
      element([5, 13, 5], [11, 15, 11]),
      element([6, 15, 6], [10, 16, 10]),
    ] }),
  }));

  /** 下界砖栅栏。要塞的走廊两侧全是它 */
  r.register(defineBlock({
    id: 113, name: Blocks.NETHER_BRICK_FENCE, hardness: 2, tool: ToolKind.PICKAXE, minTier: ToolTier.WOOD,
    textures: 'nether_brick', opaque: false, soundGroup: SoundGroup.STONE,
    modelFor: () => ({ elements: [
      element([6, 0, 6], [10, 16, 10]),
      element([0, 6, 7], [16, 9, 9]), element([7, 6, 0], [9, 9, 16]),
      element([0, 12, 7], [16, 15, 9]), element([7, 12, 0], [9, 15, 16]),
    ] }),
  }));

}
