/**
 * 服务端指令。
 *
 * 从 server-core 里分出来的：那个文件顶到了 600 行的硬上限。
 * 分界线很自然 —— 指令是**自动化与调试的入口**，不是游戏逻辑的一部分，
 * 正常游玩一条都不会走到。
 *
 * 所有指令都必须能安全地接收垃圾输入：`__mc` 与测试会往这里灌各种东西，
 * 一条坏指令把服务端打挂的话，整套自动化就瞎了。
 */
import type { ServerCore } from './server-core.ts';
import type { ServerPlayer } from './player/server-player.ts';
import { S_CommandResult, S_TimeUpdate, WindowKind } from '../core/net/packets.ts';
import { AIR_STATE, packState, stateId } from '../core/world/chunk.ts';
import { makeStack } from '../core/item/item-def.ts';
import { giveToPlayer, syncInventory, showWindow } from './player/inventory-actions.ts';
import { SECTIONS_PER_COLUMN } from '../core/constants.ts';

export function handleCommand(
core: ServerCore,
player: ServerPlayer,
value: Record<string, unknown>,
): void {
  const requestId = value['requestId'] as number;
  const text = String(value['text'] ?? '');
  const reply = (ok: boolean, msg: string): void => {
    player.channel.send(S_CommandResult, { requestId, ok, text: msg });
  };

  const parts = text.trim().split(/\s+/);
  const cmd = parts[0] ?? '';
  try {
    switch (cmd) {
      case 'setblock': {
        const [, sx, sy, sz, blockName] = parts;
        const state = packState(core.registry.idOf(String(blockName)));
        const ok = core.world.setBlock(Number(sx), Number(sy), Number(sz), state);
        reply(ok, ok ? 'ok' : '区块未加载');
        return;
      }
      case 'getblock': {
        const [, sx, sy, sz] = parts;
        const state = core.world.getBlock(Number(sx), Number(sy), Number(sz));
        const id = state & 0xfff;
        reply(true, core.registry.get(id)?.name ?? `未知(${id})`);
        return;
      }
      case 'tp': {
        const [, sx, sy, sz] = parts;
        player.x = Number(sx);
        player.y = Number(sy);
        player.z = Number(sz);
        player.resetSubscriptions();
        reply(true, 'ok');
        return;
      }
      case 'time': {
        const [, sub, val] = parts;
        if (sub === 'set') {
          core.world.timeOfDay = ((Number(val) % 24000) + 24000) % 24000;
        } else if (sub === 'hold') {
          core.world.daylightCycle = val !== '1' && val !== 'true';
        }
        // 立刻回传一次，不等下一个同步周期 —— 自动化就是靠这个知道设定生效了
        for (const p of core.playersForTest()) {
          p.channel.send(S_TimeUpdate, {
            worldAge: BigInt(core.world.worldAge),
            timeOfDay: BigInt(core.world.timeOfDay),
          });
        }
        reply(true, String(core.world.timeOfDay));
        return;
      }
      case 'light': {
        const [, sx, sy, sz] = parts;
        const x = Number(sx), y = Number(sy), z = Number(sz);
        reply(true, `${core.world.store.getSkyLight(x, y, z)}/${core.world.store.getBlockLight(x, y, z)}`);
        return;
      }
      case 'settled': {
        // 自动化用：一次**同步**的服务端状态查询。
        //
        // 不能用 S_ServerStats 代替 —— 那是每隔若干 tick 才发一次的，
        // 相机刚移动完时客户端手里还是移动**之前**的那份统计，
        // 会读到"没有待推送区块"而误判世界已就绪，然后在截图中途
        // 才把新区块补上。指令走的是包队列，服务端处理它时
        // 必定已经处理完了之前的移动包，所以结果一定是新鲜的。
        reply(true, `${player.pendingCount} ${player.subscribedCount} ${core.world.loadedCount}`);
        return;
      }
      case 'gallery': {
        // 把每一种方块摆成一个阵列，供单张截图回归。
        //
        // 在服务端一次性搭好，而不是让客户端发几十条 setblock ——
        // 那样每条都是一次往返，顺序还会受调度影响，截图就不确定了。
        const [, gx, gy, gz] = parts;
        const ox = Number(gx);
        const oy = Number(gy);
        const oz = Number(gz);
        reply(true, String(buildGallery(core, ox, oy, oz)));
        return;
      }
      case 'shapes': {
        // 只摆非立方体方块，排成一行，供近距离截图。
        // 大阵列图里每个方块只有二十来像素，看不出楼梯朝向反没反。
        const [, sx2, sy2, sz2] = parts;
        reply(true, String(buildShapeRow(core, Number(sx2), Number(sy2), Number(sz2))));
        return;
      }
      case 'fillbox': {
        // 在服务端一次性填一片，而不是让客户端发几百条 setblock ——
        // 那样每一条都要走一轮消息往返，一个 20×20 的平台要几百帧才铺完
        const [, ax, ay, az, bx, by, bz, blockName] = parts;
        const state = packState(core.registry.idOf(String(blockName)));
        let filled = 0;
        for (let x = Math.min(Number(ax), Number(bx)); x <= Math.max(Number(ax), Number(bx)); x++) {
          for (let y = Math.min(Number(ay), Number(by)); y <= Math.max(Number(ay), Number(by)); y++) {
            for (let z = Math.min(Number(az), Number(bz)); z <= Math.max(Number(az), Number(bz)); z++) {
              if (core.world.setBlock(x, y, z, state)) filled++;
            }
          }
        }
        reply(true, String(filled));
        return;
      }
      case 'countfluid': {
        // 数一数某个立方体里有多少格流体。冒烟测试用它验"水真的流开了"
        const [, ax, ay, az, bx2, by2, bz2] = parts;
        let n = 0;
        for (let x = Math.min(Number(ax), Number(bx2)); x <= Math.max(Number(ax), Number(bx2)); x++) {
          for (let y = Math.min(Number(ay), Number(by2)); y <= Math.max(Number(ay), Number(by2)); y++) {
            for (let z = Math.min(Number(az), Number(bz2)); z <= Math.max(Number(az), Number(bz2)); z++) {
              const id = core.world.getBlock(x, y, z) & 0xfff;
              if (id >= 8 && id <= 11) n++;
            }
          }
        }
        reply(true, String(n));
        return;
      }
      case 'spawn': {
        // 自动化与调试用：在指定位置放一只生物
        const [, kind, sx, sy, sz] = parts;
        const x = sx === undefined ? player.x : Number(sx);
        const y = sy === undefined ? player.y : Number(sy);
        const z = sz === undefined ? player.z : Number(sz);
        const mob = core.mobs.spawnByName(String(kind), x, y, z);
        reply(mob !== null, mob === null ? `没有这种生物: ${String(kind)}` : String(mob.entityId));
        return;
      }
      case 'killall': {
        const [, kind] = parts;
        const n = core.mobs.removeAll(kind === undefined ? undefined : String(kind));
        reply(true, String(n));
        return;
      }
      case 'mobs': {
        // 当前有多少只，各是什么。断言用
        const counts = new Map<string, number>();
        for (const m of core.mobs.mobs.values()) {
          counts.set(m.def.name, (counts.get(m.def.name) ?? 0) + 1);
        }
        const parts2 = [...counts.entries()].sort().map(([k, v]) => `${k}=${v}`);
        reply(true, parts2.length === 0 ? 'none' : parts2.join(' '));
        return;
      }
      case 'explode': {
        const [, sx, sy, sz, power] = parts;
        core.explode(Number(sx), Number(sy), Number(sz), Number(power ?? 3));
        reply(true, 'ok');
        return;
      }
      case 'give': {
        // 自动化与调试用：直接把东西塞进背包
        const [, what, howMany] = parts;
        const name = String(what);
        const id = core.items.get(0) !== undefined && /^\d+$/.test(name)
          ? Number(name)
          : (core.registry.hasBlock(name) ? core.registry.idOf(name) : core.items.idOf(name));
        const count = Math.max(1, Math.min(640, Number(howMany ?? 1)));
        const left = giveToPlayer(core, player, makeStack(id, count));
        syncInventory(core, player);
        reply(true, `${count - left}`);
        return;
      }
      case 'inv': {
        // 打印背包内容，供断言
        const inv = player.inventory;
        const out = inv.slots
          .map((s2, i) => (s2.count > 0 ? `${i}:${s2.id}x${s2.count}` : ''))
          .filter((x) => x !== '')
          .join(',');
        reply(true, out);
        return;
      }
      case 'held': {
        const h = player.inventory.held;
        reply(true, h.count > 0 ? `${h.id}x${h.count}` : 'empty');
        return;
      }
      case 'height': {
        const [, sx, sz] = parts;
        reply(true, String(core.world.store.getHeight(Number(sx), Number(sz))));
        return;
      }
      case 'stats':
        reply(true, JSON.stringify(core.stats()));
        return;
      default:
        reply(false, `未知指令: ${cmd}`);
    }
  } catch (err) {
    reply(false, err instanceof Error ? err.message : String(err));
  }
}

