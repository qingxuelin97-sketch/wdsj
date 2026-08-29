/**
 * 把方块模型烘焙成扁平 typed array。
 *
 * 和 block-tables 同一个道理：注册表里的模型是**对象**（好写好读），
 * 但 mesher 每秒要处理几百万格，绝不能在热循环里碰对象。
 * 冻结时烘一次，之后只读数组。
 *
 * 模型是**按状态**（方块 id + 4 位元数据）索引的：楼梯的朝向、
 * 栅栏的连接、门的开合都在元数据里。4096 × 16 = 65536 个槽，
 * 一个 Uint16 索引就是 128 KB —— 换来"取模型"退化成一次数组下标。
 *
 * 相同的模型会去重：绝大多数方块的 16 个元数据指向同一个整格立方体。
 */
import type { BlockModel } from '../block/block-model.ts';
import { isFullCube, modelCollisionBoxes } from '../block/block-model.ts';

/** 状态 = id * 16 + meta */
export const STATE_SLOTS = 4096 * 16;

export interface ModelTables {
  /** 状态 -> 模型索引。0 号模型固定是"空"（空气用） */
  readonly stateModel: Uint16Array;
  /** 模型索引 -> 元素区间 */
  readonly modelElementStart: Uint32Array;
  readonly modelElementCount: Uint8Array;
  /** 元素索引 * 6 -> from/to，单位 1/16 格 */
  readonly elementBox: Uint8Array;
  /** 元素索引 * 6 + face -> 贴图槽（0..5），−1 表示这一面不画 */
  readonly elementTexture: Int8Array;
  /** 元素索引 * 6 + face -> cullface 方向，−1 表示永不剔除 */
  readonly elementCullface: Int8Array;
  /** 元素索引 -> UV 是否按元素尺寸裁剪 */
  readonly elementClampUv: Uint8Array;
  /** 模型索引 -> 碰撞盒区间 */
  readonly modelBoxStart: Uint32Array;
  readonly modelBoxCount: Uint8Array;
  /** 碰撞盒索引 * 6 -> minX,minY,minZ,maxX,maxY,maxZ，单位格 */
  readonly collisionBoxes: Float32Array;
  /** 模型索引 -> 是否整格立方体 */
  readonly modelFullCube: Uint8Array;
  /** 已烘焙的模型数 */
  readonly modelCount: number;
}

/** 烘焙器：边收模型边去重 */
export class ModelBaker {
  private readonly stateModel = new Uint16Array(STATE_SLOTS);
  private readonly keyToIndex = new Map<string, number>();
  private readonly elementBox: number[] = [];
  private readonly elementTexture: number[] = [];
  private readonly elementCullface: number[] = [];
  private readonly elementClampUv: number[] = [];
  private readonly collision: number[] = [];
  private readonly starts: number[] = [];
  private readonly counts: number[] = [];
  private readonly boxStarts: number[] = [];
  private readonly boxCounts: number[] = [];
  private readonly fullCube: number[] = [];

  constructor() {
    // 0 号是空模型，空气与不渲染的方块都指向它
    this.starts.push(0);
    this.counts.push(0);
    this.boxStarts.push(0);
    this.boxCounts.push(0);
    this.fullCube.push(0);
    this.keyToIndex.set('', 0);
  }

  /** 登记某个状态用的模型，返回模型索引 */
  set(id: number, meta: number, model: BlockModel): number {
    const key = modelKey(model);
    let index = this.keyToIndex.get(key);
    if (index === undefined) {
      index = this.starts.length;
      this.keyToIndex.set(key, index);
      this.starts.push(this.elementClampUv.length);
      this.counts.push(model.elements.length);
      for (const e of model.elements) {
        this.elementBox.push(e.from[0], e.from[1], e.from[2], e.to[0], e.to[1], e.to[2]);
        for (let f = 0; f < 6; f++) {
          this.elementTexture.push(e.faceTexture[f] ?? -1);
          this.elementCullface.push(e.cullface[f] ?? -1);
        }
        this.elementClampUv.push(e.clampUv ? 1 : 0);
      }
      this.boxStarts.push(this.collision.length / 6);
      const boxes = modelCollisionBoxes(model);
      this.boxCounts.push(boxes.length);
      for (const b of boxes) this.collision.push(...b);
      this.fullCube.push(isFullCube(model) ? 1 : 0);
    }
    this.stateModel[id * 16 + meta] = index;
    return index;
  }

  finish(): ModelTables {
    return {
      stateModel: this.stateModel,
      modelElementStart: Uint32Array.from(this.starts),
      modelElementCount: Uint8Array.from(this.counts),
      elementBox: Uint8Array.from(this.elementBox),
      elementTexture: Int8Array.from(this.elementTexture),
      elementCullface: Int8Array.from(this.elementCullface),
      elementClampUv: Uint8Array.from(this.elementClampUv),
      modelBoxStart: Uint32Array.from(this.boxStarts),
      modelBoxCount: Uint8Array.from(this.boxCounts),
      collisionBoxes: Float32Array.from(this.collision),
      modelFullCube: Uint8Array.from(this.fullCube),
      modelCount: this.starts.length,
    };
  }
}

/** 结构化去重键。绝大多数方块共用同一个整格立方体，去重后模型数只有几十 */
function modelKey(model: BlockModel): string {
  const parts: string[] = [];
  for (const e of model.elements) {
    parts.push(
      `${e.from.join(',')}|${e.to.join(',')}|${e.faceTexture.join(',')}|` +
      `${e.cullface.join(',')}|${e.clampUv ? 1 : 0}`,
    );
  }
  return parts.join(';');
}

/** 取某个状态的模型索引 */
export function modelIndexOf(tables: ModelTables, id: number, meta: number): number {
  return tables.stateModel[id * 16 + (meta & 15)] ?? 0;
}
