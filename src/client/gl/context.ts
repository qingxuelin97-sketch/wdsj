/**
 * WebGL2 上下文创建与能力检测。
 *
 * 项目全程只用 WebGL2 核心特性，不引入任何渲染库 —— 体素渲染要塞极度压缩的自定义顶点
 * 格式（3×uint32 / 顶点，着色器内解包），任何场景图抽象在这里都只会被绕过。
 */

export interface GlCaps {
  readonly maxTextureSize: number;
  readonly maxArrayTextureLayers: number;
  readonly maxVertexAttribs: number;
  readonly maxTextureUnits: number;
  /** 各向异性过滤的最大倍数；不支持时为 1 */
  readonly maxAnisotropy: number;
  readonly rendererName: string;
  readonly vendorName: string;
}

export interface GlContext {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement;
  readonly caps: GlCaps;
  /** 各向异性过滤扩展，可能为 null */
  readonly anisoExt: EXT_texture_filter_anisotropic | null;
}

export class GlError extends Error {}

/**
 * 创建上下文。
 *
 * preserveDrawingBuffer 恒为 false（开了会显著掉帧）；截图靠在同一个 rAF 回调里
 * 先 render 再 toDataURL 来保证内容还在。
 */
export function createContext(canvas: HTMLCanvasElement): GlContext {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    depth: true,
    stencil: false,
    antialias: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
    desynchronized: false,
  });

  if (gl === null) {
    throw new GlError('WebGL2 不可用。本项目要求 WebGL2（需要 3D 纹理数组与整数顶点属性）。');
  }

  const anisoExt =
    gl.getExtension('EXT_texture_filter_anisotropic') ??
    (gl.getExtension('MOZ_EXT_texture_filter_anisotropic') as EXT_texture_filter_anisotropic | null) ??
    (gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic') as EXT_texture_filter_anisotropic | null);

  const dbgInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const rendererName =
    dbgInfo !== null
      ? String(gl.getParameter(dbgInfo.UNMASKED_RENDERER_WEBGL) ?? '')
      : String(gl.getParameter(gl.RENDERER) ?? '');
  const vendorName =
    dbgInfo !== null
      ? String(gl.getParameter(dbgInfo.UNMASKED_VENDOR_WEBGL) ?? '')
      : String(gl.getParameter(gl.VENDOR) ?? '');

  const caps: GlCaps = {
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    maxArrayTextureLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number,
    maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS) as number,
    maxTextureUnits: gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) as number,
    maxAnisotropy:
      anisoExt !== null ? (gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number) : 1,
    rendererName,
    vendorName,
  };

  // 方块图集用 TEXTURE_2D_ARRAY，1.0 大约需要 300-400 层；256 是 WebGL2 保证的下限。
  if (caps.maxArrayTextureLayers < 256) {
    throw new GlError(`纹理数组层数上限过低（${caps.maxArrayTextureLayers}），至少需要 256。`);
  }

  return { gl, canvas, caps, anisoExt };
}

/**
 * 把 canvas 的绘制缓冲尺寸同步到 CSS 尺寸。
 * 返回是否发生了变化，调用方据此决定要不要重设 viewport 与投影矩阵。
 *
 * 注意 dpr 参数：截图回归需要跨机器逐字节可比，所以 __mc.setCanvasSize 会绕过
 * devicePixelRatio 直接写 canvas.width/height，那条路径不走这个函数。
 */
export function resizeToDisplay(canvas: HTMLCanvasElement, dpr: number): boolean {
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width === w && canvas.height === h) return false;
  canvas.width = w;
  canvas.height = h;
  return true;
}
