/**
 * 方块实体：需要**额外状态**的方块。
 *
 * 方块本身只有 12 位 id + 4 位元数据，装不下箱子的 27 格物品或者熔炉的
 * 燃烧进度。这些方块在世界里额外挂一个对象，按坐标索引。
 *
 * 索引**按区块分组**（见 block-entity-store.ts）而不是一张扁平的全局表：
 * 区块卸载时它的方块实体要跟着走，挂在扁平表上的话会留下一堆指向
 * 已卸载区块的孤儿，而那种泄漏要跑很久才显形（M3 的区块泄漏就是这么来的）。
 *
 * 分组放在 server 层而不是 core 的 Chunk 上，是因为 core 不许 import 任何人，
 * 而方块实体要用到物品栏与熔炼表 —— 让 Chunk 认识它们会把依赖方向倒过来。
 */
import {
  nbt, getInt, getString, getList, type NbtValue,
} from '../../core/nbt/nbt.ts';
import { TagType } from '../../core/nbt/nbt.ts';
import {
  emptyStack, isEmpty, cloneStack, type ItemStack,
} from '../../core/item/item-def.ts';

export const BlockEntityKind = {
  CHEST: 'chest',
  FURNACE: 'furnace',
  SIGN: 'sign',
  ENCHANTING: 'enchanting',
  BREWING: 'brewing',
} as const;
export type BlockEntityKind = (typeof BlockEntityKind)[keyof typeof BlockEntityKind];

export abstract class BlockEntity {
  readonly kind: BlockEntityKind;
  readonly x: number;
  readonly y: number;
  readonly z: number;

  constructor(kind: BlockEntityKind, x: number, y: number, z: number) {
    this.kind = kind;
    this.x = x;
    this.y = y;
    this.z = z;
  }

  /** 每 tick 一次。返回 true 表示状态变了、需要同步 */
  tick(_ctx: BlockEntityContext): boolean {
    return false;
  }

  /** 被破坏时要掉出来的东西 */
  contents(): ItemStack[] {
    return [];
  }

  abstract toNbt(): NbtValue;
}

/** 方块实体 tick 时能用到的外部信息 */
export interface BlockEntityContext {
  /** 某个物品烧多久（tick），0 表示不是燃料 */
  burnTicks(id: number): number;
  /** 某个物品熔炼出什么，null 表示烧不了 */
  smeltResult(id: number): { id: number; count: number } | null;
  /** 某种物品能叠多少 */
  maxStack(id: number): number;
  /** 把方块换成另一个 id（熔炉点燃 / 熄灭） */
  setBlockId(x: number, y: number, z: number, id: number): void;
}

// ---------------------------------------------------------------------------

/** 箱子：27 格 */
export class ChestEntity extends BlockEntity {
  readonly slots: ItemStack[] = Array.from({ length: 27 }, () => emptyStack());

  constructor(x: number, y: number, z: number) {
    super(BlockEntityKind.CHEST, x, y, z);
  }

  override contents(): ItemStack[] {
    return this.slots.filter((s) => !isEmpty(s)).map(cloneStack);
  }

  override toNbt(): NbtValue {
    return nbt.compound({
      id: nbt.string(this.kind),
      x: nbt.int(this.x), y: nbt.int(this.y), z: nbt.int(this.z),
      Items: stacksToNbt(this.slots),
    });
  }
}

/**
 * 熔炉：输入 / 燃料 / 产物三格 + 两个计时器。
 *
 * MC 的数值：一次熔炼 200 tick（10 秒），煤能烧 1600 tick（8 次）。
 * 燃料是在**开始烧**的时候就整份消耗掉的，不是按需扣 —— 所以熄火时
 * 剩下的燃烧时间就浪费了，这也是"别把最后一块煤放进去烧一个东西"的由来。
 */
export const SMELT_TICKS = 200;

export class FurnaceEntity extends BlockEntity {
  /** 0 = 输入，1 = 燃料，2 = 产物 */
  readonly slots: ItemStack[] = Array.from({ length: 3 }, () => emptyStack());
  /** 剩余燃烧时间 */
  burnTime = 0;
  /** 当前这份燃料总共能烧多久，用来画火焰进度条 */
  burnTotal = 0;
  /** 当前这次熔炼已经进行了多久 */
  cookTime = 0;
  /** 点着的时候方块要换成 lit_furnace */
  private lit = false;
  /**
   * 上一刻**格子里的东西**变没变（相对于只是计时器在走）。
   *
   * 分开这两件事是为了省带宽：燃烧时间每刻都在减，而格子里的东西
   * 一炉可能就动两三次。不分的话，一个玩家盯着熔炉看就等于每刻重发
   * 46 个格子 —— 而进度条本来就有自己的小包（S_WindowProgress）。
   */
  contentsChanged = false;

  constructor(x: number, y: number, z: number) {
    super(BlockEntityKind.FURNACE, x, y, z);
  }

