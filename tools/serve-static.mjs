/**
 * 预览 `dist/` 的静态服务器。**只发文件，不做任何处理** ——
 * 这正是它的价值：它模拟 GitHub Pages 的行为。
 *
 * 用 dev-server 预览是测不出问题的：那个会现场剥类型、会补 COOP/COEP 头，
 * 于是"忘了把 .ts 重写成 .js"这类构建 bug 在它下面完全看不出来，
 * 一发到 Pages 上就是满屏 404。
 *
 * 用法: node tools/serve-static.mjs [--port 8080] [--root dist]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const PORT = Number(argOf('--port', 8080));
const DIR = path.resolve(ROOT, argOf('--root', 'dist'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.css': 'text/css; charset=utf-8',
};

http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(DIR, decodeURIComponent(rel));
  // 目录穿越：把 ../ 挡在外面
  if (!file.startsWith(DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  res.end(fs.readFileSync(file));
}).listen(PORT, () => {
  console.log(`[static] http://127.0.0.1:${PORT}/  (root: ${path.relative(ROOT, DIR)})`);
  console.log('[static] 注意：**不带 COOP/COEP**，与 GitHub Pages 一致 ——');
  console.log('[static] 所以这里同样没有 SharedArrayBuffer，服务端会回落到 setTimeout 心跳');
});
