/**
 * 统计账单聚合回归（B4 / T40）
 *
 * 锁死四件事：
 * 1. 日均分母是**已过天数**（月初记 100 块，日均就该是 100，不是 3.3）；
 * 2. **未来月**日均 `0.00` + `applicable=false`，绝不泄漏 `NaN` / `Infinity`；
 * 3. **「未打标签」是正常的桶**（否则各标签占比之和 < 100%，用户会以为算错）；
 * 4. 逐日加总 === 月合计（同一份口径的两条路径必须勾稽）。
 */
import { describe, expect, it } from 'vitest'

import { averagePerDay, dailyRows, statsTotals, tagShares, txnCount, UNTAGGED_LABEL } from '@/core/stats'
import type { ReportTxn } from '@/core/reports'
import type { SummaryAccount } from '@/core/record'

const ACCOUNTS: SummaryAccount[] = [
  { id: 1, name: 'Assets:Cash', display_name: '现金', type: 'Assets' },
  { id: 10, name: 'Expenses:Food', display_name: '餐饮', type: 'Expenses' },
  { id: 11, name: 'Expenses:Car', display_name: '交通', type: 'Expenses' },
  { id: 20, name: 'Income:Salary', display_name: '工资', type: 'Income' },
]

function txn(
  id: number,
  date: string,
  description: string,
  postings: ReportTxn['postings'],
  tags?: string[],
): ReportTxn {
  const out: ReportTxn = { id, date, description, created_by_name: '阿文', postings }
  if (tags !== undefined) {
    out.tags = tags
  }
  return out
}

function expense(id: number, date: string, amount: string, accountId = 10, tags?: string[]): ReportTxn {
  return txn(id, date, `支出${id}`, [
    { account_id: accountId, commodity: 'CNY', amount },
    { account_id: 1, commodity: 'CNY', amount: `-${amount}` },
  ], tags)
}

function income(id: number, date: string, amount: string, tags?: string[]): ReportTxn {
  return txn(id, date, `收入${id}`, [
    { account_id: 1, commodity: 'CNY', amount },
    { account_id: 20, commodity: 'CNY', amount: `-${amount}` },
  ], tags)
}

const TXNS: ReportTxn[] = [
  expense(1, '2026-11-01', '100.00', 10, ['家庭']),
  expense(2, '2026-11-01', '50.00', 11, ['通勤']),
  income(3, '2026-11-02', '900.00', ['工资']),
  expense(4, '2026-11-05', '30.00'), // 无标签 → 「未打标签」桶
  // 转账：无收支分录，不进标签桶、但计入笔数
  txn(5, '2026-11-05', '搬钱', [
    { account_id: 1, commodity: 'CNY', amount: '-200.00' },
    { account_id: 1, commodity: 'CNY', amount: '200.00' },
  ]),
]

describe('statsTotals：收入 / 支出 / 结余 / 笔数', () => {
  it('四件套口径（笔数含转账，与账单页一致）', () => {
    const totals = statsTotals(TXNS, ACCOUNTS, 'CNY')
    expect(totals.expense).toBe('180.00')
    expect(totals.income).toBe('900.00')
    expect(totals.balance).toBe('720.00')
    expect(totals.count).toBe(5)
  })

  it('币种隔离：USD 交易不混进 CNY', () => {
    const usd = txn(9, '2026-11-06', '外币', [
      { account_id: 10, commodity: 'USD', amount: '9.00' },
      { account_id: 1, commodity: 'USD', amount: '-9.00' },
    ])
    const cny = statsTotals([...TXNS, usd], ACCOUNTS, 'CNY')
    expect(cny.expense).toBe('180.00')
    expect(cny.count).toBe(5)
    const usdTotals = statsTotals([...TXNS, usd], ACCOUNTS, 'USD')
    expect(usdTotals.expense).toBe('9.00')
    expect(usdTotals.count).toBe(1)
  })

  it('txnCount 去重交易（多分录只算 1 笔）', () => {
    expect(txnCount([TXNS[0]], 'CNY')).toBe(1)
  })
})

