<script setup lang="ts">
/**
 * 高级双录：逐行账户 / 金额 / 币种 + 增删 + auto-balance + 配平检查卡。
 *
 * 受控组件：唯一数据源是 props.rows，任何改动都先改本地副本再 emit('update:rows')
 * 交回 RecordSheet 写回 form.advancedPostings（草稿与提交共用同一份数据）。
 * 补行账户留空 → canSubmit=false，用户必须选择账户后才能保存（稿内口径）。
 *
 * v2.1（规格 §12）：
 * - 行金额独立四则表达式（§5-E 顺序求值 / 2 位定点 / 除零行内报错）；
 * - 行账户 / 币种 chip 打开浮层（移动底部弹层 / PC Teleport 锚定下拉）；
 * - 行级三态校验红边、差额按币种带 + 号直出。
 * 结构上 AdvancedRow / 提交载荷 / core 守门零改动。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import type { AccountView } from '@/api/types'
import { formatAmount, Money } from '@/core/Money'
import {
  accountLabel,
  advancedRowsReady,
  amountDirection,
  balanceDiffByCommodity,
  balanceGroups,
  evaluateAmountExpression,
  magnitudeOf,
  resolveAccountCommodity,
  signAmount,
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
    /** 高级行内键盘当前焦点行；-1 表示无焦点。 */
    activeRow?: number
    /** 高级行内键盘是否展开（仅移动端会置 true）。 */
    keypadActive?: boolean
  }>(),
  { editing: false, activeRow: -1, keypadActive: false },
)

