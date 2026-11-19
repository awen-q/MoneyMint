/**
 * 交易行视图模型（B2 账单页 / B3 搜索结果共用的纯逻辑层）
 *
 * 现网 `TransactionsView.vue` 的行渲染里混着四件事：徽章判定、取哪个 posting
 * 算展示金额、转账是否带符号、副行字段拼接。B2（账单）与 B3（搜索）要复用
 * 同一套，若各自复制模板就会出现「账单页与搜索页对同一笔交易的金额符号
 * 不一样」这种静默不一致。本模块把这份口径收敛成 `TxnRowView`：
 * **core 产出视图模型，组件只负责渲染。**
 *
 * 四条口径（与现网逐字一致，勿擅自「优化」）：
 * 1. **展示金额**取 `displayEntryOf(postings, accounts)` 的代表分录：
 *    转账取转出方（负值）资金分录绝对值；混合交易（同时含 Expenses 与 Income）
 *    优先正号资金分录；支出 / 收入取资金分录带符号原值；无资金分录取首条。
 * 2. **符号**：`signed = kind !== 'transfer'`（转账不带符号，金额已取绝对值）。
 * 3. **徽章**两组各一枚（0~2 枚，顺序 `[reversal 组] → [kind 组]`）：
 *    reversal 组 `已冲正 > 冲正`，kind 组 `转账 > 期初`；组内互斥、组间并存。
 * 4. **标题**备注优先，为空时按类型回落（转账 / 期初 / 分类名 / 未命名交易）。
 *
 * 纯逻辑约束：不 import Vue / store / 组件，只依赖 `core/record` 与 `core/Money`；
 * 金额一律走定点串（`Money` 无 `toNumber`，禁 parseFloat / Math.abs）。
 */
import { Money } from './Money'
import {
  accountLabel,
  displayEntryOf,
  transactionKind,
  transferRoute,
  type SummaryAccount,
  type TransactionKind,
} from './record'
import type { TransactionView } from '../api/types'

/** 行样式档位：账单单行 / 搜索结果两行 / 抽屉（不截断）。 */
export type TxnRowVariant = 'bill' | 'search' | 'drawer'

/** 副行字段种类（渲染层按 kind 决定图标/样式，本层不排样式）。 */
export type MetaKind = 'date' | 'type' | 'category' | 'account' | 'member' | 'tag'

/** 徽章色调（渲染层映射到主题 token，本层不出现任何色值）。 */
export type BadgeTone = 'neutral' | 'transfer' | 'opening' | 'reversal'

/** 一条副行元信息（text 一律非空，空字段本层不产出）。 */
export interface TxnRowMeta {
  kind: MetaKind
  text: string
}

/** 一枚徽章（一笔交易至多两枚：reversal 组 + kind 组）。 */
export interface TxnRowBadge {
  label: string
  tone: BadgeTone
}

/** 行视图模型：组件只按此渲染，不再做任何判定。 */
export interface TxnRowView {
  /**
   * 交易 id（后端主键），用于行点击跳详情。
   *
   * 放在视图模型里而不是让 `TxnRow` 的 `open` 事件带 payload：组件不必知道
   * 自己渲染的是谁，职责更干净；页面从 `view.id` 取即可，不必再并排存
   * `{ id, view }`（B2 已因此绕了 3 行）。
   */
  id: number
  /** 展示金额（固定两位定点串）。 */
  amount: string
  /** 展示金额所属分录的币种（行内金额按分录币种渲染）。 */
  commodity: string
  /** 是否展示正负号（转账为 false）。 */
  signed: boolean
  /** 主文案（备注优先，空则按类型回落）。 */
  title: string
  /** 副行元信息，顺序即渲染顺序。 */
  meta: TxnRowMeta[]
  /** 徽章（0~2 枚，顺序固定：[reversal 组] → [kind 组]）。 */
  badges: TxnRowBadge[]
}

/** 展示类型的中文标签（用于副行 `type` 项）。 */
const KIND_LABELS: Record<TransactionKind, string> = {
  expense: '支出',
  income: '收入',
  transfer: '转账',
  opening: '期初',
}

/** 备注为空时的兜底标题。 */
const FALLBACK_TITLE = '未命名交易'

/** 各档位的副行字段顺序与 tag 截取上限（顺序即渲染顺序，渲染层不再排序）。 */
interface VariantPlan {
  fields: MetaKind[]
  maxTags: number
}

