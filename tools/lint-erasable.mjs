/**
 * 可擦除语法检查。
 *
 * Node 的原生 TS 支持只做"类型剥离"，不做转译，所以 enum / namespace / 构造函数参数属性 /
 * 装饰器 / <T>expr 这类需要生成运行时代码的语法一律不可用。tsconfig 的 erasableSyntaxOnly
 * 已经会拦一道，这里再跑一遍真正的 stripTypeScriptTypes 作为第二道保险 —— 因为最终在
 * 浏览器和 node --test 里跑的就是它，它说不行才是真不行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { ROOT, walk, Failures } from './lint-util.mjs';

const origEmitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
  if (type === 'ExperimentalWarning' && String(warning).includes('stripTypeScriptTypes')) return;
  return origEmitWarning.call(process, warning, ...rest);
};

const fail = new Failures('lint-erasable');
const files = [...walk('src', ['.ts']), ...walk('tests', ['.ts'])];

for (const file of files) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  try {
    const out = stripTypeScriptTypes(src, { mode: 'strip' });
    // 剥离必须保留行数，否则 DevTools 的栈会错位 —— 这是我们不带 sourcemap 的前提
    const srcLines = src.split('\n').length;
    const outLines = out.split('\n').length;
    if (srcLines !== outLines) {
      fail.add(file, 1, `类型剥离改变了行数（${srcLines} -> ${outLines}），栈帧会错位`);
    }
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    // Node 的报错里通常带 "at <line>:<col>"，尽量抠出行号
    const m = /(\d+):(\d+)/.exec(msg);
    fail.add(file, m ? Number(m[1]) : 1, `不可擦除语法：${msg.split('\n')[0]}`);
  }
}

process.exit(fail.report());
