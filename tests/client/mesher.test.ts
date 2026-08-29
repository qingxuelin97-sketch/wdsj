/**
 * 网格化验证。
 *
 * 重点是 **UV 断言**。前作的 mesher 带着一个致命 UV bug 上线（侧面用 Y 坐标驱动 U/V，
 * y=64 的面会偏移四个图集格，贴上完全不相干的贴图），而它的 mesher 测试从头到尾
 * 没有断言过任何一个 UV 值。这里每个用例都验 UV 与纹理层号。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meshSection, paddedIndex, PADDED_VOLUME, PADDED_AREA, type MeshJob, type MesherTables } from '../../src/client/mesh/mesher.ts';
import { unpackVertex } from '../../src/client/render/block-shader.ts';
import { packState } from '../../src/core/world/chunk.ts';
import { ModelKind, RenderLayer } from '../../src/core/block/types.ts';
import { ModelBaker } from '../../src/core/registry/model-tables.ts';
import { cubeModel, slabModel, stairsModel, type BlockModel } from '../../src/core/block/block-model.ts';
import { Facing } from '../../src/core/block/types.ts';

/** 给测试用的最小模型表：每个 id 都是整格立方体 */
function buildCubeModels(count: number): ReturnType<ModelBaker['finish']> {
  const baker = new ModelBaker();
  for (let id = 1; id < count; id++) {
    for (let meta = 0; meta < 16; meta++) baker.set(id, meta, cubeModel());
  }
  return baker.finish();
}

// --- 测试用的最小方块表 ---
// id 1 = 普通不透明立方体；2 = 玻璃（同类剔除）；3 = 树叶（同类不剔除）；4 = 十字植物
const NUM_IDS = 8;
function makeTables(): MesherTables {
  const t: MesherTables = {
    modelKind: new Uint8Array(NUM_IDS),
    renderLayer: new Uint8Array(NUM_IDS),
    tint: new Uint8Array(NUM_IDS),
    tintFaces: new Uint8Array(NUM_IDS).fill(0b111111),
    fullCube: new Uint8Array(NUM_IDS),
    cullSameType: new Uint8Array(NUM_IDS),
    opaque: new Uint8Array(NUM_IDS),
    faceLayer: new Uint16Array(NUM_IDS * 6),
    // 立方体方块的模型：所有 id 的所有元数据都指向同一个整格模型。
    // 非立方体的形状在 tests/core/block-model.test.ts 里单独验。
    models: buildCubeModels(NUM_IDS),
  };
  // 1: 石头
  t.modelKind[1] = ModelKind.CUBE; t.fullCube[1] = 1; t.opaque[1] = 1;
  t.renderLayer[1] = RenderLayer.OPAQUE;
  // 每个面给一个不同的层号，这样能验出"面 -> 贴图"的映射有没有错位
  for (let f = 0; f < 6; f++) t.faceLayer[1 * 6 + f] = 10 + f;
  // 2: 玻璃
  t.modelKind[2] = ModelKind.CUBE; t.fullCube[2] = 0; t.opaque[2] = 0;
  t.cullSameType[2] = 1; t.renderLayer[2] = RenderLayer.CUTOUT;
  for (let f = 0; f < 6; f++) t.faceLayer[2 * 6 + f] = 20;
  // 3: 树叶
  t.modelKind[3] = ModelKind.CUBE; t.fullCube[3] = 0; t.opaque[3] = 0;
  t.cullSameType[3] = 0; t.renderLayer[3] = RenderLayer.CUTOUT; t.tint[3] = 2;
  for (let f = 0; f < 6; f++) t.faceLayer[3 * 6 + f] = 30;
  // 4: 十字植物
  t.modelKind[4] = ModelKind.CROSS; t.renderLayer[4] = RenderLayer.CUTOUT; t.tint[4] = 1;
  for (let f = 0; f < 6; f++) t.faceLayer[4 * 6 + f] = 40;
  return t;
}

function emptyJob(): MeshJob {
  return {
    cx: 0, cy: 0, cz: 0, rev: 1,
    blocks: new Uint16Array(PADDED_VOLUME),
    light: new Uint8Array(PADDED_VOLUME).fill(0xf0), // 满天光、无方块光
    biomes: new Uint8Array(PADDED_AREA),
  };
}

/** 往 padded 邻域里按**局部坐标**（0..15）写方块 */
function setLocal(job: MeshJob, lx: number, ly: number, lz: number, id: number, meta = 0): void {
  job.blocks[paddedIndex(lx + 1, ly + 1, lz + 1)] = packState(id, meta);
}

