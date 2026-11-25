<script setup lang="ts">
/**
 * 同步状态徽标（批 5，P-18 / sync_badge.dart 对应物）
 *
 * 有积压（待推 / 死信）或离线时显示；点击进同步页处理。
 * 平时隐藏，不占视觉空间。
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'

import { t } from '@/i18n'
import { useSyncStore } from '@/stores/sync'

const sync = useSyncStore()
const router = useRouter()

const label = computed(() => {
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
    :aria-label="t('shell.syncStatusLabel', { label })"
  >
    <span class="sb__dot" :class="sync.deadCount > 0 ? 'sb__dot--err' : 'sb__dot--warn'" />
    <span class="sb__text">{{ label }}</span>
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
</style>
