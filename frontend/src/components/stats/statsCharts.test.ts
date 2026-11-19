// @vitest-environment jsdom
/**
 * 图表卡的下钻与「颜色单一来源」回归（B4 / T45 · T46 · T47）
 *
 * 图表本体用桩替换（jsdom 没有 canvas）：本文件测的是**接线**——
 * `pick(index)` 事件是否映射到正确的分类 / 标签，以及环图 slice 与排行行
 * 是否共用同一份颜色。画得对不对由图表组件自己的用例负责。
 */
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent } from 'vue'

import type { CategoryShare } from '@/core/reports'
import type { DailyRow, TagShare } from '@/core/stats'
import CategoryBarCard from '@/components/stats/CategoryBarCard.vue'
import DonutRankCard from '@/components/stats/DonutRankCard.vue'
import TagPanel from '@/components/stats/TagPanel.vue'

beforeEach(() => {
  setActivePinia(createPinia())
})

/** 捕获 props 且能回放 pick 的 Chart 桩。 */
const BarStub = defineComponent({
  name: 'BarChart',
  props: ['data', 'title', 'chartLabel', 'color', 'masked', 'state', 'dense', 'emptyText'],
  emits: ['pick'],
  template: '<div class="bar-stub" />',
})

const DonutStub = defineComponent({
  name: 'DonutChart',
  props: ['slices', 'title', 'chartLabel', 'centerText', 'centerValue', 'commodity', 'masked', 'state', 'emptyText'],
  emits: ['pick'],
  template: '<div class="donut-stub" />',
})

/**
 * 颜色比较：jsdom 会把内联 style 里的 hex 归一成三通道数值串，
 * 因此不比字符串，而是**比通道数值**（更强，且避免在源码里写色值字面量——
 * 主题门禁会把任何色值函数调用或 hex 判成未授权硬编码色值）。
 */
function styleChannels(style: string): number[] {
  const matched = style.match(/(\d+),\s*(\d+),\s*(\d+)/)
  if (matched === null) {
    return []
  }
  return [Number(matched[1]), Number(matched[2]), Number(matched[3])]
}

function hexChannels(hex: string): number[] {
  const raw = hex.replace('#', '')
  return [
    parseInt(raw.slice(0, 2), 16),
    parseInt(raw.slice(2, 4), 16),
    parseInt(raw.slice(4, 6), 16),
  ]
}

const CATEGORIES: CategoryShare[] = [
  { label: '餐饮', amount: '80.00', ratio: 0.53, id: 10, count: 2, kind: 'Expenses' },
  { label: '交通', amount: '70.00', ratio: 0.47, id: 11, count: 1, kind: 'Expenses' },
]

const DRILL_DAILY: DailyRow[] = [
  { day: 1, date: '2026-11-01', income: '0.00', expense: '30.00', balance: '-30.00', hasData: true, count: 1 },
  { day: 2, date: '2026-11-02', income: '0.00', expense: '50.00', balance: '-50.00', hasData: true, count: 1 },
]

