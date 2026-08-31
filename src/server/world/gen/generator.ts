/**
 * 世界生成器接口。
 *
 * ServerWorld 对生成器的全部要求就下面两条 —— 这一点直到要加下界时
 * 才看得出价值：主世界生成器有 8 个子系统（密度场、洞穴、矿脉、地表、
 * 装饰……），但**世界本身一个都不认识**，它只会 `generate(cx, cz)`。
 * 于是"多一个维度"在 ServerWorld 里是零改动。
 *
 * 把接口单独放一个文件而不是从 overworld-gen 里导出，是为了让
 * nether-gen / end-gen 不必 import 主世界生成器 —— 那会让三个维度
 * 在模块图上串成一条链，改一个牵动另外两个。
 */
import type { Chunk } from '../../../core/world/chunk.ts';

export interface WorldGenerator {
  /** 生成一个区块。必须是确定性的：同种子同坐标逐格相同 */
  generate(cx: number, cz: number): Chunk;
  /**
   * 这个维度的默认落脚点。
   *
   * 下界与末地并不真的用它来"出生"（玩家总是从传送门进来的），
   * 但指令 `tp` 和"传送门算出来的落点被岩浆占了"这类兜底要用。
   */
  findSpawn(): { x: number; y: number; z: number };
}
