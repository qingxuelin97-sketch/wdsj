/**
 * 自动化用的**场景搭建**指令实现：合成链、陈列阵、形状行。
 *
 * 从 commands.ts 拆出来的（那个文件到了 627 行、越过 600 硬上限），
 * 分界线很自然：commands.ts 是"指令怎么解析、谁能调"，
 * 这里是"某几条指令具体在世界里摆什么"。后者只被截图回归用到，
 * 与游戏玩法一点关系都没有 —— 混在一起会让人以为陈列阵是个游戏特性。
 */
import type { ServerCore } from '../server-core.ts';
import type { ServerPlayer } from '../player/server-player.ts';
import { packState } from '../../core/world/chunk.ts';
import type { ItemStack } from '../../core/item/item-def.ts';
import { showWindow, closeWindow } from '../player/inventory-actions.ts';
import { WindowKind } from '../../core/net/packets.ts';

export function runCraftChain(core: ServerCore, player: ServerPlayer): string[] {
  const made: string[] = [];
  const inv = player.inventory;

  /** 背包里有多少个某物 */
  const countOf = (name: string): number => {
    const id = core.registry.hasBlock(name) ? core.registry.idOf(name) : core.items.idOf(name);
    let n = 0;
    for (const s of inv.slots) if (s.id === id && s.count > 0) n += s.count;
    return n;
  };

  /**
   * 在窗口里合一次。
   * @param grid 合成格的内容（按窗口槽位顺序），null 表示空
   * @param times 连续取几次产物
   */
  const craft = (kind: WindowKind, grid: (string | null)[], times: number): boolean => {
    showWindow(core, player, kind);
    const win = player.openWindow;
    if (win === null) return false;
    // 槽位 0 是产物，合成格从 1 开始
    for (let i = 0; i < grid.length; i++) {
      const name = grid[i] ?? null;
      const slot = win.container.slots[1 + i];
      if (slot === undefined) return false;
      if (name === null) {
        slot.id = 0;
        slot.count = 0;
        continue;
      }
      const id = core.registry.hasBlock(name) ? core.registry.idOf(name) : core.items.idOf(name);
      // 材料从背包里扣，模拟玩家把东西拖进合成格
      if (!takeFromInventory(inv.slots, id, 1)) return false;
      slot.id = id;
      slot.count = 1;
      slot.damage = 0;
    }
    // 摆完材料要让窗口重算产物槽。
    //
    // 正常玩家是**点**进去的，每次点击后 click() 自己会调 refreshOutput；
    // 这里为了省事直接写了格子，那条路就没走到 —— 产物槽还是空的，
    // 接下来点它当然什么都拿不到。pullFromPlayer 会重算产物，
    // 而合成格映射到 −1（窗口自己的临时格），不会被它覆盖
    win.pullFromPlayer();

    let got = false;
    for (let t = 0; t < times; t++) {
      // shift+左键产物槽 = 全部拿走并塞进背包
      if (!win.click(0, 0, true)) break;
      got = true;
    }
    closeWindow(core, player);
    return got;
  };

  // 1. 原木 -> 木板。**合两次**：一根原木出 4 块板，而后面要用掉
  // 2 块做木棍 + 4 块做工作台 + 3 块做镐 = 9 块，一次不够
  let plankRuns = 0;
  for (let i = 0; i < 3; i++) {
    if (craft(WindowKind.INVENTORY, ['log', null, null, null], 1)) plankRuns++;
  }
  if (plankRuns > 0) made.push('planks');
  // 2. 木板 -> 木棍（竖着两块，出 4 根）
  if (craft(WindowKind.INVENTORY, ['planks', null, 'planks', null], 1)) made.push('stick');
  // 3. 木板 ×4 -> 工作台
  if (craft(WindowKind.INVENTORY, ['planks', 'planks', 'planks', 'planks'], 1)) made.push('crafting_table');
  // 4. 工作台上合木镐：三块木板一横 + 两根木棍一竖
  if (craft(WindowKind.CRAFTING, [
    'planks', 'planks', 'planks',
    null, 'stick', null,
    null, 'stick', null,
  ], 1)) made.push('wooden_pickaxe');

  void countOf;
  return made;
}

/** 从背包里扣掉若干个某物。不够返回 false */
function takeFromInventory(slots: ItemStack[], id: number, count: number): boolean {
  let left = count;
  for (const s of slots) {
    if (s.id !== id || s.count <= 0) continue;
    const take = Math.min(s.count, left);
    s.count -= take;
    left -= take;
    if (s.count <= 0) {
      s.id = 0;
      s.damage = 0;
    }
    if (left <= 0) return true;
  }
  return left <= 0;
}

export function buildGallery(core: ServerCore, ox: number, oy: number, oz: number): number {
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
export function buildShapeRow(core: ServerCore, ox: number, oy: number, oz: number): number {
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
