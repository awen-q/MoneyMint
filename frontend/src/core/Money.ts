/**
 * 金额封装（E-01）
 *
 * 口径与旧版 `frontend/lib/utils/money.dart` 对齐：
 * - 金额一律为定点十进制字符串，禁止 JS 浮点参与运算或存储；
 * - 内部 Decimal 实例不对外暴露，构造只接受普通十进制字符串（不接受 1e21 之类指数记数法）；
 * - `toString()` 固定两位小数，绝不输出指数记数法；
 * - 展示层负号前置到币种符号之前，金额本体始终取绝对值，避免 `-¥ -1,234.50`。
 */
import Decimal from 'decimal.js'

// 全局精度与舍入：28 位有效数字 + 四舍五入（与旧版 package:decimal 展示一致）。
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP })

/** 普通十进制字符串（允许可选正负号，不接受指数记数法）。 */
const PLAIN_DECIMAL_RE = /^[+-]?\d+(?:\.\d+)?$/

/** 常见币种的显示符号；未知币种返回空串（直接显示代码）。 */
export function currencySymbol(commodity: string): string {
  switch (commodity) {
    case 'CNY':
      return '¥'
    case 'USD':
      return '$'
    case 'EUR':
      return '€'
    case 'JPY':
      return '¥'
    case 'GBP':
      return '£'
    case 'HKD':
      return 'HK$'
    default:
      return ''
  }
}

/** 千分位分组（只接受非负整数部分）。 */
function groupThousands(digits: string): string {
  let out = ''
  let count = 0
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    if (count > 0 && count % 3 === 0) {
      out = `,${out}`
    }
    out = `${digits[i]}${out}`
    count += 1
  }
  return out
}

/** 把非负 Decimal 格成「千分位 + 两位小数」。 */
function formatMagnitude(value: Decimal): string {
  const [intPart, decPart] = value.abs().toFixed(2).split('.')
  return `${groupThousands(intPart)}.${decPart}`
}

/** 宽松解析：无法解析的输入按 0 处理（与旧版 formatAmount 行为一致）。 */
function parseOrZero(amount: string): Decimal {
  const trimmed = amount.trim()
  if (!PLAIN_DECIMAL_RE.test(trimmed)) {
    return new Decimal(0)
  }
  return new Decimal(trimmed)
}

/** 把定点十进制字符串格式化为带千分位、两位小数的展示串（保留符号）。 */
export function formatAmount(amount: string): string {
  const value = parseOrZero(amount)
  const magnitude = formatMagnitude(value)
  const negative = value.isNeg() && magnitude !== '0.00'
  return `${negative ? '-' : ''}${magnitude}`
}

export interface FormatMoneyOptions {
  /** 正数是否显式加 `+`（零不显示符号）。 */
  signed?: boolean
}

/** 去掉定点串末尾的 `.0`（`1.0` → `1`），保证不出现 `1.0k` 这种别扭写法。 */
function trimTrailingZero(fixed: string): string {
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed
}

/**
 * 简写金额（日历格 / 坐标轴专用）：不带币种符号、不带千分位。
 *
 * 档位：`< 1000` 取整元；`1000 ~ 9999.99` 一位小数 + `k`；`>= 10000` 一位小数 + `w`。
 * 进位跨档会复核：`999.95` 先舍入成 `1000`，输出 `1k` 而不是 `1000`。
 *
 * **只用于展示，调用方不得把结果 parse 回金额。**
 */
export function formatCompact(
  amount: string,
  options: FormatMoneyOptions = {},
): string {
  const value = parseOrZero(amount)
  const abs = value.abs()
  const negative = value.isNeg() && !abs.isZero()

  let body: string
  if (abs.gte(10000)) {
    body = `${trimTrailingZero(
      abs.div(10000).toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toFixed(1),
    )}w`
  } else if (abs.gte(1000)) {
    body = `${trimTrailingZero(
      abs.div(1000).toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toFixed(1),
    )}k`
  } else {
    const rounded = abs.toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    if (rounded.gte(1000)) {
      // 999.95 → 1000，落回 k 档
      body = '1k'
    } else {
      body = rounded.toFixed(0)
    }
  }

  const isDisplayZero = body === '0'
  if (negative && !isDisplayZero) return `-${body}`
  if (options.signed && !isDisplayZero) return `+${body}`
  return body
}

/**
 * 完整展示：符号 + 金额（+ 可选币种代码）。
 * 已知币种如 `-¥ 1,234.50`；未知币种如 `-1,234.50 XYZ`。
 */
export function formatMoney(
  amount: string,
  commodity: string,
  options: FormatMoneyOptions = {},
): string {
  return formatMoneyValue(parseOrZero(amount), commodity, options)
}

