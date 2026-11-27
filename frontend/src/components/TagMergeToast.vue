<script setup lang="ts">
/**
 * 标签合并非阻断提示（P1）。
 *
 * 只承载 role=status / aria-live=polite 的一次性轻量消息，4 秒自动消失；
 * 不用 <dialog> / showModal / role=alert，也没有任何需要用户点击的按钮，
 * 因此绝不打断记账。样式刻意区别于内联编辑器的红色 role=alert 错误面板。
 */
import { onMounted, onUnmounted, ref } from 'vue'

import { subscribeMergeNotice, type MergeNotice } from '@/core/tagEvents/notice'

const DISMISS_MS = 4_000

const current = ref<MergeNotice | null>(null)
let unsubscribe: (() => void) | null = null
let timer: ReturnType<typeof setTimeout> | null = null

function show(notice: MergeNotice): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  current.value = notice
  timer = setTimeout(() => {
    current.value = null
    timer = null
  }, DISMISS_MS)
}

onMounted(() => {
  unsubscribe = subscribeMergeNotice(show)
})

onUnmounted(() => {
  if (unsubscribe !== null) {
    unsubscribe()
    unsubscribe = null
  }
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
})
</script>

<template>
  <div
    v-if="current !== null"
    class="tag-merge-toast"
    role="status"
    aria-live="polite"
    data-testid="tag-merge-toast"
  >
    <strong class="tag-merge-toast__title">{{ current.title }}</strong>
    <span v-if="current.body !== ''" class="tag-merge-toast__body">{{ current.body }}</span>
  </div>
</template>

<style scoped>
.tag-merge-toast {
  position: fixed;
  right: 16px;
  bottom: calc(94px + env(safe-area-inset-bottom, 0px));
  z-index: 45;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-width: min(320px, calc(100vw - 32px));
  padding: 10px 14px;
  border: 1px solid var(--fb-blue-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-blue-soft);
  color: var(--fb-blue);
  font-size: 12px;
  line-height: 1.5;
}

.tag-merge-toast__title {
  font-size: 12px;
  font-weight: 600;
}

.tag-merge-toast__body {
  color: var(--fb-sub);
}

@media (min-width: 900px) {
  .tag-merge-toast {
    bottom: 24px;
  }
}
</style>
