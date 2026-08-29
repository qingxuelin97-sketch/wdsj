/**
 * 红石线与活塞。
 *
 * 其余的红石元件（拉杆、按钮、压力板、红石火把、中继器、发射器、音符盒、
 * 铁轨）在 M7 就作为**方块**注册好了 —— 它们有模型、有贴图、能放能挖，
 * 只是没有行为。M13 补的是行为，而这里补的是那两个连方块都还没有的。
 *
 * id 照抄 MC：红石线 55、活塞 33、粘性活塞 29、活塞头 34。
 *
 * 红石线的元数据是**信号强度 0..15**，而不是连接方向 —— 连接是每帧
 * 由邻居推出来的（见 client 的模型），存进元数据会多出一份要维护的冗余。
 * MC 自己也是这么做的。
 */
import { defineBlock } from '../core/block/block-def.ts';
import { ModelKind, RenderLayer, SoundGroup, ToolKind, TintKind, Facing } from '../core/block/types.ts';
import { element, layerModel, type ModelElement } from '../core/block/block-model.ts';
import type { BlockRegistry } from '../core/registry/block-registry.ts';

export const RedstoneBlocks = {
  REDSTONE_WIRE: 'redstone_wire',
  REDSTONE_TORCH_OFF: 'redstone_torch_off',
  REPEATER_ON: 'repeater_block_on',
  PISTON: 'piston',
  STICKY_PISTON: 'sticky_piston',
  PISTON_HEAD: 'piston_head',
} as const;

/** 红石线的最大信号强度。每传一格减 1，所以能传 15 格 */
export const REDSTONE_MAX_POWER = 15;

/** 活塞能推多少个方块 */
export const PISTON_PUSH_LIMIT = 12;

/**
 * 活塞的朝向存在元数据的低 3 位，第 4 位（8）表示"伸出来了"。
 * 与 MC 一致。
 */
export const PISTON_EXTENDED_BIT = 8;

export function pistonFacing(meta: number): Facing {
  return (meta & 7) as Facing;
}
export function pistonExtended(meta: number): boolean {
  return (meta & PISTON_EXTENDED_BIT) !== 0;
}

/** 活塞杆的模型：朝某个方向伸出去的一根方柱 + 顶上的面板 */
function pistonHeadModel(facing: Facing): ModelElement[] {
  // 面板 4 格厚，杆 4×4 见方
  const plate: Record<number, [number, number, number, number, number, number]> = {
    [Facing.DOWN]: [0, 0, 0, 16, 4, 16],
    [Facing.UP]: [0, 12, 0, 16, 4, 16],
    [Facing.NORTH]: [0, 0, 0, 16, 16, 4],
    [Facing.SOUTH]: [0, 0, 12, 16, 16, 4],
    [Facing.WEST]: [0, 0, 0, 4, 16, 16],
    [Facing.EAST]: [12, 0, 0, 4, 16, 16],
  };
  const rod: Record<number, [number, number, number, number, number, number]> = {
    [Facing.DOWN]: [6, 4, 6, 4, 12, 4],
    [Facing.UP]: [6, 0, 6, 4, 12, 4],
    [Facing.NORTH]: [6, 6, 4, 4, 4, 12],
    [Facing.SOUTH]: [6, 6, 0, 4, 4, 12],
    [Facing.WEST]: [4, 6, 6, 12, 4, 4],
    [Facing.EAST]: [0, 6, 6, 12, 4, 4],
  };
  const p = plate[facing] ?? plate[Facing.UP]!;
  const r = rod[facing] ?? rod[Facing.UP]!;
  return [
    element([p[0], p[1], p[2]], [p[0] + p[3], p[1] + p[4], p[2] + p[5]]),
    element([r[0], r[1], r[2]], [r[0] + r[3], r[1] + r[4], r[2] + r[5]]),
  ];
}

