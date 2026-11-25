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
 */
import type { IdentityCheckResult } from '@/api/types'
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

/** 三种口径的免责声明，任何状态都必须带着它。 */
export const LEDGER_HEALTH_CAVEAT =
  '本检查按币种实时核对分录借贷是否相等；不是 bean-check，也不是余额校准（balance_key 为日初口径）。'

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
      text: '分录借贷恒等式检查失败，请稍后重试或查看明细',
      detail: LEDGER_HEALTH_CAVEAT,
    }
  }
  if (result === null) {
    return {
      tone: 'unknown',
      text: '正在进行分录借贷恒等式检查…',
      detail: LEDGER_HEALTH_CAVEAT,
    }
  }
  if (result.balanced) {
    return {
      tone: 'ok',
      text: `分录借贷恒等式检查通过：${result.posting_count} 条分录按币种借贷平衡`,
      detail: LEDGER_HEALTH_CAVEAT,
    }
  }
  const diffs = formatIdentityDiffs(fromIdentityDiffs(result.diffs))
  return {
    tone: 'unbalanced',
    text: `分录借贷恒等式检查未通过：${diffs === '' ? '差额明细缺失' : `按币种差额 ${diffs}`}`,
    detail: LEDGER_HEALTH_CAVEAT,
  }
}
