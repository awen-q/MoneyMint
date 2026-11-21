/**
 * 分享图数据层回归：最小披露是默认值，任何敏感字段都必须显式勾选才进票面。
 */
import { describe, expect, it } from 'vitest'

import {
  collectShareLines,
  DEFAULT_EXTRAS,
  EMPTY_DETAILS,
  type ShareReceiptData,
} from './receiptImage'

function baseData(): ShareReceiptData {
  return {
    amountText: '¥ 128.50',
    kindLabel: '支出 EXPENSE',
    date: '2026-11-21',
    payee: '超市',
    stamp: '已记账',
    extras: { ...DEFAULT_EXTRAS },
  }
}

describe('receiptImage：默认最小披露', () => {
  it('默认只输出日期 + 分类展示名两行', () => {
    const lines = collectShareLines(baseData(), EMPTY_DETAILS)
    expect(lines).toEqual([
      { label: '日期', value: '2026-11-21' },
      { label: '分类', value: '超市' },
    ])
  })

  it('默认不含 bean / 完整账户 / 标签 / 精确时间', () => {
    const details = {
      accountLines: ['Assets:Alipay', 'Expenses:Food'],
      tagLine: '日常 孩子',
      beanLines: ['2026-11-21 * "超市"'],
      preciseTime: '2026-11-21 18:30:00',
    }
    const text = JSON.stringify(collectShareLines(baseData(), details))
    expect(text).not.toContain('Assets:')
    expect(text).not.toContain('Expenses:')
    expect(text).not.toContain('孩子')
    expect(text).not.toContain('18:30')
    expect(text).not.toContain('2026-11-21 *')
  })
})

describe('receiptImage：显式展开才输出', () => {
  it('勾选精确时间与标签后逐项出现', () => {
    const data = baseData()
    data.extras.preciseTime = true
    data.extras.tags = true
    const lines = collectShareLines(data, {
      ...EMPTY_DETAILS,
      tagLine: '日常',
      preciseTime: '18:30:00',
    })
    expect(lines).toContainEqual({ label: '时间', value: '18:30:00' })
    expect(lines).toContainEqual({ label: '标签', value: '日常' })
  })

  it('勾选账户后完整账户名出现（用户主动选择）', () => {
    const data = baseData()
    data.extras.accounts = true
    const lines = collectShareLines(data, {
      ...EMPTY_DETAILS,
      accountLines: ['Assets:Alipay'],
    })
    expect(lines).toContainEqual({ label: '账户', value: 'Assets:Alipay' })
  })
})

describe('receiptImage：遮挡态透传', () => {
  it('amountText 是遮挡符时数据层原样保留，不反查原始金额', () => {
    const data = baseData()
    data.amountText = '••••••'
    expect(data.amountText).toBe('••••••')
    expect(JSON.stringify(collectShareLines(data, EMPTY_DETAILS))).not.toContain('128.50')
  })
})
