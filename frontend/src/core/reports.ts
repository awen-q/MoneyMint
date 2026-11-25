/**
 * P-11 报表聚合（批 3，纯逻辑层）
 *
 * 批 2.5 铁律（勿删）：
 * - **一切聚合显式携带 commodity 维度**，禁止跨币种求和、禁止折算成单值；
 * - 收支统计一律**分录级**，按账户 type 判定 Income / Expenses；
 *   转账（全是 Assets / Liabilities 分录）天然不计入收支；
 * - 金额运算只走 `core/Money`（decimal.js 定点），禁止 JS 裸 +/-、parseFloat；
 *   占比 / 比率仅用于绘图宽度，允许 Number，但绝不回写为金额；
 * - 净资产口径 ΣAssets + ΣLiabilities 由 `computeBalanceSummary` 统一提供，
 *   本模块不自行按账户类型取绝对值或乘系数。
 *
 * Safari 14.1 兼容：不用 `.at()` / findLast / Object.hasOwn / padStart / toISOString。
 */
import { Money } from './Money'
import { t } from '../i18n'
import { accountLabel, type SummaryAccount } from './record'

/**
 * 周标签（周一~周日）与月刻度的消息键。
 *
 * 模块顶层只保存**键**（不含译文），译文一律在 periodBuckets 访问时 t() 求值 ——
 * 否则切语言后图表刻度仍是旧语言（模块快照陷阱）。
 */
const WEEKDAY_KEYS = [
  'core.reports.weekMon',
  'core.reports.weekTue',
  'core.reports.weekWed',
  'core.reports.weekThu',
  'core.reports.weekFri',
  'core.reports.weekSat',
  'core.reports.weekSun',
] as const

const MONTH_KEYS = [
  'core.reports.month1',
  'core.reports.month2',
  'core.reports.month3',
  'core.reports.month4',
  'core.reports.month5',
  'core.reports.month6',
  'core.reports.month7',
  'core.reports.month8',
  'core.reports.month9',
  'core.reports.month10',
  'core.reports.month11',
  'core.reports.month12',
] as const

/** 报表所需的最小分录结构（与 api/types 的 PostingView 兼容）。 */
export interface ReportPosting {
  account_id: number
  commodity: string
  amount: string
}

/** 报表所需的最小交易结构。 */
export interface ReportTxn {
  id: number
  date: string
  description: string
  created_by_name: string
  tags?: string[]
  postings: ReportPosting[]
}

export type ReportPeriod = 'week' | 'month' | 'year'

/** 一个时间桶：key 用于与交易日期比对，label 用于图表刻度。 */
export interface PeriodBucket {
  key: string
  label: string
}

