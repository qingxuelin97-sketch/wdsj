/**
 * 把程序化贴图渲成一张 PNG 供肉眼检查。零依赖（只用 node:zlib 做 PNG 压缩）。
 *
 * 为什么要有它：改贴图配方原本只能起 dev-server + 无头 Chrome 看，一轮一分钟。
 * 贴图生成是**纯函数**（没有 DOM、没有 GL），完全可以在 Node 里直接跑，
 * 一轮不到一秒。
 *
 * 每格默认按 2×2 平铺画：贴图接不接得上一眼就看出来 —— 这是 16×16 贴图
 * 最容易出问题也最容易被忽略的地方，单看一格永远发现不了。
 *
 * 用法:
 *   node tools/tile-sheet.mjs                        全部贴图 -> tests/out/tiles.png
 *   node tools/tile-sheet.mjs stone dirt grass_top    只看这几张
 *   node tools/tile-sheet.mjs --scale 8 --repeat 1    放大 8 倍、不平铺
 *   node tools/tile-sheet.mjs --out /tmp/a.png
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// stripTypeScriptTypes 的实验警告会刷屏，只屏蔽这一条
process.emitWarning = ((orig) => (warning, ...rest) => {
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
  if (type === 'ExperimentalWarning') return;
  return orig.call(process, warning, ...rest);
})(process.emitWarning);

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const SCALE = Number(argOf('--scale', 5));
const REPEAT = Number(argOf('--repeat', 2));
const COLS = Number(argOf('--cols', 8));
const OUT = argOf('--out', path.join(ROOT, 'tests/out/tiles.png'));
const GAP = 6;
const only = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));

// --- 最小 PNG 编码器 ---
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** rgba: Uint8Array，长度 w*h*4 */
function encodePng(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型 RGBA
  // 每条扫描线前面要加一个 filter 字节。全用 0（None）—— 图很小，
  // 压缩率无所谓，省掉一整套 filter 选择逻辑
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (1 + w * 4) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const { TilePainter, TILE_SIZE } = await load('src/client/render/texgen.ts');
const { RECIPES } = await load('src/client/render/tile-recipes.ts');
const { ITEM_RECIPES } = await load('src/client/render/item-recipes.ts');

const all = { ...RECIPES, ...ITEM_RECIPES };
const names = only.length > 0 ? only : Object.keys(all);
const missing = names.filter((n) => all[n] === undefined);
if (missing.length > 0) {
  console.error(`没有这些配方: ${missing.join(', ')}`);
  process.exit(1);
}

const cell = TILE_SIZE * SCALE * REPEAT;
const cols = Math.min(COLS, names.length);
const rows = Math.ceil(names.length / cols);
const W = cols * (cell + GAP) + GAP;
const H = rows * (cell + GAP) + GAP;
const sheet = new Uint8Array(W * H * 4);
// 背板画成中灰：纯黑或纯白背景会骗过眼睛 —— 深色贴图在黑底上看着"有对比"，
// 放进游戏里贴到亮天空旁边就发灰
for (let i = 0; i < W * H; i++) {
  sheet[i * 4] = 60;
  sheet[i * 4 + 1] = 60;
  sheet[i * 4 + 2] = 66;
  sheet[i * 4 + 3] = 255;
}

for (let i = 0; i < names.length; i++) {
  const name = names[i];
  const p = new TilePainter(name);
  all[name](p);
  p.bleedEdges(); // 与 buildAtlas 一致，否则看到的不是最终结果
  const ox = GAP + (i % cols) * (cell + GAP);
  const oy = GAP + Math.floor(i / cols) * (cell + GAP);
  for (let y = 0; y < cell; y++) {
    for (let x = 0; x < cell; x++) {
      const sx = Math.floor(x / SCALE) % TILE_SIZE;
      const sy = Math.floor(y / SCALE) % TILE_SIZE;
      const s = (sy * TILE_SIZE + sx) * 4;
      const a = p.data[s + 3] / 255;
      const d = ((oy + y) * W + ox + x) * 4;
      // 透明处混上背板，才看得出 cutout 的形状
      sheet[d] = p.data[s] * a + sheet[d] * (1 - a);
      sheet[d + 1] = p.data[s + 1] * a + sheet[d + 1] * (1 - a);
      sheet[d + 2] = p.data[s + 2] * a + sheet[d + 2] * (1 - a);
    }
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, encodePng(sheet, W, H));
console.log(`${names.length} 张贴图 -> ${OUT}  (${W}×${H}, 每格 ${REPEAT}×${REPEAT} 平铺)`);
for (let r = 0; r < rows; r++) {
  console.log(`  行${r + 1}: ${names.slice(r * cols, (r + 1) * cols).join('  ')}`);
}
