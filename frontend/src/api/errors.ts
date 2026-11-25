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
import { t } from '@/i18n'
import { zhCN, type MessageKey } from '@/i18n/zh-CN'

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
 * 稳定错误码 → 用户文案的集中入口（设计 §5.2；阶段 1 迁入 i18n 字典）。
 *
 * 中文文案已迁到 `frontend/src/i18n/zh-CN.ts`，key 形如 `apiErrors.<稳定码>`
 * （错误码即 key，与后端契约同源）；en.ts 同步提供英文。
 *
 * 与 `frontend/src/core/sync/models.ts` 的 `DEAD_CODES` 用途不同：本表覆盖
 * **在线端点**返回的全部稳定码，供页面展示可读文案，绝不把 `HTTP 500` 原文
 * 或后端英文报错甩给用户。`txn_already_reversed` 等在线码不进 `DEAD_CODES`
 * （它们不产生于 sync/push 路径）。
 *
 * 未知码返回空串，调用方应回退到 `ApiError.message`（后端通常已给可读文案）；
 * 不要把 `code` 本身当文案展示。
 */
function isKnownApiErrorKey(key: string): boolean {
  // 只认真实存在的字符串 value：顺带挡住 'constructor' / '__proto__' 这类
  // 原型链属性（typeof 非 string），避免把函数当文案返回。
  return typeof (zhCN as Record<string, string>)[key] === 'string'
}

/** 按稳定错误码返回当前语言文案；未知码返回空串（调用方回退 ApiError.message）。 */
export function codeMessage(code: string): string {
  if (code === '') {
    return ''
  }
  const key = `apiErrors.${code}`
  if (!isKnownApiErrorKey(key)) {
    return ''
  }
  // 动态拼串无法直接满足 MessageKey 字面量联合，已先用字典存在性校验兜底。
  return t(key as MessageKey)
}
