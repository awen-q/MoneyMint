/**
 * 账单聚合层回归（B2）
 *
 * 锁死四类容易被「顺手优化」改坏的口径：
 * 1. 只累计指定币种的分录（跨币种混算会静默错账）；
 * 2. Income 分录取反后对外恒为正、支出永不为负（退款场景）；
 * 3. 逐日序列长度恒为当月天数（日历格按 index 取）；
 * 4. 三者勾稽：Σ 逐日 = 月合计（**字符串逐项累加**比较，不做浮点求和）。
 */
import { describe, expect, it } from 'vitest'

import { billCells, daySeries, monthTotals, type BillDayPoint } from '@/core/bill'
import type { PostingView, TransactionView } from '@/api/types'

function posting(account: string, amount: string, commodity = 'CNY'): PostingView {
  return { account_id: 1, account, commodity, amount }
}

function makeTxn(
  id: number,
  date: string,
  postings: PostingView[],
  overrides: Partial<TransactionView> = {},
): TransactionView {
  return {
    id,
    uuid: `uuid-${id}`,
    date,
    flag: '*',
    description: `交易${id}`,
    created_by_name: '阿文',
    postings,
    ...overrides,
  }
}

/** 一笔「支出 3.81」：Expenses 借方正、Assets 贷方负。 */
function expenseTxn(id: number, date: string, amount: string, commodity = 'CNY'): TransactionView {
  return makeTxn(id, date, [
    posting('Expenses:Food:Drink', amount, commodity),
    posting('Assets:Bank', `-${amount}`, commodity),
  ])
}

/** 一笔「收入 18500.00」：Income 贷方负、Assets 借方正。 */
function incomeTxn(id: number, date: string, amount: string, commodity = 'CNY'): TransactionView {
  return makeTxn(id, date, [
    posting('Assets:Bank', amount, commodity),
    posting('Income:Salary', `-${amount}`, commodity),
  ])
}

/** 字符串逐项累加（禁浮点求和）。 */
function sumOf(values: string[]): string {
  let total = 0
  // 累计到「分」为单位后比较，避免浮点误差：金额恒为两位定点串。
  for (const value of values) {
    const [intPart, decPart] = value.split('.')
    const negative = intPart.charAt(0) === '-'
    const intDigits = negative ? intPart.slice(1) : intPart
    const cents = Number(intDigits) * 100 + Number(decPart)
    total += negative ? -cents : cents
  }
  const negative = total < 0
  const abs = Math.abs(total)
  const intText = String(Math.floor(abs / 100))
  const decText = String(abs % 100).padStart(2, '0')
  return `${negative ? '-' : ''}${intText}.${decText}`
}

function pointOf(points: BillDayPoint[], day: number): BillDayPoint {
  for (const point of points) {
    if (point.day === day) {
      return point
    }
  }
  throw new Error(`没有第 ${day} 天`)
}

describe('monthTotals', () => {
  it('空数组：全部 0.00、笔数 0', () => {
    expect(monthTotals([], 'CNY')).toEqual({
      expense: '0.00',
      income: '0.00',
      balance: '0.00',
      count: 0,
    })
  })

  it('单笔支出：支出为正、结余为负', () => {
    const totals = monthTotals([expenseTxn(1, '2026-11-10', '3.81')], 'CNY')
    expect(totals.expense).toBe('3.81')
    expect(totals.income).toBe('0.00')
    expect(totals.balance).toBe('-3.81')
    expect(totals.count).toBe(1)
  })

  it('单笔收入：Income 分录取反后对外为正', () => {
    const totals = monthTotals([incomeTxn(1, '2026-11-10', '18500.00')], 'CNY')
    expect(totals.income).toBe('18500.00')
    expect(totals.expense).toBe('0.00')
    expect(totals.balance).toBe('18500.00')
  })

  it('跨币种：只算指定币种，笔数也只数该币种交易', () => {
    const txns: TransactionView[] = [
      expenseTxn(1, '2026-11-10', '100.00', 'CNY'),
      expenseTxn(2, '2026-11-10', '50.00', 'USD'),
      incomeTxn(3, '2026-11-11', '20.00', 'USD'),
    ]
    const cny = monthTotals(txns, 'CNY')
    expect(cny.expense).toBe('100.00')
    expect(cny.income).toBe('0.00')
    expect(cny.count).toBe(1)

    const usd = monthTotals(txns, 'USD')
    expect(usd.expense).toBe('50.00')
    expect(usd.income).toBe('20.00')
    expect(usd.count).toBe(2)
  })

  it('同一笔交易的多条该币种分录只算 1 笔', () => {
    const txn = makeTxn(1, '2026-11-10', [
      posting('Expenses:Food', '10.00'),
      posting('Expenses:Food:Drink', '5.00'),
      posting('Assets:Bank', '-15.00'),
    ])
    const totals = monthTotals([txn], 'CNY')
    expect(totals.count).toBe(1)
    expect(totals.expense).toBe('15.00')
  })

  it('转账（无收支分录）计入笔数但不计入金额', () => {
    const transfer = makeTxn(1, '2026-11-10', [
      posting('Assets:Bank', '-100.00'),
      posting('Assets:Cash', '100.00'),
    ])
    const totals = monthTotals([transfer], 'CNY')
    expect(totals.expense).toBe('0.00')
    expect(totals.income).toBe('0.00')
    expect(totals.count).toBe(1)
  })

  it('退款（支出分录为负）冲减当日支出，不会出现负支出', () => {
    const txns: TransactionView[] = [
      expenseTxn(1, '2026-11-10', '100.00'),
      // 同一天退款 30：Expenses 侧为负
      makeTxn(2, '2026-11-10', [
        posting('Expenses:Food', '-30.00'),
        posting('Assets:Bank', '30.00'),
      ]),
    ]
    expect(monthTotals(txns, 'CNY').expense).toBe('70.00')

    // 纯退款日：净支出为负 → 归零，不出现「负的支出」，也不搬进收入桶
    const refundOnly = monthTotals(
      [
        makeTxn(3, '2026-11-12', [
          posting('Expenses:Food', '-50.00'),
          posting('Assets:Bank', '50.00'),
        ]),
      ],
      'CNY',
    )
    expect(refundOnly.expense).toBe('0.00')
    expect(refundOnly.income).toBe('0.00')
  })
})

