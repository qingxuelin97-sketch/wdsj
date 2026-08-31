/**
 * Minecraft Java Edition Release 1.0.0 的数值真相来源。
 *
 * 规则：本文件里的每个数字都对应 1.0 的真实行为。任何在两处以上用到的数值都必须放这里，
 * 不许在使用处写字面量 —— 移动手感、挖掘时间、矿物分布这些一旦散落各处就再也对不齐了。
 *
 * 版本边界锚点（用来判断某特性是否属于 1.0）：
 *   最大方块 ID 122（龙蛋） · 最大物品 ID 382（金色闪光西瓜） · 世界高 128 · McRegion 存档
 *   每世界 3 个要塞 · 单人无指令无聊天 · 11 张唱片 · 仅默认世界类型
 */

// ---------------------------------------------------------------------------
// 时间与世界尺度
// ---------------------------------------------------------------------------

/** 每秒 tick 数 */
export const TPS = 20;
/** 每 tick 毫秒数 */
export const MS_PER_TICK = 1000 / TPS;
/** 一整个昼夜 = 24000 tick = 20 分钟 */
export const DAY_LENGTH_TICKS = 24000;
/** 日出结束/白天开始 */
export const TIME_DAY = 0;
/** 日落开始 */
export const TIME_SUNSET = 12000;
/** 夜晚开始（怪物可安全生成） */
export const TIME_NIGHT = 13800;
/** 日出开始 */
export const TIME_SUNRISE = 22200;
/** 可以上床睡觉的时间窗口 */
export const SLEEP_START = 12542;
export const SLEEP_END = 23459;

/** 世界高度。1.0 是 McRegion，128 格；256 是 1.2 的 Anvil 才有的 */
export const WORLD_HEIGHT = 128;
/** 区块水平边长 */
export const CHUNK_SIZE = 16;
/** 子区块边长（立方） */
export const SECTION_SIZE = 16;
/** 每列子区块数 */
export const SECTIONS_PER_COLUMN = WORLD_HEIGHT / SECTION_SIZE; // 8
/** 每个子区块的方块数 */
export const SECTION_VOLUME = SECTION_SIZE * SECTION_SIZE * SECTION_SIZE; // 4096
/** 海平面：最高的水方块在 Y=62 */
export const SEA_LEVEL = 62;
/** 建筑上限 */
export const BUILD_LIMIT = WORLD_HEIGHT - 1; // 127
/** 基岩层厚度（Y 0..4 随机化） */
export const BEDROCK_LAYERS = 5;

// ---------------------------------------------------------------------------
// 玩家物理 —— 这些数值错了，游戏立刻"感觉是假的"
// ---------------------------------------------------------------------------

/** 每 tick 的重力加速度（格/tick²） */
export const GRAVITY = 0.08;
/** 每 tick 的垂直速度阻尼 */
export const DRAG_VERTICAL = 0.98;
/** 跳跃初速度（格/tick），约合 1.25 格高 */
export const JUMP_VELOCITY = 0.42;
/** 行走速度（格/秒） */
export const SPEED_WALK = 4.317;
/** 疾跑速度（格/秒） */
export const SPEED_SPRINT = 5.612;
/** 潜行速度（格/秒） */
export const SPEED_SNEAK = 1.295;
/** 游泳速度（格/秒） */
export const SPEED_SWIM = 2.2;
/** 爬梯速度（格/秒） */
export const SPEED_LADDER = 2.35;
/** 灵魂沙速度系数 */
export const SOUL_SAND_FACTOR = 0.4;
/** 冰面摩擦（普通方块是 0.6） */
export const FRICTION_ICE = 0.98;
export const FRICTION_DEFAULT = 0.6;

