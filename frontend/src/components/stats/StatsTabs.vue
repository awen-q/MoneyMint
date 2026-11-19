<script setup lang="ts">
/**
 * 统计子页 chips（B4 / T42）：统计 / 标签。
 *
 * **LO-03 原始缺陷**：上一版把 chips 吸底，把内容挤出首屏。这里就是**普通行内元素**，
 * `position` 保持默认 —— 不吸底、也不吸顶（吸顶同样会遮挡日历/指标）。
 */
withDefaults(
  defineProps<{
    /** 当前子页。 */
    tab: 'stat' | 'tag'
  }>(),
  { tab: 'stat' },
)

const emit = defineEmits<{
  (event: 'select', tab: 'stat' | 'tag'): void
}>()
</script>

<template>
  <div class="stats-tabs" role="tablist" aria-label="统计子页">
    <button
      type="button"
      role="tab"
      class="stats-tabs__btn"
      :class="{ 'stats-tabs__btn--on': tab === 'stat' }"
      :aria-selected="tab === 'stat'"
      @click="emit('select', 'stat')"
    >统计</button>
    <button
      type="button"
      role="tab"
      class="stats-tabs__btn"
      :class="{ 'stats-tabs__btn--on': tab === 'tag' }"
      :aria-selected="tab === 'tag'"
      @click="emit('select', 'tag')"
    >标签</button>
  </div>
</template>

<style scoped>
/* 刻意不设 position：chips 是行内控件，吸底/吸顶都会挤占内容区（LO-03） */
.stats-tabs {
  display: inline-flex;
  padding: 3px;
  border-radius: var(--fb-radius-pill);
  background: var(--fb-soft);
}

.stats-tabs__btn {
  padding: 5px 14px;
  border: none;
  border-radius: var(--fb-radius-pill);
  background: transparent;
  color: var(--fb-sub);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.stats-tabs__btn--on {
  background: var(--fb-card);
  color: var(--fb-ink);
  font-weight: 600;
  box-shadow: var(--fb-shadow-card);
}
</style>