describe('daySeries', () => {
  it('长度恒为当月天数，无交易的日给 0.00 / 0', () => {
    const points = daySeries([], 2026, 4, 'CNY')
    expect(points).toHaveLength(30)
    expect(points[0]).toEqual({ day: 1, expense: '0.00', income: '0.00', count: 0 })
    expect(points[29].day).toBe(30)
  })

  it('闰年 2028-02 为 29 天，平年 2027-02 为 28 天', () => {
    expect(daySeries([], 2028, 2, 'CNY')).toHaveLength(29)
    expect(daySeries([], 2027, 2, 'CNY')).toHaveLength(28)
    expect(daySeries([], 2024, 2, 'CNY')).toHaveLength(29)
  })

  it('同一天多笔累加，笔数按交易数而非分录数', () => {
    const txns: TransactionView[] = [
      expenseTxn(1, '2026-11-10', '10.00'),
      expenseTxn(2, '2026-11-10', '5.50'),
      incomeTxn(3, '2026-11-10', '100.00'),
    ]
    const point = pointOf(daySeries(txns, 2026, 11, 'CNY'), 10)
    expect(point.expense).toBe('15.50')
    expect(point.income).toBe('100.00')
    expect(point.count).toBe(3)
  })
})

describe('billCells：四态与主数字', () => {
  it('both：只显示支出侧带负号，收入用圆点', () => {
    const cells = billCells(
      [expenseTxn(1, '2026-11-10', '967.00'), incomeTxn(2, '2026-11-10', '18500.00')],
      2026,
      11,
      'CNY',
    )
    const cell = cells[9]
    expect(cell.day).toBe(10)
    expect(cell.kind).toBe('both')
    expect(cell.text).toBe('-967')
    expect(cell.text.charAt(0)).toBe('-')
    // 收入是加法字段：18500 → formatCompact 的 1.9w 档，主数字仍只有支出
    expect(cell.incomeText).toBe('+1.9w')
    expect(cell.incomeDot).toBe(true)
    // 读屏文案给全两位小数精确值，且不带 compact 后缀
    expect(cell.ariaLabel).toBe('11月10日，收入 18500.00，支出 967.00')
    expect(cell.ariaLabel).not.toMatch(/[kw]/)
  })

  it('expense-only：带负号，无收入圆点', () => {
    const cells = billCells([expenseTxn(1, '2026-11-05', '3.81')], 2026, 11, 'CNY')
    expect(cells[4].kind).toBe('expense-only')
    expect(cells[4].text).toBe('-4') // 3.81 四舍五入到整数元
    expect(cells[4].incomeText).toBeUndefined()
    expect(cells[4].incomeDot).toBe(false)
    expect(cells[4].ariaLabel).toBe('11月5日，支出 3.81')
  })

  it('income-only：带正号并走 compact', () => {
    const cells = billCells([incomeTxn(1, '2026-11-03', '1800.00')], 2026, 11, 'CNY')
    expect(cells[2].kind).toBe('income-only')
    expect(cells[2].text).toBe('+1.8k')
    // income-only 的 incomeText 与主数字同值（渲染层只摆第一行，不重复）
    expect(cells[2].incomeText).toBe('+1.8k')
    expect(cells[2].incomeDot).toBe(false)
    expect(cells[2].ariaLabel).toBe('11月3日，收入 1800.00')
  })

  it('empty：text 为空串、文案为「无收支」', () => {
    const cells = billCells([], 2026, 11, 'CNY')
    expect(cells).toHaveLength(30)
    for (const cell of cells) {
      expect(cell.kind).toBe('empty')
      expect(cell.text).toBe('')
      expect(cell.incomeText).toBeUndefined()
      expect(cell.incomeDot).toBe(false)
    }
    expect(cells[0].ariaLabel).toBe('11月1日，无收支')
  })

  it('舍入为 0 的日子按 empty 处理（不出现孤零零的 0）', () => {
    const cells = billCells([expenseTxn(1, '2026-11-07', '0.001')], 2026, 11, 'CNY')
    expect(cells[6].kind).toBe('empty')
    expect(cells[6].text).toBe('')
  })

  it('四态与 daySeries 同日数据一致', () => {
    const txns: TransactionView[] = [
      expenseTxn(1, '2026-11-01', '10.00'), // expense-only
      incomeTxn(2, '2026-11-02', '20.00'), // income-only
      expenseTxn(3, '2026-11-03', '5.00'),
      incomeTxn(4, '2026-11-03', '8.00'), // both
      // 11-04 empty
    ]
    const cells = billCells(txns, 2026, 11, 'CNY')
    const points = daySeries(txns, 2026, 11, 'CNY')
    const expected = ['expense-only', 'income-only', 'both', 'empty']
    for (let index = 0; index < expected.length; index += 1) {
      expect(cells[index].kind).toBe(expected[index])
      const point = points[index]
      const hasExpense = point.expense !== '0.00'
      const hasIncome = point.income !== '0.00'
      expect(cells[index].incomeDot).toBe(hasExpense && hasIncome)
    }
  })
})

