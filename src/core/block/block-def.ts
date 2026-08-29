/**
 * 方块定义。
 *
 * 方块是**数据记录**，不是 120 个子类。1.0 的约 110 种方块里只有二十几种需要真行为
 * （熔炉、箱子、门、床、流体、红石、活塞、作物…），其余全是纯数据。这是本项目防屎山的
 * 第一件装置。
 *
 * 性能上的关键约定：**热循环不读 BlockDef 对象**。注册表冻结时会把这些字段烘焙成
 * `core/registry/block-tables.ts` 里的扁平 typed array，mesher / 光照 / 碰撞 / 射线
 * 只读那些数组。见 docs/RULES.md 第 6 条。
 */
import { ToolKind } from './types.ts';
import type { ToolTier, RenderLayer, TintKind, SoundGroup, ModelKind } from './types.ts';
import type { BlockHooks } from './block-hooks.ts';
import type { Aabb } from '../math/aabb.ts';
import type { BlockModel } from './block-model.ts';
import { FRICTION_DEFAULT } from '../constants.ts';

/** 方块的六面贴图。给出单个名字表示六面相同 */
export type BlockTextures =
  | string
  | {
      readonly down?: string;
      readonly up?: string;
      readonly north?: string;
      readonly south?: string;
      readonly west?: string;
      readonly east?: string;
      /** 未单独指定的面用它兜底 */
      readonly all?: string;
      /** side 同时指定东南西北四面 */
      readonly side?: string;
    };

/** CUSTOM 模型的一个盒子 */
export interface ModelElement {
  /** 起止坐标，单位是 1/16 格，范围 0..16 */
  readonly from: readonly [number, number, number];
  readonly to: readonly [number, number, number];
  /** 每个面的贴图名；缺省的面不生成几何 */
  readonly faces: Partial<Record<'down' | 'up' | 'north' | 'south' | 'west' | 'east', string>>;
  /**
   * 该面贴着哪个方向的邻居 —— 邻居不透明时这个面会被剔除。
   * 只有真正贴合方块边界的面才该填，否则会被错误剔除。
   */
  readonly cullface?: Partial<Record<'down' | 'up' | 'north' | 'south' | 'west' | 'east', boolean>>;
  /** 是否参与环境光遮蔽 */
  readonly shade?: boolean;
}

export interface BlockDef {
  /** 方块 id，0..4095。0 恒为空气 */
  readonly id: number;
  /** 稳定的字符串名，存档与配方表按它引用，改了会破坏旧存档 */
  readonly name: string;

  // --- 挖掘 ---
  /** 硬度。-1 表示不可破坏（基岩、末地传送门框架） */
  readonly hardness: number;
  /**
   * 表面滑度。普通方块 0.6，冰 0.98。
   *
   * 它同时决定加速度和减速度（见 core/physics/entity-physics.ts），
   * 所以"冰上加速慢、停得也慢"是一个数推出来的，不是两处分别调的。
   */
  readonly slipperiness: number;
  /** 对口工具。null 表示任意工具都算对口 */
  readonly tool: ToolKind | null;
  /** 掉落所需的最低工具等级 */
  readonly minTier: ToolTier;
  /**
   * 收获是否**必须**有对口工具。
   *
   * 和 minTier 是两件事：minTier=WOOD 是 0，而 ToolTier 里没有"无"这一档，
   * 所以光靠 minTier 表达不出"徒手就能挖到"。MC 里这是按材质定的
   * （岩石/金属要工具，泥土/木头/羊毛不要），这里默认按"是否用镐"推导，
   * 正好覆盖 1.0 的全部方块；个别方块可以显式覆盖。
   */
  readonly requiresTool: boolean;
  /** 爆炸抗性 */
  readonly blastResistance: number;

  // --- 物理与光学 ---
  /** 是否有碰撞体积 */
  readonly solid: boolean;
  /** 是否完整遮挡光线。玻璃是 false，石头是 true */
  readonly opaque: boolean;
  /** 光照衰减量。不透明方块用 15，水用 3，树叶用 1 */
  readonly opacity: number;
  /** 自身发光强度 0..15 */
  readonly lightEmission: number;
  /** 放置时能否直接替换掉（草、雪层、流体） */
  readonly replaceable: boolean;
  /** 可燃度，0 表示不可燃 */
  readonly flammability: number;

