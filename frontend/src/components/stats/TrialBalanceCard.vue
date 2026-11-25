<script setup lang="ts">
/**
 * 试算平衡折叠卡（B4 / T48c）。
 *
 * 两条不能改的口径：
 * 1. **全员可见**（与已下线的旧报表页同口径）：写成 owner-only 是**降级**——
 *    普通成员同样需要核对自己记的账有没有配平；
 * 2. **默认收起**：它是核对工具，不是首屏指标。
 *
 * 金额是该币种的**账户余额原值**（符号如实，不取绝对值），来自
 * `core/reports.ts` 的 `trialBalanceRows`。
 */
import { computed, ref } from 'vue'

import type { TrialBalanceRow } from '@/core/reports'
import { t } from '@/i18n'
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
      <span class="trial-card__title">{{ t('stats.trialTitle') }}</span>
      <span class="trial-card__state" :class="balanced ? 'trial-card__state--ok' : 'trial-card__state--warn'">
        {{ balanced ? t('stats.trialBalanced') : t('stats.trialDiff', { diff: sumText }) }}
      </span>
      <span class="trial-card__caret" aria-hidden="true">{{ open ? '⌃' : '⌄' }}</span>
    </button>

    <div v-if="open" class="trial-card__body">
      <p v-if="rows.length === 0" class="trial-card__empty">{{ t('stats.trialEmpty', { commodity }) }}</p>
      <table v-else class="trial-card__table">
        <thead>
          <tr>
            <th scope="col">{{ t('stats.trialAccount') }}</th>
            <th scope="col">{{ t('stats.trialType') }}</th>
            <th scope="col" class="trial-card__r">{{ t('stats.trialBalance') }}</th>
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
        <!--
          合计行（EXT-02 ④）：试算平衡的业务结论就是「全部账户合计应为 0.00」，
          原来这个结论只写在折叠条上，展开后表内看不到「配平在哪里」。
          设计 `.dt-table tfoot`（2px `--line-strong` / 700 / `--ink-deep`）正好提供了原语。

          - 合计值是**现成的 `sumText`**（`sumCents` 逐分累加的结果），这里再算一遍
            就等于造出第二个真相源；
          - 金额走 `MoneyText` + `:privacy="masked"`：隐私模式下合计与明细一起被遮挡，
            绝不自己拼字符串（那会绕过全局遮挡）；
          - 列数与 thead 严格 3 列，「类型」列留空单元格并 `aria-hidden`。
        -->
        <tfoot>
          <tr>
            <td>{{ t('common.total') }}</td>
            <td aria-hidden="true"></td>
            <td class="trial-card__r" :class="{ 'trial-card__sum--diff': !balanced }">
              <MoneyText :amount="sumText" :commodity="commodity" :privacy="masked" size="sm" />
            </td>
          </tr>
        </tfoot>
      </table>
      <p class="trial-card__hint">{{ t('stats.trialHint', { commodity }) }}</p>
    </div>
  </section>
</template>

<style scoped>
.trial-card {
  padding: 16px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-card);
  background: var(--fb-card);
  box-shadow: var(--fb-shadow-card);
}

/* 折叠条按设计 `.card-head` 语法（EXT-02 ②）：基线对齐、两端拉开、下方 12px。
   **不加 position: sticky / fixed** —— `statsCards.test.ts:52-53` 有护栏。 */
.trial-card__toggle {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  margin-bottom: 12px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--fb-ink);
  font-family: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

/* 键盘焦点环（EXT-02 ⑤ / 设计 `:693`） */
.trial-card__toggle:focus-visible {
  outline: 2px solid var(--fb-blue);
  outline-offset: 2px;
}

.trial-card__title {
  color: var(--fb-ink);
  font-size: 15px;
  font-weight: 700;
}

.trial-card__state {
  color: var(--fb-sub);
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
  margin-top: 0;
}

.trial-card__empty {
  margin: 0;
  color: var(--fb-sub);
  font-size: 12px;
}

/* 表格三处对齐设计 `.dt-table`（EXT-02 ③）：12.5px / th 7px 6px + 600 +
   `--line-strong` 表头线 / td 6px 6px */
.trial-card__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
  font-variant-numeric: var(--fb-font-numeric);
}

.trial-card__table th {
  padding: 7px 6px;
  border-bottom: 1px solid var(--fb-line-strong);
  color: var(--fb-sub);
  font-weight: 600;
  text-align: left;
}

.trial-card__table td {
  padding: 6px 6px;
  border-bottom: 1px solid var(--fb-line);
  color: var(--fb-ink);
}

/* 合计行（EXT-02 ④）：设计 `.dt-table tfoot td`
   —— 2px `--line-strong` 上边线、无下边线、700、`--ink-deep`、padding-top 8px */
.trial-card__table tfoot td {
  padding-top: 8px;
  border-top: 2px solid var(--fb-line-strong);
  border-bottom: none;
  color: var(--fb-ink-deep);
  font-weight: 700;
}

/* 合计非 0（未配平）时用危险正文墨：0.00 是「结论」，差额是「问题」 */
.trial-card__table tfoot .trial-card__sum--diff {
  color: var(--fb-danger-ink);
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

@media (max-width: 768px) {
  .trial-card {
    padding: 14px;
  }
}
</style>
