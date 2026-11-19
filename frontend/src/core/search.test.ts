/**
 * 搜索页聚合层回归（B3）
 *
 * 锁死四类容易漂移的口径：
 * 1. 分币种汇总**禁跨币种求和**（无 total 字段），且排序按币种字典序（稳定维度）；
 * 2. 归零粒度与 `bill.ts` 一致 —— 按（日期 × 币种）归零后再合并，有交叉断言。
 *
 * 关键词匹配（原第 3、4 条）已随 T38 下推服务端并从本文件移除。
 */
import { describe, expect, it } from 'vitest'

import { summaryByCommodity } from '@/core/search'
import { monthTotals } from '@/core/bill'
import type { AccountView, PostingView, TransactionView } from '@/api/types'

const BANK: AccountView = {
  id: 1,
  name: 'Assets:Bank',
  display_name: '银行卡',
  uuid: 'uuid-1',
  type: 'Assets',
  open_date: '2026-01-01',
  sort_order: 1,
}
const FOOD: AccountView = {
  id: 2,
  name: 'Expenses:Food',
  display_name: '餐饮',
  uuid: 'uuid-2',
  type: 'Expenses',
  open_date: '2026-01-01',
  sort_order: 2,
}
const SALARY: AccountView = {
  id: 3,
  name: 'Income:Salary',
  display_name: '工资',
  uuid: 'uuid-3',
  type: 'Income',
  open_date: '2026-01-01',
  sort_order: 3,
}
const ACCOUNTS: AccountView[] = [BANK, FOOD, SALARY]

function posting(accountId: number, account: string, amount: string, commodity = 'CNY'): PostingView {
  return { account_id: accountId, account, commodity, amount }
}

function makeTxn(
  id: number,
  date: string,
  postings: PostingView[],
  overrides: Partial<TransactionView> = {},
): TransactionView {
  return {
    id,
    uuid: `uuid-txn-${id}`,
    date,
    flag: '*',
    description: `交易${id}`,
    created_by_name: '阿文',
    postings,
    ...overrides,
  }
}

/** 支出：Expenses 借方正、Assets 贷方负。 */
function expenseTxn(
  id: number,
  date: string,
  amount: string,
  commodity = 'CNY',
  description = `支出${id}`,
): TransactionView {
  return makeTxn(
    id,
    date,
    [
      posting(2, 'Expenses:Food', amount, commodity),
      posting(1, 'Assets:Bank', `-${amount}`, commodity),
    ],
    { description },
  )
}

/** 收入：Assets 借方正、Income 贷方负。 */
function incomeTxn(
  id: number,
  date: string,
  amount: string,
  commodity = 'CNY',
): TransactionView {
  return makeTxn(
    id,
    date,
    [
      posting(1, 'Assets:Bank', amount, commodity),
      posting(3, 'Income:Salary', `-${amount}`, commodity),
    ],
    { description: `收入${id}` },
  )
}

