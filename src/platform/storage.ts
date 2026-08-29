/**
 * 存档后端接口。
 *
 * 三个实现：浏览器 OPFS、node 文件系统、内存（测试）。三者的差异**只在这一层**，
 * 上面的存档逻辑（region 文件、NBT 编码、脏区块追踪）一份代码通吃。
 *
 * 接口是**异步**的，因为 OPFS 只有异步 API。这是整条存档路径唯一被迫异步的地方 ——
 * NBT 与 RLE 都刻意保持同步，于是"世界 -> 字节"这一段可以在测试里逐字节比对，
 * 只有最后的"字节 -> 磁盘"才需要 await。
 *
 * 键是扁平的字符串（`region/r.0.0`、`level.dat`、`player/1.dat`），
 * 不做目录树：OPFS 的目录 API 又啰嗦又慢，而我们总共也就几十个键。
 */
export interface SaveStorage {
  read(key: string): Promise<Uint8Array | null>;
  write(key: string, data: Uint8Array): Promise<void>;
  /** 列出所有以某个前缀开头的键 */
  list(prefix: string): Promise<string[]>;
  remove(key: string): Promise<void>;
}

/** 内存后端。测试用，也是"没有可用后端"时的兜底 */
export class MemoryStorage implements SaveStorage {
  private readonly files = new Map<string, Uint8Array>();

  read(key: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.files.get(key) ?? null);
  }

  write(key: string, data: Uint8Array): Promise<void> {
    // 存副本：调用方通常复用缓冲区，直接存引用会在下一次写入时被改掉
    this.files.set(key, data.slice());
    return Promise.resolve();
  }

  list(prefix: string): Promise<string[]> {
    return Promise.resolve([...this.files.keys()].filter((k) => k.startsWith(prefix)).sort());
  }

  remove(key: string): Promise<void> {
    this.files.delete(key);
    return Promise.resolve();
  }

  /** 测试用：总共占了多少字节 */
  get totalBytes(): number {
    let n = 0;
    for (const v of this.files.values()) n += v.length;
    return n;
  }

  get fileCount(): number {
    return this.files.size;
  }
}
