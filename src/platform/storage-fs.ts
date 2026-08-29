/**
 * node 文件系统后端。只被 node 入口引用，浏览器打包路径碰不到它。
 *
 * 键里的 `/` 直接当目录用，写之前 mkdir -p。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SaveStorage } from './storage.ts';

export class FsStorage implements SaveStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private pathOf(key: string): string {
    return path.join(this.root, ...key.split('/'));
  }

  async read(key: string): Promise<Uint8Array | null> {
    try {
      const buf = await fs.readFile(this.pathOf(key));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch {
      // 文件不存在是**正常**的（第一次进这个世界），不是错误
      return null;
    }
  }

  async write(key: string, data: Uint8Array): Promise<void> {
    const file = this.pathOf(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) await walk(path.join(dir, e.name), childRel);
        else if (childRel.startsWith(prefix)) out.push(childRel);
      }
    };
    await walk(this.root, '');
    return out.sort();
  }

  async remove(key: string): Promise<void> {
    try {
      await fs.unlink(this.pathOf(key));
    } catch {
      // 已经不在了就算删成功
    }
  }
}
