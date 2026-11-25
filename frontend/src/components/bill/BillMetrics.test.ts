// @vitest-environment jsdom
/**
 * BillMetrics 回归（B2）：
 * - 四卡：收入 / 支出 / 结余 / 交易数量，数字直接取 `BillMonthTotals`（组件不做算术）；
 * - 结余三档唯一（LO-08）：正 / 负 / 零 各自一个 class，符号由 `MoneyText` 负责；
 * - 隐私遮挡下不出现任何真值。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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

describe('BillMetrics：边距固定（老板要求）', () => {
  /** Vitest 下 import.meta.url 不是 file: scheme，按 cwd（frontend 根）取路径。 */
  function styleOf(relativePath: string): string {
    const source = readFileSync(resolve(process.cwd(), relativePath), 'utf8')
    const start = source.indexOf('<style scoped>')
    const end = source.indexOf('</style>')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    return source.slice(start, end)
  }

  it('四卡 padding 与栅格 gap 是固定 px，媒体查询不再改它们', () => {
    const css = styleOf('src/components/bill/BillMetrics.vue')
    const gridRule = css.match(/\.metrics\s*\{([^}]*)\}/)?.[1] ?? ''
    const cardRule = css.match(/\.metrics__card\s*\{([^}]*)\}/)?.[1] ?? ''

    expect(gridRule).toContain('gap: 12px')
    expect(cardRule).toContain('padding: 16px')
    // 旧移动端覆盖（padding: 12px 14px / gap: 10px）必须彻底移除
    expect(css).not.toContain('gap: 10px')
    expect(css).not.toContain('padding: 12px 14px')
    expect(css).not.toContain('padding: 14px 16px')
    // 四卡共用同一条规则，不存在某张卡单独改边距
    expect(css.match(/\.metrics__card[\w-]*\s*\{[^}]*padding:/g) ?? []).toHaveLength(1)
  })

  it('骨架指标带与真实指标带 gap 一致（12px），加载前后不跳动', () => {
    const billsCss = styleOf('src/views/BillsView.vue')
    const skelRule = billsCss.match(/\.bills__skel-metrics\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(skelRule).toContain('gap: 12px')
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
