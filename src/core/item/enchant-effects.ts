/**
 * 附魔的**效果层**：把"这件装备身上有哪些附魔"翻译成"某个计算要改多少"。
 *
 * `item/enchantment.ts` 管附魔的定义，`craft/enchanting.ts` 管附魔台怎么抽。
 * 抽出来之后附魔一直是**死的** —— 一把锋利 V 的剑和一把木剑打出来的伤害一模一样，
 * `enchantLevel` 全仓库零调用者。这个文件补的就是中间那一段。
 *
 * ## 为什么整层都是纯函数
 *
 * 每一条都是"装备 + 情境 → 一个数"，不碰世界、不碰玩家、不自己摇随机数：
 * 要随机的四条（抢夺、时运、耐久、水下呼吸）一律把 `nextInt` 当参数传进来。
 * 这样服务端的战斗、挖掘、掉落三条路各自调用互不牵连，而测试能把"摇到 0"和
 * "摇到上限"两端直接钉死，不必跑几万次碰运气。
 *
 * ## 版本：一律按 MC 1.0（即 pre-1.9）的公式
 *
 * 附魔数值在 1.9 被整体重做过 —— 锋利从"每级 +1.25"改成"1 + 0.5×(级−1)"，
 * 力量的系数翻了一倍。照现代公式写的话玩家会发现"锋利 V 怎么才加 3 点"，
 * 与 1.0 的手感差得很远。每条公式的注释里都写了它出自哪、**我有多确定**，
 * 不确定的那条（力量）把系数抽成了常量。等级**不夹**到 maxLevel：原版也不夹
 * （指令塞进去的锋利 X 就按 X 算），夹了会把"存档里的超级附魔"悄悄吞掉。
 */
import { enchantLevel, isEmpty, type ItemStack } from './item-def.ts';
import { Enchantment } from './enchantment.ts';

// ---------------------------------------------------------------------------
// 入参类型
// ---------------------------------------------------------------------------

/**
 * 目标生物属于哪一类。对应 MC 的 EnumCreatureAttribute。只有三档，而且**故意不
 * import 服务端的 Mob** —— core 不许 import server，这一层还要能脱离世界单跑。
 * 谁是亡灵、谁是节肢由调用方（combat.ts）从 MobType 映射过来。
 */
export const MobKind = {
  NORMAL: 0,
  /** 亡灵：僵尸、骷髅、僵尸猪人 */
  UNDEAD: 1,
  /** 节肢：蜘蛛、洞穴蜘蛛、蠹虫 */
  ARTHROPOD: 2,
} as const;
export type MobKind = (typeof MobKind)[keyof typeof MobKind];

/**
 * 伤害来源的种类，决定哪一系保护生效。对应 MC 的 DamageSource 上那几个判定。
 *
 * 没叫 DamageKind 是有意的：server/player/player-vitals.ts 已经有一个同名但
 * **不同口径**的枚举（那个分的是"护甲挡不挡得住 / 给不给无敌帧"），
 * 两个都会在 combat.ts 里出现，重名会当场撞车。
 *
 * 没有"无视护甲"那一档：溺水、窒息、饿死、虚空在原版里连保护附魔也不减
 * （DamageSource 的 absolute 分支直接返回 0），调用方不该为它们走这条路。
 */
export const DamageSourceKind = {
  /** 近战、仙人掌这类一般伤害 */
  GENERIC: 0,
  FIRE: 1,
  EXPLOSION: 2,
  /** 箭、火球 */
  PROJECTILE: 3,
  FALL: 4,
} as const;
export type DamageSourceKind = (typeof DamageSourceKind)[keyof typeof DamageSourceKind];

/**
 * 随机数入参。语义与 java.util.Random.nextInt(bound) 完全一致：返回 0..bound−1。
 * 把随机源当参数传而不是在这里 new 一个，是为了让"摇到最小 / 最大"在测试里是
 * 两行断言而不是一次统计。`core/rng/java-random.ts` 的 nextInt 可以直接当它用。
 */