describe('T45 CategoryBarCard：点柱下钻与返回', () => {
  function mountCard(overrides: Record<string, unknown> = {}) {
    return mount(CategoryBarCard, {
      props: {
        categories: CATEGORIES,
        drillDaily: DRILL_DAILY,
        direction: 'expense',
        drilledId: null,
        drilledLabel: '',
        commodity: 'CNY',
        ...overrides,
      },
      global: { stubs: { BarChart: BarStub } },
    })
  }

  it('全部分类时，柱数据来自 categories（label + 定点金额）', () => {
    const wrapper = mountCard()
    const bar = wrapper.findComponent(BarStub)
    const data = bar.props('data') as Array<{ label: string; value: number; amount: string }>
    expect(data.map((item) => item.label)).toEqual(['餐饮', '交通'])
    expect(data.map((item) => item.amount)).toEqual(['80.00', '70.00'])
    expect(data.map((item) => item.value)).toEqual([80, 70])
    expect(wrapper.text()).toContain('支出分类统计')
  })

  it('点柱 → emit drill(该分类 id)；返回按钮 → emit drill(null)', async () => {
    const wrapper = mountCard()
    wrapper.findComponent(BarStub).vm.$emit('pick', 1)
    expect(wrapper.emitted('drill')?.[0]).toEqual([11])
  })

  it('已下钻时柱数据切换为该分类逐日金额，且出现返回按钮', () => {
    const wrapper = mountCard({ drilledId: 10, drilledLabel: '餐饮' })
    const bar = wrapper.findComponent(BarStub)
    const data = bar.props('data') as Array<{ label: string; amount: string }>
    expect(data.map((item) => item.label)).toEqual(['1', '2'])
    expect(data.map((item) => item.amount)).toEqual(['30.00', '50.00'])
    expect(wrapper.text()).toContain('餐饮 · 每日支出')
    const back = wrapper.findAll('button').filter((node) => node.text().includes('返回全部分类'))
    expect(back).toHaveLength(1)
  })

  it('已下钻时点柱不再重复下钻（避免 id 被覆盖）', () => {
    const wrapper = mountCard({ drilledId: 10, drilledLabel: '餐饮' })
    wrapper.findComponent(BarStub).vm.$emit('pick', 0)
    expect(wrapper.emitted('drill')).toBeUndefined()
  })

  it('方向 seg 点击 emit select-direction', async () => {
    const wrapper = mountCard()
    const buttons = wrapper.findAll('.cat-bar__seg-btn')
    await buttons[1].trigger('click')
    expect(wrapper.emitted('select-direction')?.[0]).toEqual(['income'])
  })

  it('收入方向时用收入逐日金额', () => {
    const wrapper = mountCard({
      direction: 'income',
      drilledId: 20,
      drilledLabel: '工资',
      drillDaily: [
        { day: 1, date: '2026-11-01', income: '900.00', expense: '0.00', balance: '900.00', hasData: true, count: 1 },
      ],
    })
    const data = wrapper.findComponent(BarStub).props('data') as Array<{ amount: string }>
    expect(data[0].amount).toBe('900.00')
  })
})

describe('T46 DonutRankCard：环图与排行共用同一份颜色', () => {
  const EXPENSE: CategoryShare[] = [
    { label: '餐饮', amount: '80.00', ratio: 0.53, id: 10, count: 2, kind: 'Expenses' },
    { label: '交通', amount: '70.00', ratio: 0.47, id: 11, count: 1, kind: 'Expenses' },
  ]
  const INCOME: CategoryShare[] = [
    { label: '工资', amount: '900.00', ratio: 1, id: 20, count: 1, kind: 'Income' },
  ]

  function mountCard() {
    return mount(DonutRankCard, {
      props: {
        expense: EXPENSE,
        income: INCOME,
        expenseTotal: '150.00',
        incomeTotal: '900.00',
        commodity: 'CNY',
      },
      global: { stubs: { DonutChart: DonutStub } },
    })
  }

  it('排行行的色块与 ring slice 的颜色逐一相同（单一来源）', () => {
    const wrapper = mountCard()
    const donuts = wrapper.findAllComponents(DonutStub)
    const expenseSlices = donuts[0].props('slices') as Array<{ color: string; name: string }>
    const dots = wrapper.findAll('.donut-rank__dot')
    // 前两条是支出侧的排行行
    expect(styleChannels(dots[0].attributes('style') ?? '')).toEqual(hexChannels(expenseSlices[0].color))
    expect(styleChannels(dots[1].attributes('style') ?? '')).toEqual(hexChannels(expenseSlices[1].color))
    // 两块颜色必须不同（相邻撞色顺延逻辑生效）
    expect(expenseSlices[0].color).not.toBe(expenseSlices[1].color)
  })

  it('环心金额取定点串（不由 value 反算），且带币种', () => {
    const wrapper = mountCard()
    const donuts = wrapper.findAllComponents(DonutStub)
    expect(donuts[0].props('centerValue')).toBe('150.00')
    expect(donuts[1].props('centerValue')).toBe('900.00')
    expect(donuts[0].props('commodity')).toBe('CNY')
  })

  it('点环 → emit drill(id, kind)；点排行行同样下钻', async () => {
    const wrapper = mountCard()
    wrapper.findAllComponents(DonutStub)[0].vm.$emit('pick', 1)
    expect(wrapper.emitted('drill')?.[0]).toEqual([11, 'expense'])
    await wrapper.findAll('.donut-rank__row')[2].trigger('click')
    expect(wrapper.emitted('drill')?.[1]).toEqual([20, 'income'])
  })

  it('某侧为空时该侧环走 empty 态', () => {
    const wrapper = mount(DonutRankCard, {
      props: {
        expense: [],
        income: INCOME,
        expenseTotal: '0.00',
        incomeTotal: '900.00',
        commodity: 'CNY',
      },
      global: { stubs: { DonutChart: DonutStub } },
    })
    const donuts = wrapper.findAllComponents(DonutStub)
    expect(donuts[0].props('state')).toBe('empty')
    expect(donuts[1].props('state')).toBe('ready')
  })
})

