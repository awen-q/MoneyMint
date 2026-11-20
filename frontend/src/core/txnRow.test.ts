/**
 * 交易行视图模型回归（B2 账单页 / B3 搜索结果共用口径）
 *
 * 重点锁死四件容易被「顺手优化」改坏的事：
 * 1. 徽章两组各一枚（reversal 组 + kind 组，最多两枚，顺序固定）；
 * 2. 转账 `signed === false`，支出/收入带符号原值；
 * 3. 备注为空时标题回落；
 * 4. 三档 variant 的 meta 数量与顺序（顺序即渲染顺序，渲染层不再排序）。
 */
import { describe, expect, it } from 'vitest'

import { buildTxnRow, type MetaKind, type TxnRowVariant } from '@/core/txnRow'
import type { SummaryAccount } from '@/core/record'
import type { PostingView, TransactionView } from '@/api/types'

const BANK: SummaryAccount = {
  id: 1,
  name: 'Assets:Bank',
  display_name: '银行卡',
  type: 'Assets',
}
const CASH: SummaryAccount = { id: 5, name: 'Assets:Cash', display_name: '现金', type: 'Assets' }
const FOOD: SummaryAccount = {
  id: 2,
  name: 'Expenses:Food',
  display_name: '餐饮',
  type: 'Expenses',
}
const SALARY: SummaryAccount = { id: 3, name: 'Income:Salary', display_name: '工资', type: 'Income' }
const OPENING: SummaryAccount = { id: 4, name: 'Equity:Opening', type: 'Equity' }
const ACCOUNTS: SummaryAccount[] = [BANK, CASH, FOOD, SALARY, OPENING]

function posting(accountId: number, amount: string, commodity = 'CNY'): PostingView {
  return { account_id: accountId, account: `Acct:${accountId}`, commodity, amount }
}

function makeTxn(overrides: Partial<TransactionView> = {}): TransactionView {
  const base: TransactionView = {
    id: 1,
    uuid: 'uuid-1',
    date: '2026-08-09',
    flag: '*',
    description: '午餐',
    created_by_name: '阿文',
    postings: [posting(1, '-25.50'), posting(2, '25.50')],
  }
  return { ...base, ...overrides }
}

function metaKinds(variant: TxnRowVariant, txn: TransactionView): MetaKind[] {
  const kinds: MetaKind[] = []
  for (const meta of buildTxnRow(txn, ACCOUNTS, variant).meta) {
    kinds.push(meta.kind)
  }
  return kinds
}

describe('buildTxnRow：徽章（reversal 组 + kind 组，最多两枚）', () => {
  it('被冲正的转账 → 两枚，顺序 [已冲正, 转账]', () => {
    const txn = makeTxn({
      description: '搬钱',
      reversed_by: 'uuid-new',
      postings: [posting(1, '-100.00'), posting(5, '100.00')],
    })
    const row = buildTxnRow(txn, ACCOUNTS, 'bill')
    expect(row.badges).toHaveLength(2)
    expect(row.badges[0]).toEqual({ label: '已冲正', tone: 'reversal' })
    expect(row.badges[1]).toEqual({ label: '转账', tone: 'transfer' })
  })

  it('冲正（冲正交易本身）+ 转账 → 两枚 [冲正, 转账]', () => {
    const txn = makeTxn({
      description: '搬钱',
      reversal_of: 'uuid-old',
      postings: [posting(1, '-100.00'), posting(5, '100.00')],
    })
    expect(buildTxnRow(txn, ACCOUNTS, 'bill').badges).toEqual([
      { label: '冲正', tone: 'neutral' },
      { label: '转账', tone: 'transfer' },
    ])
  })

  it('冲正 + 期初 → [冲正, 期初]；纯期初 → 只有「期初」', () => {
    const openingTxn = makeTxn({
      description: '期初余额',
      postings: [posting(1, '1000.00'), posting(4, '-1000.00')],
    })
    expect(buildTxnRow(openingTxn, ACCOUNTS, 'bill').badges).toEqual([
      { label: '期初', tone: 'opening' },
    ])

    const reversed = { ...openingTxn, reversal_of: 'uuid-old' }
    expect(buildTxnRow(reversed, ACCOUNTS, 'bill').badges).toEqual([
      { label: '冲正', tone: 'neutral' },
      { label: '期初', tone: 'opening' },
    ])
  })

  it('reversal 组内互斥：reversed_by 与 reversal_of 同时非空只出「已冲正」', () => {
    const txn = makeTxn({ reversed_by: 'uuid-new', reversal_of: 'uuid-old' })
    const row = buildTxnRow(txn, ACCOUNTS, 'bill')
    expect(row.badges).toEqual([{ label: '已冲正', tone: 'reversal' }])
  })

  it('转账 → 「转账」；普通支出 / 收入无徽章', () => {
    const transfer = makeTxn({ postings: [posting(1, '-100.00'), posting(5, '100.00')] })
    expect(buildTxnRow(transfer, ACCOUNTS, 'bill').badges).toEqual([
      { label: '转账', tone: 'transfer' },
    ])

    expect(buildTxnRow(makeTxn(), ACCOUNTS, 'bill').badges).toEqual([])

    const income = makeTxn({ postings: [posting(1, '5000.00'), posting(3, '-5000.00')] })
    expect(buildTxnRow(income, ACCOUNTS, 'bill').badges).toEqual([])
  })
})

