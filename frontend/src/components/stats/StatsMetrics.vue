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
    return '本月未开始'
  }
  const base = `按已过 ${props.average.elapsedDays} 天`
  return props.isCurrentMonth === true ? `${base}（本月未完）` : base
})
</script>

<template>
  <section class="stats-metrics" aria-label="统计信息">
    <div class="stats-metrics__card">
      <span class="stats-metrics__label">收入</span>
      <MoneyText :amount="totals.income" :commodity="commodity" :privacy="masked === true" size="md" />
    </div>
    <div class="stats-metrics__card">
      <span class="stats-metrics__label">支出</span>
      <MoneyText :amount="totals.expense" :commodity="commodity" :privacy="masked === true" size="md" />
    </div>
    <div class="stats-metrics__card">
      <span class="stats-metrics__label">结余</span>
      <MoneyText
        :amount="totals.balance"
        :commodity="commodity"
        :privacy="masked === true"
        size="md"
        signed
      />
    </div>
    <div class="stats-metrics__card">
      <span class="stats-metrics__label">日均消费</span>
      <span v-if="average.applicable" class="stats-metrics__avg">
        <MoneyText
          :amount="average.expense"
          :commodity="commodity"
          :privacy="masked === true"
          size="md"
        />
      </span>
      <span v-else class="stats-metrics__dash" aria-label="本月未开始">—</span>
      <span class="stats-metrics__sub">{{ averageSub }}</span>
    </div>
    <div class="stats-metrics__card">
      <span class="stats-metrics__label">记账数量</span>
      <span class="stats-metrics__count">{{ totals.count }}</span>
      <span class="stats-metrics__sub">所选币种笔数</span>
    </div>
  </section>
</template>

<style scoped>
.stats-metrics {
  display: grid;
  /* auto-fit：320px 一列、宽屏自动铺满；不用断点硬编码列数 */
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
}

.stats-metrics__card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  border-radius: var(--fb-radius-card);
  background: var(--fb-card);
  box-shadow: var(--fb-shadow-card);
}

.stats-metrics__label {
  color: var(--fb-sub);
  font-size: 11px;
}

.stats-metrics__avg {
  color: var(--fb-ink);
  font-variant-numeric: var(--fb-font-numeric);
}

.stats-metrics__dash {
  color: var(--fb-sub);
  font-size: 16px;
  font-weight: 700;
}

.stats-metrics__count {
  color: var(--fb-ink);
  font-size: 16px;
  font-weight: 700;
  font-variant-numeric: var(--fb-font-numeric);
}

.stats-metrics__sub {
  color: var(--fb-sub);
  font-size: 10px;
  line-height: 1.4;
}
</style>
