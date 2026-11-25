<script setup lang="ts">
/**
 * P-20 恢复向导（M2-c，批 4）
 *
 * 三步流：选文件 → 只读预检 → 确认词执行：
 * - 预检不改动任何数据，摘要卡展示「备份 vs 当前」覆盖量对比 + 副作用警告；
 * - valid=false 时整体拒绝并给出原因（损坏 / 非本系统备份 / 未来版本 / 超大）；
 * - 「执行还原」必须输入 RESTORE 解锁（服务端同样硬校验，双保险）；
 * - 成功后展示替换行数、pre-restore 快照名与重写后的库世代，
 *   并明确提示「请用备份中的账号重新登录」——本机登录态随用户表被替换而失效。
 *
 * 全库级操作：路由带 adminOnly 守卫，视图内再断言一次 is_admin（纵深防御）。
 *
 * i18n 阶段 2 子批 5a：对比行 / 拒绝原因 / 错误文案改为直接消费 `core/m2`
 * （`restoreCompareRows` / `restoreRejectionText` / `mapRestoreError`），视图内不再保留等价映射。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'

import { restoreApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { RestorePreviewResult, RestoreResult } from '@/api/types'
import {
  mapRestoreError,
  RESTORE_CONFIRM_WORD,
  restoreCompareRows,
  restoreRejectionText,
} from '@/core/m2'
import { t } from '@/i18n'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()
const router = useRouter()

type Step = 'pick' | 'preview' | 'done'

const step = ref<Step>('pick')
const file = ref<File | null>(null)
const preview = ref<RestorePreviewResult | null>(null)
const result = ref<RestoreResult | null>(null)
const confirmText = ref('')
const busy = ref(false)
const actionError = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

const isAdmin = computed(() => session.user !== null && session.user.is_admin === true)
const confirmUnlocked = computed(() => confirmText.value === RESTORE_CONFIRM_WORD)

/** 「备份 vs 当前」覆盖量对比行（直接消费 core/m2）。 */
const compareRows = computed(() => {
  if (preview.value === null) {
    return []
  }
  return restoreCompareRows(preview.value.backup, preview.value.current)
})

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  file.value = input.files !== null && input.files.length > 0 ? input.files[0] : null
  actionError.value = ''
}

function reset(): void {
  step.value = 'pick'
  file.value = null
  preview.value = null
  result.value = null
  confirmText.value = ''
  actionError.value = ''
  if (fileInput.value !== null) {
    fileInput.value.value = ''
  }
}

async function runPreview(): Promise<void> {
  if (file.value === null || busy.value) {
    return
  }
  busy.value = true
  actionError.value = ''
  try {
    preview.value = await restoreApi.preview(file.value)
    step.value = 'preview'
  } catch (err) {
    actionError.value =
      err instanceof ApiError ? mapRestoreError(err.status, err.message) : mapRestoreError(0, '')
  } finally {
    busy.value = false
  }
}

async function runRestore(): Promise<void> {
  if (file.value === null || !confirmUnlocked.value || busy.value) {
    return
  }
  busy.value = true
  actionError.value = ''
  try {
    result.value = await restoreApi.execute(file.value, confirmText.value)
    step.value = 'done'
  } catch (err) {
    actionError.value =
      err instanceof ApiError ? mapRestoreError(err.status, err.message) : mapRestoreError(0, '')
  } finally {
    busy.value = false
  }
}

/** 还原成功后本机登录态已随用户表被替换：仅本地登出，不再调 logout 端点。 */
function backToLogin(): void {
  session.markGuest()
  void router.replace({ name: 'login' })
}
</script>

