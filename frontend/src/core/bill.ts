/**
 * 账单页聚合层（B2，纯逻辑）
 *
 * 现网 `TransactionsView.vue` 把「按日分桶、日历格四态、月合计」散在模板与
 * computed 里；B2 账单页要复用同一套口径，本模块把它收敛成三个纯函数：
 *
 * - `monthTotals`：当月合计（支出 / 收入 / 结余 / 笔数）；
 * - `daySeries`：逐日序列，**长度恒为当月天数**（日历格按 index 取）；
 * - `billCells`：每个日历格该显示什么（四态 + 主数字 + 收入圆点 + 读屏文案）。
 *
 * 口径（与 `core/calendar.ts` 的 `dailyTotals` 同源，勿各自演化）：
 *
 * **符号口径来自后端写入路径（取证，非推测）**：
 * ```
 * internal/server/opening_http_test.go:358-361   Assets:Cash -10.00 / Expenses:Food +10.00
 * internal/service/imports_test.go:310-313       Assets:Cash +5000 / Income:Salary  -5000
 * internal/export/beancount_test.go:70           Expenses:Food 10.00 CNY
 * ```
 * 即 Beancount「借方为正」：**Expenses 为正、Income 为负**。前端现网实现同口径
 * （`core/calendar.ts` 的 `dailyTotals` `:56-72`、`core/reports.ts` 的
 * `incomeExpenseTotals` `:263-281`：`income = value.negated()`、`expense = value`）。
 * 若有人给出反向公式（如 `expense = Σ(−Expenses)`），以本节取证为准 —— 反向
 * 会让 expense / income 双双为负。
 *
 * 1. **分录级判定**：`Expenses` 根账户的分录金额原值计入支出桶（借方为正）；
 *    `Income` 根账户的分录金额**取反**计入收入桶（fava 口径下 Income 为负，
 *    取反后对外恒为正数）；Assets / Liabilities / Equity 分录不计入收支 ——
 *    转账没有收支分录，天然被排除，期初（Equity）同理。
 * 2. **只累计指定币种**：页面即使忘记过滤，也不会把 USD 分录混进 CNY 合计
 *    （双保险，不是冗余）。
 * 3. **账户类型取自 `posting.account` 的根段**，不依赖账户列表：后端
 *    `ValidateAccountName`（internal/service/account.go）保证账户全名的根段
 *    必为 Assets/Liabilities/Equity/Income/Expenses 之一且与 type 一致，
 *    因此根段判定与「按 type 查账户」等价，且在账户列表尚未加载时也成立。
 * 4. **金额一律走 `core/Money`**（Decimal 定点），禁止 parseFloat / 裸算术。
 *
 * 纯逻辑约束：零 Vue / 零 store / 零 DOM，只依赖 `core/Money` 与 `api/types` 的类型。
 */
import { t } from '@/i18n'

import { Money, formatCompact } from './Money'
import type { TransactionView } from '../api/types'

/** 当月合计（各字段均为固定两位定点串，count 为该币种的交易笔数）。 */
export interface BillMonthTotals {
  /** 支出合计，**正数**（对外不出现负的支出）。 */
  expense: string
  /** 收入合计，**正数**。 */
  income: string
  /** 结余 = income − expense，可能为负。 */
  balance: string
  /** 该币种下的**交易笔数**（去重 txn，不是分录数）。 */
  count: number
}

/** 逐日序列中的一天。 */
export interface BillDayPoint {
  /** 1..31 */
  day: number
  expense: string
  income: string
  count: number
}

/** 日历格四态。 */
export type BillCellKind = 'both' | 'income-only' | 'expense-only' | 'empty'

/** 单个日历格的渲染数据（页面只摆格子，判断全在这里）。 */
export interface BillCell {
  day: number
  kind: BillCellKind
  /** 主数字，已带符号；`empty` 时为 `''`。`both` 仍只给支出侧。 */
  text: string
  /** 收入侧简写数字（加法字段）；仅 `both` / `income-only` 有值，其余为 `undefined`。 */
  incomeText?: string
  /** `kind === 'both'` 时为 true（右上角 4px 收入圆点）。 */
  incomeDot: boolean
  /** 读屏精确值（两位小数，不走 compact）；`empty` 时为「N月D日，无收支」。 */
  ariaLabel: string
}

/** Beancount 五大根类别中与收支相关的两个（其余根一律不计入收支）。 */
const ROOT_EXPENSES = 'Expenses'
const ROOT_INCOME = 'Income'

/** 年份 / 月份的合法区间（与 `stores/period.ts` 的归一规则保持一致）。 */
const MIN_YEAR = 1970
const MAX_YEAR = 9999

/**
 * 取账户全名的根段（`Expenses:Food:Drink` → `Expenses`）。
 * 没有 `:` 时返回原串（不会匹配收支根，属未知账户）。
 */
function accountRoot(account: string): string {
  const index = account.indexOf(':')
  return index < 0 ? account : account.slice(0, index)
}

