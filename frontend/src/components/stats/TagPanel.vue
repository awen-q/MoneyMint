<script setup lang="ts">
/**
 * 标签子页（B4 / T47）：标签统计表 + 支出/收入标签双环。
 *
 * 三条口径：
 * 1. **「未打标签」是正常的桶**（`core/stats.ts` 的 `untaggedLabel()`）：只统计有标签的
 *    交易会让各扇区之和 < 100%，用户会以为算错。这里照常作为一行/一块显示；
 * 2. **颜色单一来源**：环图 slice 与排行行色块共用同一个 `pickColor` 结果；
 * 3. 环心是该侧合计（支出标签合计 / 收入标签合计），金额取定点串，不由 value 反算。
 */
import { computed } from 'vue'

import type { TagShare } from '@/core/stats'
import { t } from '@/i18n'
import { getChartPalette, pickColor, readThemeTokens, themeEpoch } from '@/styles/themeTokens'
import DonutChart from '@/components/charts/DonutChart.vue'
import MoneyText from '@/components/MoneyText.vue'

const props = withDefaults(
  defineProps<{
    shares: TagShare[]
    commodity: string
    masked?: boolean
  }>(),
  { masked: false },
)

const emit = defineEmits<{
  (event: 'drill', tag: string, kind: 'expense' | 'income'): void
}>()

const palette = computed(() => {
  void themeEpoch.value
  return getChartPalette(readThemeTokens())
})

interface Slice {
  name: string
  value: number
  amount: string
  color: string
  /** 「未打标签」不是用户创建的标签，排行行不加 `#` 前缀（与表格一致）。 */
  untagged: boolean
}

/** 取某一方向金额 > 0 的标签，并按该方向金额降序。 */
function sideSlices(kind: 'expense' | 'income'): Slice[] {
  const items = props.shares
    .filter((share) => Number(kind === 'expense' ? share.expense : share.income) > 0)
    .slice()
    .sort((left, right) => Number(kind === 'expense' ? right.expense : right.income) -
      Number(kind === 'expense' ? left.expense : left.income))
  const out: Slice[] = []
  let previous: string | undefined
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    const color = pickColor(palette.value.pie, index, previous)
    previous = color
    const amount = kind === 'expense' ? item.expense : item.income
    out.push({ name: item.tag, value: Number(amount), amount, color, untagged: item.isUntagged })
  }
  return out
}

const expenseSlices = computed(() => sideSlices('expense'))
const incomeSlices = computed(() => sideSlices('income'))

const expenseTotal = computed(() => {
  let total = 0
  for (const share of props.shares) {
    total += Number(share.expense)
  }
  return total.toFixed(2)
})

const incomeTotal = computed(() => {
  let total = 0
  for (const share of props.shares) {
    total += Number(share.income)
  }
  return total.toFixed(2)
})

function drillExpense(index: number): void {
  const slice = expenseSlices.value[index]
  if (slice !== undefined) {
    emit('drill', slice.name, 'expense')
  }
}

function drillIncome(index: number): void {
  const slice = incomeSlices.value[index]
  if (slice !== undefined) {
    emit('drill', slice.name, 'income')
  }
}
</script>

