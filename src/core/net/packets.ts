/**
 * 协议定义。
 *
 * 这是客户端与服务端之间**唯一**的通信面。如果它长到 40 个包以上，说明有东西
 * 从边界渗漏了（比如客户端开始想直接读服务端的内部状态）—— 那时该回头看架构，
 * 而不是继续加包。
 *
 * 复杂载荷（区块数据、容器内容）走 `bytes` 字段 + 专门的编解码函数，
 * 见 core/world/chunk-codec.ts。
 */
import { definePacket, PacketRegistry, type Payload } from './schema.ts';

// ---------------------------------------------------------------------------
// 客户端 -> 服务端
// ---------------------------------------------------------------------------

export const C2S = new PacketRegistry();

/** 握手：客户端自报协议版本与玩家名 */
export const C_Handshake = C2S.add(
  definePacket(0x01, 'C_Handshake', [
    ['protocolVersion', 'u16'],
    ['playerName', 'str'],
  ]),
);

/** 玩家移动。seq 用于服务端和解时定位到具体哪一帧输入 */
export const C_PlayerMove = C2S.add(
  definePacket(0x02, 'C_PlayerMove', [
    ['seq', 'u32'],
    ['x', 'f64'],
    ['y', 'f64'],
    ['z', 'f64'],
    ['yaw', 'f32'],
    ['pitch', 'f32'],
    ['onGround', 'bool'],
    ['sneaking', 'bool'],
    ['sprinting', 'bool'],
  ]),
);

/**
 * 玩家对方块的动作。
 * action: 0=开始挖 1=取消挖 2=挖掘完成 3=丢弃物品 4=丢弃整组
 */
export const C_PlayerAction = C2S.add(
  definePacket(0x03, 'C_PlayerAction', [
    ['action', 'u8'],
    ['x', 'i32'],
    ['y', 'i32'],
    ['z', 'i32'],
    ['face', 'u8'],
  ]),
);

/**
 * 攻击一个实体。
 *
 * 单独一个包而不是复用 C_PlayerAction：那个包的载荷是方块坐标，
 * 硬塞一个实体 id 进去会让两种含义共用同一组字段 ——
 * 而"同一个字段在不同情况下是不同的东西"正是协议最容易腐化的地方。
 */
export const C_AttackEntity = C2S.add(
  definePacket(0x0c, 'C_AttackEntity', [['entityId', 'u32']]),
);

/** 对方块使用手上的物品（放置 / 右键交互） */
export const C_UseBlock = C2S.add(
  definePacket(0x04, 'C_UseBlock', [
    ['x', 'i32'],
    ['y', 'i32'],
    ['z', 'i32'],
    ['face', 'u8'],
    ['hitX', 'f32'],
    ['hitY', 'f32'],
    ['hitZ', 'f32'],
  ]),
);

/** 切换手持槽位 */
export const C_HeldSlot = C2S.add(
  definePacket(0x05, 'C_HeldSlot', [['slot', 'u8']]),
);

/** 挥手动画 */
export const C_Swing = C2S.add(definePacket(0x06, 'C_Swing', []));

/** 设置渲染距离，服务端据此决定推送哪些区块 */
export const C_SetViewDistance = C2S.add(
  definePacket(0x07, 'C_SetViewDistance', [['distance', 'u8']]),
);

/** 调试/测试指令，供 __mc 使用 */
export const C_Command = C2S.add(
  definePacket(0x08, 'C_Command', [
    ['requestId', 'u32'],
    ['text', 'str'],
  ]),
);

/**
 * 点击容器里的一个槽位。
 *
 * 客户端**不自己改物品栏**：点了之后等服务端把结果发回来。
 * 本地预测物品栏在单人下没有收益（延迟是微秒级），却会引入
 * "客户端以为合成了、服务端说没有"这类极难查的分叉。
 */
