<script setup lang="ts">
/**
 * 双环 + 排行卡（B4 / T46）：消费分类 / 收入分类，各一个环 + 一份排行。
 *
 * 三条口径：
 * 1. **颜色只有一个来源**：slices 与排行行的色块都取同一个 `pickColor(pie, i, prev)`
 *    的结果，绝不各算一次 —— 否则「第 7 行色 ≠ 第 7 块色」是最难发现的静默错账；
 * 2. **环心 = 该侧合计**（`amount` 定点串直接喂 `centerValue`，不由 value 反算）；
 * 3. **排行即图例**（PRD：环图 + 排行合为一张卡），所以本组件不接 legend；
 *    移动端无 hover，排行列表是识别「哪个分类、多少钱」的唯一通道，属 P0。
 */
import { computed } from 'vue'

import type { CategoryShare } from '@/core/reports'
import { getChartPalette, pickColor, readThemeTokens, themeEpoch } from '@/styles/themeTokens'
import DonutChart from '@/components/charts/DonutChart.vue'
import MoneyText from '@/components/MoneyText.vue'

const props = withDefaults(
  defineProps<{
    /** 支出分类（按金额降序）。 */
    expense: CategoryShare[]
    /** 收入分类（按金额降序）。 */
    income: CategoryShare[]
    /** 本月合计（环心金额）—— 支出侧 / 收入侧各一个。 */
    expenseTotal: string
    incomeTotal: string
    commodity: string
    masked?: boolean
  }>(),
  { masked: false },
)

const emit = defineEmits<{
  (event: 'drill', categoryId: number | null, kind: 'expense' | 'income'): void
}>()

/** 图表配色跟随主题（夜间切换后重新取色）。 */
const palette = computed(() => {
  void themeEpoch.value
  return getChartPalette(readThemeTokens())
})

interface Slice {
  name: string
  value: number
  amount: string
  color: string
}

/** 把分类聚合转成环图 slices —— 颜色在这里一次算好，排行行复用同一个数组。 */
function toSlices(items: CategoryShare[]): Slice[] {
  const out: Slice[] = []
  let previous: string | undefined
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    const color = pickColor(palette.value.pie, index, previous)
    previous = color
    const value = Number(item.amount)
    out.push({
      name: item.label,
      // 负值（退款导致）不参与角度：占比为 0，但仍保留行（金额照实显示）
      value: Number.isFinite(value) && value > 0 ? value : 0,
      amount: item.amount,
      color,
    })
  }
  return out
}

const expenseSlices = computed(() => toSlices(props.expense))
const incomeSlices = computed(() => toSlices(props.income))

function drillExpense(index: number): void {
  const item = props.expense[index]
  emit('drill', item === undefined ? null : item.id, 'expense')
}

function drillIncome(index: number): void {
  const item = props.income[index]
  emit('drill', item === undefined ? null : item.id, 'income')
}
</script>

<template>
  <section class="donut-rank">
    <header class="donut-rank__head">
      <span class="donut-rank__title">分类占比</span>
      <span class="donut-rank__note">点击环图或排行项下钻</span>
    </header>

    <div class="donut-rank__duo">
      <div class="donut-rank__block">
        <p class="donut-rank__block-title">消费分类</p>
        <DonutChart
          title="消费分类"
          :chart-label="`消费分类占比，${commodity} 口径`"
          :slices="expenseSlices"
          center-text="合计"
          :center-value="expenseTotal"
          :commodity="commodity"
          :masked="masked"
          :state="expenseSlices.length === 0 ? 'empty' : 'ready'"
          empty-text="本月没有支出记录"
          @pick="drillExpense"
        />
        <ul v-if="expenseSlices.length > 0" class="donut-rank__list">
          <li v-for="(slice, index) in expenseSlices" :key="slice.name + index">
            <button type="button" class="donut-rank__row" @click="drillExpense(index)">
              <span class="donut-rank__dot" :style="{ background: slice.color }" aria-hidden="true"></span>
              <span class="donut-rank__name">{{ slice.name }}</span>
              <span class="donut-rank__amount">
                <MoneyText :amount="slice.amount" :commodity="commodity" :privacy="masked" size="sm" />
              </span>
            </button>
          </li>
        </ul>
      </div>

      <div class="donut-rank__block">
        <p class="donut-rank__block-title">收入分类</p>
        <DonutChart
          title="收入分类"
          :chart-label="`收入分类占比，${commodity} 口径`"
          :slices="incomeSlices"
          center-text="合计"
          :center-value="incomeTotal"
          :commodity="commodity"
          :masked="masked"
          :state="incomeSlices.length === 0 ? 'empty' : 'ready'"
          empty-text="本月没有收入记录"
          @pick="drillIncome"
        />
        <ul v-if="incomeSlices.length > 0" class="donut-rank__list">
          <li v-for="(slice, index) in incomeSlices" :key="slice.name + index">
            <button type="button" class="donut-rank__row" @click="drillIncome(index)">
              <span class="donut-rank__dot" :style="{ background: slice.color }" aria-hidden="true"></span>
              <span class="donut-rank__name">{{ slice.name }}</span>
              <span class="donut-rank__amount">
                <MoneyText :amount="slice.amount" :commodity="commodity" :privacy="masked" size="sm" />
              </span>
            </button>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
.donut-rank__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.donut-rank__title {
  color: var(--fb-ink);
  font-size: 13px;
  font-weight: 600;
}

.donut-rank__note {
  color: var(--fb-sub);
  font-size: 11px;
}

.donut-rank__duo {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
  margin-top: 10px;
}

.donut-rank__block {
  min-width: 0;
}

.donut-rank__block-title {
  margin: 0 0 4px;
  color: var(--fb-sub);
  font-size: 11px;
}

.donut-rank__list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
}

.donut-rank__row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 2px;
  border: none;
  border-bottom: 1px solid var(--fb-line);
  background: transparent;
  color: var(--fb-ink);
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.donut-rank__dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.donut-rank__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.donut-rank__amount {
  margin-left: auto;
  flex: none;
  font-variant-numeric: var(--fb-font-numeric);
}
</style>
