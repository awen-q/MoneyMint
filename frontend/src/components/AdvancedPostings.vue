<script setup lang="ts">
/**
 * 高级双录：逐行账户 / 金额 / 币种 + 增删 + auto-balance + 配平检查卡。
 *
 * 受控组件：唯一数据源是 props.rows，任何改动都先改本地副本再 emit('update:rows')
 * 交回 RecordSheet 写回 form.advancedPostings（草稿与提交共用同一份数据）。
 * 补行账户留空 → canSubmit=false，用户必须选择账户后才能保存（稿内口径）。
 */
import { computed, ref, watch } from 'vue'

import type { AccountView } from '@/api/types'
import { formatAmount, Money } from '@/core/Money'
import {
  accountLabel,
  advancedRowsReady,
  balanceDiffByCommodity,
  balanceGroups,
  resolveAccountCommodity,
  type AdvancedRow,
  type BalanceGroup,
  type PostingView,
  type SummaryAccount,
} from '@/core/record'
import PostingPreview from './PostingPreview.vue'

const props = withDefaults(
  defineProps<{
    rows: AdvancedRow[]
    accounts: AccountView[]
    commodities: string[]
    bean: string
    /** 编辑态冲正提示（固定文案，不出现「已保存在本机」）。 */
    editing?: boolean
  }>(),
  { editing: false },
)

const emit = defineEmits<{
  (event: 'update:rows', rows: AdvancedRow[]): void
  (event: 'back'): void
}>()

/** 本地副本：只在用户操作时变更，随后 emit 交回父组件（props 保持只读）。 */
const localRows = ref<AdvancedRow[]>(cloneRows(props.rows))

watch(
  () => props.rows,
  (next) => {
    localRows.value = cloneRows(next)
  },
)

function cloneRows(rows: ReadonlyArray<AdvancedRow>): AdvancedRow[] {
  return rows.map((row) => ({
    accountId: row.accountId,
    amount: row.amount,
    commodity: row.commodity === undefined || row.commodity === '' ? '' : row.commodity,
  }))
}

function fallbackCommodity(): string {
  return props.commodities.length > 0 ? props.commodities[0] : 'CNY'
}

/** 账户 id → 币种；账户未选或无限定时退回币种列表首项。 */
function commodityOf(id: number | null): string {
  if (id === null) {
    return fallbackCommodity()
  }
  const account = props.accounts.find((item) => item.id === id)
  return account === undefined ? fallbackCommodity() : resolveAccountCommodity(account, fallbackCommodity())
}

/** 提交回父组件：始终给一份新数组，便于 watch 精确触发草稿写入。 */
function commit(): void {
  emit('update:rows', cloneRows(localRows.value))
}

/** 供配平计算的分录形状（金额非法时按 0，提交前由 canSubmit 拦截）。 */
const postingAmounts = computed(() =>
  localRows.value.map((row) => ({
    commodity: row.commodity === '' ? fallbackCommodity() : row.commodity,
    amount: row.amount,
  })),
)

const groups = computed<BalanceGroup[]>(() => balanceGroups(postingAmounts.value))

/** 全部币种配平 + 至少 2 行 + 每行账户已选且金额非 0（与 RecordSheet 共用 core 守门）。 */
const canSubmit = computed(() => advancedRowsReady(localRows.value, fallbackCommodity()))

/** 分录预览视图（真实导出名 + 展示名 + 借贷徽标）。 */
const postingViews = computed<PostingView[]>(() =>
  localRows.value.map((row) => {
    const account = props.accounts.find((item) => item.id === row.accountId)
    let value = Money.zero()
    try {
      value = Money.from(row.amount)
    } catch {
      // 非法金额展示为 0.00，canSubmit 会拦截提交。
    }
    const placeholder: SummaryAccount = { id: -1, name: '', type: '' }
    return {
      account: account === undefined ? placeholder : account,
      name: account === undefined ? '' : account.name,
      label: account === undefined ? '' : accountLabel(account),
      amount: value.toString(),
      commodity: row.commodity === '' ? fallbackCommodity() : row.commodity,
      isDebit: !value.isNegative(),
    }
  }),
)

function fmt(value: string): string {
  return formatAmount(value)
}