export type Roll = (bound: number) => number;

// ---------------------------------------------------------------------------
// 可调常量。把不确定的系数抽出来，改的时候只动一行
// ---------------------------------------------------------------------------

/** 近战附加伤害：锋利每级 1.25，亡灵 / 节肢杀手每级 2.5（1.9 才改成 1 + 0.5×(级−1)） */
export const SHARPNESS_PER_LEVEL = 1.25;
export const SLAYER_PER_LEVEL = 2.5;
/** 火焰附加每级点燃 4 秒；火矢命中固定 5 秒（与等级无关，火矢也只有 I 级） */
export const FIRE_ASPECT_SECONDS_PER_LEVEL = 4;
export const FLAME_ARROW_SECONDS = 5;
/** 力量每级给箭的伤害系数加多少，基准系数 2。**最不确定的一条**，见 arrowDamageMultiplier */
export const POWER_DAMAGE_PER_LEVEL = 0.25;
export const ARROW_BASE_DAMAGE = 2;
/** 保护系的两个夹子与分母。为什么是这三个数，见 damageAfterProtection */
export const MAX_PROTECTION_EPF = 25;
export const MAX_PROTECTION_HALVED = 20;
export const PROTECTION_DIVISOR = 25;

/**
 * 取某件装备上某个附魔的等级。空手 / 空槽一律 0。多包一层 isEmpty 是因为
 * ItemStack 的"空"是 `count === 0` 而不是 null：只要哪条路径漏删了 enchantments
 * （clearStack 会删，读档与网络包解出来的不一定），空手就会带着上一把剑的锋利，
 * 而且没有任何报错。
 */
function levelOf(stack: ItemStack, id: number): number {
  return isEmpty(stack) ? 0 : enchantLevel(stack, id);
}

// ---------------------------------------------------------------------------
// 剑：锋利 / 亡灵杀手 / 节肢杀手 / 击退 / 火焰附加 / 抢夺
// ---------------------------------------------------------------------------

/**
 * 近战附加伤害（半心为 1，与 ItemDef.attackDamage 同一口径）。
 *
 * 出自 1.0 的 `EnchantmentDamage.calcModifierLiving`：type 0（锋利）→ level × 1.25，
 * 对**所有**目标生效；type 1（亡灵）/ type 2（节肢）→ 目标对得上时 level × 2.5，
 * 否则 0。这条我很确定：1.9 之前一直是这个式子，1.9 才改成 1 + 0.5×(级−1)。
 *
 * 三条累加而不是取最大：原版就是遍历物品身上所有附魔求和。它们在
 * EXCLUSIVE_GROUPS 里互斥，正常最多命中一条，但指令硬塞的三条并存也该按
 * 原版的方式算。返回**小数**（锋利 V = 6.25），取整交给调用方 ——
 * 原版是攒进 int 伤害里一起截断的，这一层不该替它做主。
 */
export function meleeBonusDamage(weapon: ItemStack, target: MobKind): number {
  let bonus = levelOf(weapon, Enchantment.SHARPNESS) * SHARPNESS_PER_LEVEL;
  if (target === MobKind.UNDEAD) bonus += levelOf(weapon, Enchantment.SMITE) * SLAYER_PER_LEVEL;
  if (target === MobKind.ARTHROPOD) {
    bonus += levelOf(weapon, Enchantment.BANE_OF_ARTHROPODS) * SLAYER_PER_LEVEL;
  }
  return bonus;
}

/**
 * 击退要额外加几级强度。没附魔是 0。`EnchantmentHelper.getKnockbackModifier`
 * 直接返回等级，打中之后击退强度按级累加：一级多推半格多，两级能把猪推下悬崖，
 * 而这是击退唯一的玩法价值。
 */