<template>
  <section class="rs">
    <header class="rs__hero fb-hero">
      <span class="rs__title">{{ t('restore.title') }}</span>
      <span class="rs__sub">{{ t('restore.subtitle') }}</span>
    </header>

    <div v-if="!isAdmin" class="fb-card rs__card" role="alert">
      <h2>{{ t('restore.adminOnlyTitle') }}</h2>
      <p>{{ t('restore.adminOnlyBody') }}</p>
    </div>

    <template v-else>
      <p v-if="actionError" class="rs__notice" role="alert">{{ actionError }}</p>

      <!-- 第 1 步：选择备份文件 -->
      <div v-if="step === 'pick'" class="fb-card rs__card">
        <h2>{{ t('restore.step1Title') }}</h2>
        <p class="rs__desc">{{ t('restore.step1Desc') }}</p>
        <input
          ref="fileInput"
          class="rs__file"
          type="file"
          accept=".db,application/octet-stream"
          @change="onFileChange"
        />
        <div class="rs__buttons">
          <button class="fb-btn-primary rs__btn" type="button" :disabled="file === null || busy" @click="runPreview">
            {{ busy ? t('restore.previewing') : t('restore.startPreview') }}
          </button>
        </div>
      </div>

      <!-- 第 2 步：预检摘要 + 确认词解锁 -->
      <template v-else-if="step === 'preview' && preview !== null">
        <div v-if="!preview.valid" class="fb-card rs__card rs__reject" role="alert">
          <h2>{{ t('restore.rejectTitle') }}</h2>
          <p>{{ restoreRejectionText(preview) }}</p>
          <div class="rs__buttons">
            <button class="fb-btn-ghost rs__btn" type="button" @click="reset">{{ t('restore.pickAgain') }}</button>
          </div>
        </div>

        <div v-else class="fb-card rs__card">
          <h2>{{ t('restore.step2Title') }}</h2>
          <table class="rs__table">
            <thead>
              <tr><th>{{ t('restore.colContent') }}</th><th>{{ t('restore.colBackup') }}</th><th>{{ t('restore.colCurrent') }}</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in compareRows" :key="row.label">
                <td>{{ row.label }}</td>
                <td>{{ row.backup }}</td>
                <td>{{ row.current }}</td>
              </tr>
            </tbody>
          </table>
          <p class="rs__desc">{{ t('restore.schemaVersion', { schema: String(preview.schema_version), current: String(preview.current_version) }) }}</p>
          <ul class="rs__warnings">
            <li v-for="w in preview.warnings" :key="w">{{ w }}</li>
          </ul>
          <label class="rs__confirm">
            <span>{{ t('restore.confirmBefore') }}<strong>{{ RESTORE_CONFIRM_WORD }}</strong>{{ t('restore.confirmAfter') }}</span>
            <input v-model="confirmText" class="rs__input" type="text" autocomplete="off" :placeholder="RESTORE_CONFIRM_WORD" />
          </label>
          <div class="rs__buttons">
            <button class="fb-btn-primary rs__btn" type="button" :disabled="!confirmUnlocked || busy" @click="runRestore">
              {{ busy ? t('restore.restoring') : t('restore.execute') }}
            </button>
            <button class="fb-btn-ghost rs__btn" type="button" :disabled="busy" @click="reset">{{ t('restore.cancel') }}</button>
          </div>
        </div>
      </template>

      <!-- 第 3 步：结果 -->
      <div v-else-if="step === 'done' && result !== null" class="fb-card rs__card">
        <h2>{{ t('restore.doneTitle') }}</h2>
        <p class="rs__desc">
          {{ t('restore.replaced', {
            users: String(result.replaced.users),
            ledgers: String(result.replaced.ledgers),
            accounts: String(result.replaced.accounts),
            transactions: String(result.replaced.transactions),
          }) }}
        </p>
        <p v-if="result.snapshot" class="rs__desc">{{ t('restore.snapshot', { snapshot: result.snapshot }) }}</p>
        <p class="rs__desc">{{ t('restore.instanceUpdated', { id: result.new_instance_id }) }}</p>
        <p class="rs__must" role="alert">{{ result.warnings[0] || t('restore.reloginHint') }}</p>
        <div class="rs__buttons">
          <button class="fb-btn-primary rs__btn" type="button" @click="backToLogin">{{ t('restore.relogin') }}</button>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.rs { padding-bottom: 20px; }
.rs__hero { padding: calc(20px + env(safe-area-inset-top, 0px)) 20px 20px; border-radius: 0 0 24px 24px; }
.rs__title { display: block; font-size: 16px; font-weight: 700; }
.rs__sub { display: block; margin-top: 4px; font-size: 12px; color: var(--fb-on-hero-muted); }
.rs__card { margin-top: 12px; padding: 14px 16px; }
.rs__card h2 { margin: 0 0 8px; font-size: 14px; }
.rs__reject { border: 1px solid var(--fb-danger); }
.rs__reject h2 { color: var(--fb-danger); }
.rs__desc { margin: 0 0 8px; font-size: 11px; color: var(--fb-sub); line-height: 1.7; }
.rs__notice { margin: 10px 0 0; padding: 8px 12px; border-radius: var(--fb-radius-input); font-size: 12px; background: var(--fb-danger-soft); color: var(--fb-danger-ink); }
.rs__file { display: block; margin: 10px 0; font-size: 12px; }
.rs__buttons { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.rs__btn { padding: 6px 12px; font-size: 12px; }
.rs__table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 10px; }
.rs__table th, .rs__table td { padding: 6px 8px; border-bottom: 1px solid var(--fb-line); text-align: left; }
.rs__table th { color: var(--fb-sub); font-weight: 600; font-size: 11px; }
.rs__warnings { margin: 0 0 10px; padding-left: 18px; font-size: 11px; color: var(--fb-sub); line-height: 1.8; }
.rs__confirm { display: flex; align-items: center; gap: 8px; font-size: 12px; margin-top: 6px; flex-wrap: wrap; }
.rs__input { padding: 6px 8px; border: 1px solid var(--fb-line); border-radius: var(--fb-radius-input); font-size: 12px; width: 140px; }
.rs__must { margin: 10px 0 0; padding: 8px 12px; border-radius: var(--fb-radius-input); font-size: 12px; background: var(--fb-warn-soft); color: var(--fb-warn-ink); font-weight: 600; }
</style>
