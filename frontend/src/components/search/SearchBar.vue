<script setup lang="ts">
/**
 * 搜索条（T34）：关键词输入 + 已选条件 chips + 「更多筛选」折叠。
 *
 * 两条交互口径（同时存在才不别扭）：
 * 1. **边打字边搜**，但**防抖**（默认 300ms）——否则每敲一个字就发一次请求，
 *    服务端分页 + keysort 游标会被频繁重置；
 * 2. **「搜索」按钮与回车立即生效**——显式提交必须比防抖更快，且要取消待发的那次
 *    防抖，避免「回车刚出结果、300ms 后又发一次同样的请求」。
 *
 * 「更多筛选」的展开内容用**默认插槽**塞进来（`SearchFilters`），展开态由本组件持有：
 * `aria-expanded` 与 `aria-controls` 必须成对维护，把内容和按钮拆到两个组件里
 * 最容易出现「按钮说有、DOM 里没有」的错配。
 */
import { onBeforeUnmount, ref, watch } from 'vue'

import { t } from '@/i18n'

const props = withDefaults(
  defineProps<{
    /** 当前关键词（受控）。 */
    keyword?: string
    /** 已选条件下的 chips；`key` 用于回传移除，`label` 是显示文案。 */
    chips?: Array<{ key: string; label: string }>
    /** 「更多筛选」内容的 DOM id（`aria-controls` 指向它）。 */
    moreId?: string
    /** 防抖毫秒数；显式提交（按钮 / 回车）不受它影响。 */
    debounceMs?: number
  }>(),
  {
    keyword: '',
    chips: () => [],
    moreId: 'search-more',
    debounceMs: 300,
  },
)

const emit = defineEmits<{
  /** 提交关键词（防抖到期或显式提交）。 */
  search: [keyword: string]
  /** 移除某个条件 chip。 */
  'remove-chip': [key: string]
  /** 清除全部条件。 */
  clear: []
}>()

/** 输入框本地值：受控于 props，但打字时先本地更新（否则光标会跳）。 */
const local = ref<string>(props.keyword)
const moreOpen = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

watch(
  () => props.keyword,
  (next) => {
    if (next !== local.value) {
      local.value = next
    }
  },
)

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}

/** 防抖提交：只用于「边打字边搜」。 */
function schedule(): void {
  clearTimer()
  if (props.debounceMs <= 0) {
    emit('search', local.value)
    return
  }
  timer = setTimeout(() => {
    timer = null
    emit('search', local.value)
  }, props.debounceMs)
}

/** 显式提交：按钮与回车都走这里，先取消待发的防抖。 */
function submit(): void {
  clearTimer()
  emit('search', local.value)
}

function onInput(): void {
  schedule()
}

function toggleMore(): void {
  moreOpen.value = !moreOpen.value
}

function removeChip(key: string): void {
  emit('remove-chip', key)
}

onBeforeUnmount(() => {
  // 组件销毁后仍触发 emit 会被 Vue 警告，也会打一次无主请求。
  clearTimer()
})
</script>

<template>
  <div class="search-bar">
    <div class="search-bar__row">
      <input
        v-model="local"
        type="search"
        class="search-bar__input"
        :placeholder="t('search.placeholder')"
        :aria-label="t('search.keywordLabel')"
        @input="onInput"
        @keydown.enter.prevent="submit"
      />
      <button type="button" class="search-bar__submit" @click="submit">{{ t('search.submit') }}</button>
    </div>

    <div v-if="chips.length > 0" class="search-bar__chips" aria-live="polite">
      <span v-for="chip in chips" :key="chip.key" class="search-bar__chip">
        {{ chip.label }}
        <button
          type="button"
          class="search-bar__chip-x"
          :aria-label="t('search.removeChip', { label: chip.label })"
          @click="removeChip(chip.key)"
        >✕</button>
      </span>
    </div>

    <button
      type="button"
      class="search-bar__toggle"
      :aria-expanded="moreOpen ? 'true' : 'false'"
      :aria-controls="moreId"
      @click="toggleMore"
    >
      {{ t('search.moreFilters') }} <span aria-hidden="true">{{ moreOpen ? '▴' : '▾' }}</span>
    </button>

    <div v-show="moreOpen" :id="moreId" class="search-bar__more">
      <slot />
    </div>

    <div v-if="chips.length > 0" class="search-bar__reset">
      <button type="button" class="search-bar__reset-btn" @click="emit('clear')">{{ t('search.clearAll') }}</button>
    </div>
  </div>
</template>

<style scoped>
.search-bar {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.search-bar__row {
  display: flex;
  gap: 8px;
}

.search-bar__input {
  flex: 1;
  min-width: 0;
  min-height: 44px;
  padding: 10px 14px;
  border: 1.5px solid var(--fb-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-card);
  color: var(--fb-ink);
  font-family: inherit;
  font-size: 14px;
}

.search-bar__input:focus {
  outline: none;
  border-color: var(--fb-blue);
}

.search-bar__submit {
  flex: none;
  min-width: 64px;
  min-height: 44px;
  padding: 8px 16px;
  border: 1px solid var(--fb-blue);
  border-radius: var(--fb-radius-input);
  background: var(--fb-blue);
  color: var(--fb-white);
  font-family: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}

.search-bar__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.search-bar__chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px 3px 10px;
  border-radius: var(--fb-radius-pill);
  background: var(--fb-blue-soft);
  color: var(--fb-blue);
  font-size: 11px;
}

.search-bar__chip-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin: -4px -2px -4px 0;
  border: none;
  background: transparent;
  color: inherit;
  font-size: 11px;
  cursor: pointer;
}

.search-bar__toggle {
  align-self: flex-start;
  min-height: 32px;
  padding: 4px 8px;
  border: none;
  background: transparent;
  color: var(--fb-blue);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.search-bar__more {
  padding: 8px 0 0;
}

.search-bar__reset {
  padding-top: 2px;
}

.search-bar__reset-btn {
  min-height: 32px;
  padding: 4px 8px;
  border: none;
  background: transparent;
  color: var(--fb-sub);
  font-family: inherit;
  font-size: 12px;
  text-decoration: underline;
  cursor: pointer;
}

.search-bar__input:focus-visible,
.search-bar__submit:focus-visible,
.search-bar__toggle:focus-visible,
.search-bar__reset-btn:focus-visible,
.search-bar__chip-x:focus-visible {
  outline: 2px solid var(--fb-blue);
  outline-offset: 2px;
}
</style>