/** 玩家碰撞盒 */
export const PLAYER_WIDTH = 0.6;
export const PLAYER_HEIGHT = 1.8;
/** 站立眼高 */
export const EYE_HEIGHT = 1.62;
/** 潜行眼高 */
export const EYE_HEIGHT_SNEAK = 1.54;
/** 自动上台阶高度 */
export const STEP_HEIGHT = 0.6;
/** 生存模式方块触及距离 */
export const REACH_SURVIVAL = 4.5;
/** 创造模式方块触及距离 */
export const REACH_CREATIVE = 5.0;
/** 实体攻击触及距离 */
export const REACH_ENTITY = 3.0;
/** 疾跑所需的最低饥饿值 */
export const SPRINT_MIN_HUNGER = 6;

// ---------------------------------------------------------------------------
// 生命、伤害、战斗
// ---------------------------------------------------------------------------

/** 满生命值（20 = 10 颗心） */
export const MAX_HEALTH = 20;
/** 受击后的无敌帧 */
export const INVULNERABLE_TICKS = 10;
/** 摔落伤害 = ceil(距离 - 这个阈值) */
export const FALL_DAMAGE_THRESHOLD = 3;
/** 空手伤害 */
export const FIST_DAMAGE = 1;
/** 下落中攻击的暴击倍率 */
export const CRIT_MULTIPLIER = 1.5;
/** 水下憋气 tick 数，之后每秒 2 点伤害 */
export const AIR_SUPPLY_TICKS = 300;

/** 各种持续伤害源的间隔与伤害（tick, 伤害） */
export const DAMAGE_FIRE = { interval: 10, amount: 1 } as const;
export const DAMAGE_LAVA = { interval: 10, amount: 4 } as const;
export const DAMAGE_DROWN = { interval: 20, amount: 2 } as const;
export const DAMAGE_SUFFOCATE = { interval: 10, amount: 1 } as const;
export const DAMAGE_CACTUS = { interval: 10, amount: 1 } as const;
export const DAMAGE_VOID = { interval: 10, amount: 4 } as const;
export const DAMAGE_STARVE = { interval: 80, amount: 1 } as const;
export const DAMAGE_LIGHTNING = 5;

/**
 * 药水效果的节奏与强度，照 MC 1.0 的 Potion.java 与 EntityPlayer 取值。
 *
 * "按等级翻倍"在原版里一律写成移位（`25 >> 等级`、`6 << 等级`），
 * 这里保持同一个形状 —— 换成乘除会在 II 级上差出一两点，
 * 而那正是玩家会拿去和 wiki 对照的地方。
 */
export const POTION = {
  /** 中毒每这么多刻掉 1 点血，II 级减半。**毒不死人**，最低留 1 血 */
  poisonInterval: 25,
  /** 再生每这么多刻回 1 点血，II 级减半 */
  regenInterval: 50,
  /** 瞬间治疗/伤害的点数，II 级翻倍 */
  instantAmount: 6,
  /** 力量加的近战伤害，II 级翻倍 */
  strengthBonus: 3,
  /** 虚弱减的近战伤害，II 级翻倍 */
  weaknessPenalty: 2,
} as const;

/** 1.9 之前的盔甲减伤：输出 = 输入 × (25 - 点数) / 25，即每点减 4%，上限 80% */
export const ARMOR_DAMAGE_DIVISOR = 25;
/** 各材质整套盔甲的护甲点数 */
export const ARMOR_POINTS = {
  leather: 7,
  chainmail: 12,
  iron: 15,
  gold: 11,
  diamond: 20,
} as const;

// ---------------------------------------------------------------------------
// 饥饿
// ---------------------------------------------------------------------------

export const MAX_HUNGER = 20;
/** 每累积这么多消耗值，扣 1 点饱和度（饱和为 0 时扣 1 点饥饿） */
export const EXHAUSTION_PER_UNIT = 4.0;
/** 自然回血所需的最低饥饿值 */
export const REGEN_MIN_HUNGER = 18;
/** 自然回血间隔（tick）—— 每 4 秒 1 点 */
export const REGEN_INTERVAL = 80;
/** 各行为的消耗值 */
export const EXHAUSTION = {
  sprintPerMeter: 0.1,
  swimPerMeter: 0.015,
  jump: 0.2,
  sprintJump: 0.8,
  breakBlock: 0.025,
  attack: 0.3,
  damageTaken: 0.3,
  regen: 3.0,
} as const;

