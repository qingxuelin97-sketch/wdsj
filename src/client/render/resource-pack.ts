/**
 * 资源包覆盖层：用外部 PNG 顶掉程序化生成的贴图。
 *
 * ## 为什么是"覆盖"而不是"替换"
 *
 * 仓库里**不含任何 Mojang 素材**，也不下载任何东西 —— 那是版权问题，
 * 也是 `docs/RULES.md` 的纪律。想要原版材质的人，自己从本地的
 * `.minecraft` 里把 `assets/` 解出来，用 `?pack=<url>` 指过去即可。
 * 素材始终在使用者自己的盘上，一个字节都不进这个仓库。
 *
 * 覆盖是**逐张**的：包里有的就用包里的，没有的退回程序化生成。
 * 所以哪怕只解出十几张也能用，缺的部分不会变成紫黑格。
 *
 * ## 分辨率
 *
 * 一律缩到 `TILE_SIZE`（16×16）。图集是一个 TEXTURE_2D_ARRAY，
 * 整个数组只能有一个尺寸，混不了。缩放用 `imageSmoothingEnabled = false`
 * 的最近邻 —— 像素画一旦被双线性插值就糊成一团，这也是渲染那边
 * MAG_FILTER 用 NEAREST 的同一个理由。
 *
 * HD 资源包（32×/64×）因此会被压回 16×，等于白费。要真支持得让
 * `TILE_SIZE` 变成运行时值，那是另一件事，见 `docs/ART-PLAN.md`。
 */
import { TILE_SIZE, TILE_BYTES } from './texgen.ts';
import { candidatePaths, PACK_DIRS } from './pack-names.ts';

/**
 * 目录探针：随便哪个 MC 资源包都该有的文件名。
 *
 * 只用来回答"这个目录里有东西吗"，不参与实际加载。两套是因为方块与
 * 物品在不同目录下，拿方块名去探 item 目录永远是 404。
 * 每套都同时列了 1.13 前后的两种命名。
 */
const BLOCK_PROBES: readonly string[] = ['stone', 'dirt', 'cobblestone', 'sand', 'oak_planks', 'planks_oak'];
const ITEM_PROBES: readonly string[] = ['apple', 'stick', 'coal', 'diamond', 'iron_ingot'];

export interface PackResult {
  /** 贴图名 -> 16×16 RGBA。只含**成功加载**的那些 */
  readonly tiles: ReadonlyMap<string, Uint8Array>;
  /** 包里找不到、退回程序化生成的名字 */
  readonly missing: readonly string[];
  /** 加载过程中的说明，进 __mc.logs() 好让冒烟测试看得见 */
  readonly notes: readonly string[];
}

const EMPTY: PackResult = { tiles: new Map(), missing: [], notes: [] };

/** 单个请求的上限。挂死的连接靠它兜底 */
const REQUEST_TIMEOUT_MS = 4000;

/**
 * 把一张已解码的图缩到 16×16 RGBA。
 *
 * 用 OffscreenCanvas 而不是 document.createElement('canvas')：
 * 这段将来可能要挪进 worker，而且不碰 DOM 就不必等文档就绪。
 */
function toTile(bitmap: ImageBitmap): Uint8Array {
  const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx === null) throw new Error('拿不到 2d 上下文，无法解码资源包贴图');
  ctx.imageSmoothingEnabled = false;
  // 动画贴图（岩浆、水、火）在资源包里是**竖着一长条**的多帧图。
  // 整张缩进 16×16 会把所有帧挤成一团糊。只取第一帧 —— 高度是宽度整数倍
  // 就按宽度截一个正方形出来。
  const frameH = bitmap.height > bitmap.width && bitmap.height % bitmap.width === 0
    ? bitmap.width
    : bitmap.height;
  ctx.drawImage(bitmap, 0, 0, bitmap.width, frameH, 0, 0, TILE_SIZE, TILE_SIZE);
  const img = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
  const out = new Uint8Array(TILE_BYTES);
  out.set(img.data);
  return out;
}

/**
 * 试一条路径。404 与解码失败都只返回 null，不抛 —— 试错是正常流程。
 *
 * 超时用 `AbortSignal.timeout` 而不是自己掐表：`src/client/render/` 下
 * **禁止读挂钟**（lint-layers 强制，因为动画相位必须来自 clock.renderTick，
 * 否则 freeze() 停不住、截图回归失效）。声明式的超时不碰 Date.now，
 * 同样能防住一个挂死的连接。
 */
