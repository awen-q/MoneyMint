/**
 * M2 恢复 / 导入的纯逻辑（批 4，P-19 / P-20）
 *
 * 与 `core/batch3.ts` 同一口径：视图只做编排，判定与文案全部收口在这里，
 * 便于 Vitest 直接单测（不挂载组件）。
 *
 * 关键口径：
 * - 恢复是全库替换：预检摘要必须展示「备份 vs 当前」覆盖量对比，
 *   执行需输入确认词 RESTORE 解锁，成功后提示用备份中的账号重新登录；
 * - 导入是新建账本：预检 valid=false 时整体拒绝并列出全部错误行号
 *   （RK-M2-04：跳过等于悄悄丢账）。
 */
import type {
  BeancountParseError,
  ImportConflict,
  ImportPreviewResult,
  RestorePreviewResult,
  RestoreStats,
} from '@/api/types'
import { t } from '../i18n'

/** 执行还原所需的二次确认词（后端 service.restore 同值硬校验）。 */
export const RESTORE_CONFIRM_WORD = 'RESTORE'

/** 预检拒绝原因码 → 人类可读文案（error 兜底，未知原因给通用文案）。 */
export function restoreRejectionText(result: RestorePreviewResult): string {
  if (result.error !== undefined && result.error !== '') {
    return result.error
  }
  const byReason: Record<string, string> = {
    not_sqlite: t('core.m2.reject.not_sqlite'),
    integrity_failed: t('core.m2.reject.integrity_failed'),
    not_our_backup: t('core.m2.reject.not_our_backup'),
    future_version: t('core.m2.reject.future_version'),
    file_too_large: t('core.m2.reject.file_too_large'),
  }
  if (result.reason !== undefined && byReason[result.reason] !== undefined) {
    return byReason[result.reason]
  }
  return t('core.m2.reject.generic')
}

/** 恢复端点错误（4xx/5xx）→ 文案。 */
export function mapRestoreError(status: number, message: string): string {
  if (status === 401) return t('core.m2.restoreErr401')
  if (status === 403) return t('core.m2.restoreErr403')
  if (status === 400) return message !== '' ? message : t('core.m2.restoreErr400')
  if (status >= 500) return t('core.m2.restoreErrServer')
  return message !== '' ? message : t('core.m2.restoreErrGeneric')
}

/** 导入端点错误（4xx/5xx）→ 文案。 */
export function mapImportError(status: number, message: string): string {
  if (status === 401) return t('core.m2.importErr401')
  if (status === 400) return message !== '' ? message : t('core.m2.importErr400')
  if (status >= 500) return t('core.m2.importErrServer')
  return message !== '' ? message : t('core.m2.importErrGeneric')
}

/** 预检对比卡的一行：核心表名 + 备份行数 + 当前行数。 */
export interface RestoreCompareRow {
  label: string
  backup: number
  current: number
}

/** 构造「备份 vs 当前」覆盖量对比行（顺序固定：用户/账本/账户/交易）。 */
export function restoreCompareRows(backup: RestoreStats, current: RestoreStats): RestoreCompareRow[] {
  return [
    { label: t('core.m2.compare.users'), backup: backup.users, current: current.users },
    { label: t('core.m2.compare.ledgers'), backup: backup.ledgers, current: current.ledgers },
    { label: t('core.m2.compare.accounts'), backup: backup.accounts, current: current.accounts },
    { label: t('core.m2.compare.transactions'), backup: backup.transactions, current: current.transactions },
  ]
}

/**
 * 解析错误列表 → 逐行文案（`第 N 行：原因`）。
 * 后端保证收集全部错误后才返回，这里保序展示，不做去重截断。
 */
export function formatImportErrors(errors: BeancountParseError[]): string[] {
  return errors.map((e) => t('core.m2.errorLine', { line: String(e.line), msg: e.msg }))
}

/** 导入预检的摘要行（0.6.0 S5：新建/复用账户、新建/跳过交易、新建币种）。 */
export interface ImportSummaryRow {
  label: string
  value: number
}

export function importSummaryRows(prev: ImportPreviewResult): ImportSummaryRow[] {
  return [
    { label: t('core.m2.summary.newAccounts'), value: prev.new_accounts },
    { label: t('core.m2.summary.reuseAccounts'), value: prev.reuse_accounts },
    { label: t('core.m2.summary.newTransactions'), value: prev.new_transactions },
    { label: t('core.m2.summary.skipTransactions'), value: prev.skip_transactions },
    { label: t('core.m2.summary.newCommodities'), value: prev.new_commodities },
  ]
}

/** 预检冲突类型 → 短标签。 */
export function importConflictTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    account_conflict: t('core.m2.conflict.account_conflict'),
    commodity_conflict: t('core.m2.conflict.commodity_conflict'),
    undeclared_account: t('core.m2.conflict.undeclared_account'),
    unbalanced: t('core.m2.conflict.unbalanced'),
    pad_balance_unsupported: t('core.m2.conflict.pad_balance_unsupported'),
  }
  return labels[type] ?? t('core.m2.conflict.generic')
}

/**
 * 预检冲突列表 → 逐行文案（`[标签] 第 N 行 名称：原因`，保序展示，不去重截断）。
 */
export function formatImportConflicts(conflicts: ImportConflict[]): string[] {
  return conflicts.map((c) => {
    const line = c.line > 0 ? t('core.m2.conflictLine', { line: String(c.line) }) : ''
    const name = c.name !== '' ? ` ${c.name}` : ''
    const raw = `${line}${name}`
    const where = raw !== '' ? t('core.m2.conflictWhere', { where: raw }) : ''
    return t('core.m2.conflictEntry', {
      label: importConflictTypeLabel(c.type),
      where,
      reason: c.reason,
    })
  })
}
