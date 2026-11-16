/**
 * Beancount 导出片段（预览 / 小票专用纯函数）
 *
 * ⚠️ 职责边界：权威导出仍是后端 `GET /api/export`（internal/export/beancount.go）。
 *    本模块只负责「交易尚未落库时」的对照预览与票面展示，不参与提交载荷，
 *    也不重复实现后端的文件级导出（open/close/price/空行等）。
 *
 * 格式逐字对齐 internal/export/beancount.go:246-258（用单测钉死为契约）：
 *   ${date} ${flag} "${desc}"
 *     tags: "${joinTags(tags)}"
 *     ${account.name} ${beanAmount(amount)} ${commodity}
 *
 * 硬约束：零 DOM / 零 Vue 依赖；金额一律走 core/Money，禁止裸浮点与千分位。
 */
import { Money } from './Money'
import type { TxnFlag } from '../api/types'

/** 生成预览片段所需的一条分录。 */
export interface BeanPosting {
  /** account.name（ASCII 冒号层级导出名）；空表示账户尚未选择。 */
  accountName: string
  /** 带符号定点金额字符串。 */
  amount: string
  commodity: string
}

/** 生成预览片段的输入。 */
export interface BeanSnippetInput {
  date: string
  flag: TxnFlag
  description: string
  tags: readonly string[]
  postings: ReadonlyArray<BeanPosting>
}

/** 未选账户时的占位符（稿内同款，便于 bean-check 前直观发现）。 */
export const BEAN_ACCOUNT_PLACEHOLDER = '<待选账户>'

/**
 * 金额 → Beancount 数字（定点两位、无指数、无千分位）。
 * 与稿内 `beanAmt()` 等价，但用 Money 而非 `(x/100).toFixed(2)`。
 */
export function beanAmount(amount: string): string {
  const value = Money.from(amount)
  const magnitude = value.abs().toString()
  return value.isNegative() ? `-${magnitude}` : magnitude
}

/**
 * 标签清洗 + 空格拼接，等价 Go `joinTags`（internal/export/beancount.go:298）：
 * 去首尾空白、忽略空标签、用单个空格连接。
 */
export function joinTags(tags: readonly string[]): string {
  const clean: string[] = []
  for (const tag of tags) {
    const trimmed = tag.trim()
    if (trimmed !== '') {
      clean.push(trimmed)
    }
  }
  return clean.join(' ')
}

/**
 * Go `%q` 的字符串转义（只覆盖记账文本会出现的字符）：
 * 反斜杠与双引号必须转义，换行 / 回车 / 制表符写成 \n / \r / \t，
 * 其余 Unicode（含中文）原样保留，与 fmt.Sprintf("%q", ...) 一致。
 */
function goQuote(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
}

/**
 * 构造对照 bean-check 的片段文本。
 * 中文标签走 `tags: "..."` 元数据行（Beancount 的 #tag 只收 ASCII），不是 #tag。
 */
export function buildBeanSnippet(input: BeanSnippetInput): string {
  const lines: string[] = [`${input.date} ${input.flag} "${goQuote(input.description)}"`]
  const joined = joinTags(input.tags)
  if (joined !== '') {
    lines.push(`  tags: "${goQuote(joined)}"`)
  }
  for (const posting of input.postings) {
    const name = posting.accountName === '' ? BEAN_ACCOUNT_PLACEHOLDER : posting.accountName
    lines.push(`  ${name} ${beanAmount(posting.amount)} ${posting.commodity}`)
  }
  return lines.join('\n')
}