describe('averagePerDay：分母是已过天数', () => {
  it('月初记 100 块，日均就是 100（不是 100/30）', () => {
    const totals = statsTotals([expense(1, '2026-11-01', '100.00')], ACCOUNTS, 'CNY')
    const avg = averagePerDay(totals, 1)
    expect(avg.expense).toBe('100.00')
    expect(avg.applicable).toBe(true)
    expect(avg.elapsedDays).toBe(1)
  })

  it('未来月（elapsedDays=0）→ 0.00 + applicable=false，不产生 NaN/Infinity', () => {
    const totals = statsTotals(TXNS, ACCOUNTS, 'CNY')
    const avg = averagePerDay(totals, 0)
    expect(avg.expense).toBe('0.00')
    expect(avg.income).toBe('0.00')
    expect(avg.balance).toBe('0.00')
    expect(avg.applicable).toBe(false)
    expect(avg.expense).not.toContain('NaN')
    expect(avg.expense).not.toContain('Infinity')
    // 笔数不是比值，原样保留
    expect(avg.count).toBe(totals.count)
  })

  it('非法分母（NaN / 负数）同样退化为不可用，而不是抛出', () => {
    const totals = statsTotals(TXNS, ACCOUNTS, 'CNY')
    expect(averagePerDay(totals, Number.NaN).applicable).toBe(false)
    expect(averagePerDay(totals, -3).applicable).toBe(false)
  })

  it('往月按整月天数折算（31 天）', () => {
    const totals = statsTotals([expense(1, '2026-10-01', '310.00')], ACCOUNTS, 'CNY')
    expect(averagePerDay(totals, 31).expense).toBe('10.00')
  })
})

describe('dailyRows：每日明细表', () => {
  const today = new Date(2026, 10, 10) // 2026-11-10

  it('恒为整月天数，逐日给出收入 / 支出 / 结余', () => {
    const table = dailyRows(TXNS, ACCOUNTS, 2026, 11, 'CNY', today)
    expect(table.rows).toHaveLength(30)
    expect(table.rows[0]).toEqual({
      day: 1,
      date: '2026-11-01',
      income: '0.00',
      expense: '150.00',
      balance: '-150.00',
      hasData: true,
      count: 2,
    })
    expect(table.rows[1].income).toBe('900.00')
    expect(table.rows[1].balance).toBe('900.00')
    // 无交易日：hasData=false（展示「—」而不是 ¥0.00）
    expect(table.rows[2].hasData).toBe(false)
  })

  it('总计在卡头（total），日均在 tfoot（average），两者同源', () => {
    const table = dailyRows(TXNS, ACCOUNTS, 2026, 11, 'CNY', today)
    expect(table.total.expense).toBe('180.00')
    expect(table.total.income).toBe('900.00')
    expect(table.total.balance).toBe('720.00')
    expect(table.elapsedDays).toBe(10)
    expect(table.isCurrentMonth).toBe(true)
    expect(table.average.expense).toBe('18.00') // 180 / 10
    expect(table.average.income).toBe('90.00') // 900 / 10
  })

  it('勾稽：逐日加总 === 月合计（字符串逐分累加，不做浮点求和）', () => {
    const table = dailyRows(TXNS, ACCOUNTS, 2026, 11, 'CNY', today)
    let expenseCents = 0
    let incomeCents = 0
    let count = 0
    for (const row of table.rows) {
      expenseCents += Math.round(Number(row.expense) * 100)
      incomeCents += Math.round(Number(row.income) * 100)
      count += row.count
    }
    expect(expenseCents).toBe(Math.round(Number(table.total.expense) * 100))
    expect(incomeCents).toBe(Math.round(Number(table.total.income) * 100))
    expect(count).toBe(table.total.count)
  })

  it('往月：elapsedDays = 整月天数，isCurrentMonth=false', () => {
    const table = dailyRows([expense(1, '2026-10-05', '310.00')], ACCOUNTS, 2026, 10, 'CNY', today)
    expect(table.rows).toHaveLength(31)
    expect(table.elapsedDays).toBe(31)
    expect(table.isCurrentMonth).toBe(false)
    expect(table.average.expense).toBe('10.00')
  })

  it('未来月：日均不可用（0.00 + applicable=false），不泄漏 NaN', () => {
    const table = dailyRows([], ACCOUNTS, 2026, 12, 'CNY', today)
    expect(table.elapsedDays).toBe(0)
    expect(table.average.applicable).toBe(false)
    expect(table.average.expense).toBe('0.00')
    expect(table.isCurrentMonth).toBe(false)
  })

  it('闰年 2 月 29 天', () => {
    expect(dailyRows([], ACCOUNTS, 2024, 2, 'CNY', today).rows).toHaveLength(29)
    expect(dailyRows([], ACCOUNTS, 2026, 2, 'CNY', today).rows).toHaveLength(28)
  })
})