export const C_WindowClick = C2S.add(
  definePacket(0x0a, 'C_WindowClick', [
    ['windowId', 'u8'],
    ['slot', 'i16'],
    ['button', 'u8'],
    ['shift', 'bool'],
  ]),
);

/** 关闭当前打开的界面 */
export const C_CloseWindow = C2S.add(
  definePacket(0x0b, 'C_CloseWindow', [['windowId', 'u8']]),
);

export const C_KeepAlive = C2S.add(
  definePacket(0x09, 'C_KeepAlive', [['time', 'i64']]),
);

// ---------------------------------------------------------------------------
// 服务端 -> 客户端
// ---------------------------------------------------------------------------

export const S2C = new PacketRegistry();

/** 登录成功，告知玩家实体 id、维度与出生点 */
export const S_Login = S2C.add(
  definePacket(0x80, 'S_Login', [
    ['entityId', 'u32'],
    ['dimension', 'i8'],
    ['gameMode', 'u8'],
    ['seed', 'i64'],
    ['spawnX', 'f64'],
    ['spawnY', 'f64'],
    ['spawnZ', 'f64'],
  ]),
);

/**
 * 一整列区块的数据。
 * blob 的格式见 core/world/chunk-codec.ts 的 encodeChunk。
 */
export const S_ChunkData = S2C.add(
  definePacket(0x81, 'S_ChunkData', [
    ['cx', 'i32'],
    ['cz', 'i32'],
    ['blob', 'bytes'],
  ]),
);

/** 卸载一列区块 */
export const S_ChunkUnload = S2C.add(
  definePacket(0x82, 'S_ChunkUnload', [
    ['cx', 'i32'],
    ['cz', 'i32'],
  ]),
);

/** 单个方块变更 */
export const S_BlockUpdate = S2C.add(
  definePacket(0x83, 'S_BlockUpdate', [
    ['x', 'i32'],
    ['y', 'i32'],
    ['z', 'i32'],
    ['state', 'u16'],
  ]),
);

/**
 * 一个子区块内的批量方块变更 + 光照增量。
 * blob 格式：u16 count，然后每项 u16 位置(y<<8|z<<4|x) + u16 状态；
 * 之后 u16 lightCount，每项 u16 位置 + u8 光照。
 */
export const S_SectionUpdate = S2C.add(
  definePacket(0x84, 'S_SectionUpdate', [
    ['cx', 'i32'],
    ['cy', 'u8'],
    ['cz', 'i32'],
    ['blob', 'bytes'],
  ]),
);

/** 世界时间。服务端是时间的唯一权威 */
/**
 * 换维度。
 *
 * 客户端收到之后必须**把整个世界镜像扔掉**再重建 —— 区块坐标在两个
 * 维度里是重叠的（下界的 (0,0) 和主世界的 (0,0) 都存在），不清空的话
 * 新维度的区块会一块一块盖在旧的上面，而没被盖到的地方还留着主世界的
 * 地形。症状是"下界里有一片草地"，看起来像生成器疯了。
 *
 * 位置一并带上：换维度必然伴随传送，分成两个包发的话中间那一刻
 * 客户端会拿新维度的地形去判旧坐标的碰撞。
 */
export const S_ChangeDimension = S2C.add(
  definePacket(0x9b, 'S_ChangeDimension', [
    ['dimension', 'i8'],
    ['x', 'f64'],
    ['y', 'f64'],
    ['z', 'f64'],
    ['yaw', 'f32'],
  ]),
);

export const S_TimeUpdate = S2C.add(
  definePacket(0x85, 'S_TimeUpdate', [
    ['worldAge', 'i64'],
    ['timeOfDay', 'i64'],
  ]),
);

/**
 * 天气。只在**变化时**发，不每刻发。
 *
 * 强度用 u8 的 0..100 而不是 f32：这个值唯一的用途是渲染雨的密度和
 * 压暗天色，1% 的分辨率绰绰有余，省下的三个字节乘以在线人数乘以每次变化。
 *
 * 客户端拿到之后**自己每帧插值**吗？不。强度已经是服务端平滑过的
 * （每刻 ±0.01），照着用就行 —— 客户端再插一次会让两边对不上，
 * 而"雨有多大"是会影响刷怪判据的，必须一致。
 */