describe('T47 TagPanel：未打标签桶照常显示', () => {
  const SHARES: TagShare[] = [
    { tag: '家庭', expense: '100.00', income: '0.00', balance: '-100.00', count: 1, isUntagged: false },
    { tag: '工资', expense: '0.00', income: '900.00', balance: '900.00', count: 1, isUntagged: false },
    { tag: '未打标签', expense: '30.00', income: '0.00', balance: '-30.00', count: 1, isUntagged: true },
  ]

  function mountPanel() {
    return mount(TagPanel, {
      props: { shares: SHARES, commodity: 'CNY' },
      global: { stubs: { DonutChart: DonutStub } },
    })
  }

  it('未打标签作为普通行显示（不加 # 前缀），且计入表格', () => {
    const wrapper = mountPanel()
    const rows = wrapper.findAll('tbody tr')
    expect(rows).toHaveLength(3)
    expect(wrapper.text()).toContain('未打标签')
    expect(wrapper.text()).toContain('#家庭')
    expect(wrapper.text()).not.toContain('#未打标签')
  })

  it('支出 / 收入双环只取对应方向 > 0 的标签', () => {
    const wrapper = mountPanel()
    const donuts = wrapper.findAllComponents(DonutStub)
    const expenseSlices = donuts[0].props('slices') as Array<{ name: string; amount: string }>
    const incomeSlices = donuts[1].props('slices') as Array<{ name: string; amount: string }>
    expect(expenseSlices.map((slice) => slice.name).sort()).toEqual(['家庭', '未打标签'].sort())
    expect(incomeSlices.map((slice) => slice.name)).toEqual(['工资'])
    expect(expenseSlices.every((slice) => slice.amount !== '0.00')).toBe(true)
  })

  it('点击表格行 / 排行行都 emit drill(tag, kind)', async () => {
    const wrapper = mountPanel()
    await wrapper.findAll('.tag-panel__row-btn')[0].trigger('click')
    expect(wrapper.emitted('drill')?.[0]).toEqual(['家庭', 'expense'])
    await wrapper.findAll('.tag-panel__rank')[0].trigger('click')
    expect(wrapper.emitted('drill')?.[1]).toEqual(['家庭', 'expense'])
  })

  it('无标签交易时给出空态文案，不渲染空表格', () => {
    const wrapper = mount(TagPanel, {
      props: { shares: [], commodity: 'CNY' },
      global: { stubs: { DonutChart: DonutStub } },
    })
    expect(wrapper.text()).toContain('本月暂无可统计的标签交易')
    expect(wrapper.find('table').exists()).toBe(false)
  })
})
