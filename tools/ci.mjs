/**
 * 门禁。每次提交前全跑一遍，任何一步失败就整体失败。
 *
 * 用法: node tools/ci.mjs [--skip-smoke]
 *
 * 注意：所有子进程都用 shell:false 直接拉可执行文件。项目路径含中文，一旦经过 cmd.exe
 * 转发就会被按 GBK 重新解析成乱码 —— 见 docs/RULES.md 第 13 条。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const skipSmoke = process.argv.includes('--skip-smoke');

/** @type {{name: string, cmd: string, args: string[]}[]} */
const steps = [
  {
    name: 'typecheck (tsc --noEmit)',
    cmd: NODE,
    args: [path.join(ROOT, 'tools/vendor/typescript/bin/tsc'), '--noEmit', '-p', path.join(ROOT, 'tsconfig.json')],
  },
  { name: 'lint-erasable', cmd: NODE, args: [path.join(ROOT, 'tools/lint-erasable.mjs')] },
  { name: 'lint-layers', cmd: NODE, args: [path.join(ROOT, 'tools/lint-layers.mjs')] },
  { name: 'lint-size', cmd: NODE, args: [path.join(ROOT, 'tools/lint-size.mjs')] },
  { name: 'unit tests', cmd: NODE, args: ['--no-warnings', '--test'] },
  // 后台标签页的 TPS。CI 里只观测 10 秒 —— 足够抓住"彻底停摆"这种回退，
  // 完整的 60 秒验收用 node tools/bg-tps.mjs 单跑。
  { name: 'background tps', cmd: NODE, args: ['tools/bg-tps.mjs', '10'] },
];

if (!skipSmoke && fs.existsSync(path.join(ROOT, 'tools/smoke.mjs'))) {
  steps.push({ name: 'smoke (headless chrome)', cmd: NODE, args: [path.join(ROOT, 'tools/smoke.mjs')] });
  // 闸门测试③：真浏览器 + 真 OPFS + 真页面刷新。
  // 单元测试用的是内存后端，验不到"存盘请求有没有送到 worker"这一段接线。
  steps.push({ name: '闸门③ 存读 (headless chrome)', cmd: NODE, args: [path.join(ROOT, 'tools/persist-check.mjs')] });
  // 闸门测试①：把世界生成、挖掘、掉落物、拾取、合成、放置、光照、昼夜、
  // 怪物生成与 AI 串成一条链跑一遍。单项全绿而这条挂掉，
  // 说明有东西只在隔离环境里成立
  steps.push({ name: '闸门① 第一夜 (headless chrome)', cmd: NODE, args: [path.join(ROOT, 'tools/first-night-check.mjs')] });
  // 多人：起一个独立服务端 + 两个真标签页。
  // 单元测试验的是服务端的差集逻辑，这里验的是整条链路真的通
  // （WebSocket 握手、帧编解码、把出生包画成一个人）——
  // 两者少了哪一半都可能"全绿但连不上"。
  steps.push({ name: '多人 (两个标签页)', cmd: NODE, args: [path.join(ROOT, 'tools/mp-check.mjs')] });
  // 性能：只跑 1 分钟。帧率在软件渲染下不作数（工具自己会判断并跳过），
  // 但**服务端每刻耗时**与**堆漂移**与 GPU 无关，任何机器上都作数。
  // 十分钟的完整内存验收用 node tools/perf-check.mjs --minutes 10 单跑
  steps.push({ name: '性能 (1 分钟)', cmd: NODE, args: [path.join(ROOT, 'tools/perf-check.mjs'), '--rd', '4', '--minutes', '1'] });
}

let failed = 0;
const t0 = Date.now();

for (const step of steps) {
  const label = `[ci] ${step.name}`;
  console.log(`\n${label} ...`);
  const started = Date.now();
  const res = spawnSync(step.cmd, step.args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  const ms = Date.now() - started;
  if (res.error) {
    console.error(`${label} 启动失败: ${res.error.message}`);
    failed++;
  } else if (res.status !== 0) {
    console.error(`${label} 失败 (exit ${res.status}, ${ms}ms)`);
    failed++;
  } else {
    console.log(`${label} ok (${ms}ms)`);
  }
}

const total = Date.now() - t0;
console.log(`\n${'='.repeat(56)}`);
if (failed === 0) {
  console.log(`[ci] 全部通过 (${steps.length} 步, ${total}ms)`);
  process.exit(0);
} else {
  console.error(`[ci] ${failed}/${steps.length} 步失败 (${total}ms)`);
  process.exit(1);
}
