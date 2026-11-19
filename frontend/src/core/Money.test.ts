import { describe, expect, it } from 'vitest'

import { Money, formatAmount, formatCompact, formatMoney } from './Money'

describe('Money 定点金额', () => {
  it('detail: -0.001 舍入后归一为 0.00，不出现负零', () => {
    expect(formatAmount('-0.001')).toBe('0.00')
    expect(Money.from('-0.001').toString()).toBe('0.00')
  })

  it('detail: 0.005 按 ROUND_HALF_UP 进位为 0.01', () => {
    expect(formatAmount('0.005')).toBe('0.01')
    expect(Money.from('0.005').toString()).toBe('0.01')
  })

  it('detail: 1e21 量级不输出指数记数法', () => {
    const money = Money.from('1000000000000000000000')
    expect(money.toString()).toBe('1000000000000000000000.00')
    expect(money.formatAmount()).toBe('1,000,000,000,000,000,000,000.00')
  })

  it('detail: 大额千分位', () => {
    expect(formatAmount('1234567.891')).toBe('1,234,567.89')
    expect(formatAmount('123456789.5')).toBe('123,456,789.50')
  })

  it('detail: 负号前置到币种符号之前，金额本体取绝对值', () => {
    expect(formatMoney('-1234.5', 'CNY')).toBe('-¥ 1,234.50')
    expect(formatMoney('1234.5', 'USD', { signed: true })).toBe('+$ 1,234.50')
    expect(formatMoney('-1234.5', 'XYZ')).toBe('-1,234.50 XYZ')
  })

  it('detail: 展示为零时不显示任何符号', () => {
    expect(formatMoney('-0.001', 'CNY')).toBe('¥ 0.00')
    expect(formatMoney('0.001', 'CNY', { signed: true })).toBe('¥ 0.00')
  })

  it('detail: 构造只接受普通十进制字符串', () => {
    expect(() => Money.from('1e21')).toThrow(RangeError)
    expect(() => Money.from('abc')).toThrow(RangeError)
    expect(Money.from(' 12.30 ').toString()).toBe('12.30')
  })

  it('detail: 不可变运算', () => {
    const a = Money.from('0.10')
    const b = Money.from('0.20')
    expect(a.plus(b).toString()).toBe('0.30')
    expect(a.minus(b).toString()).toBe('-0.10')
    expect(a.negated().toString()).toBe('-0.10')
    expect(a.abs().toString()).toBe('0.10')
    expect(a.isZero()).toBe(false)
    expect(Money.zero().isZero()).toBe(true)
  })
})

describe('Money.div 定点除法', () => {
  it('两位小数 HALF_UP 舍入', () => {
    expect(Money.from('10.00').div(3).toString()).toBe('3.33')
    // 5.005 → 5.01（二进制浮点会得到 5.00，定点必须 5.01）
    expect(Money.from('10.01').div(2).toString()).toBe('5.01')
    expect(Money.from('0.01').div(3).toString()).toBe('0.00')
  })

  it('负数按远离零进位，负零归一', () => {
    expect(Money.from('-10.01').div(2).toString()).toBe('-5.01')
    expect(Money.from('-0.01').div(3).toString()).toBe('0.00')
    expect(Money.from('-0.004').div(1).toString()).toBe('0.00')
  })

  it('分母非法一律抛错，不静默兜底', () => {
    expect(() => Money.from('1.00').div(0)).toThrow(RangeError)
    expect(() => Money.from('1.00').div(Number.NaN)).toThrow(RangeError)
    expect(() => Money.from('1.00').div(Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })

  it('大额不丢精度（不经过浮点）', () => {
    expect(Money.from('123456789.99').div(3).toString()).toBe('41152263.33')
  })
})

describe('formatCompact 金额简写', () => {
  it('千元以下取整，不带符号不带千分位', () => {
    expect(formatCompact('864.00')).toBe('864')
    expect(formatCompact('-967.00')).toBe('-967')
    expect(formatCompact('0.00')).toBe('0')
    expect(formatCompact('999.40')).toBe('999')
  })

  it('k 档一位小数，去掉尾巴 .0', () => {
    expect(formatCompact('-1200.00')).toBe('-1.2k')
    expect(formatCompact('1000.00')).toBe('1k')
    expect(formatCompact('15000.00')).toBe('1.5w')
  })

  it('w 档一位小数，十万位整数化', () => {
    expect(formatCompact('12500.00')).toBe('1.3w')
    expect(formatCompact('120000.00')).toBe('12w')
    expect(formatCompact('-388550.00')).toBe('-38.9w')
  })

  it('进位跨档复核：999.95 → 1k 而不是 1000', () => {
    expect(formatCompact('999.95')).toBe('1k')
  })

  it('signed 只给正数加 +，零不加', () => {
    expect(formatCompact('18500.00', { signed: true })).toBe('+1.9w')
    expect(formatCompact('0.00', { signed: true })).toBe('0')
    expect(formatCompact('-1200.00', { signed: true })).toBe('-1.2k')
  })

  it('不可解析串回落 0', () => {
    expect(formatCompact('abc')).toBe('0')
    expect(formatCompact('')).toBe('0')
  })
})
