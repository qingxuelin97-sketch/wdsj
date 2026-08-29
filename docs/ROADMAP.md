# 里程碑

目标：达到 Minecraft Java Edition **Release 1.0.0**（2011-11-18）特性面的 80%+，实际按 90+ 规划。
评分细则见 [RUBRIC.md](RUBRIC.md)。

排序原则：**最不确定的技术风险最早退休**。三个真未知是 (a) 零依赖工具链、(b) worker + 流式加载的帧预算、
(c) 客户端/服务端边界重构 —— M0 干掉 (a)，M3 在还没有内容拖慢之前干掉 (b)，M2 先在同线程里引入
`ServerCore` + `Transport`，于是 M5 的 worker 拆分是搬一个已经长成边界形状的代码库，而不是重写 4 万行。

| # | 里程碑 | 验收标准 | 状态 | commit |
|---|---|---|---|---|
| **M0** | 工具链与第一帧 | CI 全绿；违规能被 lint 精确报行拒绝；JavaRandom 与 JDK 逐位一致；浏览器出现可操控的贴图场景，fps>55 | ✅ | `3e02574` |
| **M1** | 区块数据与网格化 | 面剔除逐面匹配黄金图案；chunk 编解码往返一致；**UV 有断言测试**；单列柱体六面方向正确 | ✅ | |
| **M2** | 世界生成 + 服务端骨架（同线程） | `node --test` 直接 new `ServerCore` 跑 200 tick 无异常；全数据包随机往返；同种子区块哈希相同；RD 4 可漫游真实地形 | ☐ | |
| **M3** | Worker 拓扑与流式加载 | RD 8 定步长飞行 60 s：fps≥55、无空洞、`meshQueueDepth` 归零、堆漂移<20 MB、`drawCalls`<1200 | ☐ | |
| **M4** | 光照 | 4 个黄金场景逐格相等；tick 0/6000/13000/18000 截图哈希匹配；破坏一格后 1 tick 内正确且重网格 section≤4；光照≤5 ms/tick | ☐ | |
| **M5** | 服务端 Worker 化 | M4 全部验收在 worker 边界下重跑通过；layer lint 证明 client 无世界写路径；**后台标签页 60 s 后 TPS 仍为 20** | ☐ | |
| **M6** | 玩家物理与挖掘放置 | 物理黄金轨迹与 1.0 数值一致；`press('w',1000)` 位移命中黄金值；10 级裂纹 + 破坏粒子 + 材质音 | ☐ | |
| **M7** | 方块模型系统 | `/gallery` 全方块阵列单张截图对比黄金；每个非立方体方块碰撞 AABB 单测通过 | ☐ | |
| **M8** | 物品·背包·合成·容器 | **≥120 条配方逐条匹配黄金表**（含镜像与偏移归一化）；shift 点击语义测试；GUI 截图匹配 | ☐ | |
| **M9** | 方块实体·掉落物·持久化 | 建结构→保存→刷新：结构/背包/坐标/熔炉进度/计划刻全部还原；NBT 模糊往返；400 区块存读<2 s。**闸门③** | ☐ | |
| **M10** | 实体与 AI | 无头 100 生物跑 600 tick 无异常、tick≤15 ms；生物模型截图匹配；日灼/引信/传送各有单测 | ☐ | |
| **M11** | 流体·重力·火·爆炸 | 8 个 ASCII 流体布局逐格匹配；瀑布截图匹配；**TNT 爆坑方块数与黄金完全相等** | ☐ | |
| **M12** | 生存循环 | 饥饿/坠落/盔甲/经验曲线全部对 1.0 黄金数值相等；无头生存-死亡-重生跑 2 万 tick。**闸门①** | ☐ | |
| **M13** | 农业与红石 | **12 个 ASCII 电路黄金测试**逐 tick 输出匹配；作物 8 阶段生长与水合规则单测 | ☐ | |
| **M14** | 表现层：音效·粒子·天气·天空·GUI·F3 | 音效生成字节哈希稳定；菜单/F3/雨雪雷截图匹配。**闸门②；此处越过 80 分线** | ☐ | |
| **M15** | 下界 + 要塞 + 附魔 + 酿造 | 建门→点燃→传送→下界地形截图匹配；1:8 链接单测；恶魂火球可击回；附魔/酿造配方表匹配 | ☐ | |
| **M16** | 末地 + 末影龙 | `__mc` 全流程脚本：定位要塞→激活→末地→水晶→击杀龙→出口传送门，12 检查点截图匹配 | ☐ | |
| **M17** | 多人 + 性能 + 终验评分 | 两标签页连同一 node 服务器双向可见、延迟<100 ms；RD 12 fps≥60、tickMs≤25；10 min 内存平坦；按 RUBRIC 打分留档 | ☐ | |

