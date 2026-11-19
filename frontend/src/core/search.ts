/**
 * 搜索页聚合层（B3，纯逻辑）
 *
 * 两个纯函数，喂给搜索页的两块内容：
 * - `summaryByCommodity`：结果集的**分币种**汇总（收入 / 支出 / 笔数）；
 * - `matchKeyword`：关键词**五路**匹配（备注 / 分类名 / 账户名 / 成员 / 标签）。
 *
 * 口径与 `core/bill.ts`、`core/calendar.ts`、`core/reports.ts` 同源（勿各自演化）：
 *
 * **符号口径来自后端写入路径（取证，非推测）**：
 * ```
 * internal/server/opening_http_test.go:358-361   Assets:Cash -10.00 / Expenses:Food +10.00
 * internal/service/imports_test.go:310-313       Assets:Cash +5000 / Income:Salary  -5000
 * internal/export/beancount_test.go:70           Expenses:Food 10.00 CNY
 * ```
 * 即 Beancount「借方为正」：**Expenses 为正、Income 为负**，故
 * `expense = Σ(Expenses 分录)`、`income = Σ(−Income 分录)`，**不取 abs**
 * （符号错了要暴露，不能被静默抹平）。
 *
 * **禁用跨币种求和**：输出按币种分行，不提供 `total` 字段 —— 任何「合计」都
 * 只能在同一币种内成立。
 *
 * 纯逻辑约束：零 Vue / 零 store / 零 DOM，只依赖 `core/Money`、`core/record`
 * 与 `api/types` 的类型。
 */
import { Money } from './Money'
import { accountLabel, type AccountLabelSource } from './record'
import type { AccountView, TransactionView } from '../api/types'

/** 关键词匹配所需的最小交易结构（`TransactionView` 与 `FilterableTxn` 都满足）。 */
export interface KeywordMatchableTxn {
  description: string
  created_by_name?: string
  tags?: string[]
  postings: Array<{ account_id: number; account?: string }>
}

/** 关键词匹配所需的最小账户结构（`SummaryAccount` 与 `AccountView` 都满足）。 */
export type KeywordMatchableAccount = AccountLabelSource & { id: number }

/** 某币种的汇总（各金额均为固定两位定点串）。 */
export interface CommoditySummary {
  commodity: string
  /** 收入合计，**正数**。 */
  income: string
  /** 支出合计，**正数**（负数净额按展示口径归零，见下）。 */
  expense: string
  /** 该币种的**交易笔数**（去重 txn，含转账 / 期初）。 */
  count: number
}

/** Beancount 五大根类别中与收支相关的两个（其余根一律不计入收支）。 */
const ROOT_EXPENSES = 'Expenses'
const ROOT_INCOME = 'Income'

/**
 * 取账户全名的根段（`Expenses:Food:Drink` → `Expenses`）。
 *
 * 类型判定**不查 accounts**：后端 `ValidateAccountName`
 * （internal/service/account.go）保证账户全名的根段必为
 * Assets/Liabilities/Equity/Income/Expenses 之一且与账户 type 一致，
 * 因此根段判定与「按 type 查账户」等价，且**账户列表尚未加载时也正确**
 * （`reports.ts` 的 `accountById` 查不到会把分录直接丢掉，属隐性少算）。
 */
function accountRoot(account: string): string {
  const index = account.indexOf(':')
  return index < 0 ? account : account.slice(0, index)
}

/** 定点串 → Money；非法金额按 0 处理（与 `bill.ts` / `calendar.ts` 同口径）。 */
function moneyOf(amount: string): Money {
  try {
    return Money.from(amount)
  } catch {
    return Money.zero()
  }
}

/** 负值归零：对外不展示「负的支出 / 负的收入」（与 `bill.ts:positiveOf` 同口径）。 */
function positiveOf(value: Money): Money {
  return value.isNegative() ? Money.zero() : value
}

/** 按（日期 × 币种）累计的桶（内部结构，不对外）。 */
interface DayCommodityBucket {
  commodity: string
  expense: Money
  income: Money
}

/**
 * 分币种汇总。
 *
 * **始终反映传入的 `txns`**：调用方负责把「已应用的全部筛选」施加于 `txns`
 * 后再传入，本函数内部**不做任何二次筛选**（否则会出现「列表 3 条、汇总全账本」）。
 *
 * 归零粒度与 `bill.ts` **一致**：先按（日期 × 币种）累加、再**逐桶归零**、
 * 最后按币种合并。若改成「按币种一次性累加后归零」，同一个月里「day1 支出 100、
 * day2 纯退款 50」会得到 50，而账单页月合计是 100 —— 同一账本两个数字，最容易被
 * 当成 bug 上报。`search.test.ts` 有一条与 `bill.monthTotals` 的交叉断言钉住这点。
 *
 * 排序按 `commodity` **字典序**（不用 `localeCompare`：不同环境 locale 不同会
 * 导致顺序漂移；币种代码是 ASCII，字典序确定）。**不按金额降序** —— 金额排序会让
 * 用户切换筛选时币种行位置跳动，而币种是稳定维度。
 *
 * 空输入返回 `[]`（不是错误态）。
 */
