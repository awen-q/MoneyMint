<script setup lang="ts">
/**
 * P-19 导入向导（M2-f 批 4；0.6.0 S5 升级：支持导入到当前账本 + 批次撤销）
 *
 * - 两种目标：current（导入到当前账本，同名账户复用）/ new（新建独立账本）；
 * - 两种输入：粘贴文本 / 上传 .beancount 文件（读为文本后走同一预检）；
 * - 预检只读不写库：valid=false 时整体拒绝——语法错误列全部错误行号，
 *   与目标账本的冲突（账户/币种/借贷不平/pad-balance 不支持）逐项列出；
 * - target=current 支持 pad/balance 结构化预览（累计/差额），但执行整体拒绝；
 * - 执行在服务端单一大事务内完成，失败不留半批数据；
 *   成功后展示批次标识，可一键撤销（仅回滚本批新建实体与本批交易）。
 *
 * i18n 阶段 2 子批 3（数据域）：用户可见文案走字典。**待收敛**：以下文案
 * 原本由 `core/m2` 输出中文，本视图内做了等价映射（core 未改动）：
 * `importSummaryRows` 的五行标签、`formatImportErrors` 的行号文案、
 * `formatImportConflicts` 的冲突标签与拼接格式、`mapImportError` 的错误文案。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'

import { importApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { ImportPreviewResult, ImportResult, ImportUndoResult, ImportWarning } from '@/api/types'
import type { ImportSummaryRow } from '@/core/m2'
import { t } from '@/i18n'
import type { MessageKey } from '@/i18n/zh-CN'
import { markDirty } from '@/stores/dataFreshness'

const router = useRouter()

const text = ref('')
const filename = ref('')
const target = ref<'current' | 'new'>('current')
const preview = ref<ImportPreviewResult | null>(null)
const result = ref<ImportResult | null>(null)
const undoResult = ref<ImportUndoResult | null>(null)
const undoing = ref(false)
const busy = ref(false)
const actionError = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

const hasText = computed(() => text.value.trim() !== '')

/** 预检摘要行（core/m2.importSummaryRows 的视图内等价映射，待收敛）。 */
const summaryRows = computed<ImportSummaryRow[]>(() => {
  if (preview.value === null) {
    return []
  }
  return [
    { label: t('import.summaryNewAccounts'), value: preview.value.new_accounts },
    { label: t('import.summaryReuseAccounts'), value: preview.value.reuse_accounts },
    { label: t('import.summaryNewTransactions'), value: preview.value.new_transactions },
    { label: t('import.summarySkipTransactions'), value: preview.value.skip_transactions },
    { label: t('import.summaryNewCommodities'), value: preview.value.new_commodities },
  ]
})

/** 解析错误逐行文案（core/m2.formatImportErrors 的视图内等价映射，待收敛）。 */
const errorLines = computed<string[]>(() => {
  if (preview.value === null || preview.value.errors === undefined) {
    return []
  }
  return preview.value.errors.map((e) => t('import.errorLine', { line: String(e.line), msg: e.msg }))
})

/** 冲突类型短标签（core/m2.importConflictTypeLabel 的视图内等价映射，待收敛）。 */
function conflictTypeLabel(type: string): string {
  const keys: Record<string, MessageKey> = {
    account_conflict: 'import.conflict.account_conflict',
    commodity_conflict: 'import.conflict.commodity_conflict',
    undeclared_account: 'import.conflict.undeclared_account',
    unbalanced: 'import.conflict.unbalanced',
    pad_balance_unsupported: 'import.conflict.pad_balance_unsupported',
  }
  const key = keys[type]
  return key === undefined ? t('import.conflict.generic') : t(key)
}

