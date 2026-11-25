/**
 * 0.6.0 S4 余额校准前端金额与文案工具（AC-3.1 / AC-3.7）。
 *
 * 金额一律走 core/Money.ts 的 Money（decimal.js 定点十进制、ROUND_HALF_UP），
 * 禁止 JS 裸 `+` / `-`；差额、展示、符号判断全部在这里收口。
 */
import { formatAmount, Money } from '@/core/Money'
import { t } from '../i18n'

/** 普通十进制字符串（允许可选正负号，不接受指数记数法）。 */
const PLAIN_DECIMAL_RE = /^[+-]?\d+(?:\.\d+)?$/

/** 判断是否为合法定点十进制字符串。 */
export function isPlainDecimal(value: string): boolean {
  return PLAIN_DECIMAL_RE.test(value.trim())
}

/** 差额 = 目标 − 截至 D 日初累计（定点运算，禁浮点）。 */
export function balanceDiff(cumulative: string, target: string): string {
  if (!isPlainDecimal(cumulative) || !isPlainDecimal(target)) {
    throw new Error('金额必须为定点十进制字符串')
  }
  return Money.from(target.trim()).minus(Money.from(cumulative.trim())).toString()
}

/** 差额展示：正数显式带 +，零与负数不带额外符号。 */
export function signedDiff(diff: string): string {
  const value = Money.from(diff)
  if (value.isZero() || value.isDisplayZero()) {
    return '0.00'
  }
  if (value.isNegative()) {
    return value.formatAmount()
  }
  return `+${value.formatAmount()}`
}

/**
 * 预检统一文案（AC-3.1）：
 * 「截至 D 日初（前一日日终）当前累计 X / 目标 Y / 将自动补记 ±差额」。
 */
export function previewText(
  asOfDate: string,
  cumulative: string,
  target: string,
): string {
  return t('core.balance.preview', {
    date: asOfDate,
    current: formatAmount(cumulative),
    target: formatAmount(target),
    diff: signedDiff(balanceDiff(cumulative, target)),
  })
}

/** D 之后是否已有交易（AC-3.7：二次确认需提示「会改变 D 之后的所有余额」）。 */
export function hasTransactionsAfter(asOfDate: string, dates: string[]): boolean {
  for (const date of dates) {
    if (date > asOfDate) {
      return true
    }
  }
  return false
}