function twoDigits(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** 本地时区的 `YYYY-MM-DD`（不用 toISOString，避免 UTC 跨日）。 */
export function dateString(date: Date): string {
  return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`
}

/** 某月天数（用 Date 溢出法，不依赖 Intl）。 */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

/**
 * 生成时间桶：周 = 周一~周日 7 天；月 = 当月每一天；年 = 12 个月。
 * cursor 决定落在哪一周期，切换周期时由视图重置为今天。
 */
export function periodBuckets(period: ReportPeriod, cursor: Date): PeriodBucket[] {
  const year = cursor.getFullYear()
  const month = cursor.getMonth()
  const out: PeriodBucket[] = []

  if (period === 'year') {
    for (let m = 0; m < 12; m += 1) {
      out.push({ key: `${year}-${twoDigits(m + 1)}`, label: t(MONTH_KEYS[m]) })
    }
    return out
  }

  if (period === 'month') {
    const total = daysInMonth(year, month)
    for (let day = 1; day <= total; day += 1) {
      out.push({
        key: `${year}-${twoDigits(month + 1)}-${twoDigits(day)}`,
        label: `${twoDigits(month + 1)}/${twoDigits(day)}`,
      })
    }
    return out
  }

  // 周：以周一为起点（getDay(): 0=周日）。
  const weekday = cursor.getDay()
  const offset = weekday === 0 ? 6 : weekday - 1
  const monday = new Date(year, month, cursor.getDate() - offset)
  for (let i = 0; i < 7; i += 1) {
    const day = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i)
    out.push({ key: dateString(day), label: t(WEEKDAY_KEYS[i]) })
  }
  return out
}

/** 交易日期是否落在桶内（年用 `YYYY-MM` 前缀，周/月用完整日期）。 */
export function inBuckets(date: string, buckets: PeriodBucket[], period: ReportPeriod): boolean {
  for (const bucket of buckets) {
    if (period === 'year' ? date.indexOf(bucket.key) === 0 : date === bucket.key) {
      return true
    }
  }
  return false
}

/** 区间可读标签，用于顶部「上一周 / 下一月」中间的文案。 */
export function periodLabel(period: ReportPeriod, cursor: Date): string {
  const year = cursor.getFullYear()
  if (period === 'year') {
    return t('core.reports.yearLabel', { year: String(year) })
  }
  if (period === 'month') {
    return t('core.reports.monthLabel', {
      year: String(year),
      month: String(cursor.getMonth() + 1),
    })
  }
  const buckets = periodBuckets('week', cursor)
  return `${buckets[0].key} ~ ${buckets[6].key}`
}

/** 按周期平移 cursor（上一期 / 下一期）。 */
export function shiftPeriod(period: ReportPeriod, cursor: Date, delta: number): Date {
  const next = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate())
  if (period === 'week') {
    next.setDate(next.getDate() + delta * 7)
  } else if (period === 'month') {
    next.setMonth(next.getMonth() + delta)
  } else {
    next.setFullYear(next.getFullYear() + delta)
  }
  return next
}

/** 从交易收集去重标签（供 #tag 下钻）。 */
export function collectTags(txns: ReportTxn[]): string[] {
  const tags: string[] = []
  for (const txn of txns) {
    if (txn.tags === undefined) {
      continue
    }
    for (const tag of txn.tags) {
      if (tag !== '' && tags.indexOf(tag) < 0) {
        tags.push(tag)
      }
    }
  }
  return tags.sort()
}

/** 时间区间 + 标签过滤；tag 为空串表示全部。 */
export function filterReportTransactions(
  txns: ReportTxn[],
  buckets: PeriodBucket[],
  period: ReportPeriod,
  tag: string,
): ReportTxn[] {
  const out: ReportTxn[] = []
  for (const txn of txns) {
    if (!inBuckets(txn.date, buckets, period)) {
      continue
    }
    if (tag !== '') {
      const tags = txn.tags === undefined ? [] : txn.tags
      if (tags.indexOf(tag) < 0) {
        continue
      }
    }
    out.push(txn)
  }
  return out
}

function safeMoney(value: string): Money {
  try {
    return Money.from(value)
  } catch {
    return Money.zero()
  }
}

function accountById(accounts: SummaryAccount[], id: number): SummaryAccount | undefined {
  for (const account of accounts) {
    if (account.id === id) {
      return account
    }
  }
  return undefined
}

/** 是否命中指定账户类型与币种（跨币种分录一律跳过）。 */
function matches(
  posting: ReportPosting,
  accounts: SummaryAccount[],
  type: 'Income' | 'Expenses',
  commodity: string,
): boolean {
  if (posting.commodity !== commodity) {
    return false
  }
  const account = accountById(accounts, posting.account_id)
  return account !== undefined && account.type === type
}

/**
 * 选定主币种：取支出分录绝对额总和最大的币种；无数据回退 defaultCommodity。
 * 这里只比较各币种**各自的**合计大小来决定展示币种，不产生跨币种金额。
 */
export function pickCommodity(
  txns: ReportTxn[],
  accounts: SummaryAccount[],
  fallback: string,
): string {
  const totals: { [code: string]: Money } = {}
  for (const txn of txns) {
    for (const posting of txn.postings) {
      const account = accountById(accounts, posting.account_id)
      if (account === undefined || account.type !== 'Expenses') {
        continue
      }
      const code = posting.commodity
      const value = safeMoney(posting.amount).abs()
      totals[code] = totals[code] === undefined ? value : totals[code].plus(value)
    }
  }
  let best = ''
  // 仅用于「比较哪个币种金额更大」以决定展示币种，不产出跨币种金额；
  // 定点字符串字典序无法比较位数不同的数（"10.00" < "9.00"），故转 Number 比较。
  let bestMagnitude = -1
  for (const code of Object.keys(totals)) {
    const magnitude = Number(totals[code].toString())
    if (magnitude > bestMagnitude) {
      best = code
      bestMagnitude = magnitude
    }
  }
  return best === '' ? (fallback === '' ? 'CNY' : fallback) : best
}

/** 全部出现过的币种（供币种切换器，按字母序）。 */
export function collectCommodities(txns: ReportTxn[], fallback: string): string[] {
  const codes: string[] = [fallback]
  for (const txn of txns) {
    for (const posting of txn.postings) {
      if (posting.commodity !== '' && codes.indexOf(posting.commodity) < 0) {
        codes.push(posting.commodity)
      }
    }
  }
  return codes.sort()
}

/** 收支合计（带符号：退款 / 冲减分录会抵减对应桶，允许负合计）。 */
export interface IncomeExpenseTotals {
  income: string
  expense: string
}

/**
 * 收支合计（带符号，fava 口径）：
 * - Income 分录贡献 = Σ(−amount)（fava 下收入分录原值为负，取负后为正收入；
 *   退款产生的正分录会冲减收入，可出现负合计）；
 * - Expenses 分录贡献 = Σ(+amount)（借方为正支出；退款负分录冲减支出）；
 * - 禁 abs：符号即方向，取绝对值会把「负支出 / 退款」误计为正向发生额。
 */
export function incomeExpenseTotals(
  txns: ReportTxn[],
  accounts: SummaryAccount[],
  commodity: string,
): IncomeExpenseTotals {
  let income = Money.zero()
  let expense = Money.zero()
  for (const txn of txns) {
    for (const posting of txn.postings) {
      const value = safeMoney(posting.amount)
      if (matches(posting, accounts, 'Income', commodity)) {
        income = income.plus(value.negated())
      } else if (matches(posting, accounts, 'Expenses', commodity)) {
        expense = expense.plus(value)
      }
    }
  }
  return { income: income.toString(), expense: expense.toString() }
}

/** 趋势序列：与 buckets 等长，逐桶收入 / 支出幅度。 */
export interface TrendSeries {
  labels: string[]
  income: string[]
  expense: string[]
}

export function trendSeries(
  txns: ReportTxn[],
  accounts: SummaryAccount[],
  commodity: string,
  buckets: PeriodBucket[],
  period: ReportPeriod,
): TrendSeries {
  const labels: string[] = []
  const income: string[] = []
  const expense: string[] = []
  for (const bucket of buckets) {
    const inRange: ReportTxn[] = []
    for (const txn of txns) {
      const hit =
        period === 'year'
          ? txn.date.indexOf(bucket.key) === 0
          : txn.date === bucket.key
      if (hit) {
        inRange.push(txn)
      }
    }
    const totals = incomeExpenseTotals(inRange, accounts, commodity)
    labels.push(bucket.label)
    income.push(totals.income)
    expense.push(totals.expense)
  }
  return { labels, income, expense }
}

/**
 * 分类占比 / 排行条目；`ratio` 仅用于绘图宽度（0~1），不是金额。
 *
 * `id` / `count` / `kind` 为 B4（T39）**additive** 新增：
 * - `id`：账户 id（**按 id 聚合**，同名子账户不再被合并成一行 —— 那样环图 /
 *   排行 / 柱状图三处数字会同时偏大或偏小）；账户查不到时为 `null`（「未分类」桶）；
 * - `count`：该分类下的**交易笔数**（去重 txn，不是分录数）；
 * - `kind`：该行属于支出侧还是收入侧（`categoryShares` 的 `kind` 参数原样回填），
 *   供下钻时构造搜索页筛选条件。
 *
 * 既有三个字段（`label` / `amount` / `ratio`）的名称与含义**一字未改**，
 * 消费方：统计页（`views/StatsView.vue`）与其图表卡片；旧报表页已于 T49 下线。
 */
export interface CategoryShare {
  label: string
  amount: string
  ratio: number
  /** 账户 id；「未分类」桶（查不到账户）为 `null`。 */
  id: number | null
  /** 该分类下的交易笔数（去重 txn）。 */
  count: number
  /** 该行所属方向。 */
  kind: 'Expenses' | 'Income'
}

/**
 * 分类聚合（带符号）：Expenses 分录按原符号累加（负分录 / 退款冲减支出），
 * 负合计允许存在；ratio 仅在 grand > 0 时按 amount/grand 计算，负合计得 0，
 * 视图层柱宽须自行 Math.max(0, …) 防负宽度。金额文本保持带符号展示。
 */
export function categoryShares(
  txns: ReportTxn[],
  accounts: SummaryAccount[],
  commodity: string,
  limit = 8,
  kind: 'Expenses' | 'Income' = 'Expenses',
): CategoryShare[] {
  // 按 account id 聚合（T39）：同名子账户是不同的分类，按显示名合并会让
  // 环图 / 排行 / 柱状图三处同时偏大。查不到账户的归入「未分类」桶（id=null）。
  const buckets: { [key: string]: { id: number | null; label: string; amount: Money; txns: number[] } } = {}
  for (const txn of txns) {
    for (const posting of txn.postings) {
      if (!matches(posting, accounts, kind, commodity)) {
        continue
      }
      const account = accountById(accounts, posting.account_id)
      const key = account === undefined ? 'untagged' : `id:${posting.account_id}`
      let bucket = buckets[key]
      if (bucket === undefined) {
        bucket = {
          id: account === undefined ? null : posting.account_id,
          label: account === undefined ? t('core.reports.uncategorized') : accountLabel(account),
          amount: Money.zero(),
          txns: [],
        }
        buckets[key] = bucket
      }
      // 收入侧取反后为正（Income 分录原值为负）：否则柱高 / 占比恒为负、ratio 恒 0。
      // 支出侧保留原值（借方为正；退款负分录会自然冲减，ratio 有 grand>0 守卫）。
      const value = safeMoney(posting.amount)
      bucket.amount = bucket.amount.plus(kind === 'Income' ? value.negated() : value)
      if (bucket.txns.indexOf(txn.id) < 0) {
        bucket.txns.push(txn.id)
      }
    }
  }
  const rows: Array<{ id: number | null; label: string; amount: Money; count: number }> = []
  for (const key of Object.keys(buckets)) {
    const bucket = buckets[key]
    rows.push({ id: bucket.id, label: bucket.label, amount: bucket.amount, count: bucket.txns.length })
  }
  rows.sort((a, b) => (a.amount.toString() === b.amount.toString()
    ? (a.label < b.label ? -1 : 1)
    : (Number(a.amount.toString()) > Number(b.amount.toString()) ? -1 : 1)))

  let grand = Money.zero()
  for (const row of rows) {
    grand = grand.plus(row.amount)
  }
  const grandNumber = Number(grand.toString())
  const out: CategoryShare[] = []
  for (let i = 0; i < rows.length && i < limit; i += 1) {
    const row = rows[i]
    out.push({
      label: row.label,
      amount: row.amount.toString(),
      ratio: grandNumber > 0 ? Number(row.amount.toString()) / grandNumber : 0,
      id: row.id,
      count: row.count,
      kind,
    })
  }
  return out
}

/**
 * 成员贡献：按记账人聚合笔数与该币种支出金额（带符号：退款负分录冲减，
 * 负合计允许存在；ratio 与柱宽口径同 categoryShares）。
 */
export interface MemberContribution {
  name: string
  count: number
  amount: string
  ratio: number
}

export function memberContributions(
  txns: ReportTxn[],
  accounts: SummaryAccount[],
  commodity: string,
): MemberContribution[] {
  const buckets: { [name: string]: { count: number; amount: Money } } = {}
  for (const txn of txns) {
    const name = txn.created_by_name === '' ? t('core.reports.unnamedMember') : txn.created_by_name
    let expense = Money.zero()
    for (const posting of txn.postings) {
      if (matches(posting, accounts, 'Expenses', commodity)) {
        expense = expense.plus(safeMoney(posting.amount))
      }
    }
    const current = buckets[name]
    buckets[name] = current === undefined
      ? { count: 1, amount: expense }
      : { count: current.count + 1, amount: current.amount.plus(expense) }
  }
  let grand = Money.zero()
  for (const name of Object.keys(buckets)) {
    grand = grand.plus(buckets[name].amount)
  }
  const grandNumber = Number(grand.toString())
  const out: MemberContribution[] = []
  for (const name of Object.keys(buckets)) {
    const item = buckets[name]
    out.push({
      name,
      count: item.count,
      amount: item.amount.toString(),
      ratio: grandNumber > 0 ? Number(item.amount.toString()) / grandNumber : 0,
    })
  }
  out.sort((a, b) => (Number(b.amount) > Number(a.amount) ? 1 : -1))
  return out
}

/** 试算平衡行：账户 / 类型 / 该币种余额（原符号，不取绝对值）。 */
export interface TrialBalanceRow {
  label: string
  type: string
  balance: string
}

export function trialBalanceRows(
  accounts: SummaryAccount[],
  commodity: string,
): TrialBalanceRow[] {
  const out: TrialBalanceRow[] = []
  for (const account of accounts) {
    const balances = account.balances === undefined ? {} : account.balances
    const value = balances[commodity]
    if (value === undefined) {
      continue
    }
    out.push({ label: accountLabel(account), type: account.type, balance: value })
  }
  return out
}
