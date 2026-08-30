/**
 * 二维界面绘制。
 *
 * 一个极小的批处理器：所有界面元素（面板、槽位、物品图标、数字）都是
 * 屏幕空间的矩形，攒在一个顶点缓冲里一次画完。
 *
 * 每个矩形要么是纯色（面板、边框、高亮），要么采样纹理数组的某一层
 * （物品图标）。用同一个着色器处理两者，靠 `layer < 0` 区分 ——
 * 分成两个管线会让每帧多出十几次状态切换，而 UI 的矩形总共也就百来个。
 *
 * 坐标是**虚拟像素**：界面按固定的 320×240 设计，再整体缩放到画布上。
 * 这样界面在任何分辨率下比例一致，而且缩放系数取整时像素不会糊 ——
 * 与 MC 的 GUI scale 是一回事。
 */
import { Shader } from '../gl/shader.ts';
import { buildFont, GLYPH_H, GLYPH_W, GLYPH_ADVANCE, type Font } from './font.ts';

/** 界面的设计分辨率。所有布局坐标都在这个尺度上 */
export const UI_WIDTH = 320;
export const UI_HEIGHT = 240;

/** 每个顶点：x, y, u, v, layer, r, g, b, a */
const FLOATS_PER_VERTEX = 9;
/**
 * 一批最多几个矩形。
 *
 * 4096 是被 F3 逼出来的：一屏调试文字有二十行，每行四十来个字符，
 * 每个字符十来个亮点段 —— 七八百到一千出头。原来的上限正好是 1024，
 * 于是 F3 被**悄悄截断**，画面上表现为右下角那几行没了。
 *
 * 内存代价：4096 × 6 顶点 × 9 float × 4 字节 ≈ 884 KB，一次性分配。
 */
const MAX_QUADS = 4096;

const VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aUv;
layout(location = 2) in float aLayer;
layout(location = 3) in vec4 aColor;

out vec2 vUv;
flat out float vLayer;
out vec4 vColor;

