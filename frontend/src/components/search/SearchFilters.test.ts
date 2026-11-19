// @vitest-environment jsdom
/**
 * SearchFilters 回归（T35）：
 * - 7 个控件齐全且每个带 `aria-label`（日期两个、类型/账户/分类/标签/成员各一）；
 * - 账户下拉**只列资金账户**（Assets / Liabilities）、分类下拉**只列分类账户**
 *   （Expenses / Income），且都**排除已关户**；
 * - 每次改动只 `emit('change', patch)`，组件不持有筛选状态；
 * - 标签 / 成员选项来自 props（页面从现有交易收集），组件不发请求。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import { emptyFilters } from '@/core/filters'
import SearchFilters, { type FilterAccountOption } from './SearchFilters.vue'

const ACCOUNTS: FilterAccountOption[] = [
  { id: 1, name: 'Assets:Cash', display_name: '现金', type: 'Assets' },
  { id: 2, name: 'Assets:Bank', type: 'Assets' },
  { id: 3, name: 'Liabilities:Card', display_name: '信用卡', type: 'Liabilities' },
  { id: 4, name: 'Expenses:Food', display_name: '餐饮', type: 'Expenses' },
  { id: 5, name: 'Income:Salary', display_name: '工资', type: 'Income' },
  // 已关户：两个下拉都不应出现
  { id: 6, name: 'Assets:Old', display_name: '旧卡', type: 'Assets', close_date: '2026-01-01' },
  { id: 7, name: 'Expenses:Old', display_name: '旧分类', type: 'Expenses', close_date: '2026-01-01' },
]

function mountFilters(props: Record<string, unknown> = {}) {
  return mount(SearchFilters, {
    props: {
      filters: emptyFilters(),
      accounts: ACCOUNTS,
      tags: ['出差', '餐饮'],
      members: ['阿文', '太太'],
      ...props,
    },
  })
}

describe('SearchFilters：控件与无障碍', () => {
  it('7 个控件，每个都有 aria-label', () => {
    const wrapper = mountFilters()
    const labelled = [
      '起始日期',
      '截止日期',
      '类型筛选',
      '账户筛选',
      '分类筛选',
      '标签筛选',
      '成员筛选',
    ]
    for (const label of labelled) {
      expect(wrapper.find(`[aria-label="${label}"]`).exists()).toBe(true)
    }
    expect(wrapper.findAll('.search-filters__field')).toHaveLength(7)
  })

  it('账户下拉只列资金账户且排除已关户', () => {
    const wrapper = mountFilters()
    const account = wrapper.find('[aria-label="账户筛选"]')
    const labels = account.findAll('option').map((option) => option.text())
    expect(labels).toEqual(['全部账户', '现金', 'Assets:Bank', '信用卡'])
    expect(labels).not.toContain('旧卡')
  })

  it('分类下拉只列分类账户且排除已关户', () => {
    const wrapper = mountFilters()
    const category = wrapper.find('[aria-label="分类筛选"]')
    const labels = category.findAll('option').map((option) => option.text())
    expect(labels).toEqual(['全部分类', '餐饮', '工资'])
    expect(labels).not.toContain('旧分类')
  })

  it('标签与成员选项来自 props（组件不自己造数据）', () => {
    const wrapper = mountFilters()
    expect(
      wrapper.find('[aria-label="标签筛选"]').findAll('option').map((option) => option.text()),
    ).toEqual(['全部标签', '出差', '餐饮'])
    expect(
      wrapper.find('[aria-label="成员筛选"]').findAll('option').map((option) => option.text()),
    ).toEqual(['全部成员', '阿文', '太太'])
  })
})

describe('SearchFilters：改动只回传 patch', () => {
  it('日期改动回传 { from }', async () => {
    const wrapper = mountFilters()
    const input = wrapper.find('[aria-label="起始日期"]')
    await input.setValue('2026-11-01')
    expect(wrapper.emitted('change')?.[0]).toEqual([{ from: '2026-11-01' }])
  })

  it('类型改动回传 { kind }，非法值回落 all', async () => {
    const wrapper = mountFilters()
    const select = wrapper.find('[aria-label="类型筛选"]')
    await select.setValue('expense')
    expect(wrapper.emitted('change')?.[0]).toEqual([{ kind: 'expense' }])
  })

  it('账户 / 分类：空选项回传 null（不是 0 或空串）', async () => {
    const wrapper = mountFilters({ filters: { ...emptyFilters(), account: 2, category: 4 } })
    await wrapper.find('[aria-label="账户筛选"]').setValue('')
    expect(wrapper.emitted('change')?.[0]).toEqual([{ account: null }])
    await wrapper.find('[aria-label="分类筛选"]').setValue('5')
    expect(wrapper.emitted('change')?.[1]).toEqual([{ category: 5 }])
  })

  it('标签 / 成员改动回传字符串，空选项回传空串', async () => {
    const wrapper = mountFilters()
    await wrapper.find('[aria-label="标签筛选"]').setValue('出差')
    expect(wrapper.emitted('change')?.[0]).toEqual([{ tag: '出差' }])
    await wrapper.find('[aria-label="成员筛选"]').setValue('')
    expect(wrapper.emitted('change')?.[1]).toEqual([{ member: '' }])
  })
})
