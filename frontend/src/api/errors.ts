/**
 * API 错误封装（批 0）
 *
 * 后端错误体约定（`internal/handler/handler.go` 的 writeError）：
 * - `{ "error": "文案", "code"?: "稳定错误码", ...明细 }`
 * - 关闭账户余额非 0 时额外带 `account_uuid` 与 `balances`；
 * - 限流时额外带 `retry_after_seconds`；
 * - 未知错误回退 `{ "error": "..." }`。
 *
 * 前端保留 `message`（用户可读文案）与 `balances`（结构化差额），
 * 其余明细收进 `details`，便于页面按需读取而不丢信息。
 */
import type { BalanceDiff } from './types'

/** 错误响应体（宽松解析，字段都可能缺失）。 */
export interface ApiErrorBody {
  error?: string
  message?: string
  code?: string
  balances?: BalanceDiff[]
  details?: unknown
  [key: string]: unknown
}

/** 构造 ApiError 的选项。 */
export interface ApiErrorOptions {
  code?: string
  details?: Record<string, unknown>
  balances?: BalanceDiff[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBalanceDiff(value: unknown): value is BalanceDiff {
  return (
    isRecord(value) &&
    typeof value.commodity === 'string' &&
    typeof value.amount === 'string'
  )
}

/** 统一的 API 错误：HTTP 状态 + 稳定错误码 + 结构化明细。 */
export class ApiError extends Error {
  /** HTTP 状态码。 */
  readonly status: number
  /** 后端稳定错误码（如 `account_balance_not_zero`），无则为 undefined。 */
  readonly code?: string
  /** 其余明细（如 `account_uuid`、`retry_after_seconds`）。 */
  readonly details?: Record<string, unknown>
  /** 关闭账户时的按币种差额明细。 */
  readonly balances?: BalanceDiff[]

  constructor(status: number, message: string, options: ApiErrorOptions = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = options.code
    this.details = options.details
    this.balances = options.balances
  }

  /**
   * 从 HTTP 状态与响应体解析错误。
   * 文案优先级：`error` → `message` → `HTTP ${status}`（未知码回退）。
   */
  static fromBody(status: number, body: unknown): ApiError {
    if (typeof body === 'string' && body.trim() !== '') {
      return new ApiError(status, body.trim())
    }
    if (!isRecord(body)) {
      return new ApiError(status, `HTTP ${status}`)
    }

    const message =
      typeof body.error === 'string' && body.error !== ''
        ? body.error
        : typeof body.message === 'string' && body.message !== ''
          ? body.message
          : `HTTP ${status}`

    const code = typeof body.code === 'string' && body.code !== '' ? body.code : undefined

    const balances = Array.isArray(body.balances)
      ? body.balances.filter(isBalanceDiff)
      : undefined

    // 把除已知字段外的键收进 details（含后端平铺的 account_uuid 等）。
    const { error: _error, message: _message, code: _code, balances: _balances, ...rest } = body
    const details = Object.keys(rest).length > 0 ? rest : undefined

    return new ApiError(status, message, {
      code,
      details,
      balances: balances && balances.length > 0 ? balances : undefined,
    })
  }
}

/**
 * 稳定错误码 → 中文用户文案的集中映射（设计 §5.2）。
 *
 * 与 `frontend/src/core/sync/models.ts` 的 `DEAD_CODES` 用途不同：本表覆盖
 * **在线端点**返回的全部稳定码，供页面展示可读文案，绝不把 `HTTP 500` 原文
 * 或后端英文报错甩给用户。`txn_already_reversed` 等在线码不进 `DEAD_CODES`
 * （它们不产生于 sync/push 路径）。
 *
 * 未知码返回空串，调用方应回退到 `ApiError.message`（后端通常已给可读文案）；
 * 不要把 `code` 本身当文案展示。
 */
const CODE_MESSAGES: Readonly<Record<string, string>> = {
  // ---- 0.6.0 账本删除（S1）----
  ledger_has_members: '还有其他成员未移除，请先在成员管理中移除后再删除账本',
  last_ledger: '这是最后一个有效账本，不能删除',
  ledger_deleted: '该账本已删除，请切换到其他账本',
  // ---- 0.6.0 账户 / 币种（S2）----
  account_name_invalid: '账户名不符合 Beancount 格式要求，请检查根类别与首段命名',
  account_name_exists: '该账户名已被占用，请换一个名称',
  parent_not_found: '父账户不存在或属于其他账本',
  parent_type_mismatch: '父账户类型与子账户不匹配',
  // ---- 批 II 账户展示字段（PATCH / create 共用）----
  account_visual_invalid: '图标需不超过 8 个字符的 emoji，颜色需为 #RRGGBB 格式',
  commodity_exists: '该币种已存在',
  commodity_in_use: '该币种已被账户、交易或价格引用，不能删除',
  // ---- 0.6.0 余额校准（S4）----
  balance_date_invalid: '指定日期不合法或超出允许范围，须不早于 max(账户开户日, 账本期初日期) 且不晚于今日',
  balance_date_too_early: '指定日期过早，无法在 max(账户开户日, 账本期初日期) 之后生成补平分录',
  opening_equity_closed: '期初余额权益账户已关闭，无法生成校准分录，请先恢复该账户',
  // ---- 0.6.0 交易修改（S6）----
  txn_edit_forbidden: '只能修改自己记的账，或由账本 owner 修改',
  txn_not_editable: '期初 / 冲正 / 校准交易不能修改',
  txn_already_reversed: '该交易已被冲正，请修改最新版本',
  // ---- 0.6.0 导入（S5）----
  import_pad_balance_unsupported:
    '文件含 pad / balance 指令，请展开成普通交易后重导，或改用新建账本模式',
  import_unbalanced: '导入交易存在借贷不平，请检查预检列出的行号',
  import_account_conflict: '同名账户类型或币种限制冲突，无法复用',
  import_batch_not_found: '未找到该导入批次，无法撤销',
  // ---- 0.5.1 及更早的既有在线码（同源镜像，避免页面各自硬编码）----
  account_not_found: '账户不存在',
  account_closed: '账户已关闭，不能记账',
  account_balance_not_zero: '账户余额不为 0，请先转出',
  account_open_date_after_ledger: '开户日期不能晚于账本期初日期',
  opening_conflict: '期初余额冲突，请刷新后重试',
  opening_via_api_only: '期初余额请在在线端设置',
  opening_amount_invalid: '期初金额不合法',
  opening_direction_invalid: '期初方向不合法',
  opening_commodity_mismatch: '期初币种与账户限定币种不一致',
  opening_account_not_openable: '该账户不能设置期初余额',
  opening_date_mismatch: '期初日期与账本设置不一致',
  ledger_opening_date_invalid: '期初日期需为 YYYY-MM-DD 且不晚于今日',
  ledger_opening_date_after_first_txn: '期初日期不能晚于账本最早交易',
  idempotency_key_deleted: '该请求的交易已被删除，请重新提交',
  idempotency_payload_mismatch: '同一请求标识对应了不同内容，请重新提交',
  csrf_required: '缺少 CSRF 头，请刷新页面后重试',
}

/** 按稳定错误码返回中文文案；未知码返回空串（调用方回退 ApiError.message）。 */
export function codeMessage(code: string): string {
  const found = CODE_MESSAGES[code]
  return found === undefined ? '' : found
}