<template>
  <div class="tag-panel">
    <section class="tag-panel__card">
      <header class="tag-panel__head">
        <span class="tag-panel__title">{{ t('stats.tagTitle') }}</span>
        <span class="tag-panel__note">{{ t('stats.tagNote') }}</span>
      </header>
      <p v-if="shares.length === 0" class="tag-panel__empty">{{ t('stats.tagEmpty') }}</p>
      <table v-else class="tag-panel__table">
        <thead>
          <tr>
            <th scope="col">{{ t('stats.tagCol') }}</th>
            <th scope="col" class="tag-panel__r">{{ t('common.expense') }}</th>
            <th scope="col" class="tag-panel__r">{{ t('common.income') }}</th>
            <th scope="col" class="tag-panel__r">{{ t('common.balance') }}</th>
            <th scope="col" class="tag-panel__r">{{ t('stats.countCol') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="share in shares" :key="share.tag">
            <td>
              <button type="button" class="tag-panel__row-btn" @click="emit('drill', share.tag, 'expense')">
                {{ share.isUntagged ? share.tag : `#${share.tag}` }}
              </button>
            </td>
            <td class="tag-panel__r">
              <MoneyText v-if="share.expense !== '0.00'" :amount="share.expense" :commodity="commodity" :privacy="masked" size="sm" />
              <span v-else class="tag-panel__dash">—</span>
            </td>
            <td class="tag-panel__r">
              <MoneyText v-if="share.income !== '0.00'" :amount="share.income" :commodity="commodity" :privacy="masked" size="sm" />
              <span v-else class="tag-panel__dash">—</span>
            </td>
            <td class="tag-panel__r">
              <MoneyText :amount="share.balance" :commodity="commodity" :privacy="masked" size="sm" signed />
            </td>
            <td class="tag-panel__r tag-panel__count">{{ share.count }}</td>
          </tr>
        </tbody>
      </table>
      <p class="tag-panel__hint">{{ t('stats.tagHint') }}</p>
    </section>

    <section class="tag-panel__card">
      <header class="tag-panel__head">
        <span class="tag-panel__title">{{ t('stats.tagDonutTitle') }}</span>
        <span class="tag-panel__note">{{ t('stats.drillHint') }}</span>
      </header>
      <div class="tag-panel__duo">
        <div>
          <p class="tag-panel__block-title">{{ t('stats.expenseTag') }}</p>
          <DonutChart
            :title="t('stats.expenseTag')"
            :chart-label="t('stats.expenseTagLabel', { commodity })"
            :slices="expenseSlices"
            :center-text="t('common.total')"
            :center-value="expenseTotal"
            :commodity="commodity"
            :masked="masked"
            :state="expenseSlices.length === 0 ? 'empty' : 'ready'"
            :empty-text="t('stats.emptyExpenseTag')"
            @pick="drillExpense"
          />
          <ul v-if="expenseSlices.length > 0" class="tag-panel__list">
            <li v-for="(slice, index) in expenseSlices" :key="'e' + slice.name">
              <button type="button" class="tag-panel__rank" @click="drillExpense(index)">
                <span class="tag-panel__dot" :style="{ background: slice.color }" aria-hidden="true"></span>
                <span class="tag-panel__rank-name">{{ slice.untagged ? slice.name : `#${slice.name}` }}</span>
                <span class="tag-panel__rank-amount">
                  <MoneyText :amount="slice.amount" :commodity="commodity" :privacy="masked" size="sm" />
                </span>
              </button>
            </li>
          </ul>
        </div>
        <div>
          <p class="tag-panel__block-title">{{ t('stats.incomeTag') }}</p>
          <DonutChart
            :title="t('stats.incomeTag')"
            :chart-label="t('stats.incomeTagLabel', { commodity })"
            :slices="incomeSlices"
            :center-text="t('common.total')"
            :center-value="incomeTotal"
            :commodity="commodity"
            :masked="masked"
            :state="incomeSlices.length === 0 ? 'empty' : 'ready'"
            :empty-text="t('stats.emptyIncomeTag')"
            @pick="drillIncome"
          />
          <ul v-if="incomeSlices.length > 0" class="tag-panel__list">
            <li v-for="(slice, index) in incomeSlices" :key="'i' + slice.name">
              <button type="button" class="tag-panel__rank" @click="drillIncome(index)">
                <span class="tag-panel__dot" :style="{ background: slice.color }" aria-hidden="true"></span>
                <span class="tag-panel__rank-name">{{ slice.untagged ? slice.name : `#${slice.name}` }}</span>
                <span class="tag-panel__rank-amount">
                  <MoneyText :amount="slice.amount" :commodity="commodity" :privacy="masked" size="sm" />
                </span>
              </button>
            </li>
          </ul>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.tag-panel__card {
  margin-bottom: 10px;
  padding: 14px;
  border-radius: var(--fb-radius-card);
  background: var(--fb-card);
  box-shadow: var(--fb-shadow-card);
}

.tag-panel__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.tag-panel__title {
  color: var(--fb-ink);
  font-size: 13px;
  font-weight: 600;
}

.tag-panel__note {
  color: var(--fb-sub);
  font-size: 11px;
}

.tag-panel__empty {
  margin: 12px 0 0;
  color: var(--fb-sub);
  font-size: 12px;
  text-align: center;
}

.tag-panel__table {
  width: 100%;
  margin-top: 8px;
  border-collapse: collapse;
  font-size: 12px;
  font-variant-numeric: var(--fb-font-numeric);
}

.tag-panel__table th {
  padding: 6px 4px;
  border-bottom: 1px solid var(--fb-line);
  color: var(--fb-sub);
  font-weight: 500;
  text-align: left;
}

.tag-panel__table td {
  padding: 7px 4px;
  border-bottom: 1px solid var(--fb-line);
  color: var(--fb-ink);
}

.tag-panel__r {
  text-align: right;
}

.tag-panel__row-btn {
  border: none;
  background: transparent;
  color: var(--fb-blue);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  padding: 0;
}

.tag-panel__dash {
  color: var(--fb-sub);
}

.tag-panel__count {
  color: var(--fb-sub);
}

.tag-panel__hint {
  margin: 8px 0 0;
  color: var(--fb-sub);
  font-size: 11px;
  line-height: 1.5;
}

.tag-panel__duo {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
  margin-top: 10px;
}

.tag-panel__block-title {
  margin: 0 0 4px;
  color: var(--fb-sub);
  font-size: 11px;
}

.tag-panel__list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
}

.tag-panel__rank {
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

.tag-panel__dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.tag-panel__rank-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag-panel__rank-amount {
  margin-left: auto;
  flex: none;
  font-variant-numeric: var(--fb-font-numeric);
}
</style>
