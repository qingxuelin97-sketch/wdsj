/**
 * 方块渲染的着色器与顶点格式。
 *
 * 顶点是 3 个 uint32（12 字节），用 vertexAttribIPointer 上传，在顶点着色器里解包：
 *
 *   data0: x:9 | y:9<<9 | z:9<<18 | ao:2<<27
 *          位置是子区块局部坐标，1/16 格精度，范围 0..256（即 0..16 格）
 *   data1: u:9 | v:9<<9 | layer:11<<18
 *          UV 也以 1/16 格为单位，所以贪心合并出的大面可以直接靠 REPEAT 平铺；
 *          layer 是纹理数组的层号，2048 层足够 1.0 的全部贴图
 *   data2: sky:4 | block:4<<4 | face:3<<8 | tint:3<<11
 *
 * 对比前作：ga 用 4 个独立 Float32 属性共 32 字节/顶点，D:\minecraft 用 48 字节。
 * 这里 12 字节，且仍留有空位，不做过度压缩以保可读性。
 *
 * 用 TEXTURE_2D_ARRAY 而不是图集：mip 不跨层，所以既不需要 padding 也不会渗色，
 * 还能用 REPEAT 让合并后的大面正确平铺 —— 这三件事图集方案都做不到。
 */

/** 每顶点字节数 */
export const VERTEX_STRIDE = 12;

/** 打包一个顶点。位置与 UV 的单位都是 1/16 格。 */
export function packVertex(
  out: Uint32Array,
  offset: number,
  x16: number,
  y16: number,
  z16: number,
  u16: number,
  v16: number,
  layer: number,
  skyLight: number,
  blockLight: number,
  face: number,
  ao: number,
  tint: number,
): void {
  out[offset] = (x16 & 511) | ((y16 & 511) << 9) | ((z16 & 511) << 18) | ((ao & 3) << 27);
  out[offset + 1] = (u16 & 511) | ((v16 & 511) << 9) | ((layer & 2047) << 18);
  out[offset + 2] = (skyLight & 15) | ((blockLight & 15) << 4) | ((face & 7) << 8) | ((tint & 7) << 11);
}

/** 面朝向编号，与 core 的 Facing 保持一致 */
export const FACE = { DOWN: 0, UP: 1, NORTH: 2, SOUTH: 3, WEST: 4, EAST: 5 } as const;

export interface UnpackedVertex {
  /** 单位是格（已除以 16） */
  x: number;
  y: number;
  z: number;
  /** UV 单位也是格 */
  u: number;
  v: number;
  layer: number;
  skyLight: number;
  blockLight: number;
  face: number;
  ao: number;
  tint: number;
}

/**
 * 解包一个顶点。**测试专用** —— 生产代码在着色器里解包，不走这条路径。
 *
 * 有了它，UV 才能被断言。前作的 UV bug（侧面用 Y 坐标驱动 U/V，y=64 的面偏移四个图集格，
 * 贴图完全错位）之所以能一路带到线上，正是因为它的 mesher 测试从未断言过任何一个 UV 值。
 */
export function unpackVertex(data: Uint32Array, offset: number): UnpackedVertex {
  const d0 = data[offset]!;
  const d1 = data[offset + 1]!;
  const d2 = data[offset + 2]!;
  return {
    x: (d0 & 511) / 16,
    y: ((d0 >>> 9) & 511) / 16,
    z: ((d0 >>> 18) & 511) / 16,
    ao: (d0 >>> 27) & 3,
    u: (d1 & 511) / 16,
    v: ((d1 >>> 9) & 511) / 16,
    layer: (d1 >>> 18) & 2047,
    skyLight: d2 & 15,
    blockLight: (d2 >>> 4) & 15,
    face: (d2 >>> 8) & 7,
    tint: (d2 >>> 11) & 7,
  };
}

export const BLOCK_VERT_SRC = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in uvec3 aData;

uniform mat4 uViewProj;
uniform vec3 uSectionOrigin;
/**
 * 太阳整体亮度，0.2（午夜）..1.0（正午），由 core/world/day-night.ts 算出。
 *
 * 注意渲染用的是**存储的原始天光等级**，昼夜靠这个系数缩放，
 * 而不是去减 skyLightSubtracted —— 那个是**玩法**用的（决定怪能不能刷），
 * 两者在 MC 里是分开的。混用的话夜里会黑得什么都看不见。
 */
uniform float uSunBrightness;
/**
 * 群系染色表，按 TintKind 索引：NONE / GRASS / FOLIAGE / WATER。
 * 草和树叶的贴图本身画成灰度，颜色全靠这里乘上去 —— 与 MC 的做法一致，
 * 这样不同群系可以共用同一张贴图。
 */
