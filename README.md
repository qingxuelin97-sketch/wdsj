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
UPDATE_GOLDEN=1 node tools/smoke.mjs   # 重新生成截图黄金哈希
```

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

M0 完成 —— 工具链、CI 门禁、无头截图回归、JavaRandom、数学库、噪声、
以及用最终顶点格式和纹理数组渲染的第一帧。详见 ROADMAP。