/**
 * 搭一个方块陈列阵。
 *
 * 每一列放一种方块，带元数据的方块横向排开它的几个代表状态 ——
 * 半砖的上下、楼梯的四个朝向、栅栏的连接、雪层的厚度。
 * 一张截图就能覆盖"所有形状"，而形状错了在截图里是一眼可见的。
 *
 * @returns 摆了多少个方块
 */
function buildGallery(core: ServerCore, ox: number, oy: number, oz: number): number {
  const ids: number[] = [];
  for (let id = 1; id < core.world.tables.count; id++) {
    if (core.world.tables.defs[id] == null) continue;
    // 流体（8..11）与火（51）不进陈列阵：它们**会动**。
    // 水会流开并盖掉旁边的展品，火会烧掉可燃的邻居再自己熄灭，
    // 于是这张本该静止的回归截图每次都不一样。
    // 它们由 tools/smoke-sim-checks.mjs 的瀑布场景单独验
    if (id >= 8 && id <= 11) continue;
    if (id === 51) continue;
    ids.push(id);
  }

  // 需要展示多个状态的方块：id -> 要展示的元数据列表
  const metaVariants = new Map<number, number[]>([
    [44, [0, 1]],                 // 半砖：下/上
    [53, [0, 1, 2, 3]],           // 木楼梯：四个朝向
    [67, [0, 4]],                 // 石楼梯：正/倒
    [85, [0, 0b0011, 0b1111]],    // 栅栏：孤立 / 两向 / 四向
    [50, [0, 1, 3]],              // 火把：立地 / 贴两侧
    [102, [0, 0b0011, 0b1111]],   // 玻璃板
    [78, [0, 3, 7]],              // 雪层：薄 / 中 / 满
    [92, [0, 2, 5]],              // 蛋糕：完整 / 吃两口 / 吃五口
    [64, [0, 4]],                 // 门：关 / 开
    [96, [0, 4]],                 // 活板门：平放 / 竖起
    [65, [0, 1, 2, 3]],           // 梯子：四面
  ]);

  const columns = 10;
  let placed = 0;
  let slot = 0;
  for (const id of ids) {
    const metas = metaVariants.get(id) ?? [0];
    const cx = ox + (slot % columns) * 2;
    const cz = oz + Math.floor(slot / columns) * 2;
    for (let i = 0; i < metas.length; i++) {
      // 每个状态往上叠一格，同一列从下往上是同一种方块的不同状态
      const base = oy + i * 2;
      // 脚下垫一块石头，非整格的方块才有个明确的参照
      core.world.setBlock(cx, base - 1, cz, packState(1));
      if (core.world.setBlock(cx, base, cz, packState(id, metas[i]!))) placed++;
    }
    slot++;
  }
  return placed;
}