describe('buildTxnRow：金额与符号', () => {
  it('转账 signed=false 且金额取转出方绝对值', () => {
    const txn = makeTxn({ postings: [posting(1, '-1234.50'), posting(5, '1234.50')] })
    const row = buildTxnRow(txn, ACCOUNTS, 'bill')
    expect(row.signed).toBe(false)
    expect(row.amount).toBe('1234.50')
    expect(row.commodity).toBe('CNY')
  })

  it('支出带负号原值、收入带正号原值，两者 signed=true', () => {
    const expense = buildTxnRow(makeTxn(), ACCOUNTS, 'bill')
    expect(expense.signed).toBe(true)
    expect(expense.amount).toBe('-25.50')

    const income = buildTxnRow(
      makeTxn({ postings: [posting(1, '5000.00'), posting(3, '-5000.00')] }),
      ACCOUNTS,
      'bill',
    )
    expect(income.signed).toBe(true)
    expect(income.amount).toBe('5000.00')
  })

  it('混合交易（同时含 Expenses 与 Income）取正号资金分录（净收款）', () => {
    // 消费 100、退款 120 → 资金净流入 20。
    const txn = makeTxn({
      postings: [posting(2, '100.00'), posting(3, '-120.00'), posting(1, '20.00')],
    })
    const row = buildTxnRow(txn, ACCOUNTS, 'bill')
    expect(row.amount).toBe('20.00')
    expect(row.signed).toBe(true)
  })

  it('amount 一律归一为两位定点串', () => {
    const txn = makeTxn({ postings: [posting(1, '-12.5'), posting(2, '12.5')] })
    const row = buildTxnRow(txn, ACCOUNTS, 'bill')
    expect(row.amount).toBe('-12.50')
    expect(row.amount).toMatch(/^-?\d+\.\d{2}$/)
  })
})

describe('buildTxnRow：id 透出', () => {
  it('view.id 等于 txn.id（页面据此跳详情，无需并排存 { id, view }）', () => {
    const row = buildTxnRow(makeTxn({ id: 42 }), ACCOUNTS, 'bill')
    expect(row.id).toBe(42)
  })

  it('三档 variant 都透出同一个 id', () => {
    const txn = makeTxn({ id: 7 })
    for (const variant of ['bill', 'search', 'drawer'] as TxnRowVariant[]) {
      expect(buildTxnRow(txn, ACCOUNTS, variant).id).toBe(7)
    }
  })
})

describe('buildTxnRow：title 回落', () => {
  it('备注优先', () => {
    expect(buildTxnRow(makeTxn({ description: '和爸妈吃饭' }), ACCOUNTS, 'bill').title).toBe(
      '和爸妈吃饭',
    )
  })

  it('备注为空：转账 → 「转账」，期初 → 「期初」，支出 → 分类名', () => {
    const transfer = makeTxn({
      description: '',
      postings: [posting(1, '-100.00'), posting(5, '100.00')],
    })
    expect(buildTxnRow(transfer, ACCOUNTS, 'bill').title).toBe('转账')

    const opening = makeTxn({
      description: '   ',
      postings: [posting(1, '1000.00'), posting(4, '-1000.00')],
    })
    expect(buildTxnRow(opening, ACCOUNTS, 'bill').title).toBe('期初')

    expect(buildTxnRow(makeTxn({ description: '  ' }), ACCOUNTS, 'bill').title).toBe('餐饮')
  })

  it('备注为空且账户未加载 → 「未命名交易」', () => {
    const row = buildTxnRow(makeTxn({ description: '' }), [], 'bill')
    expect(row.title).toBe('未命名交易')
  })
})

