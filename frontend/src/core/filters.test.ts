/**
 * 筛选 query 化用例（AC-16：写 / 读往返还原、非法值容错、筛选应用）
 */
import { describe, expect, it } from 'vitest'

import { applyFilters, emptyFilters, filtersFromQuery, filtersToQuery, hasActiveFilters } from './filters'
import type { SummaryAccount } from './record'

const accounts: SummaryAccount[] = [
  { id: 1, name: 'Assets:Cash', display_name: '招商储蓄', type: 'Assets' },
  { id: 2, name: 'Assets:Bank', display_name: '工商银行', type: 'Assets' },
  { id: 4, name: 'Expenses:Food', display_name: '食品饮料', type: 'Expenses' },
  { id: 5, name: 'Income:Salary', display_name: '薪资收入', type: 'Income' },
]

const txns = [
  {
    id: 1,
    date: '2026-11-09',
    flag: '*',
    description: '午餐',
    created_by_name: '阿文',
    postings: [
      { account_id: 4, amount: '38.50' },
      { account_id: 1, amount: '-38.50' },
    ],
  },
  {
    id: 2,
    date: '2026-11-01',
    flag: '*',
    description: '十月工资',
    created_by_name: '太太',
    postings: [
      { account_id: 5, amount: '-9500.00' },
      { account_id: 2, amount: '9500.00' },
    ],
  },
  {
    id: 3,
    date: '2026-11-05',
    flag: '*',
    description: '转账',
    created_by_name: '阿文',
    postings: [
      { account_id: 1, amount: '-2000.00' },
      { account_id: 2, amount: '2000.00' },
    ],
  },
]

describe('筛选 query 化（AC-16）', () => {
  it('写 / 读往返还原：全部字段都进 query 并能完整还原', () => {
    const filters = {
      from: '2026-11-01',
      to: '2026-11-09',
      kind: 'transfer' as const,
      account: 2,
      category: 4,
      member: '阿文',
      keyword: '火锅',
    }
    const query = filtersToQuery(filters)
    expect(query).toEqual({
      from: '2026-11-01',
      to: '2026-11-09',
      kind: 'transfer',
      account: '2',
      category: '4',
      member: '阿文',
      q: '火锅',
    })
    expect(filtersFromQuery(query)).toEqual(filters)
  })

  it('空筛选产出干净 query（空值省略），还原回默认值', () => {
    const filters = emptyFilters()
    expect(filtersToQuery(filters)).toEqual({})
    expect(filtersFromQuery({})).toEqual(filters)
    expect(hasActiveFilters(filters)).toBe(false)
  })

  it('非法值容错：坏日期 / 坏枚举 / 坏 id 一律回退默认，不抛错', () => {
    const restored = filtersFromQuery({
      from: '2026/11/01',
      to: 'not-a-date',
      kind: 'hack',
      account: '-3',
      category: 'abc',
    })
    expect(restored).toEqual(emptyFilters())
  })

  it('vue-router 数组形状的 query 取第一个值', () => {
    expect(filtersFromQuery({ member: ['阿文', '太太'] }).member).toBe('阿文')
    expect(filtersFromQuery({ account: ['2', '9'] }).account).toBe(2)
  })

  it('hasActiveFilters 随任一字段生效而变化', () => {
    const filters = emptyFilters()
    filters.kind = 'expense'
    expect(hasActiveFilters(filters)).toBe(true)
    filters.kind = 'all'
    filters.from = '2026-11-01'
    expect(hasActiveFilters(filters)).toBe(true)
  })
})

describe('关键词（B3）：query 化与激活判定', () => {
  it('hasActiveFilters：有关键词为 true，纯空格为 false', () => {
    expect(hasActiveFilters({ ...emptyFilters(), keyword: '火锅' })).toBe(true)
    // 纯空格不算激活：否则敲一个空格就冒出「清除筛选」按钮
    expect(hasActiveFilters({ ...emptyFilters(), keyword: '   ' })).toBe(false)
    expect(hasActiveFilters({ ...emptyFilters(), keyword: '' })).toBe(false)
  })

  it('query 往返：keyword → ?q=火锅 → 读回原值', () => {
    const filters = { ...emptyFilters(), keyword: '火锅' }
    const query = filtersToQuery(filters)
    expect(query).toEqual({ q: '火锅' })
    expect(filtersFromQuery(query).keyword).toBe('火锅')
  })

  it('空关键词不出现在 query 里（URL 保持干净）', () => {
    expect(filtersToQuery(emptyFilters())).not.toHaveProperty('q')
    // 纯空格同样不写出，与 hasActiveFilters 的 trim 判据保持一致
    expect(filtersToQuery({ ...emptyFilters(), keyword: '   ' })).not.toHaveProperty('q')
  })

  it('q 缺失 / 数组形状 / 空串一律回退默认值', () => {
    expect(filtersFromQuery({}).keyword).toBe('')
    expect(filtersFromQuery({ q: ['火锅', '烤肉'] }).keyword).toBe('火锅')
    expect(filtersFromQuery({ q: '' }).keyword).toBe('')
  })
})