const emit = defineEmits<{
  (event: 'update:rows', rows: AdvancedRow[]): void
  (event: 'back'): void
  /** 点行内金额框：交给父组件展开自定义键盘（不唤起系统键盘）。 */
  (event: 'focus-amount', index: number, el: HTMLInputElement): void
  /** 焦点行消失（删除 / 返回简化）时请父组件收起键盘。 */
  (event: 'keypad-done'): void
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
    // 边界归一化：旧草稿 / 异常后端数据可能带来非 string，统一成合法定点串形状。
    amount: typeof row.amount === 'string' ? row.amount : '',
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

function accountOf(id: number | null): AccountView | undefined {
  if (id === null) {
    return undefined
  }
  return props.accounts.find((item) => item.id === id)
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
    const account = accountOf(row.accountId)
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

/** 差额展示：正数直接带 +（规格 §12-6，示例 +12.00）。 */
function signedFmt(value: string): string {
  let negative = false
  try {
    negative = Money.from(value).isNegative()
  } catch {
    negative = false
  }
  return negative ? fmt(value) : `+${fmt(value)}`
}

// ─────────── 行级表达式（§5-E / §12-2）：每行独立状态，结果只写回该行 ───────────

/** 内部运算符统一半角 + - * /（键面显示 × ÷ − +）。 */
const ROW_OPERATOR_KEYS: Record<string, string> = {
  '×': '*',
  '÷': '/',
  '−': '-',
  '+': '+',
}

const rowExpressions = ref<Record<number, string>>({})
const rowAfterEquals = ref<Record<number, boolean>>({})
const rowEvalErrors = ref<Record<number, string>>({})

function isRowOperator(char: string): boolean {
  return char === '+' || char === '-' || char === '*' || char === '/'
}

function currentSegment(expr: string): string {
  let start = 0
  for (let i = expr.length - 1; i >= 0; i -= 1) {
    if (isRowOperator(expr.charAt(i))) {
      start = i + 1
      break
    }
  }
  return expr.slice(start)
}

function markRowEditing(index: number): void {
  rowAfterEquals.value[index] = false
  rowEvalErrors.value[index] = ''
}

/** 表达式小字：展示态把半角运算符换成键面文案，`=` 后追加求值箭头与结果。 */
function expressionOf(index: number): string {
  const expr = rowExpressions.value[index] ?? ''
  if (expr === '') {
    return ''
  }
  const pretty = expr
    .replace(/\*/g, ' × ')
    .replace(/\//g, ' ÷ ')
    .replace(/\+/g, ' + ')
    .replace(/-/g, ' − ')
    .replace(/\s+/g, ' ')
    .trim()
  if (rowAfterEquals.value[index] === true) {
    const row = localRows.value[index]
    return `${pretty} → ${row === undefined ? '' : magnitudeOf(row.amount)}`
  }
  return pretty
}

/** `=`：逐行调用 core 的定点求值；失败只写行内错误，绝不落值（保存守门随后拦截）。 */
function evaluateRow(index: number): void {
  const row = localRows.value[index]
  if (row === undefined) {
    return
  }
  const expr = (rowExpressions.value[index] ?? '').trim()
  if (expr === '' || rowAfterEquals.value[index] === true) {
    return
  }
  try {
    const result = evaluateAmountExpression(expr)
    row.amount = signAmount(amountDirection(row.amount), result.toString())
    rowAfterEquals.value[index] = true
    rowEvalErrors.value[index] = ''
    commit()
  } catch (err) {
    // 除零等错误：保留上一次成功落值，只显示该行错误。
    rowEvalErrors.value[index] = err instanceof Error ? err.message : '金额表达式不正确'
  }
}

/** 由父组件（行内键盘）转发按键到当前焦点行。 */
function pressActiveKey(key: string): void {
  const index = props.activeRow
  if (index < 0 || index >= localRows.value.length) {
    return
  }
  if (key === '=') {
    evaluateRow(index)
    return
  }
  if (key === '⌫') {
    markRowEditing(index)
    rowExpressions.value[index] = (rowExpressions.value[index] ?? '').slice(0, -1)
    return
  }
  const operator = ROW_OPERATOR_KEYS[key]
  if (operator !== undefined) {
    let expr = rowExpressions.value[index] ?? ''
    if (expr === '') {
      return
    }
    markRowEditing(index)
    if (isRowOperator(expr.slice(-1))) {
      expr = expr.slice(0, -1) + operator
    } else {
      expr += operator
    }
    rowExpressions.value[index] = expr
    return
  }
  let expr = rowAfterEquals.value[index] === true ? '' : (rowExpressions.value[index] ?? '')
  markRowEditing(index)
  const segment = currentSegment(expr)
  if (key === '.') {
    if (segment.indexOf('.') >= 0) {
      rowExpressions.value[index] = expr
      return
    }
    rowExpressions.value[index] = expr + (segment === '' ? '0.' : '.')
    return
  }
  if (/^[0-9]$/.test(key)) {
    const dot = segment.indexOf('.')
    if (dot >= 0 && segment.length - dot - 1 >= 2) {
      rowExpressions.value[index] = expr
      return
    }
    rowExpressions.value[index] = expr + key
  }
}

/** 重排后把逐行表达式状态同步到新下标，避免错行串值。 */
function reindexExpressionState(): void {
  const expressions = localRows.value.map((_, index) => rowExpressions.value[index] ?? '')
  const afterEquals = localRows.value.map((_, index) => rowAfterEquals.value[index] === true)
  const errors = localRows.value.map((_, index) => rowEvalErrors.value[index] ?? '')
  rowExpressions.value = {}
  rowAfterEquals.value = {}
  rowEvalErrors.value = {}
  expressions.forEach((value, index) => { rowExpressions.value[index] = value })
  afterEquals.forEach((value, index) => { rowAfterEquals.value[index] = value })
  errors.forEach((value, index) => { rowEvalErrors.value[index] = value })
}

// ─────────── 行账户 / 币种浮层（§12-3 / §12-4）：移动底部弹层 / PC 锚定下拉 ───────────

type RowPopoverKind = 'acc' | 'cur'
interface RowPopoverState {
  kind: RowPopoverKind
  row: number
}

const rowPopover = ref<RowPopoverState | null>(null)
const rowPopoverSearch = ref('')
const rowPopoverStyle = ref<Record<string, string>>({})
let popoverAnchor: HTMLElement | null = null

/**
 * 移动端高级行金额框恒 readonly：焦点事件先于 click 到达，若等 keypadActive 置位
 * 再设 readonly，iOS 会先弹系统键盘。PC 保持可编辑（§12-1 物理键盘直输）。
 */
const isPcViewport = ref(typeof window === 'undefined' || window.innerWidth >= 900)

const ACCOUNT_GROUPS: Array<{ type: string; label: string }> = [
  { type: 'Assets', label: 'ASSETS · 资产' },
  { type: 'Liabilities', label: 'LIABILITIES · 负债' },
  { type: 'Income', label: 'INCOME · 收入' },
  { type: 'Expenses', label: 'EXPENSES · 支出' },
  { type: 'Equity', label: 'EQUITY · 权益' },
]

/** 全部账户五类分组（与仅资金账户的简化态浮层明确区分）+ 顶部搜索。 */
const accountGroups = computed(() => {
  const keyword = rowPopoverSearch.value.trim().toLowerCase()
  return ACCOUNT_GROUPS.map((group) => ({
    type: group.type,
    label: group.label,
    accounts: props.accounts.filter((account) => {
      if (String(account.type) !== group.type) {
        return false
      }
      if (keyword === '') {
        return true
      }
      return (
        accountLabel(account).toLowerCase().indexOf(keyword) >= 0 ||
        account.name.toLowerCase().indexOf(keyword) >= 0
      )
    }),
  })).filter((group) => group.accounts.length > 0)
})

const currencyOptions = computed<string[]>(() =>
  props.commodities.length > 0 ? props.commodities.slice() : [fallbackCommodity()],
)

/** 锚点取 getBoundingClientRect，右 / 下溢出翻转（teleport 到 body 不受弹窗 overflow 裁剪）。 */
function setRowPopoverAnchor(element: HTMLElement, kind: RowPopoverKind): void {
  if (typeof window === 'undefined' || typeof element.getBoundingClientRect !== 'function') {
    rowPopoverStyle.value = { '--pop-left': '12px', '--pop-top': '120px', '--pop-width': '250px' }
    return
  }
  const rect = element.getBoundingClientRect()
  const width = Math.max(250, Math.round(rect.width))
  const viewportWidth = window.innerWidth > 0 ? window.innerWidth : width + 24
  const viewportHeight = window.innerHeight > 0 ? window.innerHeight : 768
  const left = rect.left + width + 12 <= viewportWidth
    ? Math.round(rect.left)
    : Math.max(12, Math.round(rect.right - width))
  const estimatedHeight = kind === 'acc' ? 420 : 220
  const top = rect.bottom + estimatedHeight + 12 <= viewportHeight
    ? Math.round(rect.bottom + 6)
    : Math.max(12, Math.round(rect.top - estimatedHeight - 6))
  rowPopoverStyle.value = {
    '--pop-left': `${left}px`,
    '--pop-top': `${top}px`,
    '--pop-width': `${width}px`,
  }
}

function openRowPopover(kind: RowPopoverKind, row: number, event: Event): void {
  const element = event.currentTarget as HTMLElement | null
  popoverAnchor = element
  if (element !== null) {
    setRowPopoverAnchor(element, kind)
  }
  rowPopoverSearch.value = ''
  rowPopover.value = { kind, row }
}

function closeRowPopover(): void {
  rowPopover.value = null
  popoverAnchor = null
}

function onViewportChange(): void {
  if (typeof window !== 'undefined') {
    isPcViewport.value = window.innerWidth >= 900
  }
  const state = rowPopover.value
  if (state !== null && popoverAnchor !== null) {
    setRowPopoverAnchor(popoverAnchor, state.kind)
  }
}

function onDocumentClick(event: MouseEvent): void {
  if (rowPopover.value === null) {
    return
  }
  const target = event.target as HTMLElement | null
  if (target === null || typeof target.closest !== 'function') {
    return
  }
  const insidePopover = target.closest('.adv-popover') !== null
  const insideTrigger = target.closest('[data-popover-trigger]') !== null
  if (!insidePopover && !insideTrigger) {
    closeRowPopover()
  }
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && rowPopover.value !== null) {
    closeRowPopover()
  }
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick)
  document.addEventListener('keydown', onDocumentKeydown)
  window.addEventListener('scroll', onViewportChange, true)
  window.addEventListener('resize', onViewportChange)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick)
  document.removeEventListener('keydown', onDocumentKeydown)
  window.removeEventListener('scroll', onViewportChange, true)
  window.removeEventListener('resize', onViewportChange)
})

