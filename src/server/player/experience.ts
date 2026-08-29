/**
 * 经验：等级曲线、经验球、死亡掉落。
 *
 * **关于等级公式的诚实说明**：1.3 之前的曲线是线性的
 * `升到下一级需要 10 + 等级 × 2` 点经验，这是公开记载的形式，
 * 也是本项目采用的。我没有原始 1.0 源码可以逐值核对，所以
 * docs/DEVIATIONS.md 里把它记成"按公开记载实现，未逐值核对"，
 * 而不是声称"与 1.0 黄金值相等"—— 这两者的区别很重要：
 * 前者是一个诚实的近似，后者是一句查不到出处的断言。
 *
 * 能确定的是这条曲线的**性质**，测试断言的也是这些：单调递增、
 * 线性增长（不是 1.3 之后的分段二次）、等级 0 升 1 需要 10 点。
 */
import { nbt, getInt, type NbtValue } from '../../core/nbt/nbt.ts';

/** 升到下一级需要多少点经验 */
export function xpToNextLevel(level: number): number {
  return 10 + level * 2;
}

/** 从 0 级攒到 level 级总共需要多少点 */
export function totalXpForLevel(level: number): number {
  let sum = 0;
  for (let i = 0; i < level; i++) sum += xpToNextLevel(i);
  return sum;
}

/** 玩家的经验状态 */
export class Experience {
  level = 0;
  /** 当前等级里已经攒了多少点 */
  progress = 0;
  /** 一共拿过多少点，死亡掉落按它算 */
  total = 0;

  /** 拿到一些经验 */
  add(amount: number): void {
    if (amount <= 0) return;
    this.total += amount;
    this.progress += amount;
    while (this.progress >= xpToNextLevel(this.level)) {
      this.progress -= xpToNextLevel(this.level);
      this.level++;
    }
  }

  /**
   * 花掉若干等级。不够就什么都不做，返回 false。
   * 附魔与铁砧（M15）用它。
   */
  spendLevels(levels: number): boolean {
    if (this.level < levels) return false;
    this.level -= levels;
    // MC 的做法是把进度条也一起清掉
    this.progress = 0;
    this.total = totalXpForLevel(this.level);
    return true;
  }

  /**
   * 死亡时掉多少经验。
   *
   * MC 的规则：掉 `等级 × 7`，但最多 100 点。上限是为了避免高等级玩家
   * 死一次就在地上撒出几千个经验球 —— 那既卡又捡不完。
   */
  dropOnDeath(): number {
    return Math.min(100, this.level * 7);
  }

  reset(): void {
    this.level = 0;
    this.progress = 0;
    this.total = 0;
  }

  toNbt(): NbtValue {
    return nbt.compound({
      XpLevel: nbt.int(this.level),
      XpProgress: nbt.int(this.progress),
      XpTotal: nbt.int(this.total),
    });
  }

  loadNbt(tag: NbtValue): void {
    this.level = getInt(tag, 'XpLevel');
    this.progress = getInt(tag, 'XpProgress');
    this.total = getInt(tag, 'XpTotal');
  }
}

/**
 * 一堆经验拆成几个经验球。
 *
 * MC 按面额从大到小拆（1/3/7/17/37/73/149/307/1237/2477），
 * 这样 100 点不会变成 100 个球。数量直接决定服务端要 tick 多少实体，
 * 所以这不是美观问题。
 */
const ORB_VALUES: readonly number[] = [2477, 1237, 307, 149, 73, 37, 17, 7, 3, 1];

export function splitIntoOrbs(amount: number): number[] {
  const out: number[] = [];
  let left = amount;
  while (left > 0) {
    const v = ORB_VALUES.find((x) => x <= left) ?? 1;
    out.push(v);
    left -= v;
  }
  return out;
}
