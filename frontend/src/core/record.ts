/**
 * 记账 / 汇总的金额与符号口径（批 1，纯逻辑层）
 *
 * 硬约束：
 * - 一切金额运算走 `core/Money`（decimal.js 定点），禁止裸 + - * /、parseFloat；
 * - 净资产口径统一 `ΣAssets + ΣLiabilities`，后端返回的账户余额本身带符号
 *   （Liabilities / Income 为负），禁止按类型 abs() 或乘系数（§6.4 / AC-12）；
 * - 在线 postings 只用账户整数 id，金额用定点十进制字符串。
 *
 * 批 3 前置铁律（老板拍板「基础核心必须 fava/beancount 一致」，勿删）：
 * - 任何聚合函数签名必须**显式携带 commodity 维度**（如 dailyTotals 的
 *   mainCommodity、账户余额的 balances[commodity]）；
 * - **禁止跨币种求和**、禁止输出跨币种折算后的单值；
 * - 报表（批 3）将带币种切换器，聚合一律在选定币种内进行。
 */
import { Money } from './Money'
// 仅类型导入：编译后完全擦除，core 层零运行时依赖 api / Vue / store。
// api/types.ts 的 TxnFlag 是唯一 flag 类型源，此处不重复定义。
import type { TxnFlag } from '../api/types'

/** 账户余额视图所需的最小结构（避免 core 层反向依赖 api 层）。 */
export interface SummaryAccount {
  id: number
  name: string
  display_name?: string
  type: string
  commodity_restriction?: string
  balances?: Record<string, string>
  /** 关户守门用（后端 close_date，非空即已关闭）。 */
  close_date?: string
  /** 分类拖拽排序（0.4-C，同类型内升序）。 */
  sort_order?: number
  /** 账户 uuid（批 2 起列表透出；层级树 parent 关系优先用它）。 */
  uuid?: string
  /** 父账户 uuid（三级分类结构；批 2.5 账户层级树用）。 */
  parent_uuid?: string
}

/** 记账类型（C-01 三 Tab）。 */
export type RecordKind = 'expense' | 'income' | 'transfer'

/** 一条在线分录草稿（account_id 为整数）。 */
export interface PostingDraft {
  accountId: number
  accountName: string
  commodity: string
  amount: string
}

/** 记一笔表单的持久化形状（草稿不含任何凭据）。 */
export interface RecordForm {
  kind: RecordKind
  /** 数字键盘拼出的表达式，如 `12.50+3.25`；空串表示未输入。 */
  amountExpression: string
  date: string
  description: string
  tags: string[]
  /** 支出 → Expenses 账户；收入 → Income 账户。 */
  categoryAccountId: number | null
  /** 支出 / 收入的资金账户（Assets / Liabilities）。 */
  fundAccountId: number | null
  transferFromAccountId: number | null
  transferToAccountId: number | null
  /** 高级双录模式的分录行（批 2.5；accountId 允许 null 表示未选择；旧草稿无此字段）。 */
  advancedPostings?: AdvancedRow[]
  /**
   * 交易标记：`*` 已完成 / `!` 待核或冲正。
   * 可选仅为兼容既有测试固件与旧草稿（它们不声明该字段）；RecordSheet 运行时始终写入，
   * 缺省口径一律按 `'*'` 处理。类型源仍是 api/types.ts 的 TxnFlag。
   */
  flag?: TxnFlag
}

/** 高级双录的一行：账户 + 带符号定点金额 + 币种（由账户带出，可下拉覆盖）。 */
export interface AdvancedRow {
  accountId: number | null
  /** 定点字符串（带符号），如 `-128.50`。 */
  amount: string
  /** 由账户 commodity_restriction 带出，空串表示跟随账本默认币种。 */
  commodity: string
}

/**
 * 带符号金额串 → 借贷方向：非负=借(debit)，负=贷(credit)；非法值按借兜底。
 *
 * 与 PostingView.isDebit 同源（都看 Money.isNegative），供高级录入 UI 派生
 * Toggle 方向；方向是 UI 状态，不进 AdvancedRow、不落库。
 */
export function amountDirection(amount: string): 'debit' | 'credit' {
  // 非 string / 空串都按借兜底：草稿恢复或后端异常数据可能带来 undefined，
  // 不能让 UI 在读取方向时抛 TypeError（Money.from 内部会调 .trim()）。
  if (typeof amount !== 'string' || amount.trim() === '') {
    return 'debit'
  }
  try {
    return Money.from(amount).isNegative() ? 'credit' : 'debit'
  } catch {
    return 'debit'
  }
}