function selectRowAccount(id: number): void {
  const state = rowPopover.value
  if (state === null) {
    return
  }
  const row = localRows.value[state.row]
  if (row !== undefined) {
    row.accountId = id
    row.commodity = commodityOf(id)
    commit()
  }
  closeRowPopover()
}

function selectRowCurrency(code: string): void {
  const state = rowPopover.value
  if (state === null) {
    return
  }
  const row = localRows.value[state.row]
  if (row !== undefined) {
    row.commodity = code
    commit()
  }
  closeRowPopover()
}

function popoverSelectedAccount(): number | null {
  const state = rowPopover.value
  if (state === null) {
    return null
  }
  const row = localRows.value[state.row]
  return row === undefined ? null : row.accountId
}

function popoverSelectedCommodity(): string {
  const state = rowPopover.value
  if (state === null) {
    return ''
  }
  const row = localRows.value[state.row]
  return row === undefined ? '' : (row.commodity === '' ? fallbackCommodity() : row.commodity)
}

// ─────────── 行操作与校验 ───────────

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
  const target = event.target as HTMLInputElement
  const raw = typeof target.value === 'string' ? target.value : ''
  // 兼容粘贴/测试里的带符号输入：显式负号优先决定方向；否则沿用当前方向。
  // 金额框只负责幅值，符号由方向赋予，故必须先剥掉输入里的 +/-。
  const dir = raw.trim().startsWith('-') ? 'credit' : amountDirection(row.amount)
  row.amount = signAmount(dir, raw)
  // 物理键盘直输（PC 口径）时同步表达式小字，保证后续键盘续算不串值。
  rowExpressions.value[index] = magnitudeOf(row.amount)
  rowAfterEquals.value[index] = false
  rowEvalErrors.value[index] = ''
  commit()
}