**三项闸门测试**（任一不过，总分封顶 60）：
1. **第一夜** —— 出生 → 徒手打木 → 合成台+工具 → 搭掩体 → 熬过有怪的一夜
2. **下矿** —— 下到 Y<16，火把照明找到钻石，躲开岩浆，活着回来
3. **存读** —— 退出重进，世界/背包/容器内容/时间完全还原

---

## M0 完成记录（2026-08-29）

**交付**
- 零依赖工具链：`tools/dev-server.mjs` 用 Node 内置 `module.stripTypeScriptTypes` 现场剥离类型直接喂浏览器；
  剥离保留空白，行列号与源码逐字符对齐，因此不需要 sourcemap，DevTools 栈直指 `.ts` 原位
- 供应工具：esbuild 0.25.12（`tools/bin/esbuild.exe`）、TypeScript 5.9.3、@types/node 22.20.1，
  全部由本机既有安装复制而来，**零下载**
- CI 门禁 `tools/ci.mjs`：tsc → lint-erasable → lint-layers → lint-size → node:test → smoke
- 无头验证：`tools/cdp.mjs` 用 Node 24 内置 WebSocket 直接驱动 CDP，**不需要 Puppeteer**
- `src/core/rng/java-random.ts`：位级复刻 `java.util.Random`
- `src/core/math/`：vec3 / mat4，全部 `(out,...)->out` 零分配形式
- `src/core/noise/perlin.ts`：Perlin + 倍频 + 脊状，置换表由 JavaRandom 洗牌
- `src/core/constants.ts`：MC 1.0 数值真相来源
- 客户端第一帧：原生 WebGL2 + **12 字节顶点格式** + **TEXTURE_2D_ARRAY** + 程序化贴图 + 自由飞行相机
- `window.__mc` 测试钩子 + 截图哈希回归

**验收证据**
- `node tools/ci.mjs` 6 步全绿
- JavaRandom：与 BigInt 参考实现交叉验证 10 项全过，且命中两个独立的 JDK 已知输出锚点
  （`new Random(0).nextInt() = -1155484576`、`new Random(42).nextInt() = -1170105035`）
- lint 实测能拦：`enum`、跨层 import、缺 `.ts` 后缀、DOM 全局泄漏、渲染层读挂钟、裸模块说明符，
  且报出精确行号
- 无头 Chrome 真 GPU（ANGLE D3D11）渲染 968 面 / 1 次 draw call / fps 180
- 截图哈希跨有头与无头环境完全一致（`overview = 4e9f9d7c`）；故意改坏黄金值会以退出码 1 拦下
- 截图：`tests/out/{overview,closeup,topdown}.png`

**过程中修掉的真问题**
1. `mat4.fromCamera` 右向量符号写反 —— 正交性检查发现不了（翻转不破坏正交性），
   靠与 `lookAt` 的交叉验证抓到
2. Chrome 后台标签页 rAF 完全不派发、`setTimeout` 也被节流到 1 Hz，
   自动化会挂死 → 改用 worker 心跳驱动后台帧
3. `setCanvasSize(640,360)` 被 `resizeToDisplay` 按 dpr=1.5 改成 960×540，
   破坏跨机器可比 → 加尺寸锁
