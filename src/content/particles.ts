/**
 * 粒子种类表。纯数据。
 *
 * 和方块、物品、生物一样走注册表：粒子之间的差别几乎全是**数值**
 * （多重、多快、活多久、什么贴图），不是行为。写成十几个类的话，
 * 每个类里有意义的代码只有一行构造函数。
 *
 * MC 1.0 的粒子类型比这里多，但很多是别的系统的（药水的 spell、
 * 村民的 angry、传送门的 portal）—— 那些跟着各自的系统在后面的里程碑里加。
 * 这里先做**已经存在的东西会产生的**那些。
 *
 * 关于 gravity：正数往下掉，负数往上飘。烟和气泡是负的 ——
 * 这是它们和碎屑的全部区别，不需要为"会上升的粒子"单开一套代码。
 */

export interface ParticleDef {
  readonly name: string;
  /** 贴图名。会被烘进同一个纹理数组 */
  readonly texture: string;
  /**
   * 每刻的竖直加速度，格/刻²。
   * 正 = 下落（碎屑、岩浆滴），负 = 上升（烟、火焰、气泡）
   */
  readonly gravity: number;
  /** 每刻速度乘的阻尼。越小停得越快 */
  readonly drag: number;
  /** 初速度的量级 */
  readonly speed: number;
  /** 方片边长（格） */
  readonly size: number;
  /** 尺寸的随机浮动比例 */
  readonly sizeVar: number;
  /** 寿命（刻） */
  readonly life: number;
  readonly lifeVar: number;
  /** 颜色乘子。贴图多是灰度的，颜色靠这个给 */
  readonly tint: readonly [number, number, number];
  /** 临终前多少刻开始淡出。0 = 不淡出，寿终时直接消失 */
  readonly fadeTicks: number;
}

function def(name: string, texture: string, o: Partial<ParticleDef> = {}): ParticleDef {
  return {
    name,
    texture,
    gravity: 0.04,
    drag: 0.9,
    speed: 0.05,
    size: 0.12,
    sizeVar: 0.4,
    life: 20,
    lifeVar: 0.5,
    tint: [1, 1, 1],
    fadeTicks: 0,
    ...o,
  };
}

export const PARTICLES: readonly ParticleDef[] = [
  // 烟。火把、熔炉、火上面那一缕，是全游戏出现最多的粒子。
  // gravity 取负数让它往上飘，drag 高让它飘得慢而稳
  def('smoke', 'particle_smoke', {
    gravity: -0.006, drag: 0.96, speed: 0.012,
    size: 0.09, life: 42, lifeVar: 0.4, tint: [0.42, 0.42, 0.42], fadeTicks: 12,
  }),
  // 大烟：熔炉在烧、着火的地方。更大更慢更黑
  def('large_smoke', 'particle_smoke', {
    gravity: -0.004, drag: 0.97, speed: 0.01,
    size: 0.17, life: 60, lifeVar: 0.4, tint: [0.3, 0.3, 0.3], fadeTicks: 18,
  }),
  // 火焰：几乎不动，只是原地跳一下就没了。它的作用是给火把一个"活着"的感觉
  def('flame', 'particle_flame', {
    gravity: -0.002, drag: 0.94, speed: 0.008,
    size: 0.11, life: 16, lifeVar: 0.4, tint: [1, 1, 1], fadeTicks: 5,
  }),
  // 岩浆冒泡：往上弹一下再落回去，所以 gravity 是正的、初速大
  def('lava', 'particle_flame', {
    gravity: 0.06, drag: 0.99, speed: 0.22,
    size: 0.16, life: 26, lifeVar: 0.3, tint: [1, 0.55, 0.15],
  }),
  // 落水的水花
  def('splash', 'particle_splash', {
    gravity: 0.055, drag: 0.94, speed: 0.16,
    size: 0.08, life: 14, lifeVar: 0.5, tint: [0.65, 0.78, 1],
  }),
  // 水下气泡：快速上浮
  def('bubble', 'particle_bubble', {
    gravity: -0.03, drag: 0.92, speed: 0.03,
    size: 0.07, life: 24, lifeVar: 0.4, tint: [1, 1, 1],
  }),
  // 暴击星星。往外飞散、稍微下落
  def('crit', 'particle_crit', {
    gravity: 0.03, drag: 0.9, speed: 0.22,
    size: 0.1, life: 12, lifeVar: 0.4, tint: [1, 0.95, 0.6],
  }),
  // 爆炸的烟球
  def('explode', 'particle_smoke', {
    gravity: -0.008, drag: 0.9, speed: 0.18,
    size: 0.5, sizeVar: 0.5, life: 22, lifeVar: 0.4, tint: [0.92, 0.9, 0.88], fadeTicks: 10,
  }),
  // 红石粉的红点
  def('redstone', 'particle_dust', {
    gravity: 0, drag: 0.88, speed: 0.005,
    size: 0.07, life: 14, lifeVar: 0.4, tint: [0.95, 0.1, 0.05],
  }),
  // 音符盒的音符
  def('note', 'particle_note', {
    gravity: -0.008, drag: 0.94, speed: 0.02,
    size: 0.18, life: 24, lifeVar: 0.2, tint: [1, 1, 1], fadeTicks: 8,
  }),
] as const;

/** 粒子名 -> 下标。发射器用名字，热路径用下标 */
const BY_NAME = new Map<string, number>();
PARTICLES.forEach((p, i) => BY_NAME.set(p.name, i));

export function particleIndex(name: string): number {
  const i = BY_NAME.get(name);
  if (i === undefined) throw new Error(`未知的粒子 '${name}'`);
  return i;
}

export function particleDef(name: string): ParticleDef {
  return PARTICLES[particleIndex(name)]!;
}

/** 全部粒子贴图名，供入口烘进图集 */
export const PARTICLE_TEXTURE_NAMES: readonly string[] =
  [...new Set(PARTICLES.map((p) => p.texture))];