uniform vec3 uTintColors[4];
/*
 * 贴图动画。水、岩浆、火在 MC 1.0 里是逐帧动画的。
 *
 * 图集把动画帧排在 uAnimStart 之后，每 uAnimFrames 层一组。
 * 层号落在动画区里的，把它换到本组的第 uAnimFrame 帧。
 * mesher 烘进顶点的是本组的第 0 帧，所以 (layer - uAnimStart) % uAnimFrames
 * 恒为 0，直接减掉再加当前帧就行。
 *
 * 相位来自 clock.renderTick 而不是挂钟（RULES 第 4 条）——
 * freeze() 一停 renderTick 不再前进，uAnimFrame 就钉住了，
 * 截图回归照样成立。这也是这套动画能加进来的前提：
 * 项目里每一个"会让画面自己变"的东西都必须有办法停住。
 *
 * 注意这段注释里不能出现反引号 —— 整个着色器源码是个模板字符串，
 * 一个反引号就把它截断了，报出来是一串莫名其妙的 TS1005。
 */
uniform uint uAnimStart;
uniform uint uAnimFrames;
uniform uint uAnimFrame;

out vec2 vUv;
flat out uint vLayer;
out vec3 vLight;
out vec3 vTint;
out vec3 vWorldPos;

/**
 * MC 的光照亮度曲线，和 core/world/day-night.ts 里的 lightBrightness 同式。
 * 非线性是关键：7 级只有 0.18，所以一支火把只能照亮很小一圈。
 */
float lightBrightness(float level) {
  float f = 1.0 - clamp(level, 0.0, 15.0) / 15.0;
  return (1.0 - f) / (f * 3.0 + 1.0);
}

/**
 * 各朝向的固定明暗，复刻 MC 的"方向光照"观感：
 * 顶面最亮，底面最暗，南北与东西各一档。这一步没有真实光照计算，
 * 纯粹是让立方体的六个面能被眼睛区分开。
 */
float faceShade(uint face) {
  if (face == 1u) return 1.00;   // UP
  if (face == 0u) return 0.50;   // DOWN
  if (face == 2u || face == 3u) return 0.80;  // NORTH / SOUTH
  return 0.60;                   // WEST / EAST
}

void main() {
  uint d0 = aData.x;
  uint d1 = aData.y;
  uint d2 = aData.z;

  vec3 localPos = vec3(
    float(d0 & 511u),
    float((d0 >> 9) & 511u),
    float((d0 >> 18) & 511u)
  ) * (1.0 / 16.0);

  float ao = float((d0 >> 27) & 3u);

  vUv = vec2(float(d1 & 511u), float((d1 >> 9) & 511u)) * (1.0 / 16.0);
  uint layer = (d1 >> 18) & 2047u;
  if (layer >= uAnimStart) layer = layer - ((layer - uAnimStart) % uAnimFrames) + uAnimFrame;
  vLayer = layer;

  float sky   = float(d2 & 15u);
  float block = float((d2 >> 4) & 15u);
  uint  face  = (d2 >> 8) & 7u;
  uint  tint  = (d2 >> 11) & 7u;
  vTint = uTintColors[min(tint, 3u)];

  // 两条通道各自过亮度曲线后**相加**（不是取 max），再夹到 1。
  //
  //   天光：整体乘太阳亮度；红绿再乘 (sun*0.65+0.35) 而蓝不乘，
  //         于是太阳一落山天光自动偏蓝 —— MC 的月光色就是这么来的。
  //   方块光：先放大 1.5 倍（MC 的火把闪烁基数），再按 0.6/0.4 曲线压绿压蓝，
  //         得到偏暖的橙色。
  //
  // 这个色差是"洞口冷、火把边暖"的来源。取 max 或者不分通道染色的话，
  // 两者会混成同一种灰，画面立刻塑料感。
  float sl = lightBrightness(sky) * uSunBrightness;
  float sunTint = uSunBrightness * 0.65 + 0.35;
  vec3 skyCol = vec3(sl * sunTint, sl * sunTint, sl);

  float bl = lightBrightness(block) * 1.5;
  vec3 blockCol = vec3(bl, bl * (bl * 0.6 + 0.4), bl * (bl * bl * 0.6 + 0.4));

  vec3 lightCol = min(vec3(1.0), skyCol + blockCol) * 0.96 + 0.03;

  // AO 0..3 映射到 0.55..1.0
  float aoFactor = 0.55 + ao * 0.15;
  vLight = lightCol * faceShade(face) * aoFactor;

  vec3 world = uSectionOrigin + localPos;
  vWorldPos = world;
  gl_Position = uViewProj * vec4(world, 1.0);
}
`;

export const BLOCK_FRAG_SRC = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;

in vec2 vUv;
flat in uint vLayer;
in vec3 vLight;
in vec3 vTint;
in vec3 vWorldPos;

uniform sampler2DArray uAtlas;
uniform vec3 uFogColor;
uniform vec3 uCameraPos;
uniform float uFogStart;
uniform float uFogEnd;

out vec4 fragColor;

void main() {
  vec4 tex = texture(uAtlas, vec3(vUv, float(vLayer)));
  // cutout：树叶这类贴图有透明像素，直接丢弃，避免写深度
  if (tex.a < 0.5) discard;

  vec3 color = tex.rgb * vTint * vLight;

  float dist = distance(vWorldPos, uCameraPos);
  float fog = clamp((dist - uFogStart) / max(uFogEnd - uFogStart, 0.001), 0.0, 1.0);
  color = mix(color, uFogColor, fog);

  fragColor = vec4(color, 1.0);
}
`;