/** 点行内金额框：不唤起系统键盘，交给父组件开自定义键盘（PC 父组件会忽略）。 */
function onAmountFocus(index: number, event: Event): void {
  const element = event.currentTarget as HTMLInputElement | null
  if (element !== null) {
    emit('focus-amount', index, element)
  }
}

/** 借贷 Toggle：保留幅值，按所选方向重新赋号。 */
function onDirectionChange(index: number, dir: 'debit' | 'credit'): void {
  const row = localRows.value[index]
  if (row === undefined) {
    return
  }
  row.amount = signAmount(dir, magnitudeOf(row.amount))
  commit()
}

/** ＋/− 翻转：等价快捷切换借贷方向。 */
function onFlipDirection(index: number): void {
  const row = localRows.value[index]
  if (row === undefined) {
    return
  }
  onDirectionChange(index, amountDirection(row.amount) === 'debit' ? 'credit' : 'debit')
}

function onCommodityChange(index: number, event: Event): void {
  const row = localRows.value[index]
  if (row === undefined) {
    return
  }
  row.commodity = (event.target as HTMLSelectElement).value
  commit()
}

function isLegalAmount(value: string): boolean {
  if (typeof value !== 'string' || value.trim() === '') {
    return false
  }
  try {
    Money.from(value)
    return true
  } catch {
    return false
  }
}

/** 行级三态：账户未选 / 金额空或非法 → 红边（挂行容器）。 */
function rowInvalid(index: number): boolean {
  const row = localRows.value[index]
  return row === undefined || row.accountId === null || !isLegalAmount(row.amount)
}

function rowFocused(index: number): boolean {
  return props.keypadActive && props.activeRow === index
}

/** 添加一行：账户留空、金额空串（§12-5 拍板项）、币种 CNY，canSubmit 随即变 false。 */
function addRow(): void {
  const index = localRows.value.length
  localRows.value.push({
    accountId: null,
    amount: '',
    commodity: fallbackCommodity(),
  })
  rowExpressions.value[index] = ''
  rowAfterEquals.value[index] = false
  rowEvalErrors.value[index] = ''
  commit()
}

function removeRow(index: number): void {
  if (localRows.value.length <= 2) {
    return
  }
  localRows.value.splice(index, 1)
  reindexExpressionState()
  if (props.activeRow === index) {
    emit('keypad-done')
  }
  closeRowPopover()
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
  const index = localRows.value.length
  localRows.value.push({
    accountId: null,
    amount: Money.from(first.diff).negated().toString(),
    commodity: first.commodity,
  })
  rowExpressions.value[index] = ''
  rowAfterEquals.value[index] = false
  rowEvalErrors.value[index] = ''
  commit()
}