export const S_Weather = S2C.add(
  definePacket(0x98, 'S_Weather', [
    ['rain', 'u8'],
    ['thunder', 'u8'],
  ]),
);

/**
 * 爆炸发生在哪、多大。
 *
 * 位置必须带上。原来复用的是 S_EntityEvent(event=2)，它只有 entityId ——
 * 客户端只能知道"炸了"，不知道炸在哪，于是声音没有方位、粒子无处可放。
 * 而 TNT 炸的时候那个源实体已经不存在了，连个能查坐标的东西都没有。
 */
export const S_Explosion = S2C.add(
  definePacket(0x9a, 'S_Explosion', [
    ['x', 'f32'],
    ['y', 'f32'],
    ['z', 'f32'],
    ['power', 'f32'],
  ]),
);

/** 闪电劈在哪。客户端据此放一道光和一声雷 */
export const S_Lightning = S2C.add(
  definePacket(0x99, 'S_Lightning', [
    ['x', 'i32'],
    ['y', 'i32'],
    ['z', 'i32'],
  ]),
);

/** 强制设置玩家位置（传送、和解失败时的纠正） */
export const S_PlayerPosLook = S2C.add(
  definePacket(0x86, 'S_PlayerPosLook', [
    ['seq', 'u32'],
    ['x', 'f64'],
    ['y', 'f64'],
    ['z', 'f64'],
    ['yaw', 'f32'],
    ['pitch', 'f32'],
    ['onGround', 'bool'],
  ]),
);

export const S_Health = S2C.add(
  definePacket(0x87, 'S_Health', [
    ['health', 'f32'],
    ['food', 'u8'],
    ['saturation', 'f32'],
  ]),
);

/** 通用提示/聊天 */
export const S_Chat = S2C.add(
  definePacket(0x88, 'S_Chat', [['text', 'str']]),
);

/**
 * 整个窗口的物品，一次全发。
 *
 * 不做增量：一个窗口最多几十格，每格 6 字节，全量也就两百来字节，
 * 而增量同步要维护"客户端以为是什么"的影子状态 —— 那是物品栏 bug
 * 最经典的来源（影子状态和真状态一旦漂移，表现是物品凭空出现或消失）。
 */
export const S_WindowItems = S2C.add(
  definePacket(0x8d, 'S_WindowItems', [
    ['windowId', 'u8'],
    /** 每格 3 个 i32：id / count / damage。手上拿的那一堆排在最后 */
    ['slots', 'bytes'],
  ]),
);

/** 打开一个容器界面 */
export const S_OpenWindow = S2C.add(
  definePacket(0x8e, 'S_OpenWindow', [
    ['windowId', 'u8'],
    ['kind', 'u8'],
    ['title', 'str'],
  ]),
);

/** 关闭界面（服务端主动，比如箱子被挖了） */
export const S_CloseWindow = S2C.add(
  definePacket(0x8f, 'S_CloseWindow', [['windowId', 'u8']]),
);

/** 指令回执，与 C_Command 的 requestId 对应 */
export const S_CommandResult = S2C.add(
  definePacket(0x89, 'S_CommandResult', [
    ['requestId', 'u32'],
    ['ok', 'bool'],
    ['text', 'str'],
  ]),
);

export const S_Disconnect = S2C.add(
  definePacket(0x8a, 'S_Disconnect', [['reason', 'str']]),
);

export const S_KeepAlive = S2C.add(
  definePacket(0x8b, 'S_KeepAlive', [['time', 'i64']]),
);

/**
 * 服务端运行状态。
 *
 * 服务端搬进 Worker 之后，主线程再也无法直接读到它的内部状态 ——
 * 而自动化测试需要知道"世界是否已经流式加载完毕"（只看客户端的网格化队列不够，
 * 服务端可能还在一批批地推）。F3 调试面板也要用它显示真实 TPS。
 */