describe('summaryByCommodity', () => {
  it('空输入返回 []', () => {
    expect(summaryByCommodity([])).toEqual([])
  })

  it('单币种单笔支出：count 1、expense 为该值、income 0.00', () => {
    const rows = summaryByCommodity([expenseTxn(1, '2026-11-10', '25.50')])
    expect(rows).toHaveLength(1)
    expect(rows[0].commodity).toBe('CNY')
    expect(rows[0].expense).toBe('25.50')
    expect(rows[0].income).toBe('0.00')
    expect(rows[0].count).toBe(1)
  })

  it('CNY + USD 混合：两行、各自金额正确、无 total 字段', () => {
    const rows = summaryByCommodity([
      expenseTxn(1, '2026-11-10', '100.00', 'CNY'),
      expenseTxn(2, '2026-11-10', '50.00', 'USD'),
      incomeTxn(3, '2026-11-11', '20.00', 'USD'),
    ])
    expect(rows).toHaveLength(2)
    const cny = rows[0].commodity === 'CNY' ? rows[0] : rows[1]
    const usd = rows[0].commodity === 'USD' ? rows[0] : rows[1]
    expect(cny).toEqual({ commodity: 'CNY', income: '0.00', expense: '100.00', count: 1 })
    expect(usd).toEqual({ commodity: 'USD', income: '20.00', expense: '50.00', count: 2 })
    // 禁跨币种求和：不得出现任何形式的合计字段
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['commodity', 'count', 'expense', 'income'])
    }
  })

  it('排序按币种字典序，与输入顺序无关', () => {
    const rows = summaryByCommodity([
      expenseTxn(1, '2026-11-10', '10.00', 'USD'),
      expenseTxn(2, '2026-11-10', '10.00', 'JPY'),
      expenseTxn(3, '2026-11-10', '10.00', 'CNY'),
    ])
    expect(rows.map((row) => row.commodity)).toEqual(['CNY', 'JPY', 'USD'])
  })

  it('转账计入 count 但不计入金额', () => {
    const transfer = makeTxn(1, '2026-11-10', [
      posting(1, 'Assets:Bank', '-100.00'),
      posting(9, 'Assets:Cash', '100.00'),
    ])
    const rows = summaryByCommodity([transfer])
    expect(rows).toHaveLength(1)
    expect(rows[0].count).toBe(1)
    expect(rows[0].expense).toBe('0.00')
    expect(rows[0].income).toBe('0.00')
  })

  it('退款（负 Expenses）不产生负 expense', () => {
    const txns: TransactionView[] = [
      expenseTxn(1, '2026-11-10', '100.00'),
      // 同一天退款 30 → 净 70
      makeTxn(2, '2026-11-10', [
        posting(2, 'Expenses:Food', '-30.00'),
        posting(1, 'Assets:Bank', '30.00'),
      ]),
    ]
    expect(summaryByCommodity(txns)[0].expense).toBe('70.00')

    // 纯退款日：净额为负 → 按展示口径归零
    const refundOnly = summaryByCommodity([
      makeTxn(3, '2026-11-12', [
        posting(2, 'Expenses:Food', '-50.00'),
        posting(1, 'Assets:Bank', '50.00'),
      ]),
    ])
    expect(refundOnly[0].expense).toBe('0.00')
  })

  it('与 bill.monthTotals 同口径：同一份输入的费用 / 收入 / 笔数一致', () => {
    const txns: TransactionView[] = [
      expenseTxn(1, '2026-11-01', '10.00'),
      expenseTxn(2, '2026-11-01', '2.50'),
      incomeTxn(3, '2026-11-02', '1800.00'),
      // 纯退款日：bill 与 search 都必须按 0 计
      makeTxn(4, '2026-11-03', [
        posting(2, 'Expenses:Food', '-50.00'),
        posting(1, 'Assets:Bank', '50.00'),
      ]),
    ]
    const rows = summaryByCommodity(txns)
    const totals = monthTotals(txns, 'CNY')
    expect(rows[0].expense).toBe(totals.expense)
    expect(rows[0].income).toBe(totals.income)
    expect(rows[0].count).toBe(totals.count)
  })

  it('同一笔多分录只算 1 笔；多币种交易在每个币种各算 1 笔', () => {
    const multi = makeTxn(1, '2026-11-10', [
      posting(2, 'Expenses:Food', '10.00', 'CNY'),
      posting(2, 'Expenses:Food', '5.00', 'CNY'),
      posting(1, 'Assets:Bank', '-10.00', 'CNY'),
      posting(1, 'Assets:Bank', '-5.00', 'CNY'),
    ])
    const rows = summaryByCommodity([multi])
    expect(rows).toHaveLength(1)
    expect(rows[0].count).toBe(1)
    expect(rows[0].expense).toBe('15.00')

    const crossCurrency = makeTxn(2, '2026-11-10', [
      posting(2, 'Expenses:Food', '10.00', 'CNY'),
      posting(2, 'Expenses:Food', '2.00', 'USD'),
    ])
    const mixed = summaryByCommodity([crossCurrency])
    expect(mixed.map((row) => row.commodity)).toEqual(['CNY', 'USD'])
    expect(mixed[0].count).toBe(1)
    expect(mixed[1].count).toBe(1)
  })

  it('非法金额按 0 处理，不污染汇总', () => {
    const txn = makeTxn(1, '2026-11-10', [
      posting(2, 'Expenses:Food', 'abc'),
      posting(2, 'Expenses:Food', '10.00'),
      posting(1, 'Assets:Bank', '-10.00'),
    ])
    expect(summaryByCommodity([txn])[0].expense).toBe('10.00')
  })
})