/**
 * 方向 + 正数文本 → AdvancedRow.amount（唯一写入口；剥掉输入里的 +/-）。
 *
 * 硬约束：返回值**永远是合法 string**——空幅值（含纯符号 `-` / `--` 输入）
 * 归一为空串，绝不产生裸符号串。裸 `-` 曾是页面崩溃源：它经由 bean 预览的
 * Money.from 抛出 RangeError，使 RecordSheet 整棵组件树渲染失败。
 * 合法输入的文本形态（如 `12.` / `-0.00`）原样保留，不影响往返恒等。
 */
export function signAmount(dir: 'debit' | 'credit', magnitude: string): string {
  const raw = typeof magnitude === 'string' ? magnitude : ''
  // 连续剥掉前导 +/-：幅值框只收正数，用户粘贴的带符号值由本函数统一赋号。
  const mag = raw.trim().replace(/^[+-]+/, '')
  if (mag === '') {
    return ''
  }
  return dir === 'credit' ? `-${mag}` : mag
}

/** 带符号串 → 正数显示文本（保真输入，如 `12.` 不改写成 `12.0`；非 string 兜底空串）。 */
export function magnitudeOf(amount: string): string {
  return typeof amount === 'string' ? amount.replace(/^[+-]/, '') : ''
}

/** 分录展示行：真实导出名 + 中文 DisplayName + 借贷徽标（仅 UI，Beancount 无借贷字段）。 */
export interface PostingView {
  account: SummaryAccount
  /** account.name，真实 ASCII 导出名。 */
  name: string
  /** display_name 优先、name 兜底的中文主文案。 */
  label: string
  /** 带符号定点金额。 */
  amount: string
  commodity: string
  /** amount > 0 为借（UI 徽标），仅展示用。 */
  isDebit: boolean
}

/** 按商品（币种）分组的配平结果。 */
export interface BalanceGroup {
  commodity: string
  /** 带符号合计。 */
  sum: string
  /** 正数分录之和（恒为非负）。 */
  pos: string
  /** 负数分录之和（恒为非正）。 */
  neg: string
  rows: number
  /** 同币种 sum = 0 且分录数 >= 2。 */
  balanced: boolean
}

/** 两位补零（不依赖 padStart / toISOString，避免跨时区跨日）。 */
function twoDigits(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** 今日日期 `YYYY-MM-DD`（本地时区）。 */
export function todayString(now: Date = new Date()): string {
  return `${String(now.getFullYear())}-${twoDigits(now.getMonth() + 1)}-${twoDigits(now.getDate())}`
}

/** 把 `12.` / `.5` 这类键盘输入规范成 Money.from 可接受的普通十进制串。 */
function normalizeNumberToken(token: string): string {
  let result = token
  if (result.charAt(0) === '.') {
    result = `0${result}`
  }
  if (result.charAt(result.length - 1) === '.') {
    result = `${result}0`
  }
  return result
}

/**
 * 定点求值金额表达式（数字键盘的 ＋ / － 会拼出 `12.5+3.25`）。
 * 只接受数字、小数点和加减号；结果取绝对值（方向由三 Tab 决定）。
 * 全程 Money 定点运算，杜绝 `0.1 + 0.2` 浮点尾差（AC-22）。
 */
export function evaluateAmountExpression(expression: string): Money {
  const expr = expression.trim()
  if (expr === '' || !/^[0-9.]+(?:[+-][0-9.]+)*$/.test(expr)) {
    throw new RangeError('金额只能包含数字、小数点与加减号')
  }

  const parts: Array<{ minus: boolean; value: string }> = []
  let buffer = ''
  let minus = false
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr.charAt(i)
    if (ch === '+' || ch === '-') {
      if (buffer === '') {
        throw new RangeError('金额表达式的运算符位置不正确')
      }
      parts.push({ minus, value: normalizeNumberToken(buffer) })
      buffer = ''
      minus = ch === '-'
    } else {
      buffer += ch
    }
  }
  if (buffer === '') {
    throw new RangeError('金额表达式不能以运算符结尾')
  }
  parts.push({ minus, value: normalizeNumberToken(buffer) })

  let total = Money.zero()
  for (const part of parts) {
    const value = Money.from(part.value)
    total = part.minus ? total.minus(value) : total.plus(value)
  }
  return total.abs()
}