describe('关键词过滤（B3）：applyFilters 真的接上了', () => {
  it('命中备注 → 只留命中的那条', () => {
    const result = applyFilters(txns, { ...emptyFilters(), keyword: '午餐' }, accounts)
    expect(result.map((txn) => txn.id)).toEqual([1])
  })

  it('命中账户展示名（传 SummaryAccount，证明 A 方案解决了两种账户型的赋值问题）', () => {
    // 「工商银行」只在 accounts[1].display_name 里出现，交易里没有这个字符串。
    const result = applyFilters(txns, { ...emptyFilters(), keyword: '招商' }, accounts)
    expect(result.map((txn) => txn.id)).toEqual([1, 3])
  })

  it('空关键词幂等：与不带 keyword 时返回同一批 id（不只是条数相同）', () => {
    const baseline = applyFilters(txns, emptyFilters(), accounts)
    const withEmpty = applyFilters(txns, { ...emptyFilters(), keyword: '' }, accounts)
    expect(withEmpty.map((txn) => txn.id)).toEqual(baseline.map((txn) => txn.id))
  })

  it('纯空格等同空关键词（与 hasActiveFilters 的 trim 口径一致）', () => {
    const baseline = applyFilters(txns, emptyFilters(), accounts)
    const withBlank = applyFilters(txns, { ...emptyFilters(), keyword: '   ' }, accounts)
    expect(withBlank.map((txn) => txn.id)).toEqual(baseline.map((txn) => txn.id))
  })

  it('负例：不存在的关键词 → 0 条（前四条全绿也不能证明过滤接上了）', () => {
    const result = applyFilters(txns, { ...emptyFilters(), keyword: '绝不存在的词' }, accounts)
    expect(result).toHaveLength(0)
  })
})

describe('筛选应用', () => {
  it('日期范围（字典序含端点）', () => {
    const result = applyFilters(txns, { ...emptyFilters(), from: '2026-11-01', to: '2026-11-05' }, accounts)
    expect(result.map((txn) => txn.id)).toEqual([2, 3])
  })

  it('kind 判定与首页口径一致（转账 / 支出 / 收入）', () => {
    expect(applyFilters(txns, { ...emptyFilters(), kind: 'transfer' }, accounts).map((t) => t.id)).toEqual([3])
    expect(applyFilters(txns, { ...emptyFilters(), kind: 'expense' }, accounts).map((t) => t.id)).toEqual([1])
    expect(applyFilters(txns, { ...emptyFilters(), kind: 'income' }, accounts).map((t) => t.id)).toEqual([2])
  })

  it('账户 / 分类命中任一分录即保留；成员精确匹配', () => {
    expect(applyFilters(txns, { ...emptyFilters(), account: 2 }, accounts).map((t) => t.id)).toEqual([2, 3])
    expect(applyFilters(txns, { ...emptyFilters(), category: 4 }, accounts).map((t) => t.id)).toEqual([1])
    expect(applyFilters(txns, { ...emptyFilters(), member: '太太' }, accounts).map((t) => t.id)).toEqual([2])
  })
})

describe('批 2.5：kind 分录命中（三分法降级）', () => {
  // 退款类混合交易：Expenses -50（冲回）+ Income -30 + Assets +80。
  const refund = {
    id: 9,
    date: '2026-11-10',
    flag: '*',
    description: '退款+报销',
    created_by_name: '阿文',
    postings: [
      { account_id: 4, amount: '-50.00' }, // Expenses（负，冲回）
      { account_id: 5, amount: '-30.00' }, // Income
      { account_id: 2, amount: '80.00' },  // Assets
    ],
  }

  it('kind=expense / income 均按分录命中：混合交易同时命中两类筛选', () => {
    expect(
      applyFilters([refund], { ...emptyFilters(), kind: 'expense' }, accounts).map((t) => t.id),
    ).toEqual([9])
    expect(
      applyFilters([refund], { ...emptyFilters(), kind: 'income' }, accounts).map((t) => t.id),
    ).toEqual([9])
  })

  it('kind=transfer 维持全资金分录整笔判定：混合交易不命中', () => {
    expect(
      applyFilters([refund], { ...emptyFilters(), kind: 'transfer' }, accounts),
    ).toEqual([])
  })

  it('kind=all 下混合交易与期初（Equity）交易均可见', () => {
    const opening = {
      id: 10,
      date: '2026-11-11',
      flag: '*',
      description: '期初',
      created_by_name: 'owner',
      postings: [
        { account_id: 6, amount: '12500.00' }, // Equity（accounts 里无 → 未知类型回退，模拟足够）
        { account_id: 1, amount: '12500.00' },
      ],
    }
    const all = applyFilters([refund, opening], emptyFilters(), accounts)
    expect(all.map((t) => t.id)).toEqual([9, 10])
    // 期初交易不含 Expenses/Income/全资金 → 不命中 expense/income/transfer 任一筛选。
    expect(applyFilters([opening], { ...emptyFilters(), kind: 'expense' }, accounts)).toEqual([])
    expect(applyFilters([opening], { ...emptyFilters(), kind: 'income' }, accounts)).toEqual([])
    expect(applyFilters([opening], { ...emptyFilters(), kind: 'transfer' }, accounts)).toEqual([])
  })
})