export function summaryByCommodity(
  txns: readonly TransactionView[],
): CommoditySummary[] {
  const buckets = new Map<string, DayCommodityBucket>()
  const counts = new Map<string, number>()

  for (const txn of txns) {
    // 一笔交易在同币种下只算 1 笔（多分录不重复计数）。
    const seen = new Set<string>()
    for (const posting of txn.postings) {
      const commodity = posting.commodity
      if (!seen.has(commodity)) {
        seen.add(commodity)
        counts.set(commodity, (counts.get(commodity) ?? 0) + 1)
      }
      const root = accountRoot(posting.account)
      if (root !== ROOT_EXPENSES && root !== ROOT_INCOME) {
        continue
      }
      const key = `${txn.date}\u0000${commodity}`
      let bucket = buckets.get(key)
      if (bucket === undefined) {
        bucket = { commodity, expense: Money.zero(), income: Money.zero() }
        buckets.set(key, bucket)
      }
      const value = moneyOf(posting.amount)
      if (root === ROOT_EXPENSES) {
        bucket.expense = bucket.expense.plus(value)
      } else {
        // Income 分录在 fava 口径下为负，取反后收入对外恒为正。
        bucket.income = bucket.income.plus(value.negated())
      }
    }
  }

  // 逐桶归零后再按币种合并（见 doc：与 bill.ts 的归零粒度保持一致）。
  const totals = new Map<string, { expense: Money; income: Money }>()
  buckets.forEach((bucket) => {
    const total = totals.get(bucket.commodity) ?? {
      expense: Money.zero(),
      income: Money.zero(),
    }
    total.expense = total.expense.plus(positiveOf(bucket.expense))
    total.income = total.income.plus(positiveOf(bucket.income))
    totals.set(bucket.commodity, total)
  })

  const summaries: CommoditySummary[] = []
  counts.forEach((count, commodity) => {
    const total = totals.get(commodity)
    summaries.push({
      commodity,
      expense: (total === undefined ? Money.zero() : total.expense).toString(),
      income: (total === undefined ? Money.zero() : total.income).toString(),
      count,
    })
  })
  summaries.sort((a, b) => {
    if (a.commodity === b.commodity) {
      return 0
    }
    return a.commodity < b.commodity ? -1 : 1
  })
  return summaries
}

/** 匹配用的归一化：去首尾空白 + 小写。 */
function normalize(value: string): string {
  return value.trim().toLowerCase()
}

function findAccount(
  accounts: readonly KeywordMatchableAccount[],
  accountId: number,
): KeywordMatchableAccount | undefined {
  for (const account of accounts) {
    if (account.id === accountId) {
      return account
    }
  }
  return undefined
}

/**
 * 关键词五路匹配（备注 / 分类名 / 账户名 / 成员 / 标签）。
 *
 * - 全部 `trim()` + `toLowerCase()` 后 `includes`，**任一路命中即 true**；
 * - **空关键词（含纯空白）直接返回 `true`**（等同无筛选），且**不遍历** txn —— 
 *   让「空串 = 命中全部」成为函数内建语义，调用方只需
 *   `txns.filter((txn) => matchKeyword(txn, kw, accounts))`，无需各处写
 *   `kw === '' || ...`；
 * - 账户名同时匹配**展示名**（`accountLabel`，如「餐饮」）与**Beancount 全名**
 *   （`Expenses:Food:Drink` 与 `account.name`）—— 用户记得的可能是 `Food`
 *   而不是「餐饮」，只匹配展示名会造成「明明有这个账户却搜不到」；
 * - 用 `toLowerCase()` 而非 locale-aware 比较：本项目以中文为主，西文标签受益于
 *   大小写不敏感。**已知局限**：土耳其文 `İ → i̇`、德语 `ß` 不展开；若将来真有多
 *   语言需求，改 `toLocaleLowerCase` / `localeCompare`。
 */
export function matchKeyword(
  txn: KeywordMatchableTxn,
  keyword: string,
  accounts: readonly KeywordMatchableAccount[],
): boolean {
  const needle = normalize(keyword)
  if (needle === '') {
    return true
  }
  if (normalize(txn.description).indexOf(needle) >= 0) {
    return true
  }
  const member = txn.created_by_name
  if (typeof member === 'string' && normalize(member).indexOf(needle) >= 0) {
    return true
  }
  if (Array.isArray(txn.tags)) {
    for (const tag of txn.tags) {
      if (typeof tag === 'string' && normalize(tag).indexOf(needle) >= 0) {
        return true
      }
    }
  }
  for (const posting of txn.postings) {
    // 展示名优先（accounts 未加载时退化为只有全名，仍可搜到）。
    const account = findAccount(accounts, posting.account_id)
    if (account !== undefined) {
      if (normalize(accountLabel(account)).indexOf(needle) >= 0) {
        return true
      }
      if (normalize(account.name).indexOf(needle) >= 0) {
        return true
      }
    }
    // `account` 在最小型里是可选（`FilterableTxn` 未约束该字段），必须守卫。
    if (typeof posting.account === 'string' && normalize(posting.account).indexOf(needle) >= 0) {
      return true
    }
  }
  return false
}