export function knockbackLevels(weapon: ItemStack): number {
  return levelOf(weapon, Enchantment.KNOCKBACK);
}

/**
 * 火焰附加点燃目标多少**秒**。没附魔是 0。原版是打中后 `target.setFire(level * 4)`，
 * 而 `Entity.setFire` 的入参单位就是秒（内部再 ×20 转 tick）。返回 tick 的话调用方会
 * 再乘一次 20，烧上 80 秒 —— 这类单位错误的表现是"被点着的猪一路烧到死"，
 * 而不是任何报错。
 */
export function fireAspectSeconds(weapon: ItemStack): number {
  return levelOf(weapon, Enchantment.FIRE_ASPECT) * FIRE_ASPECT_SECONDS_PER_LEVEL;
}

/**
 * 抢夺带来的**额外**掉落件数（不含基础掉落）。
 *
 * 1.0 的抢夺不在 EnchantmentHelper 里加东西，而是把等级传进
 * `EntityLiving.dropFewItems(recentlyHit, looting)`，每种生物自己写
 * `if (looting > 0) count += rand.nextInt(looting + 1)`。所以抢夺 III 是 0..3 件，
 * **有可能一件都不多给** —— 这个"经常白附"的手感是原版的一部分，改成保底 +1
 * 会让刷怪塔的产出直接翻番。
 *
 * 没附魔时一次随机数都不摸：调用方共用随机源，白摇会让后面的序列全部错位。
 */
export function extraLootRolls(weapon: ItemStack, roll: Roll): number {
  const level = levelOf(weapon, Enchantment.LOOTING);
  return level > 0 ? roll(level + 1) : 0;
}

// ---------------------------------------------------------------------------
// 盔甲：五系保护 / 水下呼吸 / 水下速掘
// ---------------------------------------------------------------------------

/** 某一系保护对某种伤害的系数，不适用时 0 */
function protectionFactor(id: number, kind: DamageSourceKind): number {
  // 保护是**无差别**的：对摔落、火、爆炸、箭一样生效，只是系数最低。这一点常被漏掉
  // —— 漏了的话"穿一套保护 IV 摔下来照样半血"，而原版里保护是能救命的
  // （护甲点数对摔落无效，保护附魔有效）
  if (id === Enchantment.PROTECTION) return 0.75;
  if (id === Enchantment.FIRE_PROTECTION) return kind === DamageSourceKind.FIRE ? 1.25 : 0;
  if (id === Enchantment.BLAST_PROTECTION) return kind === DamageSourceKind.EXPLOSION ? 1.5 : 0;
  if (id === Enchantment.PROJECTILE_PROTECTION) return kind === DamageSourceKind.PROJECTILE ? 1.5 : 0;
  if (id === Enchantment.FEATHER_FALLING) return kind === DamageSourceKind.FALL ? 2.5 : 0;
  return 0;
}

const PROTECTION_IDS = [
  Enchantment.PROTECTION, Enchantment.FIRE_PROTECTION, Enchantment.BLAST_PROTECTION,
  Enchantment.PROJECTILE_PROTECTION, Enchantment.FEATHER_FALLING,
] as const;

/**
 * 单件装备的 EPF（Enchantment Protection Factor）。
 *
 * pre-1.9 的 `EnchantmentProtection.calcModifierDamage`：base = (6 + 等级²) / 3，
 * 再乘系数（保护 0.75 / 防火 1.25 / 爆炸 1.5 / 弹射物 1.5 / 摔落缓冲 2.5），
 * 再**向下取整**。于是保护 IV 一件 = floor(22/3 × 0.75) = 5，防火 IV 一件 = 9。
 *
 * 取整必须**逐条**做完再相加：保护 IV 单件真值 5.5，先加四件再取整会得到 22 而不是
 * 20，多出的两点足以把减伤从 40% 抬到 48%。一件上可以同时有两条（靴子的保护 +
 * 摔落缓冲），所以这里求和 —— 与原版遍历物品全部附魔的做法一致。
 */