function backToSimple(): void {
  emit('keypad-done')
  emit('back')
}

defineExpose({ canSubmit, addRow, removeRow, autoBalance, pressActiveKey })
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
      <div
        v-for="(row, index) in localRows"
        :key="index"
        class="adv-row rs-adv-row"
        :class="{ 'rs-adv-row--focus': rowFocused(index), 'rs-adv-row--invalid': rowInvalid(index) }"
        :data-row="index"
      >
        <div class="row-top">
          <!-- 契约控件：保留真实 select 锚点，浮层 chip 同时挂 data-rf="acc"（data-role 区分）。 -->
          <select
            class="acc-contract"
            :value="row.accountId === null ? '' : String(row.accountId)"
            :aria-label="`第 ${index + 1} 行账户（契约控件）`"
            data-rf="acc"
            data-role="input"
            @change="onAccountChange(index, $event)"
          >
            <option value="">选择账户…</option>
            <option v-for="account in accounts" :key="account.id" :value="String(account.id)">
              {{ accountLabel(account) }} · {{ account.name }}
            </option>
          </select>
          <button
            type="button"
            class="acc-chip"
            :aria-label="`第 ${index + 1} 行账户，打开账户选择`"
            data-rf="acc"
            data-role="chip"
            data-popover-trigger="acc"
            :data-row="index"
            @click="openRowPopover('acc', index, $event)"
          >
            <span class="acc-chip__main">{{ row.accountId === null ? '选择账户…' : accountLabel(accountOf(row.accountId) ?? { name: '' }) }}</span>
            <code class="acc-chip__mono">{{ row.accountId === null ? '' : (accountOf(row.accountId)?.name ?? '') }}</code>
            <span class="chip-caret">▾</span>
          </button>
          <button
            type="button"
            class="adv-remove"
            :aria-label="`删除第 ${index + 1} 行`"
            data-act="remove-row"
            :data-row="index"
            @click="removeRow(index)"
          >✕</button>
        </div>
        <div class="row-bottom">
          <div class="dir-toggle" role="group" :aria-label="`第 ${index + 1} 行借贷方向`">
            <button
              type="button"
              class="seg debit"
              :class="{ on: amountDirection(row.amount) === 'debit' }"
              :aria-pressed="amountDirection(row.amount) === 'debit'"
              data-rf="dir"
              data-dir="debit"
              @click="onDirectionChange(index, 'debit')"
            >借</button>
            <button
              type="button"
              class="seg credit"
              :class="{ on: amountDirection(row.amount) === 'credit' }"
              :aria-pressed="amountDirection(row.amount) === 'credit'"
              data-rf="dir"
              data-dir="credit"
              @click="onDirectionChange(index, 'credit')"
            >贷</button>
          </div>
          <div class="amt-box">
            <span
              class="sign-hint"
              :class="{ neg: amountDirection(row.amount) === 'credit' }"
              data-rf="sign"
              aria-hidden="true"
            >{{ amountDirection(row.amount) === 'debit' ? '+' : '−' }}</span>
            <input
              type="text"
              inputmode="decimal"
              :readonly="!isPcViewport || (keypadActive && activeRow === index)"
              :value="magnitudeOf(row.amount)"
              :aria-label="`第 ${index + 1} 行金额（正数）`"
              data-rf="amt"
              placeholder="0.00"
              @click="onAmountFocus(index, $event)"
              @focus="onAmountFocus(index, $event)"
              @input="onAmountChange(index, $event)"
              @change="onAmountChange(index, $event)"
            />
          </div>
          <button
            type="button"
            class="signflip"
            :aria-label="`翻转第 ${index + 1} 行借贷方向`"
            title="正负翻转（切换借贷方向）"
            data-act="flip"
            :data-row="index"
            @click="onFlipDirection(index)"
          >＋/−</button>
          <select
            class="cur-contract row-cur"
            :value="row.commodity"
            :aria-label="`第 ${index + 1} 行币种（契约控件）`"
            data-rf="cur"
            data-role="input"
            @change="onCommodityChange(index, $event)"
          >
            <option v-for="code in commodities" :key="code" :value="code">{{ code }}</option>
          </select>
          <button
            type="button"
            class="cur-chip"
            :aria-label="`第 ${index + 1} 行币种，打开币种选择`"
            data-rf="cur"
            data-role="chip"
            data-popover-trigger="cur"
            :data-row="index"
            @click="openRowPopover('cur', index, $event)"
          >{{ row.commodity === '' ? fallbackCommodity() : row.commodity }} ▾</button>
        </div>
        <div v-if="expressionOf(index) !== ''" class="row-expr js-adv-expr" :data-row="index">
          {{ expressionOf(index) }}
        </div>
        <div v-if="rowEvalErrors[index]" class="row-error js-adv-eval-error" role="alert" :data-row="index">
          {{ rowEvalErrors[index] }}
        </div>
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
          <span :class="group.sum === '0.00' ? 'zero' : 'neg'">{{ signedFmt(group.sum) }}</span>
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

  <!-- 行浮层：Teleport 到 body 避开 .rs-panel{overflow:hidden} / .rs-body{overflow-y:auto} 裁剪。 -->
  <Teleport to="body">
    <div v-if="rowPopover !== null" class="adv-popover-mask" @click.self="closeRowPopover">
      <div
        class="adv-popover"
        :style="rowPopoverStyle"
        role="dialog"
        :aria-label="rowPopover.kind === 'acc' ? '选择账户（该行）' : '选择币种（该行）'"
        :data-popover="rowPopover.kind"
        :data-row="rowPopover.row"
      >
        <div class="adv-pop-head">
          <b>{{ rowPopover.kind === 'acc' ? `选择账户（第 ${rowPopover.row + 1} 行）` : '选择币种（该行）' }}</b>
          <button type="button" class="adv-pop-close" aria-label="关闭浮层" @click="closeRowPopover">✕</button>
        </div>
        <template v-if="rowPopover.kind === 'acc'">
          <input
            v-model="rowPopoverSearch"
            class="adv-search"
            type="search"
            placeholder="搜索 display_name / name"
            aria-label="搜索账户"
            data-search="adv-acc"
          />
          <div v-for="group in accountGroups" :key="group.type" class="adv-group">
            <div class="adv-group__head">{{ group.label }}</div>
            <button
              v-for="account in group.accounts"
              :key="account.id"
              type="button"
              class="adv-option"
              :class="{ on: popoverSelectedAccount() === account.id }"
              :data-account="account.id"
              @click="selectRowAccount(account.id)"
            >
              <span class="adv-option__icon">{{ account.icon === undefined || account.icon === '' ? '📁' : account.icon }}</span>
              <span class="adv-option__main">{{ accountLabel(account) }}</span>
              <code class="adv-option__mono">{{ account.name }}</code>
              <span v-if="popoverSelectedAccount() === account.id" class="adv-option__check">✓</span>
            </button>
          </div>
        </template>
        <template v-else>
          <button
            v-for="code in currencyOptions"
            :key="code"
            type="button"
            class="adv-option"
            :class="{ on: popoverSelectedCommodity() === code }"
            :data-commodity="code"
            @click="selectRowCurrency(code)"
          >
            <span class="adv-option__icon">¥</span>
            <span class="adv-option__main">{{ code }}</span>
            <span v-if="popoverSelectedCommodity() === code" class="adv-option__check">✓</span>
          </button>
        </template>
      </div>
    </div>
  </Teleport>
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
  appearance: none;
  -webkit-appearance: none;
  line-height: 1.2;
}

