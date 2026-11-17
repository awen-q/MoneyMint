// @vitest-environment jsdom
/**
 * 高级双录子组件回归：
 * - 配平判定按 commodity 分组，多币种各自 sum=0 才算通过；
 * - auto-balance 只补一行且账户留空 → canSubmit=false（禁保存）；
 * - 增删行守门（至少 2 行）；
 * - .js-bean 展示的片段与 core/bean 生成结果逐字一致。
 */
import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import AdvancedPostings from './AdvancedPostings.vue'
import { buildBeanSnippet } from '@/core/bean'
import type { AdvancedRow } from '@/core/record'

const ACCOUNTS = [
  { id: 1, uuid: 'a1', name: 'Assets:Cash', display_name: '现金', type: 'Assets' as const, open_date: '2026-01-01', sort_order: 0 },
  { id: 2, uuid: 'a2', name: 'Assets:Bank', display_name: '银行', type: 'Assets' as const, open_date: '2026-01-01', sort_order: 0, commodity_restriction: 'USD' },
  { id: 3, uuid: 'a3', name: 'Expenses:Food', display_name: '食品', type: 'Expenses' as const, open_date: '2026-01-01', sort_order: 0 },
]

function rows(input: Array<[number | null, string, string]>): AdvancedRow[] {
  return input.map(([accountId, amount, commodity]) => ({ accountId, amount, commodity }))
}

function canSubmitOf(wrapper: ReturnType<typeof mount>): boolean {
  return (wrapper.vm as unknown as { canSubmit: boolean }).canSubmit
}

function mountRows(initial: AdvancedRow[], editing = false) {
  const bean = buildBeanSnippet({
    date: '2026-11-16',
    flag: '*',
    description: '超市采购',
    tags: ['日常'],
    postings: initial.map((row) => ({
      accountName: row.accountId === null ? '' : (ACCOUNTS.find((a) => a.id === row.accountId)?.name ?? ''),
      amount: row.amount,
      commodity: row.commodity,
    })),
  })
  const wrapper = mount(AdvancedPostings, {
    props: {
      rows: initial,
      accounts: ACCOUNTS,
      commodities: ['CNY', 'USD'],
      bean,
      editing,
    },
  })
  return { wrapper, bean }
}

