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
import { t } from '@/i18n'
import { getChartPalette, readThemeTokens, themeEpoch } from '@/styles/themeTokens'
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

/**
 * 图表配色跟随主题（X-05）。
 *
 * 与 `DonutRankCard` / 两个折线页同一条取色路径；**禁止**给 ECharts 传
 * `'var(--fb-green)'` 这类字符串 —— SVG renderer 把它们写进 `stroke` / `fill`
 * 表现属性，`var()` 在其上的解析在 Safari 14 / iOS 14 基线不可靠。
 */
const palette = computed(() => {
  void themeEpoch.value
  return getChartPalette(readThemeTokens())
})

/** 柱色：收入方向用成功绿，支出方向用危险红（与全站「收支」语义一致）。 */
const barColor = computed(() =>
  props.direction === 'income' ? palette.value.income : palette.value.danger,
)

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
  const dirLabel = props.direction === 'income' ? t('common.income') : t('common.expense')
  if (!drilled.value) {
    return t('stats.barTitle', { dir: dirLabel })
  }
  return t('stats.barDrilledTitle', { label: props.drilledLabel, dir: dirLabel })
})

const emptyText = computed(() =>
  drilled.value ? t('stats.barEmptyDrill') : t('stats.barEmpty'),
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
      <div class="cat-bar__seg" role="group" :aria-label="t('stats.barDirectionLabel')">
        <button
          type="button"
          class="cat-bar__seg-btn"
          :class="{ 'cat-bar__seg-btn--on': direction === 'expense' }"
          :aria-pressed="direction === 'expense'"
          @click="emit('select-direction', 'expense')"
        >{{ t('common.expense') }}</button>
        <button
          type="button"
          class="cat-bar__seg-btn"
          :class="{ 'cat-bar__seg-btn--on': direction === 'income' }"
          :aria-pressed="direction === 'income'"
          @click="emit('select-direction', 'income')"
        >{{ t('common.income') }}</button>
      </div>
      <span class="cat-bar__title">{{ title }}</span>
      <button v-if="drilled" type="button" class="cat-bar__back" @click="emit('drill', null)">
        {{ t('stats.backAllCategories') }}
      </button>
    </header>

    <BarChart
      :title="title"
      :chart-label="t('stats.barChartLabel', { title, commodity })"
      :data="chartData"
      :color="barColor"
      :masked="masked"
      :dense="drilled"
      :empty-text="emptyText"
      :state="chartData.length === 0 ? 'empty' : 'ready'"
      @pick="onPick"
    />
  </section>
</template>

<style scoped>
/* 卡头（设计 `.bar-head` gap 8 / margin-bottom 10） */
.cat-bar__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

/* 方向 seg（S-08）：容器描边 + 选中「实心墨绿 + 米白字」（原实现反色） */
.cat-bar__seg {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-pill);
  background: var(--fb-soft);
}

.cat-bar__seg-btn {
  min-height: 30px;
  padding: 6px 14px;
  border: none;
  border-radius: var(--fb-radius-pill);
  background: transparent;
  color: var(--fb-sub);
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.cat-bar__seg-btn--on {
  background: var(--fb-blue);
  color: var(--fb-white);
  font-weight: 600;
}

.cat-bar__seg-btn:focus-visible {
  outline: 2px solid var(--fb-blue);
  outline-offset: 2px;
}

/* 标题 13.5/700（设计 `.bar-title`） */
.cat-bar__title {
  color: var(--fb-ink);
  font-size: 13.5px;
  font-weight: 700;
}

/* 「返回全部分类」（S-08）：设计 `.back-chip` —— brand-soft 底 + brand-line 描边胶囊，
   原来是纯文字蓝字，看不出是个按钮 */
.cat-bar__back {
  margin-left: auto;
  padding: 5px 12px;
  border: 1px solid var(--fb-brand-line);
  border-radius: var(--fb-radius-pill);
  background: var(--fb-brand-soft);
  color: var(--fb-blue);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.cat-bar__back:focus-visible {
  outline: 2px solid var(--fb-blue);
  outline-offset: 2px;
}
</style>