describe('tagShares：必须存在「未打标签」桶', () => {
  it('未打标签是一个正常桶，不是脏数据', () => {
    const shares = tagShares(TXNS, ACCOUNTS, 'CNY')
    const untagged = shares.find((share) => share.isUntagged)
    expect(untagged === undefined ? '' : untagged.tag).toBe(UNTAGGED_LABEL)
    expect(untagged === undefined ? '' : untagged.expense).toBe('30.00')
    expect(untagged === undefined ? '' : untagged.count).toBe(1)
  })

  it('各桶金额加总 === 月合计（含未打标签桶时才成立）', () => {
    const shares = tagShares(TXNS, ACCOUNTS, 'CNY')
    let expenseCents = 0
    for (const share of shares) {
      expenseCents += Math.round(Number(share.expense) * 100)
    }
    expect(expenseCents).toBe(Math.round(Number(statsTotals(TXNS, ACCOUNTS, 'CNY').expense) * 100))
  })

  it('一笔多标签各自计入（按标签看账的语义）', () => {
    const multi = [expense(1, '2026-11-01', '100.00', 10, ['家庭', '餐饮'])]
    const shares = tagShares(multi, ACCOUNTS, 'CNY')
    expect(shares.map((share) => share.tag).sort()).toEqual(['家庭', '餐饮'].sort())
    for (const share of shares) {
      expect(share.expense).toBe('100.00')
    }
  })

  it('结余 = 收入 − 支出，可能为负', () => {
    const shares = tagShares(TXNS, ACCOUNTS, 'CNY')
    const salary = shares.find((share) => share.tag === '工资')
    expect(salary === undefined ? '' : salary.income).toBe('900.00')
    expect(salary === undefined ? '' : salary.balance).toBe('900.00')
    const home = shares.find((share) => share.tag === '家庭')
    expect(home === undefined ? '' : home.balance).toBe('-100.00')
  })

  it('空标签 / 纯空白标签按未打标签处理，不产生名为空的桶', () => {
    const shares = tagShares([expense(1, '2026-11-01', '10.00', 10, ['', '   '])], ACCOUNTS, 'CNY')
    expect(shares).toHaveLength(1)
    expect(shares[0].isUntagged).toBe(true)
  })

  it('转账 / 期初不进标签桶（无收支金额，进桶会让笔数虚高）', () => {
    const transfer = txn(1, '2026-11-05', '搬钱', [
      { account_id: 1, commodity: 'CNY', amount: '-200.00' },
      { account_id: 1, commodity: 'CNY', amount: '200.00' },
    ])
    expect(tagShares([transfer], ACCOUNTS, 'CNY')).toHaveLength(0)
  })

  it('按金额（支出+收入）降序；相同时未打标签排最后', () => {
    const shares = tagShares(TXNS, ACCOUNTS, 'CNY')
    for (let i = 1; i < shares.length; i += 1) {
      const prev = Number(shares[i - 1].expense) + Number(shares[i - 1].income)
      const cur = Number(shares[i].expense) + Number(shares[i].income)
      expect(prev).toBeGreaterThanOrEqual(cur)
    }
  })
})
