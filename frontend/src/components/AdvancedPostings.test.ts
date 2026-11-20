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

describe('AdvancedPostings：借贷方向 Toggle / 翻转 / 带符号往返（v2）', () => {
  it('点「贷」→ emit 带符号 amount，金额框只显示正数、符号提示为 −', async () => {
    const { wrapper } = mountRows(rows([[3, '38.50', 'CNY'], [1, '-38.50', 'CNY']]))
    const credit = wrapper.findAll('.adv-row')[0].find('[data-dir="credit"]')
    expect(credit.attributes('aria-pressed')).toBe('false')
    await credit.trigger('click')
    await flushPromises()

    const next = (wrapper.emitted('update:rows')?.[0]?.[0] ?? []) as AdvancedRow[]
    expect(next[0].amount).toBe('-38.50')
    const row = wrapper.findAll('.adv-row')[0]
    expect((row.find('[data-rf="amt"]').element as HTMLInputElement).value).toBe('38.50')
    expect(row.find('.sign-hint').text()).toBe('−')
    expect(row.find('[data-rf="amt"]').attributes('inputmode')).toBe('decimal')
    wrapper.unmount()
  })

  it('点「＋/−」→ 方向翻转，38.50 ⇄ -38.50 往返一致', async () => {
    const { wrapper } = mountRows(rows([[3, '38.50', 'CNY'], [1, '-38.50', 'CNY']]))
    await wrapper.findAll('.adv-row')[0].find('[data-act="flip"]').trigger('click')
    let next = (wrapper.emitted('update:rows')?.slice(-1)[0]?.[0] ?? []) as AdvancedRow[]
    expect(next[0].amount).toBe('-38.50')

    await wrapper.findAll('.adv-row')[0].find('[data-act="flip"]').trigger('click')
    next = (wrapper.emitted('update:rows')?.slice(-1)[0]?.[0] ?? []) as AdvancedRow[]
    expect(next[0].amount).toBe('38.50')
    wrapper.unmount()
  })

  it('粘贴带符号 -38.50 → 方向自动变贷，amount 保持带负号', async () => {
    const { wrapper } = mountRows(rows([[3, '38.50', 'CNY'], [1, '-38.50', 'CNY']]))
    await wrapper.findAll('.adv-row')[0].find('[data-rf="amt"]').setValue('-38.50')
    await flushPromises()

    const next = (wrapper.emitted('update:rows')?.slice(-1)[0]?.[0] ?? []) as AdvancedRow[]
    expect(next[0].amount).toBe('-38.50')
    const row = wrapper.findAll('.adv-row')[0]
    expect(row.find('.sign-hint').text()).toBe('−')
    expect(row.find('[data-dir="credit"]').attributes('aria-pressed')).toBe('true')
    wrapper.unmount()
  })

  it('编辑态 + 负 amount：无「返回简化模式」且方向显示贷', () => {
    const { wrapper } = mountRows(rows([[3, '-38.50', 'CNY'], [1, '38.50', 'CNY']]), true)
    expect(wrapper.find('[data-act="back-simple"]').exists()).toBe(false)
    const row = wrapper.findAll('.adv-row')[0]
    expect(row.find('.sign-hint').text()).toBe('−')
    expect(row.find('[data-dir="credit"]').attributes('aria-pressed')).toBe('true')
    wrapper.unmount()
  })

  it('magnitude 保真：输入 `12.` 原样写入 amount，不被规范化', async () => {
    const { wrapper } = mountRows(rows([[3, '0.00', 'CNY'], [1, '0.00', 'CNY']]))
    await wrapper.findAll('.adv-row')[0].find('[data-rf="amt"]').setValue('12.')
    await flushPromises()

    const next = (wrapper.emitted('update:rows')?.slice(-1)[0]?.[0] ?? []) as AdvancedRow[]
    expect(next[0].amount).toBe('12.')
    expect(
      (wrapper.findAll('.adv-row')[0].find('[data-rf="amt"]').element as HTMLInputElement).value,
    ).toBe('12.')
    wrapper.unmount()
  })
})

describe('AdvancedPostings：新增分录空值不崩溃', () => {
  it('新增行清空金额 → emit 空串（非裸 "-"），输入框为空且 canSubmit=false', async () => {
    const { wrapper } = mountRows(rows([[3, '38.50', 'CNY'], [1, '-38.50', 'CNY']]))
    await wrapper.find('[data-act="add-row"]').trigger('click')
    await flushPromises()
    await wrapper.findAll('.adv-row')[2].find('[data-rf="amt"]').setValue('')
    await flushPromises()

    const next = (wrapper.emitted('update:rows')?.slice(-1)[0]?.[0] ?? []) as AdvancedRow[]
    expect(next[2].amount).toBe('')
    expect(
      (wrapper.findAll('.adv-row')[2].find('[data-rf="amt"]').element as HTMLInputElement).value,
    ).toBe('')
    expect(canSubmitOf(wrapper)).toBe(false)
    wrapper.unmount()
  })

  it('新增行清空金额后再点「贷」→ amount 仍为空串，不写入非法裸 "-"', async () => {
    const { wrapper } = mountRows(rows([[3, '38.50', 'CNY'], [1, '-38.50', 'CNY']]))
    await wrapper.find('[data-act="add-row"]').trigger('click')
    await flushPromises()
    await wrapper.findAll('.adv-row')[2].find('[data-rf="amt"]').setValue('')
    await flushPromises()
    await wrapper.findAll('.adv-row')[2].find('[data-dir="credit"]').trigger('click')
    await flushPromises()

    const next = (wrapper.emitted('update:rows')?.slice(-1)[0]?.[0] ?? []) as AdvancedRow[]
    expect(next[2].amount).toBe('')
    expect(
      (wrapper.findAll('.adv-row')[2].find('[data-rf="amt"]').element as HTMLInputElement).value,
    ).toBe('')
    expect(canSubmitOf(wrapper)).toBe(false)
    wrapper.unmount()
  })

  it('旧草稿 amount=undefined → 边界归一化为空串，渲染不抛 TypeError', () => {
    const broken = [
      { accountId: 1, amount: undefined as unknown as string, commodity: 'CNY' },
      { accountId: 3, amount: '1.00', commodity: 'CNY' },
    ]
    const wrapper = mount(AdvancedPostings, {
      props: { rows: broken, accounts: ACCOUNTS, commodities: ['CNY', 'USD'], bean: '预览' },
    })
    expect(
      (wrapper.findAll('.adv-row')[0].find('[data-rf="amt"]').element as HTMLInputElement).value,
    ).toBe('')
    expect(canSubmitOf(wrapper)).toBe(false)
    wrapper.unmount()
  })
})