/** 定点串 → Money；非法金额按 0 处理（与 `calendar.ts` 的 addMoney 同口径）。 */
function moneyOf(amount: string): Money {
  try {
    return Money.from(amount)
  } catch {
    return Money.zero()
  }
}

/**
 * 负值归零：对外不展示「负的支出 / 负的收入」。
 *
 * 展示层归零：当日 Expenses 净额为负（纯退款）时按 0 计。
 * 这是**展示口径**，不是数据修正 —— 原始分录未被改动，回款金额在搜索结果 /
 * 导出里仍可见。不搬进收入桶：跨桶补偿会破坏「收支两条线可勾稽」。
 */
function positiveOf(value: Money): Money {
  return value.isNegative() ? Money.zero() : value
}

/** 按日累计的单日桶（内部结构，不对外）。 */
interface DayBucket {
  expense: Money
  income: Money
  count: number
}

/**
 * 按日累计（**唯一**的累加入口：`monthTotals` / `daySeries` / `billCells`
 * 三者都从它派生，因此天然勾稽，不存在「三处各算一遍算出三个数」）。
 *
 * - `count` 记录「含至少一条该币种分录的交易」笔数，同一笔多分录只算 1 次；
 *   转账 / 期初等无收支分录的交易**仍计入笔数**（账单页的「共 N 笔」对应
 *   下方真实行数，不是「收支笔数」）。
 * - 日期非法（非 `YYYY-MM-DD`）的交易整体跳过，避免落到不存在的日桶里
 *   造成「合计包含了、日历上看不到」的静默错账。
 */
function accumulate(
  txns: readonly TransactionView[],
  commodity: string,
): Map<number, DayBucket> {
  const byDay = new Map<number, DayBucket>()
  for (const txn of txns) {
    const day = Number(txn.date.slice(8, 10))
    if (!Number.isSafeInteger(day) || day < 1 || day > 31) {
      continue
    }
    let matched = false
    for (const posting of txn.postings) {
      if (posting.commodity === commodity) {
        matched = true
        break
      }
    }
    if (!matched) {
      continue
    }
    let bucket = byDay.get(day)
    if (bucket === undefined) {
      bucket = { expense: Money.zero(), income: Money.zero(), count: 0 }
      byDay.set(day, bucket)
    }
    bucket.count += 1
    for (const posting of txn.postings) {
      if (posting.commodity !== commodity) {
        continue
      }
      const root = accountRoot(posting.account)
      if (root === ROOT_EXPENSES) {
        bucket.expense = bucket.expense.plus(moneyOf(posting.amount))
      } else if (root === ROOT_INCOME) {
        // Income 分录在 fava 口径下为负，取反后收入对外恒为正。
        bucket.income = bucket.income.plus(moneyOf(posting.amount).negated())
      }
    }
  }
  return byDay
}

/** 归一日历用的年月（非法输入夹到合法区间，避免 `getDate()` 返回 NaN）。 */
function normalizeYear(year: number): number {
  if (!Number.isFinite(year)) {
    return MIN_YEAR
  }
  const value = Math.trunc(year)
  if (value < MIN_YEAR) {
    return MIN_YEAR
  }
  return value > MAX_YEAR ? MAX_YEAR : value
}

/** 归一月份到 1..12（与 `stores/period.ts` 同口径）。 */
function normalizeMonth(month: number): number {
  if (!Number.isFinite(month)) {
    return 1
  }
  const value = Math.trunc(month)
  if (value < 1) {
    return 1
  }
  return value > 12 ? 12 : value
}

/**
 * 当月天数。
 *
 * **这是标准技巧，不是 off-by-one**：JS 的 `Date` 构造器 monthIndex 从 0 开始，
 * `new Date(year, month, 0)` 取的是「下个月的第 0 天」= **本月最后一天**，
 * 因此传 1-12 语义的 `month` 时无需 `-1`，闰年 2 月（2028-02 = 29 天）
 * 由 Date 自动处理，不必手写闰年判断。
 */
function daysInMonth(year: number, month: number): number {
  return new Date(normalizeYear(year), normalizeMonth(month), 0).getDate()
}

/**
 * 当月合计。
 *
 * 月合计**不是**「先加总再归零」，而是「**逐日归零后累加**」—— 复用与
 * `daySeries` 完全同一份日桶、同一套归零规则。否则「day1 支出 100 + day2 纯退款
 * 50」会得到月合计 50，而日历格加起来 100（两处都看似合理，却对不上）。
 * 因此 `Σ daySeries[i].expense === monthTotals.expense` 由结构保证 —— 这是
 * 「日历格子加起来不等于顶上合计」那类缺陷的结构性防线。
 *
 * 退款（支出分录为负）会自然冲减当日支出；若某日净额为负（当日纯退款），
 * 该日支出按 0 计（对外不出现负支出，见 `positiveOf` 的展示口径说明），
 * 因此**该笔退款不会跨日补偿**，也不会被搬进收入桶。
 */
