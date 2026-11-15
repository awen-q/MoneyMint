/**
 * 0.6.0 S4 余额校准前端定点金额与文案回归。
 * 重点证伪「JS 裸 +/- 造成浮点误差」与「预检文案措辞不一致」。
 */
import { describe, expect, it } from 'vitest'

import {
  balanceDiff,
  hasTransactionsAfter,
  isPlainDecimal,
  previewText,
  signedDiff,
} from './balance'

describe('余额校准：定点金额（禁浮点）', () => {
  it('差额 = 目标 − 累计，正 / 负 / 零均精确', () => {
    expect(balanceDiff('12000.00', '12350.00')).toBe('350.00')
    expect(balanceDiff('12000.00', '11000.00')).toBe('-1000.00')
    expect(balanceDiff('100.00', '100.00')).toBe('0.00')
  })

  it('0.1 + 0.2 类浮点陷阱不出现（定点字符串运算）', () => {
    expect(balanceDiff('0.10', '0.30')).toBe('0.20')
    expect(balanceDiff('-0.10', '0.20')).toBe('0.30')
    expect(balanceDiff('1234567890.12', '1234567890.15')).toBe('0.03')
  })

  it('非法金额（指数 / 空 / 文字 / 分数）一律拒绝', () => {
    expect(isPlainDecimal('1e3')).toBe(false)
    expect(isPlainDecimal('1/2')).toBe(false)
    expect(isPlainDecimal('')).toBe(false)
    expect(isPlainDecimal('abc')).toBe(false)
    expect(() => balanceDiff('1e3', '2')).toThrow('定点十进制')
    expect(() => balanceDiff('1.00', 'abc')).toThrow('定点十进制')
    expect(isPlainDecimal('-12.50')).toBe(true)
  })

  it('差额展示：正数带 +，零不带符号，负数保留负号', () => {
    expect(signedDiff('350.00')).toBe('+350.00')
    expect(signedDiff('0.00')).toBe('0.00')
    expect(signedDiff('-1000.00')).toBe('-1,000.00')
  })
})

describe('余额校准：预检文案与二次确认（AC-3.1 / AC-3.7）', () => {
  it('文案统一「截至 D 日初（前一日日终）当前累计 / 目标 / 将自动补记 ±差额」', () => {
    const text = previewText('2026-03-01', '12000.00', '12350.00')
    expect(text).toContain('截至 2026-03-01 日初（前一日日终）')
    expect(text).toContain('当前累计 12,000.00')
    expect(text).toContain('目标 12,350.00')
    expect(text).toContain('将自动补记 +350.00')
  })

  it('负差额文案不带双重负号', () => {
    expect(previewText('2026-03-01', '12000.00', '11000.00')).toContain('将自动补记 -1,000.00')
  })

  it('D 之后有交易时二次确认提示生效，D 当日交易不算「之后」', () => {
    expect(hasTransactionsAfter('2026-03-01', ['2026-02-28', '2026-03-01', '2026-03-02'])).toBe(true)
    expect(hasTransactionsAfter('2026-03-01', ['2026-02-28', '2026-03-01'])).toBe(false)
    expect(hasTransactionsAfter('2026-03-01', [])).toBe(false)
  })
})