// ---------------------------------------------------------------------------
// 挖掘与工具
// ---------------------------------------------------------------------------

/** 对口工具：时间 = 硬度 × 这个系数 / 工具速度 */
export const MINE_TIME_CORRECT_TOOL = 1.5;
/** 徒手或错误工具：时间 = 硬度 × 这个系数 */
export const MINE_TIME_WRONG_TOOL = 5.0;
/** 各材质的挖掘速度倍率 */
export const TOOL_SPEED = { wood: 2, stone: 4, iron: 6, diamond: 8, gold: 12 } as const;
/** 各材质的工具耐久 */
export const TOOL_DURABILITY = { wood: 59, stone: 131, iron: 250, diamond: 1561, gold: 32 } as const;
/** 各材质剑的伤害 */
export const SWORD_DAMAGE = { wood: 4, stone: 5, iron: 6, diamond: 7, gold: 4 } as const;
/** 挖掘进度的裂纹贴图级数 */
export const BREAK_STAGES = 10;

// ---------------------------------------------------------------------------
// 光照
// ---------------------------------------------------------------------------

export const MAX_LIGHT = 15;
/** 各发光方块的亮度 */
export const LIGHT_EMISSION = {
  lava: 15,
  glowstone: 15,
  fire: 15,
  jackOLantern: 15,
  endPortal: 15,
  torch: 14,
  litFurnace: 13,
  netherPortal: 11,
  glowingRedstoneOre: 9,
  redstoneTorch: 7,
  brewingStand: 1,
  brownMushroom: 1,
} as const;
/** 敌对生物生成所需的最高方块光照 */
export const HOSTILE_SPAWN_MAX_LIGHT = 7;
/** 蜘蛛在方块光 ≥ 此值时转为中立 */
export const SPIDER_PASSIVE_LIGHT = 12;

// ---------------------------------------------------------------------------
// 流体
// ---------------------------------------------------------------------------

/** 水平流动格数 */
export const FLUID_SPREAD_WATER = 7;
export const FLUID_SPREAD_LAVA_OVERWORLD = 3;
export const FLUID_SPREAD_LAVA_NETHER = 7;
/** 流动更新间隔（tick） */
export const FLUID_TICK_WATER = 5;
export const FLUID_TICK_LAVA_OVERWORLD = 30;
export const FLUID_TICK_LAVA_NETHER = 10;

// ---------------------------------------------------------------------------
// 熔炼与爆炸
// ---------------------------------------------------------------------------

/** 一次熔炼耗时 */
export const SMELT_TICKS = 200;
/** 各燃料的燃烧 tick 数 */
export const FUEL_TICKS = {
  coal: 1600,
  charcoal: 1600,
  planks: 300,
  log: 300,
  stick: 100,
  sapling: 100,
  lavaBucket: 20000,
} as const;

/** TNT */
export const TNT_FUSE_TICKS = 80;
export const TNT_POWER = 4;
/** 苦力怕 */
export const CREEPER_FUSE_TICKS = 30;
export const CREEPER_POWER = 3;
export const CREEPER_CHARGED_POWER = 6;
/** 末影水晶被摧毁时的爆炸威力 */
export const ENDER_CRYSTAL_POWER = 6;
/** 爆炸后方块掉落的概率 */
export const EXPLOSION_DROP_CHANCE = 0.3;

// ---------------------------------------------------------------------------
// 生物生成
// ---------------------------------------------------------------------------

