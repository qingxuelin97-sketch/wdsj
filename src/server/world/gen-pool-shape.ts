/** 见 chunk-provider.ts。这里只放池的容量推导，供宿主复用 */

/**
 * 生成 worker 的数量。
 *
 * 上限压到 2：本机空闲内存只有 4.4 GB，而 mesh worker 已经占了 4 个。
 * 生成是 CPU 密集的，多开也换不来线性收益 —— 真正的瓶颈很快会变成
 * 服务端线程的收货与编码。
 */
export function recommendedGenWorkers(cores: number): number {
  return Math.min(2, Math.max(1, (cores - 4) >> 3));
}

/**
 * 允许同时在途的生成请求数。
 *
 * 太小则 worker 空转等下一个 tick 派单；太大则内存里堆着一批算好但还没消费的
 * 区块（一个约 96 KB）。一个 worker 在 50 ms 的 tick 间隔里能做掉约 5 个，
 * 留 10 个的余量才不会让它在两次派单之间闲着。
 */
export function genQueueDepth(workers: number): number {
  return workers * 10;
}