function onAccountChange(index: number, event: Event): void {
  const row = localRows.value[index]
  if (row === undefined) {
    return
  }
  const raw = (event.target as HTMLSelectElement).value
  const id = raw === '' || !/^\d+$/.test(raw) ? null : Number(raw)
  row.accountId = id === null || !Number.isSafeInteger(id) || id <= 0 ? null : id
  row.commodity = commodityOf(row.accountId)
  commit()
}

function onAmountChange(index: number, event: Event): void {
  const row = localRows.value[index]
  if (row === undefined) {
    return
  }
  row.amount = (event.target as HTMLInputElement).value
  commit()
}

function onCommodityChange(index: number, event: Event): void {
  const row = localRows.value[index]
  if (row === undefined) {
    return
  }
  row.commodity = (event.target as HTMLSelectElement).value
  commit()
}

/** 添加一行：账户留空、金额 0.00（稿内口径），canSubmit 随即变 false。 */
function addRow(): void {
  localRows.value.push({
    accountId: null,
    amount: '0.00',
    commodity: fallbackCommodity(),
  })
  commit()
}

function removeRow(index: number): void {
  if (localRows.value.length <= 2) {
    return
  }
  localRows.value.splice(index, 1)
  commit()
}

/**
 * 按差额补一行（auto-balance）：取第一个不平币种，补 -diff；账户留空，
 * 用户必须选择账户后才能保存。差额为 0 时不做任何事。
 */
function autoBalance(): void {
  const diffs = balanceDiffByCommodity(postingAmounts.value)
  if (diffs.length === 0) {
    return
  }
  const first = diffs[0]
  localRows.value.push({
    accountId: null,
    amount: Money.from(first.diff).negated().toString(),
    commodity: first.commodity,
  })
  commit()
}

function backToSimple(): void {
  emit('back')
}

defineExpose({ canSubmit, addRow, removeRow, autoBalance })
</script>

<template>
  <section class="grp">
    <div class="g-head">
      <span class="g-title"><i class="g-dot"></i>双录分录</span>
      <!-- 编辑态隐藏「返回简化模式」：带类型 Tab 的简化编辑器会把类型暗示带回编辑态。 -->
      <button v-if="!editing" type="button" class="g-link" data-act="back-simple" @click="backToSimple">
        ‹ 返回简化模式
      </button>
    </div>
    <p class="g-note">每行一个账户 · 按币种合计必须为 0 · 至少 2 行 · 账户名取真实导出名</p>

    <div class="js-advrows">
      <div v-for="(row, index) in localRows" :key="index" class="adv-row rs-adv-row" :data-row="index">
        <select
          :value="row.accountId === null ? '' : String(row.accountId)"
          :aria-label="`第 ${index + 1} 行账户`"
          data-rf="acc"
          @change="onAccountChange(index, $event)"
        >
          <option value="">选择账户…</option>
          <option v-for="account in accounts" :key="account.id" :value="String(account.id)">
            {{ accountLabel(account) }} · {{ account.name }}
          </option>
        </select>
        <input
          type="text"
          inputmode="decimal"
          :value="row.amount"
          :aria-label="`第 ${index + 1} 行金额`"
          data-rf="amt"
          placeholder="0.00"
          @input="onAmountChange(index, $event)"
          @change="onAmountChange(index, $event)"
        />
        <select
          class="row-cur"
          :value="row.commodity"
          :aria-label="`第 ${index + 1} 行币种`"
          data-rf="cur"
          @change="onCommodityChange(index, $event)"
        >
          <option v-for="code in commodities" :key="code" :value="code">{{ code }}</option>
        </select>
        <button
          type="button"
          class="adv-remove"
          :aria-label="`删除第 ${index + 1} 行`"
          data-act="remove-row"
          :data-row="index"
          @click="removeRow(index)"
        >✕</button>
      </div>
    </div>

    <button type="button" class="add-row" data-act="add-row" @click="addRow">＋ 添加分录</button>
    <button type="button" class="auto-row" data-act="auto-balance" @click="autoBalance">
      按差额补一行（账户仍需选择）
    </button>
  </section>

  <section class="grp">
    <div class="g-head">
      <span class="g-title"><i class="g-dot"></i>配平检查</span>
      <span class="g-side js-bal-tag" :class="canSubmit ? 'ok' : 'bad'">
        {{ canSubmit ? '✓ 已平衡' : '✕ 未配平' }}
      </span>
    </div>
    <div class="js-check">
      <template v-for="group in groups" :key="group.commodity">
        <div class="check-line">
          <span>{{ group.commodity }} 借方合计（+）</span><span class="pos">+{{ fmt(group.pos) }}</span>
        </div>
        <div class="check-line">
          <span>{{ group.commodity }} 贷方合计（−）</span><span class="neg">{{ fmt(group.neg) }}</span>
        </div>
        <div class="check-line">
          <span>{{ group.commodity }} 差额</span>
          <span :class="group.sum === '0.00' ? 'zero' : 'neg'">{{ fmt(group.sum) }}</span>
        </div>
      </template>
    </div>
    <PostingPreview
      :postings="postingViews"
      :groups="groups"
      :bean="bean"
      :advanced="true"
    />
  </section>

  <!-- 编辑态：日期 / 标签 / 备注来自原交易；新建态：沿用切换前填写的内容。 -->
  <p v-if="editing" class="adv-note">日期 / 标签 / 备注来自原交易，可直接修改；保存走冲正 + 新建（仅在线）。</p>
  <p v-else class="adv-note">日期 / 标签 / 备注沿用切换前填写的内容；返回简化模式可修改。提交走与简化模式相同的幂等路径。</p>
  <p v-if="editing" class="edit-mini">原交易将被冲正：保存后以新交易为准，仅在线提交。</p>
  <p class="adv-note">多币种时按 <b>commodity 分组</b>各自配平；跨币种 cost / price 注解属 P1，本期不出。</p>
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
}