/**
 * 账户名的结构最小型：凡是只需要「展示名」的地方（如 `accountLabel`、
 * 关键词匹配）都不该要求完整账户 —— 这让 `SummaryAccount`、`AccountView`
 * 与 `FilterableTxn` 侧的最小结构都能直接传入，避免为了类型兼容做 map。
 */
export interface AccountLabelSource {
  name: string
  display_name?: string
}

/** 账户展示名（优先 display_name）。 */
export function accountLabel(account: AccountLabelSource): string {
  return account.display_name !== undefined && account.display_name !== ''
    ? account.display_name
    : account.name
}

/**
 * 账户币种：commodity_restriction 优先，否则用账本默认币种。
 * 高级双录「选账户自动带出币种」与 buildPostings 共用同一口径，避免两处漂移。
 */
export function resolveAccountCommodity(
  account: SummaryAccount,
  fallback: string,
): string {
  const restriction = account.commodity_restriction
  return restriction !== undefined && restriction !== '' ? restriction : fallback
}

function resolveCommodity(account: SummaryAccount, fallback: string): string {
  return resolveAccountCommodity(account, fallback)
}

/** 复式恒等式：所有分录金额（定点）求和必须为 0。 */
export function postingsBalanced(postings: PostingDraft[]): boolean {
  let sum = Money.zero()
  for (const posting of postings) {
    sum = sum.plus(Money.from(posting.amount))
  }
  return sum.isZero()
}

/**
 * 依据三 Tab 生成两条配平分录。
 * - 支出：Expenses +amount / 资金账户 -amount
 * - 收入：Income -amount / 资金账户 +amount
 * - 转账：转出 -amount / 转入 +amount
 * 后端余额口径即「postings 直接累加」，因此这里不按账户类型乘系数。
 */
export function buildPostings(
  form: RecordForm,
  accounts: SummaryAccount[],
  defaultCommodity: string,
): PostingDraft[] {
  const amount = evaluateAmountExpression(form.amountExpression)
  if (amount.isDisplayZero()) {
    throw new RangeError('请输入大于 0 的金额')
  }

  const byId = new Map<number, SummaryAccount>()
  for (const account of accounts) {
    byId.set(account.id, account)
  }
  const resolve = (id: number | null, label: string): SummaryAccount => {
    if (id === null) {
      throw new RangeError(`请选择${label}`)
    }
    const found = byId.get(id)
    if (found === undefined) {
      throw new RangeError(`${label}不在当前账本账户列表中`)
    }
    return found
  }

  const positive = amount.toString()
  const negative = amount.negated().toString()
  const postings: PostingDraft[] = []

  if (form.kind === 'transfer') {
    const from = resolve(form.transferFromAccountId, '转出账户')
    const to = resolve(form.transferToAccountId, '转入账户')
    if (from.id === to.id) {
      throw new RangeError('转出与转入账户不能相同')
    }
    const fromCommodity = resolveCommodity(from, defaultCommodity)
    const toCommodity = resolveCommodity(to, defaultCommodity)
    if (fromCommodity !== toCommodity) {
      throw new RangeError('转出与转入账户币种需一致')
    }
    postings.push({
      accountId: from.id,
      accountName: accountLabel(from),
      commodity: fromCommodity,
      amount: negative,
    })
    postings.push({
      accountId: to.id,
      accountName: accountLabel(to),
      commodity: toCommodity,
      amount: positive,
    })
  } else {
    const category = resolve(
      form.categoryAccountId,
      form.kind === 'income' ? '收入分类' : '支出分类',
    )
    const fund = resolve(form.fundAccountId, '资金账户')
    const categoryCommodity = resolveCommodity(category, defaultCommodity)
    const fundCommodity = resolveCommodity(fund, defaultCommodity)
    if (categoryCommodity !== fundCommodity) {
      throw new RangeError('分类与资金账户币种需一致')
    }
    const isExpense = form.kind === 'expense'
    postings.push({
      accountId: category.id,
      accountName: accountLabel(category),
      commodity: categoryCommodity,
      amount: isExpense ? positive : negative,
    })
    postings.push({
      accountId: fund.id,
      accountName: accountLabel(fund),
      commodity: fundCommodity,
      amount: isExpense ? negative : positive,
    })
  }

  if (!postingsBalanced(postings)) {
    throw new RangeError('分录未配平，请检查金额')
  }
  return postings
}

