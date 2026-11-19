/**
 * ECharts 在册实例计数。
 *
 * 为什么需要它：稿内 `assets/charts.js` 的 8 个实例从不 dispose，
 * 路由切走后实例常驻 → 峰值不是「当前页几张图」，而是「切过的所有图」。
 * 生产用 `v-if` 控制面板 + `onBeforeUnmount` 必 dispose 来保证峰值有界，
 * 本模块把这个「有界」变成可断言的数字。
 *
 * 上限 4 的依据：统计页是全站唯一同时挂 4 张图的页面
 * （statTrend + donutE + donutI + catBar），其余页最多 2 张。
 */
export const MAX_LIVE_CHARTS = 4

let live = 0

/** 记录一个实例上线，返回释放函数（便于 try/finally 与测试）。 */
export function acquireChart(label: string): () => void {
  live += 1
  if (import.meta.env.DEV && live > MAX_LIVE_CHARTS) {
    console.warn(
      `[charts] 在册实例 ${live} 个，超过上限 ${MAX_LIVE_CHARTS}（新增：${label}）。` +
        '检查是否有图表组件在 onBeforeUnmount 里漏了 dispose。',
    )
  }
  let released = false
  return () => {
    if (released) return
    released = true
    live = Math.max(0, live - 1)
  }
}

/** 当前在册实例数。 */
export function liveChartCount(): number {
  return live
}

/** 仅测试用：把计数归零，避免用例之间互相污染。 */
export function resetLiveChartCount(): void {
  live = 0
}
