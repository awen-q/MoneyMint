// @vitest-environment jsdom
/**
 * BillCalendar 回归（T27）：
 * - 42 格；补位格是 `div` + `aria-hidden`，当月格是 `button`；
 * - 四态：`empty` 只显示日号、`expense-only` 带 `-`、`income-only` 带 `+`、`both` 有收入圆点；
 * - 读屏文案：未遮挡用 core 的 `ariaLabel`，遮挡后换成「N月D日，金额已隐藏」且格子只显示遮挡符；
 * - 交互：点格 emit `pick(day)`，选中态出 chip，点 ✕ emit `clear`；
 * - 卡头摘要：支出 / 收入 / 记账 N 天。
 */
import { createPinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import type { BillCell, BillMonthTotals } from '@/core/bill'
import type { CalendarDay } from '@/core/calendar'
import { PRIVACY_MASK } from '@/core/privacy'

import BillCalendar from './BillCalendar.vue'

const TOTALS: BillMonthTotals = {
  expense: '1067.00',
  income: '19000.00',
  balance: '17933.00',
  count: 3,
}

/** 3 天有账：2 号纯支出、3 号双有、4 号纯收入，其余空。 */
const CELLS: BillCell[] = [
  { day: 1, kind: 'empty', text: '', incomeDot: false, ariaLabel: '11月1日，无收支' },
  { day: 2, kind: 'expense-only', text: '-967', incomeDot: false, ariaLabel: '11月2日，支出 967.00' },
  { day: 3, kind: 'both', text: '-100', incomeDot: true, ariaLabel: '11月3日，收入 19000.00，支出 100.00' },
  { day: 4, kind: 'income-only', text: '+500', incomeDot: false, ariaLabel: '11月4日，收入 500.00' },
]

function makeGrid(): CalendarDay[] {
  const out: CalendarDay[] = []
  for (let index = 0; index < 42; index += 1) {
    const day = index < 30 ? index + 1 : index - 29
    out.push({
      key: `2026-11-${String(day).padStart(2, '0')}-${index}`,
      day,
      inMonth: index < 30,
      expense: '0.00',
      income: '0.00',
    })
  }
  return out
}

function mountCalendar(overrides: Record<string, unknown> = {}) {
  return mount(BillCalendar, {
    props: {
      year: 2026,
      month: 11,
      grid: makeGrid(),
      cells: CELLS,
      totals: TOTALS,
      commodity: 'CNY',
      activeDays: 3,
      selectedDay: null,
      masked: false,
      ...overrides,
    },
    global: { plugins: [createPinia()] },
  })
}

describe('BillCalendar：网格与四态', () => {
  it('渲染 42 格，补位格是 div 且 aria-hidden', () => {
    const wrapper = mountCalendar()
    expect(wrapper.findAll('.cal__cell')).toHaveLength(42)
    const buttons = wrapper.findAll('button.cal__cell')
    expect(buttons).toHaveLength(30)
    const padding = wrapper.findAll('div.cal__cell')
    expect(padding).toHaveLength(12)
    expect(padding[0].attributes('aria-hidden')).toBe('true')
  })

  it('empty 日只显示日号，无金额无圆点', () => {
    const wrapper = mountCalendar()
    const day1 = wrapper.findAll('button.cal__cell')[0]
    expect(day1.find('.cal__day').text()).toBe('1')
    expect(day1.find('.cal__amount').exists()).toBe(false)
    expect(day1.find('.cal__dot').exists()).toBe(false)
    expect(day1.classes()).toContain('cal__cell--empty')
  })

  it('纯支出 / 纯收入 / 双有 三种形态各自正确', () => {
    const cells = mountCalendar().findAll('button.cal__cell')
    expect(cells[1].classes()).toContain('cal__cell--expense-only')
    expect(cells[1].find('.cal__amount').text()).toBe('-967')
    expect(cells[2].classes()).toContain('cal__cell--both')
    expect(cells[2].find('.cal__amount').text()).toBe('-100')
    expect(cells[2].find('.cal__dot').exists()).toBe(true)
    expect(cells[3].classes()).toContain('cal__cell--income-only')
    expect(cells[3].find('.cal__amount').text()).toBe('+500')
  })

  it('未遮挡时读屏文案用 core 的 ariaLabel（含金额）', () => {
    const cells = mountCalendar().findAll('button.cal__cell')
    expect(cells[2].attributes('aria-label')).toBe('11月3日，收入 19000.00，支出 100.00')
  })

  it('遮挡时格子只显示遮挡符，读屏文案换成中性版本（不泄露收支结构）', () => {
    const cells = mountCalendar({ masked: true }).findAll('button.cal__cell')
    expect(cells[2].find('.cal__amount').text()).toBe(PRIVACY_MASK)
    expect(cells[2].attributes('aria-label')).toBe('11月3日，金额已隐藏')
    expect(cells[2].attributes('aria-label')).not.toContain('收入')
    // 空日仍然只有日号
    expect(cells[0].find('.cal__amount').exists()).toBe(false)
  })
})

describe('BillCalendar：交互与摘要', () => {
  it('点当月格 emit pick(day)', async () => {
    const wrapper = mountCalendar()
    await wrapper.findAll('button.cal__cell')[2].trigger('click')
    expect(wrapper.emitted('pick')?.[0]).toEqual([3])
  })

  it('选中态：chip 出现、格子 aria-pressed=true，点 ✕ emit clear', async () => {
    const wrapper = mountCalendar({ selectedDay: 3 })
    const cells = wrapper.findAll('button.cal__cell')
    expect(cells[2].attributes('aria-pressed')).toBe('true')
    expect(cells[2].classes()).toContain('cal__cell--on')
    const chip = wrapper.find('.bills__filter-chip')
    expect(chip.text()).toContain('已选 11-03')
    await wrapper.find('.bills__filter-clear').trigger('click')
    expect(wrapper.emitted('clear')).toHaveLength(1)
  })

  it('未选日时不渲染 chip', () => {
    expect(mountCalendar().find('.bills__filter-chip').exists()).toBe(false)
  })

  it('卡头摘要：日期 + 支出/收入 + 记账天数', () => {
    const wrapper = mountCalendar()
    const head = wrapper.find('.bill-cal__head').text()
    expect(wrapper.find('.bill-cal__title').text()).toBe('2026 年 11 月')
    expect(head).toContain('¥ 1,067.00')
    expect(head).toContain('¥ 19,000.00')
    expect(head).toContain('记账 3 天')
  })
})
