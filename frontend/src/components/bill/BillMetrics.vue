<script setup lang="ts">
/**
 * 指标带（B2）：收入 / 支出 / 结余 / 交易数量四卡。
 *
 * - 数字**只来自 `BillMonthTotals`**（`core/bill.ts` 的产出），组件不做任何算术；
 * - 金额一律走 `MoneyText`（隐私遮挡、币种符号、千分位都在那里，组件不拼串）；
 * - **结余三档唯一**（LO-08：现网「结余为正」有 4 种颜色）：正 `--fb-green-ink`、
 *   负 `--fb-danger-ink`、零 `--fb-ink`。符号本身由 `MoneyText` 的 `signed` 决定，
 *   本组件只用颜色表达「正/负/零」，不重复拼 `+`/`-`。
 */
import { computed } from 'vue'

import type { BillMonthTotals } from '@/core/bill'
import { Money } from '@/core/Money'
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
  <section class="metrics" aria-label="当月指标">
    <div class="metrics__card">
      <span class="metrics__label">收入</span>
      <MoneyText :amount="totals.income" :commodity="commodity" size="md" />
    </div>
    <div class="metrics__card">
      <span class="metrics__label">支出</span>
      <MoneyText :amount="totals.expense" :commodity="commodity" size="md" />
    </div>
    <div class="metrics__card">
      <span class="metrics__label">结余</span>
      <span class="metrics__value" :class="`metrics__value--${balanceTone}`">
        <MoneyText :amount="totals.balance" :commodity="commodity" size="md" signed />
      </span>
    </div>
    <div class="metrics__card">
      <span class="metrics__label">交易数量</span>
      <span class="metrics__value">{{ totals.count }} 笔</span>
    </div>
  </section>
</template>

<style scoped>
/* <900 两列（含 769–899 档），≥900 四列 */
.metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.metrics__card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  border-radius: var(--fb-radius-card);
  background: var(--fb-card);
  box-shadow: var(--fb-shadow-card);
}

.metrics__label {
  color: var(--fb-sub);
  font-size: 11px;
}

.metrics__value {
  color: var(--fb-ink);
  font-size: 16px;
  font-weight: 700;
  font-variant-numeric: var(--fb-font-numeric);
}

/* 结余三档（LO-08）：正绿 / 负红 / 零中性 */
.metrics__value--pos {
  color: var(--fb-green-ink);
}

.metrics__value--neg {
  color: var(--fb-danger-ink);
}

.metrics__value--neutral {
  color: var(--fb-ink);
}

@media (min-width: 900px) {
  .metrics {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
</style>
