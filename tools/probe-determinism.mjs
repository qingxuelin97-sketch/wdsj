/**
 * 排查工具：世界状态在两次独立加载之间是否一致。
 *
 * 截图哈希不稳定时，先用它把问题定位到"世界数据"还是"渲染"。
 * 世界数据不一致 -> 服务端/光照的问题；世界一致而截图不同 -> 渲染或时序的问题。
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchChrome, openPage } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8097;

/** 在页面里对已加载世界做指纹：区块集合、方块、光照各一份哈希 */
const FINGERPRINT = `
  const m = window.__mc;
  await m.ready;
  await m.waitForIdle();
  const w = m._world();
  const keys = [];
  for (const c of w.store.chunkValues()) keys.push(c.cx + ',' + c.cz);
  keys.sort();

  let blockHash = 0x811c9dc5;
  let lightHash = 0x811c9dc5;
  const mix = (h, v) => { h ^= v; return Math.imul(h, 0x01000193) >>> 0; };
  for (const key of keys) {
    const [cx, cz] = key.split(',').map(Number);
    const c = w.store.getChunk(cx, cz);
    for (let sy = 0; sy < 8; sy++) {
      const sec = c.sections[sy];
      if (sec == null) { blockHash = mix(blockHash, 0xffff); continue; }
      for (let i = 0; i < sec.states.length; i += 7) blockHash = mix(blockHash, sec.states[i]);
      for (let i = 0; i < sec.light.length; i += 7) lightHash = mix(lightHash, sec.light[i]);
    }
  }
  return {
    chunkCount: keys.length,
    chunkSet: keys.join('|').length + ':' + keys[0] + '..' + keys[keys.length - 1],
    blockHash: (blockHash >>> 0).toString(16),
    lightHash: (lightHash >>> 0).toString(16),
    stats: m.stats(),
  };
`;

async function main() {
  const server = spawn(process.execPath, [path.join(ROOT, 'tools/dev-server.mjs'), '--port', String(PORT)], {
    cwd: ROOT, shell: false, stdio: 'ignore', env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  await new Promise((r) => setTimeout(r, 800));

  const chrome = await launchChrome({ port: 9335, headless: true });
  const results = [];
  try {
    for (let run = 0; run < 3; run++) {
      const page = await openPage(9335, `http://127.0.0.1:${PORT}/?seed=1234&rd=4`);
      const fp = await page.evaluate(FINGERPRINT);
      results.push(fp);
      console.log(
        `第 ${run + 1} 次: 区块=${fp.chunkCount} 方块哈希=${fp.blockHash} 光照哈希=${fp.lightHash} ` +
        `集合=${fp.chunkSet}`,
      );
      page.close();
    }
  } finally {
    await chrome.close();
    server.kill();
  }

  const same = (k) => results.every((r) => r[k] === results[0][k]);
  console.log('\n--- 结论 ---');
  console.log(`区块集合一致: ${same('chunkSet') ? '是' : '否'}`);
  console.log(`方块数据一致: ${same('blockHash') ? '是' : '否'}`);
  console.log(`光照数据一致: ${same('lightHash') ? '是' : '否'}`);
  process.exit(same('chunkSet') && same('blockHash') && same('lightHash') ? 0 : 1);
}

void main();