/** 已解析 Decimal 的格式化实现（避免大数经 toString() 变成指数记数法）。 */
function formatMoneyValue(
  value: Decimal,
  commodity: string,
  options: FormatMoneyOptions = {},
): string {
  const symbol = currencySymbol(commodity)
  const magnitude = formatMagnitude(value)
  const body = symbol !== '' ? `${symbol} ${magnitude}` : magnitude

  const isDisplayZero = magnitude === '0.00'
  const isNegative = value.isNeg() && !isDisplayZero
  const isPositive = value.isPos() && !isDisplayZero
  const sign = isNegative ? '-' : options.signed && isPositive ? '+' : ''
  const result = `${sign}${body}`

  if (symbol === '' && commodity !== '') {
    return `${result} ${commodity}`
  }
  return result
}

/**
 * 金额值对象。
 *
 * 构造只接受 string（`Money.from`），内部 Decimal 私有，避免外部绕过定点规则。
 */
export class Money {
  private readonly amount: Decimal

  private constructor(amount: Decimal) {
    this.amount = amount
  }

  /** 从普通十进制字符串构造；非法或指数记数法直接抛错。 */
  static from(input: string): Money {
    const trimmed = input.trim()
    if (!PLAIN_DECIMAL_RE.test(trimmed)) {
      throw new RangeError(`非法金额字符串（只接受普通十进制）: ${input}`)
    }
    return new Money(new Decimal(trimmed))
  }

  /** 零值。 */
  static zero(): Money {
    return new Money(new Decimal(0))
  }

  /** 固定两位小数，永不输出指数记数法；负零归一为 0.00。 */
  toString(): string {
    const fixed = this.amount.toFixed(2)
    return fixed === '-0.00' ? '0.00' : fixed
  }

  /** 绝对值。 */
  abs(): Money {
    return new Money(this.amount.abs())
  }

  /** 取反。 */
  negated(): Money {
    return new Money(this.amount.negated())
  }

  /** 相加（另一侧必须是 Money，禁止裸字符串混算）。 */
  plus(other: Money): Money {
    return new Money(this.amount.plus(other.amount))
  }

  /** 相减。 */
  minus(other: Money): Money {
    return new Money(this.amount.minus(other.amount))
  }

  /**
   * 定点乘法（金额运算入口）：只接受 Money，结果按两位小数 HALF_UP 收敛到「分」。
   *
   * 与下方 `div(number)` 的「仅供展示、禁止回写交易金额」约束不同，本方法专供
   * 键盘表达式（§5-E）等**可回写金额**的场景；两侧都是 Money，杜绝裸数字混算。
   */
  times(other: Money): Money {
    return new Money(
      this.amount.times(other.amount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
    )
  }

  /**
   * 定点除法（金额运算入口）：只接受 Money 作除数，结果按两位小数 HALF_UP 收敛。
   *
   * 除数为 0 时抛 RangeError（文案含「除数不能为 0」），绝不静默返回 0 / NaN。
   * 与 `div(number)` 的展示聚合口径彼此独立：本方法是表达式求值唯一合法的金额
   * 除法路径，调用方无需（也不得）改用 `div(number)` 绕过约束。
   */
  dividedBy(other: Money): Money {
    if (other.isZero()) {
      throw new RangeError('除数不能为 0')
    }
    return new Money(
      this.amount.div(other.amount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
    )
  }

  /** 按两位小数 HALF_UP 量化为「分」口径（顺序求值每步收敛精度用）。 */
  rounded(): Money {
    return new Money(this.amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP))
  }

  /**
   * 定点除法（**仅供展示聚合使用**：日均、环比占比的分子分母）。
   *
   * 舍入固定两位 HALF_UP（负数按「远离零」进位），与全站金额口径一致。
   * 结果**禁止回写交易金额**——账芯不接受派生值。
   *
   * @param divisor 非零有限数，否则抛 RangeError（静默兜底会掩盖分母算错）
   */
  div(divisor: number): Money {
    if (!Number.isFinite(divisor) || divisor === 0) {
      throw new RangeError(`divisor 必须为非零有限数，收到: ${String(divisor)}`)
    }
    return new Money(
      this.amount.div(divisor).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
    )
  }

  /** 是否为 0（按原始值判断，不做展示舍入）。 */
  isZero(): boolean {
    return this.amount.isZero()
  }

  /** 是否严格小于 0（不做展示舍入）。 */
  isNegative(): boolean {
    return this.amount.isNeg()
  }

  /** 按两位小数展示判断是否为零（-0.001 视为 0.00）。 */
  isDisplayZero(): boolean {
    return this.amount.abs().toFixed(2) === '0.00'
  }

  /** 按两位小数展示的金额（千分位、保留符号）。 */
  formatAmount(): string {
    const magnitude = formatMagnitude(this.amount)
    const negative = this.amount.isNeg() && magnitude !== '0.00'
    return `${negative ? '-' : ''}${magnitude}`
  }

  /** 按两位小数展示的完整金额（符号前置、金额取绝对值）。 */
  formatMoney(commodity: string, options: FormatMoneyOptions = {}): string {
    return formatMoneyValue(this.amount, commodity, options)
  }
}
