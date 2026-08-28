/** lint 脚本共用的小工具。零依赖。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 递归收集目录下匹配后缀的文件，返回相对 ROOT 的 posix 路径 */
export function walk(dir, exts = ['.ts'], out = []) {
  const abs = path.isAbsolute(dir) ? dir : path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const p = path.join(abs, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(p, exts, out);
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(path.relative(ROOT, p).split(path.sep).join('/'));
    }
  }
  return out;
}

/**
 * 把注释和字符串字面量替换成等长空白，保留行列号。
 * 这样后续用正则扫描时不会把注释里的示例代码或字符串里的单词当成真代码。
 */
export function blankOutCommentsAndStrings(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      let j = i + 2;
      while (j < n && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
    } else if (c === '/' && c2 === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      blank(i, Math.min(j + 2, n));
      i = j + 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === quote) break;
        j++;
      }
      // 字符串内容置空但保留引号，这样 import 的 from '...' 仍可被识别为存在
      blank(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

/** 提取所有 import/export ... from '...' 的模块说明符（含动态 import 与 new Worker） */
export function extractSpecifiers(src) {
  const specs = [];
  const patterns = [
    /(?:^|\n)\s*import\s+(?:[\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s+(?:[\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src)) !== null) specs.push({ spec: m[1], index: m.index });
  }
  return specs;
}

/** 由字符偏移求 1-based 行号 */
export function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

/** 统一的失败收集与报告 */
export class Failures {
  constructor(name) {
    this.name = name;
    this.items = [];
  }
  add(file, line, msg) {
    this.items.push({ file, line, msg });
  }
  report() {
    if (this.items.length === 0) {
      console.log(`  ${this.name}: ok`);
      return 0;
    }
    console.error(`  ${this.name}: ${this.items.length} 处违规`);
    for (const it of this.items) {
      console.error(`    ${it.file}:${it.line}  ${it.msg}`);
    }
    return 1;
  }
}