.g-note {
  margin: -4px 0 10px;
  font-size: 11.5px;
  color: var(--fb-sub);
  line-height: 1.6;
}

.adv-row {
  position: relative;
  margin-top: 8px;
  padding: 9px;
  border: 1px solid var(--fb-line);
  border-radius: 12px;
  background: var(--fb-card);
}

/* 行级三态：焦点行 --fb-brand 描边；账户未选 / 金额非法 --fb-danger 红边（§12-6）。 */
.rs-adv-row--focus {
  border-color: var(--fb-brand);
  box-shadow: 0 0 0 2px var(--fb-brand-soft);
}

.rs-adv-row--invalid {
  border-color: var(--fb-danger);
}

/* 两行 grid：上行账户+删除，下行 Toggle+金额+翻转+币种（与批准效果图一致） */
.row-top {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 44px;
  gap: 6px;
  align-items: center;
}

.row-bottom {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr) 44px 68px;
  gap: 6px;
  align-items: center;
  margin-top: 7px;
}

.adv-row select,
.adv-row input {
  min-height: 46px;
  width: 100%;
  padding: 0 7px;
  border: 1.5px solid var(--fb-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-card);
  color: var(--fb-ink);
  font-family: inherit;
  /* ★ 防 iOS 聚焦缩放：computed font-size <16px 会整页放大 */
  font-size: 16px;
}

