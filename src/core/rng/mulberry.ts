/**
 * mulberry32 与 FNV-1a。
 *
 * 放在 core 是因为**两个互不相关的子系统都要它**：贴图生成按名字播种，
 * 环境音调度按固定种子播种。原来它俩都长在 `client/render/texgen.ts` 里，
 * 于是音频那边要 `import { mulberry32 } from '../client/render/texgen.ts'` ——
 * 一个音频模块依赖渲染模块，只为了拿一个随机数发生器。
 *
 * 这两个函数与渲染毫无关系，属于 core 的通用工具。
 *
 * 与 `core/rng/java-random.ts` 的分工：那个要与 JDK 逐位一致（世界生成
 * 必须和 MC 对得上），这个只要求**快而且确定**，用在不需要与 MC 对齐的地方。
 */

/** FNV-1a，把字符串变成稳定的 32 位种子 */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32：小巧、质量足够、状态只有一个 uint32 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
