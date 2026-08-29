/**
 * 浏览器 OPFS（Origin Private File System）后端。
 *
 * 选它而不是 IndexedDB：OPFS 存的就是文件，读写整块二进制不需要序列化，
 * 而 region 文件本来就是"一大块二进制"。IndexedDB 要为此包一层 Blob，
 * 每次读写多一次结构化克隆。
 *
 * 键里的 `/` 当目录用。OPFS 的目录句柄要一级级取，所以这里缓存了句柄 ——
 * 存一次世界要写几十个 region 文件，每次都重新走一遍目录树很浪费。
 */
import type { SaveStorage } from './storage.ts';

export class OpfsStorage implements SaveStorage {
  private readonly rootName: string;
  private rootHandle: FileSystemDirectoryHandle | null = null;
  private readonly dirCache = new Map<string, FileSystemDirectoryHandle>();

  constructor(rootName: string) {
    this.rootName = rootName;
  }

  /** OPFS 可用吗。私密模式、老浏览器、非安全上下文都可能没有 */
  static available(): boolean {
    return typeof navigator !== 'undefined'
      && typeof navigator.storage?.getDirectory === 'function';
  }

  private async root(): Promise<FileSystemDirectoryHandle> {
    if (this.rootHandle === null) {
      const base = await navigator.storage.getDirectory();
      this.rootHandle = await base.getDirectoryHandle(this.rootName, { create: true });
    }
    return this.rootHandle;
  }

  /** 取到某个键所在的目录句柄 */
  private async dirFor(key: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
    const parts = key.split('/');
    parts.pop();
    let dir = await this.root();
    let sofar = '';
    for (const part of parts) {
      sofar = sofar === '' ? part : `${sofar}/${part}`;
      const cached = this.dirCache.get(sofar);
      if (cached !== undefined) {
        dir = cached;
        continue;
      }
      try {
        dir = await dir.getDirectoryHandle(part, { create });
      } catch {
        return null;
      }
      this.dirCache.set(sofar, dir);
    }
    return dir;
  }

  private static leaf(key: string): string {
    const parts = key.split('/');
    return parts[parts.length - 1]!;
  }

  async read(key: string): Promise<Uint8Array | null> {
    const dir = await this.dirFor(key, false);
    if (dir === null) return null;
    try {
      const handle = await dir.getFileHandle(OpfsStorage.leaf(key));
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      return null;
    }
  }

  async write(key: string, data: Uint8Array): Promise<void> {
    const dir = await this.dirFor(key, true);
    if (dir === null) throw new Error(`OPFS: 建不出 ${key} 的目录`);
    const handle = await dir.getFileHandle(OpfsStorage.leaf(key), { create: true });
    const w = await handle.createWritable();
    // 转成 BufferSource 再传：TS 5.9 把类型化数组的缓冲区参数化了，
    // 而 Uint8Array<ArrayBufferLike> 不满足 write() 要求的 ArrayBufferView<ArrayBuffer>
    // （因为前者可能是 SharedArrayBuffer 支撑的）。运行时完全等价
    await w.write(data as unknown as BufferSource);
    await w.close();
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: FileSystemDirectoryHandle, rel: string): Promise<void> => {
      // @ts-expect-error entries() 在 lib.dom 里还没有，但所有支持 OPFS 的浏览器都有
      for await (const [name, handle] of dir.entries()) {
        const childRel = rel === '' ? name : `${rel}/${name}`;
        if (handle.kind === 'directory') await walk(handle as FileSystemDirectoryHandle, childRel);
        else if (childRel.startsWith(prefix)) out.push(childRel);
      }
    };
    await walk(await this.root(), '');
    return out.sort();
  }

  async remove(key: string): Promise<void> {
    const dir = await this.dirFor(key, false);
    if (dir === null) return;
    try {
      await dir.removeEntry(OpfsStorage.leaf(key));
    } catch {
      // 已经不在了
    }
  }
}
