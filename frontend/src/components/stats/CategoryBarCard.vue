<script setup lang="ts">
/**
 * 分类柱状卡（B4 / T45）：方向 seg（支出 / 收入）+ 点柱下钻 + 返回。
 *
 * 下钻用 **`BarChart` 的 `pick(index)` 事件**（`chart.on('click')` 的 `dataIndex`），
 * 不用 ECharts 命中层（`triggerEvent` / `silent:false`）：命中层在 SVG renderer 下
 * 与 `dispose` 时序打架，会拿到已销毁实例的索引（T07 已定，勿改）。
 *
 * 数据全部来自 `core/reports.ts`（分类聚合）与 `core/stats.ts`（逐日），
 * 本组件只做「哪一份喂给图表」的切换，不做任何算术。
 */
import { computed } from 'vue'

import type { CategoryShare } from '@/core/reports'
import type { DailyRow } from '@/core/stats'
import BarChart from '@/components/charts/BarChart.vue'

const props = withDefaults(
  defineProps<{
    /** 全部分类（已按金额降序、已按 id 分开）。 */
    categories: CategoryShare[]
    /** 下钻后某分类的逐日金额（与 `categories` 同一个币种口径）。 */
    drillDaily: DailyRow[]
    /** 当前方向。 */
    direction: 'expense' | 'income'
    /** 已下钻的分类 id；`null` 表示「全部分类」。 */
    drilledId: number | null
    /** 已下钻分类的显示名（用于标题）。 */
    drilledLabel: string
    commodity: string
    masked?: boolean
  }>(),
  { masked: false },
)

const emit = defineEmits<{
  (event: 'select-direction', direction: 'expense' | 'income'): void
  (event: 'drill', categoryId: number | null): void
}>()

const drilled = computed(() => props.drilledId !== null)

/** 全部分类时：柱 = 各分类金额；下钻时：柱 = 该分类逐日金额。 */
const chartData = computed(() => {
  if (drilled.value) {
    return props.drillDaily.map((row) => ({
      label: String(row.day),
      value: Number(props.direction === 'income' ? row.income : row.expense),
      amount: props.direction === 'income' ? row.income : row.expense,
    }))
  }
  return props.categories.map((item) => ({
    label: item.label,
    value: Number(item.amount),
    amount: item.amount,
  }))
})

const title = computed(() => {
  const dirLabel = props.direction === 'income' ? '收入' : '支出'
  if (!drilled.value) {
    return `${dirLabel}分类统计`
  }
  return `${props.drilledLabel} · 每日${dirLabel}`
})

const emptyText = computed(() =>
  drilled.value ? '该分类本月没有记录' : '本月没有该方向的记录',
)

/** 点柱：全部分类时按索引下钻到对应分类；已下钻时不再响应（避免重复下钻）。 */
function onPick(index: number): void {
  if (drilled.value) {
    return
  }
  const item = props.categories[index]
  if (item === undefined) {
    return
  }
  emit('drill', item.id)
}
</script>

<template>
  <section class="cat-bar">
    <header class="cat-bar__head">
      <div class="cat-bar__seg" role="group" aria-label="柱状图收支方向">
        <button
          type="button"
          class="cat-bar__seg-btn"
          :class="{ 'cat-bar__seg-btn--on': direction === 'expense' }"
          :aria-pressed="direction === 'expense'"
          @click="emit('select-direction', 'expense')"
        >支出</button>
        <button
          type="button"
          class="cat-bar__seg-btn"
          :class="{ 'cat-bar__seg-btn--on': direction === 'income' }"
          :aria-pressed="direction === 'income'"
          @click="emit('select-direction', 'income')"
        >收入</button>
      </div>
      <span class="cat-bar__title">{{ title }}</span>
      <button v-if="drilled" type="button" class="cat-bar__back" @click="emit('drill', null)">
        ‹ 返回全部分类
      </button>
    </header>

    <BarChart
      :title="title"
      :chart-label="`${title}，${commodity} 口径`"
      :data="chartData"
      :color="direction === 'income' ? 'var(--fb-green)' : 'var(--fb-danger)'"
      :masked="masked"
      :dense="drilled"
      :empty-text="emptyText"
      :state="chartData.length === 0 ? 'empty' : 'ready'"
      @pick="onPick"
    />
  </section>
</template>

<style scoped>
.cat-bar__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.cat-bar__seg {
  display: inline-flex;
  padding: 2px;
  border-radius: var(--fb-radius-pill);
  background: var(--fb-soft);
}

.cat-bar__seg-btn {
  padding: 4px 12px;
  border: none;
  border-radius: var(--fb-radius-pill);
  background: transparent;
  color: var(--fb-sub);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.cat-bar__seg-btn--on {
  background: var(--fb-card);
  color: var(--fb-ink);
  font-weight: 600;
}

.cat-bar__title {
  color: var(--fb-ink);
  font-size: 12px;
  font-weight: 600;
}

.cat-bar__back {
  margin-left: auto;
  border: none;
  background: transparent;
  color: var(--fb-blue);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}
</style>
