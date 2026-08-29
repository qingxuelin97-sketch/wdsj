/**
 * 传输抽象。
 *
 * 这是单人与多人之间**唯一**的差异点：
 *   单人 = ServerCore 跑在 Web Worker 里，走 MessagePortTransport
 *   多人 = 同一份 ServerCore 跑在 Node 里，走 WebSocketTransport
 * 除了换一个 Transport 实现，其余代码一行不改。
 *
 * 测试里用 LoopbackTransport 把两端接在同一个线程上，于是 node --test 可以直接
 * 构造 ServerCore 挂一个客户端跑几万 tick 做断言，完全不需要浏览器。
 */
import { ByteWriter, ByteReader } from './codec.ts';
import { encodePacket, decodePacket, type PacketDef, type PacketRegistry, type Payload, type Schema } from './schema.ts';

export interface Transport {
  send(data: Uint8Array): void;
  onMessage(cb: (data: Uint8Array) => void): void;
  onClose(cb: () => void): void;
  close(): void;
  readonly closed: boolean;
}

/**
 * 同线程的一对传输，互为对端。
 *
 * 默认**异步投递**（microtask），这样它的时序特征和真正的 worker/socket 一致 ——
 * 若做成同步调用，测试里能跑通的代码换到真传输上可能因为重入而挂掉。
 */
export class LoopbackTransport implements Transport {
  private peer: LoopbackTransport | null = null;
  private messageCb: ((data: Uint8Array) => void) | null = null;
  private closeCb: (() => void) | null = null;
  private _closed = false;
  /** 设为 true 时同步投递，仅用于需要精确控制时序的测试 */
  synchronous = false;

  static createPair(): [LoopbackTransport, LoopbackTransport] {
    const a = new LoopbackTransport();
    const b = new LoopbackTransport();
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  get closed(): boolean {
    return this._closed;
  }

  send(data: Uint8Array): void {
    if (this._closed) return;
    const peer = this.peer;
    if (peer === null || peer._closed) return;
    // 复制一份：真传输会序列化，调用方复用缓冲是合法的
    const copy = new Uint8Array(data);
    if (this.synchronous) {
      peer.messageCb?.(copy);
    } else {
      queueMicrotask(() => {
        if (!peer._closed) peer.messageCb?.(copy);
      });
    }
  }

  onMessage(cb: (data: Uint8Array) => void): void {
    this.messageCb = cb;
  }

  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.closeCb?.();
    const peer = this.peer;
    if (peer !== null && !peer._closed) peer.close();
  }
}

/** MessagePort 上的传输，用于主线程 <-> 服务端 worker */
export class MessagePortTransport implements Transport {
  private readonly port: MessagePort;
  private closeCb: (() => void) | null = null;
  private _closed = false;

  constructor(port: MessagePort) {
    this.port = port;
    port.start?.();
  }

  get closed(): boolean {
    return this._closed;
  }

  send(data: Uint8Array): void {
    if (this._closed) return;
    // 转移所有权，避免结构化克隆再复制一遍
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    this.port.postMessage(buf, [buf]);
  }

  onMessage(cb: (data: Uint8Array) => void): void {
    this.port.onmessage = (ev: MessageEvent): void => {
      const d = ev.data as ArrayBuffer | { __close?: true };
      if (d instanceof ArrayBuffer) cb(new Uint8Array(d));
      else if ((d as { __close?: true }).__close === true) this.close();
    };
  }

  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    try {
      this.port.postMessage({ __close: true });
      this.port.close();
    } catch {
      // 对端已经没了
    }
    this.closeCb?.();
  }
}

/**
 * 包通道：在 Transport 之上做批量收发。
 *
 * 一个 tick 内产生的所有包攒在一起，flush 时作为**一条**消息发出，
 * 内部用 u32 长度前缀分帧。前作用 u16，一个调色板熵高的区块包就能超过 65535 字节，
 * 长度字段静默截断，整条流从此错位。
 */
export class PacketChannel {
  private readonly transport: Transport;
  private readonly incoming: PacketRegistry;
  private readonly out = new ByteWriter(8192);
  private handler: ((name: string, value: Record<string, unknown>) => void) | null = null;
  private errorHandler: ((err: Error) => void) | null = null;

  /** 统计，供 __mc 与性能面板使用 */
  bytesSent = 0;
  bytesReceived = 0;
  packetsSent = 0;
  packetsReceived = 0;

  constructor(transport: Transport, incoming: PacketRegistry) {
    this.transport = transport;
    this.incoming = incoming;
    transport.onMessage((data) => this.handleMessage(data));
  }

  get closed(): boolean {
    return this.transport.closed;
  }

  onPacket(cb: (name: string, value: Record<string, unknown>) => void): void {
    this.handler = cb;
  }

  onError(cb: (err: Error) => void): void {
    this.errorHandler = cb;
  }

  /** 追加一个包到出缓冲。真正发送发生在 flush() */
  send<S extends Schema>(def: PacketDef<S>, value: Payload<S>): void {
    if (this.transport.closed) return;
    const bytes = encodePacket(def, value);
    this.out.u32(bytes.length);
    this.out.bytes(bytes);
    this.packetsSent++;
  }

  /** 把攒下的包一次性发出。每 tick 调用一次 */
  flush(): void {
    if (this.out.length === 0) return;
    const payload = this.out.view_();
    this.bytesSent += payload.length;
    this.transport.send(payload);
    this.out.reset();
  }

  private handleMessage(data: Uint8Array): void {
    this.bytesReceived += data.length;
    const r = new ByteReader(data);
    try {
      while (!r.atEnd) {
        const len = r.u32();
        const frame = r.bytes(len);
        const { def, value } = decodePacket(this.incoming, frame);
        this.packetsReceived++;
        this.handler?.(def.name, value);
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (this.errorHandler !== null) this.errorHandler(e);
      else throw e;
    }
  }

  close(): void {
    this.transport.close();
  }
}