/** 往 padded 的边缘一圈写方块（模拟邻居区块） */
function setPadded(job: MeshJob, px: number, py: number, pz: number, id: number): void {
  job.blocks[paddedIndex(px, py, pz)] = packState(id, 0);
}

function totalQuads(r: { layers: { quadCount: number }[] }): number {
  return r.layers.reduce((a, l) => a + l.quadCount, 0);
}

test('孤立方块生成 6 个面', () => {
  const t = makeTables();
  const job = emptyJob();
  setLocal(job, 5, 5, 5, 1);
  const r = meshSection(job, t);
  assert.equal(totalQuads(r), 6);
  assert.equal(r.layers.length, 1);
  assert.equal(r.layers[0]!.layer, RenderLayer.OPAQUE);
  assert.equal(r.layers[0]!.indices.length, 36);
});

test('相邻两方块剔掉接触的两个面', () => {
  const t = makeTables();
  const job = emptyJob();
  setLocal(job, 5, 5, 5, 1);
  setLocal(job, 6, 5, 5, 1);
  assert.equal(totalQuads(meshSection(job, t)), 10);
});

test('3×3×3 实心只留外表面 54 个', () => {
  const t = makeTables();
  const job = emptyJob();
  for (let y = 0; y < 3; y++) for (let z = 0; z < 3; z++) for (let x = 0; x < 3; x++) setLocal(job, x + 4, y + 4, z + 4, 1);
  // 6 面 × 9 格 = 54，中心那块完全被包住
  assert.equal(totalQuads(meshSection(job, t)), 54);
});

test('padded 邻域里的邻居能剔掉边界面 —— 没有这一圈就会有假面和光照缝', () => {
  const t = makeTables();
  const job = emptyJob();
  // 中心区域左下角那一格
  setLocal(job, 0, 0, 0, 1);
  assert.equal(totalQuads(meshSection(job, t)), 6, '四周为空时应有 6 个面');

  // 在 padded 边缘放一个邻居（局部坐标 -1，即 padded 0），西面应被剔除
  const job2 = emptyJob();
  setLocal(job2, 0, 0, 0, 1);
  setPadded(job2, 0, 1, 1, 1); // padded x=0 -> 局部 x=-1，正对西面
  assert.equal(totalQuads(meshSection(job2, t)), 5, '邻区块有方块时西面应被剔除');
});

test('UV 恒为整格，且四角顺序正确 —— 前作正是这里出的错', () => {
  const t = makeTables();
  const job = emptyJob();
  setLocal(job, 8, 8, 8, 1);
  const r = meshSection(job, t);
  const { vertices, quadCount } = r.layers[0]!;

  // 期望的四角 UV，单位是格：origin / +u / +u+v / +v
  const expectedUV = [[0, 1], [1, 1], [1, 0], [0, 0]];

  for (let q = 0; q < quadCount; q++) {
    for (let c = 0; c < 4; c++) {
      const v = unpackVertex(vertices, (q * 4 + c) * 3);
      assert.equal(v.u, expectedUV[c]![0], `第 ${q} 个面第 ${c} 个角的 u`);
      assert.equal(v.v, expectedUV[c]![1], `第 ${q} 个面第 ${c} 个角的 v`);
    }
  }
});

test('每个面用对应朝向的纹理层，不会串面', () => {
  const t = makeTables();
  const job = emptyJob();
  setLocal(job, 8, 8, 8, 1);
  const r = meshSection(job, t);
  const { vertices, quadCount } = r.layers[0]!;

  const seen = new Map<number, number>(); // face -> layer
  for (let q = 0; q < quadCount; q++) {
    const v = unpackVertex(vertices, q * 4 * 3);
    // 同一个面的四个角必须层号一致
    for (let c = 1; c < 4; c++) {
      assert.equal(unpackVertex(vertices, (q * 4 + c) * 3).layer, v.layer, `第 ${q} 面角 ${c} 的层号不一致`);
    }
    seen.set(v.face, v.layer);
  }
  assert.equal(seen.size, 6, '应该正好出现 6 个不同朝向');
  for (let f = 0; f < 6; f++) {
    assert.equal(seen.get(f), 10 + f, `朝向 ${f} 应使用层号 ${10 + f}`);
  }
});

