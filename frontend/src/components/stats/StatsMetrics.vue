<script setup lang="ts">
/**
 * 五指标卡（B4 / T43）：收入 / 支出 / 结余 / 日均消费 / 记账数量。
 *
 * - 数字**只来自 `core/stats.ts`** 的 `StatsTotals` 与 `AveragePerDay`，组件零算术；
 * - 日均的副标必须说清分母：`按已过 N 天`，本月未完时追加「（本月未完）」，
 *   未来月（`applicable === false`）显示「—」—— 绝不给一个 `NaN` 或 `0.00`
 *   假装算过；
 * - 网格 `auto-fit minmax(140px)`：320px 一列、宽屏自动铺满，不用断点硬编码。
 */
import { computed } from 'vue'

import type { AveragePerDay, StatsTotals } from '@/core/stats'
import { t } from '@/i18n'
import MoneyText from '@/components/MoneyText.vue'

const props = defineProps<{
  totals: StatsTotals
  average: AveragePerDay
  commodity: string
  /** 是否本月（本月未完时日均要标注）。 */
  isCurrentMonth?: boolean
  /** 单独强制遮挡。 */
  masked?: boolean
}>()

/** 日均副标：分母 + 本月未完提示；未来月明确说「未开始」。 */
const averageSub = computed(() => {
  if (!props.average.applicable) {
    return t('stats.monthNotStarted')
  }
  const base = t('stats.avgByDays', { days: String(props.average.elapsedDays) })
  return props.isCurrentMonth === true ? `${base}${t('stats.monthInProgress')}` : base
})
</script>

<template>
  <section class="stats-metrics" :aria-label="t('stats.metricsLabel')">
    <div class="stats-metrics__card stats-metrics__card--income">
      <span class="stats-metrics__label">{{ t('common.income') }}</span>
      <MoneyText :amount="totals.income" :commodity="commodity" :privacy="masked === true" size="md" />
    </div>
    <div class="stats-metrics__card stats-metrics__card--expense">
      <span class="stats-metrics__label">{{ t('common.expense') }}</span>
      <MoneyText :amount="totals.expense" :commodity="commodity" :privacy="masked === true" size="md" />
    </div>
    <div class="stats-metrics__card">
      <span class="stats-metrics__label">{{ t('common.balance') }}</span>
      <MoneyText
        :amount="totals.balance"
        :commodity="commodity"
        :privacy="masked === true"
        size="md"
        signed
      />
    </div>
    <div class="stats-metrics__card stats-metrics__card--expense">
      <span class="stats-metrics__label">{{ t('stats.avgExpense') }}</span>
      <span v-if="average.applicable" class="stats-metrics__avg">
        <MoneyText
          :amount="average.expense"
          :commodity="commodity"
          :privacy="masked === true"
          size="md"
        />
      </span>
      <span v-else class="stats-metrics__dash" :aria-label="t('stats.monthNotStarted')">—</span>
      <span class="stats-metrics__sub">{{ averageSub }}</span>
    </div>
    <div class="stats-metrics__card">
      <span class="stats-metrics__label">{{ t('stats.txnCountLabel') }}</span>
      <span class="stats-metrics__count">{{ totals.count }}</span>
      <span class="stats-metrics__sub">{{ t('stats.countSub') }}</span>
    </div>
  </section>
</template>

<style scoped>
.stats-metrics {
  display: grid;
  /* auto-fit：320px 一列、宽屏自动铺满；不用断点硬编码列数 */
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
}

.stats-metrics__card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 16px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-card);
  background: var(--fb-card);
  box-shadow: var(--fb-shadow-card);
}

.stats-metrics__label {
  color: var(--fb-sub);
  font-size: 12px;
}

/* 数值 20px（移动 18px）。`MoneyText` 的 md 档是 16px，需在组件内覆盖；
   日均卡的「—」与笔数走各自的类，保持同一字号。 */
.stats-metrics__card :deep(.money-text) {
  font-size: 20px;
  font-weight: 700;
}

.stats-metrics__avg {
  color: var(--fb-ink);
  font-variant-numeric: var(--fb-font-numeric);
}

.stats-metrics__dash {
  color: var(--fb-sub);
  font-size: 20px;
  font-weight: 700;
}

.stats-metrics__count {
  color: var(--fb-ink);
  font-size: 20px;
  font-weight: 700;
  font-variant-numeric: var(--fb-font-numeric);
}

.stats-metrics__sub {
  color: var(--fb-sub);
  font-size: 11px;
  line-height: 1.4;
}

/* 收入绿 / 支出红（S-04）：设计 `.m-income .val` / `.m-expense .val`，
   日均消费同样用红（`c-stats-top.png`）。两色在卡面上实测 4.72 / 5.22，过 AA。 */
.stats-metrics__card--income :deep(.money-text) {
  color: var(--fb-green);
}

.stats-metrics__card--expense :deep(.money-text) {
  color: var(--fb-danger);
}

/* 例外：日均不可用时是「—」不是数字，保持次要色（红「—」会被读成负值告警） */
.stats-metrics__card--expense .stats-metrics__dash {
  color: var(--fb-sub);
}

@media (max-width: 768px) {
  .stats-metrics__card {
    padding: 12px 14px;
  }

  .stats-metrics__card :deep(.money-text),
  .stats-metrics__dash,
  .stats-metrics__count {
    font-size: 18px;
  }
}
</style>