/** 冲突逐行文案（core/m2.formatImportConflicts 的视图内等价映射，待收敛）。 */
const conflictLines = computed<string[]>(() => {
  if (preview.value === null || preview.value.conflicts.length === 0) {
    return []
  }
  return preview.value.conflicts.map((c) => {
    const line = c.line > 0 ? t('import.lineRef', { line: String(c.line) }) : ''
    const name = c.name !== '' ? ` ${c.name}` : ''
    const raw = `${line}${name}`
    const where = raw !== '' ? t('import.conflictWhere', { where: raw }) : ''
    return t('import.conflictEntry', { label: conflictTypeLabel(c.type), where, reason: c.reason })
  })
})

// 非阻断性警告（如负债正余额疑似符号填反）：仅提示，不进冲突清单、不影响导入。
const warnings = computed<ImportWarning[]>(() =>
  preview.value === null || preview.value.warnings === undefined ? [] : preview.value.warnings,
)

/** 新建账本的确认句（含来源 title 时追加括号说明，与原模板逐字节一致）。 */
const newLedgerLine = computed<string>(() => {
  if (preview.value === null) {
    return ''
  }
  if (preview.value.title !== '') {
    return t('import.confirmNewLedgerWithTitle', { name: preview.value.ledger_name, title: preview.value.title })
  }
  return t('import.confirmNewLedger', { name: preview.value.ledger_name })
})

/** current 模式结果句（跳过重复计数 > 0 时追加一段，与原模板逐字节一致）。 */
const resultCurrentLine = computed<string>(() => {
  if (result.value === null) {
    return ''
  }
  const params = {
    accounts: String(result.value.new_accounts),
    reused: String(result.value.reused_accounts),
    txns: String(result.value.created_transactions),
    skipped: String(result.value.skipped_transactions),
  }
  return result.value.skipped_transactions > 0
    ? t('import.resultCurrentSkipped', params)
    : t('import.resultCurrent', params)
})

/** 导入端点错误文案（core/m2.mapImportError 的视图内等价映射，待收敛）。 */
function importErrorText(status: number, message: string): string {
  if (status === 401) return t('import.errLogin')
  if (status === 400) return message !== '' ? message : t('import.errInvalid')
  if (status >= 500) return t('import.errServer')
  return message !== '' ? message : t('import.errGeneric')
}

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files !== null && input.files.length > 0 ? input.files[0] : null
  if (file === null) {
    return
  }
  filename.value = file.name
  // Blob.text() Safari 14 起可用，不在 §14.7 禁用清单内。
  void file
    .text()
    .then((content) => {
      text.value = content
      actionError.value = ''
    })
    .catch(() => {
      actionError.value = t('import.readFileFailed')
    })
}

function clearInput(): void {
  text.value = ''
  filename.value = ''
  preview.value = null
  result.value = null
  undoResult.value = null
  actionError.value = ''
  if (fileInput.value !== null) {
    fileInput.value.value = ''
  }
}

async function runPreview(): Promise<void> {
  if (!hasText.value || busy.value) {
    return
  }
  busy.value = true
  actionError.value = ''
  result.value = null
  undoResult.value = null
  try {
    preview.value = await importApi.preview(text.value, target.value)
  } catch (err) {
    actionError.value =
      err instanceof ApiError ? importErrorText(err.status, err.message) : importErrorText(0, '')
  } finally {
    busy.value = false
  }
}

async function runImport(): Promise<void> {
  if (!hasText.value || busy.value) {
    return
  }
  busy.value = true
  actionError.value = ''
  try {
    result.value = await importApi.execute(text.value, target.value)
    preview.value = null
    // target=current 会写账户+交易；target=new 只建新账本，置脏也只会多一次无害刷新。
    markDirty('local-write')
  } catch (err) {
    actionError.value =
      err instanceof ApiError ? importErrorText(err.status, err.message) : importErrorText(0, '')
  } finally {
    busy.value = false
  }
}

