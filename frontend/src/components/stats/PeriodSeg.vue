<script setup lang="ts">
/**
 * 统计页周期 seg（B4 / T48a）：周 / 月 / 年。
 *
 * 只负责「选哪个周期」，**不碰 cursor 与数据窗口** —— 那是页面（T48）的事，
 * 组件保持可单测、可复用（B6 资产统计页也要同一套）。
 */
import { computed } from 'vue'

import type { ReportPeriod } from '@/core/reports'
import { t } from '@/i18n'

withDefaults(
  defineProps<{
    period: ReportPeriod
  }>(),
  { period: 'month' },
)

const emit = defineEmits<{
  (event: 'select', period: ReportPeriod): void
}>()

/** 选项标签**访问时**求值（computed）：切语言后段控文案即时跟随。 */
const OPTIONS = computed<Array<{ value: ReportPeriod; label: string }>>(() => [
  { value: 'week', label: t('stats.periodWeek') },
  { value: 'month', label: t('stats.periodMonth') },
  { value: 'year', label: t('stats.periodYear') },
])
</script>

<template>
  <div class="period-seg" role="group" :aria-label="t('stats.periodLabel')">
    <button
      v-for="option in OPTIONS"
      :key="option.value"
      type="button"
      class="period-seg__btn"
      :class="{ 'period-seg__btn--on': period === option.value }"
      :aria-pressed="period === option.value"
      @click="emit('select', option.value)"
    >{{ option.label }}</button>
  </div>
</template>

<style scoped>
.period-seg {
  display: inline-flex;
  padding: 2px;
  border-radius: var(--fb-radius-pill);
  background: var(--fb-soft);
}

.period-seg__btn {
  padding: 4px 12px;
  border: none;
  border-radius: var(--fb-radius-pill);
  background: transparent;
  color: var(--fb-sub);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.period-seg__btn--on {
  background: var(--fb-card);
  color: var(--fb-ink);
  font-weight: 600;
}
</style>
