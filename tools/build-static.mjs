/**
 * 把整个项目编译成一坨**纯静态文件**，用来发到 GitHub Pages。
 *
 * ## 这不是在给项目加构建步骤
 *
 * 开发依然是零构建的：`node tools/dev-server.mjs` 现场剥类型直接喂浏览器，
 * 那条路一个字没变。这个脚本只服务于一件事 —— GitHub Pages 只会原样吐文件，
 * 没有服务端可以帮你剥 TypeScript，所以**部署这一条路**必须先离线剥好。
 *
 * 换句话说：dev 是零构建，deploy 需要这一步。两条路用的是同一个
 * `module.stripTypeScriptTypes`，所以不会出现"开发能跑、线上不一样"的分裂。
 *
 * ## 做了什么
 *
 * 1. `src/**\/*.ts` 逐个剥类型，写成同名 `.js`
 * 2. 把 import 里的 `./x.ts` 重写成 `./x.js` —— 浏览器按字面加载，
 *    `.ts` 后缀在静态托管上就是 404
 * 3. `index.html` 去掉只在 dev-server 下才有意义的两段（日志回传、热重载），
 *    并把入口指向 `.js`
 * 4. 写一个 `.nojekyll`：GitHub Pages 默认跑 Jekyll，会吃掉下划线开头的路径
 *
 * 用法: node tools/build-static.mjs [--out dist]
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

// 与 dev-server 同理：只屏蔽剥类型那一条实验性警告，别的照常
const origEmitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const text = typeof warning === 'string' ? warning : String(warning?.message ?? '');
  if (text.includes('stripTypeScriptTypes')) return;
  origEmitWarning.call(process, warning, ...rest);
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const OUT = path.resolve(ROOT, argOf('--out', 'dist'));

/**
 * 替换掉 dev-only 那段脚本的线上版本。
 *
 * **保留**致命错误的显示：线上出问题时，玩家能截个图发过来比什么都强，
 * 而一个白屏什么信息都没有。
 * **去掉**日志回传（往 /__log POST，线上每次都 404）与 SSE 热重载
 * （连 /__reload，同样 404 且会不停重连）。
 */
const STATIC_BOOT = `  <script type="module">
    // 线上没有 dev-server，所以不回传日志、不热重载。
    // 但**致命错误照样要显示** —— 白屏是最没用的错误报告
    const showFatal = (text) => {
      const el = document.getElementById('fatal');
      el.style.display = 'block';
      el.textContent = String(text);
    };
    window.addEventListener('error', (e) => {
      showFatal(e.error ? (e.error.stack || e.error.message) : e.message);
    });
    window.addEventListener('unhandledrejection', (e) => {
      showFatal(e.reason && e.reason.stack ? e.reason.stack : String(e.reason));
    });
  </script>`;

/**
 * 把模块说明符里的 `.ts` 换成 `.js`。
 *
 * 只认**以 `.` 开头**的相对路径，所以不会误伤代码里恰好写着 ".ts" 的字符串
 * （比如错误信息里的 "在 tile-recipes.ts 里补上"）。
 *
 * 三种写法都要照顾到，漏一种就是运行时 404：
 *   import x from './a.ts'        普通 import
 *   await import('./b.ts')        动态 import
 *   new URL('./c.ts', import.meta.url)   worker 的入口
 * 它们在源码里都是"引号 + 点开头 + .ts + 同种引号"，所以一条正则够了。
 */
function rewriteSpecifiers(code) {
  return code.replace(/(['"])(\.[^'"\n]*?)\.ts\1/g, '$1$2.js$1');
}

/** 递归收集 src 下所有 .ts */
function collect(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

await fsp.rm(OUT, { recursive: true, force: true });
await fsp.mkdir(OUT, { recursive: true });

// --- 1. 源码 ---
const files = collect(path.join(ROOT, 'src'));
let bytes = 0;
for (const abs of files) {
  const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
  const src = await fsp.readFile(abs, 'utf8');
  // mode:'strip' 保留空白，行列与源文件逐字符对齐 —— 线上报错的栈帧
  // 仍然指得回源码的正确位置，不需要 sourcemap
  const js = rewriteSpecifiers(stripTypeScriptTypes(src, { mode: 'strip', sourceMap: false }));
  const dst = path.join(OUT, rel.replace(/\.ts$/, '.js'));
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.writeFile(dst, js);
  bytes += Buffer.byteLength(js);
}

// --- 2. index.html ---
let html = await fsp.readFile(path.join(ROOT, 'index.html'), 'utf8');

// 入口换成 .js，并且**改成相对路径**：项目页发布在
// https://<用户>.github.io/<仓库>/ 下，绝对路径的 /src/... 会打到域名根上
html = html.replace('src="/src/entry/client-main.ts"', 'src="./src/entry/client-main.js"');

// 去掉整段只在 dev-server 下才成立的脚本（日志回传到 stdout、SSE 热重载）。
// 留着的话线上每 400ms 往 /__log POST 一次、每次都 404，控制台会被刷满。
const devStart = html.indexOf('  <script type="module">');
const devEnd = html.indexOf('</script>', devStart);
if (devStart < 0 || devEnd < 0) {
  throw new Error('index.html 里找不到那段 dev-only 脚本 —— 结构变了，构建脚本要跟着改');
}
html = html.slice(0, devStart) + STATIC_BOOT + html.slice(devEnd + '</script>'.length);

await fsp.writeFile(path.join(OUT, 'index.html'), html);

// --- 3. Pages 的两个杂项 ---
// Jekyll 会忽略下划线开头的文件/目录。这个项目现在没有，但以后加了
// 会变成"本地好好的、线上 404"这种最难查的问题，先堵上
await fsp.writeFile(path.join(OUT, '.nojekyll'), '');

console.log(`[build] ${files.length} 个模块 -> ${path.relative(ROOT, OUT)}/  (${(bytes / 1024).toFixed(0)} KB)`);
console.log('[build] 本地预览: node tools/serve-static.mjs');