export const S_ServerStats = S2C.add(
  definePacket(0x8c, 'S_ServerStats', [
    ['tick', 'u32'],
    ['pendingChunks', 'u16'],
    ['loadedChunks', 'u16'],
    /** 最近一次 tick 的耗时，单位 0.01 毫秒 */
    ['tickMicros', 'u16'],
  ]),
);

/**
 * 一批掉落物的出现与移动。
 *
 * 合成一个包发，而不是每个实体一个包：一次爆炸或者一棵树砍完，
 * 一刻之内能冒出几十个掉落物，逐个发会让包头的开销超过载荷本身。
 *
 * 坐标用 i32 的 1/32 格定点数而不是 f64：掉落物差半个像素没人看得出来，
 * 但每个实体每 tick 省下 12 字节。
 */
export const S_SpawnItems = S2C.add(
  definePacket(0x90, 'S_SpawnItems', [
    /** 每项 20 字节：entityId(u32) x(i32) y(i32) z(i32) itemId(u16) count(u8) damage(u8) */
    ['entries', 'bytes'],
  ]),
);

/** 掉落物的位置更新。每项 16 字节：entityId(u32) x(i32) y(i32) z(i32) */
export const S_EntityMoves = S2C.add(
  definePacket(0x91, 'S_EntityMoves', [
    ['entries', 'bytes'],
  ]),
);

/** 实体消失（被捡走、过期、区块卸载）。每项 4 字节的 entityId */
export const S_DestroyEntities = S2C.add(
  definePacket(0x92, 'S_DestroyEntities', [
    ['entries', 'bytes'],
  ]),
);

/**
 * 容器的进度条数值（熔炉的火焰与箭头）。
 *
 * 单独一个包而不是塞进 S_WindowItems：燃烧时间每刻都在变，而容器内容
 * 一分钟也未必动一次。合在一起发的话，开着熔炉就等于每刻重发 46 个格子。
 */
export const S_WindowProgress = S2C.add(
  definePacket(0x93, 'S_WindowProgress', [
    ['windowId', 'u8'],
    ['burnTime', 'u16'],
    ['burnTotal', 'u16'],
    ['cookTime', 'u16'],
  ]),
);

/**
 * 附魔台的三个报价。
 *
 * 单独一个包而不是复用 S_WindowProgress：那个包的三个字段叫
 * burnTime/burnTotal/cookTime，塞进"三个附魔等级"能跑，
 * 但读代码的人下一次会以为附魔台在烧煤。
 *
 * 0 表示这个槽没得选（台子上没放东西，或者玩家等级不够）。
 */
export const S_EnchantOffers = S2C.add(
  definePacket(0x9c, 'S_EnchantOffers', [
    ['windowId', 'u8'],
    ['a', 'u8'],
    ['b', 'u8'],
    ['c', 'u8'],
  ]),
);

/** 玩家点了附魔台的第 slot 个选项（0..2） */
export const C_EnchantSelect = C2S.add(
  definePacket(0x0e, 'C_EnchantSelect', [
    ['windowId', 'u8'],
    ['slot', 'u8'],
  ]),
);

/**
 * 一批生物的出现。
 *
 * 每项 23 字节：entityId(u32) type(u8) variant(u8) x/y/z(i32×3)
 * yaw(i16) headYaw(i16) health(u8)。
 * 朝向用 1/1000 弧度的定点数 —— 生物转头差千分之一弧度没人看得出来。
 */
export const S_SpawnMobs = S2C.add(
  definePacket(0x94, 'S_SpawnMobs', [['entries', 'bytes']]),
);

/**
 * 生物的位置与状态。
 *
 * 每项 22 字节：entityId(u32) x/y/z(i32×3) yaw(i16) headYaw(i16)
 * flags(u8) health(u8)。flags 位：1 受伤闪红 / 2 着火 / 4 苦力怕鼓起 / 8 正在死。
 * 这几位都是**表现**用的，客户端拿它决定怎么画，不参与任何判定。
 */