test('顶点位置落在正确的格子上，且不超出 9 bit 编码范围', () => {
  const t = makeTables();
  const job = emptyJob();
  setLocal(job, 15, 15, 15, 1); // 最远的一格
  const r = meshSection(job, t);
  const { vertices, quadCount } = r.layers[0]!;
  for (let i = 0; i < quadCount * 4; i++) {
    const v = unpackVertex(vertices, i * 3);
    assert.ok(v.x >= 15 && v.x <= 16, `x=${v.x} 应在 [15,16]`);
    assert.ok(v.y >= 15 && v.y <= 16, `y=${v.y} 应在 [15,16]`);
    assert.ok(v.z >= 15 && v.z <= 16, `z=${v.z} 应在 [15,16]`);
    // 9 bit 能表示 0..511，也就是 0..31.9375 格；16 格远在范围内
    assert.ok(v.x * 16 < 512 && v.y * 16 < 512 && v.z * 16 < 512);
  }
});

test('玻璃对玻璃剔除共面，树叶对树叶不剔除', () => {
  const t = makeTables();
  const glass = emptyJob();
  setLocal(glass, 5, 5, 5, 2);
  setLocal(glass, 6, 5, 5, 2);
  assert.equal(totalQuads(meshSection(glass, t)), 10, '两块玻璃应剔掉接触面');

  const leaves = emptyJob();
  setLocal(leaves, 5, 5, 5, 3);
  setLocal(leaves, 6, 5, 5, 3);
  assert.equal(totalQuads(meshSection(leaves, t)), 12, '两块树叶不应剔除，否则树冠会看出空洞');
});

test('不透明方块能剔掉玻璃的面，反之不能', () => {
  const t = makeTables();
  // 玻璃贴着石头：玻璃朝石头的那面被剔
  const a = emptyJob();
  setLocal(a, 5, 5, 5, 2); // 玻璃
  setLocal(a, 6, 5, 5, 1); // 石头
  const ra = meshSection(a, t);
  const glassQuads = ra.layers.find((l) => l.layer === RenderLayer.CUTOUT)!.quadCount;
  const stoneQuads = ra.layers.find((l) => l.layer === RenderLayer.OPAQUE)!.quadCount;
  assert.equal(glassQuads, 5, '玻璃朝石头那面应被剔除');
  // 石头保留全部 6 面：玻璃不是 fullCube，挡不住背后的面。
  // 这与 MC 一致 —— 隔着玻璃看石头，石头那一面是画出来的。
  assert.equal(stoneQuads, 6, '石头朝玻璃那面不该被剔除（玻璃不是 fullCube）');
});

test('渲染层被正确分离', () => {
  const t = makeTables();
  const job = emptyJob();
  setLocal(job, 2, 2, 2, 1); // 不透明
  setLocal(job, 8, 8, 8, 3); // cutout
  const r = meshSection(job, t);
  assert.equal(r.layers.length, 2);
  const opaque = r.layers.find((l) => l.layer === RenderLayer.OPAQUE);
  const cutout = r.layers.find((l) => l.layer === RenderLayer.CUTOUT);
  assert.equal(opaque?.quadCount, 6);
  assert.equal(cutout?.quadCount, 6);
});

test('AO：被两侧夹住的角最暗，空旷处最亮', () => {
  const t = makeTables();
  // 一块地面 + 一个墙角，检查地面顶面靠墙那两个角的 AO 更低
  const job = emptyJob();
  for (let z = 0; z < 5; z++) for (let x = 0; x < 5; x++) setLocal(job, x + 3, 3, z + 3, 1);
  // 在 (4,4,3) 和 (3,4,4) 放两块，形成一个内角，包住 (3,4,3) 上方
  setLocal(job, 4, 4, 3, 1);
  setLocal(job, 3, 4, 4, 1);
  const r = meshSection(job, t);
  const { vertices, quadCount } = r.layers[0]!;

  let minAo = 3;
  let maxAo = 0;
  for (let i = 0; i < quadCount * 4; i++) {
    const v = unpackVertex(vertices, i * 3);
    if (v.face !== 1) continue; // 只看 UP 面
    minAo = Math.min(minAo, v.ao);
    maxAo = Math.max(maxAo, v.ao);
  }
  assert.equal(maxAo, 3, '空旷处的顶面角应为最亮 AO=3');
  assert.ok(minAo < 3, `内角处应出现被遮蔽的角，实得最小 AO=${minAo}`);
});

