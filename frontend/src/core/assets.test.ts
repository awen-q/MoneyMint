/**
 * 资产页聚合层回归（B5 / T50）
 *
 * 每条都是「会真红」的用例，不是「不抛错」：
 * - 外币并进小计 → 「外币不计入小计」必红；
 * - 关户被过滤 → 「关户仍列出」必红；
 * - 组顺序依赖 key 顺序 → 「负债在后」必红。
 */
import { describe, expect, it } from 'vitest'

import { buildAssetBreakdown } from '@/core/assets'
import { computeBalanceSummary, type SummaryAccount } from '@/core/record'

function account(overrides: Partial<SummaryAccount> & { id: number; type: string }): SummaryAccount {
  return {
    name: `Assets:Acc${overrides.id}`,
    ...overrides,
  }
}

const ACCOUNTS: SummaryAccount[] = [
  account({ id: 1, name: 'Assets:Bank:CNY', display_name: '招商储蓄', type: 'Assets', sort_order: 1, balances: { CNY: '12000.00' } }),
  // 多币种账户：CNY 进小计、USD 单列
  account({ id: 2, name: 'Assets:Bank:Multi', display_name: '多币种账户', type: 'Assets', sort_order: 2, balances: { CNY: '800.00', USD: '150.00' } }),
  // 已关户：仍要列出，并计入小计（钱的历史还在这个账户里）
  account({ id: 3, name: 'Assets:OldCard', display_name: '已注销卡', type: 'Assets', sort_order: 3, close_date: '2026-10-01', balances: { CNY: '200.00' } }),
  // 无余额数据的新账户：也要列出（0.00）
  account({ id: 4, name: 'Assets:NewWallet', display_name: '新钱包', type: 'Assets', sort_order: 4 }),
  // 负债（余额为负，符号如实）
  account({ id: 5, name: 'Liabilities:Mortgage', display_name: '房贷', type: 'Liabilities', sort_order: 1, balances: { CNY: '-300000.00' } }),
  account({ id: 6, name: 'Liabilities:Card', display_name: '信用卡', type: 'Liabilities', sort_order: 2, balances: { CNY: '-1500.00' } }),
  // 非资产类账户：必须被忽略
  account({ id: 7, name: 'Expenses:Food', display_name: '餐饮', type: 'Expenses', balances: { CNY: '99.00' } }),
]

describe('buildAssetBreakdown：小计口径', () => {
  it('外币单列：USD 不进主币种小计，并出现在 foreignRows / foreignCommodities', () => {
    const breakdown = buildAssetBreakdown(ACCOUNTS, 'CNY')
    const assets = breakdown.groups[0]
    // 主币种小计 = 12000 + 800 + 200 + 0，**不含** USD 150
    expect(assets.subtotal).toBe('13000.00')
    expect(assets.foreignRows).toHaveLength(1)
    expect(assets.foreignRows[0].amount).toBe('150.00')
    expect(assets.foreignRows[0].commodity).toBe('USD')
    expect(assets.foreignRows[0].isForeign).toBe(true)
    expect(breakdown.foreignCommodities).toEqual(['USD'])
  })

  it('主币种切换后，原来的外币变主币种、小计随之改变（不是硬编码 CNY）', () => {
    const breakdown = buildAssetBreakdown(ACCOUNTS, 'USD')
    const assets = breakdown.groups[0]
    expect(assets.subtotal).toBe('150.00')
    // 三个有 CNY 余额的账户变成外币行；id=4 无余额数据，按主币种 USD 0.00 列出
    expect(assets.foreignRows.map((row) => row.commodity)).toEqual(['CNY', 'CNY', 'CNY'])
    expect(breakdown.foreignCommodities).toEqual(['CNY'])
  })

  it('负债符号如实：小计为负，不 abs', () => {
    const breakdown = buildAssetBreakdown(ACCOUNTS, 'CNY')
    const liabilities = breakdown.groups[1]
    expect(liabilities.subtotal).toBe('-301500.00')
    expect(liabilities.rows.every((row) => row.amount.charAt(0) === '-')).toBe(true)
  })

  it('分组小计之和等于 computeBalanceSummary 的总资产 / 总负债（两侧口径钉死）', () => {
    const breakdown = buildAssetBreakdown(ACCOUNTS, 'CNY')
    const summary = computeBalanceSummary(ACCOUNTS, 'CNY')
    expect(breakdown.groups[0].subtotal).toBe(summary.assetTotal)
    expect(breakdown.groups[1].subtotal).toBe(summary.liabilityTotal)
  })
})

