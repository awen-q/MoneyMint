<script setup lang="ts">
/**
 * P-15 数据安全（批 3）
 *
 * 与旧版 backup_card.dart + import_export_screen.dart 1:1：
 * - 备份（仅系统管理员渲染，避免暴露无权功能）：列表 / 立即备份 / 下载 /
 *   409 冲突 / 503 未启用等错误文案 / 相对时间 / 体积 / 失败记录；
 * - 导出：单文件 beancount、目录 zip、CSV（纯前端生成，字段与旧版一致）；
 * - 导入：本期占位提示（M2 的 P-19/P-20 属批 4）。
 *
 * §14.5 #3 不降级且按方案**补强**：旧版是导出后用响应头告警、不阻断；
 * 新版导出前先跑 `GET /api/identity/check`，不平即**阻断**并列出按币种差额。
 * 导出成功后仍读 `X-Ledger-*` 响应头做二次提示（双保险）。
 *
 * i18n 阶段 2 子批 3（数据域）：用户可见文案走字典。**待收敛**：以下文案
 * 原本由 `core/batch3` 输出中文，本视图内做了等价映射（core 未改动）：
 * `mapBackupError` 的错误文案、`formatIdentityDiffs` 的“、”分隔符；
 * `relativeTime` / `formatBackupSize` 属日期/体积格式化，按约定不动。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { accountApi, backupApi, exportApi, identityApi, transactionApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { BackupItem } from '@/api/types'
import {
  backupSucceeded,
  downloadBlob,
  downloadText,
  formatBackupSize,
  fromIdentityDiffs,
  relativeTime,
} from '@/core/batch3'
import { buildCsvRowsFromTransactions, buildTransactionsCsv } from '@/core/csv'
import { formatAmount } from '@/core/Money'
import { t } from '@/i18n'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()
const router = useRouter()

const items = ref<BackupItem[]>([])
const backupLoading = ref(false)
const backupBusy = ref(false)
const backupError = ref('')
const showAll = ref(false)
const notice = ref('')
const actionError = ref('')
const checking = ref(false)
const unbalanced = ref(false)
const diffText = ref('')

const isAdmin = computed(() => session.user !== null && session.user.is_admin === true)
const visibleItems = computed(() => (showAll.value ? items.value : items.value.slice(0, 3)))
const successfulItems = computed(() => items.value.filter(backupSucceeded))
const totalSize = computed(() => {
  let total = 0
  for (const item of items.value) {
    total += item.size
  }
  return total
})

function messageOf(err: unknown): string {
  return err instanceof ApiError ? err.message : t('dataSafety.errGeneric')
}

/** 备份错误码 → 文案（core/batch3.mapBackupError 的视图内等价映射，待收敛）。 */
function backupErrorText(status: number, message: string): string {
  switch (status) {
    case 401:
      return t('dataSafety.errLogin')
    case 403:
      return t('dataSafety.errForbidden')
    case 409:
      return t('dataSafety.errConflict')
    case 503:
      return t('dataSafety.errDisabled')
    case 0:
      return t('dataSafety.errNetwork')
    default:
      return message === '' ? t('dataSafety.errGeneric') : message
  }
}

/** 差额明细文案（core/batch3.formatIdentityDiffs 的视图内等价映射，待收敛）。 */
function identityDiffText(diffs: Array<{ commodity: string; amount: string }>): string {
  const parts: string[] = []
  for (const diff of diffs) {
    const text = formatAmount(diff.amount)
    const sign = text.charAt(0) === '-' || text === '0.00' ? '' : '+'
    parts.push(`${diff.commodity} ${sign}${text}`)
  }
  return parts.join(t('dataSafety.diffSeparator'))
}

/** M2（P-19 / P-20）：导入 / 恢复向导页入口。 */
function goImport(): void {
  void router.push({ name: 'import' })
}
function goRestore(): void {
  void router.push({ name: 'restore' })
}

async function loadBackups(): Promise<void> {
  if (!isAdmin.value) {
    return
  }
  backupLoading.value = true
  backupError.value = ''
  try {
    const res = await backupApi.list()
    items.value = Array.isArray(res.items) ? res.items : []
  } catch (err) {
    backupError.value =
      err instanceof ApiError ? backupErrorText(err.status, err.message) : backupErrorText(0, '')
  } finally {
    backupLoading.value = false
  }
}

async function runBackup(): Promise<void> {
  if (backupBusy.value) {
    return
  }
  backupBusy.value = true
  backupError.value = ''
  notice.value = ''
  try {
    await backupApi.run()
    notice.value = t('dataSafety.noticeBackupCreated')
    await loadBackups()
  } catch (err) {
    backupError.value =
      err instanceof ApiError ? backupErrorText(err.status, err.message) : backupErrorText(0, '')
  } finally {
    backupBusy.value = false
  }
}