/** 首页余额汇总（按币种分组；主币种单列便于大数字展示）。 */
export interface BalanceSummary {
  assets: Record<string, string>
  liabilities: Record<string, string>
  netWorth: Record<string, string>
  assetTotal: string
  liabilityTotal: string
  netWorthTotal: string
  commodity: string
}

interface MoneyBuckets {
  [code: string]: Money
}

function safeMoney(value: string): Money {
  try {
    return Money.from(value)
  } catch {
    return Money.zero()
  }
}

function addToBucket(bucket: MoneyBuckets, code: string, value: string): void {
  const previous = bucket[code]
  bucket[code] = previous === undefined
    ? safeMoney(value)
    : previous.plus(safeMoney(value))
}

function bucketToStrings(bucket: MoneyBuckets): Record<string, string> {
  const result: Record<string, string> = {}
  const codes = Object.keys(bucket)
  for (const code of codes) {
    result[code] = bucket[code].toString()
  }
  return result
}

/**
 * `computeBalanceSummary` 的选项。
 */
export interface BalanceSummaryOptions {
  /**
   * 主币种无数据时是否回退到「第一个有数据的币种」。
   *
   * - `true`（**默认**，与历史行为一致）：用于传**账本默认币种**的页面
   *   （如 `CommoditiesView`）—— 那里 `defaultCommodity` 不是用户
   *   显式选的，回退到有数据的币种可避免「首页误显示 0.00」；
   * - `false`：用于传**用户显式选择币种**的页面（资产页）—— 用户选了 USD 却把
   *   CNY 的数字顶上来、标题还写 USD，是静默改口，比显示 0.00 糟得多。
   *
   * 无论取何值，`assets` / `liabilities` / `netWorth` 三个**明细**都按真实币种
   * 完整返回，不会被抹掉 —— 只是「主币种口径」（三个合计）是否切换。
   */
  allowFallback?: boolean
}

/**
 * 统一净资产口径：ΣAssets + ΣLiabilities（后端余额本身带符号，负债为负）。
 * 禁止 abs() / 按类型乘系数；净资产为负时原样保留负号（AC-12）。
 */
export function computeBalanceSummary(
  accounts: SummaryAccount[],
  defaultCommodity: string,
  opts: BalanceSummaryOptions = {},
): BalanceSummary {
  const assets: MoneyBuckets = {}
  const liabilities: MoneyBuckets = {}

  for (const account of accounts) {
    if (account.type !== 'Assets' && account.type !== 'Liabilities') {
      continue
    }
    const bucket = account.type === 'Assets' ? assets : liabilities
    const balances = account.balances === undefined ? {} : account.balances
    const codes = Object.keys(balances)
    for (const code of codes) {
      addToBucket(bucket, code, balances[code])
    }
  }

  const net: MoneyBuckets = {}
  const assetCodes = Object.keys(assets)
  for (const code of assetCodes) {
    net[code] = assets[code]
  }
  const liabilityCodes = Object.keys(liabilities)
  for (const code of liabilityCodes) {
    const asset = net[code]
    net[code] = asset === undefined ? liabilities[code] : asset.plus(liabilities[code])
  }

  const allCodes = Object.keys(net)
  // 账本默认币种若无任何余额数据，退回第一个实际有数据的币种，避免首页误显示 0.00。
  // `allowFallback === false` 时**不回退**：用户显式选了币种，就按该币种口径给 0.00，
  // 绝不能把另一个币种的数字顶上来（标题写 USD、数字是 CNY 属静默改口）。
  const allowFallback = opts.allowFallback !== false
  let main = defaultCommodity === '' ? 'CNY' : defaultCommodity
  if (allowFallback && net[main] === undefined && allCodes.length > 0) {
    main = allCodes[0]
  }
  const assetMain = assets[main] === undefined ? Money.zero() : assets[main]
  const liabilityMain = liabilities[main] === undefined ? Money.zero() : liabilities[main]
  const netMain = net[main] === undefined ? Money.zero() : net[main]

  return {
    assets: bucketToStrings(assets),
    liabilities: bucketToStrings(liabilities),
    netWorth: bucketToStrings(net),
    assetTotal: assetMain.toString(),
    liabilityTotal: liabilityMain.toString(),
    netWorthTotal: netMain.toString(),
    commodity: main,
  }
}