export function monthTotals(
  txns: readonly TransactionView[],
  commodity: string,
): BillMonthTotals {
  const byDay = accumulate(txns, commodity)
  let expense = Money.zero()
  let income = Money.zero()
  let count = 0
  byDay.forEach((bucket) => {
    expense = expense.plus(positiveOf(bucket.expense))
    income = income.plus(positiveOf(bucket.income))
    count += bucket.count
  })
  return {
    expense: expense.toString(),
    income: income.toString(),
    balance: income.minus(expense).toString(),
    count,
  }
}

/**
 * 逐日序列：长度**恒为当月天数**，无交易的日给 `'0.00'` / `0`。
 *
 * 日历格要按 index 取（第 1 格 = 1 号），所以不能只返有数据的日。
 */
export function daySeries(
  txns: readonly TransactionView[],
  year: number,
  month: number,
  commodity: string,
): BillDayPoint[] {
  const byDay = accumulate(txns, commodity)
  const total = daysInMonth(year, month)
  const points: BillDayPoint[] = []
  for (let day = 1; day <= total; day += 1) {
    const bucket = byDay.get(day)
    points.push({
      day,
      expense: positiveOf(bucket === undefined ? Money.zero() : bucket.expense).toString(),
      income: positiveOf(bucket === undefined ? Money.zero() : bucket.income).toString(),
      count: bucket === undefined ? 0 : bucket.count,
    })
  }
  return points
}

/** 支出主数字：取负后交给 formatCompact，由它输出 `-967` 这类字符串。 */
function expenseText(expense: string): string {
  return formatCompact(Money.from(expense).negated().toString(), { signed: true })
}

/** 收入主数字：`+1.8k` 这类字符串。 */
function incomeText(income: string): string {
  return formatCompact(income, { signed: true })
}

/**
 * 日历格四态：`text` 是主数字，`incomeText` 是同日双有时第二行的收入数字。
 *
 * `both` 的 `text` 仍**只给支出侧**（`-967`，老断言与调用方口径不动）；收入另放
 * `incomeText`，由渲染层决定第二行是否显示。右上角 4px 圆点保留作快速扫描标记，
 * 精确两位小数仍由 `ariaLabel` 给全（隐私遮挡时圆点与第二行一起隐藏）。
 *
 * | kind | 条件 | text | incomeText |
 * |---|---|---|---|
 * | `both` | expense > 0 且 income > 0 | 支出侧 `-967` | 收入侧 `+1.9w` |
 * | `expense-only` | expense > 0、income = 0 | `-967` | — |
 * | `income-only` | expense = 0、income > 0 | `+1.8k` | `+1.8k`（incomeText 同值） |
 * | `empty` | 皆 0 | `''` | — |
 *
 * 「为 0」按**展示精度**判断（`isDisplayZero()`，即两位小数舍入后为 0），
 * 否则 `0.001` 这种舍入后显示 `0` 的日会被判成 `expense-only`、格子里出现
 * 一个孤零零的 `0`。
 */
export function billCells(
  txns: readonly TransactionView[],
  year: number,
  month: number,
  commodity: string,
): BillCell[] {
  const series = daySeries(txns, year, month, commodity)
  const monthLabel = normalizeMonth(month)
  const cells: BillCell[] = []
  for (const point of series) {
    const hasExpense = !Money.from(point.expense).isDisplayZero()
    const hasIncome = !Money.from(point.income).isDisplayZero()
    let kind: BillCellKind = 'empty'
    if (hasExpense && hasIncome) {
      kind = 'both'
    } else if (hasExpense) {
      kind = 'expense-only'
    } else if (hasIncome) {
      kind = 'income-only'
    }
    let text = ''
    if (kind === 'both' || kind === 'expense-only') {
      text = expenseText(point.expense)
    } else if (kind === 'income-only') {
      text = incomeText(point.income)
    }
    // 读屏文案同样走字典（访问时求值）：日期图案 + 该日四态。
    const dateLabel = t('bills.dayPlain', { month: String(monthLabel), day: String(point.day) })
    let ariaLabel = t('bills.ariaNoAmount', { date: dateLabel })
    if (kind === 'both') {
      ariaLabel = t('bills.ariaBoth', {
        date: dateLabel,
        income: point.income,
        expense: point.expense,
      })
    } else if (kind === 'income-only') {
      ariaLabel = t('bills.ariaIncome', { date: dateLabel, income: point.income })
    } else if (kind === 'expense-only') {
      ariaLabel = t('bills.ariaExpense', { date: dateLabel, expense: point.expense })
    }
    const cell: BillCell = {
      day: point.day,
      kind,
      text,
      incomeDot: kind === 'both',
      ariaLabel,
    }
    // 加法字段：复用同一个 incomeText() 简写口径，主数字 text 一行未改。
    if (kind === 'both' || kind === 'income-only') {
      cell.incomeText = incomeText(point.income)
    }
    cells.push(cell)
  }
  return cells
}
