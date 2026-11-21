// @vitest-environment jsdom
/**
 * BillCalendar 回归（T27）：
 * - 42 格；补位格是 `div` + `aria-hidden`，当月格是 `button`；
 * - 四态：`empty` 只显示日号、`expense-only` 带 `-`、`income-only` 带 `+`、`both` 有收入圆点；
 * - 读屏文案：未遮挡用 core 的 `ariaLabel`，遮挡后换成「N月D日，金额已隐藏」且格子只显示遮挡符；
 * - 交互：点格 emit `pick(day)`，选中态带 `cal__cell--on`；今天带 `cal__cell--today`；
 * - 卡头摘要：支出 / 收入 / 记账 N 天。
 *
 * 注：「已选 11-03 · N 笔」与「查看整月 ✕」**不在本组件里**（审计 B-17/B-18：
 * 它清的是列表的日筛选，搬到 `BillsView` 的列表卡内），所以本文件不再断言 chip。
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
  {
    day: 3,
    kind: 'both',
    text: '-100',
    incomeText: '+1.9w',
    incomeDot: true,
    ariaLabel: '11月3日，收入 19000.00，支出 100.00',
  },
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

/**
 * 当月 1..31 全部「在月内」的 42 格。
 *
 * 「今天」用例专用：当月天数由真实日期决定（28~31），用固定 30 格的 `makeGrid()`
 * 会在 31 号那天找不到格子。这里宁可可重复，也不让用例按日期飘。
 */
function makeFullMonthGrid(year: number, month: number): CalendarDay[] {
  const prefix = `${year}-${String(month).padStart(2, '0')}`
  const out: CalendarDay[] = []
  for (let index = 0; index < 42; index += 1) {
    const day = index < 31 ? index + 1 : index - 30
    out.push({
      key: `${prefix}-${String(day).padStart(2, '0')}-${index}`,
      day,
      inMonth: index < 31,
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

  it('同日双有：支出在第一行，收入在第二行并带 --income 修饰', () => {
    const cells = mountCalendar().findAll('button.cal__cell')
    const amounts = cells[2].findAll('.cal__amount')
    expect(amounts).toHaveLength(2)
    expect(amounts[0].text()).toBe('-100')
    expect(amounts[1].text()).toBe('+1.9w')
    expect(amounts[1].classes()).toContain('cal__amount--income')
    // 纯收入日只有一行，不重复显示第二行
    expect(cells[3].findAll('.cal__amount')).toHaveLength(1)
  })

  it('遮挡态：收入第二行与收入圆点都不渲染', () => {
    const cells = mountCalendar({ masked: true }).findAll('button.cal__cell')
    expect(cells[2].findAll('.cal__amount')).toHaveLength(1)
    expect(cells[2].find('.cal__amount--income').exists()).toBe(false)
    expect(cells[2].find('.cal__dot').exists()).toBe(false)
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

  it('遮挡态：当月格类名统一降级为 masked，不再泄露真实四态', () => {
    const wrapper = mountCalendar({ masked: true })
    const realKinds = [
      'cal__cell--both',
      'cal__cell--income-only',
      'cal__cell--expense-only',
      'cal__cell--empty',
    ]
    const cells = wrapper.findAll('button.cal__cell')
    expect(cells).toHaveLength(30)
    for (const cell of cells) {
      const classes = cell.classes()
      expect(classes).toContain('cal__cell--masked')
      for (const kind of realKinds) {
        expect(classes).not.toContain(kind)
      }
    }
    // 补位格仍保持 padding，不受遮挡态影响
    for (const padding of wrapper.findAll('div.cal__cell')) {
      expect(padding.classes()).toContain('cal__cell--padding')
      expect(padding.classes()).not.toContain('cal__cell--masked')
    }
  })

  it('遮挡态：masked 与 today / selected 高亮修饰类共存', () => {
    const now = new Date()
    const year = now.getFullYear()
    const month = now.getMonth() + 1
    const wrapper = mount(BillCalendar, {
      global: { plugins: [createPinia()] },
      props: {
        year,
        month,
        grid: makeFullMonthGrid(year, month),
        cells: CELLS,
        totals: TOTALS,
        commodity: 'CNY',
        activeDays: 3,
        selectedDay: now.getDate(),
        masked: true,
      },
    })
    const todayCell = wrapper.findAll('button.cal__cell')[now.getDate() - 1]
    const classes = todayCell.classes()
    expect(classes).toContain('cal__cell--masked')
    expect(classes).toContain('cal__cell--today')
    expect(classes).toContain('cal__cell--on')
  })
})

describe('BillCalendar：交互与摘要', () => {
  it('点当月格 emit pick(day)', async () => {
    const wrapper = mountCalendar()
    await wrapper.findAll('button.cal__cell')[2].trigger('click')
    expect(wrapper.emitted('pick')?.[0]).toEqual([3])
  })

  it('选中态：格子 aria-pressed=true 且带 cal__cell--on', () => {
    const wrapper = mountCalendar({ selectedDay: 3 })
    const cells = wrapper.findAll('button.cal__cell')
    expect(cells[2].attributes('aria-pressed')).toBe('true')
    expect(cells[2].classes()).toContain('cal__cell--on')
    expect(wrapper.findAll('.cal__cell--on')).toHaveLength(1)
  })

  it('未选日时没有任何选中格', () => {
    const wrapper = mountCalendar()
    expect(wrapper.findAll('.cal__cell--on')).toHaveLength(0)
    expect(wrapper.findAll('button.cal__cell')[2].attributes('aria-pressed')).toBe('false')
  })

  it('今天：唯一一格带 cal__cell--today，且读屏文案补「，今天」', () => {
    const now = new Date()
    const wrapper = mount(BillCalendar, {
      global: { plugins: [createPinia()] },
      props: {
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        grid: makeFullMonthGrid(now.getFullYear(), now.getMonth() + 1),
        cells: [],
        totals: TOTALS,
        commodity: 'CNY',
        activeDays: 0,
        selectedDay: null,
      },
    })
    const cells = wrapper.findAll('button.cal__cell')
    const todayCell = cells[now.getDate() - 1]
    expect(todayCell.classes()).toContain('cal__cell--today')
    expect(todayCell.attributes('aria-label')).toContain('，今天')
    // 视觉高亮只该有今天一格（不能因为「没数据」就把好几格都点亮）
    expect(wrapper.findAll('.cal__cell--today')).toHaveLength(1)
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
