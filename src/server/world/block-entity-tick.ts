/**
 * 方块实体的每刻处理，以及它们需要的外部信息。
 *
 * 只遍历 `BlockEntityStore.tickingEntities()`（目前就是熔炉），
 * 不扫描已加载区块 —— 计划 §3.2 坑 #9 点名的就是后者。
 */
import type { ServerCore } from '../server-core.ts';
import type { BlockEntityContext } from './block-entity.ts';
import { packState, stateMeta } from '../../core/world/chunk.ts';
import { maxStackOf } from '../player/inventory-actions.ts';
import { BrewingEntity } from './block-entity-craft.ts';
import { brew } from '../../core/craft/brewing.ts';

/** 建一个 tick 上下文。里面的四个查询都要 O(1)，因为熔炉每刻都会问 */
export function makeBlockEntityContext(core: ServerCore, world = core.world): BlockEntityContext {
  return {
    burnTicks: (id) => core.items.get(id)?.burnTicks ?? 0,
    smeltResult: (id) => {
      const r = core.smeltingOf(id);
      return r === null ? null : { id: r.outputId, count: r.outputCount };
    },
    maxStack: (id) => maxStackOf(core, id),
    setBlockId: (x, y, z, id) => {
      // 保住元数据：熔炉的朝向存在元数据里，点火时只该换 id
      const meta = stateMeta(world.getBlock(x, y, z));
      world.setBlock(x, y, z, packState(id, meta));
    },
  };
}

/**
 * 推进所有需要 tick 的方块实体。
 *
 * 熔炉点火/熄火会调 setBlockId，那会走进 ServerWorld.setBlock ——
 * 而 setBlock 又会因为 61<->62 触发 updateBlockEntity。那里特意判了
 * "同一种方块实体就不动"，所以熔炉不会在点火的瞬间被清空。
 */
export function tickBlockEntities(core: ServerCore): void {
  for (const world of core.loadedWorlds()) {
    const store = world.blockEntities;
    if (store.tickingCount === 0) continue;
    const ctx = makeBlockEntityContext(core, world);
    // 先抄一份再遍历：tick 里可能会改方块，而那会动到 ticking 集合本身
    for (const entity of [...store.tickingEntities()]) {
      // 酿造台的推进要一张物品名字表（core 的 brew() 按名字查配方），
      // 那不在 BlockEntityContext 里 —— 加进去的话每个方块实体都要
      // 认识酿造，而熔炉不该知道药水是什么
      const changed = entity instanceof BrewingEntity
        ? entity.tickBrew((damage, id) => resolveBrew(core, damage, id))
        : entity.tick(ctx);
      if (changed) core.markBlockEntityDirty(entity);
    }
  }
}

/** 把"药水 damage + 材料物品 id"翻译成 core 的 brew() 能吃的形式 */
function resolveBrew(core: ServerCore, potionDamage: number, ingredientId: number): number | null {
  const name = core.items.get(ingredientId)?.name;
  if (name === undefined) return null;
  return brew(potionDamage, name);
}
