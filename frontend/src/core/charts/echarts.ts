/**
 * ECharts 唯一加载器与 init 出口。
 *
 * 三条硬约束（违反即返工）：
 * 1. **全仓只允许从这里拿到 echarts**。任何组件直接 `import 'echarts'` 或
 *    `import * as echarts from 'echarts/core'` 都会把 1MB 拉进入口 chunk，
 *    懒加载失效，``check-bundle-size`` 门禁会红。
 * 2. **注册动作在 `register.ts`，此处只负责懒加载与 init**。注册必须走静态命名
 *    导入（见该文件头注释）：动态 import barrel 会让 rollup 无法 tree-shake，
 *    实测从 173.78 KB 反弹到 336.19 KB gzip。
 * 3. **renderer 恒为 svg**：唯一 init 出口，不接受调用方覆盖。
 *
 * 为什么 echarts 侧全部走动态 import：
 * manualChunks 只决定「落到哪个文件」，静态 import 仍会让入口依赖它 →
 * 首屏照样下载。只有动态 import 才能真正把 echarts 摘出首屏。
 */
import type { ECharts } from 'echarts/core'

export type EChartsInstance = ECharts

/**
 * 懒加载模块的形状。
 *
 * 只需要 `init` —— 注册是 `register.ts` 的模块副作用，加载即生效，
 * 调用方无需（也无法）再 `use()` 任何东西。
 */
export type EChartsModule = typeof import('./register')

/** 释放函数：`releaseChart()` 由 acquireChart 返回。 */
export { MAX_LIVE_CHARTS, acquireChart, liveChartCount, resetLiveChartCount } from './liveCount'

/**
 * 单例 Promise 工厂（纯函数，可注入，便于在 node 环境测并发去重）。
 * 并发调用只执行一次 loader；失败不缓存（下次调用重试），
 * 否则一次网络抖动会让图表永久失效到刷新为止。
 */
export function createOnceLoader<T>(loader: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null
  return () => {
    if (pending) return pending
    const p = loader().catch((err: unknown) => {
      pending = null
      throw err
    })
    pending = p
    return p
  }
}

/**
 * 懒加载 echarts + 注册表。
 *
 * 注意加载的是本目录的 `register.ts` 而不是 `echarts/core` 的 barrel：
 * barrel 命名空间对象不可 tree-shake（实测多付 162 KB gzip）。
 */
const loadECharts = (): Promise<EChartsModule> => import('./register')

/** 全站唯一的 echarts 入口。 */
export const ensureECharts = createOnceLoader(loadECharts)

/**
 * 全站唯一的 init 出口：renderer 固定 svg。
 * 调用前必须自查容器是否还挂在 DOM 上（await 期间组件可能已卸载）。
 */
export async function initChart(
  el: HTMLElement,
): Promise<EChartsInstance | null> {
  if (!el.isConnected) return null
  const core = await ensureECharts()
  // await 期间组件可能已卸载，必须复检，否则会在游离节点上建实例（泄漏）。
  if (!el.isConnected) return null
  return core.init(el, undefined, { renderer: 'svg' })
}