.adv-row input {
  text-align: right;
  font-family: var(--fb-font-mono);
  font-variant-numeric: var(--fb-font-numeric);
}

.adv-row input[readonly] {
  background: var(--fb-soft);
  color: var(--fb-brand);
}

.adv-row .row-cur {
  min-width: 0;
  font-family: var(--fb-font-mono);
  font-size: 16px;
}

/* 契约 select 保留 DOM 锚点但由 chip 承担交互；浮层 chip 另挂同名 data-rf。 */
.acc-contract,
.cur-contract {
  position: absolute !important;
  width: 1px !important;
  height: 1px !important;
  min-height: 0 !important;
  padding: 0 !important;
  margin: -1px !important;
  border: 0 !important;
  opacity: 0;
  pointer-events: none;
}

.acc-chip,
.cur-chip {
  width: 100%;
  min-width: 0;
  min-height: 46px;
  padding: 4px 8px;
  border: 1.5px solid var(--fb-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-card);
  color: var(--fb-ink);
  font-family: inherit;
  font-size: 16px;
  text-align: left;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  line-height: 1.2;
}

.acc-chip {
  display: flex;
  align-items: center;
  gap: 6px;
}

.acc-chip__main {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.acc-chip__mono {
  flex: 0 0 auto;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fb-sub);
  font-size: 9px;
}

.chip-caret {
  flex: 0 0 auto;
  color: var(--fb-brand);
}

.cur-chip {
  font-family: var(--fb-font-mono);
  text-align: center;
}

/* 借/贷分段 Toggle：借=正、贷=负，与 core/record.amountDirection 同源。
   iOS/WebKit 下 flex:1 对 button 元素会按内容固有宽度分配，选中色块缩在格子左侧；
   改用 Grid 两等分显式列宽，列宽计算不再依赖 button 的 flex 固有尺寸。 */
.dir-toggle {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  min-height: 46px;
  padding: 3px;
  gap: 2px;
  border: 1.5px solid var(--fb-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-soft);
}

.dir-toggle .seg {
  /* 显式钉死几何：撑满 grid 单元并清掉 button UA 默认内边距/外边距，
     绕开 iOS/WebKit 对 button 固有宽度的私有渲染行为。 */
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 38px;
  padding: 0;
  margin: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--fb-sub);
  font-family: inherit;
  font-size: 16px;
  font-weight: 800;
  cursor: pointer;
  /* iOS Safari 默认给 button 套 -webkit-appearance:button（原生内边距/圆角/渐变），
     显式清掉并固定行高，Chrome/iOS 表现一致。 */
  appearance: none;
  -webkit-appearance: none;
  line-height: 1.2;
}

.dir-toggle .seg.debit.on {
  background: var(--fb-brand);
  color: var(--fb-white);
}

.dir-toggle .seg.credit.on {
  background: var(--fb-seal);
  color: var(--fb-white);
}

/* 金额框组：符号提示（自动赋号）+ 只填正数的 input */
.amt-box {
  display: flex;
  align-items: center;
  min-height: 46px;
  border: 1.5px solid var(--fb-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-card);
  overflow: hidden;
}

.amt-box:focus-within {
  border-color: var(--fb-brand);
}

.sign-hint {
  flex: 0 0 30px;
  align-self: stretch;
  display: flex;
  align-items: center;
  justify-content: center;
  border-right: 1px solid var(--fb-line);
  color: var(--fb-green);
  background: var(--fb-green-soft);
  font-family: var(--fb-font-mono);
  font-size: 16px;
  font-weight: 800;
}

