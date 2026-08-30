/**
 * 零依赖开发服务器。
 *
 * 核心：用 Node 内置的 module.stripTypeScriptTypes 现场剥离 TS 类型，直接喂给浏览器。
 * 剥离是"保留空白"的（`const x: number = 1` -> `const x         = 1`），行数与每行
 * 列宽都与源文件逐字符对齐，所以不需要 sourcemap —— DevTools 的栈帧直接指到 .ts 原位。
 *
 * 用法: node tools/dev-server.mjs [--port 8080] [--root <dir>]
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

// stripTypeScriptTypes 是实验特性，每次调用都会打一条 ExperimentalWarning，刷屏。
// 只屏蔽这一条，其它警告照常。
const origEmitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
  if (type === 'ExperimentalWarning' && String(warning).includes('stripTypeScriptTypes')) return;
  return origEmitWarning.call(process, warning, ...rest);
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const PORT = Number(argOf('--port', 8080));

/**
 * 资源包挂载点。`--pack <dir>` 把一个**仓库外**的目录挂到 `/pack/`。
 *
 * 为什么要有：资源包覆盖层（src/client/render/resource-pack.ts）要通过
 * HTTP 拿 PNG，而素材按纪律不能进仓库。跨域另起一个服务器又要处理 CORS
 * 和 COEP（本服务器给所有响应打了 require-corp，跨域资源会被直接拦掉）。
 * 挂载在同源之下最省事。
 *
 * 用法: node tools/dev-server.mjs --pack "D:/.minecraft/unpacked"
 *       然后开 http://127.0.0.1:8080/?pack=/pack/
 */
const PACK_DIR = argOf('--pack', '') === '' ? null : path.resolve(argOf('--pack', ''));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8', // 剥离后就是 JS
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.bin': 'application/octet-stream',
};

/** 剥离结果缓存，key = 绝对路径，失效条件 = mtimeMs 或 size 变化 */
const stripCache = new Map();

/** 打开的 SSE 连接，用于热重载 */
const sseClients = new Set();

/**
 * 把 URL 路径安全地映射到磁盘路径，越界返回 null。
 *
 * `/pack/...` 走挂载的资源包目录，其余走仓库根。两边都要做越界检查 ——
 * 少了它 `/pack/../../etc/passwd` 就能读到挂载目录外面去。
 */
function resolveSafe(urlPath) {
  const decoded = decodeURIComponent(urlPath);
  if (decoded.startsWith('/pack/')) {
    if (PACK_DIR === null) return null;
    const abs = path.resolve(PACK_DIR, '.' + decoded.slice('/pack'.length));
    const rel = path.relative(PACK_DIR, abs);
    return rel.startsWith('..') || path.isAbsolute(rel) ? null : abs;
  }
  const abs = path.resolve(ROOT, '.' + decoded);
  const rel = path.relative(ROOT, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

/** 每个响应都带上 COOP/COEP —— SharedArrayBuffer（服务端 tick 时钟）需要 */
function baseHeaders(extra = {}) {
  return {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cache-Control': 'no-store',
    ...extra,
  };
}

async function serveTypeScript(abs, res) {
  const st = await fsp.stat(abs);
  const cached = stripCache.get(abs);
  let js;
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    js = cached.js;
  } else {
    const src = await fsp.readFile(abs, 'utf8');
    try {
      js = stripTypeScriptTypes(src, { mode: 'strip' });
    } catch (err) {
      // 语法错误：返回一个会在浏览器控制台报错的模块，而不是 500，
      // 这样热重载后页面能给出可读的错误位置。
      const msg = String(err && err.message ? err.message : err);
      const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
      console.error(`[strip] ${rel}: ${msg}`);
      js = `console.error(${JSON.stringify(`TS strip failed in ${rel}:\n${msg}`)});\nthrow new Error(${JSON.stringify(`TS strip failed in ${rel}`)});\n`;
      res.writeHead(200, baseHeaders({ 'Content-Type': MIME['.ts'] }));
      res.end(js);
      return;
    }
    stripCache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, js });
  }
  res.writeHead(200, baseHeaders({ 'Content-Type': MIME['.ts'] }));
  res.end(js);
}

async function serveStatic(abs, res) {
  const ext = path.extname(abs).toLowerCase();
  const body = await fsp.readFile(abs);
  res.writeHead(200, baseHeaders({ 'Content-Type': MIME[ext] ?? 'application/octet-stream' }));
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  try {
    // --- 热重载 SSE ---
    if (pathname === '/__reload') {
      res.writeHead(200, baseHeaders({
        'Content-Type': 'text/event-stream',
        Connection: 'keep-alive',
      }));
      res.write('retry: 500\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // --- 客户端日志汇聚 ---
    if (pathname === '/__log' && req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        const entries = JSON.parse(text);
        for (const e of Array.isArray(entries) ? entries : [entries]) {
          const level = String(e.level ?? 'log').toUpperCase();
          console.log(`[page:${level}] ${e.msg ?? ''}`);
        }
      } catch {
        console.log(`[page] ${text}`);
      }
      res.writeHead(204, baseHeaders());
      res.end();
      return;
    }

    // --- 首页 ---
    if (pathname === '/' || pathname === '/index.html') {
      const abs = path.join(ROOT, 'index.html');
      if (fs.existsSync(abs)) return await serveStatic(abs, res);
      res.writeHead(404, baseHeaders({ 'Content-Type': MIME['.html'] }));
      res.end('<h1>index.html not found</h1>');
      return;
    }

    const abs = resolveSafe(pathname);
    if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      res.writeHead(404, baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
      res.end(`404 ${pathname}`);
      return;
    }

    if (abs.endsWith('.ts')) return await serveTypeScript(abs, res);
    return await serveStatic(abs, res);
  } catch (err) {
    console.error('[dev-server]', err);
    res.writeHead(500, baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
    res.end(String(err && err.stack ? err.stack : err));
  }
});

// --- 文件监听 + 防抖广播 ---
let reloadTimer = null;
function scheduleReload(file) {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    if (sseClients.size === 0) return;
    console.log(`[reload] ${file ?? ''} -> ${sseClients.size} client(s)`);
    for (const res of sseClients) res.write('event: reload\ndata: 1\n\n');
  }, 50);
}

for (const dir of ['src', 'assets', 'index.html']) {
  const target = path.join(ROOT, dir);
  if (!fs.existsSync(target)) continue;
  fs.watch(target, { recursive: fs.statSync(target).isDirectory() }, (_evt, name) => {
    scheduleReload(name ? String(name) : dir);
  });
}

server.listen(PORT, () => {
  console.log(`dev-server  http://localhost:${PORT}/   root=${ROOT}`);
  console.log('  .ts 现场类型剥离 · COOP/COEP 已开(SAB 可用) · /__reload SSE · /__log 日志汇聚');
  if (PACK_DIR !== null) {
    console.log(`  资源包挂在 /pack/ -> ${PACK_DIR}   用 http://localhost:${PORT}/?pack=/pack/ 打开`);
  }
});
