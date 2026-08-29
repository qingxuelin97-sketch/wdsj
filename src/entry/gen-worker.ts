/**
 * 世界生成 worker。
 *
 * 生成一个区块要 9.6 ms，而一个 tick 只有 50 ms。留在服务端线程里的话，
 * 加载期间每个 tick 都在生成区块 —— 实测 RD 8 首次加载时单 tick 的
 * p50 是 96.9 ms、最大 269.6 ms，79 个 tick 里有 62 个超预算，
 * 服务端等于在以 10 TPS 跑。玩家看到的是地形一块一块慢慢长出来。
 *
 * 搬到这里之后服务端线程只剩"收货 + 播光照 + 编码下发"。
 *
 * 之所以能这么搬，是因为世界生成是 (seed, cx, cz) 的**纯函数**：
 * 每一列独立推导所有与它相交的结构，不依赖任何邻居状态，也不依赖生成顺序
 * （tests/server/worldgen.test.ts 里"生成顺序不影响结果"就是锁这条的）。
 * 否则并行生成会立刻产生跨区块的接缝。
 */
import { OverworldGenerator } from '../server/world/gen/overworld-gen.ts';
import { createBlockRegistry } from '../content/blocks.ts';
import { encodeChunk } from '../core/world/chunk-codec.ts';

interface StartMessage {
  kind: 'start';
  seed: number;
}
interface GenMessage {
  kind: 'gen';
  cx: number;
  cz: number;
}

let generator: OverworldGenerator | null = null;

self.onmessage = (ev: MessageEvent): void => {
  const msg = ev.data as StartMessage | GenMessage;

  if (msg.kind === 'start') {
    generator = new OverworldGenerator(BigInt(msg.seed), createBlockRegistry());
    self.postMessage({ kind: 'ready' });
    return;
  }

  if (msg.kind === 'gen') {
    if (generator === null) throw new Error('gen-worker 还没初始化就收到了生成请求');
    const chunk = generator.generate(msg.cx, msg.cz);
    const blob = encodeChunk(chunk);
    // 缓冲的所有权转移给服务端线程，避免复制近百 KB
    self.postMessage({ kind: 'chunk', cx: msg.cx, cz: msg.cz, blob }, [blob.buffer]);
  }
};
