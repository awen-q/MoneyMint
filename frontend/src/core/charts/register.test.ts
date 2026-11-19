// @vitest-environment jsdom
/**
 * `register.ts` 注册表烟测：用**真实 echarts**（不 mock）证明注册表完整可用。
 *
 * 为什么必须有这个文件：`register.ts` 是全仓唯一一个「改错了不报错、只在运行时炸」
 * 的文件。漏注册 `GridComponent` 这类错，三道门全绿——
 * - `option.test.ts` 只测纯函数，不碰注册表；
 * - 组件测试（`TrendChart.test.ts` / `ChartErrorState.test.ts`）全都 mock 掉了 `echarts`；
 * - 体积门禁只看 chunk 分布与 gzip，看不出注册项少了一个。
 * 结果就是直到用户打开账单页才抛 `Component grid is not exists`。
 *
 * 三条断言的分工：
 * 1. `initChart` 能返回实例（renderer 固定 svg 这条路本身通）；
 * 2. 三种图各 `setOption` 一次不抛错（抓「系列/组件没注册」）；
 * 3. 每种图都**真的产出了 SVG 节点**（抓「注册了但没生效 / 渲染器没接上」）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  buildBarOption,
  buildDonutOption,
  buildLineOption,
  type ChartColors,
} from './option'
import { acquireChart, liveChartCount, resetLiveChartCount } from './liveCount'
import { initChart } from './echarts'

/**
 * jsdom 没有 canvas 2d 上下文，zrender 量文字宽度会调 `getContext('2d')`，
 * 不桩就会刷一片 `Not implemented` 甚至中断渲染。
 */
const FAKE_CTX = {
  measureText: (text: string) => ({ width: text.length * 6 }),
  fillText: () => undefined,
  fillRect: () => undefined,
  clearRect: () => undefined,
  strokeRect: () => undefined,
  save: () => undefined,
  restore: () => undefined,
  setTransform: () => undefined,
  translate: () => undefined,
  scale: () => undefined,
  beginPath: () => undefined,
  closePath: () => undefined,
  moveTo: () => undefined,
  lineTo: () => undefined,
  stroke: () => undefined,
  fill: () => undefined,
  setLineDash: () => undefined,
  createLinearGradient: () => ({ addColorStop: () => undefined }),
  font: '',
  textBaseline: 'alphabetic',
  textAlign: 'left',
  lineWidth: 1,
  globalAlpha: 1,
}

const originalGetContext = HTMLCanvasElement.prototype.getContext

beforeAll(() => {
  // @ts-expect-error 故意用最小桩覆盖 jsdom 的空实现
  HTMLCanvasElement.prototype.getContext = () => FAKE_CTX
})

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext
})

/**
 * 建一个带尺寸的容器。
 *
 * jsdom 不做布局，`clientWidth/clientHeight` 恒为 0，ECharts 会打印
 * 「Can't get DOM width or height」并可能跳过渲染，所以必须显式定义。
 */
function createHost(width = 320, height = 200): HTMLDivElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'clientWidth', { value: width, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: height, configurable: true })
  document.body.appendChild(el)
  return el
}

