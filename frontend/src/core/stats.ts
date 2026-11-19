/**
 * 统计账单页聚合层（B4 / T40，纯逻辑）
 *
 * 与 `core/reports.ts` / `core/bill.ts` 同源的三条铁律：
 * 1. **显式携带 commodity 维度**，禁跨币种求和、禁折算单值；
 * 2. 收支一律**分录级**、按账户 type 判定（转账 / 期初天然不计入）；
 * 3. 金额只走 `core/Money`（Decimal 定点），`ratio` 仅用于绘图宽度。
 *
 * 本模块**不重复实现**「收支分录判定」：逐日 / 逐标签的收支都复用
 * `reports.incomeExpenseTotals`，保证与报表页、账单页的符号口径只有一份实现。
 */
import { Money } from './Money'
import { elapsedDays } from './calendar'
import { incomeExpenseTotals, type ReportTxn } from './reports'
import type { SummaryAccount } from './record'

/** 收支三件套（定点串；`balance = income − expense`，可能为负）。 */
export interface StatsTotals {
  income: string
  expense: string
  balance: string
  /** 该币种的交易笔数（去重 txn，含转账 / 期初，与账单页 `count` 同口径）。 */
  count: number
}

/**
 * 日均（分母是「已过天数」，见 `calendar.elapsedDays`）。
 *
 * `elapsedDays === 0`（**未来月**）时返回 `0.00` 且 `applicable = false`：
 * 显式判断除零，绝不把 `Infinity` / `NaN` 泄漏到 UI。展示层据此显示「—」。
 */
export interface AveragePerDay extends StatsTotals {
  /** 分母：已过天数；未来月为 0。 */
  elapsedDays: number
  /** 分母是否为 0（未来月），false 时三个金额都无意义。 */
  applicable: boolean
}

/** 一天一行（`day` 为 1..当月天数）。 */
export interface DailyRow {
  day: number
  /** `YYYY-MM-DD`。 */
  date: string
  income: string
  expense: string
  balance: string
  /** 当日是否有任何收支（false 时单元格显示「—」而不是 `¥0.00`）。 */
  hasData: boolean
  /** 当日该币种的交易笔数。 */
  count: number
}

/** 每日明细表所需的全量数据。 */
export interface DailyTable {
  /** 恒为整月天数（表要逐日列出，空格用「—」）。 */
  rows: DailyRow[]
  /** 总计（展示在卡头右侧，不放 tfoot）。 */
  total: StatsTotals
  /** 日均（tfoot 唯一的一行）。 */
  average: AveragePerDay
  /** 已过天数（未来月为 0）。 */
  elapsedDays: number
  /** 是否本月（用于「本月未完」提示）。 */
  isCurrentMonth: boolean
}

function moneyOf(amount: string): Money {
  try {
    return Money.from(amount)
  } catch {
    return Money.zero()
  }
}