.g-side {
  font-size: 11px;
  color: var(--fb-sub);
}

.g-side.ok {
  color: var(--fb-green);
  font-weight: 700;
}

.g-side.bad {
  color: var(--fb-danger);
  font-weight: 700;
}

.g-link {
  min-height: 44px;
  padding: 0 4px;
  border: none;
  background: transparent;
  color: var(--fb-brand);
  font-size: 11.5px;
  cursor: pointer;
}

.g-note {
  margin: -4px 0 10px;
  font-size: 11.5px;
  color: var(--fb-sub);
  line-height: 1.6;
}

.adv-row {
  display: grid;
  grid-template-columns: 1fr 92px 62px 44px;
  gap: 6px;
  align-items: center;
  margin-top: 8px;
}

.adv-row select,
.adv-row input {
  min-height: 44px;
  width: 100%;
  padding: 0 7px;
  border: 1.5px solid var(--fb-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-card);
  color: var(--fb-ink);
  font-size: 11.5px;
}

.adv-row input {
  text-align: right;
  font-family: var(--fb-font-mono);
  font-variant-numeric: var(--fb-font-numeric);
}

.adv-row .row-cur {
  min-width: 0;
  font-family: var(--fb-font-mono);
  font-size: 11px;
}

.adv-remove {
  min-width: 44px;
  min-height: 44px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-card);
  color: var(--fb-danger);
  font-size: 12px;
  cursor: pointer;
}

.add-row,
.auto-row {
  width: 100%;
  min-height: 44px;
  margin-top: 8px;
  border: 1px dashed var(--fb-line-strong);
  border-radius: var(--fb-radius-input);
  background: var(--fb-card);
  color: var(--fb-brand);
  font-size: 11.5px;
  cursor: pointer;
}

.auto-row {
  border-style: solid;
  background: var(--fb-soft);
  color: var(--fb-warn-ink);
}

.check-line {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px dotted var(--fb-line);
  font-size: 11.5px;
}

.check-line:last-child {
  border-bottom: none;
}

.check-line span:last-child {
  font-family: var(--fb-font-mono);
  font-variant-numeric: var(--fb-font-numeric);
  font-weight: 700;
}

.check-line .pos {
  color: var(--fb-green);
}

.check-line .neg {
  color: var(--fb-danger);
}

.check-line .zero {
  color: var(--fb-brand);
}

.adv-note {
  margin: 8px 2px 4px;
  font-size: 11px;
  line-height: 1.75;
  color: var(--fb-sub);
}

.edit-mini {
  margin: 8px 2px 4px;
  padding: 8px 10px;
  border-left: 3px solid var(--fb-warn);
  border-radius: var(--fb-radius-input);
  background: var(--fb-warn-soft);
  color: var(--fb-warn-ink);
  font-size: 11px;
  line-height: 1.6;
}

@media (max-width: 380px) {
  .adv-row {
    grid-template-columns: 1fr 78px 56px 40px;
    gap: 4px;
  }
}
</style>