async function downloadBackup(name: string): Promise<void> {
  backupError.value = ''
  try {
    const blob = await backupApi.download(name)
    downloadBlob(name, blob)
    notice.value = t('dataSafety.noticeDownloaded', { name })
  } catch (err) {
    backupError.value =
      err instanceof ApiError ? backupErrorText(err.status, err.message) : backupErrorText(0, '')
  }
}

/** 导出前恒等式校验：不平即阻断（方案 §14.5 #3 比旧版更严）。 */
async function ensureBalanced(): Promise<boolean> {
  checking.value = true
  actionError.value = ''
  try {
    const res = await identityApi.check()
    if (!res.balanced) {
      unbalanced.value = true
      diffText.value = identityDiffText(fromIdentityDiffs(res.diffs))
      return false
    }
    unbalanced.value = false
    diffText.value = ''
    return true
  } catch (err) {
    actionError.value = t('dataSafety.identityCheckFailed', { message: messageOf(err) })
    return false
  } finally {
    checking.value = false
  }
}

async function exportFile(kind: 'beancount' | 'archive'): Promise<void> {
  if (checking.value) {
    return
  }
  if (!(await ensureBalanced())) {
    return
  }
  try {
    const result = kind === 'beancount' ? await exportApi.beancount() : await exportApi.archive()
    const filename = kind === 'beancount' ? 'family.beancount' : 'ledger-beancount.zip'
    downloadBlob(filename, result.blob)
    if (!result.balanced) {
      actionError.value = t('dataSafety.exportedUnbalanced', { diffs: identityDiffText(result.diffs) })
    } else {
      notice.value = t('dataSafety.noticeExported', { filename })
    }
  } catch (err) {
    actionError.value = t('dataSafety.exportFailed', { message: messageOf(err) })
  }
}

async function exportCsv(): Promise<void> {
  try {
    const [txnRes, accountRes] = await Promise.all([transactionApi.list(), accountApi.list({ includeClosed: true })])
    const rows = buildCsvRowsFromTransactions(
      Array.isArray(txnRes.transactions) ? txnRes.transactions : [],
      Array.isArray(accountRes.accounts) ? accountRes.accounts : [],
    )
    downloadText('family-ledger.csv', buildTransactionsCsv(rows), 'text/csv')
    notice.value = t('dataSafety.noticeExportedCsv', { n: String(rows.length) })
    actionError.value = ''
  } catch (err) {
    actionError.value = t('dataSafety.csvExportFailed', { message: messageOf(err) })
  }
}

onMounted(() => { void loadBackups() })
</script>