const VARIANT_PLANS: Record<TxnRowVariant, VariantPlan> = {
  // 账单页单行：必须能被 ellipsis 截断，只给分类 + 成员 + 1 个标签。
  bill: { fields: ['category', 'member', 'tag'], maxTags: 1 },
  // 搜索结果两行 clamp：先给日期与类型，再给分类 / 账户，最后标签与成员。
  search: { fields: ['date', 'type', 'category', 'account', 'tag', 'member'], maxTags: 2 },
  // 抽屉不截断：标签全量。
  drawer: {
    fields: ['date', 'type', 'category', 'account', 'tag', 'member'],
    maxTags: Number.MAX_SAFE_INTEGER,
  },
}

function findAccount(accounts: SummaryAccount[], accountId: number): SummaryAccount | undefined {
  for (const account of accounts) {
    if (account.id === accountId) {
      return account
    }
  }
  return undefined
}

/** 归一为非空文本（去除首尾空白）；空串 / 非字符串一律返回 ''。 */
function cleanText(value: string | undefined): string {
  if (typeof value !== 'string') {
    return ''
  }
  return value.trim()
}

/** 展示金额归一：任何来源的金额都收敛为固定两位定点串。 */
function normalizeAmount(amount: string): string {
  try {
    return Money.from(amount).toString()
  } catch {
    return '0.00'
  }
}

/**
 * 分类账户：优先 Expenses，其次 Income。
 * 混合交易（退款 / 报销类，同时含两类分录）取支出侧——与报表「支出分类」
 * 视角一致，避免同一笔在账单页与报表页归到不同分类。
 */
function findCategoryAccount(
  postings: TransactionView['postings'],
  accounts: SummaryAccount[],
): SummaryAccount | undefined {
  const types: string[] = ['Expenses', 'Income']
  for (const type of types) {
    for (const posting of postings) {
      const account = findAccount(accounts, posting.account_id)
      if (account !== undefined && account.type === type) {
        return account
      }
    }
  }
  return undefined
}

/** 资金账户（Assets / Liabilities）：支出/收入的付款账户，按 postings 顺序取首个。 */
function findFundAccount(
  postings: TransactionView['postings'],
  accounts: SummaryAccount[],
): SummaryAccount | undefined {
  for (const posting of postings) {
    const account = findAccount(accounts, posting.account_id)
    if (account !== undefined && (account.type === 'Assets' || account.type === 'Liabilities')) {
      return account
    }
  }
  return undefined
}

/** 主文案：备注优先，为空时按类型回落（转账 / 期初 / 分类名 / 兜底）。 */
function buildTitle(
  txn: TransactionView,
  kind: TransactionKind,
  accounts: SummaryAccount[],
): string {
  const description = cleanText(txn.description)
  if (description !== '') {
    return description
  }
  if (kind === 'transfer') {
    return '转账'
  }
  if (kind === 'opening') {
    return '期初'
  }
  const category = findCategoryAccount(txn.postings, accounts)
  if (category !== undefined) {
    return accountLabel(category)
  }
  return FALLBACK_TITLE
}

/**
 * 徽章：**两组各出一枚，最多两枚**，顺序固定 `[reversal 组] → [kind 组]`。
 *
 * 「已冲正」是状态修饰、「转账」是交易类型，两个维度互不冲突：一笔被冲正的
 * 转账，用户既要知道它已失效，也要知道它原本是转账（否则不带符号的金额会被
 * 误读成异常）。组内仍互斥：已冲正 > 冲正（`reversed_by` 优先）。
 *
 * `reversed_by` / `reversal_of` 直接读原始值（`?? ''` 兜住旧响应缺字段），
 * 不用真值判断，避免后端给出 `0` / `false` 之类的意外形态。
 */
function buildBadges(txn: TransactionView, kind: TransactionKind): TxnRowBadge[] {
  const out: TxnRowBadge[] = []
  // reversal 组：三选一，**组内互斥**（`已冲正` 优先于 `冲正`）。
  // 为什么已冲正优先：一笔已作废的交易，最需要被看到的是「它作废了」；
  // 「它当初是冲正来的」是次要信息（详情页有 reversal_of 链接可查）。
  // 这条注明是为了挡住后人「顺手改成两条都出」——两组是独立维度（reversal 组 ×
  // kind 组），组内不是。
  if ((txn.reversed_by ?? '') !== '') {
    out.push({ label: '已冲正', tone: 'reversal' })
  } else if ((txn.reversal_of ?? '') !== '') {
    out.push({ label: '冲正', tone: 'neutral' })
  }
  // kind 组：三选一。
  if (kind === 'transfer') {
    out.push({ label: '转账', tone: 'transfer' })
  } else if (kind === 'opening') {
    out.push({ label: '期初', tone: 'opening' })
  }
  return out
}

