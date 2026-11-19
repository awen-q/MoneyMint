<script setup lang="ts">
/**
 * 月度资产变化列表（B6 / T56）。
 *
 * 四列：月份 · 月末总资产 · 较上月 · 变化占比。
 *
 * 三条口径：
 * 1. **不重算金额**：`assets` / `deltaAssets` 都是 `core/assetSeries.ts` 给的定点串，
 *    本组件只决定「显示成什么符号与颜色」；
 * 2. **缺失值给「—」而不是 0**：1 月没有上月数据（跨年无从推算），上月为 0 时占比
 *    没有意义 —— 这两处都必须是 `—`。补 0 会读成「这个月没变化」，是错信息；
 * 3. 金额走 `MoneyText`（隐私遮挡与币种符号都在那一层）。
 */
import type { AssetSeriesMonth } from '@/core/assetSeries'
import MoneyText from '@/components/MoneyText.vue'

withDefaults(
  defineProps<{
    months: AssetSeriesMonth[]
    commodity: string
    masked?: boolean
  }>(),
  { masked: false },
)

/** 变化占比展示：0~1 → 百分数，一位小数；`null` 给「—」。 */
function ratioText(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) {
    return '—'
  }
  const percent = ratio * 100
  const rounded = Math.round(percent * 10) / 10
  const sign = rounded > 0 ? '+' : ''
  return `${sign}${rounded.toFixed(1)}%`
}

/** 差额正负：用于决定颜色（金额符号本身仍由 MoneyText 的 `signed` 决定）。 */
function deltaTone(delta: string | null): 'pos' | 'neg' | 'none' {
  if (delta === null) {
    return 'none'
  }
  const value = Number(delta)
  if (!Number.isFinite(value) || value === 0) {
    return 'none'
  }
  return value > 0 ? 'pos' : 'neg'
}
</script>

<template>
  <section class="mo">
    <header class="mo__head">
      <span class="mo__title">月度资产变化</span>
      <span class="mo__note">月末总资产 · 环比变化额 · 环比变化占比</span>
    </header>

    <div class="mo__table" role="table" aria-label="月度资产变化">
      <div class="mo__row mo__row--head" role="row">
        <span role="columnheader">月份</span>
        <span role="columnheader" class="mo__r">月末总资产</span>
        <span role="columnheader" class="mo__r">较上月</span>
        <span role="columnheader" class="mo__r">变化占比</span>
      </div>

      <div v-for="month in months" :key="month.month" class="mo__row" role="row">
        <span class="mo__month">{{ month.label }}</span>
        <span class="mo__r mo__amount">
          <MoneyText :amount="month.assets" :commodity="commodity" :privacy="masked" size="sm" />
        </span>
        <span class="mo__r mo__delta" :class="`mo__delta--${deltaTone(month.deltaAssets)}`">
          <MoneyText
            v-if="month.deltaAssets !== null"
            :amount="month.deltaAssets"
            :commodity="commodity"
            :privacy="masked"
            size="sm"
            signed
          />
          <span v-else class="mo__dash" aria-label="无上月数据">—</span>
        </span>
        <span class="mo__r mo__ratio" :class="`mo__delta--${deltaTone(month.deltaAssets)}`">
          {{ ratioText(month.deltaRatio) }}
        </span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.mo__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}

.mo__title {
  color: var(--fb-ink);
  font-size: 13px;
  font-weight: 600;
}

.mo__note {
  color: var(--fb-sub);
  font-size: 11px;
}

.mo__table {
  margin-top: 8px;
  font-size: 12px;
  font-variant-numeric: var(--fb-font-numeric);
}

.mo__row {
  display: grid;
  grid-template-columns: 56px minmax(0, 1.2fr) minmax(0, 1fr) 76px;
  align-items: center;
  gap: 8px;
  padding: 7px 0;
  border-bottom: 1px solid var(--fb-line);
  color: var(--fb-ink);
}

.mo__row:last-child {
  border-bottom: none;
}

.mo__row--head {
  color: var(--fb-sub);
  font-size: 11px;
}

.mo__r {
  text-align: right;
}

.mo__month {
  color: var(--fb-sub);
}

.mo__dash {
  color: var(--fb-sub);
}

/* 变化方向只用颜色表达；符号本身由 MoneyText 的 signed 决定，不重复拼 + */
.mo__delta--pos {
  color: var(--fb-green-ink);
}

.mo__delta--neg {
  color: var(--fb-danger-ink);
}

.mo__delta--none {
  color: var(--fb-sub);
}

/* 320px：两列（月份 + 金额），环比折到第二行，避免四列挤成两条线 */
@media (max-width: 360px) {
  .mo__row {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    row-gap: 2px;
  }

  .mo__row--head {
    display: none;
  }

  .mo__month {
    grid-column: 1 / 2;
    color: var(--fb-ink);
    font-weight: 600;
  }

  .mo__row .mo__amount {
    grid-column: 2 / 3;
  }

  .mo__row .mo__delta,
  .mo__row .mo__ratio {
    grid-column: 2 / 3;
    font-size: 11px;
  }
}
</style>