/**
 * 交易展示类型（整笔启发式）。
 *
 * ⚠️ 文档化口径（批 2.5 三分法降级）：本判定是**整笔启发式**，仅供
 * 列表 badge 展示与 kind 筛选旧值兼容（transfer 项），**禁止作为任何
 * 统计依据**——收支统计一律分录级（见 calendar.dailyTotals）。筛选的
 * expense / income 是**分录命中**，但该口径自 T38 起由服务端承载
 * （`internal/service/transaction.go`，前端只发 `kind` 参数，不再本地过滤）。
 */
export type TransactionKind = 'transfer' | 'expense' | 'income' | 'opening'

/** 判定展示类型所需的最小分录结构（与 api/types 的 PostingView 结构兼容）。 */
export interface PostingLike {
  account_id: number
  amount: string
  /** 分录币种（列表行内金额按分录自身币种渲染；可选，兜底由调用方决定）。 */
  commodity?: string
}

function findAccount(
  accounts: SummaryAccount[],
  accountId: number,
): SummaryAccount | undefined {
  for (const account of accounts) {
    if (account.id === accountId) {
      return account
    }
  }
  return undefined
}


/**
 * 判定一笔交易的整笔启发式类型：
 * - 含 Equity 分录 → opening（优先级最高：期初交易在每个账户都有分录，
 *   被标成「支出」是确定性错误）
 * - postings 全部属于 Assets / Liabilities → transfer（同账本内转账）
 * - 含 Expenses → expense
 * - 含 Income → income
 * - 其余（未知账户类型、空 postings、账户未加载）→ expense 回退
 */
export function transactionKind(
  postings: PostingLike[],
  accounts: SummaryAccount[],
): TransactionKind {
  if (postings.length === 0) {
    return 'expense'
  }
  let fundCount = 0
  let hasExpense = false
  let hasIncome = false
  let hasEquity = false
  for (const posting of postings) {
    const account = findAccount(accounts, posting.account_id)
    const type = account === undefined ? '' : account.type
    if (type === 'Assets' || type === 'Liabilities') {
      fundCount += 1
    } else if (type === 'Expenses') {
      hasExpense = true
    } else if (type === 'Income') {
      hasIncome = true
    } else if (type === 'Equity') {
      hasEquity = true
    }
  }
  if (hasEquity) {
    return 'opening'
  }
  if (hasExpense) {
    return 'expense'
  }
  if (hasIncome) {
    return 'income'
  }
  if (fundCount === postings.length) {
    return 'transfer'
  }
  return 'expense'
}

/**
 * 展示类型分类器（Bug2）：只在「还款主体 + 小额优惠」复合交易上把 `income`
 * 降格为 `transfer`，其余原样返回 `transactionKind`。
 *
 * 五条条件必须**全部**满足（顺序与方案 §3.2 一致）：
 * 1. `transactionKind === 'income'`（不动 expense / opening / transfer）；
 * 2. 无 Equity、无 Expenses 分录（排除期初与退款/报销：后端明确支持一笔
 *    同时命中 expense+income，那类交易即使有 Income 也不降格）；
 * 3. ≥2 条资金分录（Assets/Liabilities），且存在一负一正（还款主体结构）；
 * 4. 恰有 1 条 Income 分录且金额 < 0（优惠/冲减，fava 收入原值为负）；
 * 5. `|Income| < min(|资金分录|)`（小额优惠，排除主体就是真实收入）。
 *
 * ⚠️ 两套 kind 语义刻意并存：这里是**整笔展示标签**，后端 `kind` 是
 * **分录级查询命中**。展示为「转账」的交易仍可能被 `kind=income` 筛出，
 * 这是刻意保留的既有差异；统计与 Beancount 导出只认原始 postings。
 * 金额一律走 Money decimal，禁用 Math.abs / parseFloat。
 */
