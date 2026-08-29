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
export const S_TimeUpdate = S2C.add(
  definePacket(0x85, 'S_TimeUpdate', [
    ['worldAge', 'i64'],
    ['timeOfDay', 'i64'],
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
export const PlayerActionKind = {
  START_DIG: 0,
  CANCEL_DIG: 1,
  FINISH_DIG: 2,
  DROP_ITEM: 3,
  DROP_STACK: 4,
} as const;
export type PlayerActionKind = (typeof PlayerActionKind)[keyof typeof PlayerActionKind];
