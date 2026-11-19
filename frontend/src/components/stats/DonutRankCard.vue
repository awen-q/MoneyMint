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

/**
 * 占比列（S-07 ⑥）：`slice.value / 该侧合计`。
 *
 * 合计用**同一份 slices 的和**而不是再读一遍 props：slices 已把负值（退款）
 * 归零，两者若各算一遍会出现「占比列加起来 ≠ 100%」。占比**只用于展示**，
 * 绝不回写金额。
 *
 * @param slices 该侧的 slices
 * @param index 行序号
 * @returns 形如 `12.3%` 的文本；合计为 0 时给「—」（不编 0% 假数据）
 */
function shareText(slices: Slice[], index: number): string {
  let total = 0
  for (const slice of slices) {
    total += slice.value
  }
  const target = slices[index]
  if (target === undefined || total <= 0) {
    return '—'
  }
  const percent = (target.value / total) * 100
  const rounded = Math.round(percent * 10) / 10
  return `${rounded.toFixed(1)}%`
}

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
              <span class="donut-rank__pct">{{ shareText(expenseSlices, index) }}</span>
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
              <span class="donut-rank__pct">{{ shareText(incomeSlices, index) }}</span>
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

/* 卡头（S-06）：设计 `.card-title` 15/700，note 11px `--fb-sub` */
.donut-rank__title {
  color: var(--fb-ink);
  font-size: 15px;
  font-weight: 700;
}

.donut-rank__note {
  color: var(--fb-sub);
  font-size: 11px;
}

/* 双环并排（设计 `.duo` 1fr 1fr / gap 16；≤768 单列） */
.donut-rank__duo {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-top: 10px;
}

.donut-rank__block {
  min-width: 0;
}

/* 小标题（S-07 ①）：从「灰色 11px」变「墨色 13/700」——
   这是双环卡最明显的层级差异（`c-stats-top.png` 的「消费分类」是深色粗体） */
.donut-rank__block-title {
  margin: 0 0 6px;
  color: var(--fb-ink);
  font-size: 13px;
  font-weight: 700;
}

.donut-rank__list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
}

/* 排行行（S-07 ③④）：设计 `.rank-item` —— 8px 6px 内边距、描边透明、
   圆角输入档，hover 出 soft 底 + 描边（移动端无 hover，列表本身是唯一识别通道）。
   原来的「行下边框」改为「透明描边」：四段式行不该画成表格。 */
.donut-rank__row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 6px;
  border: 1px solid transparent;
  border-radius: var(--fb-radius-input);
  background: transparent;
  color: var(--fb-ink);
  font-family: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.donut-rank__row:hover,
.donut-rank__row:focus-visible {
  border-color: var(--fb-line);
  background: var(--fb-soft);
  outline: none;
}

/* 色块 10px 方角（设计 `.rank-dot`：10×10 / radius 3px），不是 8px 圆点 */
.donut-rank__dot {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 3px;
}

.donut-rank__name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.donut-rank__amount {
  flex: none;
  font-size: 12.5px;
  font-weight: 600;
  font-variant-numeric: var(--fb-font-numeric);
}

/* 占比列（S-07 ⑥）：设计 `.rank-pct` 10.5px `--fb-muted` / 不换行 */
.donut-rank__pct {
  flex: none;
  color: var(--fb-sub);
  font-size: 10.5px;
  white-space: nowrap;
}

@media (max-width: 768px) {
  .donut-rank__duo {
    grid-template-columns: minmax(0, 1fr);
  }
}

/* 平板 769–899：设计稿也是单列（`mockup:752-756` 的 `769–899` 中间态，
   `.duo { grid-template-columns: 1fr }`）。PC 断点下移到 900 后这一段是补的，
   漏了它会让 769–899 的双环挤成两条极窄的环。 */
@media (min-width: 769px) and (max-width: 899px) {
  .donut-rank__duo {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