export function displayKindOf(
  postings: PostingLike[],
  accounts: SummaryAccount[],
): TransactionKind {
  const kind = transactionKind(postings, accounts)
  if (kind !== 'income') {
    return kind
  }

  let fundCount = 0
  let hasNegativeFund = false
  let hasPositiveFund = false
  let minFundAbs: Money | null = null
  let incomeCount = 0
  let incomeAmount: Money | null = null

  try {
    for (const posting of postings) {
      const account = findAccount(accounts, posting.account_id)
      const type = account === undefined ? '' : account.type
      // 条件 2：期初 / 退款类即使 transactionKind 未来调整也不降格。
      if (type === 'Equity' || type === 'Expenses') {
        return kind
      }
      const money = Money.from(posting.amount)
      if (type === 'Assets' || type === 'Liabilities') {
        fundCount += 1
        if (money.isNegative()) {
          hasNegativeFund = true
        } else if (!money.isZero()) {
          hasPositiveFund = true
        }
        const magnitude = money.abs()
        if (minFundAbs === null || magnitude.minus(minFundAbs).isNegative()) {
          minFundAbs = magnitude
        }
      } else if (type === 'Income') {
        incomeCount += 1
        incomeAmount = money
      }
    }
  } catch {
    // 非法金额保守不降格：宁可保留原标签，也不能靠猜测改展示口径。
    return kind
  }

  if (fundCount < 2 || !hasNegativeFund || !hasPositiveFund) {
    return kind
  }
  if (incomeCount !== 1 || incomeAmount === null || !incomeAmount.isNegative()) {
    return kind
  }
  // 条件 5：严格小于；等于时属于「主体即收入」，不降格。
  if (minFundAbs === null || !incomeAmount.abs().minus(minFundAbs).isNegative()) {
    return kind
  }
  return 'transfer'
}

function amountAbs(amount: string): string {
  try {
    return Money.from(amount).abs().toString()
  } catch {
    return '0.00'
  }
}

/**
 * 转账展示金额：取转出方（负值）资金分录的**绝对值**。
 *
 * 全程走 core/Money 的 decimal `abs()`，禁止 Math.abs / parseFloat；
 * 找不到负值分录时退回第一条资金分录的绝对值，非法金额容错为 0.00。
 */
export function transferAmount(
  postings: PostingLike[],
  accounts: SummaryAccount[],
): string {
  let fallback = ''
  for (const posting of postings) {
    const account = findAccount(accounts, posting.account_id)
    const type = account === undefined ? '' : account.type
    if (type !== 'Assets' && type !== 'Liabilities') {
      continue
    }
    if (posting.amount.charAt(0) === '-') {
      return amountAbs(posting.amount)
    }
    if (fallback === '') {
      fallback = posting.amount
    }
  }
  return fallback === '' ? '0.00' : amountAbs(fallback)
}

/** 转账方向标签：`转出账户 → 转入账户`（账户名优先 display_name）。 */
export function transferRoute(
  postings: PostingLike[],
  accounts: SummaryAccount[],
): string {
  let from = ''
  let to = ''
  for (const posting of postings) {
    const account = findAccount(accounts, posting.account_id)
    if (account === undefined) {
      continue
    }
    if (account.type !== 'Assets' && account.type !== 'Liabilities') {
      continue
    }
    const label = accountLabel(account)
    if (posting.amount.charAt(0) === '-') {
      if (from === '') {
        from = label
      }
    } else if (to === '') {
      to = label
    }
  }
  if (from !== '' && to !== '') {
    return `${from} → ${to}`
  }
  return from !== '' ? from : to
}

/** 行内金额的代表分录（含币种）。 */
export interface DisplayEntry {
  amount: string
  /** 分录自身币种（行内金额按此渲染，非主币种不得错标主币种符号）。 */
  commodity: string
}

/**
 * 用户视角的代表分录（首页 / 流水列表共用口径）：
 * - 转账取转出方（负值）资金分录的绝对值金额；
 * - **混合交易回退**（批 2.5）：同时含 Expenses 与 Income 分录（退款 / 报销类）
 *   时优先取**正号**资金分录——用户视角是净收款；
 * - 支出 / 收入取资金分录带符号原值（负=支出、正=收入）；
 * - 无资金分录取首条分录原值；空分录取 {0.00, ''}。
 * 币种始终取代表分录自身的 commodity（行内金额按分录币种渲染，批 2.5 修 3）。
 */
