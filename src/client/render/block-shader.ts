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

export const BLOCK_VERT_SRC = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in uvec3 aData;

uniform mat4 uViewProj;
uniform vec3 uSectionOrigin;
/** 天光的整体强度，随昼夜变化；夜间不为 0（MC 夜里天光贡献约 4/15） */
uniform float uSkyBrightness;

out vec2 vUv;
flat out uint vLayer;
out float vShade;
out vec3 vWorldPos;

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
  vLayer = (d1 >> 18) & 2047u;

  float sky   = float(d2 & 15u);
  float block = float((d2 >> 4) & 15u);
  uint  face  = (d2 >> 8) & 7u;

  // 最终光照 = max(方块光, 天光 * 昼夜系数)，再乘朝向明暗与 AO
  float light = max(block, sky * uSkyBrightness) * (1.0 / 15.0);
  // AO 0..3 映射到 0.55..1.0
  float aoFactor = 0.55 + ao * 0.15;
  vShade = clamp(light, 0.06, 1.0) * faceShade(face) * aoFactor;

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
in float vShade;
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

  vec3 color = tex.rgb * vShade;

  float dist = distance(vWorldPos, uCameraPos);
  float fog = clamp((dist - uFogStart) / max(uFogEnd - uFogStart, 0.001), 0.0, 1.0);
  color = mix(color, uFogColor, fog);

  fragColor = vec4(color, 1.0);
}
`;
