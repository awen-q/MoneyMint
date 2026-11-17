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
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'

import { importApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { ImportPreviewResult, ImportResult, ImportUndoResult } from '@/api/types'
import {
  formatImportConflicts,
  formatImportErrors,
  importSummaryRows,
  mapImportError,
  type ImportSummaryRow,
} from '@/core/m2'

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
const summaryRows = computed<ImportSummaryRow[]>(() =>
  preview.value === null ? [] : importSummaryRows(preview.value),
)
const errorLines = computed<string[]>(() =>
  preview.value !== null && preview.value.errors !== undefined
    ? formatImportErrors(preview.value.errors)
    : [],
)
const conflictLines = computed<string[]>(() =>
  preview.value !== null && preview.value.conflicts.length > 0
    ? formatImportConflicts(preview.value.conflicts)
    : [],
)

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
      actionError.value = '读取文件失败，请重试或直接粘贴文本'
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
      err instanceof ApiError ? mapImportError(err.status, err.message) : mapImportError(0, '')
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
  } catch (err) {
    actionError.value =
      err instanceof ApiError ? mapImportError(err.status, err.message) : mapImportError(0, '')
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
  } catch (err) {
    actionError.value =
      err instanceof ApiError ? mapImportError(err.status, err.message) : mapImportError(0, '')
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
      <span class="im__title">导入 Beancount</span>
      <span class="im__sub">{{
        target === 'current'
          ? '解析后写入当前账本：同名账户自动复用，重复内容自动跳过'
          : '解析为独立新账本，不覆盖既有数据'
      }}</span>
    </header>

    <p v-if="actionError" class="im__notice" role="alert">{{ actionError }}</p>

    <!-- 目标切换 -->
    <div class="fb-card im__card">
      <h2>① 选择导入目标</h2>
      <div class="im__targets">
        <button
          type="button"
          class="im__target"
          :class="{ 'im__target--on': target === 'current' }"
          @click="target = 'current'"
        >
          导入到当前账本
        </button>
        <button
          type="button"
          class="im__target"
          :class="{ 'im__target--on': target === 'new' }"
          @click="target = 'new'"
        >
          新建独立账本
        </button>
      </div>
      <p class="im__desc">
        {{
          target === 'current'
            ? '写入当前所选账本：同名账户复用（类型/币种限制须一致），重复交易按内容自动跳过；不支持 pad/balance。'
            : '新建独立账本：同名账本自动加序号；pad 自动展开为补平交易，balance 转导入后自检。'
        }}
      </p>
    </div>

    <!-- 输入 -->
    <div class="fb-card im__card">
      <h2>② 提供文件内容</h2>
      <p class="im__desc">支持粘贴文本或上传 .beancount 文件；仅支持本系统导出用到的语法子集。</p>
      <input ref="fileInput" class="im__file" type="file" accept=".beancount,.txt,text/plain" @change="onFileChange" />
      <textarea
        v-model="text"
        class="im__textarea"
        rows="8"
        spellcheck="false"
        placeholder='option "title" "家庭账本"&#10;2026-11-01 open Assets:Cash:CNY&#10;2026-11-02 * "早餐"&#10;  Expenses:食品:CNY -12.50 CNY&#10;  Assets:Cash:CNY'
      ></textarea>
      <p v-if="filename !== ''" class="im__desc">已读入文件：{{ filename }}</p>
      <div class="im__buttons">
        <button class="fb-btn-primary im__btn" type="button" :disabled="!hasText || busy" @click="runPreview">
          {{ busy ? '解析中…' : '解析预览' }}
        </button>
        <button class="fb-btn-ghost im__btn" type="button" :disabled="busy" @click="clearInput">清空</button>
      </div>
    </div>

    <!-- 预检结果 -->
    <template v-if="preview !== null">
      <div v-if="!preview.valid" class="fb-card im__card im__reject" role="alert">
        <h2>预检未通过，已整体拒绝</h2>
        <p v-if="preview.errors !== undefined && preview.errors.length > 0" class="im__desc">
          {{ preview.error || '文件含不支持的语法，已整体拒绝' }}
        </p>
        <ul v-if="errorLines.length > 0" class="im__errors">
          <li v-for="line in errorLines" :key="line">{{ line }}</li>
        </ul>
        <p v-if="conflictLines.length > 0" class="im__desc">
          与目标账本存在 {{ conflictLines.length }} 处冲突：
        </p>
        <ul v-if="conflictLines.length > 0" class="im__errors">
          <li v-for="line in conflictLines" :key="line">{{ line }}</li>
        </ul>
        <div v-if="preview.pad_balance.length > 0" class="im__padbox">
          <p class="im__desc">文件含 pad / balance 指令（{{ preview.pad_balance.length }} 条），按当前账本重算：</p>
          <table class="im__table">
            <tbody>
              <tr v-for="pb in preview.pad_balance" :key="`r-${pb.line}-${pb.account}-${pb.type}`">
                <td>第 {{ pb.line }} 行</td>
                <td>{{ pb.type === 'pad' ? '补平(pad)' : '断言(balance)' }}</td>
                <td>{{ pb.account }}</td>
                <td>目标 {{ pb.target_amount }} · 累计 {{ pb.cumulative }} · 差额 {{ pb.diff }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="target === 'current'" class="im__must" role="alert">
            当前账本模式不支持 pad/balance：请展开为普通交易后重导，或改用新建账本模式。
          </p>
        </div>
        <p class="im__desc">修改文件或切换导入目标后重新解析即可；不会产生任何账本数据。</p>
      </div>

      <div v-else class="fb-card im__card">
        <h2>③ 确认导入内容</h2>
        <table class="im__table">
          <tbody>
            <tr v-for="row in summaryRows" :key="row.label">
              <td>{{ row.label }}</td>
              <td>{{ row.value }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="target === 'new'" class="im__desc">
          将创建新账本「{{ preview.ledger_name }}」<span v-if="preview.title !== ''">（来源 title：{{ preview.title }}）</span>。
        </p>
        <p v-else class="im__desc">
          将写入当前账本；同名账户复用、重复交易自动跳过，不覆盖既有数据。
        </p>
        <p v-if="target === 'new' && preview.duplicate" class="im__must" role="alert">
          已存在同名账本且交易数相同，疑似重复导入；确认无误可继续（不会覆盖原账本）。
        </p>
        <div v-if="preview.pad_balance.length > 0" class="im__padbox">
          <p class="im__desc">文件含 pad / balance 指令（{{ preview.pad_balance.length }} 条）：</p>
          <table class="im__table">
            <tbody>
              <tr v-for="pb in preview.pad_balance" :key="`${pb.line}-${pb.account}-${pb.type}`">
                <td>第 {{ pb.line }} 行</td>
                <td>{{ pb.type === 'pad' ? '补平(pad)' : '断言(balance)' }}</td>
                <td>{{ pb.account }}</td>
                <td>目标 {{ pb.target_amount }} · 累计 {{ pb.cumulative }} · 差额 {{ pb.diff }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="target === 'current'" class="im__must" role="alert">
            当前账本模式不支持 pad/balance：请展开为普通交易后重导，或改用新建账本模式。
          </p>
        </div>
        <div class="im__buttons">
          <button class="fb-btn-primary im__btn" type="button" :disabled="busy" @click="runImport">
            {{ busy ? '导入中…' : '执行导入' }}
          </button>
          <button class="fb-btn-ghost im__btn" type="button" :disabled="busy" @click="clearInput">取消</button>
        </div>
      </div>
    </template>

    <!-- 导入结果 -->
    <div v-if="result !== null" class="fb-card im__card">
      <h2>导入完成</h2>
      <p v-if="result.mode === 'new'" class="im__desc">
        新账本「{{ result.ledger_name }}」：新建账户 {{ result.new_accounts }} · 交易 {{ result.created_transactions }}。
      </p>
      <p v-else class="im__desc">
        已写入当前账本：新建账户 {{ result.new_accounts }} · 复用账户 {{ result.reused_accounts }} ·
        新建交易 {{ result.created_transactions }}<span v-if="result.skipped_transactions > 0"> · 跳过重复 {{ result.skipped_transactions }}</span>。
      </p>
      <template v-if="undoResult === null">
        <p class="im__desc">批次 {{ result.import_batch_id }}：导入有误可撤销（仅回滚本批新建内容）。</p>
        <div class="im__buttons">
          <button
            v-if="result.mode === 'new'"
            class="fb-btn-primary im__btn"
            type="button"
            @click="gotoLedgers"
          >去账本页查看</button>
          <button
            class="fb-btn-ghost im__btn"
            type="button"
            :disabled="undoing"
            @click="runUndo"
          >{{ undoing ? '撤销中…' : '撤销本次导入' }}</button>
          <button class="fb-btn-ghost im__btn" type="button" @click="clearInput">再导入一份</button>
        </div>
      </template>
      <template v-else>
        <p class="im__desc" role="status">
          已撤销：交易 {{ undoResult.removed_transactions }} · 分录 {{ undoResult.removed_postings }} ·
          账户 {{ undoResult.removed_accounts }} · 币种 {{ undoResult.removed_commodities }}。
        </p>
        <div class="im__buttons">
          <button class="fb-btn-ghost im__btn" type="button" @click="clearInput">关闭</button>
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
.im__textarea { width: 100%; box-sizing: border-box; padding: 10px; border: 1.5px solid var(--fb-line); border-radius: var(--fb-radius-input); font-size: 12px; font-family: monospace; line-height: 1.6; resize: vertical; background: var(--fb-surface, transparent); color: var(--fb-text, inherit); }
.im__buttons { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.im__btn { padding: 6px 12px; font-size: 12px; }
/* pad / balance 表格的目标 / 累计 / 差额是定点金额，数字列等宽对齐。 */
.im__table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 10px; font-variant-numeric: var(--fb-font-numeric); }
.im__table td { padding: 6px 8px; border-bottom: 1px solid var(--fb-line); }
.im__table td:first-child { color: var(--fb-sub); width: 40%; }
.im__errors { margin: 0 0 10px; padding-left: 18px; font-size: 11px; line-height: 1.8; color: var(--fb-danger); }
.im__must { margin: 10px 0 0; padding: 8px 12px; border-radius: var(--fb-radius-input); font-size: 12px; background: var(--fb-warn-soft); color: var(--fb-warn-ink); font-weight: 600; }
.im__targets { display: flex; gap: 8px; margin-bottom: 8px; }
.im__target { flex: 1; padding: 8px 10px; font-size: 12px; border: 1.5px solid var(--fb-line); border-radius: var(--fb-radius-input); background: transparent; color: var(--fb-text, inherit); }
.im__target--on { border-color: var(--fb-primary); font-weight: 600; background: var(--fb-primary-soft); }
.im__padbox { margin: 8px 0; }
</style>