  // --- 渲染 ---
  readonly modelKind: ModelKind;
  /**
   * 按元数据给出模型。不提供时按 modelKind 取默认（整格 / 十字 / 不渲染）。
   *
   * 楼梯的朝向、栅栏的连接、门的开合都在元数据里，所以模型是**按状态**定的，
   * 而不是按方块。冻结时会把 16 个元数据各烘一份并去重。
   */
  readonly modelFor?: (meta: number) => BlockModel;
  readonly textures: BlockTextures;
  readonly renderLayer: RenderLayer;
  readonly tint: TintKind;
  /**
   * 哪些面参与群系染色，按 Facing 位掩码。缺省 0b111111 表示六面全染。
   *
   * 草方块必须设成"只有顶面"：它的侧面贴图下半是泥土，整块染绿会让泥土也变绿。
   * MC 的做法是侧面用一张单独的、不染色的彩色贴图，效果等同于这里的按面掩码。
   */
  readonly tintFaces?: number;
  /** CUSTOM 模型的盒子列表 */
  readonly elements?: readonly ModelElement[];
  /**
   * 同类方块之间是否剔除共面。
   * 玻璃对玻璃要剔除（不然一堵玻璃墙内部全是面），树叶对树叶不剔除（会看出空洞）。
   */
  readonly cullSameType?: boolean;

  // --- 其它 ---
  readonly soundGroup: SoundGroup;
  /** 碰撞盒。缺省为整格。空数组表示无碰撞 */
  readonly collisionShape?: readonly Aabb[];
  /** 选中框，缺省与碰撞盒相同 */
  readonly outlineShape?: readonly Aabb[];
  /** 是否有方块实体（箱子、熔炉、告示牌…） */
  readonly hasBlockEntity?: boolean;
  /** 是否接收随机刻（作物生长、草蔓延、树叶消失…） */
  readonly randomTick?: boolean;
  /** 行为钩子。绝大多数方块不需要 */
  readonly hooks?: BlockHooks;
}

/** 构造 BlockDef 时的可选字段默认值 */
export type BlockDefInput = Omit<
  BlockDef,
  'blastResistance' | 'solid' | 'opaque' | 'opacity' | 'lightEmission' | 'replaceable' | 'flammability' | 'renderLayer' | 'tint' | 'soundGroup' | 'modelKind' | 'minTier' | 'tool' | 'hardness' | 'slipperiness' | 'requiresTool'
> &
  Partial<BlockDef>;

/**
 * 补全默认值。
 * 默认是"一个普通的不透明立方体石质方块"，因为那是最常见的形状。
 */
export function defineBlock(input: BlockDefInput): BlockDef {
  const opaque = input.opaque ?? true;
  return {
    id: input.id,
    name: input.name,
    hardness: input.hardness ?? 1,
    slipperiness: input.slipperiness ?? FRICTION_DEFAULT,
    tool: input.tool ?? null,
    minTier: input.minTier ?? 0,
    requiresTool: input.requiresTool ?? input.tool === ToolKind.PICKAXE,
    blastResistance: input.blastResistance ?? (input.hardness ?? 1) * 5,
    solid: input.solid ?? true,
    opaque,
    opacity: input.opacity ?? (opaque ? 15 : 0),
    lightEmission: input.lightEmission ?? 0,
    replaceable: input.replaceable ?? false,
    flammability: input.flammability ?? 0,
    modelKind: input.modelKind ?? 1, // ModelKind.CUBE
    ...(input.modelFor !== undefined ? { modelFor: input.modelFor } : {}),
    textures: input.textures,
    renderLayer: input.renderLayer ?? 0, // RenderLayer.OPAQUE
    tint: input.tint ?? 0, // TintKind.NONE
    tintFaces: input.tintFaces ?? 0b111111,
    soundGroup: input.soundGroup ?? 0, // SoundGroup.STONE
    ...(input.elements !== undefined ? { elements: input.elements } : {}),
    ...(input.cullSameType !== undefined ? { cullSameType: input.cullSameType } : {}),
    ...(input.collisionShape !== undefined ? { collisionShape: input.collisionShape } : {}),
    ...(input.outlineShape !== undefined ? { outlineShape: input.outlineShape } : {}),
    ...(input.hasBlockEntity !== undefined ? { hasBlockEntity: input.hasBlockEntity } : {}),
    ...(input.randomTick !== undefined ? { randomTick: input.randomTick } : {}),
    ...(input.hooks !== undefined ? { hooks: input.hooks } : {}),
  };
}

/** 把 BlockTextures 展开成按 Facing 索引的六个贴图名 */
export function resolveTextures(t: BlockTextures): [string, string, string, string, string, string] {
  if (typeof t === 'string') return [t, t, t, t, t, t];
  const all = t.all ?? '';
  const side = t.side ?? all;
  return [
    t.down ?? all,
    t.up ?? all,
    t.north ?? side,
    t.south ?? side,
    t.west ?? side,
    t.east ?? side,
  ];
}
