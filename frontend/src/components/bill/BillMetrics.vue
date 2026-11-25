<script setup lang="ts">
/**
 * 指标带（B2）：收入 / 支出 / 结余 / 交易数量四卡。
 *
 * - 数字**只来自 `BillMonthTotals`**（`core/bill.ts` 的产出），组件不做任何算术；
 * - 金额一律走 `MoneyText`（隐私遮挡、币种符号、千分位都在那里，组件不拼串）；
 * - **结余三档唯一**（LO-08：现网「结余为正」有 4 种颜色）：正 `--fb-green`、
 *   负 `--fb-danger`、零 `--fb-ink`（三色在卡面上实测 4.72 / 5.22 / 高，均过 AA）。
 *   符号本身由 `MoneyText` 的 `signed` 决定，本组件只用颜色表达「正/负/零」，
 *   不重复拼 `+`/`-`。
 */
import { computed } from 'vue'

import type { BillMonthTotals } from '@/core/bill'
import { Money } from '@/core/Money'
import { t } from '@/i18n'
import MoneyText from '@/components/MoneyText.vue'

const props = defineProps<{
  /** 月合计（`monthTotals` 产出）。 */
  totals: BillMonthTotals
  /** 展示币种。 */
  commodity: string
}>()

/** 结余档位：正 / 负 / 零。用 `Money` 判符号，不 parseFloat 定点串。 */
const balanceTone = computed<'pos' | 'neg' | 'neutral'>(() => {
  let balance: Money
  try {
    balance = Money.from(props.totals.balance)
  } catch {
    return 'neutral'
  }
  if (balance.isZero()) {
    return 'neutral'
  }
  return balance.isNegative() ? 'neg' : 'pos'
})
</script>

<template>
  <section class="metrics" :aria-label="t('bills.metricsLabel')">
    <div class="metrics__card metrics__card--income">
      <span class="metrics__label">{{ t('common.income') }}</span>
      <MoneyText :amount="totals.income" :commodity="commodity" size="md" />
    </div>
    <div class="metrics__card metrics__card--expense">
      <span class="metrics__label">{{ t('common.expense') }}</span>
      <MoneyText :amount="totals.expense" :commodity="commodity" size="md" />
    </div>
    <div class="metrics__card">
      <span class="metrics__label">{{ t('common.balance') }}</span>
      <span class="metrics__value" :class="`metrics__value--${balanceTone}`">
        <MoneyText :amount="totals.balance" :commodity="commodity" size="md" signed />
      </span>
      <span class="metrics__sub">{{ t('bills.balanceFormula') }}</span>
    </div>
    <div class="metrics__card">
      <span class="metrics__label">{{ t('bills.metricCount') }}</span>
      <span class="metrics__value">{{ t('common.txnCount', { count: String(totals.count) }) }}</span>
      <span class="metrics__sub">{{ t('bills.countSub') }}</span>
    </div>
  </section>
</template>

<style scoped>
/* <900 两列（含 769–899 档），≥900 四列。
   **gap 与卡片内边距是固定 px，任何断点都不改**（老板要求四卡上下左右边距固定）；
   骨架复合 `.bills__skel-metrics` 同步 12px，加载前后不跳动。 */
.metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.metrics__card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 16px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-card);
  background: var(--fb-card);
  box-shadow: var(--fb-shadow-card);
}

.metrics__label {
  color: var(--fb-sub);
  font-size: 12px;
}

/* 数值 20px（移动 18px）。
   收入 / 支出卡的数字是裸 `MoneyText`（**不能**包一层 `.metrics__value`：
   `BillMetrics.test.ts:58-73` 用 `findAll('.metrics__value')[0]` 取结余卡，
   给前两张卡也加同类名会把下标挪位），所以两处分别写。 */
.metrics__value {
  color: var(--fb-ink);
  font-size: 20px;
  font-weight: 700;
  font-variant-numeric: var(--fb-font-numeric);
}

.metrics__value :deep(.money-text) {
  font-size: 20px;
  font-weight: 700;
}

.metrics__card--income :deep(.money-text) {
  font-size: 20px;
  font-weight: 700;
}

.metrics__card--expense :deep(.money-text) {
  font-size: 20px;
  font-weight: 700;
}

/* 收入绿 / 支出红（B-04）：设计 `.m-income .val` / `.m-expense .val`。
   两色在 `--fb-card` 上实测 4.72 / 5.22，均过 WCAG AA 正文门禁。 */
.metrics__card--income :deep(.money-text) {
  color: var(--fb-green);
}

.metrics__card--expense :deep(.money-text) {
  color: var(--fb-danger);
}

.metrics__sub {
  color: var(--fb-sub);
  font-size: 11px;
  line-height: 1.4;
  min-height: 15px;
}

/* 结余三档（LO-08）：正绿 / 负红 / 零中性（色值对齐设计 `--income` / `--expense`） */
.metrics__value--pos {
  color: var(--fb-green);
}

.metrics__value--neg {
  color: var(--fb-danger);
}

.metrics__value--neutral {
  color: var(--fb-ink);
}

@media (max-width: 768px) {
  /* 只缩数字字号，不碰 gap / padding —— 边距在桌面与移动端必须一致 */
  .metrics__value,
  .metrics__value :deep(.money-text) {
    font-size: 18px;
  }

  .metrics__card--income :deep(.money-text),
  .metrics__card--expense :deep(.money-text) {
    font-size: 18px;
  }
}

@media (min-width: 900px) {
  .metrics {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
</style>