function twoDigits(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** 某月天数（Date 溢出法：传下个月第 0 天 = 本月最后一天）。 */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

/** 该币种的交易笔数（含转账 / 期初；与 `bill.ts` / `search.ts` 同口径）。 */
export function txnCount(txns: readonly ReportTxn[], commodity: string): number {
  let count = 0
  for (const txn of txns) {
    for (const posting of txn.postings) {
      if (posting.commodity === commodity) {
        count += 1
        break
      }
    }
  }
  return count
}

/** 收入 / 支出 / 结余 / 笔数（一次遍历拿到四件套，供五指标卡使用）。 */
export function statsTotals(
  txns: readonly ReportTxn[],
  accounts: SummaryAccount[],
  commodity: string,
): StatsTotals {
  // `incomeExpenseTotals` 的入参是非 readonly 数组（历史签名），这里复制一层；
  // 复制成本可忽略（月级数据量），比改共用签名安全。
  const totals = incomeExpenseTotals(txns.slice(), accounts, commodity)
  const income = moneyOf(totals.income)
  const expense = moneyOf(totals.expense)
  return {
    income: income.toString(),
    expense: expense.toString(),
    balance: income.minus(expense).toString(),
    count: txnCount(txns, commodity),
  }
}

/**
 * 日均：`total / elapsedDays`（定点除法，两位小数 HALF_UP）。
 *
 * 分母为 0（未来月）→ 三个金额都是 `0.00`、`applicable = false`；
 * `count` 不参与除法（笔数是整数计数，日均笔数无业务含义），原样返回。
 */
export function averagePerDay(totals: StatsTotals, elapsed: number): AveragePerDay {
  if (!Number.isFinite(elapsed) || elapsed <= 0) {
    return {
      income: '0.00',
      expense: '0.00',
      balance: '0.00',
      count: totals.count,
      elapsedDays: 0,
      applicable: false,
    }
  }
  const income = moneyOf(totals.income)
  const expense = moneyOf(totals.expense)
  return {
    income: income.div(elapsed).toString(),
    expense: expense.div(elapsed).toString(),
    balance: income.minus(expense).div(elapsed).toString(),
    count: totals.count,
    elapsedDays: elapsed,
    applicable: true,
  }
}

/**
 * 每日明细（T44 的数据源）：恒为整月逐日，总计与日均一并给出。
 *
 * - **逐日**：只用该日的交易调 `incomeExpenseTotals`（复用唯一一份收支判定）；
 * - **总计**：直接对整月调用一次（而不是把逐日加起来）—— 两者应当相等，
 *   但那由 `stats.test.ts` 的勾稽用例来保证，页面不需要自己再 reduce 一遍；
 * - **日均**：分母用 `elapsedDays`（往月 = 整月、当月 = 今天几号、未来月 = 0）。
 */
export function dailyRows(
  txns: readonly ReportTxn[],
  accounts: SummaryAccount[],
  year: number,
  month: number,
  commodity: string,
  today: Date,
): DailyTable {
  const total = daysInMonth(year, month)
  const byDay: ReportTxn[][] = []
  for (let day = 0; day <= total; day += 1) {
    byDay.push([])
  }
  for (const txn of txns) {
    const day = Number(txn.date.slice(8, 10))
    if (!Number.isSafeInteger(day) || day < 1 || day > total) {
      continue
    }
    byDay[day].push(txn)
  }
  // 笔数按「含该币种分录的交易」计（与 statsTotals / bill / search 同口径）。
  const counts: number[] = []
  for (let day = 0; day <= total; day += 1) {
    counts.push(txnCount(byDay[day], commodity))
  }

  const rows: DailyRow[] = []
  for (let day = 1; day <= total; day += 1) {
    const dayTxns = byDay[day]
    const totals = incomeExpenseTotals(dayTxns, accounts, commodity)
    const income = moneyOf(totals.income)
    const expense = moneyOf(totals.expense)
    rows.push({
      day,
      date: `${year}-${twoDigits(month)}-${twoDigits(day)}`,
      income: income.toString(),
      expense: expense.toString(),
      balance: income.minus(expense).toString(),
      hasData: dayTxns.length > 0 && counts[day] > 0,
      count: counts[day],
    })
  }

  const monthTotals = statsTotals(txns, accounts, commodity)
  const elapsed = elapsedDays(year, month, today)
  const todayYear = today.getFullYear()
  const todayMonth = today.getMonth() + 1
  return {
    rows,
    total: monthTotals,
    average: averagePerDay(monthTotals, elapsed),
    elapsedDays: elapsed,
    isCurrentMonth: year === todayYear && month === todayMonth,
  }
}

/** 标签桶（`isUntagged` 为 true 表示「未打标签」这个正常桶）。 */
export interface TagShare {
  tag: string
  expense: string
  income: string
  /** `income − expense`，可能为负。 */
  balance: string
  /** 该标签下的交易笔数（去重 txn；一笔多标签会分别计入各标签）。 */
  count: number
  /** 是否为「未打标签」桶（**不是脏数据**，是正常分类）。 */
  isUntagged: boolean
}

/** 「未打标签」桶的显示名（唯一字符串源，组件不得自造）。 */
export const UNTAGGED_LABEL = '未打标签'

/**
 * 标签聚合（T47 的数据源）。
 *
 * 三条口径：
 * 1. **必须存在「未打标签」桶**：只统计有标签的交易会让各扇区之和小于 100%，
 *    用户会以为算错了并从此不信任这一页。未打标签是**正常的桶**，不是脏数据。
 * 2. 一笔交易的多个标签**各自计入**（同一笔在两个标签下都出现）—— 这与「按标签
 *    角度看账」的语义一致；也意味着各标签金额之和**大于**总额，占比仅在单侧
 *    （支出标签 / 收入标签）内部归一。
 * 3. 空标签（空串 / 纯空白）按「未打标签」处理，不产生名为空的桶。
 */
export function tagShares(
  txns: readonly ReportTxn[],
  accounts: SummaryAccount[],
  commodity: string,
): TagShare[] {
  const buckets: { [tag: string]: { expense: Money; income: Money; txns: number[] } } = {}
  const ensure = (tag: string): { expense: Money; income: Money; txns: number[] } => {
    let bucket = buckets[tag]
    if (bucket === undefined) {
      bucket = { expense: Money.zero(), income: Money.zero(), txns: [] }
      buckets[tag] = bucket
    }
    return bucket
  }

  for (const txn of txns) {
    const totals = incomeExpenseTotals([txn], accounts, commodity)
    const hasMoney = totals.income !== '0.00' || totals.expense !== '0.00'
    const tags: string[] = []
    if (Array.isArray(txn.tags)) {
      for (const raw of txn.tags) {
        const tag = typeof raw === 'string' ? raw.trim() : ''
        if (tag !== '' && tags.indexOf(tag) < 0) {
          tags.push(tag)
        }
      }
    }
    // 只有真正参与收支的交易才进标签桶（转账 / 期初没有收支金额，进「未打标签」
    // 会让该桶金额为 0 却笔数很高，看着像 bug）。
    if (!hasMoney) {
      continue
    }
    if (tags.length === 0) {
      const bucket = ensure(UNTAGGED_LABEL)
      bucket.expense = bucket.expense.plus(moneyOf(totals.expense))
      bucket.income = bucket.income.plus(moneyOf(totals.income))
      bucket.txns.push(txn.id)
      continue
    }
    for (const tag of tags) {
      const bucket = ensure(tag)
      bucket.expense = bucket.expense.plus(moneyOf(totals.expense))
      bucket.income = bucket.income.plus(moneyOf(totals.income))
      if (bucket.txns.indexOf(txn.id) < 0) {
        bucket.txns.push(txn.id)
      }
    }
  }

  const out: TagShare[] = []
  for (const tag of Object.keys(buckets)) {
    const bucket = buckets[tag]
    out.push({
      tag,
      expense: bucket.expense.toString(),
      income: bucket.income.toString(),
      balance: bucket.income.minus(bucket.expense).toString(),
      count: bucket.txns.length,
      isUntagged: tag === UNTAGGED_LABEL,
    })
  }
  out.sort((left, right) => {
    const leftTotal = moneyOf(left.expense).plus(moneyOf(left.income))
    const rightTotal = moneyOf(right.expense).plus(moneyOf(right.income))
    if (!leftTotal.minus(rightTotal).isZero()) {
      return rightTotal.minus(leftTotal).isNegative() ? -1 : 1
    }
    // 金额相同时「未打标签」排最后（它不是用户主动创建的分类），其余按名称稳定排序。
    if (left.isUntagged !== right.isUntagged) {
      return left.isUntagged ? 1 : -1
    }
    return left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0
  })
  return out
}

/** 柱状图方向（分类柱状卡的方向 seg）。 */
export type BarDirection = 'expense' | 'income'
