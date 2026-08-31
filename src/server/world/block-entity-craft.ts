/**
 * 附魔台与酿造台两个方块实体。
 *
 * 与箱子/熔炉分开一个文件，是因为它们的**状态语义完全不同**：
 * 箱子和熔炉存的是物品与进度，这两个存的是"一次交易的报价"和
 * "一炉三瓶的共同进度"。塞进 block-entity.ts 会让那个文件同时讲
 * 两件不相干的事（而它已经 320 行了）。
 *
 * 算法都不在这里：附魔在 core/craft/enchanting.ts，酿造在
 * core/craft/brewing.ts，两边都是纯函数、在 node 里跑得了统计。
 * 这里只做"把算法接到物品栏上"。
 */
import {
  BlockEntity, BlockEntityKind, registerCraftBlockEntities,
  type BlockEntityContext,
} from './block-entity.ts';
import {
  nbt, getInt, getList, type NbtValue,
} from '../../core/nbt/nbt.ts';
import { emptyStack, isEmpty, cloneStack, type ItemStack } from '../../core/item/item-def.ts';
import { stacksToNbt, nbtToStacks } from './block-entity.ts';

/**
 * 附魔台。
 *
 * 只有**一格** —— MC 1.0 的附魔台不吃青金石（那是 1.3 才有的）。
 * 三个报价在放上装备的那一刻算好并**锁住**，直到装备被拿走。
 *
 * 锁住是关键：不锁的话玩家可以反复拿起放下，直到刷出想要的报价，
 * 而那会让"要不要花这 30 级"这个决策彻底消失。MC 用一个每次附魔
 * 才重置的随机种子达到同样效果。
 */
export class EnchantingEntity extends BlockEntity {
  /** 0 = 待附魔的装备 */
  readonly slots: ItemStack[] = [emptyStack()];
  /** 三个槽各要花多少级。0 = 这一槽没得选 */
  offers: [number, number, number] = [0, 0, 0];
  /**
   * 这一次报价用的随机种子。
   *
   * 存下来而不是每次现摇：客户端要能反复看到同一份报价，
   * 而服务端在玩家真的点下去之前不该把结果算出来。
   */
  seed = 0;
  /** 报价是按几个书架算的，存下来供断言与调试 */
  bookshelves = 0;

  constructor(x: number, y: number, z: number) {
    super(BlockEntityKind.ENCHANTING, x, y, z);
  }

  override contents(): ItemStack[] {
    return this.slots.filter((s) => !isEmpty(s)).map(cloneStack);
  }

  /** 台子上放的东西变了：要么重新报价，要么清空 */
  clearOffers(): void {
    this.offers = [0, 0, 0];
    this.seed = 0;
  }

  override toNbt(): NbtValue {
    return nbt.compound({
      id: nbt.string(this.kind),
      x: nbt.int(this.x), y: nbt.int(this.y), z: nbt.int(this.z),
      Items: stacksToNbt(this.slots),
      Seed: nbt.int(this.seed),
    });
  }

  static fromNbt(x: number, y: number, z: number, tag: NbtValue): EnchantingEntity {
    const e = new EnchantingEntity(x, y, z);
    nbtToStacks(getList(tag, 'Items'), e.slots);
    e.seed = getInt(tag, 'Seed');
    return e;
  }
}

/**
 * 酿造台。
 *
 * 四格：0..2 是瓶位，3 是材料。**一份材料同时酿三瓶** —— 这是酿造
 * 唯一的效率来源，也是"先囤三个水瓶再开酿"这个习惯的由来。
 * 做成一瓶一份的话，整套酿造会慢三倍，玩家立刻会觉得不对。
 */
export const BREW_TICKS = 400;

export class BrewingEntity extends BlockEntity {
  /** 0..2 瓶位，3 材料 */
  readonly slots: ItemStack[] = Array.from({ length: 4 }, () => emptyStack());
  /** 剩余酿造时间。0 = 没在酿 */
  brewTime = 0;
  /**
   * 上一刻算出来的三个结果。
   *
   * 缓存下来是因为 tick 要在**开始**时判断"这一炉能不能酿"，
   * 在**结束**时把结果写回去，而中途材料可能被拿走。
   * 不缓存的话，拿走材料再放回一个不同的，会按新材料出货 ——
   * 相当于用一份材料换到了另一份的效果。
   */
  private pending: (number | null)[] = [null, null, null];

  constructor(x: number, y: number, z: number) {
    super(BlockEntityKind.BREWING, x, y, z);
  }

  override contents(): ItemStack[] {
    return this.slots.filter((s) => !isEmpty(s)).map(cloneStack);
  }

  /**
   * 推进一刻。
   *
   * @param resolve 由服务端注入：给定一瓶药水的 damage 与材料的物品名，
   *                算出结果。core 的 brew() 用物品**名字**，
   *                而这里手上只有 id —— 名字表在 content 层，
   *                方块实体够不着，所以由调用方翻译
   */
  tickBrew(resolve: (potionDamage: number, ingredientId: number) => number | null): boolean {
    const ingredient = this.slots[3]!;
    if (this.brewTime > 0) {
      // 材料被拿走就停下，进度归零（MC 也是这样，且不退还时间）
      if (isEmpty(ingredient)) {
        this.brewTime = 0;
        this.pending = [null, null, null];
        return true;
      }
      this.brewTime--;
      if (this.brewTime > 0) return false;
      // 出货
      for (let i = 0; i < 3; i++) {
        const out = this.pending[i];
        if (out === null || out === undefined) continue;
        this.slots[i]!.damage = out;
      }
      this.pending = [null, null, null];
      ingredient.count--;
      if (ingredient.count <= 0) this.slots[3] = emptyStack();
      return true;
    }

    if (isEmpty(ingredient)) return false;
    let any = false;
    const next: (number | null)[] = [null, null, null];
    for (let i = 0; i < 3; i++) {
      const bottle = this.slots[i]!;
      if (isEmpty(bottle)) continue;
      const out = resolve(bottle.damage, ingredient.id);
      if (out === null || out === bottle.damage) continue;
      next[i] = out;
      any = true;
    }
    if (!any) return false;
    this.pending = next;
    this.brewTime = BREW_TICKS;
    return true;
  }

  override tick(_ctx: BlockEntityContext): boolean {
    // 真正的推进要 resolve 回调，由 block-entity-tick 调 tickBrew。
    // 这里保持 BlockEntity 的默认行为
    return false;
  }

  override toNbt(): NbtValue {
    return nbt.compound({
      id: nbt.string(this.kind),
      x: nbt.int(this.x), y: nbt.int(this.y), z: nbt.int(this.z),
      Items: stacksToNbt(this.slots),
      BrewTime: nbt.int(this.brewTime),
    });
  }

  static fromNbt(x: number, y: number, z: number, tag: NbtValue): BrewingEntity {
    const e = new BrewingEntity(x, y, z);
    nbtToStacks(getList(tag, 'Items'), e.slots);
    // 进度不跨存档保留：存的时候 pending 没写进去，读回来会出错货。
    // 损失是玩家读档时那一炉要重来 400 刻，比出错货好得多
    e.brewTime = 0;
    return e;
  }
}

// 注册工厂。见 block-entity.ts 的 registerCraftBlockEntities
registerCraftBlockEntities((kind, x, y, z) => (
  kind === BlockEntityKind.ENCHANTING
    ? new EnchantingEntity(x, y, z)
    : new BrewingEntity(x, y, z)
));
