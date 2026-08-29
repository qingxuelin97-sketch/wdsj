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
): RenderResources {
  // 方块贴图 + 挖掘裂纹 + 物品图标全部烘进同一个纹理数组：
  // 世界渲染与 UI 共用一次纹理绑定，也省掉一套并行的资源管理
  const atlas = buildAtlas([...tables.collectTextureNames(), ...DESTROY_STAGE_NAMES, ...extraTextures]);
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
