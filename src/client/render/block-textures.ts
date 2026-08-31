/**
 * 贴图图集：把贴图名解析成 TEXTURE_2D_ARRAY 的层号，并烘焙出 mesher 用的扁平查表。
 *
 * core 的 BlockTables 只存贴图**名字**（core 不该知道渲染细节）；这里把名字映射成层号，
 * 并烘焙成 `id*6 + face -> layer` 的 Uint16Array，供 mesher 的热循环直接下标访问。
 */
import type { BlockTables } from '../../core/registry/block-tables.ts';
import { TilePainter, TILE_SIZE, TILE_BYTES } from './texgen.ts';
import { RECIPES } from './tile-recipes.ts';
import { ITEM_RECIPES } from './item-recipes.ts';

/**
 * 会动的贴图，以及它们每帧滚动多少像素。
 *
 * MC 1.0 的水、岩浆、火都是逐帧动画的；本项目在此之前**全部是静态的** ——
 * 一片死水看上去最不像原版。
 *
 * 做法是"滚动"而不是逐帧手画：这几张贴图本来就无缝平铺，
 * 整体平移一像素仍然无缝，滚满一圈正好回到起点，所以动画天然是循环的。
 * 流动的水/岩浆沿流向滚（向下），火向上滚正好读作火苗上窜。
 *
 * 静止的水与岩浆用**斜向**小步长：纯横向平移在一大片湖面上会读成
 * "整个湖在滑动"，斜向 1px 更像水面自己在晃。
 *
 * 速度差靠**每帧滚多远**表达，不靠帧数 —— 所有动画贴图必须同帧数，
 * 这样着色器里一个 `uAnimFrame` 就够，不必为每张图各带一个计数器。
 */
const ANIMATED: Readonly<Record<string, readonly [number, number]>> = {
  water: [1, 1],
  water_flow: [0, 1],
  lava: [1, 1],
  lava_flow: [0, 1],
  fire: [0, 2],
  // 传送门竖着流。横向不动（[0, ...]）—— 门的纹理是被"吸上去"的，
  // 带横向分量会看成水流而不是能量场
  nether_portal: [0, 1],
  // 末地门的星空**很慢**地飘。给快了会像屏保
  end_portal: [0, 1],
};

/** 每张动画贴图有几帧。滚 16 帧正好走完一圈，回到第 0 帧 */
export const ANIM_FRAMES = 16;

/** 把一张 16×16 RGBA 整体平移 (dx,dy)，越界的从对边绕回来 */
function rollTile(src: Uint8Array, dx: number, dy: number): Uint8Array {
  const out = new Uint8Array(TILE_BYTES);
  for (let y = 0; y < TILE_SIZE; y++) {
    for (let x = 0; x < TILE_SIZE; x++) {
      const sx = ((x - dx) % TILE_SIZE + TILE_SIZE) % TILE_SIZE;
      const sy = ((y - dy) % TILE_SIZE + TILE_SIZE) % TILE_SIZE;
      const d = (y * TILE_SIZE + x) * 4;
      const o = (sy * TILE_SIZE + sx) * 4;
      out[d] = src[o]!;
      out[d + 1] = src[o + 1]!;
      out[d + 2] = src[o + 2]!;
      out[d + 3] = src[o + 3]!;
    }
  }
  return out;
}

export interface TileAtlas {
  /** 所有层拼接成的连续 RGBA 数据，可直接喂 texSubImage3D */
  readonly data: Uint8Array;
  readonly layers: number;
  readonly tileSize: number;
  /** 贴图名 -> 层号。动画贴图给的是**第 0 帧**的层号 */
  readonly index: ReadonlyMap<string, number>;
  /**
   * 动画帧区的起点层号。这个层号**之后**的所有层都是动画帧，
   * 每 `ANIM_FRAMES` 层为一组。着色器靠这一个数就能判断要不要换帧。
   */
  readonly animStart: number;
  /** 有几组动画贴图 */
  readonly animGroups: number;
}

/**
 * 生成指定贴图。
 * 顺序由传入的名字数组决定，所以调用方（BlockTables.collectTextureNames）必须给出
 * 稳定排序，否则层号会随注册顺序变动，截图黄金值就白记了。
 */
