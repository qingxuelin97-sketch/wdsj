/**
 * 材质底：石、木、金属、砖。
 *
 * 这些"底"被几十张贴图共用（熔炉/发射器/半砖/坩埚都是石头底，
 * 箱子/唱片机/音符盒/床都是木头底）。分出来有两个好处：
 *
 *   1. 同一族的贴图**质感一致** —— 各写各的话，一面墙上熔炉和石头
 *      会是两种灰，看着像两种材料
 *   2. 调一次全族跟着变，不用逐张改
 *
 * 手法与 `tile-recipes-terrain.ts` 一致：可平铺格点噪声打底、
 * 成团斑块加特征、边缘收一道。为什么不是白噪声见那个文件的头注释。
 */
import { rgb, type TilePainter, type Rgb } from './texgen.ts';

/** 石头底。矿石、熔炉、发射器、半砖、坩埚、中继器都用它 */
export function stoneBase(p: TilePainter, tone: Rgb = rgb(0x7e7e7e)): void {
  // 振幅 26 而不是 15。
  //
  // 15/255 只有 6% 的明暗范围 —— 放大看是有层次的，可一铺满整个地下
  // 就是一面死灰的水泥墙，玩家分不出哪里是墙哪里是地。MC 的石头
  // 明暗跨度接近 20%，这也是它在火把光下仍然读得出结构的原因。
  p.valueNoise(tone, 26, 4, 4, 3);
  // 深色斑：数量翻倍、更小更暗。少而大的斑点会在平铺时变成显眼的重复标记，
  // 多而小的才读得出"石头本来就花"
  p.blobs({ r: tone.r - 30, g: tone.g - 30, b: tone.b - 30 }, 9, 1.4, 10);
  // 再补几点高光。只有暗斑没有亮斑的话，整张图会往下压成一块脏灰
  p.blobs({ r: tone.r + 20, g: tone.g + 20, b: tone.b + 20 }, 5, 1.1, 8);
}

/**
 * 木头底。箱子、唱片机、音符盒、活塞筒身都用它。
 *
 * `vertical` 决定木纹方向：侧面板通常是横纹，立柱是竖纹。
 * 方向错了看着像把木头拧了 90 度。
 */
export function woodBase(p: TilePainter, tone: Rgb, vertical = false): void {
  p.grain(tone, 16, vertical);
}

/**
 * 金属底。铁门、铁栏杆、铁块类用它。
 *
 * 金属与石头的区别在**噪声幅度**：金属要平（amp 小、格点细），
 * 石头要糙。幅度给大了铁门看着像水泥门。
 */
export function metalBase(p: TilePainter, tone: Rgb): void {
  p.valueNoise(tone, 7, 6, 6, 2);
}

/**
 * 错缝砖格。砖块类（圆石以外）用这个。
 *
 * 砖面本身带格点噪声（不是纯色 + 一个随机偏移），且每块砖**顶边提亮、
 * 底边压暗** —— 砖有了厚度才不像贴在墙上的色块。
 */
export function brickGrid(
  p: TilePainter, base: Rgb, mortar: Rgb, cellW: number, cellH: number, jitter: number,
): void {
  p.valueNoise(mortar, 9, 8, 8, 1);
  const rows = Math.ceil(16 / cellH);
  for (let row = 0; row < rows; row++) {
    const offset = (row % 2) * Math.floor(cellW / 2);
    for (let col = -1; col < Math.ceil(16 / cellW) + 1; col++) {
      const x0 = col * cellW + offset;
      const d = (p.rand() - 0.5) * jitter;
      const r = base.r + d;
      const g = base.g + d;
      const b = base.b + d;
      // 用 setWrapped 而不是 rect：rect 走 set()，越界直接丢弃，
      // 于是错缝行左右两端的半块砖被切掉，贴图接不上
      for (let y = 0; y < cellH - 1; y++) {
        for (let x = 0; x < cellW - 1; x++) {
          const n = (p.rand() - 0.5) * 8;
          const top = y === 0 ? 9 : 0;
          const bottom = y === cellH - 2 ? -11 : 0;
          p.setWrapped(x0 + x, row * cellH + y, r + n + top + bottom, g + n + top + bottom, b + n + top + bottom, 255);
        }
      }
    }
  }
}

/**
 * 一片**分得开的石子**，铺满整块。圆石、沙砾、苔石用它。
 *
 * ## 为什么不能用 `blobs`
 *
 * `blobs` 是往整块上随机撒，位置不受约束，于是团与团大量重叠、
 * 大小也没有节制 —— 铺出来是"一片有明暗的灰"，看不出是由石子组成的。
 * MC 的圆石是**六到八块能一个个数出来**的石头，中间夹着深色缝，
 * 那个"数得出来"才是它的辨识度。
 *
 * 做法是抖动网格：把 16×16 切成 cells×cells 个格，每格里放**一块**石子，
 * 中心在格内抖一点、半径略小于半格，于是石子之间天然留出缝，
 * 又不会排得像瓷砖。全部走 `setWrapped`，所以照样无缝。
 *
 * @param cells  切几格。3 -> 约 5px 的石子（圆石），4 -> 约 4px（沙砾）
 * @param spread 石子之间的明度差。给大了像一堆碎石，给小了又糊回一片
 */