.sign-hint.neg {
  color: var(--fb-danger);
  background: var(--fb-danger-soft);
}

.amt-box input {
  min-height: 44px;
  border: none;
  border-radius: 0;
  background: transparent;
}

/* 行内表达式小字 / 除零错误（§12-2） */
.row-expr,
.row-error {
  margin-top: 6px;
  font-family: var(--fb-font-mono);
  font-size: 11px;
  line-height: 1.5;
  text-align: right;
}

.row-expr {
  color: var(--fb-sub);
}

.row-error {
  color: var(--fb-danger-ink);
}

/* ＋/− 翻转：等价快捷切换借贷方向 */
.signflip {
  /* 与 .seg 同类的 grid 单元按钮：显式撑满居中，避免 iOS 靠内容宽度贴边。
     字号 / 触控高度 / 配色保持不变。 */
  width: 100%;
  height: 100%;
  min-width: 44px;
  min-height: 46px;
  padding: 0;
  margin: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1.5px solid var(--fb-warn);
  border-radius: var(--fb-radius-input);
  background: var(--fb-warn-soft);
  color: var(--fb-warn-ink);
  font-family: var(--fb-font-mono);
  font-size: 16px;
  font-weight: 800;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  line-height: 1.2;
}

.adv-remove {
  /* 同上：44px grid 列内显式撑满居中，不改字号 / 触控 / 颜色。 */
  width: 100%;
  height: 100%;
  min-width: 44px;
  min-height: 46px;
  padding: 0;
  margin: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-card);
  color: var(--fb-danger);
  font-size: 16px;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  line-height: 1.2;
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
  appearance: none;
  -webkit-appearance: none;
  line-height: 1.2;
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

/* ── 行浮层：移动底部弹层 / PC chip 锚定下拉（Teleport 到 body，z-index 80 > rs-mask 60） ── */
.adv-popover-mask {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 80;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: var(--fb-mask);
}

.adv-popover {
  position: relative;
  width: 100%;
  max-height: 72vh;
  overflow-y: auto;
  padding: 14px 12px 18px;
  border-radius: var(--fb-radius-card) var(--fb-radius-card) 0 0;
  background: var(--fb-card);
  box-shadow: var(--fb-shadow-panel);
}

.adv-pop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  color: var(--fb-ink-deep);
  font-size: 13px;
}

.adv-pop-close {
  min-width: 32px;
  min-height: 32px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-pill);
  background: var(--fb-soft);
  color: var(--fb-sub);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  line-height: 1.2;
}

.adv-search {
  width: 100%;
  min-height: 44px;
  margin-bottom: 8px;
  padding: 0 10px;
  border: 1.5px solid var(--fb-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-card);
  color: var(--fb-ink);
  font-family: inherit;
  font-size: 16px;
}

.adv-group__head {
  padding: 8px 2px 4px;
  color: var(--fb-sub);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.6px;
}

.adv-option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 44px;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-bottom-color: var(--fb-line);
  background: transparent;
  color: var(--fb-ink);
  font-family: inherit;
  font-size: 16px;
  text-align: left;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  line-height: 1.2;
}

.adv-option.on {
  border-color: var(--fb-brand-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-brand-soft);
  color: var(--fb-brand);
}

.adv-option__icon {
  flex: 0 0 auto;
  font-size: 16px;
}

.adv-option__main {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.adv-option__mono {
  flex: 0 0 auto;
  color: var(--fb-sub);
  font-family: var(--fb-font-mono);
  font-size: 9px;
}

.adv-option__check {
  flex: 0 0 auto;
  font-weight: 800;
}

@media (min-width: 900px) {
  .adv-popover-mask {
    align-items: flex-start;
    justify-content: flex-start;
    background: transparent;
  }

  .adv-popover {
    position: fixed;
    top: var(--pop-top, 120px);
    left: var(--pop-left, 50%);
    width: var(--pop-width, 250px);
    min-width: 250px;
    max-height: min(420px, 70vh);
    border: 1px solid var(--fb-line);
    border-radius: var(--fb-radius-card);
  }
}

@media (max-width: 380px) {
  .row-bottom {
    grid-template-columns: 64px minmax(0, 1fr) 44px 58px;
    gap: 4px;
  }
}
</style>