test('十字植物生成 4 个双面四边形，且 UV 完整', () => {
  const t = makeTables();
  const job = emptyJob();
  setLocal(job, 7, 7, 7, 4);
  const r = meshSection(job, t);
  assert.equal(totalQuads(r), 4, '两条对角线各正反两面');
  const { vertices, quadCount } = r.layers[0]!;
  for (let q = 0; q < quadCount; q++) {
    const uvs = [0, 1, 2, 3].map((c) => {
      const v = unpackVertex(vertices, (q * 4 + c) * 3);
      return [v.u, v.v];
    });
    assert.deepEqual(uvs, [[0, 1], [1, 1], [1, 0], [0, 0]], `第 ${q} 个十字面的 UV`);
    assert.equal(unpackVertex(vertices, q * 4 * 3).layer, 40);
    assert.equal(unpackVertex(vertices, q * 4 * 3).tint, 1);
  }
});

test('空区块不产生任何几何', () => {
  const r = meshSection(emptyJob(), makeTables());
  assert.equal(r.layers.length, 0);
  assert.equal(totalQuads(r), 0);
});

test('索引全部落在顶点范围内', () => {
  const t = makeTables();
  const job = emptyJob();
  for (let i = 0; i < 40; i++) {
    setLocal(job, (i * 7) % 16, (i * 5) % 16, (i * 11) % 16, 1 + (i % 3));
  }
  const r = meshSection(job, t);
  for (const layer of r.layers) {
    const vertexCount = layer.vertices.length / 3;
    assert.equal(vertexCount, layer.quadCount * 4, '顶点数应为面数的 4 倍');
    assert.equal(layer.indices.length, layer.quadCount * 6);
    for (const idx of layer.indices) {
      assert.ok(idx < vertexCount, `索引 ${idx} 越界（共 ${vertexCount} 个顶点）`);
    }
  }
});

test('rev 与坐标原样带回 —— 过期结果要能被识别并丢弃', () => {
  const job = { ...emptyJob(), cx: 3, cy: 4, cz: -5, rev: 42 };
  const r = meshSection(job, makeTables());
  assert.equal(r.cx, 3);
  assert.equal(r.cy, 4);
  assert.equal(r.cz, -5);
  assert.equal(r.rev, 42);
});

// ---------------------------------------------------------------------------
// 非立方体模型（M7）
//
// 这一组盯的是 cullface：一个面只有在**正好贴着格子边界**时才允许被邻居剔除。
// 半砖的顶面在 y=8，不贴边界 —— 上面压一块石头也必须照画。
// 标错的话半砖上放东西会看穿，而这在静止截图里几乎发现不了：
// 要从特定角度、特定光照下才显形。
// ---------------------------------------------------------------------------

/** 把 id 5 换成给定模型的表 */
function tablesWithModel(model: BlockModel): MesherTables {
  const t = makeTables();
  const baker = new ModelBaker();
  for (let id = 1; id < NUM_IDS; id++) {
    for (let meta = 0; meta < 16; meta++) baker.set(id, meta, id === 5 ? model : cubeModel());
  }
  const t2 = { ...t, models: baker.finish() } as MesherTables;
  t2.modelKind[5] = ModelKind.CUBE;
  t2.opaque[5] = 0;
  t2.fullCube[5] = 0;
  t2.renderLayer[5] = RenderLayer.OPAQUE;
  for (let f = 0; f < 6; f++) t2.faceLayer[5 * 6 + f] = 50 + f;
  return t2;
}

test('孤立半砖生成 6 个面，顶面在半格高处', () => {
  const t = tablesWithModel(slabModel(true));
  const job = emptyJob();
  setLocal(job, 5, 5, 5, 5);
  const r = meshSection(job, t);
  assert.equal(totalQuads(r), 6, '半砖也是六个面');

  // 找出顶面（face=1）的四个顶点，y 必须都是 5.5 格 = 88（1/16 单位）
  const { vertices, quadCount } = r.layers[0]!;
  let found = false;
  for (let q = 0; q < quadCount; q++) {
    const v = unpackVertex(vertices, q * 4 * 3);
    if (v.face !== 1) continue;
    found = true;
    for (let c = 0; c < 4; c++) {
      const vc = unpackVertex(vertices, (q * 4 + c) * 3);
      // unpackVertex 返回的是**格**为单位的坐标，不是 1/16
      assert.equal(vc.y, 5.5, '半砖顶面应在 y=5.5 格');
    }
  }
  assert.ok(found, '没找到顶面');
});

