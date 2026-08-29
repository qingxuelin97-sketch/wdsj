/**
 * 方块注册表。
 *
 * 生命周期是"注册 -> 冻结 -> 只读"。冻结时把所有定义烘焙成扁平表（BlockTables），
 * 之后任何写入都会抛错 —— 服务端与客户端必须看到完全一致的方块表，
 * 运行中改注册表会让两边的方块 id 含义漂移，是最难查的一类 bug。
 */
import type { BlockDef } from '../block/block-def.ts';
import { BlockTables, MAX_BLOCK_ID } from './block-tables.ts';

export class BlockRegistry {
  private readonly byId: (BlockDef | null)[] = [];
  private readonly byName = new Map<string, BlockDef>();
  private tables: BlockTables | null = null;

  register(def: BlockDef): BlockDef {
    if (this.tables !== null) {
      throw new Error(`注册表已冻结，不能再注册 '${def.name}'`);
    }
    if (def.id < 0 || def.id >= MAX_BLOCK_ID) {
      throw new RangeError(`方块 id ${def.id} 越界（'${def.name}'），有效范围 0..${MAX_BLOCK_ID - 1}`);
    }
    const existing = this.byId[def.id];
    if (existing != null) {
      throw new Error(`方块 id ${def.id} 已被 '${existing.name}' 占用，无法注册 '${def.name}'`);
    }
    if (this.byName.has(def.name)) {
      throw new Error(`方块名 '${def.name}' 重复注册`);
    }
    while (this.byId.length <= def.id) this.byId.push(null);
    this.byId[def.id] = def;
    this.byName.set(def.name, def);
    return def;
  }

  /** 烘焙扁平表。之后注册表变为只读。 */
  freeze(): BlockTables {
    if (this.tables !== null) return this.tables;
    if (this.byId[0] == null) {
      throw new Error('方块 id 0 必须是空气');
    }
    this.tables = new BlockTables(this.byId);
    return this.tables;
  }

  get frozen(): boolean {
    return this.tables !== null;
  }

  /** 取扁平表。未冻结时抛错，避免拿到半成品 */
  getTables(): BlockTables {
    if (this.tables === null) throw new Error('注册表尚未冻结，先调用 freeze()');
    return this.tables;
  }

  /** 按 id 取定义。**冷路径专用** —— 热循环请用 BlockTables 的扁平数组 */
  get(id: number): BlockDef | null {
    return this.byId[id] ?? null;
  }

  /** 按名字取定义。存档与配方表按名字引用方块，这样改 id 不会破坏存档 */
  getByName(name: string): BlockDef | null {
    return this.byName.get(name) ?? null;
  }

  /**
   * 有没有这个名字的方块。
   * 给"一个名字既可能是方块也可能是物品"的场合用（比如 give 指令）。
   */
  hasBlock(name: string): boolean {
    return this.byName.has(name);
  }

  /** 按名字取 id，找不到时抛错 —— 内容表里写错名字应当立刻炸，而不是静默变成空气 */
  idOf(name: string): number {
    const def = this.byName.get(name);
    if (def === undefined) throw new Error(`未注册的方块名: '${name}'`);
    return def.id;
  }

  get size(): number {
    return this.byName.size;
  }

  names(): string[] {
    return [...this.byName.keys()];
  }
}