  override tick(ctx: BlockEntityContext): boolean {
    const before = `${this.burnTime}|${this.cookTime}|${this.lit}`;
    this.contentsChanged = false;

    if (this.burnTime > 0) this.burnTime--;

    const input = this.slots[0]!;
    const fuel = this.slots[1]!;
    const output = this.slots[2]!;
    const result = isEmpty(input) ? null : ctx.smeltResult(input.id);
    const canOutput = result !== null && (
      isEmpty(output)
      || (output.id === result.id && output.count + result.count <= ctx.maxStack(output.id))
    );

    // 没烧着但有活干：点火，整份燃料一次性消耗
    if (this.burnTime === 0 && canOutput && !isEmpty(fuel)) {
      const ticks = ctx.burnTicks(fuel.id);
      if (ticks > 0) {
        this.burnTime = ticks;
        this.burnTotal = ticks;
        fuel.count--;
        this.contentsChanged = true;
        if (fuel.count <= 0) {
          fuel.id = 0;
          fuel.damage = 0;
        }
      }
    }

    if (this.burnTime > 0 && canOutput) {
      this.cookTime++;
      if (this.cookTime >= SMELT_TICKS) {
        this.cookTime = 0;
        if (isEmpty(output)) {
          output.id = result!.id;
          output.count = result!.count;
          output.damage = 0;
        } else {
          output.count += result!.count;
        }
        input.count--;
        this.contentsChanged = true;
        if (input.count <= 0) {
          input.id = 0;
          input.damage = 0;
        }
      }
    } else {
      // 断料或者产物满了：进度回退而不是清零，这样补上燃料能接着烧
      if (this.cookTime > 0) this.cookTime = Math.max(0, this.cookTime - 2);
    }

    const nowLit = this.burnTime > 0;
    if (nowLit !== this.lit) {
      this.lit = nowLit;
      ctx.setBlockId(this.x, this.y, this.z, nowLit ? 62 : 61);
    }

    return `${this.burnTime}|${this.cookTime}|${this.lit}` !== before;
  }

  override contents(): ItemStack[] {
    return this.slots.filter((s) => !isEmpty(s)).map(cloneStack);
  }

  override toNbt(): NbtValue {
    return nbt.compound({
      id: nbt.string(this.kind),
      x: nbt.int(this.x), y: nbt.int(this.y), z: nbt.int(this.z),
      BurnTime: nbt.short(this.burnTime),
      BurnTotal: nbt.short(this.burnTotal),
      CookTime: nbt.short(this.cookTime),
      Items: stacksToNbt(this.slots),
    });
  }
}

/** 告示牌：四行文字 */
export class SignEntity extends BlockEntity {
  readonly lines: string[] = ['', '', '', ''];

  constructor(x: number, y: number, z: number) {
    super(BlockEntityKind.SIGN, x, y, z);
  }

  override toNbt(): NbtValue {
    return nbt.compound({
      id: nbt.string(this.kind),
      x: nbt.int(this.x), y: nbt.int(this.y), z: nbt.int(this.z),
      Text1: nbt.string(this.lines[0] ?? ''),
      Text2: nbt.string(this.lines[1] ?? ''),
      Text3: nbt.string(this.lines[2] ?? ''),
      Text4: nbt.string(this.lines[3] ?? ''),
    });
  }
}

// ---------------------------------------------------------------------------

/**
 * 把一件物品的附魔写进它的 NBT 字段表。
 *
 * 没附过魔的物品**不写这一项** —— 箱子里绝大多数格子都没附魔，
 * 给每一格写一个空列表会让存档白白胀一圈。
 *
 * 单独抽出来是因为有两条路要用：容器里的格子（stacksToNbt）和
 * 掉在地上的那一件（ItemEntity.toNbt）。少接一条的表现是
 * "扔在地上的附魔剑，区块一卸载再走回来，附魔没了"
 */
export function writeEnchantments(s: ItemStack, fields: Record<string, NbtValue>): void {
  if (s.enchantments === undefined || s.enchantments.length === 0) return;
  fields['ench'] = nbt.list(TagType.COMPOUND, s.enchantments.map((e) => nbt.compound({
    id: nbt.short(e.id),
    lvl: nbt.short(e.level),
  })));
}

/** 反过来。没有 ench 就把字段删掉 —— 目标物品可能是复用的 */
export function readEnchantments(item: NbtValue, dst: ItemStack): void {
  const ench = getList(item, 'ench');
  if (ench.length > 0) {
    dst.enchantments = ench.map((e) => ({ id: getInt(e, 'id'), level: getInt(e, 'lvl') }));
  } else {
    // nbtToStacks 上面那个清空循环只清了 id/count/damage —— 数组是复用的，
    // 不删的话上一次读进来的附魔会挂在一件空物品上
    delete dst.enchantments;
  }
}

/** 物品数组 -> NBT 列表。空格子不写，读回来时按 Slot 号还原 */
export function stacksToNbt(slots: readonly ItemStack[]): NbtValue {
  const items: NbtValue[] = [];
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i]!;
    if (isEmpty(s)) continue;
    const fields: Record<string, NbtValue> = {
      Slot: nbt.byte(i),
      id: nbt.short(s.id),
      Count: nbt.byte(s.count),
      Damage: nbt.short(s.damage),
    };
    writeEnchantments(s, fields);
    items.push(nbt.compound(fields));
  }
  return nbt.list(TagType.COMPOUND, items);
}

