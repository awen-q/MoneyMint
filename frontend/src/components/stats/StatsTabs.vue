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
  gap: 4px;
  padding: 3px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-pill);
  background: var(--fb-soft);
}

.stats-tabs__btn {
  padding: 6px 18px;
  border: none;
  border-radius: var(--fb-radius-pill);
  background: transparent;
  color: var(--fb-sub);
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}

/* 选中 = 实心墨绿 + 米白字（设计 `.stats-subtabs button.on`）。
   原实现是「白底墨字 + 阴影」，方向反了 —— `c-stats-top.png` 里「统计」是深绿块。 */
.stats-tabs__btn--on {
  background: var(--fb-blue);
  color: var(--fb-white);
  font-weight: 600;
  box-shadow: none;
}

.stats-tabs__btn:focus-visible {
  outline: 2px solid var(--fb-blue);
  outline-offset: 2px;
}

@media (max-width: 768px) {
  .stats-tabs__btn {
    padding: 6px 12px;
    font-size: 12px;
  }
}
</style>
