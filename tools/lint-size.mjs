/**
 * 文件规模检查。
 *
 * 软上限 400 行（警告），硬上限 600 行（失败）。例外清单从 docs/RULES.md 里读，
 * 这样"哪些文件允许超长"是一个需要写文档才能改的决定，而不是随手加一行 ignore。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, walk, Failures } from './lint-util.mjs';

const SOFT = 400;
const HARD = 600;

/** 从 docs/RULES.md 里解析例外清单：形如 `- 例外: src/foo/bar.ts (900) 理由...` */
function loadExceptions() {
  const rulesPath = path.join(ROOT, 'docs', 'RULES.md');
  const map = new Map();
  if (!fs.existsSync(rulesPath)) return map;
  const text = fs.readFileSync(rulesPath, 'utf8');
  const re = /^\s*[-*]\s*例外[:：]\s*`?([^\s`]+)`?\s*\((\d+)\)/gm;
  let m;
  while ((m = re.exec(text)) !== null) map.set(m[1], Number(m[2]));
  return map;
}

const exceptions = loadExceptions();
const fail = new Failures('lint-size');
const warnings = [];
const files = [...walk('src', ['.ts']), ...walk('tools', ['.mjs'])];

for (const file of files) {
  const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').length;
  const allowed = exceptions.get(file);
  const hard = allowed ?? HARD;
  if (lines > hard) {
    fail.add(
      file,
      lines,
      allowed
        ? `${lines} 行，超过 docs/RULES.md 为它声明的例外上限 ${allowed}`
        : `${lines} 行，超过硬上限 ${HARD}（若确有必要，去 docs/RULES.md 声明例外并写理由）`,
    );
  } else if (lines > SOFT && allowed === undefined) {
    warnings.push(`    ${file}: ${lines} 行（软上限 ${SOFT}，考虑拆分）`);
  }
}

if (warnings.length > 0) {
  console.log(`  lint-size: ${warnings.length} 个软上限提醒`);
  for (const w of warnings) console.log(w);
}

process.exit(fail.report());
