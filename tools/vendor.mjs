/**
 * 重建供应的工具链。
 *
 * 本项目零 npm 依赖，但类型检查和生产构建仍需要 tsc 与 esbuild。这两样都从**本机已有的
 * 安装**复制过来，不下载任何东西 —— 网络上 registry 直连不通，而且往多步计划里夹带下载
 * 是明确禁止的。
 *
 * 复制来的东西都在 .gitignore 里，所以换机器或清理后跑一次本脚本即可恢复。
 *
 * 用法: node tools/vendor.mjs [--from <pnpm-store-dir>]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 需要的包与其在项目内的落点 */
const NEEDED = [
  {
    name: 'esbuild 可执行文件',
    from: ['@esbuild+win32-x64@0.25.12', 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'],
    to: ['tools', 'bin', 'esbuild.exe'],
    kind: 'file',
    verify: 'tools/bin/esbuild.exe',
  },
  {
    name: 'TypeScript',
    from: ['typescript@5.9.3', 'node_modules', 'typescript'],
    to: ['tools', 'vendor', 'typescript'],
    kind: 'dir',
    verify: 'tools/vendor/typescript/bin/tsc',
  },
  {
    name: '@types/node',
    from: ['@types+node@22.20.1', 'node_modules', '@types', 'node'],
    to: ['tools', 'vendor', '@types', 'node'],
    kind: 'dir',
    verify: 'tools/vendor/@types/node/index.d.ts',
  },
];

/** 在本机找一个包含所需包的 pnpm store */
function findStore(explicit) {
  const candidates = [
    explicit,
    path.join(os.homedir(), 'Documents', 'ga', 'node_modules', '.pnpm'),
    path.join(os.homedir(), 'AppData', 'Local', 'pnpm', 'store'),
    'D:\\.pnpm-store',
  ].filter(Boolean);
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    // 至少要能找到 typescript，才认为这个 store 有用
    const entries = fs.readdirSync(c);
    if (entries.some((e) => e.startsWith('typescript@'))) return c;
  }
  return null;
}

const argIdx = process.argv.indexOf('--from');
const store = findStore(argIdx >= 0 ? process.argv[argIdx + 1] : undefined);

if (store === null) {
  console.error('找不到含所需包的本机 pnpm store。');
  console.error('可用 --from <目录> 指定，例如：');
  console.error('  node tools/vendor.mjs --from "C:\\Users\\me\\Documents\\ga\\node_modules\\.pnpm"');
  process.exit(1);
}
console.log(`[vendor] 源: ${store}`);

let failed = 0;
for (const item of NEEDED) {
  const src = path.join(store, ...item.from);
  const dst = path.join(ROOT, ...item.to);
  if (fs.existsSync(path.join(ROOT, item.verify))) {
    console.log(`[vendor] ${item.name}: 已存在，跳过`);
    continue;
  }
  if (!fs.existsSync(src)) {
    console.error(`[vendor] ${item.name}: 源不存在 ${src}`);
    failed++;
    continue;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (item.kind === 'file') fs.copyFileSync(src, dst);
  else fs.cpSync(src, dst, { recursive: true });
  console.log(`[vendor] ${item.name}: 已复制到 ${path.relative(ROOT, dst)}`);
}

// 复制完再逐个确认落点真的可用，而不是"复制命令没报错"就算成功
for (const item of NEEDED) {
  const p = path.join(ROOT, item.verify);
  if (!fs.existsSync(p)) {
    console.error(`[vendor] 校验失败: 缺少 ${item.verify}`);
    failed++;
  }
}

if (failed > 0) {
  console.error(`[vendor] ${failed} 项失败`);
  process.exit(1);
}
console.log('[vendor] 工具链就绪');
