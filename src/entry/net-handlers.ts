/**
 * 服务端来包的分发。
 *
 * 从 client-main.ts 里分出来的（那个文件到了 648 行、越过 600 硬上限）。
 * 分界线很自然：这是**客户端状态的唯一外部驱动源**。区块、方块、时间、
 * 物品栏、掉落物 —— 客户端的世界镜像只会因为这里的某一条 case 而改变
 * （docs/RULES.md 第 8 条）。把它们聚在一个文件里，"客户端还能从哪改世界"
 * 这个问题就只有一个地方要看。
 *
 * 依赖用一个显式的上下文对象传进来，不用闭包：谁能被包驱动，签名上写着。
 */
import type { PacketChannel } from '../core/net/transport.ts';
import {
  WindowKind, ENTITY_POS_SCALE, SPAWN_ITEM_STRIDE, ENTITY_MOVE_STRIDE,
  SPAWN_MOB_STRIDE, MOB_MOVE_STRIDE,
} from '../core/net/packets.ts';
import { stateId } from '../core/world/chunk.ts';
import type { ClientWorld } from '../client/world/client-world.ts';
import type { ClientEntities } from '../client/entity/client-entities.ts';
import type { ClientMobs } from '../client/entity/client-mobs.ts';
import type { UiController } from '../client/ui/ui-controller.ts';
import type { ChunkRenderer } from '../client/render/chunk-renderer.ts';
import type { Interaction } from '../client/player/interaction.ts';
import type { ItemStack } from '../core/item/item-def.ts';

export interface PacketContext {
  readonly world: ClientWorld;
  readonly entities: ClientEntities;
  readonly mobs: ClientMobs;
  readonly ui: UiController;
  readonly renderer: ChunkRenderer;
  readonly interaction: Interaction;
  /** 把玩家与相机放到出生点 */
  onLogin(x: number, y: number, z: number): void;
  /** 世界时间更新 */
  onTime(worldAge: number, timeOfDay: number): void;
  /** 天气变了。rain/thunder 是 0..1，服务端已经平滑过，客户端照用即可 */
  onWeather(rain: number, thunder: number): void;
  /** 闪电劈在某处 */
  onLightning(x: number, y: number, z: number): void;
  /** 爆炸发生在某处 */
  onExplosion(x: number, y: number, z: number, power: number): void;
  /** 服务端状态上报 */
  onServerStats(tick: number, pending: number, loaded: number, tickMs: number): void;
  /** 指令回执 */
  onCommandResult(requestId: number, ok: boolean, text: string): void;
  /** 从网络包里解出槽位数组 */
  decodeSlots(bytes: Uint8Array): ItemStack[];
  /** 生物受伤 / 死亡 / 爆炸，用来放音效与粒子 */
  onEntityEvent(entityId: number, event: number): void;
  /** 玩家的生存状态变了：血、饥饿、氧气、经验 */
  onHealth(v: {
    health: number; maxHealth: number; hunger: number;
    air: number; xpLevel: number; xpProgress: number;
  }): void;
  /** 有窗口打开时要解除指针锁 */
  releasePointer(): void;
  recordError(msg: string): void;
}