/** NBT 列表 -> 填进给定的物品数组 */
export function nbtToStacks(list: readonly NbtValue[], out: ItemStack[]): void {
  for (const s of out) {
    s.id = 0;
    s.count = 0;
    s.damage = 0;
  }
  for (const item of list) {
    const slot = getInt(item, 'Slot');
    if (slot < 0 || slot >= out.length) continue;
    const dst = out[slot]!;
    dst.id = getInt(item, 'id');
    dst.count = getInt(item, 'Count');
    dst.damage = getInt(item, 'Damage');
    readEnchantments(item, dst);
  }
}

/** 从 NBT 还原一个方块实体 */
export function blockEntityFromNbt(tag: NbtValue): BlockEntity | null {
  const kind = getString(tag, 'id');
  const x = getInt(tag, 'x');
  const y = getInt(tag, 'y');
  const z = getInt(tag, 'z');
  switch (kind) {
    case BlockEntityKind.CHEST: {
      const e = new ChestEntity(x, y, z);
      nbtToStacks(getList(tag, 'Items'), e.slots);
      return e;
    }
    case BlockEntityKind.FURNACE: {
      const e = new FurnaceEntity(x, y, z);
      e.burnTime = getInt(tag, 'BurnTime');
      e.burnTotal = getInt(tag, 'BurnTotal');
      e.cookTime = getInt(tag, 'CookTime');
      nbtToStacks(getList(tag, 'Items'), e.slots);
      return e;
    }
    case BlockEntityKind.SIGN: {
      const e = new SignEntity(x, y, z);
      for (let i = 0; i < 4; i++) e.lines[i] = getString(tag, `Text${i + 1}`);
      return e;
    }
    // 附魔台与酿造台在 block-entity-craft.ts。与 createBlockEntity 同理，
    // 直接 import 会成环，所以走注入的工厂。
    //
    // 漏了这两条的后果不只是"内容丢了"：读回来的方块**没有方块实体**，
    // 右键它会开出一个空窗口，而放在里面的药水与装备无声无息地没了
    case BlockEntityKind.ENCHANTING:
    case BlockEntityKind.BREWING: {
      if (craftFromNbt === null) return null;
      return craftFromNbt(kind, x, y, z, tag);
    }
    default:
      return null;
  }
}

/** 附魔台/酿造台的 NBT 还原器，由 block-entity-craft.ts 注册 */
let craftFromNbt:
  ((k: BlockEntityKind, x: number, y: number, z: number, tag: NbtValue) => BlockEntity) | null = null;

export function registerCraftBlockEntityLoader(
  f: (k: BlockEntityKind, x: number, y: number, z: number, tag: NbtValue) => BlockEntity,
): void {
  craftFromNbt = f;
}

/** 某个方块 id 对应哪种方块实体，null 表示不需要 */
export function blockEntityKindFor(blockId: number): BlockEntityKind | null {
  switch (blockId) {
    case 54: return BlockEntityKind.CHEST;
    case 61: case 62: return BlockEntityKind.FURNACE;
    case 63: case 68: return BlockEntityKind.SIGN;
    case 116: return BlockEntityKind.ENCHANTING;
    case 117: return BlockEntityKind.BREWING;
    default: return null;
  }
}

/** 新建一个方块实体 */
export function createBlockEntity(kind: BlockEntityKind, x: number, y: number, z: number): BlockEntity {
  switch (kind) {
    case BlockEntityKind.CHEST: return new ChestEntity(x, y, z);
    case BlockEntityKind.FURNACE: return new FurnaceEntity(x, y, z);
    case BlockEntityKind.SIGN: return new SignEntity(x, y, z);
    // 这两个在 block-entity-craft.ts —— 反过来 import 会成环
    // （那个文件要用本文件的 BlockEntity 基类），所以由工厂注入
    case BlockEntityKind.ENCHANTING: return craftFactory!(kind, x, y, z);
    case BlockEntityKind.BREWING: return craftFactory!(kind, x, y, z);
  }
}

/**
 * 附魔台/酿造台的构造器。由 block-entity-craft.ts 在模块加载时注册。
 *
 * 用注入而不是直接 import，是为了避免两个文件互相 import 成环：
 * craft 那边要继承本文件的 BlockEntity，本文件又要能造出它们。
 * 环在 Node 的类型剥离下会得到一个 undefined 的基类，
 * 而报错信息是"Class extends value undefined"，与真正的原因隔得很远。
 */
let craftFactory: ((k: BlockEntityKind, x: number, y: number, z: number) => BlockEntity) | null = null;

export function registerCraftBlockEntities(
  f: (k: BlockEntityKind, x: number, y: number, z: number) => BlockEntity,
): void {
  craftFactory = f;
}
