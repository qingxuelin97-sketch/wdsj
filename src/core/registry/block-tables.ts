/**
 * 方块属性的扁平表。
 *
 * 这是"方块用数据驱动"和"跑得够快"能同时成立的原因：注册表冻结时把所有 BlockDef 的
 * 字段烘焙成按 id 索引的 typed array，此后 mesher、光照引擎、碰撞、射线、随机刻这些
 * 每秒跑几百万次的路径**只读这些数组**，一次对象属性访问都不做。
 *
 * 硬规矩见 docs/RULES.md 第 6 条：热循环里出现 `blockDef.xxx` 就是写错了。
 */
import type { BlockDef } from '../block/block-def.ts';
import { resolveTextures } from '../block/block-def.ts';
import { ModelKind, RenderLayer } from '../block/types.ts';

/** 方块 id 的上限，受方块状态 12 bit 的限制 */
export const MAX_BLOCK_ID = 4096;

export class BlockTables {
  /** 已注册的最大 id + 1 */
  readonly count: number;

  // --- 挖掘 ---
  readonly hardness: Float32Array;
  readonly tool: Int8Array; // -1 表示任意工具
  readonly minTier: Uint8Array;
  readonly blastResistance: Float32Array;

  // --- 物理与光学（mesher 与光照引擎的热路径） ---
  /** 1 = 完整遮挡光线 */
  readonly opaque: Uint8Array;
  /** 光照穿过时的衰减量 */
  readonly opacity: Uint8Array;
  readonly lightEmission: Uint8Array;
  /** 1 = 有碰撞体积 */
  readonly solid: Uint8Array;
  readonly replaceable: Uint8Array;
  readonly flammability: Uint8Array;

  // --- 渲染（mesher 热路径） ---
  readonly modelKind: Uint8Array;
  readonly renderLayer: Uint8Array;
  readonly tint: Uint8Array;
  /** 哪些面参与染色，按 Facing 位掩码 */
  readonly tintFaces: Uint8Array;
  /** 1 = 同类方块之间剔除共面（玻璃是 1，树叶是 0） */
  readonly cullSameType: Uint8Array;
  /**
   * 1 = 该方块会挡住背后的面。
   * 与 opaque 的区别：楼梯是 solid 且 opaque=false（不完全挡光），
   * 但它也不能用来剔除邻居的整个面。这一位专门给 mesher 用。
   */
  readonly fullCube: Uint8Array;

  // --- 其它 ---
  readonly soundGroup: Uint8Array;
  readonly randomTick: Uint8Array;
  readonly hasBlockEntity: Uint8Array;

  /** id -> 六面贴图名。client 据此建 id*6+face -> 纹理层号 的表 */
  readonly textureNames: (readonly string[])[];
  /** id -> 完整定义。**只在冷路径使用**（GUI、掉落物、钩子分发） */
  readonly defs: (BlockDef | null)[];

  constructor(defs: readonly (BlockDef | null)[]) {
    const n = defs.length;
    this.count = n;
    this.hardness = new Float32Array(n);
    this.tool = new Int8Array(n).fill(-1);
    this.minTier = new Uint8Array(n);
    this.blastResistance = new Float32Array(n);
    this.opaque = new Uint8Array(n);
    this.opacity = new Uint8Array(n);
    this.lightEmission = new Uint8Array(n);
    this.solid = new Uint8Array(n);
    this.replaceable = new Uint8Array(n);
    this.flammability = new Uint8Array(n);
    this.modelKind = new Uint8Array(n);
    this.renderLayer = new Uint8Array(n);
    this.tint = new Uint8Array(n);
    this.tintFaces = new Uint8Array(n).fill(0b111111);
    this.cullSameType = new Uint8Array(n);
    this.fullCube = new Uint8Array(n);
    this.soundGroup = new Uint8Array(n);
    this.randomTick = new Uint8Array(n);
    this.hasBlockEntity = new Uint8Array(n);
    this.textureNames = new Array<readonly string[]>(n).fill([]);
    this.defs = new Array<BlockDef | null>(n).fill(null);

    for (let id = 0; id < n; id++) {
      const d = defs[id];
      if (d == null) continue;
      this.defs[id] = d;
      this.hardness[id] = d.hardness;
      this.tool[id] = d.tool ?? -1;
      this.minTier[id] = d.minTier;
      this.blastResistance[id] = d.blastResistance;
      this.opaque[id] = d.opaque ? 1 : 0;
      this.opacity[id] = d.opacity;
      this.lightEmission[id] = d.lightEmission;
      this.solid[id] = d.solid ? 1 : 0;
      this.replaceable[id] = d.replaceable ? 1 : 0;
      this.flammability[id] = d.flammability;
      this.modelKind[id] = d.modelKind;
      this.renderLayer[id] = d.renderLayer;
      this.tint[id] = d.tint;
      this.tintFaces[id] = d.tintFaces ?? 0b111111;
      this.cullSameType[id] = d.cullSameType === true ? 1 : 0;
      // 只有"不透明的完整立方体"才能挡住邻居的面
      this.fullCube[id] = d.modelKind === ModelKind.CUBE && d.opaque ? 1 : 0;
      this.soundGroup[id] = d.soundGroup;
      this.randomTick[id] = d.randomTick === true ? 1 : 0;
      this.hasBlockEntity[id] = d.hasBlockEntity === true ? 1 : 0;
      this.textureNames[id] = resolveTextures(d.textures);
    }
    // 空气：不渲染、不挡光、无碰撞、可替换
    this.modelKind[0] = ModelKind.NONE;
    this.opaque[0] = 0;
    this.opacity[0] = 0;
    this.solid[0] = 0;
    this.replaceable[0] = 1;
    this.fullCube[0] = 0;
    this.renderLayer[0] = RenderLayer.OPAQUE;
  }

  /** 全部贴图名的去重列表，供图集生成使用 */
  collectTextureNames(): string[] {
    const set = new Set<string>();
    for (const names of this.textureNames) {
      for (const name of names) if (name !== '') set.add(name);
    }
    return [...set].sort();
  }
}