async function tryFetch(url: string): Promise<ImageBitmap | null> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    return await createImageBitmap(await res.blob());
  } catch {
    return null;
  }
}

/**
 * 加载资源包。
 *
 * @param baseUrl 包根目录的 URL，里面应该有 `assets/minecraft/textures/...`
 * @param names   要找的贴图名（就是图集的那批名字）
 * @param requestBudget 最多发多少个请求。用**次数**而不是时间来兜底，
 *                 一来渲染层禁止读挂钟，二来次数是确定的 ——
 *                 同一个包跑两次发一样多的请求，行为可复现。
 *                 单个请求另有 `REQUEST_TIMEOUT_MS` 防挂死。
 */
export async function loadResourcePack(
  baseUrl: string,
  names: readonly string[],
  requestBudget = 1200,
): Promise<PackResult> {
  if (baseUrl === '') return EMPTY;
  const root = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  let budget = requestBudget;
  const tiles = new Map<string, Uint8Array>();
  const missing: string[] = [];
  const notes: string[] = [];

  /**
   * 第一步：**先探目录**，再逐张取图。
   *
   * 候选路径是 6 个目录 × 若干候选名。要是对每一张贴图都把 6 个目录全试
   * 一遍，255 张就是上千次注定 404 的请求。
   *
   * 第一版想省这个开销，做法是"命中过的目录记下来优先试，没命中过的
   * 只在探索预算内试"。**那是错的**，而且错得很隐蔽：预算被**未命中**
   * 消耗，于是只要前十来张贴图恰好都不在包里，预算就在第一次命中之前
   * 烧光了，之后再也不去看那个目录 —— 结果是"覆盖 0 张"，
   * 而包明明是好的（实测：直接拿 4 个名字调加载器 4 张全中，
   * 走真实启动路径 255 个名字却 0 张）。
   *
   * 现在改成显式的探测阶段：拿几个**任何资源包都该有**的文件名去试每个
   * 目录，试出哪些目录是活的。上限 6 目录 × 几个探针，几十个请求封顶，
   * 而且与"要找哪些贴图"完全解耦 —— 不会再被未命中带偏。
   */
  const dirOf = (p: string): string => p.slice(0, p.lastIndexOf('/'));
  const liveDirs: string[] = [];
  for (const dir of PACK_DIRS) {
    const probes = dir.includes('item') ? ITEM_PROBES : BLOCK_PROBES;
    for (const probe of probes) {
      if (budget <= 0) break;
      budget--;
      const bmp = await tryFetch(`${root}${dir}/${probe}.png`);
      if (bmp === null) continue;
      bmp.close();
      liveDirs.push(dir);
      break;
    }
  }
  if (liveDirs.length === 0) {
    notes.push(`资源包 ${root} 里没找到任何贴图目录（试过 ${PACK_DIRS.join('、')}），全部用程序化生成`);
    return { tiles: new Map(), missing: [...names], notes };
  }
  notes.push(`命中目录：${liveDirs.join('、')}`);

  const load = async (name: string): Promise<void> => {
    // 只在活着的目录里找。找不到就是缺，不再往别处试
    for (const rel of candidatePaths(name).filter((p) => liveDirs.includes(dirOf(p)))) {
      if (budget <= 0) return;
      budget--;
      const bmp = await tryFetch(root + rel);
      if (bmp === null) continue;
      try { tiles.set(name, toTile(bmp)); } finally { bmp.close(); }
      return;
    }
    missing.push(name);
  };

  // 分批并发。一次全发出去会把浏览器的连接池打满，反而更慢
  for (let i = 0; i < names.length; i += 8) {
    if (budget <= 0) {
      notes.push(`资源包请求数用尽（${requestBudget}），剩下 ${names.length - i} 张用程序化生成`);
      break;
    }
    await Promise.all(names.slice(i, i + 8).map(load));
  }

  notes.unshift(`资源包 ${root}：覆盖 ${tiles.size} 张，程序化 ${names.length - tiles.size} 张`);
  return { tiles, missing, notes };
}
