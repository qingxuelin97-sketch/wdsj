# 我的世界 · 复刻

从零复刻 Minecraft Java Edition **Release 1.0.0**（2011-11-18），目标是达到其特性面的 80%+。

TypeScript + 原生 WebGL2 + Web Workers，**零 npm 依赖**。
所有美术与音频资源均为程序化生成的原创内容，不含任何 Mojang 素材。

## 快速开始

```bash
node tools/dev-server.mjs          # 开发服务器 -> http://localhost:8080
node tools/ci.mjs                  # 全套门禁：类型检查 + 3 个 lint + 单测 + 无头冒烟
node --test                        # 只跑单元测试
node tools/smoke.mjs --head        # 有头模式跑冒烟测试，方便肉眼看
node tools/persist-check.mjs       # 闸门③：真浏览器建结构 -> 存盘 -> 重开 -> 全还原
node tools/first-night-check.mjs   # 闸门①：打木 -> 合成 -> 掩体 -> 熬过有怪的一夜
UPDATE_GOLDEN=1 node tools/smoke.mjs   # 重新生成截图黄金哈希
```

常用 URL 参数：`?seed=1234` 换种子，`?rd=8` 改视距，`?persist=0` 关存档、
`?mobs=0` 关自然刷怪（截图回归两个都要关：存档会让"同一个种子跑两次"
读到上一次的世界，野生的怪则会走进画面）。

开发期**没有构建步骤**：`dev-server.mjs` 用 Node 内置的 `module.stripTypeScriptTypes`
现场剥离 TS 类型直接喂给浏览器。剥离是保留空白的，行列号与源码逐字符对齐，
所以不需要 sourcemap，DevTools 的栈帧直接指到 `.ts` 原位。

## 为什么零依赖

1. **网络事实** —— 本机 npm registry 直连全部超时（DNS 返回 Clash fake-IP），只有走代理才通。
   长跑项目依赖联网 = 埋一颗随时会炸的雷。
2. **本机已有** —— esbuild、TypeScript、Node 内置测试框架都在，够用。
3. **技术上真的够** —— three.js 对体素引擎是负资产（要绕过它的 material 系统才能塞自定义
   压缩顶点格式）；`node:test` 相对 vitest 没有本项目用得上的增量。

工具链由本机既有安装复制到 `tools/vendor/` 与 `tools/bin/`（已 gitignore），
可用 `tools/vendor.mjs` 重建。

## 目录

```
src/core/      纯逻辑（无 DOM、无 node:*）
src/content/   内容数据：方块、物品、配方、群系、生物
src/server/    权威模拟
src/client/    渲染、输入、GUI、音频
src/platform/  平台适配
src/entry/     各线程入口
tools/         dev-server、构建、lint、CI、无头验证、资源生成
tests/         node:test 用例 + 黄金数据
docs/          设计、路线图、规约、评分表、有意偏差
```

## 文档

| 文件 | 内容 |
|---|---|
| [docs/DESIGN.md](docs/DESIGN.md) | 架构：内置服务器模型、分层、顶点格式、worker 拓扑 |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 18 个里程碑与验收标准，附完成记录 |
| [docs/RULES.md](docs/RULES.md) | 编码规约，前 4 条由 CI 强制 |
| [docs/RUBRIC.md](docs/RUBRIC.md) | 100 分评分表与三项闸门测试 |
| [docs/DEVIATIONS.md](docs/DEVIATIONS.md) | 明知与 1.0 不同、但有意为之的地方 |

## 当前进度

**M0–M13 完成**，CI 9 步全绿。详见 [ROADMAP](docs/ROADMAP.md) 的逐里程碑完成记录。

| | |
|---|---|
| 世界 | 128 高、分块流式加载、6 个群系、洞穴与矿脉、双通道光照 + 昼夜、海与湖 |
| 内容 | 93 种方块、122 件物品、126 条合成 + 12 条熔炼、9 种生物 |
| 玩法 | MC 1.0 精确移动常量、10 级裂纹挖掘、背包/工作台/箱子/熔炉、掉落物 |
| 生物 | 目标式 AI + 二叉堆 A*、刷怪规则与上限、日灼 / 引信 / 传送、箭与爆炸 |
| 模拟 | 流体 8 级 + 无限水源 + 岩浆反应、沙砾下落、火蔓延、TNT、计划刻队列 |
| 生存 | 血量 / 饥饿 / 饱和 / 消耗、八种伤害源、护甲减伤、经验与经验球、死亡重生 |
| 红石 | 线网整网重算、火把非门、中继器四档延时、活塞推拉、门与发射器 |
| 农业 | 随机刻系统、耕地水合、小麦八阶段、甘蔗仙人掌、草蔓延、树苗成树 |
| 存档 | NBT + RLE + region 文件；OPFS（浏览器）/ fs（node）/ 内存（测试） |
| 线程 | 主线程渲染 · 服务端 worker · 生成 worker ×2 · 网格 worker ×4 · SAB 心跳 |
| 验证 | 320 个单元测试、13 张黄金截图、闸门测试 ① ③ 通过 |

闸门测试：① **第一夜（已通过）** · ② 表现层（M14）· ③ **存读（已通过）**