/**
 * tag 元信息：按出现顺序取至多 `limit` 个，丢弃空标签与重复标签。
 * 超出上限直接丢弃（不拼「+N」，那是渲染层的事）。
 */
function buildTagMetas(txn: TransactionView, limit: number): TxnRowMeta[] {
  const out: TxnRowMeta[] = []
  if (limit <= 0 || !Array.isArray(txn.tags)) {
    return out
  }
  for (const tag of txn.tags) {
    if (out.length >= limit) {
      break
    }
    const text = cleanText(tag)
    if (text === '') {
      continue
    }
    let duplicated = false
    for (const existing of out) {
      if (existing.text === text) {
        duplicated = true
      }
    }
    if (duplicated) {
      continue
    }
    out.push({ kind: 'tag', text })
  }
  return out
}

/** 单个字段的元信息；无有效值时返回 null（绝不产出空字符串项）。 */
function buildMetaItem(
  field: MetaKind,
  txn: TransactionView,
  accounts: SummaryAccount[],
  kind: TransactionKind,
): TxnRowMeta | null {
  if (field === 'date') {
    const date = cleanText(txn.date)
    return date === '' ? null : { kind: 'date', text: date }
  }
  if (field === 'type') {
    return { kind: 'type', text: KIND_LABELS[kind] }
  }
  if (field === 'category') {
    const category = findCategoryAccount(txn.postings, accounts)
    return category === undefined
      ? null
      : { kind: 'category', text: accountLabel(category) }
  }
  if (field === 'account') {
    // 转账展示「转出 → 转入」（与流水页 rowMeta 同口径）；其余展示付款/收款账户。
    const text =
      kind === 'transfer'
        ? transferRoute(txn.postings, accounts)
        : (() => {
            const fund = findFundAccount(txn.postings, accounts)
            return fund === undefined ? '' : accountLabel(fund)
          })()
    return text === '' ? null : { kind: 'account', text }
  }
  // member
  const member = cleanText(txn.created_by_name)
  return member === '' ? null : { kind: 'member', text: member }
}

/** 按档位拼装副行元信息（顺序 = VARIANT_PLANS.fields）。 */
function buildMeta(
  txn: TransactionView,
  accounts: SummaryAccount[],
  kind: TransactionKind,
  plan: VariantPlan,
): TxnRowMeta[] {
  const out: TxnRowMeta[] = []
  for (const field of plan.fields) {
    if (field === 'tag') {
      for (const meta of buildTagMetas(txn, plan.maxTags)) {
        out.push(meta)
      }
      continue
    }
    const item = buildMetaItem(field, txn, accounts, kind)
    if (item !== null) {
      out.push(item)
    }
  }
  return out
}

/**
 * 构造交易行视图模型。
 *
 * @param txn 后端返回的交易（`tags` / `reversed_by` 等字段容忍旧响应缺失）
 * @param accounts 当前账本账户（用于类型判定与展示名；未加载时账户类型
 *     一律按未知处理，落回 `expense` 口径，与 `transactionKind` 一致）
 * @param variant 行样式档位；非法值兜底为 `bill`（运行时防御，类型层已限定）
 */
export function buildTxnRow(
  txn: TransactionView,
  accounts: SummaryAccount[],
  variant: TxnRowVariant,
): TxnRowView {
  const plan = VARIANT_PLANS[variant] === undefined ? VARIANT_PLANS.bill : VARIANT_PLANS[variant]
  const kind = transactionKind(txn.postings, accounts)
  const entry = displayEntryOf(txn.postings, accounts)
  return {
    id: txn.id,
    amount: normalizeAmount(entry.amount),
    commodity: entry.commodity,
    // 转账金额已取绝对值，再带符号会出现「+1,000」这种误导性正号。
    signed: kind !== 'transfer',
    title: buildTitle(txn, kind, accounts),
    meta: buildMeta(txn, accounts, kind, plan),
    badges: buildBadges(txn, kind),
  }
}
