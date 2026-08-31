/**
 * 贴图集与 GPU 纹理的建立。
 *
 * 从 client-main 里分出来的（那个文件第三次顶到 600 行硬上限）。
 * 这一段是纯粹的"内容表 -> GPU 资源"转换，和主循环、网络、输入都无关，
 * 分出来之后三者各自都短了一截。
 */
import { buildAtlas, buildFaceLayerTable, type TileAtlas } from './block-textures.ts';
import { DESTROY_STAGE_NAMES } from './tile-recipes.ts';
import { TILE_SIZE } from './texgen.ts';
import type { MesherTables } from '../mesh/mesher.ts';
import type { BlockTables } from '../../core/registry/block-tables.ts';
import type { GlCaps } from '../gl/context.ts';
import type { BlockRegistry } from '../../core/registry/block-registry.ts';
import type { ItemRegistry } from '../../content/items.ts';
import { loadResourcePack } from './resource-pack.ts';
import { SKY_TILE_NAMES } from './tile-recipes-sky.ts';
import { PARTICLE_TEXTURE_NAMES } from '../../content/particles.ts';

export interface RenderResources {
  atlas: TileAtlas;
  faceLayer: Uint16Array;
  mesherTables: MesherTables;
  texture: WebGLTexture;
}

export function buildRenderResources(
  gl: WebGL2RenderingContext,
  tables: BlockTables,
  caps: GlCaps,
  anisoExt: { TEXTURE_MAX_ANISOTROPY_EXT: number } | null,
  extraTextures: readonly string[],
  /** 资源包覆盖层，见 resource-pack.ts。不传就全部程序化生成 */
  packTiles?: ReadonlyMap<string, Uint8Array>,
): RenderResources {
  // 方块贴图 + 挖掘裂纹 + 物品图标全部烘进同一个纹理数组：
  // 世界渲染与 UI 共用一次纹理绑定，也省掉一套并行的资源管理
  const atlas = buildAtlas([...tables.collectTextureNames(), ...DESTROY_STAGE_NAMES, ...extraTextures], packTiles);
  const faceLayer = buildFaceLayerTable(tables, atlas);

  const mesherTables: MesherTables = {
    modelKind: tables.modelKind,
    renderLayer: tables.renderLayer,
    tint: tables.tint,
    tintFaces: tables.tintFaces,
    fullCube: tables.fullCube,
    cullSameType: tables.cullSameType,
    opaque: tables.opaque,
    faceLayer,
    models: tables.models,
  };

  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
  const mipLevels = Math.floor(Math.log2(TILE_SIZE)) + 1;
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, mipLevels, gl.RGBA8, TILE_SIZE, TILE_SIZE, atlas.layers);
  gl.texSubImage3D(
    gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, TILE_SIZE, TILE_SIZE, atlas.layers,
    gl.RGBA, gl.UNSIGNED_BYTE, atlas.data,
  );
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  // NEAREST 放大：像素风的方块贴图一旦线性插值就糊成一团
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
  if (anisoExt !== null) {
    gl.texParameterf(gl.TEXTURE_2D_ARRAY, anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(4, caps.maxAnisotropy));
  }

  return { atlas, faceLayer, mesherTables, texture };
}

/**
 * 把"决定要烘哪些贴图 + 可选地加载资源包 + 建 GPU 资源"这一串收在一起。
 *
 * 从 `client-main.ts` 分出来的（那个文件第六次顶到 600 行硬上限）。
 * 这三步是**必须按顺序发生**的一条链：名字清单决定图集，资源包覆盖图集，
 * 图集决定 GPU 纹理。散在入口文件里的话，中间插进别的初始化就会出错，
 * 而那种错表现为"某些贴图没被覆盖"，极难看出来。
 */
export async function bootRenderResources(o: {
  gl: WebGL2RenderingContext;
  registry: BlockRegistry;
  items: ItemRegistry;
  caps: GlCaps;
  anisoExt: { TEXTURE_MAX_ANISOTROPY_EXT: number } | null;
  /** `?pack=` 的值，空串表示不用资源包 */
  packUrl: string;
  log(msg: string): void;
}): Promise<RenderResources & { extraTextures: readonly string[] }> {
  const tables = o.registry.getTables();
  // 经验球的图标既不属于方块也不属于物品，要显式塞进图集
  const extraTextures = [
    ...o.items.all().map((d: { texture: string }) => d.texture), 'xp_orb', ...SKY_TILE_NAMES, ...PARTICLE_TEXTURE_NAMES,
  ];

  // 资源包覆盖层。`?pack=<url>` 指向一个解开的 MC 资源包（见 docs/ART-PLAN.md）；
  // 不给就全部程序化生成。**仓库自身不含任何外部素材**，这只是留给使用者
  // 指向本地素材的口子 —— 素材一个字节都不进 git。
  const pack = o.packUrl === ''
    ? null
    : await loadResourcePack(o.packUrl, [...tables.collectTextureNames(), ...extraTextures]);
  if (pack !== null) for (const n of pack.notes) o.log(n);

  const res = buildRenderResources(o.gl, tables, o.caps, o.anisoExt, extraTextures, pack?.tiles);
  return { ...res, extraTextures };
}