export function protectionEpf(piece: ItemStack, kind: DamageSourceKind): number {
  let epf = 0;
  for (const id of PROTECTION_IDS) {
    const level = levelOf(piece, id);
    if (level <= 0) continue;
    const factor = protectionFactor(id, kind);
    if (factor <= 0) continue;
    epf += Math.floor(((6 + level * level) / 3) * factor);
  }
  return epf;
}

/**
 * 保护系减伤之后的伤害。没有任何保护时原样返回。
 *
 * pre-1.9 的完整链路（EnchantmentHelper + EntityLiving）：四件 EPF 相加 →
 * **夹到 25** → k = (总和 + 1) >> 1（折半，"堆保护收益递减"就来自这一步）→
 * k 再夹到 20 → 伤害 × (25 − k) / 25。
 *
 * 两个夹子都照抄了，虽然第二个在原版里根本够不着：夹到 25 之后 k 最大只有 13，
 * 实际减伤天花板是 **52%**，而不是流传很广的"最高 80%" —— 那个 80% 说的是
 * 后面这个 20 换算出的名义上限。留着它是为了让公式形状与原版逐行对得上。
 *
 * 与护甲点数是**串联**的两次乘法（原版先护甲再附魔），调用方应写成
 * `damageAfterProtection(applyArmor(...), ...)`。摔落是唯一要小心的一档：
 * 护甲点数对摔落无效，但保护与摔落缓冲有效。
 *
 * 返回小数、不取整：原版伤害是 int，靠 carryoverDamage 累加器把余数攒到下一次
 * —— 那是**状态**，而本模块是纯的。取整交给调用方（它本来就在 floor）。
 */
export function damageAfterProtection(
  amount: number, armorPieces: readonly ItemStack[], kind: DamageSourceKind,
): number {
  let epf = 0;
  for (const piece of armorPieces) epf += protectionEpf(piece, kind);
  if (epf <= 0) return amount;
  epf = Math.min(MAX_PROTECTION_EPF, epf);
  const k = Math.min(MAX_PROTECTION_HALVED, (epf + 1) >> 1);
  return (amount * (PROTECTION_DIVISOR - k)) / PROTECTION_DIVISOR;
}

/**
 * 水下憋气时间的倍率。没附魔是 1。原版没有"倍率"这个量：`decreaseAirSupply` 每 tick
 * 摇一次 `nextInt(level+1) > 0` 决定扣不扣氧气，期望上就等于 ×(level + 1)。
 * 基础 300 tick（15 秒）× 4 = 60 秒，与呼吸 III 的实测一致。要逐 tick 精确的用
 * consumesAir，只想在 HUD 上显示"还能憋多久"的用这个。
 */
export function respirationAirMultiplier(helmet: ItemStack): number {
  return levelOf(helmet, Enchantment.RESPIRATION) + 1;
}

/**
 * 这一 tick 要不要扣氧气。没附魔时恒为 true。
 *
 * 逐 tick 复刻 `EntityLiving.decreaseAirSupply`：摇出非 0 就跳过这次扣除。
 * 注意判断方向 —— `nextInt(n) > 0` 的概率是 (n−1)/n，也就是等级越高越
 * **不容易**扣。写反了的表现是"戴上呼吸 III 之后淹得更快"。
 */
export function consumesAir(helmet: ItemStack, roll: Roll): boolean {
  const level = levelOf(helmet, Enchantment.RESPIRATION);
  if (level <= 0) return true;
  return roll(level + 1) === 0;
}

/**
 * 有没有水下速掘。原版在 `getCurrentPlayerStrVsBlock` 里：水里且没有这条附魔时
 * 挖掘速度 /5。`block/breaking.ts` 的 inWater 参数干的正是这件事，所以调用方传的
 * 应该是 `inWater && !hasAquaAffinity(helmet)`，而不是再叠一层倍率。
 */