/**
 * 把所有非立方体形状排成一行，脚下垫石头。
 *
 * 这一行是 M7 真正要盯的东西：楼梯朝向、半砖上下、栅栏连接、
 * 雪层厚度、蛋糕缺口 —— 错了在近景图里一眼可见，在大阵列图里看不出来。
 */
function buildShapeRow(core: ServerCore, ox: number, oy: number, oz: number): number {
  const row: [number, number][] = [
    [44, 0], [44, 1],                       // 半砖 下 / 上
    [53, 0], [53, 1], [53, 2], [53, 3],     // 木楼梯 四朝向
    [53, 4],                                // 木楼梯 倒置
    [85, 0], [85, 0b0011], [85, 0b1111],    // 栅栏 孤立 / 两向 / 四向
    [50, 0], [50, 1],                       // 火把 立地 / 贴墙
    [102, 0], [102, 0b0011],                // 玻璃板
    [78, 0], [78, 3], [78, 7],              // 雪层
    [92, 0], [92, 3],                       // 蛋糕
    [64, 0], [64, 4],                       // 门 关 / 开
    [96, 0], [96, 4],                       // 活板门
    [26, 0],                                // 床
    [66, 0],                                // 铁轨
    [65, 0],                                // 梯子
  ];
  // 摆成 7 列的网格而不是一条长队：26 个方块排成一行有 52 格长，
  // 想拍全就得退到二十多格外，每个方块只剩十几像素，等于白拍
  const COLS = 7;
  let placed = 0;
  for (let i = 0; i < row.length; i++) {
    const [id, meta] = row[i]!;
    const x = ox + (i % COLS) * 2;
    const z = oz + Math.floor(i / COLS) * 2;
    core.world.setBlock(x, oy - 1, z, packState(1));
    if (core.world.setBlock(x, oy, z, packState(id, meta))) placed++;
  }
  return placed;
}
