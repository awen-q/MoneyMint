/**
 * 分类聚合按 account id 的回归（B4 / T39）
 *
 * 核心命题：**同名子账户必须分成两行**。按显示名聚合时，两个都叫「餐饮」的子账户
 * 会被合并，环图 / 排行 / 柱状图三处数字同时错（多算或少算都看不出来）。
 */
import { describe, expect, it } from 'vitest'

import { categoryShares, type ReportTxn } from '@/core/reports'
import type { SummaryAccount } from '@/core/record'

const ACCOUNTS: SummaryAccount[] = [
  { id: 1, name: 'Assets:Cash', display_name: '现金', type: 'Assets' },
  // 两个同名不同 id 的分类账户 —— T39 要解决的正是这个场景
  { id: 10, name: 'Expenses:Food:A', display_name: '餐饮', type: 'Expenses' },
  { id: 11, name: 'Expenses:Food:B', display_name: '餐饮', type: 'Expenses' },
  { id: 20, name: 'Income:Salary', display_name: '工资', type: 'Income' },
]

function txn(id: number, date: string, postings: ReportTxn['postings']): ReportTxn {
  return { id, date, description: `t${id}`, created_by_name: '阿文', postings }
}

const TXNS: ReportTxn[] = [
  txn(1, '2026-11-01', [
    { account_id: 10, commodity: 'CNY', amount: '30.00' },
    { account_id: 1, commodity: 'CNY', amount: '-30.00' },
  ]),
  txn(2, '2026-11-02', [
    { account_id: 11, commodity: 'CNY', amount: '70.00' },
    { account_id: 1, commodity: 'CNY', amount: '-70.00' },
  ]),
  txn(3, '2026-11-03', [
    { account_id: 10, commodity: 'CNY', amount: '50.00' },
    { account_id: 1, commodity: 'CNY', amount: '-50.00' },
  ]),
  txn(4, '2026-11-04', [
    { account_id: 20, commodity: 'CNY', amount: '-900.00' },
    { account_id: 1, commodity: 'CNY', amount: '900.00' },
  ]),
  // 外币交易：CNY 口径下必须被隔离
  txn(5, '2026-11-05', [
    { account_id: 10, commodity: 'USD', amount: '9.00' },
    { account_id: 1, commodity: 'USD', amount: '-9.00' },
  ]),
]

describe('categoryShares：按 account id 聚合（T39）', () => {
  it('同名子账户分成两行，不合并', () => {
    const rows = categoryShares(TXNS, ACCOUNTS, 'CNY')
    expect(rows).toHaveLength(2)
    // 金额降序：id 11 的 70 在 id 10 的 80 之后 → 实际 id10=80(id 1+3)
    expect(rows.map((row) => row.id).sort((a, b) => Number(a) - Number(b))).toEqual([10, 11])
    const first = rows[0]
    expect(first.id).toBe(10)
    expect(first.amount).toBe('80.00')
    expect(first.count).toBe(2)
  })

  it('label 仍是展示名（既有字段语义未变）', () => {
    const rows = categoryShares(TXNS, ACCOUNTS, 'CNY')
    for (const row of rows) {
      expect(row.label).toBe('餐饮')
    }
  })

  it('count 是交易笔数（去重 txn），不是分录数', () => {
    const rows = categoryShares(TXNS, ACCOUNTS, 'CNY')
    const id10 = rows.find((row) => row.id === 10)
    expect(id10 === undefined ? -1 : id10.count).toBe(2)
  })

  it('kind 参数切换收入侧，并回填到每行', () => {
    const rows = categoryShares(TXNS, ACCOUNTS, 'CNY', 8, 'Income')
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('Income')
    expect(rows[0].id).toBe(20)
    expect(rows[0].label).toBe('工资')
    // 收入分录取反后为正（fava 口径）
    expect(rows[0].amount).toBe('900.00')
  })

  it('币种隔离：USD 交易不进 CNY 口径', () => {
    const rows = categoryShares(TXNS, ACCOUNTS, 'CNY')
    let total = 0
    for (const row of rows) {
      total += Number(row.amount)
    }
    expect(total).toBe(150)
    const usd = categoryShares(TXNS, ACCOUNTS, 'USD')
    expect(usd).toHaveLength(1)
    expect(usd[0].amount).toBe('9.00')
  })

  it('账户查不到的分录被排除（不是「未分类」行）—— 既有 matches 语义', () => {
    // `matches()` 要求 account 存在且 type 命中，因此未知 account_id 的分录
    // 在过滤阶段就被剔除。`id: null` 的「未分类」分支是防御性代码（当前不可达），
    // 这里把**真实行为**钉住，避免将来有人误以为会出一行「未分类」。
    const orphan = [txn(9, '2026-11-06', [{ account_id: 999, commodity: 'CNY', amount: '5.00' }])]
    const rows = categoryShares([...TXNS, ...orphan], ACCOUNTS, 'CNY')
    expect(rows.find((row) => row.id === null)).toBeUndefined()
    let total = 0
    for (const row of rows) {
      total += Number(row.amount)
    }
    expect(total).toBe(150)
  })

  it('既有三个字段仍齐备（ReportsView 到期前不能破）', () => {
    const rows = categoryShares(TXNS, ACCOUNTS, 'CNY')
    for (const row of rows) {
      expect(typeof row.label).toBe('string')
      expect(typeof row.amount).toBe('string')
      expect(typeof row.ratio).toBe('number')
      expect(row.ratio).toBeGreaterThanOrEqual(0)
      expect(row.ratio).toBeLessThanOrEqual(1)
    }
  })
})