export function hasAquaAffinity(helmet: ItemStack): boolean {
  return levelOf(helmet, Enchantment.AQUA_AFFINITY) > 0;
}

// ---------------------------------------------------------------------------
// 工具：效率 / 精准采集 / 耐久 / 时运
// ---------------------------------------------------------------------------

/**
 * 效率给挖掘速度加多少。**加法，不是倍率。** 没附魔是 0。
 *
 * 原版 `getCurrentPlayerStrVsBlock`：`if (f > 1) f += level² + 1`。两个细节都不能少：
 * 一是 `+=` 不是 `*=`（写成倍率的话效率 V 的钻石镐是 8×26 而不是 8+26，
 * 一秒挖穿一条矿道）；二是那个 `f > 1` 意味着**只在工具对口时生效**，
 * 少了它效率就成了万能加速，附了效率的镐挖泥土也飞快。
 *
 * @param toolMatches 调用方传 `toolSpeedAgainst(...) > 1`，与原版的 `f > 1` 同义。
 */
export function miningSpeedBonus(tool: ItemStack, toolMatches: boolean): number {
  if (!toolMatches) return 0;
  const level = levelOf(tool, Enchantment.EFFICIENCY);
  return level > 0 ? level * level + 1 : 0;
}

/**
 * 有没有精准采集。只回答"这把工具带不带这条附魔" ——
 * **"这个方块能不能被精准采集"是方块的事**（原版 `Block.canSilkHarvest`：
 * 矿石、玻璃、草方块可以，刷怪笼不行），那条判断留在调用方的掉落表里。
 * 混进来的话这个纯函数就得认识方块表，而 core/item 不该认识。
 */
export function hasSilkTouch(tool: ItemStack): boolean {
  return levelOf(tool, Enchantment.SILK_TOUCH) > 0;
}

/**
 * 这次使用要不要扣耐久（工具 / 武器 / 弓）。没附魔时恒为 true。
 *
 * `EnchantmentDurability.negateDamage`：`nextInt(level + 1) > 0` 时这次**不扣**。
 * 于是扣的概率是 1/(level+1) —— 耐久 III 只有四分之一的机会掉耐久，寿命约四倍。
 * 这也是原版不把它显示成"+X 耐久"的原因：它改的是概率，不是上限。
 */
export function consumesDurability(item: ItemStack, roll: Roll): boolean {
  const level = levelOf(item, Enchantment.UNBREAKING);
  if (level <= 0) return true;
  return roll(level + 1) === 0;
}

/**
 * 盔甲这次受击要不要扣耐久。没附魔时恒为 true。
 *
 * 盔甲比工具多一道闸门：原版是
 * `if (item instanceof ItemArmor && nextFloat() < 0.6) return false` ——
 * **六成的情况下耐久附魔连生效的机会都没有**。所以耐久 III 的盔甲扣耐久的概率是
 * 0.6 + 0.4×0.25 = 70%，而不是工具那条的 25%；拿工具那条去套盔甲，
 * 一套耐久 III 的钻甲会比原版耐用一倍多。
 *
 * 那 60% 这里写成 `roll(5) < 3`：分布与 `nextFloat() < 0.6` 完全一致，只是消耗的
 * 随机数流不同 —— 本模块只承诺分布一致，不承诺与原版随机序列逐位对齐。
 */
export function consumesArmorDurability(piece: ItemStack, roll: Roll): boolean {
  const level = levelOf(piece, Enchantment.UNBREAKING);
  if (level <= 0) return true;
  if (roll(5) < 3) return true;
  return roll(level + 1) === 0;
}