async function runUndo(): Promise<void> {
  if (result.value === null || undoing.value || result.value.import_batch_id === '') {
    return
  }
  undoing.value = true
  actionError.value = ''
  try {
    undoResult.value = await importApi.undo(result.value.import_batch_id)
    markDirty('local-write')
  } catch (err) {
    actionError.value =
      err instanceof ApiError ? importErrorText(err.status, err.message) : importErrorText(0, '')
  } finally {
    undoing.value = false
  }
}

function gotoLedgers(): void {
  void router.push({ name: 'ledgers' })
}
</script>

<template>
  <section class="im">
    <header class="im__hero fb-hero">
      <span class="im__title">{{ t('import.title') }}</span>
      <span class="im__sub">{{
        target === 'current' ? t('import.heroCurrent') : t('import.heroNew')
      }}</span>
    </header>

    <p v-if="actionError" class="im__notice" role="alert">{{ actionError }}</p>

    <!-- 目标切换 -->
    <div class="fb-card im__card">
      <h2>{{ t('import.step1Title') }}</h2>
      <div class="im__targets">
        <button
          type="button"
          class="im__target"
          :class="{ 'im__target--on': target === 'current' }"
          @click="target = 'current'"
        >
          {{ t('import.targetCurrent') }}
        </button>
        <button
          type="button"
          class="im__target"
          :class="{ 'im__target--on': target === 'new' }"
          @click="target = 'new'"
        >
          {{ t('import.targetNew') }}
        </button>
      </div>
      <p class="im__desc">
        {{ target === 'current' ? t('import.targetCurrentDesc') : t('import.targetNewDesc') }}
      </p>
    </div>

    <!-- 输入 -->
    <div class="fb-card im__card">
      <h2>{{ t('import.step2Title') }}</h2>
      <p class="im__desc">{{ t('import.inputDesc') }}</p>
      <input ref="fileInput" class="im__file" type="file" accept=".beancount,.txt,text/plain" @change="onFileChange" />
      <textarea
        v-model="text"
        class="im__textarea"
        rows="8"
        spellcheck="false"
        :placeholder="t('import.placeholder')"
      ></textarea>
      <p v-if="filename !== ''" class="im__desc">{{ t('import.fileLoaded', { name: filename }) }}</p>
      <div class="im__buttons">
        <button class="fb-btn-primary im__btn" type="button" :disabled="!hasText || busy" @click="runPreview">
          {{ busy ? t('import.parsing') : t('import.parsePreview') }}
        </button>
        <button class="fb-btn-ghost im__btn" type="button" :disabled="busy" @click="clearInput">{{ t('import.clear') }}</button>
      </div>
    </div>

    <!-- 预检结果 -->
    <template v-if="preview !== null">
      <div v-if="!preview.valid" class="fb-card im__card im__reject" role="alert">
        <h2>{{ t('import.rejectTitle') }}</h2>
        <p v-if="preview.errors !== undefined && preview.errors.length > 0" class="im__desc">
          {{ preview.error || t('import.rejectFallback') }}
        </p>
        <ul v-if="errorLines.length > 0" class="im__errors">
          <li v-for="line in errorLines" :key="line">{{ line }}</li>
        </ul>
        <p v-if="conflictLines.length > 0" class="im__desc">
          {{ t('import.conflictCount', { n: String(conflictLines.length) }) }}
        </p>
        <ul v-if="conflictLines.length > 0" class="im__errors">
          <li v-for="line in conflictLines" :key="line">{{ line }}</li>
        </ul>
        <div v-if="warnings.length > 0" class="im__warnbox">
          <p class="im__warnbox-title">{{ t('import.warningsTitle', { n: String(warnings.length) }) }}</p>
          <ul class="im__warnlist">
            <li v-for="w in warnings" :key="`r-${w.line}-${w.account}-${w.message}`">{{ w.message }}</li>
          </ul>
        </div>
        <div v-if="preview.pad_balance.length > 0" class="im__padbox">
          <p class="im__desc">{{ t('import.padBalanceReprocess', { n: String(preview.pad_balance.length) }) }}</p>
          <table class="im__table">
            <tbody>
              <tr v-for="pb in preview.pad_balance" :key="`r-${pb.line}-${pb.account}-${pb.type}`">
                <td>{{ t('import.padRowLine', { line: String(pb.line) }) }}</td>
                <td>{{ pb.type === 'pad' ? t('import.padTag') : t('import.balanceTag') }}</td>
                <td>{{ pb.account }}</td>
                <td>{{ t('import.padAmounts', { target: pb.target_amount, cumulative: pb.cumulative, diff: pb.diff }) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="target === 'current'" class="im__must" role="alert">
            {{ t('import.padNotSupportedCurrent') }}
          </p>
        </div>
        <p class="im__desc">{{ t('import.rejectFooter') }}</p>
      </div>

      <div v-else class="fb-card im__card">
        <h2>{{ t('import.step3Title') }}</h2>
        <table class="im__table">
          <tbody>
            <tr v-for="row in summaryRows" :key="row.label">
              <td>{{ row.label }}</td>
              <td>{{ row.value }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="target === 'new'" class="im__desc">
          {{ newLedgerLine }}
        </p>
        <p v-else class="im__desc">
          {{ t('import.confirmCurrent') }}
        </p>
        <p v-if="target === 'new' && preview.duplicate" class="im__must" role="alert">
          {{ t('import.duplicateWarning') }}
        </p>
        <div v-if="warnings.length > 0" class="im__warnbox">
          <p class="im__warnbox-title">{{ t('import.warningsTitle', { n: String(warnings.length) }) }}</p>
          <ul class="im__warnlist">
            <li v-for="w in warnings" :key="`c-${w.line}-${w.account}-${w.message}`">{{ w.message }}</li>
          </ul>
        </div>
        <div v-if="preview.pad_balance.length > 0" class="im__padbox">
          <p class="im__desc">{{ t('import.padBalanceList', { n: String(preview.pad_balance.length) }) }}</p>
          <table class="im__table">
            <tbody>
              <tr v-for="pb in preview.pad_balance" :key="`${pb.line}-${pb.account}-${pb.type}`">
                <td>{{ t('import.padRowLine', { line: String(pb.line) }) }}</td>
                <td>{{ pb.type === 'pad' ? t('import.padTag') : t('import.balanceTag') }}</td>
                <td>{{ pb.account }}</td>
                <td>{{ t('import.padAmounts', { target: pb.target_amount, cumulative: pb.cumulative, diff: pb.diff }) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="target === 'current'" class="im__must" role="alert">
            {{ t('import.padNotSupportedCurrent') }}
          </p>
        </div>
        <div class="im__buttons">
          <button class="fb-btn-primary im__btn" type="button" :disabled="busy" @click="runImport">
            {{ busy ? t('import.importing') : t('import.execute') }}
          </button>
          <button class="fb-btn-ghost im__btn" type="button" :disabled="busy" @click="clearInput">{{ t('import.cancel') }}</button>
        </div>
      </div>
    </template>

    <!-- 导入结果 -->
    <div v-if="result !== null" class="fb-card im__card">
      <h2>{{ t('import.doneTitle') }}</h2>
      <p v-if="result.mode === 'new'" class="im__desc">
        {{ t('import.resultNew', {
          name: result.ledger_name,
          accounts: String(result.new_accounts),
          txns: String(result.created_transactions),
        }) }}
      </p>
      <p v-else class="im__desc">
        {{ resultCurrentLine }}
      </p>
      <template v-if="undoResult === null">
        <p class="im__desc">{{ t('import.batchNote', { id: result.import_batch_id }) }}</p>
        <div class="im__buttons">
          <button
            v-if="result.mode === 'new'"
            class="fb-btn-primary im__btn"
            type="button"
            @click="gotoLedgers"
          >{{ t('import.gotoLedgers') }}</button>
          <button
            class="fb-btn-ghost im__btn"
            type="button"
            :disabled="undoing"
            @click="runUndo"
          >{{ undoing ? t('import.undoing') : t('import.undo') }}</button>
          <button class="fb-btn-ghost im__btn" type="button" @click="clearInput">{{ t('import.importAnother') }}</button>
        </div>
      </template>
      <template v-else>
        <p class="im__desc" role="status">
          {{ t('import.undoResult', {
            txns: String(undoResult.removed_transactions),
            postings: String(undoResult.removed_postings),
            accounts: String(undoResult.removed_accounts),
            commodities: String(undoResult.removed_commodities),
          }) }}
        </p>
        <div class="im__buttons">
          <button class="fb-btn-ghost im__btn" type="button" @click="clearInput">{{ t('import.close') }}</button>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.im { padding-bottom: 20px; }
.im__hero { padding: calc(20px + env(safe-area-inset-top, 0px)) 20px 20px; border-radius: 0 0 24px 24px; }
.im__title { display: block; font-size: 16px; font-weight: 700; }
.im__sub { display: block; margin-top: 4px; font-size: 12px; color: var(--fb-on-hero-muted); }
.im__card { margin-top: 12px; padding: 14px 16px; }
.im__card h2 { margin: 0 0 8px; font-size: 14px; }
.im__reject { border: 1px solid var(--fb-danger); }
.im__reject h2 { color: var(--fb-danger); }
.im__desc { margin: 0 0 8px; font-size: 11px; color: var(--fb-sub); line-height: 1.7; }
.im__notice { margin: 10px 0 0; padding: 8px 12px; border-radius: var(--fb-radius-input); font-size: 12px; background: var(--fb-danger-soft); color: var(--fb-danger-ink); }
.im__file { display: block; margin: 10px 0; font-size: 12px; }
.im__textarea { width: 100%; box-sizing: border-box; padding: 10px; border: 1.5px solid var(--fb-line); border-radius: var(--fb-radius-input); font-size: 12px; font-family: monospace; line-height: 1.6; resize: vertical; background: var(--fb-card); color: var(--fb-ink); }
.im__buttons { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.im__btn { padding: 6px 12px; font-size: 12px; }
/* pad / balance 表格的目标 / 累计 / 差额是定点金额，数字列等宽对齐。 */
.im__table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 10px; font-variant-numeric: var(--fb-font-numeric); }
.im__table td { padding: 6px 8px; border-bottom: 1px solid var(--fb-line); }
.im__table td:first-child { color: var(--fb-sub); width: 40%; }
.im__errors { margin: 0 0 10px; padding-left: 18px; font-size: 11px; line-height: 1.8; color: var(--fb-danger); }
.im__must { margin: 10px 0 0; padding: 8px 12px; border-radius: var(--fb-radius-input); font-size: 12px; background: var(--fb-warn-soft); color: var(--fb-warn-ink); font-weight: 600; }
.im__targets { display: flex; gap: 8px; margin-bottom: 8px; }
/* 非阻断性警告（黄色）：区别于红色冲突/拒绝，仅提示用户核对源文件。 */
.im__warnbox { margin: 8px 0; padding: 8px 12px; border-radius: var(--fb-radius-input); background: var(--fb-warn-soft); color: var(--fb-warn-ink); }
.im__warnbox-title { margin: 0 0 4px; font-size: 12px; font-weight: 600; }
.im__warnlist { margin: 0; padding-left: 18px; font-size: 11px; line-height: 1.8; }
.im__target { flex: 1; padding: 8px 10px; font-size: 12px; border: 1.5px solid var(--fb-line); border-radius: var(--fb-radius-input); background: transparent; color: var(--fb-ink); }
.im__target--on { border-color: var(--fb-primary); font-weight: 600; background: var(--fb-primary-soft); }
.im__padbox { margin: 8px 0; }
</style>