/**
 * 每张贴图允许几种颜色。
 *
 * 默认 6 —— 与 MC 1.0 手绘贴图的实际用色量同一量级。给得多了等于没量化
 * （量化前实测 27–59 种），给得少了会把有意义的特征并掉。
 *
 * 这里列的都是**有理由多要几个色号**的：
 *   - 多种明确色相并存的（书架四色书脊、南瓜脸的深色五官）
 *   - 本身就是渐变的（日月、火、经验球）—— 压到 6 色会出现明显色带
 *   - 灰度贴图（草、树叶、羊毛）后面还要被 tint 乘，色阶少了会出现色块
 */
function paletteSize(name: string): number {
  if (name.startsWith('moon_phase_') || name === 'sun' || name === 'clouds') return 10;
  if (name === 'fire' || name === 'xp_orb' || name === 'lava' || name === 'lava_flow') return 9;
  if (name === 'bookshelf' || name === 'gallery') return 12;
  if (name.startsWith('pumpkin') || name.startsWith('jack_o')) return 8;
  // 灰度且会被 tint 相乘的：色阶太少会在草地上出现明显色块
  if (name === 'grass_top' || name === 'leaves' || name === 'wool' || name === 'water' || name === 'water_flow') return 8;
  return 6;
}

export function buildAtlas(
  names: readonly string[],
  /**
   * 资源包覆盖层：这里给了的名字直接用给的像素，不跑配方。
   * 见 `resource-pack.ts` —— 仓库自身不含任何外部素材，
   * 这只是给使用者指向本地素材留的口子。
   */
  overrides?: ReadonlyMap<string, Uint8Array>,
): TileAtlas {
  // 动画贴图占一整组连续的层，统一排在**静态层之后**。
  //
  // 排在后面而不是原地展开，是为了让静态贴图的层号仍旧等于它在 names
  // 里的下标 —— mesher 烘的 faceLayer 表、UI 取图标、粒子取层号全都
  // 直接用 `index.get(name)`，原地展开会把后面所有静态贴图的层号推移，
  // 而着色器又得能只凭层号判断"这是不是动画帧"。
  const animNames = names.filter((n) => ANIMATED[n] !== undefined);
  const animStart = names.length;
  const totalLayers = names.length + animNames.length * ANIM_FRAMES;
  const data = new Uint8Array(TILE_BYTES * totalLayers);
  const index = new Map<string, number>();
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!;
    index.set(name, i);
    const override = overrides?.get(name);
    if (override !== undefined && override.length === TILE_BYTES) {
      // 外部贴图同样要做边缘渗色：资源包里的 cutout 图（树叶、玻璃）
      // 透明处往往是纯黑，直接用会在缩小时渗出黑边，和自己画的一个毛病
      const painter = new TilePainter(name);
      painter.data.set(override);
      painter.bleedEdges();
      data.set(painter.data, i * TILE_BYTES);
      continue;
    }
    // 方块贴图与物品图标共用一个纹理数组：UI 里画物品和世界里画方块
    // 用的是同一个 sampler，省掉一次纹理切换，也省掉一套并行的资源管理
    const blockRecipe = RECIPES[name];
    const recipe = blockRecipe ?? ITEM_RECIPES[name];
    if (recipe === undefined) {
      throw new Error(`贴图 '${name}' 没有配方 —— 在 src/client/render/tile-recipes.ts 里补上`);
    }
    const painter = new TilePainter(name);
    recipe(painter);
    // 调色板量化。**所有**贴图都过一遍 —— 这是像素画与程序化噪声之间
    // 最大的一道坎，见 `TilePainter.quantize` 的注释。
    // 放在配方之后、轮廓之前：轮廓是固定的一个深色，不该参与聚类。
    painter.quantize(paletteSize(name));
    if (blockRecipe === undefined) {
      // 物品图标统一加轮廓与体积感。
      //
      // 放在这里而不是每个配方里，是因为它对**所有**图标都成立，
      // 而 item-recipes.ts 是按原型生成的（一个 `ingot()` 派生出十几件物品）——
      // 写进原型会漏掉那些手写的特例，写进每个配方则要改一百多处。
      //
      // 为什么必须有：图标会画在任何背景上（物品栏浅灰、快捷栏半透明黑、
      // 掉在草地上时的绿）。没轮廓的图标碰上明度相近的底就整个糊进去。
      painter.formShade();
      painter.outline();
    }
    // 所有贴图统一做一遍边缘渗色。不含透明像素的贴图会在第一轮就退出，代价可忽略；
    // 含 cutout 的贴图靠它避免 mipmap 把透明处的颜色混进边缘。
    painter.bleedEdges();
    data.set(painter.data, i * TILE_BYTES);
  }

  // 生成动画帧。第 0 帧就是静态层本身，之后逐帧滚动。
  //
  // 注意 `index` 仍然指向**静态层**：着色器换帧时是从动画区里挑，
  // 而不是让 index 指过去。这样静态层永远是一份可用的兜底 ——
  // UI、物品实体、粒子那几条不做换帧的路径拿到的就是第 0 帧。
  for (let g = 0; g < animNames.length; g++) {
    const name = animNames[g]!;
    const [dx, dy] = ANIMATED[name]!;
    const staticLayer = index.get(name)!;
    // slice 而不是 subarray —— 后面要往同一个 data 里写，
    // 用视图的话第 0 帧写进去之后，源就被自己覆盖了
    const base = data.slice(staticLayer * TILE_BYTES, (staticLayer + 1) * TILE_BYTES);
    const groupBase = animStart + g * ANIM_FRAMES;
    for (let f = 0; f < ANIM_FRAMES; f++) {
      data.set(f === 0 ? base : rollTile(base, dx * f, dy * f), (groupBase + f) * TILE_BYTES);
    }
    // **把名字重新指向动画区**。mesher 烘 faceLayer 表时查的就是这里，
    // 而着色器只能靠 `layer >= animStart` 认出"这一面要换帧" ——
    // 名字若还指着静态层，着色器永远不知道它是动画的。
    // 静态层那一份就此没人引用了，留着不删：它是这一组的生成源，
    // 而且 5 张 × 1 KB 的浪费不值得为它多写一段特判。
    index.set(name, groupBase);
  }

  return {
    data,
    layers: totalLayers,
    tileSize: TILE_SIZE,
    index,
    animStart,
    animGroups: animNames.length,
  };
}