void main() {
  vUv = aUv;
  vLayer = aLayer;
  vColor = aColor;
  // 顶点进来时已经是裁剪空间坐标了。
  // 早先是传一个 uScreen 再在这里换算，结果整个界面一个像素都不出 ——
  // uniform 没取到就是 (0,0)，除出来全是 NaN，而 NaN 顶点既不报错也不画。
  // 换算挪到 CPU 上之后少了一个能静默失败的环节。
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 vUv;
flat in float vLayer;
in vec4 vColor;
uniform sampler2DArray uAtlas;
out vec4 fragColor;
void main() {
  if (vLayer < 0.0) {
    fragColor = vColor;
  } else {
    vec4 tex = texture(uAtlas, vec3(vUv, vLayer));
    if (tex.a < 0.02) discard;
    fragColor = vec4(tex.rgb * vColor.rgb, tex.a * vColor.a);
  }
}`;

export class UiRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly shader: Shader;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffer: WebGLBuffer;
  private readonly data = new Float32Array(MAX_QUADS * 6 * FLOATS_PER_VERTEX);
  private cursor = 0;
  private quads = 0;
  /** 因为超过 MAX_QUADS 而被丢掉的矩形数。非 0 就说明画面缺了东西 */
  dropped = 0;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.shader = new Shader(gl, VERT, FRAG, 'ui');
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    const stride = FLOATS_PER_VERTEX * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 16);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 20);
    gl.bindVertexArray(null);
  }

  /** 上一次 flush 画了多少矩形，排查用 */
  lastQuads = 0;

  /** 一帧开头复位。lastQuads 在这里归零，所以它统计的是**整帧**的量 */
  begin(): void {
    this.dropped = 0;
    this.lastQuads = 0;
    this.cursor = 0;
    this.quads = 0;
  }

  /** 一个纯色矩形 */
  rect(x: number, y: number, w: number, h: number, r: number, g: number, b: number, a = 1): void {
    this.push(x, y, w, h, 0, 0, 1, 1, -1, r, g, b, a);
  }

  /** 一个采样纹理数组某层的矩形 */
  sprite(x: number, y: number, w: number, h: number, layer: number, tint = 1, alpha = 1): void {
    this.push(x, y, w, h, 0, 0, 1, 1, layer, tint, tint, tint, alpha);
  }

  private push(
    x: number, y: number, w: number, h: number,
    u0: number, v0: number, u1: number, v1: number,
    layer: number, r: number, g: number, b: number, a: number,
  ): void {
    if (this.quads >= MAX_QUADS) {
      // 悄悄丢弃是最难查的那种 bug：画面少一块，没有任何报错。
      // 记下来，F3 会显示它，冒烟检查也会断言它是 0
      this.dropped++;
      return;
    }
    const d = this.data;
    let o = this.cursor;
    // 虚拟像素 -> 裁剪空间。y 轴翻转，让 (0,0) 在左上角，和布局代码的直觉一致
    const vert = (px: number, py: number, pu: number, pv: number): void => {
      d[o] = px / UI_WIDTH * 2 - 1;
      d[o + 1] = 1 - py / UI_HEIGHT * 2;
      d[o + 2] = pu; d[o + 3] = pv;
      d[o + 4] = layer;
      d[o + 5] = r; d[o + 6] = g; d[o + 7] = b; d[o + 8] = a;
      o += FLOATS_PER_VERTEX;
    };
    vert(x, y, u0, v0);
    vert(x + w, y, u1, v0);
    vert(x + w, y + h, u1, v1);
    vert(x, y, u0, v0);
    vert(x + w, y + h, u1, v1);
    vert(x, y + h, u0, v1);
    this.cursor = o;
    this.quads++;
  }

  /**
   * 画一个 0..999 的数字，右对齐到 (x, y)。
   *
   * 字形是 3×5 的点阵，直接用纯色矩形拼 —— 为了几个数字去烘一张字体图集
   * 不划算，而且点阵字在任何缩放下都是清晰的。
   */
  number(value: number, x: number, y: number, scale = 1, r = 1, g = 1, b = 1): void {
    const text = String(Math.max(0, Math.min(999, Math.floor(value))));
    let cx = x - text.length * 4 * scale;
    for (const ch of text) {
      const bits = DIGITS[ch.charCodeAt(0) - 48];
      if (bits !== undefined) {
        for (let row = 0; row < 5; row++) {
          for (let col = 0; col < 3; col++) {
            if ((bits[row]! >> (2 - col) & 1) === 0) continue;
            // 先画一层黑描边，数字压在花花绿绿的图标上才看得清
            this.rect(cx + col * scale + scale, y + row * scale + scale, scale, scale, 0, 0, 0, 0.8);
          }
        }
        for (let row = 0; row < 5; row++) {
          for (let col = 0; col < 3; col++) {
            if ((bits[row]! >> (2 - col) & 1) === 0) continue;
            this.rect(cx + col * scale, y + row * scale, scale, scale, r, g, b, 1);
          }
        }
      }
      cx += 4 * scale;
    }
  }

  /**
   * 画一段文字。
   *
   * 每个亮起的像素是一个矩形。一行 40 个字符大约 120 个矩形，
   * 而缓冲上限是 1024 —— 所以 F3 那样十几行的叠层要**单独 flush**，
   * 不能和物品栏挤在同一批里。
   *
   * @param shadow 画黑色描边。文字压在花花绿绿的世界上时没它读不出来
   */
  text(
    str: string, x: number, y: number, scale = 1,
    r = 1, g = 1, b = 1, shadow = true,
  ): void {
    const font = buildFont();
    if (shadow) this.textPass(font, str, x + scale, y + scale, scale, 0, 0, 0, 0.75);
    this.textPass(font, str, x, y, scale, r, g, b, 1);
  }

  private textPass(
    font: Font, str: string, x: number, y: number, scale: number,
    r: number, g: number, b: number, a: number,
  ): void {
    let cx = x;
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code >= font.first && code <= font.last) {
        const base = (code - font.first) * GLYPH_H;
        for (let row = 0; row < GLYPH_H; row++) {
          const v = font.bits[base + row]!;
          if (v === 0) continue;
          // 同一行里连续的亮点合成一个矩形。"HHHH" 这种笔画密的字
          // 能把矩形数砍掉三成，而缓冲只有 1024 个
          let col = 0;
          while (col < GLYPH_W) {
            if ((v >> (GLYPH_W - 1 - col) & 1) === 0) { col++; continue; }
            let end = col;
            while (end < GLYPH_W && (v >> (GLYPH_W - 1 - end) & 1) === 1) end++;
            this.rect(cx + col * scale, y + row * scale, (end - col) * scale, scale, r, g, b, a);
            col = end;
          }
        }
      }
      cx += GLYPH_ADVANCE * scale;
    }
    void x;
  }

  /** 把攒下的矩形一次画完 */
  /**
   * 把攒下的矩形一次画完，然后**清空这一批**。
   *
   * 清空这件事原来没做，于是同一帧里第二次 flush 会把第一批连同第二批
   * 一起再画一遍 —— 半透明的面板叠两层就变深了，而且矩形数会一路涨到
   * 上限被截断。F3 是第一个需要分两批画的东西，这个 bug 也就是那时才露头。
   *
   * "flush 之后这一批就没了"是批处理器该有的语义，begin() 于是变成
   * 一帧开头的可选复位。
   */
  flush(texture: WebGLTexture): void {
    this.lastQuads += this.quads;
    if (this.quads === 0) return;
    const gl = this.gl;
    this.shader.use();
    this.shader.setInt('uAtlas', 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);

    gl.disable(gl.DEPTH_TEST);
    // 二维层必须关背面剔除。
    //
    // 界面坐标的 y 轴是朝下的，换算到裁剪空间时要翻一次 y ——
    // 这一翻把顶点绕序也翻了，于是每一个界面矩形都成了"背面"，
    // 在世界渲染留下的 CULL_FACE 状态下被整个剔掉。
    // 表现是界面一个像素都不出，且不报任何错：drawArrays 照常返回，
    // 顶点数、着色器、纹理全都对，就是什么都没画上去。
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.cursor);
    gl.drawArrays(gl.TRIANGLES, 0, this.quads * 6);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);

    this.cursor = 0;
    this.quads = 0;
  }
}

/** 3×5 点阵数字，每行 3 位 */
const DIGITS: readonly (readonly number[])[] = [
  [0b111, 0b101, 0b101, 0b101, 0b111], // 0
  [0b010, 0b110, 0b010, 0b010, 0b111], // 1
  [0b111, 0b001, 0b111, 0b100, 0b111], // 2
  [0b111, 0b001, 0b111, 0b001, 0b111], // 3
  [0b101, 0b101, 0b111, 0b001, 0b001], // 4
  [0b111, 0b100, 0b111, 0b001, 0b111], // 5
  [0b111, 0b100, 0b111, 0b101, 0b111], // 6
  [0b111, 0b001, 0b010, 0b010, 0b010], // 7
  [0b111, 0b101, 0b111, 0b101, 0b111], // 8
  [0b111, 0b101, 0b111, 0b001, 0b111], // 9
];