4. CDP 在页面导航中求值报 "Cannot find default execution context" —— 竞态，
   改为先开空白页建会话再导航并等 load，另加有限重试
5. smoke 存的 PNG 原是整个视口（含 HUD 与黑边），与被哈希的 canvas 内容对不上 →
   改成直接存 `__mc.screenshot()` 的结果

**已知遗留**
- Chrome 走的是 Intel 集显而非 RTX 5060。M3 做性能验收时要确认这一点是否影响结论
- `simple-mesher.ts` 是 M0 的临时实现：无 AO、无贪心合并、不跨区块。M1 已替换

---

## M1 完成记录（2026-08-29）

**交付**
- `core/world/chunk.ts` —— `Chunk` / `ChunkSection`，扁平 `Uint16Array`（id 12bit | meta 4bit），
  YZX 下标，增量维护 heightmap，空气段不分配
- `core/world/block-view.ts` —— `BlockView` / `MutableBlockView` / `ChunkStore`，
  让一份碰撞、一份射线、一份光照同时服务客户端镜像与服务端世界
- `core/block/` —— `BlockDef` + 13 个行为钩子契约 + 基础类型
- `core/registry/` —— 注册表 + **冻结时烘焙的扁平属性表**（热路径只读 typed array）
- `core/net/codec.ts` —— ByteWriter / ByteReader，帧长度用 u32
- `core/world/chunk-codec.ts` —— 调色板 + 位打包的区块序列化，以及 18³ padded 邻域抽取
- `core/math/aabb.ts`、`core/math/frustum.ts`（Gribb-Hartmann 平面提取）
- `content/blocks.ts` —— 46 种方块，**沿用 MC 1.0 的真实 id**
- `client/mesh/mesher.ts` —— 完整网格化：18³ padded 邻域、3 采样 AO、平滑光照、
  四边形翻转消对角线接缝、三渲染层分离
- `client/render/` —— 贴图配方（51 张原创像素画）、图集与面层号烘焙、
  `ChunkRenderer`（每层一个 VAO、视锥剔除、半透明按距离排序）

**验收证据**
- 15 个 mesher 测试 + 14 个 chunk 测试全过；`node tools/ci.mjs` 6 步全绿
- **UV 有逐角断言**（前作的致命 UV bug 正是因为没有这个才带到线上）
- 编解码往返对随机内容逐格比对，覆盖 4bit / 8bit / 无调色板三条分支
- heightmap 的增量维护与全量重算逐格一致（放置与破坏两个阶段分别验证）
- 无头渲染 25 区块 / 70 段 / 32714 面 / 89 draw call / fps 180
- 4 个视角的截图黄金哈希：`tests/screenshots/hashes.json`

**过程中修掉的真问题**
1. `crossPlant` 的默认参数让 TS 把 tint 推成字面量 `0`，传 `TintKind.GRASS` 就报错 —— 显式标注
2. **草方块整块被染绿**，包括侧面本该是泥土的部分。tint 原本是方块级的，
   改成**按面掩码**（`tintFaces`）—— 顶点格式里 tint 本来就是逐顶点的
3. **alpha 渗色**：`noiseFill` 给透明像素写 `rgb(0,0,0)`，`generateMipmap` 把黑色平均进
   相邻不透明像素，树叶出现黑斑。改为透明像素也填基色，并加通用的 `bleedEdges()` 后处理
4. **小屋盖在树上**：`surfaceY` 返回的是最高非空气方块，遇到树就返回树叶高度。
   不透明木板压住下方树叶，天光归零，画面上是一大片黑斑 —— 一开始极易误判成
   mipmap 或 cutout 的渲染 bug。靠**扫描实际光照数据**（61 个天光为 0 的树叶，
   坐标正是小屋位置）才定位到，修完从 61 降到 0

> 第 3、4 条都表现为"树叶发黑"，但成因完全不同，一个在贴图生成、一个在世界内容。
> 教训与 docs/RULES.md 第 14 条一致：不要凭现象猜，去读实际数据。