test('半砖上面压方块时，顶面**仍然要画** —— cullface 的核心用例', () => {
  const t = tablesWithModel(slabModel(true));
  const job = emptyJob();
  setLocal(job, 5, 5, 5, 5);
  setLocal(job, 5, 6, 5, 1); // 正上方压一块实心石头
  const r = meshSection(job, t);

  // 半砖那一格仍应有 6 个面（顶面不贴边界，不该被剔除）
  let slabTop = 0;
  for (const layer of r.layers) {
    for (let q = 0; q < layer.quadCount; q++) {
      const v = unpackVertex(layer.vertices, q * 4 * 3);
      if (v.face === 1 && v.y === 5.5) slabTop++;
    }
  }
  assert.equal(slabTop, 1, '半砖的顶面被错误地剔掉了 —— 上面放方块会看穿');
});

test('半砖下面压方块时，底面要被剔除 —— 它确实贴着边界', () => {
  const t = tablesWithModel(slabModel(true));
  const job = emptyJob();
  setLocal(job, 5, 5, 5, 5);

  // 只数半砖自己的底面（face=0 且 y=5）—— 加一块石头会连带多出它自己的面，
  // 拿总面数做差会把两者混在一起
  const slabBottoms = (r: ReturnType<typeof meshSection>): number => {
    let n = 0;
    for (const layer of r.layers) {
      for (let q = 0; q < layer.quadCount; q++) {
        const v = unpackVertex(layer.vertices, q * 4 * 3);
        if (v.face === 0 && v.y === 5) n++;
      }
    }
    return n;
  };
  assert.equal(slabBottoms(meshSection(job, t)), 1, '孤立时底面要画');
  setLocal(job, 5, 4, 5, 1); // 正下方压一块石头
  assert.equal(slabBottoms(meshSection(job, t)), 0, '底面贴着 y=0，应该被剔掉');
});

test('半砖侧面的 UV 只取贴图的下半张', () => {
  const t = tablesWithModel(slabModel(true));
  const job = emptyJob();
  setLocal(job, 5, 5, 5, 5);
  const r = meshSection(job, t);
  const { vertices, quadCount } = r.layers[0]!;
  for (let q = 0; q < quadCount; q++) {
    const v0 = unpackVertex(vertices, q * 4 * 3);
    if (v0.face < 2) continue; // 只看四个侧面
    const vs = [0, 1, 2, 3].map((c) => unpackVertex(vertices, (q * 4 + c) * 3));
    const us = vs.map((v) => v.u);
    const vv = vs.map((v) => v.v);
    assert.deepEqual([...new Set(us)].sort((a, b) => a - b), [0, 1], `侧面 ${v0.face} 的 u 应铺满整张`);
    // v 只用下半张（0.5..1）：方块只有半格高，贴图就该只取对应的那半张。
    // 不裁的话半砖侧面会把整张贴图压扁到半格里，纹理密度和相邻整块对不上。
    assert.deepEqual([...new Set(vv)].sort((a, b) => a - b), [0.5, 1],
      `侧面 ${v0.face} 的 v 应只取 0.5..1，实得 ${vv}`);
  }
});

test('楼梯生成两个元素的面，比立方体多', () => {
  const t = tablesWithModel(stairsModel(Facing.NORTH, false));
  const job = emptyJob();
  setLocal(job, 5, 5, 5, 5);
  const r = meshSection(job, t);
  // 两个盒子共 12 个面，其中互相贴合的面仍然会画（不做元素间剔除），
  // 所以总数应显著多于 6
  assert.ok(totalQuads(r) >= 10, `楼梯应有十个以上的面，实得 ${totalQuads(r)}`);
});

test('模型里 faceTexture 为 −1 的面不画 —— 梯子只画朝屋里的那一面', () => {
  const t = tablesWithModel({
    elements: [{
      from: [0, 0, 0], to: [16, 16, 2],
      faceTexture: [-1, -1, -1, 3, -1, -1], // 只画 SOUTH
      cullface: [-1, -1, -1, -1, -1, -1],
      clampUv: false,
    }],
  });
  const job = emptyJob();
  setLocal(job, 5, 5, 5, 5);
  const r = meshSection(job, t);
  assert.equal(totalQuads(r), 1, '只该画一个面');
  const v = unpackVertex(r.layers[0]!.vertices, 0);
  assert.equal(v.face, 3, '画出来的应该是 SOUTH 面');
});
