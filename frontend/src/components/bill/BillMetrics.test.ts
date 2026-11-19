// @vitest-environment jsdom
/**
 * BillMetrics 回归（B2）：
 * - 四卡：收入 / 支出 / 结余 / 交易数量，数字直接取 `BillMonthTotals`（组件不做算术）；
 * - 结余三档唯一（LO-08）：正 / 负 / 零 各自一个 class，符号由 `MoneyText` 负责；
 * - 隐私遮挡下不出现任何真值。
 */
import { createPinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'

import type { BillMonthTotals } from '@/core/bill'
import { formatMoney } from '@/core/Money'
import { PRIVACY_MASK } from '@/core/privacy'
import { usePrivacyStore } from '@/stores/privacy'

import BillMetrics from './BillMetrics.vue'

const TOTALS: BillMonthTotals = {
  expense: '1067.00',
  income: '19000.00',
  balance: '17933.00',
  count: 3,
}

function mountMetrics(totals: BillMonthTotals = TOTALS) {
  return mount(BillMetrics, {
    props: { totals, commodity: 'CNY' },
    global: { plugins: [createPinia()] },
  })
}

beforeEach(() => {
  localStorage.clear()
})

describe('BillMetrics：四卡', () => {
  it('四项文案与 BillMonthTotals 逐字一致（不自己算）', () => {
    const cards = mountMetrics().findAll('.metrics__card')
    expect(cards).toHaveLength(4)
    expect(cards[0].text()).toContain('收入')
    expect(cards[0].text()).toContain(formatMoney(TOTALS.income, 'CNY'))
    expect(cards[1].text()).toContain(formatMoney(TOTALS.expense, 'CNY'))
    expect(cards[2].text()).toContain(formatMoney(TOTALS.balance, 'CNY'))
    expect(cards[3].text()).toContain('3 笔')
  })

  it('收入与支出都按正数展示（不出现负的支出）', () => {
    const cards = mountMetrics().findAll('.metrics__card')
    expect(cards[1].text()).not.toContain('-¥')
    expect(cards[0].text()).not.toContain('-¥')
  })
})

describe('BillMetrics：结余三档', () => {
  it('结余为正 → pos 档，并带显式 +', () => {
    const wrapper = mountMetrics()
    const value = wrapper.findAll('.metrics__value')[0]
    expect(value.classes()).toContain('metrics__value--pos')
    expect(value.text()).toContain('+¥ 17,933.00')
  })

  it('结余为负 → neg 档，带负号', () => {
    const wrapper = mountMetrics({ ...TOTALS, balance: '-500.00' })
    const value = wrapper.findAll('.metrics__value')[0]
    expect(value.classes()).toContain('metrics__value--neg')
    expect(value.text()).toContain('-¥ 500.00')
  })

  it('结余为零 → neutral 档，且不带符号', () => {
    const wrapper = mountMetrics({ ...TOTALS, balance: '0.00' })
    const value = wrapper.findAll('.metrics__value')[0]
    expect(value.classes()).toContain('metrics__value--neutral')
    expect(value.text()).toBe('¥ 0.00')
  })
})

describe('BillMetrics：隐私', () => {
  it('遮挡时所有金额位都是遮挡符，不出现真值', async () => {
    const pinia = createPinia()
    const wrapper = mount(BillMetrics, {
      props: { totals: TOTALS, commodity: 'CNY' },
      global: { plugins: [pinia] },
    })
    usePrivacyStore(pinia).setEnabled(true)
    await wrapper.vm.$nextTick()

    const text = wrapper.text()
    expect(text).toContain(PRIVACY_MASK)
    expect(text).not.toContain('19,000.00')
    expect(text).not.toContain('1,067.00')
    expect(text).not.toContain('17,933.00')
    // 笔数不是金额，遮挡时仍应可读（它是用户判断「有没有数据」的依据）
    expect(text).toContain('3 笔')
  })
})