export function installPacketHandlers(net: PacketChannel, ctx: PacketContext): void {
  net.onPacket((name, value) => {
    switch (name) {
      case 'S_Login': {
        const sx = value['spawnX'] as number;
        const sy = value['spawnY'] as number;
        const sz = value['spawnZ'] as number;
        // 相机和**身体**都要放到出生点。只挪相机的话，物理下一帧就会
        // 把相机拽回身体所在的位置（世界原点上空），表现为一出生就掉进虚空
        ctx.onLogin(sx, sy, sz);
        console.log(`[net] 登录成功，出生点 ${sx.toFixed(1)} ${sy.toFixed(1)} ${sz.toFixed(1)}`);
        return;
      }
      case 'S_ChunkData':
        ctx.world.onChunkData(value['cx'] as number, value['cz'] as number, value['blob'] as Uint8Array);
        return;
      case 'S_ChunkUnload': {
        const cx = value['cx'] as number;
        const cz = value['cz'] as number;
        ctx.world.onChunkUnload(cx, cz);
        for (let cy = 0; cy < 8; cy++) ctx.renderer.remove(cx, cy, cz);
        return;
      }
      case 'S_BlockUpdate': {
        const bx = value['x'] as number;
        const by = value['y'] as number;
        const bz = value['z'] as number;
        const newState = value['state'] as number;
        const oldId = stateId(ctx.world.store.getState(bx, by, bz));
        ctx.world.onBlockUpdate(bx, by, bz, newState);

        // 破坏：炸一把碎屑 + 一声破坏音。
        // 挂在 S_BlockUpdate 上而不是本地挖掘逻辑里，这样别人挖的方块
        // 也一样有碎屑和声音 —— 多人时这一条是"世界是活的"的主要来源。
        if (oldId !== 0 && stateId(newState) === 0) ctx.interaction.onBlockBroken(bx, by, bz, oldId);
        return;
      }
      case 'S_Weather':
        // 服务端发的是 0..100 的整数，这里还原成 0..1
        ctx.onWeather((value['rain'] as number) / 100, (value['thunder'] as number) / 100);
        return;
      case 'S_Explosion':
        ctx.onExplosion(
          value['x'] as number, value['y'] as number,
          value['z'] as number, value['power'] as number,
        );
        return;
      case 'S_Lightning':
        ctx.onLightning(value['x'] as number, value['y'] as number, value['z'] as number);
        return;
      case 'S_TimeUpdate':
        ctx.onTime(Number(value['worldAge'] as bigint), Number(value['timeOfDay'] as bigint));
        return;
      case 'S_CommandResult': {
        ctx.onCommandResult(
          value['requestId'] as number, value['ok'] as boolean, value['text'] as string,
        );
        return;
      }
      case 'S_WindowItems':
        ctx.ui.onWindowItems(value['windowId'] as number, ctx.decodeSlots(value['slots'] as Uint8Array));
        return;
      case 'S_OpenWindow': {
        const kind = value['kind'] as WindowKind;
        // 外部容器的格数：箱子 27，熔炉 3，其余 0
        const external = kind === WindowKind.CHEST ? 27 : kind === WindowKind.FURNACE ? 3 : 0;
        ctx.ui.onOpenWindow(value['windowId'] as number, kind, external);
        ctx.releasePointer();
        return;
      }
      case 'S_CloseWindow':
        ctx.ui.onCloseWindow();
        return;
      case 'S_SpawnItems':
        ctx.entities.onSpawn(value['entries'] as Uint8Array, SPAWN_ITEM_STRIDE, ENTITY_POS_SCALE);
        return;
      case 'S_EntityMoves':
        ctx.entities.onMove(value['entries'] as Uint8Array, ENTITY_MOVE_STRIDE, ENTITY_POS_SCALE);
        return;
      case 'S_DestroyEntities':
        // 掉落物与生物共用一条销毁通道：id 是全局唯一的，两边各删一次即可
        ctx.entities.onDestroy(value['entries'] as Uint8Array);
        ctx.mobs.onDestroy(value['entries'] as Uint8Array);
        return;
      case 'S_SpawnMobs':
        ctx.mobs.onSpawn(value['entries'] as Uint8Array, SPAWN_MOB_STRIDE, ENTITY_POS_SCALE);
        return;
      case 'S_MobMoves':
        ctx.mobs.onMove(value['entries'] as Uint8Array, MOB_MOVE_STRIDE, ENTITY_POS_SCALE);
        return;
      case 'S_EntityEvent':
        ctx.onEntityEvent(value['entityId'] as number, value['event'] as number);
        return;
      case 'S_PlayerHealth':
        ctx.onHealth({
          health: value['health'] as number,
          maxHealth: value['maxHealth'] as number,
          hunger: value['hunger'] as number,
          air: value['air'] as number,
          xpLevel: value['xpLevel'] as number,
          xpProgress: value['xpProgress'] as number,
        });
        return;
      case 'S_WindowProgress':
        ctx.ui.onWindowProgress(
          value['windowId'] as number,
          value['burnTime'] as number,
          value['burnTotal'] as number,
          value['cookTime'] as number,
        );
        return;
      case 'S_ServerStats':
        ctx.onServerStats(
          value['tick'] as number,
          value['pendingChunks'] as number,
          value['loadedChunks'] as number,
          (value['tickMicros'] as number) / 100,
        );
        return;
      case 'S_Chat':
        console.log(`[chat] ${value['text'] as string}`);
        return;
      case 'S_Disconnect': {
        const reason = value['reason'] as string;
        console.error(`[net] 被断开: ${reason}`);
        ctx.recordError(`断开: ${reason}`);
        return;
      }
      default:
        return;
    }
  });
}