describe('register.ts 注册表（真实 echarts）', () => {
  it('initChart 返回实例，三种图都能渲染出 SVG 节点', async () => {
    resetLiveChartCount()

    const cases = [
      {
        name: 'bar（抓 GridComponent / BarChart）',
        option: {
          xAxis: { type: 'category', data: ['a', 'b'] },
          yAxis: { type: 'value' },
          series: [{ type: 'bar', data: [1, 2] }],
        },
      },
      {
        name: 'line（抓 LineChart）',
        option: {
          xAxis: { type: 'category', data: ['a', 'b'] },
          yAxis: { type: 'value' },
          series: [{ type: 'line', data: [1, 2] }],
        },
      },
      {
        name: 'pie（抓 PieChart）',
        option: {
          series: [
            { type: 'pie', data: [{ value: 1, name: 'x' }, { value: 2, name: 'y' }] },
          ],
        },
      },
    ] as const

    for (const item of cases) {
      const host = createHost()
      const chart = await initChart(host)
      expect(chart, `${item.name}: initChart 返回 null`).not.toBeNull()

      // 系列或组件没注册时，这里会抛 `Series xxx is not exists` / `Component grid is not exists`。
      chart?.setOption(item.option)

      // 断言 3：真的画出了东西，而不是「注册了但渲染器没接上」。
      const svg = host.querySelector('svg')
      expect(svg, `${item.name}: 没有产出 svg 节点`).not.toBeNull()
      const shapes = host.querySelectorAll('svg path, svg rect')
      expect(shapes.length, `${item.name}: svg 里没有任何图形节点`).toBeGreaterThan(0)

      chart?.dispose()
      host.remove()
    }

    // 在册计数不能泄漏：组件层 acquire/release 成对，这里显式验一次。
    const release = acquireChart('register-smoke')
    expect(liveChartCount()).toBe(1)
    release()
    expect(liveChartCount()).toBe(0)
  })

  /**
   * 空数据 option 的**运行时**合法性。
   *
   * 为什么这条放在本文件而不是 `option.test.ts`：那边只能做结构断言，
   * 「ECharts 拿到空类目轴 / 空 series 会不会抛」必须喂真实 echarts 才知道。
   * B4 统计页上下钻时「某一侧没有数据」是常态（某个分类某月零交易），
   * 组件层虽然会降级 empty 不建实例，但 `notMerge` 重建的瞬间仍可能先喂一次空 option。
   *
   * 注意这里不只断言「不抛」：单靠 `not.toThrow()` 很容易变成恒真断言
   * （ECharts 不少问题是 `console.error` 而不抛）。所以再验证 option **真的生效**
   * （`getOption().series[0].type` 对得上），否则「没抛」可能只是「没处理」。
   */
  it('三种图的空数据 option 喂给真实 echarts 不抛错且真的生效', async () => {
    const colors: ChartColors = {
      grid: 'palette-grid',
      ink: 'palette-ink',
      inkDeep: 'palette-ink-deep',
      expense: 'palette-expense',
      income: 'palette-income',
    }
    // 真实空月份形态：页面固定 map 出序列对象，只是 points / data 为空。
    const emptyCases = [
      { type: 'line', option: buildLineOption({ labels: [], series: [], colors }) },
      {
        type: 'line',
        option: buildLineOption({
          labels: [],
          series: [{ name: '支出', color: colors.expense, points: [] }],
          colors,
        }),
      },
      { type: 'pie', option: buildDonutOption({ slices: [] }) },
      { type: 'pie', option: buildDonutOption({ slices: [], masked: true }) },
      { type: 'bar', option: buildBarOption({ data: [], color: 'palette-bar', colors }) },
      {
        type: 'bar',
        option: buildBarOption({
          data: [],
          color: 'palette-bar',
          colors,
          masked: true,
          dense: true,
        }),
      },
    ]

    const host = createHost()
    const chart = await initChart(host)
    expect(chart).not.toBeNull()

    for (const { type, option } of emptyCases) {
      expect(() => chart?.setOption(option, { notMerge: true })).not.toThrow()
      const applied = chart?.getOption() as { series?: Array<{ type?: string }> }
      // `buildLineOption` 的 series 为空时 applied.series 也是空数组，跳过生效断言。
      if ((applied.series ?? []).length > 0) {
        expect(applied.series?.[0]?.type).toBe(type)
      }
    }

    chart?.dispose()
    host.remove()
  })

  /**
   * 负控：证明上面那组 `not.toThrow()` 不是恒真。
   *
   * 缺 `xAxis` 的柱系列会让 ECharts 抛 `xAxis "0" not found`（注册表烟测里
   * 摘掉 `GridComponent` 时的同款错误）。有这条负控，才说明「不抛」是被验证出来的，
   * 而不是 ECharts 什么都不检查。
   */
  it('负控：结构性错误的 option 确实会抛（证明上面的断言不是恒真）', async () => {
    const host = createHost()
    const chart = await initChart(host)
    expect(chart).not.toBeNull()

    expect(() =>
      chart?.setOption({ series: [{ type: 'bar', data: [1, 2] }] }, { notMerge: true }),
    ).toThrow()

    chart?.dispose()
    host.remove()
  })
})
