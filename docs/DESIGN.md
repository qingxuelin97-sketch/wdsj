# 架构

## 核心决策：内置服务器模型（与真 MC 一致）

模拟是权威的，且与渲染完全隔离。

- **单人** = `ServerCore` 跑在 Web Worker 里，走 MessagePort
- **多人** = 同一份 `ServerCore` 跑在 Node 里，走 WebSocket

传输层是接口，其余代码一行不改。

**关键约束：`ServerCore` 本身不含任何 Worker / DOM 依赖。** Worker 只是它的一个宿主。
于是 `node --test` 可以直接 `new ServerCore({storage: memoryStorage, seed: 1234})`，挂一个
loopback 客户端，跑 2 万 tick 做断言 —— **无需浏览器即可覆盖世界生成、光照、红石、流体、AI、
容器、持久化、伤害，约占全游戏逻辑的 80%**。这是长跑能自我验证的地基。

## 分层

```
src/core/      纯逻辑。无 DOM、无 node:*
               数学 / 随机 / 噪声 / 区块结构 / 方块表 / 模型 / 物理 / 射线 /
               光照算法 / NBT / 协议 schema / 常量
src/content/   内容数据：方块表、物品表、配方、群系、生物定义、战利品表
src/server/    权威模拟：世界、生成、光照引擎、tick 调度、实体、AI、容器、红石、流体、持久化
src/client/    渲染、输入、GUI、音频、预测、插值
src/platform/  平台适配：存储(OPFS/fs)、传输(MessagePort/WebSocket)、时钟
src/entry/     入口：client-main / server-worker / gen-worker / mesh-worker / node-dedicated
tools/         资源生成器、dev-server、构建、lint、CI
tests/         node:test 用例 + 黄金数据
```

规则见 [RULES.md](RULES.md)，由 `tools/lint-layers.mjs` 强制。

## 防屎山的六件装置

1. **数据驱动注册表** —— 方块/物品/配方/群系/生物是 `content/` 里的数据记录，不是 120 个子类。
   只有约 25 个方块需要真行为模块。
2. **`block-tables.ts`：注册表冻结时烘焙成扁平 typed array**。热循环只读这些 typed array，
   永不读 `BlockDef` 对象。这一条是"数据驱动"与"够快"能同时成立的原因。
3. **声明式包 schema** —— 每个包定义一次字段表，编码器/解码器/TS 类型全部派生。
   帧长度用 u32（前作用 u16，区块包会溢出且静默截断）。
4. **方块模型系统** —— `cube` / `cross` / `fluid` / `elements[]`。楼梯/半砖/栅栏/门/火把/铁轨/
   玻璃板/蛋糕/床几乎白送，碰撞盒由模型烘焙而来。
5. **模拟确定性 + tick 驱动**，渲染器永不改世界状态。
6. **文件规模纪律** —— 软 400 / 硬 600 行。

## 顶点格式：12 字节 / 顶点

3 × uint32，用 `vertexAttribIPointer` 上传，顶点着色器内解包：

```
data0: x:9 | y:9<<9  | z:9<<18 | ao:2<<27      位置为子区块局部、1/16 格精度(0..256)
data1: u:9 | v:9<<9  | layer:11<<18            UV 也以 1/16 格为单位(支持贪心平铺)；2048 层
data2: sky:4 | block:4<<4 | face:3<<8 | tint:3<<11
```

对比前作：`ga` 32 B/顶点（4 个独立 Float32 属性），`D:\minecraft` 48 B/顶点。
留有空位，不做过度压缩以保可读性。

**纹理用 `TEXTURE_2D_ARRAY`，不用图集。** 每格贴图一层。mip 不跨层 →
无需 padding、不会渗色；可用 `REPEAT` → 贪心合并的大 quad 能正确平铺。这三件事图集方案都做不到，
而且前作的图集 padding 是用 2× 放大实现的，白白丢掉一半分辨率。

## Worker 拓扑与内存预算

| 线程 | 数量 | 负责 | 常驻 |
|---|---:|---|---:|
| 主线程 | 1 | GL、GUI、输入、音频、客户端镜像、预测、`__mc` | ~350 MB |
| 服务端 worker | 1 | 世界、实体、光照、红石、容器、持久化、tick 调度 | ~180 MB |
| 生成 worker | 2 | 地形噪声、洞穴、地表、装饰、结构（不含光照） | 2×40 MB |
| 网格 worker | 3–4 | 子区块网格化、AO、流体面、可见性掩码（**完全无状态**） | 4×30 MB |

```ts
const cores = navigator.hardwareConcurrency ?? 8;
const meshWorkers = Math.min(4, Math.max(1, (cores - 4) >> 2));
const genWorkers  = Math.min(2, Math.max(1, (cores - 4) >> 3));
// 硬上限 6 个 worker（本机空闲 RAM 只有约 4.4 GB）
```

**SharedArrayBuffer 只用于两件事**：服务端 tick 时钟的 `Atomics.wait`（免疫后台标签页节流）
+ 一个 64 槽统计环。**区块数据永不共享** —— 那会让单人/多人代码路径分叉，并引入 tick 中途的撕裂读。

网格任务传 **18³ padded 邻域**（16 + 两侧各 1 格），mesh worker 完全无状态。
这样边界处的 AO 与光照才是对的 —— 前作正因为 mesher 拿不到邻居数据，每 16 格就有一条可见光照缝。
结果里带 `recycled` 把输入缓冲还给主线程空闲池，稳态分配趋近 0。

## 客户端镜像的所有权

客户端需要可读的世界副本（网格化、射线、碰撞预测），但真相在服务端。

- `core` 拥有**世界数据模型 + 纯算法**（光照、射线、碰撞、模型）→ 两侧共用同一份实现
- `server` 拥有**权威与变更策略**
- `client` **永不创建或销毁区块** —— 只有 `S_ChunkData` / `S_ChunkUnload` 能
- 玩家移动用输入序号预测 + 回滚重放；**服务端模拟、客户端预测、生物 AI 共用同一个 `stepEntity`**，
  重放因此天然精确
- 远程实体走 100 ms 延迟快照插值

## 构建与验证

**开发期无打包器**：`tools/dev-server.mjs` 用 `module.stripTypeScriptTypes` 现场剥离类型。
剥离保留空白，行列号与源码逐字符对齐，所以不需要 sourcemap。

**生产期用 esbuild**（`tools/bin/esbuild.exe`，`--charset=utf8`，`shell:false` 直接调 exe）。

**无头验证三层**：
1. `node --test` 直接打 `ServerCore` —— 覆盖约 80% 游戏逻辑，无浏览器
2. `tools/smoke.mjs` + `tools/cdp.mjs` —— Node 24 内置 WebSocket 直接驱动 CDP，
   拉真 Chrome 做截图哈希回归，**不需要 Puppeteer**
3. Chrome MCP 扩展做交互式验证

**让截图回归成立的四条规则**（见 RULES.md 第 4 条）：渲染禁读挂钟、渲染后立刻读缓冲、
绕过 dpr 锁定画布尺寸、哈希前降到 64×64 灰度。