export function displayEntryOf(
  postings: PostingLike[],
  accounts: SummaryAccount[],
): DisplayEntry {
  if (postings.length === 0) {
    return { amount: '0.00', commodity: '' }
  }
  if (displayKindOf(postings, accounts) === 'transfer') {
    for (const posting of postings) {
      const account = findAccount(accounts, posting.account_id)
      const type = account === undefined ? '' : account.type
      if (type !== 'Assets' && type !== 'Liabilities') {
        continue
      }
      if (posting.amount.charAt(0) === '-') {
        return { amount: amountAbs(posting.amount), commodity: posting.commodity ?? '' }
      }
    }
    for (const posting of postings) {
      const account = findAccount(accounts, posting.account_id)
      const type = account === undefined ? '' : account.type
      if (type === 'Assets' || type === 'Liabilities') {
        return { amount: amountAbs(posting.amount), commodity: posting.commodity ?? '' }
      }
    }
    return { amount: '0.00', commodity: '' }
  }

  let hasExpense = false
  let hasIncome = false
  for (const posting of postings) {
    const account = findAccount(accounts, posting.account_id)
    const type = account === undefined ? '' : account.type
    if (type === 'Expenses') {
      hasExpense = true
    } else if (type === 'Income') {
      hasIncome = true
    }
  }
  // 混合交易：优先正号资金分录（净收款）。
  if (hasExpense && hasIncome) {
    for (const posting of postings) {
      const account = findAccount(accounts, posting.account_id)
      const type = account === undefined ? '' : account.type
      if (
        (type === 'Assets' || type === 'Liabilities') &&
        posting.amount.charAt(0) !== '-'
      ) {
        return { amount: posting.amount, commodity: posting.commodity ?? '' }
      }
    }
  }
  for (const posting of postings) {
    const account = findAccount(accounts, posting.account_id)
    const type = account === undefined ? '' : account.type
    if (type === 'Assets' || type === 'Liabilities') {
      return { amount: posting.amount, commodity: posting.commodity ?? '' }
    }
  }
  return { amount: postings[0].amount, commodity: postings[0].commodity ?? '' }
}

/**
 * 用户视角金额（兼容入口）：等价 `displayEntryOf(...).amount`。
 * 需要币种时请改用 displayEntryOf（批 2.5 修 3：行内金额按分录币种渲染）。
 */
export function displayAmountOf(
  postings: PostingLike[],
  accounts: SummaryAccount[],
): string {
  return displayEntryOf(postings, accounts).amount
}

/**
 * 账户侧 journal（批 2.5 修 4）：某账户在交易中的分录金额（原值原符号）。
 * 负债 / Income 账户的分录符号与资金视角相反，必须按分录原值展示；
 * 找不到该账户分录时返回 '0.00'。
 */
export function postingAmountForAccount(
  txn: { postings: PostingLike[] },
  accountId: number,
): string {
  for (const posting of txn.postings) {
    if (posting.account_id === accountId) {
      return posting.amount
    }
  }
  return '0.00'
}

/**
 * 账户侧 running balance（批 2.5 修 4）：按日期升序累计「仅主币种」分录。
 *
 * 取舍说明：多币种账户的 running balance 只对 `commodity === mainCommodity`
 * 的分录累计（其余币种行余额显示 '-'）——旧版 journal 同款主导币种口径，
 * 跨币种混合累计违反批 3 铁律（禁止跨币种求和）。
 * 返回 map：txn.id → 累计后的余额（定点字符串，符号为账户视角原符号）。
 */
export function accountRunningBalances(
  txns: ReadonlyArray<{ id: number; date: string; postings: PostingLike[] }>,
  accountId: number,
  mainCommodity: string,
): { [txnId: number]: string } {
  const ordered = txns.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const result: { [txnId: number]: string } = {}
  let running = Money.zero()
  for (const txn of ordered) {
    for (const posting of txn.postings) {
      if (posting.account_id !== accountId) {
        continue
      }
      if (mainCommodity !== '' && posting.commodity !== mainCommodity) {
        continue
      }
      try {
        running = running.plus(Money.from(posting.amount))
      } catch {
        // 非法金额跳过（后端保证定点串，此处兜底）。
      }
      break
    }
    result[txn.id] = running.toString()
  }
  return result
}

/**
 * 高级双录的配平校验（批 2.5 修 5）：按币种分组合计，任一币种合计非 0 即不平。
 * 返回差额明细（币种 + 差额定点串），供 UI 直接渲染。
 */
export function balanceDiffByCommodity(
  postings: ReadonlyArray<{ commodity: string; amount: string }>,
): Array<{ commodity: string; diff: string }> {
  const buckets: { [code: string]: Money } = {}
  for (const posting of postings) {
    let value: Money
    try {
      value = Money.from(posting.amount)
    } catch {
      value = Money.zero()
    }
    const code = posting.commodity === '' ? 'CNY' : posting.commodity
    const previous = buckets[code]
    buckets[code] = previous === undefined ? value : previous.plus(value)
  }
  const diffs: Array<{ commodity: string; diff: string }> = []
  for (const code of Object.keys(buckets)) {
    if (!buckets[code].isZero()) {
      diffs.push({ commodity: code, diff: buckets[code].toString() })
    }
  }
  return diffs
}

