/**
 * 区块的序列化格式。网络传输与存档共用。
 *
 * 内存里的区块是直白的 Uint16Array（见 docs/DEVIATIONS.md：省内存不划算，
 * 换来热路径无位移掩码）；但**上网和落盘时**必须压，一个地表区块的原始数据是 96 KB，
 * 调色板加位打包后通常 4–9 KB。
 *
 * 列格式：
 *   u16  sectionMask     每一位表示对应子区块是否存在
 *   u8   heightmap[256]
 *   u8   biomes[256]
 *   每个存在的子区块：
 *     u8   paletteLen    0 表示这一段用原始 u16（调色板超过 255 项时）
 *     u16  palette[paletteLen]
 *     u8   bitsPerBlock  4 / 8 / 16
 *     ...  位打包的调色板索引，或原始状态
 *     u8   light[4096]
 */
import { Chunk, ChunkSection, SECTION_VOLUME, AIR_STATE } from './chunk.ts';
import { SECTIONS_PER_COLUMN, CHUNK_SIZE } from '../constants.ts';
import { ByteWriter, ByteReader } from '../net/codec.ts';

const AREA = CHUNK_SIZE * CHUNK_SIZE;

/** 按调色板大小选每格用几位 */
function bitsFor(paletteLen: number): number {
  if (paletteLen <= 16) return 4;
  if (paletteLen <= 256) return 8;
  return 16;
}

function writeSection(w: ByteWriter, s: ChunkSection): void {
  // 建调色板
  const palette: number[] = [];
  const lookup = new Map<number, number>();
  for (let i = 0; i < SECTION_VOLUME; i++) {
    const v = s.states[i]!;
    if (!lookup.has(v)) {
      lookup.set(v, palette.length);
      palette.push(v);
      // 超过 255 项就不值得再建了，直接走原始 u16
      if (palette.length > 255) break;
    }
  }

  if (palette.length > 255) {
    w.u8(0); // 0 = 无调色板
    w.u8(16);
    for (let i = 0; i < SECTION_VOLUME; i++) w.u16(s.states[i]!);
  } else {
    w.u8(palette.length);
    for (const v of palette) w.u16(v);
    const bits = bitsFor(palette.length);
    w.u8(bits);
    if (bits === 4) {
      // 两个索引挤一个字节
      for (let i = 0; i < SECTION_VOLUME; i += 2) {
        const a = lookup.get(s.states[i]!)!;
        const b = lookup.get(s.states[i + 1]!)!;
        w.u8((a & 0xf) | ((b & 0xf) << 4));
      }
    } else {
      for (let i = 0; i < SECTION_VOLUME; i++) w.u8(lookup.get(s.states[i]!)!);
    }
  }
  w.bytes(s.light);
}

function readSection(r: ByteReader): ChunkSection {
  const states = new Uint16Array(SECTION_VOLUME);
  const paletteLen = r.u8();

  if (paletteLen === 0) {
    const bits = r.u8();
    if (bits !== 16) throw new Error(`无调色板的段应为 16 位，实得 ${bits}`);
    for (let i = 0; i < SECTION_VOLUME; i++) states[i] = r.u16();
  } else {
    const palette = new Uint16Array(paletteLen);
    for (let i = 0; i < paletteLen; i++) palette[i] = r.u16();
    const bits = r.u8();
    if (bits === 4) {
      for (let i = 0; i < SECTION_VOLUME; i += 2) {
        const b = r.u8();
        states[i] = palette[b & 0xf]!;
        states[i + 1] = palette[(b >> 4) & 0xf]!;
      }
    } else if (bits === 8) {
      for (let i = 0; i < SECTION_VOLUME; i++) states[i] = palette[r.u8()]!;
    } else {
      throw new Error(`不支持的位宽 ${bits}`);
    }
  }

  const light = new Uint8Array(r.bytes(SECTION_VOLUME));
  return new ChunkSection(states, light);
}

/** 把一个区块列编码成字节 */
export function encodeChunk(chunk: Chunk): Uint8Array {
  const w = new ByteWriter(16384);

  let mask = 0;
  for (let sy = 0; sy < SECTIONS_PER_COLUMN; sy++) {
    const s = chunk.sections[sy];
    // 全空气的段不传：接收方按 mask 还原成 null，省掉 12 KB
    if (s != null && !s.isEmpty) mask |= 1 << sy;
  }
  w.u16(mask);
  w.bytes(chunk.heightmap);
  w.bytes(chunk.biomes);

  for (let sy = 0; sy < SECTIONS_PER_COLUMN; sy++) {
    if ((mask & (1 << sy)) === 0) continue;
    writeSection(w, chunk.sections[sy]!);
  }
  return w.toUint8Array();
}

/** 从字节还原一个区块列 */
export function decodeChunk(cx: number, cz: number, data: Uint8Array): Chunk {
  const r = new ByteReader(data);
  const chunk = new Chunk(cx, cz);
  const mask = r.u16();
  chunk.heightmap.set(r.bytes(AREA));
  // 解码出来的区块光照就是服务端算好的最终值
  chunk.lightReady = true;
  chunk.biomes.set(r.bytes(AREA));

  for (let sy = 0; sy < SECTIONS_PER_COLUMN; sy++) {
    if ((mask & (1 << sy)) === 0) continue;
    chunk.sections[sy] = readSection(r);
  }
  return chunk;
}

/**
 * 抽取一个子区块及其一圈邻域，打包成 mesher 需要的 18³ 输入。
 *
 * 这一圈是必须的：没有它，边界处的面剔除、AO、光照全错，
 * 表现为每 16 格一条可见的光照缝（前作就是这样）。
 */
export function extractPaddedNeighborhood(
  getState: (x: number, y: number, z: number) => number,
  getLight: (x: number, y: number, z: number) => number,
  getBiome: (x: number, z: number) => number,
  cx: number,
  cy: number,
  cz: number,
  outBlocks: Uint16Array,
  outLight: Uint8Array,
  outBiomes: Uint8Array,
): void {
  const P = CHUNK_SIZE + 2;
  const baseX = cx * CHUNK_SIZE - 1;
  const baseY = cy * CHUNK_SIZE - 1;
  const baseZ = cz * CHUNK_SIZE - 1;

  for (let py = 0; py < P; py++) {
    const wy = baseY + py;
    for (let pz = 0; pz < P; pz++) {
      const wz = baseZ + pz;
      const rowBase = (py * P + pz) * P;
      for (let px = 0; px < P; px++) {
        const wx = baseX + px;
        const i = rowBase + px;
        outBlocks[i] = getState(wx, wy, wz);
        outLight[i] = getLight(wx, wy, wz);
      }
    }
  }
  for (let pz = 0; pz < P; pz++) {
    for (let px = 0; px < P; px++) {
      outBiomes[pz * P + px] = getBiome(baseX + px, baseZ + pz);
    }
  }
  void AIR_STATE;
}
