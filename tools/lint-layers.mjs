/**
 * 分层与全局约束检查。这是防屎山的主力执行机构。
 *
 * 拦四类问题：
 *   1. 跨层 import —— core 不许 import 任何人；server 与 client 永不互相 import
 *   2. 平台全局泄漏 —— DOM 全局不许出现在 core/content/server；node: 不许出现在 core/content/client
 *   3. 相对 import 缺 .ts 后缀 —— 缺了浏览器就解析不到
 *   4. 渲染路径读挂钟 —— 读了 performance.now/Date.now，freeze() 就停不住，截图回归失效
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, walk, blankOutCommentsAndStrings, extractSpecifiers, lineOf, Failures } from './lint-util.mjs';

/** 每一层允许 import 的层。key 是层名，值是允许的目标层集合。 */
const ALLOWED = {
  core: new Set(['core']),
  content: new Set(['core', 'content']),
  server: new Set(['core', 'content', 'platform', 'server']),
  client: new Set(['core', 'content', 'platform', 'client']),
  platform: new Set(['core', 'platform']),
  entry: new Set(['core', 'content', 'server', 'client', 'platform', 'entry']),
};

/** 禁止出现某些全局标识符的层 */
const DOM_FORBIDDEN_LAYERS = new Set(['core', 'content', 'server']);
const DOM_GLOBALS = ['document', 'window', 'WebGL2RenderingContext', 'HTMLCanvasElement', 'OffscreenCanvas', 'localStorage'];

/** 禁止 import node: 的层（这些代码要能在浏览器里跑） */
const NODE_FORBIDDEN_LAYERS = new Set(['core', 'content', 'client']);

/**
 * 禁止使用 Node 全局的层。
 * @types/node 是全局注入的，tsc 不会拦 client 层里的 process/Buffer，只能在这里拦。
 */
const NODE_GLOBALS = ['process', 'Buffer', '__dirname', '__filename', 'require', 'global'];

/** 禁止读挂钟的目录前缀 —— 动画相位必须来自 clock.renderTick */
const NO_WALLCLOCK_DIRS = ['src/client/render/', 'src/client/mesh/', 'src/server/'];

/**
 * 客户端不得自己改世界。
 *
 * 世界的真相在服务端，客户端只有镜像，且只能被 S_ChunkData / S_ChunkUnload /
 * S_BlockUpdate 驱动（docs/RULES.md 第 8 条）。一旦客户端有别的写入路径，
 * 两边就会漂移，而表现出来是"玩家莫名其妙被拉回去"或者"方块闪一下又变回来" ——
 * 极难定位，因为出问题的地方和写入的地方隔着好几帧。
 *
 * 唯一豁免的是 client-world.ts：那三个 onXxx 处理函数就是包驱动的入口。
 */
const WORLD_MUTATORS = ['setState', 'addChunk', 'removeChunk', 'createChunk', 'setSkyLight', 'setBlockLight'];
const WORLD_MUTATOR_EXEMPT = new Set(['src/client/world/client-world.ts']);

function layerOf(file) {
  const m = /^src\/([^/]+)\//.exec(file);
  return m ? m[1] : null;
}

/** 把相对说明符解析成相对 ROOT 的路径，用于判断目标层 */
function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const abs = path.resolve(path.dirname(path.join(ROOT, fromFile)), spec);
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

const fail = new Failures('lint-layers');
const files = walk('src', ['.ts']);

for (const file of files) {
  const layer = layerOf(file);
  if (!layer) continue;
  const raw = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const src = blankOutCommentsAndStrings(raw);

  // --- 1 & 3: import 检查 ---
  for (const { spec, index } of extractSpecifiers(raw)) {
    const line = lineOf(raw, index);

    if (spec.startsWith('.')) {
      // 相对 import 必须带 .ts
      if (!spec.endsWith('.ts')) {
        fail.add(file, line, `相对 import 必须以 .ts 结尾：'${spec}'`);
        continue;
      }
      const target = resolveSpec(file, spec);
      if (target === null) continue;
      if (!fs.existsSync(path.join(ROOT, target))) {
        fail.add(file, line, `import 指向不存在的文件：'${spec}'`);
        continue;
      }
      const targetLayer = layerOf(target);
      if (targetLayer && !ALLOWED[layer]?.has(targetLayer)) {
        fail.add(file, line, `分层违规：${layer} 不得 import ${targetLayer}（'${spec}'）`);
      }
    } else if (spec.startsWith('node:')) {
      // --- 2: node: 泄漏 ---
      if (NODE_FORBIDDEN_LAYERS.has(layer)) {
        fail.add(file, line, `${layer} 层不得 import '${spec}'（这些代码要能在浏览器里跑）`);
      }
    } else {
      fail.add(file, line, `禁止裸模块说明符 '${spec}'：本项目零依赖，只允许相对 import 与 node:`);
    }
  }

  // --- 2: DOM 全局泄漏 ---
  if (DOM_FORBIDDEN_LAYERS.has(layer)) {
    for (const g of DOM_GLOBALS) {
      const re = new RegExp(`(?<![.\\w$])${g}\\b`, 'g');
      let m;
      while ((m = re.exec(src)) !== null) {
        fail.add(file, lineOf(src, m.index), `${layer} 层不得使用 DOM 全局 '${g}'`);
      }
    }
  }

  // --- 2b: Node 全局泄漏 ---
  if (NODE_FORBIDDEN_LAYERS.has(layer)) {
    for (const g of NODE_GLOBALS) {
      const re = new RegExp(`(?<![.\\w$])${g}\\b`, 'g');
      let m;
      while ((m = re.exec(src)) !== null) {
        fail.add(file, lineOf(src, m.index), `${layer} 层不得使用 Node 全局 '${g}'（这些代码要能在浏览器里跑）`);
      }
    }
  }

  // --- 5: 客户端不得有世界写入路径 ---
  if (layer === 'client' && !WORLD_MUTATOR_EXEMPT.has(file)) {
    for (const name of WORLD_MUTATORS) {
      const re = new RegExp(String.raw`\.${name}\s*\(`, 'g');
      let m;
      while ((m = re.exec(src)) !== null) {
        fail.add(
          file,
          lineOf(src, m.index),
          `client 层不得调用 ${name}()：世界只能由服务端的包驱动改变，` +
          `入口只有 client-world.ts 的 onChunkData / onChunkUnload / onBlockUpdate`,
        );
      }
    }
  }

  // --- 4: 渲染/模拟路径禁读挂钟 ---
  if (NO_WALLCLOCK_DIRS.some((d) => file.startsWith(d))) {
    for (const g of ['performance\\.now', 'Date\\.now']) {
      const re = new RegExp(`\\b${g}\\s*\\(`, 'g');
      let m;
      while ((m = re.exec(src)) !== null) {
        fail.add(
          file,
          lineOf(src, m.index),
          `禁止读挂钟（${g.replace('\\', '')}）：动画相位必须来自 clock.renderTick，否则 freeze() 停不住、截图回归失效`,
        );
      }
    }
  }
}

process.exit(fail.report());