/**
 * 按 commodity 分桶的配平明细（设计稿 §3.3）。
 * 规则：同币种 sum = 0 且该币种分录数 >= 2 才算平衡；全程 Money 定点。
 * 与 balanceDiffByCommodity 共用同一 Money 口径，不重复实现金额算法。
 */
export function balanceGroups(
  postings: ReadonlyArray<{ commodity: string; amount: string }>,
): BalanceGroup[] {
  interface Bucket {
    sum: Money
    pos: Money
    neg: Money
    rows: number
  }
  const buckets: { [code: string]: Bucket } = {}
  for (const posting of postings) {
    const code = posting.commodity === '' ? 'CNY' : posting.commodity
    let value: Money
    try {
      value = Money.from(posting.amount)
    } catch {
      value = Money.zero()
    }
    const previous = buckets[code]
    if (previous === undefined) {
      buckets[code] = {
        sum: value,
        pos: value.isNegative() ? Money.zero() : value,
        neg: value.isNegative() ? value : Money.zero(),
        rows: 1,
      }
    } else {
      previous.sum = previous.sum.plus(value)
      if (value.isNegative()) {
        previous.neg = previous.neg.plus(value)
      } else {
        previous.pos = previous.pos.plus(value)
      }
      previous.rows += 1
    }
  }
  return Object.keys(buckets).map((code) => {
    const bucket = buckets[code]
    return {
      commodity: code,
      sum: bucket.sum.toString(),
      pos: bucket.pos.toString(),
      neg: bucket.neg.toString(),
      rows: bucket.rows,
      balanced: bucket.sum.isZero() && bucket.rows >= 2,
    }
  })
}

/**
 * 分录 → 展示视图：挂真实 ASCII 导出名（account.name）与中文 display_name。
 * 账户 id 找不到时退回占位视图，不抛错（账户列表可能尚在加载）。
 */
export function buildPostingViews(
  postings: ReadonlyArray<{ accountId: number; commodity: string; amount: string }>,
  accounts: ReadonlyArray<SummaryAccount>,
): PostingView[] {
  const byId = new Map<number, SummaryAccount>()
  for (const account of accounts) {
    byId.set(account.id, account)
  }
  return postings.map((posting) => {
    const account = byId.get(posting.accountId)
    let value = Money.zero()
    try {
      value = Money.from(posting.amount)
    } catch {
      // 非法金额按 0 展示，提交前的 buildPostings/buildAdvancedPostings 会拦截。
    }
    return {
      account: account === undefined ? { id: posting.accountId, name: '', type: '' } as SummaryAccount : account,
      name: account === undefined ? '' : account.name,
      label: account === undefined ? '' : accountLabel(account),
      amount: value.toString(),
      commodity: posting.commodity === '' ? 'CNY' : posting.commodity,
      isDebit: !value.isNegative(),
    }
  })
}

/**
 * 全部分录是否配平：每组均 balanced 且至少两行（空数组返回 false）。
 * 供 RecordSheet / AdvancedPostings 的 canSubmit 复用，避免多处重复判定。
 */
export function allBalanceGroupsBalanced(groups: ReadonlyArray<BalanceGroup>): boolean {
  if (groups.length === 0) {
    return false
  }
  for (const group of groups) {
    if (!group.balanced) {
      return false
    }
  }
  return true
}

/**
 * 高级双录行的完整守门：至少 2 行 + 每行账户已选且金额非 0 + 各币种配平。
 * RecordSheet（提交守门）与 AdvancedPostings（展示守门）共用，避免两处漂移。
 */
export function advancedRowsReady(
  rows: ReadonlyArray<{ accountId: number | null; amount: string; commodity?: string }>,
  fallbackCommodity: string,
): boolean {
  if (rows.length < 2) {
    return false
  }
  for (const row of rows) {
    if (row.accountId === null) {
      return false
    }
    let value = Money.zero()
    try {
      value = Money.from(row.amount)
    } catch {
      return false
    }
    if (value.isZero()) {
      return false
    }
  }
  return allBalanceGroupsBalanced(
    balanceGroups(
      rows.map((row) => ({
        commodity: row.commodity === undefined || row.commodity === '' ? fallbackCommodity : row.commodity,
        amount: row.amount,
      })),
    ),
  )
}
