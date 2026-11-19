// @vitest-environment jsdom
/**
 * 统计页组件回归（B4 / T42 · T43 · T44 · T48a · T48b · T48c）
 *
 * 只测「口径与版式契约」，不测画图。四条被钉住：
 * 1. `StatsTabs` **不吸底不吸顶**（LO-03：吸底把内容挤出首屏）；
 * 2. `StatsMetrics` 日均的副标必须给分母；未来月显示「—」而不是 `0.00`；
 * 3. `DailyTable` 总计在**卡头**、`tfoot` **只有日均**一行；
 * 4. `Member` / `TrialBalance` 默认收起，且试算平衡显示配平状态（全员可见）。
 */
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import type { AveragePerDay, DailyTable, StatsTotals } from '@/core/stats'
import type { MemberContribution, TrialBalanceRow } from '@/core/reports'
import DailyTableCard from '@/components/stats/DailyTable.vue'
import MemberCard from '@/components/stats/MemberCard.vue'
import PeriodSeg from '@/components/stats/PeriodSeg.vue'
import StatsMetrics from '@/components/stats/StatsMetrics.vue'
import StatsTabs from '@/components/stats/StatsTabs.vue'
import TrialBalanceCard from '@/components/stats/TrialBalanceCard.vue'

beforeEach(() => {
  setActivePinia(createPinia())
})

const TOTALS: StatsTotals = { income: '900.00', expense: '180.00', balance: '720.00', count: 5 }
const AVERAGE_OK: AveragePerDay = {
  income: '90.00',
  expense: '18.00',
  balance: '72.00',
  count: 5,
  elapsedDays: 10,
  applicable: true,
}
const AVERAGE_FUTURE: AveragePerDay = {
  income: '0.00',
  expense: '0.00',
  balance: '0.00',
  count: 0,
  elapsedDays: 0,
  applicable: false,
}

describe('T42 StatsTabs：不吸底不吸顶', () => {
  it('根元素不带 position: sticky/fixed（LO-03 回归护栏）', () => {
    const wrapper = mount(StatsTabs, { props: { tab: 'stat' } })
    const style = wrapper.attributes('style')
    expect(style === undefined || style === '').toBe(true)
    // 样式表里也不允许出现 sticky/fixed（scoped CSS 也要守住）
    expect(wrapper.html()).not.toContain('position: sticky')
    expect(wrapper.html()).not.toContain('position: fixed')
  })

  it('两个 tab 的选中态与语义正确，点击 emit select', async () => {
    const wrapper = mount(StatsTabs, { props: { tab: 'stat' } })
    const buttons = wrapper.findAll('button')
    expect(buttons).toHaveLength(2)
    expect(buttons[0].attributes('aria-selected')).toBe('true')
    expect(buttons[1].attributes('aria-selected')).toBe('false')
    await buttons[1].trigger('click')
    expect(wrapper.emitted('select')?.[0]).toEqual(['tag'])
  })
})

describe('T43 StatsMetrics：五指标', () => {
  it('渲染五张卡（收入/支出/结余/日均消费/记账数量）', () => {
    const wrapper = mount(StatsMetrics, {
      props: { totals: TOTALS, average: AVERAGE_OK, commodity: 'CNY', isCurrentMonth: true },
    })
    const labels = wrapper.findAll('.stats-metrics__label').map((node) => node.text())
    expect(labels).toEqual(['收入', '支出', '结余', '日均消费', '记账数量'])
    expect(wrapper.text()).toContain('5')
  })

  it('日均副标给出分母；本月未完时追加提示', () => {
    const wrapper = mount(StatsMetrics, {
      props: { totals: TOTALS, average: AVERAGE_OK, commodity: 'CNY', isCurrentMonth: true },
    })
    expect(wrapper.text()).toContain('按已过 10 天')
    expect(wrapper.text()).toContain('本月未完')
  })

  it('未来月：日均显示「—」而不是 0.00', () => {
    const wrapper = mount(StatsMetrics, {
      props: { totals: TOTALS, average: AVERAGE_FUTURE, commodity: 'CNY', isCurrentMonth: false },
    })
    expect(wrapper.text()).toContain('本月未开始')
    // 日均那张卡里不应出现 ¥ 0.00
    const cards = wrapper.findAll('.stats-metrics__card')
    expect(cards[3].text()).not.toContain('0.00')
  })
})