export function stoneCluster(
  p: TilePainter, cells: number, base: Rgb, mortar: Rgb, spread: number,
): void {
  p.valueNoise(mortar, 8, 6, 6, 2);
  const step = 16 / cells;
  for (let gy = 0; gy < cells; gy++) {
    // 奇数行整体错半格。规则的方格阵列即使加了抖动也还是能被眼睛读成
    // 网格 —— 错行是砖墙的做法，成本一行，效果立竿见影
    const rowShift = (gy % 2) * step * 0.5;
    for (let gx = 0; gx < cells; gx++) {
      // 中心抖动 ±35%（原来是 ±25%）。再大就会和邻格挤在一起，
      // 再小则网格感压不住
      const cx = (gx + 0.5) * step + rowShift + (p.rand() - 0.5) * step * 0.7;
      const cy = (gy + 0.5) * step + (p.rand() - 0.5) * step * 0.7;
      // 半径范围拉开（原来是 0.42..0.58，几乎一样大）。
      // 大小一致的石子看着像人造铺装，不像天然碎石
      const r = step * (0.34 + p.rand() * 0.34);
      const d = (p.rand() - 0.5) * spread;
      const rr = Math.ceil(r) + 1;
      for (let dy = -rr; dy <= rr; dy++) {
        for (let dx = -rr; dx <= rr; dx++) {
          // 半径上加噪声，正圆一眼看得出是程序画的
          if (Math.hypot(dx, dy) > r + (p.rand() - 0.5) * 0.8) continue;
          const px = Math.round(cx) + dx;
          const py = Math.round(cy) + dy;
          // 每块石子自己也有明暗：左上亮、右下暗，石子才是鼓起来的。
          //
          // **只在边缘那一圈上明暗，内部保持平。** 早先这里写的是
          // `(dx + dy) < -r*0.5 ? 10 : ... ? -12 : 0` —— `dx+dy` 沿 45°
          // 是常数，等于给**每一颗**石子都拉了一条同方向的 45° 硬边，
          // 叠在规则网格上就成了整片斜纹，一眼看出是算法画的。
          // 实测：那是"圆石看着假"的唯一最大来源。
          const dist = Math.hypot(dx, dy);
          const rim = dist / Math.max(0.001, r);   // 0 = 正中，1 = 边缘
          // 受光方向仍是左上，但强度随"离边缘多近"衰减，
          // 而且不做硬阈值 —— 硬阈值就是上面那条 45° 边的本质
          const facing = dist < 0.001 ? 0 : -(dx + dy) / (dist * 1.4142);
          const lift = Math.round(rim * rim * facing * 16);
          p.setWrapped(px, py, base.r + d + lift, base.g + d + lift, base.b + d + lift, 255);
        }
      }
    }
  }
}

/**
 * 竖向树皮：深浅相间的沟与棱。原木侧面用它。
 *
 * 单纯的竖向 `grain` 是连续渐变的条纹，读起来像布不像树皮。
 * 树皮的特征是**几道明确的深沟** —— 宽度不一、位置不均，
 * 沟旁边紧跟一条亮棱（那是沟的受光侧）。
 */
export function barkRidges(p: TilePainter, base: Rgb, furrows: number): void {
  p.grain(base, 14, true);
  let x = Math.floor(p.rand() * 16);
  for (let i = 0; i < furrows; i++) {
    // 间距不均：等距的沟看着像栅栏
    x = (x + 2 + Math.floor(p.rand() * 4)) % 16;
    const w = p.rand() < 0.4 ? 2 : 1;
    for (let y = 0; y < 16; y++) {
      // 沟本身沿 y 有轻微起伏，笔直的沟同样看得出是程序画的
      const wob = p.rand() < 0.18 ? (p.rand() < 0.5 ? -1 : 1) : 0;
      for (let k = 0; k < w; k++) {
        p.setWrapped(x + k + wob, y, base.r - 30, base.g - 26, base.b - 20, 255);
      }
      p.setWrapped(x + w + wob, y, base.r + 16, base.g + 14, base.b + 10, 255);
    }
  }
}

/**
 * 在一块已画好的贴图上压一圈内嵌边框，做出"这是一台机器/一个箱子"的感觉。
 *
 * 左上提亮、右下压暗，与界面斜面同一套语言（见 inventory-screen.ts）。
 */
export function inset(p: TilePainter, margin: number, light = 16, dark = 18): void {
  const a = margin;
  const b = 15 - margin;
  for (let i = a; i <= b; i++) {
    p.shade(i, a, light);
    p.shade(a, i, light);
    p.shade(i, b, -dark);
    p.shade(b, i, -dark);
  }
}