describe('AdvancedPostings：配平与守门', () => {
  it('两行同币种配平 → canSubmit=true，配平卡展示借贷与差额', () => {
    const { wrapper } = mountRows(rows([[3, '128.50', 'CNY'], [1, '-128.50', 'CNY']]))
    expect(canSubmitOf(wrapper)).toBe(true)
    expect(wrapper.find('.js-bal-tag').text()).toContain('已平衡')
    expect(wrapper.find('.js-check').text()).toContain('CNY 差额')
    expect(wrapper.findAll('.adv-row')).toHaveLength(2)
    expect(wrapper.find('[data-rf="acc"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('不平衡 → canSubmit=false，差额按币种直出', () => {
    const { wrapper } = mountRows(rows([[3, '100.00', 'CNY'], [1, '-30.00', 'CNY']]))
    expect(canSubmitOf(wrapper)).toBe(false)
    expect(wrapper.find('.js-check').text()).toContain('70.00')
    wrapper.unmount()
  })

  it('auto-balance 只补一行、账户留空 → canSubmit=false（禁保存）', async () => {
    const { wrapper } = mountRows(rows([[3, '100.00', 'CNY'], [1, '-30.00', 'CNY']]))
    const auto = wrapper.find('[data-act="auto-balance"]')
    await auto.trigger('click')
    await flushPromises()

    const emitted = wrapper.emitted('update:rows')
    expect(emitted).toBeDefined()
    const next = (emitted?.[0]?.[0] ?? []) as AdvancedRow[]
    expect(next).toHaveLength(3)
    expect(next[2].accountId).toBeNull()
    expect(next[2].amount).toBe('-70.00')
    expect(next[2].commodity).toBe('CNY')
    // 本地副本同步后守门立即生效。
    expect(canSubmitOf(wrapper)).toBe(false)
    wrapper.unmount()
  })

  it('选择补行账户并配平后 → canSubmit=true', async () => {
    const { wrapper } = mountRows(rows([[3, '100.00', 'CNY'], [1, '-30.00', 'CNY']]))
    await wrapper.find('[data-act="auto-balance"]').trigger('click')
    const next = (wrapper.emitted('update:rows')?.[0]?.[0] ?? []) as AdvancedRow[]
    await wrapper.setProps({ rows: next })
    await flushPromises()
    expect(canSubmitOf(wrapper)).toBe(false)

    const thirdRow = wrapper.findAll('.adv-row')[2]
    await thirdRow.find('[data-rf="acc"]').setValue('1')
    await flushPromises()
    const after = (wrapper.emitted('update:rows')?.slice(-1)[0]?.[0] ?? []) as AdvancedRow[]
    expect(after[2].accountId).toBe(1)
    expect(after[2].commodity).toBe('CNY')
    expect(canSubmitOf(wrapper)).toBe(true)
    wrapper.unmount()
  })

  it('多币种各自配平 → canSubmit=true；任一币种不平即 false', () => {
    const { wrapper } = mountRows(
      rows([
        [1, '-100.00', 'CNY'],
        [3, '100.00', 'CNY'],
        [2, '-10.00', 'USD'],
        [2, '10.00', 'USD'],
      ]),
    )
    expect(canSubmitOf(wrapper)).toBe(true)
    expect(wrapper.find('.js-check').text()).toContain('USD 差额')
    wrapper.unmount()

    const bad = mountRows(
      rows([
        [1, '-100.00', 'CNY'],
        [3, '100.00', 'CNY'],
        [2, '-10.00', 'USD'],
        [2, '9.00', 'USD'],
      ]),
    )
    expect(canSubmitOf(bad.wrapper)).toBe(false)
    bad.wrapper.unmount()
  })

  it('至少有 2 行：删除按钮在 2 行时不生效', async () => {
    const { wrapper } = mountRows(rows([[3, '1.00', 'CNY'], [1, '-1.00', 'CNY']]))
    await wrapper.find('[data-act="remove-row"]').trigger('click')
    expect(wrapper.emitted('update:rows')).toBeUndefined()
    expect(wrapper.findAll('.adv-row')).toHaveLength(2)
    wrapper.unmount()
  })

  it('bean 片段与 core/bean 生成结果逐字一致（无千分位）', () => {
    const initial = rows([[3, '128.50', 'CNY'], [1, '-128.50', 'CNY']])
    const { wrapper, bean } = mountRows(initial)
    expect(wrapper.find('.js-bean').text()).toBe(bean)
    expect(wrapper.find('.js-bean').text()).toContain('Expenses:Food 128.50 CNY')
    expect(bean).not.toMatch(/[0-9],[0-9]{3}/)
    wrapper.unmount()
  })
})

describe('AdvancedPostings：编辑态冲正口径', () => {
  it('editing=true：无「返回简化模式」链接，adv-note 为编辑态文案', () => {
    const { wrapper } = mountRows(rows([[3, '128.50', 'CNY'], [1, '-128.50', 'CNY']]), true)
    // 返回带类型 Tab 的简化编辑器会把类型暗示带回编辑态，必须隐藏。
    expect(wrapper.find('[data-act="back-simple"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('返回简化模式')
    const note = wrapper.find('.adv-note').text()
    expect(note).toContain('来自原交易')
    expect(note).toContain('冲正 + 新建（仅在线）')
    expect(note).not.toContain('沿用切换前填写的内容')
    wrapper.unmount()
  })

  it('editing=false：back-simple 存在，adv-note 保持原文案', () => {
    const { wrapper } = mountRows(rows([[3, '128.50', 'CNY'], [1, '-128.50', 'CNY']]), false)
    expect(wrapper.find('[data-act="back-simple"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('返回简化模式')
    const note = wrapper.find('.adv-note').text()
    expect(note).toContain('沿用切换前填写的内容')
    expect(note).toContain('幂等路径')
    expect(note).not.toContain('来自原交易')
    wrapper.unmount()
  })
})