<template>
  <section class="ds">
    <header class="ds__hero fb-hero">
      <span class="ds__title">{{ t('dataSafety.title') }}</span>
    </header>

    <p v-if="notice" class="ds__notice ds__notice--ok" role="status">{{ notice }}</p>
    <p v-if="actionError" class="ds__notice ds__notice--err" role="alert">{{ actionError }}</p>

    <!-- 导出不平阻断：§14.5 #3 -->
    <div v-if="unbalanced" class="fb-card ds__block" role="alert">
      <h2>{{ t('dataSafety.unbalancedTitle') }}</h2>
      <p>{{ t('dataSafety.diffLabel', { diffs: diffText || t('dataSafety.noDiffDetail') }) }}</p>
      <p class="fb-muted">{{ t('dataSafety.unbalancedHint') }}</p>
    </div>

    <div class="fb-card ds__card">
      <h2>{{ t('dataSafety.exportTitle') }}</h2>
      <p class="ds__desc">{{ t('dataSafety.exportDesc') }}</p>
      <div class="ds__buttons">
        <button class="fb-btn-primary ds__btn" type="button" :disabled="checking" @click="exportFile('beancount')">
          {{ checking ? t('dataSafety.checking') : t('dataSafety.exportBeancount') }}
        </button>
        <button class="fb-btn-ghost ds__btn" type="button" :disabled="checking" @click="exportFile('archive')">{{ t('dataSafety.exportArchive') }}</button>
        <button class="fb-btn-ghost ds__btn" type="button" @click="exportCsv">{{ t('dataSafety.exportCsv') }}</button>
      </div>
    </div>

    <div class="fb-card ds__card">
      <h2>{{ t('dataSafety.importTitle') }}</h2>
      <p class="ds__desc">{{ t('dataSafety.importDesc') }}</p>
      <p class="ds__desc">{{ t('dataSafety.revivalNote') }}</p>
      <div class="ds__buttons">
        <button class="fb-btn-primary ds__btn" type="button" @click="goImport">{{ t('dataSafety.goImport') }}</button>
        <button v-if="isAdmin" class="fb-btn-ghost ds__btn" type="button" @click="goRestore">{{ t('dataSafety.goRestore') }}</button>
      </div>
    </div>

    <!-- 备份：仅系统管理员渲染 -->
    <div v-if="isAdmin" class="fb-card ds__card">
      <div class="ds__card-head">
        <h2>{{ t('dataSafety.backupTitle') }}</h2>
        <span v-if="backupBusy" class="fb-muted">{{ t('dataSafety.backingUp') }}</span>
      </div>
      <p v-if="backupLoading" class="ds__state">{{ t('dataSafety.loadingBackups') }}</p>
      <template v-else>
        <p v-if="backupError" class="ds__err">{{ backupError }}
          <button class="fb-btn-ghost ds__btn" type="button" @click="loadBackups">{{ t('dataSafety.retry') }}</button>
        </p>
        <p v-else-if="items.length === 0" class="ds__state">
          {{ t('dataSafety.noBackups') }}
        </p>
        <p v-else class="ds__desc">
          {{ t('dataSafety.recentBackup', {
            time: relativeTime(items[0].created_at),
            count: String(successfulItems.length),
            size: formatBackupSize(totalSize),
          }) }}
        </p>

        <!-- B7：与「导入」卡片下方那段**逐字一致**（同一件事两种说法最容易被当成谣言）。 -->
        <p class="ds__desc">{{ t('dataSafety.revivalNote') }}</p>

        <div class="ds__buttons">
          <button class="fb-btn-primary ds__btn" type="button" :disabled="backupBusy" @click="runBackup">{{ t('dataSafety.runBackup') }}</button>
          <button
            v-if="successfulItems.length > 0"
            class="fb-btn-ghost ds__btn"
            type="button"
            @click="downloadBackup(successfulItems[0].name)"
          >{{ t('dataSafety.downloadLatest') }}</button>
          <button
            v-if="items.length > 3"
            class="fb-btn-ghost ds__btn"
            type="button"
            @click="showAll = !showAll"
          >{{ showAll ? t('dataSafety.collapseList') : t('dataSafety.viewAll', { n: String(items.length) }) }}</button>
        </div>

        <ul v-if="showAll" class="ds__backups">
          <li v-for="item in visibleItems" :key="item.name">
            <span class="ds__status" :class="backupSucceeded(item) ? 'ds__status--ok' : 'ds__status--err'">
              {{ backupSucceeded(item) ? '✓' : '!' }}
            </span>
            <span class="ds__backup-name">
              {{ item.name }}
              <small>
                {{ backupSucceeded(item)
                  ? t('dataSafety.backupMeta', {
                    trigger: item.trigger === 'manual' ? t('dataSafety.triggerManual') : t('dataSafety.triggerAuto'),
                    size: formatBackupSize(item.size),
                    time: relativeTime(item.created_at),
                  })
                  : t('dataSafety.backupFailed', { reason: item.error || t('dataSafety.unknownReason') }) }}
              </small>
            </span>
            <button
              v-if="backupSucceeded(item)"
              class="fb-btn-ghost ds__btn"
              type="button"
              @click="downloadBackup(item.name)"
            >{{ t('dataSafety.download') }}</button>
          </li>
        </ul>
      </template>
      <p class="ds__hint">{{ t('dataSafety.backupHint') }}</p>
    </div>
  </section>
</template>

<style scoped>
.ds { padding-bottom: 20px; }
.ds__hero { padding: calc(20px + env(safe-area-inset-top, 0px)) 20px 20px; border-radius: 0 0 24px 24px; }
.ds__title { display: block; font-size: 16px; font-weight: 700; }
.ds__notice { margin: 10px 0 0; padding: 8px 12px; border-radius: var(--fb-radius-input); font-size: 12px; }
.ds__notice--ok { background: var(--fb-green-soft); color: var(--fb-green-ink); }
.ds__notice--err { background: var(--fb-danger-soft); color: var(--fb-danger-ink); }
.ds__block { margin-top: 12px; padding: 14px 16px; border: 1px solid var(--fb-danger); }
.ds__block h2 { margin: 0 0 8px; font-size: 14px; color: var(--fb-danger); }
.ds__block p { margin: 0 0 6px; font-size: 12px; }
.ds__card { margin-top: 12px; padding: 14px 16px; }
.ds__card h2 { margin: 0 0 8px; font-size: 14px; }
.ds__card-head { display: flex; align-items: center; justify-content: space-between; }
.ds__desc, .ds__hint { margin: 0 0 10px; font-size: 11px; color: var(--fb-sub); line-height: 1.7; }
.ds__buttons { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.ds__btn { padding: 6px 12px; font-size: 12px; }
.ds__state { margin: 10px 0; font-size: 12px; color: var(--fb-sub); }
.ds__err { margin: 10px 0; font-size: 12px; color: var(--fb-danger); }
.ds__backups { list-style: none; margin: 12px 0 0; padding: 0; }
.ds__backups li { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--fb-line); }
.ds__backups li:last-child { border-bottom: none; }
.ds__status { width: 20px; font-weight: 700; }
.ds__status--ok { color: var(--fb-green); }
.ds__status--err { color: var(--fb-danger); }
.ds__backup-name { flex: 1; min-width: 0; font-size: 12px; overflow-wrap: anywhere; }
.ds__backup-name small { display: block; color: var(--fb-sub); font-size: 11px; }
</style>
