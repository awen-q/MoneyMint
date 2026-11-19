// @vitest-environment jsdom
/**
 * TrendChart 空态降级用例（jsdom）。
 *
 * 只测「四态判定 + 槽的挂卸」，**不测画图**：
 * - `initChart` 被打桩成返回 `null`（等价于「容器不在 DOM 上」），
 *   因此不会真建 ECharts 实例，也就不会走到 jsdom 缺失的
 *   `HTMLCanvasElement.getContext`（那会刷一片 Not implemented）。
 * - SVG 计数为 0 是**因为**没建实例，这里断言它，是为了证明
 *   「空态下根本不去 init」，而不是证明「画得对不对」。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import { initChart } from '@/core/charts/echarts'

import TrendChart from './TrendChart.vue'

vi.mock('@/core/charts/echarts', () => ({
  initChart: vi.fn(async () => null),
  acquireChart: vi.fn(() => () => undefined),
}))

const initSpy = vi.mocked(initChart)

/** 最小可挂载 props；用例只覆盖必要字段。 */
function mountChart(overrides: Record<string, unknown> = {}) {
  return mount(TrendChart, {
    props: {
      title: '收支趋势',
      chartLabel: '2026 年 11 月逐日收支趋势',
      labels: [],
      series: [],
      ...overrides,
    },
  })
}

describe('TrendChart 空态降级', () => {
  it('labels 与 series 皆空 → 渲染「暂无数据」，且不建实例、不出 SVG', () => {
    const wrapper = mountChart()
    expect(wrapper.text()).toContain('暂无数据')
    expect(wrapper.find('svg').exists()).toBe(false)
    // 槽随 `v-if="state === 'ready'"` 一起卸掉 → 没有容器，也就没有白占名额的实例。
    expect(wrapper.find('.fb-trend').exists()).toBe(false)
  })

  it('series 非空但每条线的 points 都为空 → 仍降级为空态', () => {
    // 这是最常见的真实形态：页面固定 map 出三条线对象，只是没有数据。
    const wrapper = mountChart({
      series: [
        { name: '支出', color: 'palette-expense', points: [] },
        { name: '收入', color: 'palette-income', points: [] },
      ],
    })
    expect(wrapper.text()).toContain('暂无数据')
    expect(wrapper.find('.fb-trend').exists()).toBe(false)
  })

  it('points 存在但值全为 0 属合法数据，不得降级', () => {
    // 资产清零年 / 某月零支出：轴和点都在，必须照常画。
    const wrapper = mountChart({
      labels: ['1', '2'],
      series: [
        {
          name: '支出',
          color: 'palette-expense',
          points: [
            { value: 0, amount: '0.00' },
            { value: 0, amount: '0.00' },
          ],
        },
      ],
    })
    expect(wrapper.text()).not.toContain('暂无数据')
    expect(wrapper.find('.fb-trend').exists()).toBe(true)
  })

  it('显式 error 优先于「数据为空」：失败绝不能被说成没有数据', () => {
    const wrapper = mountChart({ state: 'error' })
    expect(wrapper.text()).toContain('图表加载失败')
    expect(wrapper.text()).not.toContain('暂无数据')
    expect(wrapper.find('.fb-trend').exists()).toBe(false)
  })

  it('显式 loading 同样优先于空态，且在途期间不建实例', () => {
    const wrapper = mountChart({ state: 'loading' })
    expect(wrapper.text()).toContain('正在加载图表')
    expect(wrapper.text()).not.toContain('暂无数据')
    expect(wrapper.find('.fb-trend').exists()).toBe(false)
  })

  it('空态 → 有数据：槽重新挂载并重新 init（onMounted 不会再跑）', async () => {
    initSpy.mockClear()
    const wrapper = mountChart()
    // 首帧空态：槽被 v-if 卸掉，绝不该有 init。
    expect(initSpy).not.toHaveBeenCalled()
    expect(wrapper.find('.fb-trend').exists()).toBe(false)

    await wrapper.setProps({
      labels: ['1', '2'],
      series: [
        {
          name: '支出',
          color: 'palette-expense',
          points: [
            { value: 1, amount: '1.00' },
            { value: 2, amount: '2.00' },
          ],
        },
      ],
    })
    await flushPromises()

    // 关键断言：容器回来了，且 init 确实被重新调用了一次 ——
    // 证明「先空态后 ready」不会再停在空白（组件没有重新 mount，只能靠 watch(frameState)）。
    expect(wrapper.find('.fb-trend').exists()).toBe(true)
    expect(initSpy).toHaveBeenCalledTimes(1)
  })

  it('有数据 → 空数据：槽被卸掉，回到空态文案', async () => {
    const wrapper = mountChart({
      labels: ['1'],
      series: [
        {
          name: '支出',
          color: 'palette-expense',
          points: [{ value: 1, amount: '1.00' }],
        },
      ],
    })
    await flushPromises()
    expect(wrapper.find('.fb-trend').exists()).toBe(true)

    await wrapper.setProps({ labels: [], series: [] })
    await flushPromises()

    expect(wrapper.text()).toContain('暂无数据')
    expect(wrapper.find('.fb-trend').exists()).toBe(false)
  })
})
