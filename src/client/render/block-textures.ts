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

export interface TileAtlas {
  /** 所有层拼接成的连续 RGBA 数据，可直接喂 texSubImage3D */
  readonly data: Uint8Array;
  readonly layers: number;
  readonly tileSize: number;
  /** 贴图名 -> 层号 */
  readonly index: ReadonlyMap<string, number>;
}

/**
 * 生成指定贴图。
 * 顺序由传入的名字数组决定，所以调用方（BlockTables.collectTextureNames）必须给出
 * 稳定排序，否则层号会随注册顺序变动，截图黄金值就白记了。
 */
export function buildAtlas(
  names: readonly string[],
  /**
   * 资源包覆盖层：这里给了的名字直接用给的像素，不跑配方。
   * 见 `resource-pack.ts` —— 仓库自身不含任何外部素材，
   * 这只是给使用者指向本地素材留的口子。
   */
  overrides?: ReadonlyMap<string, Uint8Array>,
): TileAtlas {
  const data = new Uint8Array(TILE_BYTES * names.length);
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
    const recipe = RECIPES[name] ?? ITEM_RECIPES[name];
    if (recipe === undefined) {
      throw new Error(`贴图 '${name}' 没有配方 —— 在 src/client/render/tile-recipes.ts 里补上`);
    }
    const painter = new TilePainter(name);
    recipe(painter);
    // 所有贴图统一做一遍边缘渗色。不含透明像素的贴图会在第一轮就退出，代价可忽略；
    // 含 cutout 的贴图靠它避免 mipmap 把透明处的颜色混进边缘。
    painter.bleedEdges();
    data.set(painter.data, i * TILE_BYTES);
  }
  return { data, layers: names.length, tileSize: TILE_SIZE, index };
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