export const S_MobMoves = S2C.add(
  definePacket(0x95, 'S_MobMoves', [['entries', 'bytes']]),
);

/** 生物受伤 / 死亡的音效与粒子提示 */
export const S_EntityEvent = S2C.add(
  definePacket(0x96, 'S_EntityEvent', [
    ['entityId', 'u32'],
    /** 0 = 受伤，1 = 死亡，2 = 爆炸 */
    ['event', 'u8'],
  ]),
);

/**
 * 玩家的生存状态：血、饥饿、氧气、经验。
 *
 * 合成一个包发，因为它们**一起变**：挨一下打会同时改血量与消耗，
 * 而消耗又可能改饥饿。分成几个包发的话，客户端会在同一帧里画出
 * "血掉了但饥饿还没掉"的中间态。
 */
export const S_PlayerHealth = S2C.add(
  definePacket(0x97, 'S_PlayerHealth', [
    ['health', 'u8'],
    ['maxHealth', 'u8'],
    ['hunger', 'u8'],
    /** 剩余氧气，0..20 的气泡数 */
    ['air', 'u8'],
    ['xpLevel', 'u8'],
    /** 当前等级的进度，0..255 */
    ['xpProgress', 'u8'],
  ]),
);

/** 客户端请求重生 */
export const C_Respawn = C2S.add(definePacket(0x0d, 'C_Respawn', []));

/** S_SpawnMobs 里每项的字节数 */
export const SPAWN_MOB_STRIDE = 23;
/** S_MobMoves 里每项的字节数 */
export const MOB_MOVE_STRIDE = 22;

/** 掉落物坐标的定点数精度：1/32 格 */
export const ENTITY_POS_SCALE = 32;
/** S_SpawnItems 里每项的字节数 */
export const SPAWN_ITEM_STRIDE = 20;
/** S_EntityMoves 里每项的字节数 */
export const ENTITY_MOVE_STRIDE = 16;

// ---------------------------------------------------------------------------
// 便捷类型别名
// ---------------------------------------------------------------------------

export type HandshakePayload = Payload<typeof C_Handshake.schema>;
export type PlayerMovePayload = Payload<typeof C_PlayerMove.schema>;
export type PlayerActionPayload = Payload<typeof C_PlayerAction.schema>;
export type UseBlockPayload = Payload<typeof C_UseBlock.schema>;
export type CommandPayload = Payload<typeof C_Command.schema>;
export type ChunkDataPayload = Payload<typeof S_ChunkData.schema>;
export type LoginPayload = Payload<typeof S_Login.schema>;

/** 当前协议版本。客户端与服务端不一致时直接拒绝连接 */
export const PROTOCOL_VERSION = 1;

/** 玩家动作编号 */
/** 容器界面的种类，决定客户端画哪个布局 */
export const WindowKind = {
  /** 玩家背包，带 2×2 合成 */
  INVENTORY: 0,
  /** 工作台，3×3 合成 */
  CRAFTING: 1,
  /** 熔炉 */
  FURNACE: 2,
  /** 箱子 */
  CHEST: 3,
  /** 附魔台：一格放装备 + 三个报价 */
  ENCHANTING: 4,
  /** 酿造台：三个瓶位 + 一格材料 */
  BREWING: 5,
} as const;
export type WindowKind = (typeof WindowKind)[keyof typeof WindowKind];

export const PlayerActionKind = {
  START_DIG: 0,
  CANCEL_DIG: 1,
  FINISH_DIG: 2,
  DROP_ITEM: 3,
  /** 打开背包界面。窗口由服务端建，客户端只是请求 */
  OPEN_INVENTORY: 5,
  DROP_STACK: 4,
} as const;
export type PlayerActionKind = (typeof PlayerActionKind)[keyof typeof PlayerActionKind];
