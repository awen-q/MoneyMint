/**
 * 同步错误文案薄映射（产品 P1-1）
 *
 * 只做「稳定错误码 → 中文原因 + 建议动作」一层薄映射，文案全部走 i18n 字典；
 * 未知码一律原文透传（reason = rawMessage，空原文回退 code），绝不返回空串让 UI 留白。
 * 原始 code / message 仍在同步页折叠区展示，便于排障与反馈。
 */
import { t } from '@/i18n'
import type { MessageKey } from '@/i18n/zh-CN'

/** 一条错误的用户可读解释。 */
export interface SyncErrorDescription {
  reason: string
  action?: string
}

interface ErrorCopy {
  reason: MessageKey
  action?: MessageKey
}

/** 已知码表：DEAD_CODES + account_not_found + 顶层常见码 + P0 协议校验码。 */
const ERROR_COPY: Record<string, ErrorCopy> = {
  account_closed: {
    reason: 'syncError.account_closed.reason',
    action: 'syncError.account_closed.action',
  },
  account_balance_not_zero: {
    reason: 'syncError.account_balance_not_zero.reason',
    action: 'syncError.account_balance_not_zero.action',
  },
  opening_via_api_only: {
    reason: 'syncError.opening_via_api_only.reason',
    action: 'syncError.opening_via_api_only.action',
  },
  idempotency_key_deleted: {
    reason: 'syncError.idempotency_key_deleted.reason',
    action: 'syncError.idempotency_key_deleted.action',
  },
  idempotency_payload_mismatch: {
    reason: 'syncError.idempotency_payload_mismatch.reason',
    action: 'syncError.idempotency_payload_mismatch.action',
  },
  validation: { reason: 'syncError.validation.reason', action: 'syncError.validation.action' },
  account_not_found: {
    reason: 'syncError.account_not_found.reason',
    action: 'syncError.account_not_found.action',
  },
  network_error: {
    reason: 'syncError.network_error.reason',
    action: 'syncError.network_error.action',
  },
  unauthorized: {
    reason: 'syncError.unauthorized.reason',
    action: 'syncError.unauthorized.action',
  },
  forbidden: { reason: 'syncError.forbidden.reason', action: 'syncError.forbidden.action' },
  invalid_push_results: {
    reason: 'syncError.invalid_push_results.reason',
    action: 'syncError.invalid_push_results.action',
  },
}

/** status 形态的别名：客户端把 401/403 同时编码进 code 时也能命中。 */
const CODE_ALIASES: Record<string, string> = {
  '401': 'unauthorized',
  http_401: 'unauthorized',
  '403': 'forbidden',
  http_403: 'forbidden',
}

/**
 * 错误码 → 原因 + 建议动作。
 *
 * `http_5xx` / `http_4xx`（除 401/403）走带 {status} 占位的通用文案；
 * 任何未知码返回 rawMessage 原文，rawMessage 为空时回退 code，保证不留白。
 */
export function describeSyncError(code: string, rawMessage: string): SyncErrorDescription {
  const normalized = CODE_ALIASES[code] ?? code
  const statusMatch = /^http_(\d{3})$/.exec(normalized)
  const copy: ErrorCopy | undefined =
    ERROR_COPY[normalized] ??
    (statusMatch === null
      ? undefined
      : { reason: 'syncError.http_error.reason', action: 'syncError.http_error.action' })
  if (copy === undefined) {
    const raw = rawMessage.trim()
    const fallback = code.trim()
    return { reason: raw !== '' ? raw : fallback !== '' ? fallback : '未知同步错误' }
  }
  const params = statusMatch === null ? undefined : { status: statusMatch[1] as string }
  // http_401 / http_403 已被 CODE_ALIASES 归一，不会走到通用 HTTP 文案。
  return {
    reason: params === undefined ? t(copy.reason) : t(copy.reason, params),
    action: copy.action === undefined ? undefined : t(copy.action),
  }
}

/** 把引擎的 status 类 fallback code 转成薄映射能识别的通用码。 */
export function httpErrorCode(status: number): string {
  return `http_${status}`
}
