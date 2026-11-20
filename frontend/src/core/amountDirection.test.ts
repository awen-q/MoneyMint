/**
 * 高级录入 v2：带符号金额 ↔ 借贷方向纯函数回归。
 *
 * AdvancedRow.amount 是带符号定点串、也是 core 配平/导出/草稿的唯一真值；
 * 方向与显示幅值都由 UI 从 amount 派生。本文件守住这层派生与回写的可逆性，
 * 防止「Toggle 改方向 / 粘贴带符号值 / 编辑态恢复」把符号写坏。
 */
import { describe, expect, it } from 'vitest'

import { amountDirection, magnitudeOf, signAmount, type AdvancedRow } from './record'

const DIRECTION_CASES: ReadonlyArray<readonly [string, 'debit' | 'credit']> = [
  ['38.50', 'debit'],
  ['0.00', 'debit'],
  ['-38.50', 'credit'],
  // Decimal('-0.00').isNegative() 为 true，负零须判为贷，保证回写往返一致。
  ['-0.00', 'credit'],
  // 非法金额按借兜底，避免 UI 在输入中途崩溃。
  ['abc', 'debit'],
  ['', 'debit'],
]

// 只列 Money.from 可接受的合法串：`-12.` 这类尾随点负数属非法输入，
// amountDirection 按借兜底（方案口径），不在往返恒等保证范围内。
const ROUNDTRIP_AMOUNTS: readonly string[] = ['38.50', '-38.50', '-0.00', '12.']

describe('amountDirection：带符号金额 → 借贷方向', () => {
  it('正数/零为借，负数（含负零）为贷，非法值按借兜底', () => {
    for (const [amount, expected] of DIRECTION_CASES) {
      expect(amountDirection(amount), amount).toBe(expected)
    }
  })
})

describe('signAmount / magnitudeOf：方向与幅值互转', () => {
  it('signAmount 剥掉输入的 +/- 并按方向赋予唯一符号', () => {
    expect(signAmount('debit', '38.50')).toBe('38.50')
    expect(signAmount('credit', '38.50')).toBe('-38.50')
    expect(signAmount('debit', '-38.50')).toBe('38.50')
    expect(signAmount('credit', '+38.50')).toBe('-38.50')
    expect(signAmount('debit', '  12.  ')).toBe('12.')
  })

  it('magnitudeOf 保真显示文本，不规范化小数点形态', () => {
    expect(magnitudeOf('-38.50')).toBe('38.50')
    expect(magnitudeOf('+38.50')).toBe('38.50')
    expect(magnitudeOf('12.')).toBe('12.')
    expect(magnitudeOf('-12.')).toBe('12.')
    expect(magnitudeOf('38.50')).toBe('38.50')
  })

  it('往返恒等：amount → 方向+幅值 → amount 不改变真值', () => {
    for (const amount of ROUNDTRIP_AMOUNTS) {
      const row: AdvancedRow = { accountId: 1, amount, commodity: 'CNY' }
      const restored = signAmount(amountDirection(row.amount), magnitudeOf(row.amount))
      expect(restored, amount).toBe(amount)
    }
  })
})

describe('空值防御：新增分录清空 / 未填 / 非法值', () => {
  it('signAmount 空幅值永不产生裸符号串（裸 "-" 曾使 bean 预览抛 RangeError）', () => {
    expect(signAmount('debit', '')).toBe('')
    expect(signAmount('credit', '')).toBe('')
    expect(signAmount('credit', '-')).toBe('')
    expect(signAmount('debit', '--')).toBe('')
    expect(signAmount('credit', '+-')).toBe('')
    expect(signAmount('credit', undefined as unknown as string)).toBe('')
    expect(signAmount('debit', null as unknown as string)).toBe('')
  })

  it('magnitudeOf / amountDirection 对非 string 输入兜底', () => {
    expect(magnitudeOf(undefined as unknown as string)).toBe('')
    expect(magnitudeOf(null as unknown as string)).toBe('')
    expect(amountDirection(undefined as unknown as string)).toBe('debit')
    expect(amountDirection(null as unknown as string)).toBe('debit')
    // 空幅值往返仍为空，不会被赋成非法符号串。
    expect(signAmount(amountDirection(''), magnitudeOf(''))).toBe('')
  })

  it('合法定点串的往返恒等不被空值修复破坏', () => {
    for (const amount of ['38.50', '-38.50', '-0.00', '12.']) {
      expect(signAmount(amountDirection(amount), magnitudeOf(amount)), amount).toBe(amount)
    }
  })
})
