<script setup lang="ts">
/**
 * 分录预览卡（复式 · 按币种配平 · bean 片段折叠预览）
 *
 * 纯展示组件：账户名取真实 ASCII 导出名（PostingView.name），中文 display_name
 * 作主文案；金额走 core/Money 的 formatAmount（UI 可千分位），bean 片段由
 * core/bean 生成且禁止千分位。借贷徽标沿用产品决策，Beancount 无借贷字段。
 */
import { computed } from 'vue'

import { formatAmount } from '@/core/Money'
import type { BalanceGroup, PostingView } from '@/core/record'

const props = withDefaults(
  defineProps<{
    postings: PostingView[]
    groups: BalanceGroup[]
    bean: string
    /** 高级态：不再展示「进入高级模式」入口（主操作唯一）。 */
    advanced?: boolean
  }>(),
  { advanced: false },
)

const emit = defineEmits<{
  (event: 'advanced'): void
}>()

/** 全部币种均按 sum=0 且行数>=2 才算配平。 */
const balanced = computed(() => {
  if (props.groups.length === 0) {
    return false
  }
  return props.groups.every((group) => group.balanced)
})

/** 展示金额：千分位 + 两位小数（与 core/Money 展示口径一致）。 */
function signed(value: string): string {
  return formatAmount(value)
}

/** 分录行的正负样式（0 视为正数侧，颜色不抢主操作）。 */
function amountClass(amount: string): string {
  return amount.charAt(0) === '-' ? 'neg' : 'pos'
}

/** bean-check 提示文案：按币种给出差额。 */
function chipNote(group: BalanceGroup): string {
  return group.balanced
    ? '✓ 按币种配平（sum = 0）'
    : `✕ 差额 ${signed(group.sum)}，bean-check 会拒绝`
}
</script>

<template>
  <section class="grp">
    <div class="g-head">
      <span class="g-title"><i class="g-dot"></i>分录预览 · 复式</span>
      <span class="g-side js-bal-tag" :class="balanced ? 'ok' : 'bad'">
        {{ balanced ? '✓ 已配平' : '✕ 未配平' }}
      </span>
    </div>

    <div class="js-preview">
      <div v-for="(posting, index) in postings" :key="index" class="posting">
        <span
          class="p-sign"
          :class="posting.isDebit ? 'debit' : 'credit'"
          :aria-label="posting.isDebit ? '借方' : '贷方'"
        >{{ posting.isDebit ? '借' : '贷' }}</span>
        <span class="p-main">
          <b>{{ posting.label === '' ? '待选账户' : posting.label }}</b>
          <small>{{ posting.name === '' ? '—' : posting.name }}</small>
        </span>
        <span class="p-amt" :class="amountClass(posting.amount)">
          {{ signed(posting.amount) }}<em>{{ posting.commodity }}</em>
        </span>
      </div>

      <div class="bal-bar js-bal">
        <div
          v-for="group in groups"
          :key="group.commodity"
          class="bal-chip"
          :class="{ bad: !group.balanced }"
        >
          <b>{{ group.commodity }}</b> · {{ group.rows }} 条分录 · 合计 <b>{{ signed(group.sum) }}</b>
          <small>{{ chipNote(group) }}</small>
        </div>
      </div>

      <details class="bean">
        <summary>查看导出 .beancount 片段（对照 bean-check）</summary>
        <pre class="js-bean">{{ bean }}</pre>
      </details>

      <p class="bean-note">
        账户名必须是 <code>Assets/Liabilities/Equity/Income/Expenses</code> 开头的 ASCII 冒号层级；
        每条 posting 为 <code>账户 金额 币种</code>，同币种金额之和必须为 0。
        「借 / 贷」沿用既有认知标注，Beancount 本身没有借贷字段，判定一律以带符号金额与 sum = 0 为准。
      </p>
    </div>

    <button
      v-if="!advanced"
      type="button"
      class="adv-entry"
      data-act="advanced"
      @click="emit('advanced')"
    >
      高级模式 · 逐条编辑双录分录 <span>›</span>
    </button>
  </section>
</template>

<style scoped>
.grp {
  margin-bottom: 12px;
  padding: 14px 12px 12px;
  background-color: var(--fb-card);
  background-image: repeating-linear-gradient(0deg, var(--fb-paper-edge) 0 1px, transparent 1px 4px);
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-card);
  box-shadow: var(--fb-shadow-card);
}

