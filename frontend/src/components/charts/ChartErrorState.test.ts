// @vitest-environment jsdom
/**
 * 三个图表组件的「加载失败必须有文案」回归用例（jsdom）。
 *
 * 背景：`ensureInstance()` 早期只有 `try/finally` 没有 `catch`。断网 / chunk 404 /
 * option 构建抛错时，异常只冒到 Vue 的 errorHandler 打一条 console.error，
 * 而 `frameState` 仍是 `ready` → `ChartFrame` 渲染一个固定高度的**空容器**，
 * 既没有图也没有文案。用户无从判断是「这月没数据」还是「图表加载失败」。
 *
 * 这里把 `initChart` 打桩成**抛错**（等价于动态 import 失败），断言三个组件
 * 都落到 `ChartFrame` 的 error 态文案上。比「手动把 ensureECharts 改成 throw
 * 再跑一遍」可靠：不会忘记改回去，也不会在某天被悄悄删掉。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import BarChart from './BarChart.vue'
import DonutChart from './DonutChart.vue'
import TrendChart from './TrendChart.vue'

import { initChart } from '@/core/charts/echarts'

vi.mock('@/core/charts/echarts', () => ({
  initChart: vi.fn(async () => {
    throw new Error('Failed to fetch dynamically imported module')
  }),
  acquireChart: vi.fn(() => () => undefined),
}))

const initSpy = vi.mocked(initChart)

/** 三个组件各自的「有数据」最小 props。 */
const CHARTS = [
  {
    name: 'TrendChart',
    component: TrendChart,
    props: {
      title: '收支趋势',
      chartLabel: '逐日收支趋势',
      labels: ['1'],
      series: [
        {
          name: '支出',
          color: 'palette-expense',
          points: [{ value: 1, amount: '1.00' }],
        },
      ],
    },
  },
  {
    name: 'DonutChart',
    component: DonutChart,
    props: {
      title: '分类构成',
      chartLabel: '支出分类构成',
      slices: [
        { name: '餐饮', value: 1, amount: '1.00', color: 'palette-pie-0' },
      ],
      centerValue: '1.00',
    },
  },
  {
    name: 'BarChart',
    component: BarChart,
    props: {
      title: '分类柱图',
      chartLabel: '分类金额柱图',
      data: [{ label: '餐饮', value: 1, amount: '1.00' }],
      color: 'palette-bar',
    },
  },
] as const

describe('图表加载失败必须出文案（不得停在空容器）', () => {
  for (const item of CHARTS) {
    it(`${item.name}：initChart 抛错 → 渲染「图表加载失败」且不留空白容器`, async () => {
      initSpy.mockClear()
      const wrapper = mount(item.component, {
        props: item.props as never,
      })
      await flushPromises()

      expect(initSpy).toHaveBeenCalledTimes(1)
      expect(wrapper.text()).toContain('图表加载失败')
      // 关键：不是空白 —— 容器被换成状态文案，图表 div 已卸载。
      expect(wrapper.find('.fb-chart__state--error').exists()).toBe(true)
    })

    it(`${item.name}：显式 loading 态压过内部错误（页面重试用例）`, async () => {
      initSpy.mockClear()
      const wrapper = mount(item.component, {
        props: { ...item.props, state: 'ready' } as never,
      })
      await flushPromises()
      expect(wrapper.text()).toContain('图表加载失败')

      // 页面开始重试：切到 loading，错误文案应让位给「正在加载」。
      await wrapper.setProps({ state: 'loading' } as never)
      await flushPromises()
      expect(wrapper.text()).toContain('正在加载图表')
      expect(wrapper.text()).not.toContain('图表加载失败')

      // 重试回到 ready：内部错误已被清除 → 会重新 init（再次失败 → 再次出错误态）。
      await wrapper.setProps({ state: 'ready' } as never)
      await flushPromises()
      expect(initSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(wrapper.text()).toContain('图表加载失败')
    })
  }
})
