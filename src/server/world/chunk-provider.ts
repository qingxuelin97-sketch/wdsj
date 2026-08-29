/**
 * 区块来源。
 *
 * 把"区块从哪来"抽成接口，是为了让 ServerWorld 不认识 Worker ——
 * `node --test` 里直接同步生成，浏览器里走 gen worker 池，多人服务器上
 * 将来还可以是"从存档读"。ServerCore 及其以下不含任何 Worker 依赖，
 * 这是整个验证体系的地基（见 docs/DESIGN.md）。
 */
import type { Chunk } from '../../core/world/chunk.ts';

export interface ChunkProvider {
  /**
   * 请求生成一个区块。
   * @returns 是否受理。在途太多时返回 false，调用方下个 tick 再试。
   */
  request(cx: number, cz: number): boolean;
  /** 取走已经生成好的区块。返回的数组由调用方消费 */
  drain(): Chunk[];
  /** 还有多少个在途 */
  readonly inFlight: number;
}