describe('buildAssetBreakdown：关户与空账户', () => {
  it('关户仍列出并标注 closed，且计入小计', () => {
    const breakdown = buildAssetBreakdown(ACCOUNTS, 'CNY')
    const closedRows = breakdown.groups[0].rows.filter((row) => row.closed)
    expect(closedRows).toHaveLength(1)
    expect(closedRows[0].label).toBe('已注销卡')
    expect(closedRows[0].amount).toBe('200.00')
    expect(breakdown.closedCount).toBe(1)
  })

  it('无余额数据的账户也列出（0.00），不会静默消失', () => {
    const breakdown = buildAssetBreakdown(ACCOUNTS, 'CNY')
    const empty = breakdown.groups[0].rows.filter((row) => row.amount === '0.00')
    expect(empty).toHaveLength(1)
    expect(empty[0].label).toBe('新钱包')
  })

  it('空账本：仍返回两组，rowCount 为 0（页面据此判 empty）', () => {
    const breakdown = buildAssetBreakdown([], 'CNY')
    expect(breakdown.groups).toHaveLength(2)
    expect(breakdown.groups[0].type).toBe('Assets')
    expect(breakdown.groups[1].type).toBe('Liabilities')
    expect(breakdown.rowCount).toBe(0)
    expect(breakdown.closedCount).toBe(0)
  })

  it('只有分类账户（无资产 / 负债）时 rowCount 仍为 0', () => {
    const breakdown = buildAssetBreakdown(
      [account({ id: 9, name: 'Expenses:Food', type: 'Expenses', balances: { CNY: '1.00' } })],
      'CNY',
    )
    expect(breakdown.rowCount).toBe(0)
  })
})

describe('buildAssetBreakdown：顺序稳定', () => {
  it('资产在前、负债在后，与输入顺序无关', () => {
    const reversed = ACCOUNTS.slice().reverse()
    const breakdown = buildAssetBreakdown(reversed, 'CNY')
    expect(breakdown.groups.map((group) => group.type)).toEqual(['Assets', 'Liabilities'])
    expect(breakdown.groups[0].label).toBe('资产')
    expect(breakdown.groups[1].label).toBe('负债')
  })

  it('组内按 sort_order 再按 id 稳定排序', () => {
    const shuffled = ACCOUNTS.slice().reverse()
    const breakdown = buildAssetBreakdown(shuffled, 'CNY')
    expect(breakdown.groups[0].rows.map((row) => row.accountId)).toEqual([1, 2, 3, 4])
    expect(breakdown.groups[1].rows.map((row) => row.accountId)).toEqual([5, 6])
  })

  it('多币种账户：主币种行在前、外币行单列', () => {
    const breakdown = buildAssetBreakdown(ACCOUNTS, 'CNY')
    const multi = breakdown.groups[0].rows.find((row) => row.accountId === 2)
    expect(multi === undefined ? '' : multi.amount).toBe('800.00')
    expect(breakdown.groups[0].foreignRows[0].accountId).toBe(2)
  })

  it('非法余额按 0.00 处理，不污染小计', () => {
    const breakdown = buildAssetBreakdown(
      [account({ id: 10, type: 'Assets', balances: { CNY: 'abc' } })],
      'CNY',
    )
    expect(breakdown.groups[0].subtotal).toBe('0.00')
  })
})
