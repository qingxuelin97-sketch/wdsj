/**
 * 网格化 worker 的入口。
 *
 * 它是**无状态**的：除了启动时收到的一份只读方块表，不持有任何世界数据。
 * 每个任务自带一份 18³ 的邻域快照，算完把顶点数据和输入缓冲一起转移回主线程。
 *
 * 无状态换来的是：不需要在 worker 里同步世界、不需要处理区块加载/卸载、
 * 不会出现"worker 里的世界和主线程不一致"这类极难复现的 bug。
 * 代价只是主线程每个任务多做一次约 20 微秒的复制。
 */
import { meshSection, type MesherTables, type MeshJob } from '../client/mesh/mesher.ts';
import type { WorkerInitMessage, WorkerJobMessage, WorkerResultMessage } from '../client/mesh/mesh-worker-pool.ts';

let tables: MesherTables | null = null;

self.onmessage = (ev: MessageEvent): void => {
  const msg = ev.data as WorkerInitMessage | WorkerJobMessage;

  if (msg.kind === 'init') {
    tables = {
      modelKind: new Uint8Array(msg.tables.modelKind),
      renderLayer: new Uint8Array(msg.tables.renderLayer),
      tint: new Uint8Array(msg.tables.tint),
      tintFaces: new Uint8Array(msg.tables.tintFaces),
      fullCube: new Uint8Array(msg.tables.fullCube),
      cullSameType: new Uint8Array(msg.tables.cullSameType),
      opaque: new Uint8Array(msg.tables.opaque),
      faceLayer: new Uint16Array(msg.tables.faceLayer),
      // 模型表是结构化克隆过来的，已经是 typed array，直接用
      models: msg.models,
    };
    return;
  }

  if (tables === null) {
    // 主线程保证 init 先于 job 发出；真走到这里说明消息顺序被破坏了，
    // 静默丢弃只会让画面缺一块且无从查起，所以直接抛。
    throw new Error('mesh worker 收到任务时方块表尚未初始化');
  }

  const job: MeshJob = {
    cx: msg.cx, cy: msg.cy, cz: msg.cz, rev: msg.rev,
    blocks: new Uint16Array(msg.blocks),
    light: new Uint8Array(msg.light),
    biomes: new Uint8Array(msg.biomes),
  };
  const result = meshSection(job, tables);

  // 顶点数据必须复制成独立缓冲：mesher 返回的是内部大缓冲的 subarray，
  // 直接转移会把整块缓冲连同其它层一起送走。
  const layers = result.layers.map((l) => ({
    layer: l.layer as number,
    vertices: l.vertices.slice().buffer as ArrayBuffer,
    indices: l.indices.slice().buffer as ArrayBuffer,
    quadCount: l.quadCount,
  }));

  const reply: WorkerResultMessage = {
    kind: 'result',
    cx: result.cx, cy: result.cy, cz: result.cz, rev: result.rev,
    layers,
    // 输入缓冲原样还回去，主线程放回空闲池复用 —— 稳态下分配趋近 0
    recycled: {
      blocks: job.blocks.buffer as ArrayBuffer,
      light: job.light.buffer as ArrayBuffer,
      biomes: job.biomes.buffer as ArrayBuffer,
    },
  };

  const transfer: ArrayBuffer[] = [reply.recycled.blocks, reply.recycled.light, reply.recycled.biomes];
  for (const l of layers) {
    transfer.push(l.vertices, l.indices);
  }
  self.postMessage(reply, transfer);
};