const DAILY: DailyTable = {
  rows: [
    { day: 1, date: '2026-11-01', income: '0.00', expense: '150.00', balance: '-150.00', hasData: true, count: 2 },
    { day: 2, date: '2026-11-02', income: '900.00', expense: '0.00', balance: '900.00', hasData: true, count: 1 },
    { day: 3, date: '2026-11-03', income: '0.00', expense: '0.00', balance: '0.00', hasData: false, count: 0 },
  ],
  total: { income: '900.00', expense: '150.00', balance: '750.00', count: 3 },
  average: AVERAGE_OK,
  elapsedDays: 10,
  isCurrentMonth: true,
}

describe('T44 DailyTable：总计在卡头、tfoot 只有日均', () => {
  it('总计渲染在卡头（table 之外），tfoot 只有一行', () => {
    const wrapper = mount(DailyTableCard, { props: { table: DAILY, commodity: 'CNY' } })
    const head = wrapper.find('.daily__head')
    expect(head.text()).toContain('总计')
    expect(head.text()).toContain('900.00')
    const footRows = wrapper.findAll('tfoot tr')
    expect(footRows).toHaveLength(1)
    expect(footRows[0].text()).toContain('日均')
    // 总计不得重复出现在 tfoot
    expect(footRows[0].text()).not.toContain('750.00')
  })

  it('无收支的单元格显示「—」，不显示 ¥0.00', () => {
    const wrapper = mount(DailyTableCard, { props: { table: DAILY, commodity: 'CNY' } })
    const rows = wrapper.findAll('tbody tr')
    expect(rows[0].findAll('.daily__dash').length).toBe(1) // 当天无收入
    expect(rows[2].findAll('.daily__dash').length).toBe(2) // 无收入 + 无支出
  })

  it('日均不可用时 tfoot 显示「—」并给出说明', () => {
    const future: DailyTable = {
      ...DAILY,
      average: AVERAGE_FUTURE,
      elapsedDays: 0,
      isCurrentMonth: false,
    }
    const wrapper = mount(DailyTableCard, { props: { table: future, commodity: 'CNY' } })
    expect(wrapper.text()).toContain('本月未开始，日均暂不计算')
  })
})

describe('T48a PeriodSeg：周/月/年', () => {
  it('三个选项、当前项高亮、点击 emit', async () => {
    const wrapper = mount(PeriodSeg, { props: { period: 'month' } })
    const buttons = wrapper.findAll('button')
    expect(buttons.map((node) => node.text())).toEqual(['周', '月', '年'])
    expect(buttons[1].attributes('aria-pressed')).toBe('true')
    await buttons[2].trigger('click')
    expect(wrapper.emitted('select')?.[0]).toEqual(['year'])
  })
})

describe('T48b MemberCard：默认收起', () => {
  const MEMBERS: MemberContribution[] = [
    { name: '阿文', count: 3, amount: '120.00', ratio: 0.8 },
    { name: '太太', count: 1, amount: '30.00', ratio: 0.2 },
  ]

  it('默认不渲染明细，点击后展开', async () => {
    const wrapper = mount(MemberCard, { props: { members: MEMBERS, commodity: 'CNY' } })
    expect(wrapper.text()).toContain('2 人')
    expect(wrapper.text()).not.toContain('阿文')
    await wrapper.find('.member-card__toggle').trigger('click')
    expect(wrapper.text()).toContain('阿文')
    expect(wrapper.text()).toContain('3 笔')
  })
})

describe('T48c TrialBalanceCard：默认收起 + 全员可见 + 配平状态', () => {
  const ROWS: TrialBalanceRow[] = [
    { label: '现金', type: 'Assets', balance: '1000.00' },
    { label: '房贷', type: 'Liabilities', balance: '-1000.00' },
  ]

  it('默认收起；展开后列出账户与原符号余额', async () => {
    const wrapper = mount(TrialBalanceCard, { props: { rows: ROWS, commodity: 'CNY' } })
    expect(wrapper.text()).toContain('已配平')
    expect(wrapper.text()).not.toContain('现金')
    await wrapper.find('.trial-card__toggle').trigger('click')
    expect(wrapper.text()).toContain('现金')
    expect(wrapper.text()).toContain('Liabilities')
    expect(wrapper.text()).toContain('1,000.00')
  })

  it('不配平时给出差额（不静默通过）', () => {
    const unbalanced: TrialBalanceRow[] = [
      { label: '现金', type: 'Assets', balance: '1000.00' },
      { label: '房贷', type: 'Liabilities', balance: '-990.00' },
    ]
    const wrapper = mount(TrialBalanceCard, { props: { rows: unbalanced, commodity: 'CNY' } })
    expect(wrapper.text()).toContain('差额')
    expect(wrapper.text()).toContain('10.00')
  })
})