describe('勾稽：逐日加总 = 月合计', () => {
  const txns: TransactionView[] = [
    expenseTxn(1, '2026-11-01', '10.00'),
    expenseTxn(2, '2026-11-01', '2.50'),
    incomeTxn(3, '2026-11-02', '1800.00'),
    expenseTxn(4, '2026-11-03', '99.99'),
    incomeTxn(5, '2026-11-03', '0.01'),
    // 纯退款日：月合计与逐日都按 0 计
    makeTxn(6, '2026-11-04', [
      posting('Expenses:Food', '-50.00'),
      posting('Assets:Bank', '50.00'),
    ]),
  ]

  it('Σ expense / income / count 与 monthTotals 完全一致', () => {
    const points = daySeries(txns, 2026, 11, 'CNY')
    const totals = monthTotals(txns, 'CNY')

    const expenses: string[] = []
    const incomes: string[] = []
    let count = 0
    for (const point of points) {
      expenses.push(point.expense)
      incomes.push(point.income)
      count += point.count
    }

    expect(sumOf(expenses)).toBe(totals.expense)
    expect(sumOf(incomes)).toBe(totals.income)
    expect(count).toBe(totals.count)
    // 字符串逐项累加的结果也要与 Money 定点结果同形（两位小数）
    expect(sumOf(expenses)).toMatch(/^-?\d+\.\d{2}$/)
  })

  it('结余 = 收入 − 支出', () => {
    const totals = monthTotals(txns, 'CNY')
    expect(sumOf([totals.income, `-${totals.expense}`])).toBe(totals.balance)
  })
})

describe('边界', () => {
  it('postings 为空 / commodity 为空的交易不炸且不计数', () => {
    const txns: TransactionView[] = [
      makeTxn(1, '2026-11-10', []),
      makeTxn(2, '2026-11-10', [posting('Expenses:Food', '10.00', '')]),
    ]
    const totals = monthTotals(txns, 'CNY')
    expect(totals.count).toBe(0)
    expect(totals.expense).toBe('0.00')
    expect(daySeries(txns, 2026, 11, 'CNY')).toHaveLength(30)
  })

  it('非法日期 / 非法年份月份不产生 NaN', () => {
    const txns: TransactionView[] = [makeTxn(1, 'bad-date', [posting('Expenses:Food', '10.00')])]
    expect(monthTotals(txns, 'CNY').count).toBe(0)
    expect(daySeries(txns, 2026, 11, 'CNY')).toHaveLength(30)
    expect(daySeries([], Number.NaN, Number.NaN, 'CNY').length).toBeGreaterThan(0)
    // 月份溢出被夹到 12
    expect(daySeries([], 2026, 13, 'CNY')).toHaveLength(31)
  })

  it('非法金额按 0 处理，不污染合计', () => {
    const txns: TransactionView[] = [
      makeTxn(1, '2026-11-10', [
        posting('Expenses:Food', 'abc'),
        posting('Expenses:Food', '10.00'),
        posting('Assets:Bank', '-10.00'),
      ]),
    ]
    expect(monthTotals(txns, 'CNY').expense).toBe('10.00')
  })
})