export function registerRedstoneBlocks(r: BlockRegistry): void {
  // --- 红石线 ---
  //
  // 平铺在地上的一层，厚度 1/16。没有碰撞体积（人从上面走过去），
  // 贴图是灰度的，由 TintKind.REDSTONE 按信号强度染色 ——
  // 这是"通电的线更亮"这个观感的来源，而它是红石调试的唯一视觉反馈
  r.register(defineBlock({
    id: 55,
    name: RedstoneBlocks.REDSTONE_WIRE,
    hardness: 0,
    solid: false,
    opaque: false,
    opacity: 0,
    modelKind: ModelKind.CUSTOM,
    modelFor: () => layerModel(1),
    textures: 'redstone_wire',
    renderLayer: RenderLayer.CUTOUT,
    tint: TintKind.REDSTONE,
    soundGroup: SoundGroup.STONE,
    collisionShape: [],
  }));

  // --- 活塞 ---
  const piston = (id: number, name: string, sticky: boolean): void => {
    r.register(defineBlock({
      id,
      name,
      hardness: 0.5,
      tool: ToolKind.PICKAXE,
      requiresTool: false,
      modelKind: ModelKind.CUSTOM,
      // 伸出来的时候本体只有 12/16 厚，剩下 4/16 是活塞头占的
      modelFor: (meta) => {
        if (!pistonExtended(meta)) return { elements: [element([0, 0, 0], [16, 16, 16])] };
        const f = pistonFacing(meta);
        const box: Record<number, [number, number, number, number, number, number]> = {
          [Facing.DOWN]: [0, 4, 0, 16, 12, 16],
          [Facing.UP]: [0, 0, 0, 16, 12, 16],
          [Facing.NORTH]: [0, 0, 4, 16, 16, 12],
          [Facing.SOUTH]: [0, 0, 0, 16, 16, 12],
          [Facing.WEST]: [4, 0, 0, 12, 16, 16],
          [Facing.EAST]: [0, 0, 0, 12, 16, 16],
        };
        const b = box[f] ?? box[Facing.UP]!;
        return { elements: [element([b[0], b[1], b[2]], [b[0] + b[3], b[1] + b[4], b[2] + b[5]])] };
      },
      textures: {
        up: sticky ? 'piston_top_sticky' : 'piston_top',
        down: 'piston_bottom',
        side: 'piston_side',
      },
      soundGroup: SoundGroup.STONE,
    }));
  };
  piston(33, RedstoneBlocks.PISTON, false);
  piston(29, RedstoneBlocks.STICKY_PISTON, true);

  // --- 熄灭的红石火把（75）与点亮的中继器（94） ---
  //
  // MC 用**两个 id** 表示同一个元件的开与关（火把 75/76、中继器 93/94）。
  // M7 只注册了"亮着的火把"和"熄灭的中继器"那一半，于是红石逻辑一
  // 切换状态就会写进一个没有定义的 id：方块存进去了，但它没有模型、
  // 没有贴图、查表全是默认值 —— 表现是火把一灭就变成一个看不见的怪东西。
  r.register(defineBlock({
    id: 75,
    name: RedstoneBlocks.REDSTONE_TORCH_OFF,
    hardness: 0,
    solid: false,
    opaque: false,
    opacity: 0,
    lightEmission: 0,
    modelKind: ModelKind.CUSTOM,
    modelFor: () => ({ elements: [element([7, 0, 7], [9, 10, 9])] }),
    textures: 'redstone_torch_off',
    renderLayer: RenderLayer.CUTOUT,
    soundGroup: SoundGroup.CLOTH,
    collisionShape: [],
  }));
  r.register(defineBlock({
    id: 94,
    name: RedstoneBlocks.REPEATER_ON,
    hardness: 0,
    solid: false,
    opaque: false,
    opacity: 0,
    lightEmission: 7,
    modelKind: ModelKind.CUSTOM,
    modelFor: () => layerModel(2),
    textures: 'repeater_block_on',
    renderLayer: RenderLayer.CUTOUT,
    soundGroup: SoundGroup.STONE,
    collisionShape: [],
  }));

  // --- 活塞头：伸出去的那一截。玩家挖不到它（挖了会连本体一起消失） ---
  r.register(defineBlock({
    id: 34,
    name: RedstoneBlocks.PISTON_HEAD,
    hardness: 0.5,
    tool: ToolKind.PICKAXE,
    requiresTool: false,
    modelKind: ModelKind.CUSTOM,
    modelFor: (meta) => ({ elements: pistonHeadModel(pistonFacing(meta)) }),
    textures: { up: 'piston_top', down: 'piston_top', side: 'piston_side' },
    soundGroup: SoundGroup.STONE,
  }));
}

export function isRedstoneWire(id: number): boolean {
  return id === 55;
}
export function isPiston(id: number): boolean {
  return id === 33 || id === 29;
}
export function isStickyPiston(id: number): boolean {
  return id === 29;
}