/**
 * 烘焙 `blockId*6 + face -> 纹理层号` 的扁平表。
 * 这是 mesher 每个面都要查一次的东西，必须是 typed array 而不是 Map。
 */
export function buildFaceLayerTable(tables: BlockTables, atlas: TileAtlas): Uint16Array {
  const out = new Uint16Array(tables.count * 6);
  for (let id = 0; id < tables.count; id++) {
    const names = tables.textureNames[id]!;
    for (let face = 0; face < 6; face++) {
      const name = names[face] ?? '';
      if (name === '') continue;
      const layer = atlas.index.get(name);
      if (layer === undefined) {
        throw new Error(`方块 id ${id} 的第 ${face} 面引用了图集里没有的贴图 '${name}'`);
      }
      out[id * 6 + face] = layer;
    }
  }
  return out;
}

/**
 * 生物群系染色表，按 TintKind 索引。
 *
 * M1 先用固定颜色；M4 接入群系后会按 (温度, 湿度) 查色表，
 * 但贴图本身已经画成灰度，届时不需要改贴图。
 */
export const TINT_COLORS: readonly (readonly [number, number, number])[] = [
  [1, 1, 1], // NONE
  [0.49, 0.72, 0.34], // GRASS
  [0.37, 0.67, 0.27], // FOLIAGE
  [0.25, 0.46, 0.9], // WATER
];

/** 摊平成 shader 用的 vec3 数组 */
export function tintColorArray(): Float32Array {
  const out = new Float32Array(TINT_COLORS.length * 3);
  for (let i = 0; i < TINT_COLORS.length; i++) {
    const c = TINT_COLORS[i]!;
    out[i * 3] = c[0];
    out[i * 3 + 1] = c[1];
    out[i * 3 + 2] = c[2];
  }
  return out;
}
