<script setup lang="ts">
/**
 * 试算平衡折叠卡（B4 / T48c）。
 *
 * 两条不能改的口径：
 * 1. **全员可见**（与现网 `ReportsView.vue:292-305` 一致）：写成 owner-only 是**降级**——
 *    普通成员同样需要核对自己记的账有没有配平；
 * 2. **默认收起**：它是核对工具，不是首屏指标。
 *
 * 金额是该币种的**账户余额原值**（符号如实，不取绝对值），来自
 * `core/reports.ts` 的 `trialBalanceRows`。
 */
import { computed, ref } from 'vue'

import type { TrialBalanceRow } from '@/core/reports'
import MoneyText from '@/components/MoneyText.vue'

const props = withDefaults(
  defineProps<{
    rows: TrialBalanceRow[]
    commodity: string
    masked?: boolean
  }>(),
  { masked: false },
)

const open = ref(false)

/** 该币种下所有账户余额之和；配平时应为 0.00（用字符串逐分累加，避免浮点误差）。 */
const sumCents = computed(() => {
  let cents = 0
  for (const row of props.rows) {
    const value = Number(row.balance)
    if (Number.isFinite(value)) {
      cents += Math.round(value * 100)
    }
  }
  return cents
})

const balanced = computed(() => sumCents.value === 0)

const sumText = computed(() => {
  const negative = sumCents.value < 0
  const abs = Math.abs(sumCents.value)
  const intText = String(Math.floor(abs / 100))
  const decText = String(abs % 100).padStart(2, '0')
  return `${negative ? '-' : ''}${intText}.${decText}`
})
</script>

<template>
  <section class="trial-card">
    <button
      type="button"
      class="trial-card__toggle"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span class="trial-card__title">试算平衡</span>
      <span class="trial-card__state" :class="balanced ? 'trial-card__state--ok' : 'trial-card__state--warn'">
        {{ balanced ? '已配平' : `差额 ${sumText}` }}
      </span>
      <span class="trial-card__caret" aria-hidden="true">{{ open ? '⌃' : '⌄' }}</span>
    </button>

    <div v-if="open" class="trial-card__body">
      <p v-if="rows.length === 0" class="trial-card__empty">{{ commodity }} 口径下没有账户余额</p>
      <table v-else class="trial-card__table">
        <thead>
          <tr>
            <th scope="col">账户</th>
            <th scope="col">类型</th>
            <th scope="col" class="trial-card__r">余额</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.label + row.type">
            <td>{{ row.label }}</td>
            <td class="trial-card__type">{{ row.type }}</td>
            <td class="trial-card__r">
              <MoneyText :amount="row.balance" :commodity="commodity" :privacy="masked" size="sm" signed />
            </td>
          </tr>
        </tbody>
      </table>
      <p class="trial-card__hint">余额为 {{ commodity }} 口径原值（符号如实）；全部账户合计应为 0.00</p>
    </div>
  </section>
</template>

<style scoped>
.trial-card {
  padding: 12px 14px;
  border-radius: var(--fb-radius-card);
  background: var(--fb-card);
  box-shadow: var(--fb-shadow-card);
}

.trial-card__toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--fb-ink);
  font-family: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.trial-card__title {
  font-weight: 600;
}

.trial-card__state {
  font-size: 11px;
}

.trial-card__state--ok {
  color: var(--fb-green-ink);
}

.trial-card__state--warn {
  color: var(--fb-danger-ink);
}

.trial-card__caret {
  margin-left: auto;
  color: var(--fb-sub);
}

.trial-card__body {
  margin-top: 8px;
}

.trial-card__empty {
  margin: 0;
  color: var(--fb-sub);
  font-size: 12px;
}

.trial-card__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  font-variant-numeric: var(--fb-font-numeric);
}

.trial-card__table th {
  padding: 6px 4px;
  border-bottom: 1px solid var(--fb-line);
  color: var(--fb-sub);
  font-weight: 500;
  text-align: left;
}

.trial-card__table td {
  padding: 7px 4px;
  border-bottom: 1px solid var(--fb-line);
  color: var(--fb-ink);
}

.trial-card__r {
  text-align: right;
}

.trial-card__type {
  color: var(--fb-sub);
}

.trial-card__hint {
  margin: 8px 0 0;
  color: var(--fb-sub);
  font-size: 11px;
  line-height: 1.5;
}
</style>
