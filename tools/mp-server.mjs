/**
 * 独立多人服务端。**零依赖的 WebSocket 实现**，跑在 node 上。
 *
 * ## 为什么自己写 WebSocket
 *
 * 本项目零 npm 依赖。而 WebSocket 的服务端侧其实很小：一次
 * HTTP Upgrade 握手（SHA-1 + base64，node 的 crypto 自带）加上
 * 一个帧编解码器。真正麻烦的是客户端侧（掩码、分片、扩展协商），
 * 而客户端侧由浏览器提供 —— 我们只需要**读带掩码的帧、写不带掩码的帧**。
 *
 * ## 与浏览器内的服务端是同一份代码
 *
 * `ServerCore` 不含任何 Worker/DOM 依赖（docs/DESIGN.md 的地基），
 * 所以这里 `new ServerCore()` 拿到的和单人模式里 worker 内跑的
 * 是同一个东西。多人与单人的差别只有两样：传输换成 socket、
 * tick 由 setInterval 驱动。
 *
 * 用法：
 *   node tools/mp-server.mjs [--port 8100] [--seed 1234] [--save ./world]
 * 然后浏览器开两个标签页：
 *   http://127.0.0.1:8100/?server=ws://127.0.0.1:8100/ws
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg('port', 8100));
const SEED = Number(arg('seed', 1234));
const SAVE_DIR = arg('save', '');

// ---------------------------------------------------------------------------
// WebSocket：握手 + 帧
// ---------------------------------------------------------------------------

/**
 * RFC 6455 的魔法串。握手时拼在客户端的 key 后面做 SHA-1。
 *
 * 最后一组是 **C5AB0DC85B11**，那个 C 在开头不在结尾。写反了的话
 * 服务端照样会回 101、连接照样建立，但浏览器会在校验
 * Sec-WebSocket-Accept 时静默断开 —— 服务端这边只看到
 * "有人连上又走了"，一个字节的应用数据都没收到。
 * 用 RFC 里的例子对一遍就能发现：
 *   key "dGhlIHNhbXBsZSBub25jZQ==" -> "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * 解一个客户端发来的帧。
 *
 * 只处理二进制帧与 close/ping —— 本协议不发文本。
 * 客户端发来的帧**一定带掩码**（RFC 要求），所以掩码分支不是可选的。
 *
 * @returns {{opcode:number, payload:Buffer, rest:Buffer}|null} 数据不够时 null
 */
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < off + 2) return null;
    len = buf.readUInt16BE(off);
    off += 2;
  } else if (len === 127) {
    if (buf.length < off + 8) return null;
    // 帧长超过 2^32 在本协议里不可能出现（最大的包是一个区块，几十 KB）
    len = Number(buf.readBigUInt64BE(off));
    off += 8;
  }
  let mask = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    mask = buf.subarray(off, off + 4);
    off += 4;
  }
  if (buf.length < off + len) return null;
  const payload = Buffer.from(buf.subarray(off, off + len));
  if (mask !== null) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  }
  // 不做分片重组：本协议的每个消息都是一整帧发出去的。
  // 真收到分片就当协议错误断开，好过悄悄拼出一个错的包
  if (!fin) return { opcode: -1, payload, rest: buf.subarray(off + len) };
  return { opcode, payload, rest: buf.subarray(off + len) };
}

/** 编一个服务端发出的帧。服务端**不加掩码** */
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

/** 把一个已升级的 socket 包成本项目的 Transport */
function socketTransport(socket) {
  let onMessage = () => {};
  let onClose = () => {};
  let closed = false;
  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    for (;;) {
      const frame = decodeFrame(buffer);
      if (frame === null) break;
      buffer = frame.rest;
      if (frame.opcode === 0x8 || frame.opcode === -1) { socket.destroy(); return; }
      if (frame.opcode === 0x9) { socket.write(encodeFrame(0xa, frame.payload)); continue; }
      if (frame.opcode !== 0x2) continue;
      if (process.env['MP_DEBUG'] === '1') {
        console.log(`[ws] 收到 ${frame.payload.length} 字节`);
      }
      onMessage(new Uint8Array(frame.payload));
    }
  });
  const finish = () => {
    if (closed) return;
    closed = true;
    onClose();
  };
  socket.on('close', finish);
  socket.on('error', finish);

  return {
    send(data) {
      if (closed) return;
      socket.write(encodeFrame(0x2, Buffer.from(data.buffer, data.byteOffset, data.byteLength)));
    },
    onMessage(cb) { onMessage = cb; },
    onClose(cb) { onClose = cb; },
    close() { socket.destroy(); },
    get closed() { return closed; },
  };
}

// ---------------------------------------------------------------------------
// 静态文件（把客户端也一起服务了，省得再起一个 dev-server）
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json',
};

async function main() {
  // 动态 import：这个脚本本身是 .mjs，而服务端是 .ts。
  // node 的类型剥离让它可以直接被 import
  const { ServerCore } = await import(pathToFileURL(path.join(ROOT, 'src/server/server-core.ts')));
  const { createBlockRegistry } = await import(pathToFileURL(path.join(ROOT, 'src/content/blocks.ts')));
  const { TPS, MS_PER_TICK } = await import(pathToFileURL(path.join(ROOT, 'src/core/constants.ts')));

  const core = new ServerCore({ seed: SEED, registry: createBlockRegistry() });

  if (SAVE_DIR !== '') {
    const { FsStorage } = await import(pathToFileURL(path.join(ROOT, 'src/platform/storage-fs.ts')));
    const { WorldSave } = await import(pathToFileURL(path.join(ROOT, 'src/server/save/world-save.ts')));
    const dir = path.resolve(SAVE_DIR);
    fs.mkdirSync(dir, { recursive: true });
    core.world.save = new WorldSave(new FsStorage(dir));
    console.log(`[mp] 存档目录 ${dir}`);
  }

  const strip = await import('node:module');
  void strip;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    let rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    const ext = path.extname(file);
    let body = fs.readFileSync(file);
    if (ext === '.ts') {
      // 与 dev-server 一样：现场剥类型。零构建步骤是本项目的一条规矩
      body = Buffer.from(strip.stripTypeScriptTypes(body.toString('utf8'), {
        mode: 'strip', sourceMap: false,
      }));
    }
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' }).end(body);
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    const player = core.addClient(socketTransport(socket));
    console.log(`[mp] 玩家 ${player.entityId} 连上了，在线 ${[...core.eachPlayer()].length}`);
  });

  server.listen(PORT, () => {
    console.log(`[mp] http://127.0.0.1:${PORT}/  种子 ${SEED}`);
    console.log(`[mp] 浏览器开两个标签页：http://127.0.0.1:${PORT}/?server=ws://127.0.0.1:${PORT}/ws`);
  });

  // tick 由 setInterval 驱动。**服务端自己不读挂钟** —— 这里读的是
  // 宿主的挂钟，用来填统计与决定什么时候调 tick()，ServerCore 内部一无所知
  let last = Date.now();
  setInterval(() => {
    const t0 = Date.now();
    core.tick();
    core.lastTickMs = Date.now() - t0;
    const drift = t0 - last - MS_PER_TICK;
    // 落后一个 tick 以上就报一次。多人服务端最要紧的健康指标就是它
    if (drift > MS_PER_TICK) console.log(`[mp] 落后 ${drift}ms（tick ${core.lastTickMs}ms）`);
    last = t0;
  }, MS_PER_TICK);
  void TPS;
}

main().catch((e) => {
  console.error('[mp] 起不来:', e);
  process.exit(1);
});
