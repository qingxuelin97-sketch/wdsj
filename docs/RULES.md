# 编码规约

违反前 6 条会被 `node tools/ci.mjs` 直接拦下。其余靠自觉，但同样是硬要求。

---

## 1. 相对 import 必须带 `.ts` 后缀

```ts
import { getBlock } from '../world/chunk.ts';   // 对
import { getBlock } from '../world/chunk';      // 错，浏览器解析不到
```
Node 原生解析它，浏览器由 `tools/dev-server.mjs` 解析。**由 `lint-layers.mjs` 强制。**

## 2. 只用可擦除的 TypeScript 语法

禁用：`enum`、`namespace`、构造函数参数属性、装饰器、`<T>expr` 形式的断言。

Node 的原生 TS 支持只做类型剥离、不做转译，上面这些都需要生成运行时代码。统一改用：

```ts
export const Facing = { DOWN: 0, UP: 1, NORTH: 2, SOUTH: 3, WEST: 4, EAST: 5 } as const;
export type Facing = (typeof Facing)[keyof typeof Facing];
```

**由 tsconfig 的 `erasableSyntaxOnly` 与 `lint-erasable.mjs` 双重强制。**

## 3. 分层

```
core     → 不 import 任何人
content  → 只 import core
server   → import core / content / platform，永不 import client
client   → import core / content / platform，永不 import server
platform → 只 import core
entry    → 可以 import 所有层
```

附带的全局限制：
- `core` / `content` / `server` 里不得出现 `document`、`window`、`localStorage` 等 DOM 全局
- `core` / `content` / `client` 里不得出现 `node:` import，也不得出现 `process`、`Buffer`、`require` 等 Node 全局
- 禁止裸模块说明符（`import x from 'three'`）—— 本项目零依赖

**由 `lint-layers.mjs` 强制。**

## 4. 渲染与网格化代码禁止读挂钟

`src/client/render/**`、`src/client/mesh/**`、`src/server/**` 里不得调用 `performance.now()` / `Date.now()`。

所有动画相位 —— 水/岩浆/火/传送门的贴图帧、云漂移、太阳角度、生物待机、手持晃动 —— 必须从 `clock.renderTick` 派生。否则 `__mc.freeze()` 停不住画面，截图回归就是假的。

唯一允许读挂钟的客户端位置是 `src/client/clock.ts` 与 `src/client/frame-scheduler.ts`。

**由 `lint-layers.mjs` 强制。**

## 5. 文件规模

软上限 400 行（提醒），硬上限 600 行（失败）。需要超出时在下面声明例外并写理由，格式：

```
- 例外: `src/path/to/file.ts` (900) 理由
```

当前例外清单：

（暂无）

**由 `lint-size.mjs` 强制。**

## 6. 不许有死 import

一个 import 进来却没人用的名字，直接编译失败（tsconfig 的 `noUnusedLocals`）。

不只是嫌噪音：import 列表是"这个模块依赖谁"的唯一声明，留着死的会让这个答案是
错的，`lint-layers.mjs` 也跟着一起误判 —— 一个早就不碰 server 的 client 文件，
看起来还在 import server。M13 拆分 `server-core.ts` 时一口气积了 69 个。

`noUnusedParameters` **不**开：回调要按签名接参数，用不上的那个也得占位。

**由 tsconfig 的 `noUnusedLocals` 强制。**

## 7. 行尾一律 LF

`.gitattributes` 里 `* text=auto eol=lf` 钉死。

写文件有两条路径（Write 工具在 Windows 上写 CRLF，脚本和 heredoc 写 LF），
不钉死的话谁最后动过一个文件决定了它的行尾。到 M13 时仓库已经是 106 LF / 41 CRLF
的混合体，一次脚本化批量改动会把几十个文件整体重写，真改动淹在几千行行尾 diff 里。

---

## 8. 热循环只读扁平表，不读对象

mesher、光照引擎、碰撞、射线、随机刻这些每秒跑几百万次的路径，**只允许读 `core/registry/block-tables.ts` 里烘焙好的 typed array**，不得读 `BlockDef` 对象。这是"方块用数据驱动"和"跑得够快"能同时成立的唯一办法。

## 9. 方块行为钩子是自由函数

无 `this`，坐标拆成三个 `number` 传入（不要传 `{x,y,z}` 对象，那会在热路径里造几百万个临时对象）。

## 10. 变更世界只有一条路径

`ServerWorld.setBlock` 是唯一的写入口；`server/player/chunk-tracker.ts` 是唯一发世界包的地方。客户端**永不**创建或销毁区块 —— 只有 `S_ChunkData` / `S_ChunkUnload` 能。

## 11. 每帧/每 tick 路径里不许分配

不要在其中调用 `mat4.create()` / `vec3.create()` / `new Float32Array()`，预先分配 scratch 复用。数学库全部是 `(out, ...) -> out` 形式就是为了这条。

前作的教训：它的 mesher 在热循环里用 `Array.from` 造 mask、用元组返回坐标、用 `number[].push` 攒顶点，单列网格化约 150 万次短命分配。

## 12. 区块 key 用数值，不用字符串

`cx * 0x100000000 + cz`，不要 `` `${cx},${cz}` ``。前作在每帧的剔除循环里 `key.split(',')`，几百个区块就是几百次字符串分配加解析。

## 13. 网格化任务必须带 `rev`

结果回来时 `rev` 不匹配就静默丢弃。玩家快速挖放时会连续产生任务，没有这个就会把旧网格盖到新状态上。

## 14. 调子进程一律 `shell: false`

项目路径是 `D:\其他\我的世界`，含中文。一旦经 `cmd.exe` 转发就会被按 GBK 重新解析成乱码。直接调 `.exe`，不要用 `.cmd` shim，不要 `shell: true`。

## 15. 改含非 ASCII 的文件不要用 PowerShell 文本管道

`(Get-Content x -Raw) -replace ... | Set-Content x` 会把 UTF-8 无 BOM 文件按 GBK 误读，中文、破折号、箭头全部损坏。用 Edit/Write 工具。

## 16. 验收看证据，不看声明

"代码写了"不算完成。每个里程碑的验收标准都必须是可执行断言或截图比对。

前作的教训：它的 README 宣称"动态天空颜色和光照"，而 `world.js:341` 的 `getLight` 返回 `Math.min(15, y)` 且从未被 mesher 调用；`chunk.js:42` 的 `vertexAO` 定义了但全项目无一处调用。

## 17. 光照只有一份实现，两端共用

光照算法在 `core/light/light-engine.ts`，服务端和客户端镜像**跑的是同一份代码**。
服务端不会为一次方块变更下发光照数据（那要么发一整块几十 KB，要么发一堆散格），
客户端拿同样的世界状态自己算一遍即可。

推论：**任何一侧都不许给光照加特判**。加了就意味着两端结果不同，
而表现出来是"光照忽明忽暗"，且极难查到根因。
`tools/smoke.mjs` 里的 `checkLight` 就是守这条的 —— 它逐格比对两端的读数。
