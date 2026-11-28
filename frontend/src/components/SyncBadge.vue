<script setup lang="ts">
/**
 * 同步状态徽标（P1：按「可处置状态」给文案）
 *
 * 全部正常 → 不显示；仅重试中 → 「N 笔重试中」；仅死信 → 「同步受阻 · N 笔需处理」；
 * 混合 → 两者并列；顶层错误 → 短原因 + pending chip 副标。
 * 绝不写「同步失败 N 笔」：数量必须配下一步动作。
 *
 * 兼容：未暴露 retryingCount 的旧 store 桩（如阶段 1 i18n 抽查）走旧文案分支。
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'

import { describeSyncError } from '@/core/sync/errorMessages'
import { t } from '@/i18n'
import { useSyncStore } from '@/stores/sync'

const sync = useSyncStore()
const router = useRouter()

/** 新 store 用 retryingCount 表示失败子集；旧桩缺失时退回 pendingCount。 */
const observable = computed(() => typeof sync.retryingCount === 'number')
const retrying = computed(() =>
  observable.value ? sync.retryingCount : sync.pendingCount,
)

const label = computed(() => {
  if (sync.topError !== undefined) {
    return t('shell.syncTopError', {
      reason: describeSyncError(sync.topError.code, sync.topError.message).reason,
    })
  }
  if (observable.value) {
    if (sync.deadCount > 0 && retrying.value > 0) {
      return t('shell.syncBlockedMixed', {
        n: String(sync.deadCount),
        m: String(retrying.value),
      })
    }
    if (sync.deadCount > 0) return t('shell.syncBlockedDead', { n: String(sync.deadCount) })
    if (retrying.value > 0) return t('shell.syncRetrying', { n: String(retrying.value) })
    return ''
  }
  // 旧口径（无可处置分类）：保留既有文案，避免壳层既有断言回归。
  if (sync.deadCount > 0) {
    return sync.pendingCount > 0
      ? t('shell.syncPendingFailed', {
          pending: String(sync.pendingCount),
          dead: String(sync.deadCount),
        })
      : t('shell.syncFailed', { dead: String(sync.deadCount) })
  }
  if (sync.pendingCount > 0) return t('shell.syncPending', { pending: String(sync.pendingCount) })
  if (sync.status === 'offline') return t('shell.offline')
  return ''
})

/** 顶层错误时给出 pending chip 副标：仍有可操作条目时提示下一步。 */
const subLabel = computed(() => {
  if (sync.topError === undefined) return ''
  if (retrying.value > 0) return t('shell.syncPending', { pending: String(retrying.value) })
  if (sync.deadCount > 0) return t('shell.syncBlockedDead', { n: String(sync.deadCount) })
  return ''
})

const ariaLabel = computed(() => {
  const base = t('shell.syncStatusLabel', { label: label.value })
  return subLabel.value === '' ? base : `${base} · ${subLabel.value}`
})

function open(): void {
  void router.push({ name: 'sync' })
}
</script>

<template>
  <button
    v-if="label !== ''"
    class="sb"
    type="button"
    @click="open"
    :aria-label="ariaLabel"
  >
    <span class="sb__dot" :class="sync.deadCount > 0 || sync.topError !== undefined ? 'sb__dot--err' : 'sb__dot--warn'" />
    <span class="sb__text">{{ label }}</span>
    <span v-if="subLabel !== ''" class="sb__sub">{{ subLabel }}</span>
  </button>
</template>

<style scoped>
.sb {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--fb-line);
  background: var(--fb-soft);
  font-size: 11px;
  cursor: pointer;
}
.sb__dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.sb__dot--warn { background: var(--fb-warn); }
.sb__dot--err { background: var(--fb-danger); }
.sb__text { color: var(--fb-sub); white-space: nowrap; }
.sb__sub { color: var(--fb-sub); font-size: 10px; opacity: 0.8; white-space: nowrap; }
</style>