describe('buildTxnRow：三档 variant 的 meta', () => {
  const full = makeTxn({
    tags: ['旅行', '聚餐', '报销'],
  })

  it('bill：category → member → tag（tag 只保留 1 个）', () => {
    const row = buildTxnRow(full, ACCOUNTS, 'bill')
    expect(metaKinds('bill', full)).toEqual(['category', 'member', 'tag'])
    expect(row.meta).toEqual([
      { kind: 'category', text: '餐饮' },
      { kind: 'member', text: '阿文' },
      { kind: 'tag', text: '旅行' },
    ])
  })

  it('search：date → type → category → account → tag ×2 → member', () => {
    const row = buildTxnRow(full, ACCOUNTS, 'search')
    expect(metaKinds('search', full)).toEqual([
      'date',
      'type',
      'category',
      'account',
      'tag',
      'tag',
      'member',
    ])
    expect(row.meta[0]).toEqual({ kind: 'date', text: '2026-08-09' })
    expect(row.meta[1]).toEqual({ kind: 'type', text: '支出' })
    expect(row.meta[3]).toEqual({ kind: 'account', text: '银行卡' })
    expect(row.meta[4]).toEqual({ kind: 'tag', text: '旅行' })
    expect(row.meta[5]).toEqual({ kind: 'tag', text: '聚餐' })
  })

  it('drawer：tag 全量且不截断', () => {
    const row = buildTxnRow(full, ACCOUNTS, 'drawer')
    expect(metaKinds('drawer', full)).toEqual([
      'date',
      'type',
      'category',
      'account',
      'tag',
      'tag',
      'tag',
      'member',
    ])
    expect(row.meta[6]).toEqual({ kind: 'tag', text: '报销' })
  })

  it('无成员 / 无标签 / 旧响应缺 tags 时不产出空项', () => {
    const bare = makeTxn({ created_by_name: '' })
    const row = buildTxnRow(bare, ACCOUNTS, 'drawer')
    expect(metaKinds('drawer', bare)).toEqual(['date', 'type', 'category', 'account'])
    for (const meta of row.meta) {
      expect(meta.text).not.toBe('')
    }

    // tags 缺省（旧响应）不应抛错。
    const legacy = makeTxn()
    delete (legacy as { tags?: string[] }).tags
    expect(metaKinds('drawer', legacy)).toEqual(['date', 'type', 'category', 'account', 'member'])
  })

  it('转账的 account 项展示「转出 → 转入」，type 为「转账」', () => {
    const txn = makeTxn({
      description: '搬钱',
      postings: [posting(1, '-100.00'), posting(5, '100.00')],
    })
    const row = buildTxnRow(txn, ACCOUNTS, 'search')
    expect(row.meta[1]).toEqual({ kind: 'type', text: '转账' })
    // 转账没有分类账户，category 项被丢弃 → account 上移到 index 2。
    expect(metaKinds('search', txn)).toEqual(['date', 'type', 'account', 'member'])
    expect(row.meta[2]).toEqual({ kind: 'account', text: '银行卡 → 现金' })
  })

  it('非法 variant 运行时兜底为 bill', () => {
    const row = buildTxnRow(full, ACCOUNTS, 'unknown' as TxnRowVariant)
    expect(metaKinds('bill', full)).toEqual(['category', 'member', 'tag'])
    expect(row.meta).toHaveLength(3)
  })
})

describe('buildTxnRow：还款主体 + 小额优惠（Bug2 展示层）', () => {
  const CARD: SummaryAccount = { id: 6, name: 'Liabilities:Card', type: 'Liabilities' }
  const ACCOUNTS_WITH_CARD = [...ACCOUNTS, CARD]
  /** Assets -4997 / Liabilities +5000 / Income -3。 */
  const compound = makeTxn({
    description: '还信用卡',
    postings: [posting(1, '-4997.00'), posting(6, '5000.00'), posting(3, '-3.00')],
  })

  it('search 档 type meta 为「转账」，金额取转出方绝对值且不带正号', () => {
    const row = buildTxnRow(compound, ACCOUNTS_WITH_CARD, 'search')
    expect(row.meta.find((item) => item.kind === 'type')).toEqual({ kind: 'type', text: '转账' })
    expect(row.signed).toBe(false)
    expect(row.amount).toBe('4997.00')
    expect(row.meta.find((item) => item.kind === 'account')).toEqual({
      kind: 'account',
      text: '银行卡 → Liabilities:Card',
    })
  })

  it('bill 档不新增 income / transfer 徽章（冻结口径：badge 仍为 []）', () => {
    expect(buildTxnRow(compound, ACCOUNTS_WITH_CARD, 'bill').badges).toEqual([])
  })
})
