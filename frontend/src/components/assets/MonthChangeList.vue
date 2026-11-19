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

/* 卡头标题（AS-03 / S-06 同源）：设计 `.card-title` 15/700 */
.mo__title {
  color: var(--fb-ink);
  font-size: 15px;
  font-weight: 700;
}

.mo__note {
  color: var(--fb-sub);
  font-size: 11px;
}

/* 设计 `.mo-row`：56px / 1fr / 110px / 84px，12.5px，8px 4px 内边距 */
.mo__table {
  margin-top: 8px;
  font-size: 12.5px;
  font-variant-numeric: var(--fb-font-numeric);
}

.mo__row {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr) 110px 84px;
  align-items: center;
  gap: 8px;
  padding: 8px 4px;
  border-bottom: 1px solid var(--fb-line);
  color: var(--fb-ink);
}

.mo__row:last-child {
  border-bottom: none;
}

/* 表头（AS-02 ②）：线更重（`--line-strong`）、11px `--fb-sub` */
.mo__row--head {
  border-bottom: 1px solid var(--fb-line-strong);
  color: var(--fb-sub);
  font-size: 11px;
}

.mo__r {
  text-align: right;
}

/* 月份列（AS-02 ③）：设计 `.mo-m` 未设色 → 继承墨色，原实现是灰色 */
.mo__month {
  color: var(--fb-ink);
}

.mo__dash {
  color: var(--fb-sub);
}

/* 「月末总资产」是四列里最长的一串。375px 下可用宽 307px，
   固定列 46+96+72=214 + gap 24 → 1fr 列只剩 69px，而 `¥123,456.78`
   在 12.5px tabular 下约 78px：没有这条守卫时它不会换行，而是**画到环比列上**。
   宁可截断，也不要两个数字叠在一起。 */
.mo__amount {
  min-width: 0;
  overflow: hidden;
  font-size: 12.5px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * 上面那条只负责「不越界」：`.money-text` 是 `inline-block`，父级的
 * `text-overflow` 对它是**裁剪**而不是省略号（读者只会看到半个数字，不知道被截了）。
 * 把省略号下沉到金额元素本身，截断才有可见信号。
 */
.mo__amount :deep(.money-text) {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 变化方向只用颜色表达；符号本身由 MoneyText 的 signed 决定，不重复拼 +。
   色值按设计 `.mo-delta.ci/.ce`：`--income` / `--expense` 在卡面上实测 4.72 / 5.22，过 AA。 */
.mo__delta--pos {
  color: var(--fb-green);
}

.mo__delta--neg {
  color: var(--fb-danger);
}

.mo__delta--none {
  color: var(--fb-sub);
}

/* 设计 ≤768：46px / 1fr / 96px / 72px，12px（AS-02） */
@media (max-width: 768px) {
  .mo__row {
    grid-template-columns: 46px minmax(0, 1fr) 96px 72px;
    font-size: 12px;
  }
}

/* ≤360：两列两行（月份 + 月末资产 / 环比额 + 占比），避免四列挤成两条线。
   **必须显式 `grid-row`**：`.mo__delta` 与 `.mo__ratio` 都声明了 `grid-column: 2/3`，
   纯自动放置会各占一行（第 1 列空两行、行高翻三倍）。这里把它们按行拆到
   第 2 行的左右两列，才是真正的「两列 × 两行」。 */
@media (max-width: 360px) {
  .mo__row {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    row-gap: 2px;
  }

  .mo__row--head {
    display: none;
  }

  .mo__month {
    grid-row: 1;
    grid-column: 1 / 2;
    color: var(--fb-ink);
    font-weight: 600;
  }

  .mo__row .mo__amount {
    grid-row: 1;
    grid-column: 2 / 3;
  }

  .mo__row .mo__delta {
    grid-row: 2;
    grid-column: 1 / 2;
    font-size: 11px;
    text-align: left;
  }

  .mo__row .mo__ratio {
    grid-row: 2;
    grid-column: 2 / 3;
    font-size: 11px;
  }
}
</style>
