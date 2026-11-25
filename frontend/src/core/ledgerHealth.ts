/**
 * 首页「账本健康」状态条文案（纯函数，零 DOM / 零 Vue，便于单测）
 *
 * 数据源固定为 `GET /api/identity/check`：按币种对全账本未软删分录求和，
 * 判断借贷是否相等。这是**实时的交易恒等式**，不是 bean-check（只在 CI /
 * 脚本与 BEAN_CHECK_STRICT=1 的 go test 里跑），也不是余额校准
 * （balance_key 是日初口径、落账 D-1）。三者不可混称。
 *
 * 差额格式化复用 `core/batch3.ts` 的 `fromIdentityDiffs` /
 * `formatIdentityDiffs`，避免与数据安全页各写一份。
 *
 * i18n：文案键在账本健康前缀下（阶段 2 子批 7），**访问时**调 t() 求值，
 * 切语言后重新构建即得新语言（不在模块顶层存译文快照）。
 */
import type { IdentityCheckResult } from '@/api/types'
import { t } from '@/i18n'

import { formatIdentityDiffs, fromIdentityDiffs } from './batch3'

export type LedgerHealthTone = 'ok' | 'unbalanced' | 'unknown'

export interface LedgerHealthNotice {
  /** 决定状态条配色，不承载文案。 */
  tone: LedgerHealthTone
  /** 一行人话，状态条主文案。 */
  text: string
  /** 口径说明：明确不是 bean-check、不是余额校准。 */
  detail: string
}

/**
 * 三种口径的免责声明（函数而非模块级常量）：任何状态都必须带着它，
 * 且切语言后要取当前语言，故访问时求值。
 */
export function ledgerHealthCaveat(): string {
  return t('bills.healthCaveat')
}

/**
 * 把恒等式检查结果翻译成状态条文案。
 *
 * @param result 接口结果；`null` 表示尚未返回。
 * @param failed 接口请求失败；优先于 `result`。
 */
export function buildLedgerHealthNotice(
  result: IdentityCheckResult | null,
  failed = false,
): LedgerHealthNotice {
  if (failed) {
    return {
      tone: 'unknown',
      text: t('bills.healthCheckFailed'),
      detail: ledgerHealthCaveat(),
    }
  }
  if (result === null) {
    return {
      tone: 'unknown',
      text: t('bills.healthChecking'),
      detail: ledgerHealthCaveat(),
    }
  }
  if (result.balanced) {
    return {
      tone: 'ok',
      text: t('bills.healthOk', { count: String(result.posting_count) }),
      detail: ledgerHealthCaveat(),
    }
  }
  const diffs = formatIdentityDiffs(fromIdentityDiffs(result.diffs))
  const detailText =
    diffs === ''
      ? t('bills.healthMissingDiffs')
      : t('bills.healthUnbalancedDiffs', { diffs })
  return {
    tone: 'unbalanced',
    text: t('bills.healthUnbalanced', { detail: detailText }),
    detail: ledgerHealthCaveat(),
  }
}