.g-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--fb-line);
}

.g-title {
  font-size: 13px;
  font-weight: 800;
  line-height: 1.4;
  color: var(--fb-ink-deep);
}

.g-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 7px;
  border: 2px solid var(--fb-seal);
  border-radius: 2px;
  vertical-align: 0;
}

.g-side {
  font-size: 11px;
  color: var(--fb-sub);
}

.g-side.ok,
.js-bal-tag.ok {
  color: var(--fb-green);
  font-weight: 700;
}

.g-side.bad,
.js-bal-tag.bad {
  color: var(--fb-danger);
  font-weight: 700;
}

.posting {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  min-height: 48px;
  padding: 7px 0;
  border-bottom: 1px dotted var(--fb-line);
}

.posting:last-of-type {
  border-bottom: none;
}

.p-sign {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  border-radius: 5px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 800;
}

.p-sign.debit {
  background: var(--fb-brand-soft);
  color: var(--fb-brand);
  border: 1px solid var(--fb-brand-line);
}

.p-sign.credit {
  background: var(--fb-soft);
  color: var(--fb-sub);
  border: 1px solid var(--fb-line);
}

.p-main {
  flex: 1;
  min-width: 0;
}

.p-main b {
  display: block;
  font-size: 12.5px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.p-main small {
  display: block;
  margin-top: 2px;
  font-family: var(--fb-font-mono);
  font-size: 10.5px;
  color: var(--fb-sub);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.p-amt {
  flex: 0 0 auto;
  text-align: right;
  font-size: 12px;
  font-weight: 700;
  font-variant-numeric: var(--fb-font-numeric);
  font-family: var(--fb-font-mono);
  white-space: nowrap;
}

.p-amt.neg {
  color: var(--fb-danger);
}

.p-amt.pos {
  color: var(--fb-green);
}

.p-amt em {
  display: block;
  font-size: 9.5px;
  font-style: normal;
  color: var(--fb-sub);
  font-weight: 400;
  letter-spacing: 1px;
}

/* 用 grid gap 而非 flex gap，降低 Safari 14.1 风险（compat §8.3.3）。 */
.bal-bar {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  margin-top: 10px;
}

.bal-chip {
  min-width: 0;
  padding: 8px 9px;
  border: 1px solid var(--fb-brand-line);
  border-radius: 8px;
  background: var(--fb-green-soft);
  font-size: 11px;
  line-height: 1.5;
  color: var(--fb-ink);
}

.bal-chip.bad {
  border-color: var(--fb-danger-soft);
  background: var(--fb-danger-soft);
  color: var(--fb-danger-ink);
}

.bal-chip b {
  font-family: var(--fb-font-mono);
  font-variant-numeric: var(--fb-font-numeric);
}

.bal-chip small {
  display: block;
  color: var(--fb-sub);
  font-size: 10.5px;
}

.bal-chip.bad small {
  color: var(--fb-danger);
}

.bean {
  margin-top: 10px;
  border: 1px solid var(--fb-line);
  border-radius: 8px;
  background: var(--fb-paper);
  overflow: hidden;
}

.bean summary {
  min-height: 44px;
  display: flex;
  align-items: center;
  padding: 0 11px;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--fb-brand);
  cursor: pointer;
  list-style: none;
}

.bean summary::-webkit-details-marker {
  display: none;
}

.bean summary::before {
  content: '▸';
  margin-right: 7px;
  font-size: 12px;
}

.bean[open] summary::before {
  content: '▾';
}

.bean pre {
  margin: 0;
  padding: 9px 11px 11px;
  border-top: 1px dashed var(--fb-line);
  font-family: var(--fb-font-mono);
  font-size: 10.5px;
  line-height: 1.75;
  color: var(--fb-ink-deep);
  overflow-x: auto;
  white-space: pre;
}

.bean-note {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--fb-sub);
}

.adv-entry {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 44px;
  margin-top: 8px;
  padding: 0 4px;
  border: none;
  background: transparent;
  color: var(--fb-brand);
  font-size: 11.5px;
  text-align: left;
  cursor: pointer;
}

.adv-entry span {
  font-size: 16px;
  line-height: 1;
}
</style>