/**
 * 时运给矿物掉落乘多少倍。没附魔是 1。
 *
 * `BlockOre.quantityDroppedWithBonus`：j = nextInt(level + 2) − 1，j < 0 时按 0，
 * 掉落 = 基础 × (j + 1)。所以时运 III 是 1/1/2/3/4 倍各 1/5 —— **五次里有两次白附**，
 * 上限四倍。写成"保底 +1"或者直接用期望倍率，钻石矿的产出就失真了。
 *
 * 只对"掉落物不是方块自己"的矿石生效（煤、钻石、红石、青金石）；铁矿金矿掉的是
 * 矿石方块本身，时运无效。那条判断在调用方的掉落表里，理由同 hasSilkTouch。
 */
export function fortuneMultiplier(tool: ItemStack, roll: Roll): number {
  const level = levelOf(tool, Enchantment.FORTUNE);
  if (level <= 0) return 1;
  return Math.max(0, roll(level + 2) - 1) + 1;
}

// ---------------------------------------------------------------------------
// 弓：力量 / 冲击 / 火矢 / 无限
// ---------------------------------------------------------------------------

/**
 * 力量给箭伤的倍率。没附魔是 1。
 *
 * **这条是本文件里我最没把握的一条。** 我采信的是 1.0 的 ItemBow 写的
 * `arrow.setDamage(arrow.getDamage() + level * 0.25 + 0.25)`，而 `EntityArrow.damage`
 * 的基准是 2.0（命中伤害 = ceil(速度 × 系数)），换算成倍率就是
 * `1 + 0.25 × (level + 1) / 2`：力量 I = 1.25 倍，力量 V = 1.75 倍。
 *
 * 理由是 1.9 把那句改成了 `+ level * 0.5 + 0.5`（力量 V 到 2.5 倍），而"1.9 加强了弓"
 * 确实发生过，所以 1.0 该是较小的那个系数。但也有资料把 pre-1.9 写成"每级 +25%"
 * （对应 0.5），我没能确认它说的是哪个版本。**复核时只改
 * POWER_DAMAGE_PER_LEVEL 一行即可。**
 *
 * 返回倍率而不是"给系数加多少"：本仓库的箭伤是调用方算好的整数
 * （ArrowEntity.damage），没有"每格速度多少伤害"这个中间量可加。
 */
export function arrowDamageMultiplier(bow: ItemStack): number {
  const level = levelOf(bow, Enchantment.POWER);
  if (level <= 0) return 1;
  return 1 + (POWER_DAMAGE_PER_LEVEL * (level + 1)) / ARROW_BASE_DAMAGE;
}

/**
 * 冲击要给箭额外加几级击退。没附魔是 0。`arrow.setKnockbackStrength(level)`，
 * 与近战击退同一套口径 —— 调用方可以把它和 knockbackLevels 喂给同一个击退函数。
 */
export function punchLevels(bow: ItemStack): number {
  return levelOf(bow, Enchantment.PUNCH);
}

/**
 * 火矢命中后目标着火多少**秒**。没附魔是 0。
 *
 * 这里有个容易抄错的地方：ItemBow 给**箭自己** `setFire(100)`（100 秒，等于
 * "这支箭全程带火"），箭命中时才给**目标** `setFire(5)`。玩家感知到的"烧 5 秒"
 * 是后一个数，抄成 100 的话被射中的羊会烧到死透还在冒烟。
 */
export function flameArrowSeconds(bow: ItemStack): number {
  return levelOf(bow, Enchantment.FLAME) > 0 ? FLAME_ARROW_SECONDS : 0;
}

/**
 * 有没有无限。返回"有没有"而不是"要不要消耗箭"，是为了跟本文件其它函数守同一个
 * 约定：**没附魔一律 false / 0 / 1**。调用方写 `if (!hasInfinity(bow)) consumeArrow()`。
 *
 * 附带一条原版规则，接线时别漏：无限射出去的箭 `canBePickedUp = 2`，也就是
 * **捡不回来**。漏了它，一支箭就能刷出无限支。
 */
export function hasInfinity(bow: ItemStack): boolean {
  return levelOf(bow, Enchantment.INFINITY) > 0;
}