/** 全世界生物上限（1.0 是按世界算，不是按玩家算） */
export const MOB_CAP = { monster: 70, animal: 15, water: 5 } as const;
/** 敌对生物不会生成在离玩家这么近的范围内 */
export const SPAWN_MIN_PLAYER_DISTANCE = 24;
/** 超过这个距离立刻消失 */
export const DESPAWN_INSTANT_DISTANCE = 128;
/** 32~128 格之间每 tick 的随机消失概率 */
export const DESPAWN_RANDOM_CHANCE = 1 / 800;

// ---------------------------------------------------------------------------
// 世界生成：矿物分布
// ---------------------------------------------------------------------------

/** 一条矿脉的生成参数 */
export interface OreSpec {
  /** 单条矿脉的方块数 */
  readonly size: number;
  /** 每区块尝试几条 */
  readonly count: number;
  /** 最低 Y（含） */
  readonly minY: number;
  /** 最高 Y（含） */
  readonly maxY: number;
  /** 三角分布时的峰值 Y；不填则为均匀分布 */
  readonly triangularPeak?: number;
}

/**
 * 1.0 的矿物分布表。"Y=11 挖矿"这条元游戏必须成立，所以这张表是逐字复刻的。
 * 泥土和沙砾也走同一套矿脉生成器。
 */
export const ORE_DISTRIBUTION = {
  dirt: { size: 32, count: 20, minY: 0, maxY: 127 },
  gravel: { size: 32, count: 10, minY: 0, maxY: 127 },
  coal: { size: 16, count: 20, minY: 0, maxY: 127 },
  iron: { size: 8, count: 20, minY: 0, maxY: 63 },
  gold: { size: 8, count: 2, minY: 0, maxY: 31 },
  redstone: { size: 7, count: 8, minY: 0, maxY: 15 },
  diamond: { size: 7, count: 1, minY: 0, maxY: 15 },
  lapis: { size: 6, count: 1, minY: 0, maxY: 31, triangularPeak: 16 },
} as const satisfies Record<string, OreSpec>;

/** 峡谷生成概率：约每 50 个区块一条 */
export const RAVINE_CHANCE = 1 / 50;
/** 地牢：每区块尝试 8 次 */
export const DUNGEON_ATTEMPTS_PER_CHUNK = 8;
/** 每个世界的要塞数量 —— 1.0 是恰好 3 个 */
export const STRONGHOLD_COUNT = 3;
/** 要塞环带距出生点的距离范围 */
export const STRONGHOLD_RING = { min: 640, max: 1152 } as const;

// ---------------------------------------------------------------------------
// 维度
// ---------------------------------------------------------------------------

/** 下界与主世界的坐标比 */
export const NETHER_SCALE = 8;
/** 下界岩浆海平面 */
export const NETHER_LAVA_LEVEL = 31;
/** 站在传送门里多久触发传送 */
export const PORTAL_DELAY_TICKS = 80;
/** 末地：黑曜石柱数量与环半径 */
export const END_PILLAR_COUNT = 10;
export const END_PILLAR_RADIUS = 43;
/** 末影龙 */
export const ENDER_DRAGON_HEALTH = 200;
export const ENDER_DRAGON_XP = 20000;

// ---------------------------------------------------------------------------
// 渲染 / 客户端预算（不是 MC 数值，是本实现的工程约束）
// ---------------------------------------------------------------------------

/** 网格 worker 传给主线程的邻域边长：16 + 两侧各 1 格 */
export const MESH_PADDED_SIZE = SECTION_SIZE + 2; // 18
/** 每顶点字节数：3 × uint32 */
export const VERTEX_BYTES = 12;
/** 网格显存预算，超了就淘汰远处的网格（体素数据保留，重新网格化很便宜） */
export const MESH_BUDGET_BYTES = 192 * 1024 * 1024;
/** worker 硬上限。本机空闲内存只有约 4.4 GB，绝不超过 */
export const MAX_WORKERS_TOTAL = 6;
/** 默认渲染距离（区块） */
export const DEFAULT_RENDER_DISTANCE = 8;
