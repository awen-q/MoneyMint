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

/** 执行还原所需的二次确认词（后端 service.restore 同值硬校验）。 */
export const RESTORE_CONFIRM_WORD = 'RESTORE'

/** 预检拒绝原因码 → 人类可读文案（error 兜底，未知原因给通用文案）。 */
export function restoreRejectionText(result: RestorePreviewResult): string {
  if (result.error !== undefined && result.error !== '') {
    return result.error
  }
  const byReason: Record<string, string> = {
    not_sqlite: '不是有效的 SQLite 数据库文件',
    integrity_failed: '备份文件已损坏，无法通过完整性校验',
    not_our_backup: '缺少核心表，不是本系统的备份',
    future_version: '备份来自更新的版本，降级还原会丢列',
    file_too_large: '备份文件超过 512MB 上限',
  }
  if (result.reason !== undefined && byReason[result.reason] !== undefined) {
    return byReason[result.reason]
  }
  return '备份未通过预检'
}

/** 恢复端点错误（4xx/5xx）→ 文案。 */
export function mapRestoreError(status: number, message: string): string {
  if (status === 401) return '登录状态已失效，请重新登录后再试'
  if (status === 403) return '仅系统管理员可以还原备份'
  if (status === 400) return message !== '' ? message : '上传失败：请确认选择的是 .db 备份文件'
  if (status >= 500) return '服务端还原失败，数据未改动；请稍后重试或联系管理员'
  return message !== '' ? message : '还原请求失败，请稍后重试'
}

/** 导入端点错误（4xx/5xx）→ 文案。 */
export function mapImportError(status: number, message: string): string {
  if (status === 401) return '登录状态已失效，请重新登录后再试'
  if (status === 400) return message !== '' ? message : '请求无效：请确认文件内容为 Beancount 文本'
  if (status >= 500) return '服务端导入失败，未产生任何账本；请稍后重试'
  return message !== '' ? message : '导入请求失败，请稍后重试'
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
    { label: '用户', backup: backup.users, current: current.users },
    { label: '账本', backup: backup.ledgers, current: current.ledgers },
    { label: '账户', backup: backup.accounts, current: current.accounts },
    { label: '交易', backup: backup.transactions, current: current.transactions },
  ]
}

/**
 * 解析错误列表 → 逐行文案（`第 N 行：原因`）。
 * 后端保证收集全部错误后才返回，这里保序展示，不做去重截断。
 */
export function formatImportErrors(errors: BeancountParseError[]): string[] {
  return errors.map((e) => `第 ${e.line} 行：${e.msg}`)
}

/** 导入预检的摘要行（0.6.0 S5：新建/复用账户、新建/跳过交易、新建币种）。 */
export interface ImportSummaryRow {
  label: string
  value: number
}

export function importSummaryRows(prev: ImportPreviewResult): ImportSummaryRow[] {
  return [
    { label: '新建账户', value: prev.new_accounts },
    { label: '复用账户', value: prev.reuse_accounts },
    { label: '新建交易', value: prev.new_transactions },
    { label: '跳过交易（已存在）', value: prev.skip_transactions },
    { label: '新建币种', value: prev.new_commodities },
  ]
}

/** 预检冲突类型 → 短标签。 */
export function importConflictTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    account_conflict: '账户冲突',
    commodity_conflict: '币种冲突',
    undeclared_account: '未声明账户',
    unbalanced: '借贷不平',
    pad_balance_unsupported: 'pad/balance 不支持',
  }
  return labels[type] ?? '冲突'
}

/**
 * 预检冲突列表 → 逐行文案（`[标签] 第 N 行 名称：原因`，保序展示，不去重截断）。
 */
export function formatImportConflicts(conflicts: ImportConflict[]): string[] {
  return conflicts.map((c) => {
    const line = c.line > 0 ? `第 ${c.line} 行` : ''
    const name = c.name !== '' ? ` ${c.name}` : ''
    const where = line !== '' || name !== '' ? `${line}${name}：` : ''
    return `[${importConflictTypeLabel(c.type)}] ${where}${c.reason}`
  })
}
