<script setup lang="ts">
/**
 * P-08 账户详情（批 2）：余额（按币种）、该账户流水、期初设置入口、关户。
 *
 * 关户守门（AC-28 / AC-29）：
 * - 已关户账户展示 close_date 且不出现写入口；
 * - 关户前二次确认列出「受影响交易笔数」（affectedTransactionCount）；
 * - 服务端 409（余额非 0）时渲染 `ApiError.balances` 差额明细表，不只弹文案。
 *
 * 0.6.0 S4 余额校准（AC-3.1 / AC-3.6 / AC-3.7）：
 * - Assets / Liabilities / Equity 三类账户提供校准入口；
 * - 预检文案统一「截至 D 日初（前一日日终）当前累计 / 目标 / 将自动补记 ±差额」；
 * - 二次确认在 D 之后已有交易时明确提示「此操作会改变 D 之后的所有余额」；
 * - 展示校准版本历史 v1/v2（含操作人、时间、差额原因）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { accountApi, balanceApi, transactionApi } from '@/api/client'
import { ApiError, codeMessage } from '@/api/errors'
import type { AccountView, BalancePreview, BalanceResult, TransactionView } from '@/api/types'
import { affectedTransactionCount, balanceOf, isClosed } from '@/core/accounts'
import { balanceDiff, hasTransactionsAfter, isPlainDecimal, previewText } from '@/core/balance'
import {
  accountLabel,
  accountRunningBalances,
  postingAmountForAccount,
  todayString,
  transactionKind,
} from '@/core/record'
import { useSessionStore } from '@/stores/session'
import MoneyText from '@/components/MoneyText.vue'
import AccountForm from '@/components/AccountForm.vue'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()

const accounts = ref<AccountView[]>([])
const transactions = ref<TransactionView[]>([])
const loading = ref(false)
const loadError = ref('')
const notice = ref('')
const closing = ref(false)
const showCloseConfirm = ref(false)
const showOpeningForm = ref(false)
const closeError = ref('')
const closeBalances = ref<Array<{ commodity: string; amount: string }>>([])

// ---- 0.6.0 S4 余额校准 ----
const showBalancePanel = ref(false)
const showBalanceConfirm = ref(false)
const balanceAsOf = ref(todayString())
const balanceCommodity = ref(session.defaultCommodity)
const balanceTarget = ref('')
const balancePreview = ref<BalancePreview | null>(null)
const balanceResult = ref<BalanceResult | null>(null)
const balanceLoading = ref(false)
const balanceSubmitting = ref(false)
const balanceError = ref('')
const balanceNotice = ref('')

const accountId = computed<number | null>(() => {
  const raw = route.params.id
  const value = typeof raw === 'string' ? raw : ''
  if (value === '' || !/^\d+$/.test(value)) {
    return null
  }
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
})

const account = computed<AccountView | null>(() => {
  if (accountId.value === null) {
    return null
  }
  for (const item of accounts.value) {
    if (item.id === accountId.value) {
      return item
    }
  }
  return null
})

const balanceCodes = computed(() => {
  if (account.value === null || account.value.balances === undefined) {
    return []
  }
  return Object.keys(account.value.balances)
})

const accountTxns = computed<TransactionView[]>(() => {
  if (accountId.value === null) {
    return []
  }
  return transactions.value.filter((txn) => {
    let hit = false
    for (const posting of txn.postings) {
      if (posting.account_id === accountId.value) {
        hit = true
      }
    }
    return hit
  })
})

const affectedCount = computed(() =>
  accountId.value === null ? 0 : affectedTransactionCount(accountId.value, transactions.value),
)

const closed = computed(() => account.value !== null && isClosed(account.value))

/** 期初 / 关户写入口守卫：角色 + 关户状态（uuid 由列表接口透出）。 */
const canManage = computed(
  () => account.value !== null && !closed.value && !session.isViewer,
)

/** 校准仅对未关户的 Assets / Liabilities / Equity 开放（AC-3.1）。 */
const canCalibrate = computed(() => {
  if (account.value === null || closed.value || session.isViewer) {
    return false
  }
  const kind = account.value.type
  return kind === 'Assets' || kind === 'Liabilities' || kind === 'Equity'
})

const balanceCommodityOptions = computed(() => {
  if (balanceCodes.value.length > 0) {
    return balanceCodes.value
  }
  return [session.defaultCommodity]
})

/** 当前选中币种的日初累计（容忍旧响应缺字段）。 */
const cumulativeForSelected = computed(() => {
  const view = balancePreview.value
  if (view === null || !Array.isArray(view.cumulative)) {
    return '0.00'
  }
  for (const item of view.cumulative) {
    if (item.commodity === balanceCommodity.value) {
      return item.amount
    }
  }
  return '0.00'
})

/** 预检统一文案（AC-3.1）。 */
const balancePreviewText = computed(() => {
  if (balancePreview.value === null || !isPlainDecimal(balanceTarget.value)) {
    return ''
  }
  return previewText(balanceAsOf.value, cumulativeForSelected.value, balanceTarget.value)
})

/** D 之后是否已有交易（AC-3.7 二次确认提示）。 */
const laterTxns = computed(() => {
  const dates: string[] = []
  for (const txn of transactions.value) {
    dates.push(txn.date)
  }
  return hasTransactionsAfter(balanceAsOf.value, dates)
})

const balanceHistory = computed(() => {
  const view = balancePreview.value
  if (view === null || view.calibration === undefined || !Array.isArray(view.calibration.history)) {
    return []
  }
  return view.calibration.history
})

/** 稳定错误码优先走集中映射，具体中文原因由后端 error 补充。 */
function balanceMessageOf(err: unknown): string {
  if (err instanceof ApiError) {
    const mapped = err.code === undefined ? '' : codeMessage(err.code)
    return mapped !== '' ? mapped : err.message
  }
  return '余额校准失败，请稍后重试'
}

/** 账户侧 journal（批 2.5 修 4a）：行金额取该账户自身分录的原值原符号。 */
function rowPosting(txn: TransactionView): { amount: string; commodity: string } {
  if (accountId.value === null) {
    return { amount: '0.00', commodity: session.defaultCommodity }
  }
  for (const posting of txn.postings) {
    if (posting.account_id === accountId.value) {
      return { amount: posting.amount, commodity: posting.commodity }
    }
  }
  return { amount: '0.00', commodity: session.defaultCommodity }
}

/** running balance（批 2.5 修 4b）：仅主币种累计（取舍见 core/record 注释）。 */
const runningBalances = computed(() =>
  accountRunningBalances(
    accountTxns.value,
    accountId.value ?? 0,
    session.defaultCommodity,
  ),
)

function runningBalanceOf(txn: TransactionView): string {
  const value = runningBalances.value[txn.id]
  return value === undefined ? '-' : value
}

/** 批 2.5 修 4c：跳全局流水并预填账户筛选。 */
function openInGlobalTxns(): void {
  if (accountId.value === null) {
    return
  }
  notice.value = ''
  void router.push({ name: 'transactions', query: { account: String(accountId.value) } })
}

function kindLabel(txn: TransactionView): string {
  const kind = transactionKind(txn.postings, accounts.value)
  if (kind === 'transfer') {
    return '转账'
  }
  if (kind === 'opening') {
    return '期初'
  }
  return kind === 'income' ? '收入' : '支出'
}

function commodityBalance(code: string): string {
  return account.value === null ? '0.00' : balanceOf(account.value, code)
}

async function load(): Promise<void> {
  if (accountId.value === null) {
    loadError.value = '缺少账户 id，请从账户列表进入'
    return
  }
  loading.value = true
  loadError.value = ''
  try {
    const [accountRes, txnRes] = await Promise.all([accountApi.list(), transactionApi.list()])
    accounts.value = Array.isArray(accountRes.accounts) ? accountRes.accounts : []
    transactions.value = Array.isArray(txnRes.transactions) ? txnRes.transactions : []
    if (account.value === null) {
      loadError.value = '未找到该账户（可能已关闭或不在当前账本）'
    }
  } catch (err) {
    loadError.value = err instanceof ApiError ? err.message : '账户详情加载失败'
  } finally {
    loading.value = false
  }
}

/** 预检：GET /api/accounts/{uuid}/balance?as_of_date=D。 */
async function loadBalancePreview(): Promise<void> {
  if (account.value === null) {
    return
  }
  balanceLoading.value = true
  balanceError.value = ''
  try {
    balancePreview.value = await balanceApi.preview(account.value.uuid, balanceAsOf.value)
  } catch (err) {
    balancePreview.value = null
    balanceError.value = balanceMessageOf(err)
  } finally {
    balanceLoading.value = false
  }
}

function openBalancePanel(): void {
  if (!canCalibrate.value) {
    notice.value = '仅未关户的资产 / 负债 / 权益账户可校准余额'
    return
  }
  notice.value = ''
  balanceError.value = ''
  balanceNotice.value = ''
  showBalancePanel.value = true
  void loadBalancePreview()
}

function openBalanceConfirm(): void {
  if (!isPlainDecimal(balanceTarget.value)) {
    balanceError.value = '请输入合法的定点十进制目标余额（可带负号）'
    return
  }
  balanceError.value = ''
  showBalanceConfirm.value = true
}

async function confirmBalance(): Promise<void> {
  if (account.value === null || balanceSubmitting.value) {
    return
  }
  balanceSubmitting.value = true
  balanceError.value = ''
  try {
    const result = await balanceApi.set(account.value.uuid, {
      as_of_date: balanceAsOf.value,
      targets: [{ commodity: balanceCommodity.value, target_balance: balanceTarget.value.trim() }],
    })
    balanceResult.value = result
    showBalanceConfirm.value = false
    balanceNotice.value = result.status === 'updated'
      ? `已生成 v${result.version} 校准（旧版本仅标记失效，不删除）`
      : `已生成校准交易（落账日 ${result.date}）`
    await Promise.all([load(), loadBalancePreview()])
  } catch (err) {
    balanceError.value = balanceMessageOf(err)
  } finally {
    balanceSubmitting.value = false
  }
}

function openOpening(): void {
  if (session.isViewer) {
    notice.value = '只读成员不能修改期初'
    return
  }
  if (closed.value) {
    notice.value = '已关户账户不能修改期初'
    return
  }
  notice.value = ''
  showOpeningForm.value = true
}

function openCloseConfirm(): void {
  if (session.isViewer) {
    notice.value = '只读成员不能关户'
    return
  }
  if (closed.value) {
    notice.value = '该账户已关户'
    return
  }
  notice.value = ''
  closeError.value = ''
  closeBalances.value = []
  showCloseConfirm.value = true
}

/** AC-29：确认后走 close（DELETE = Beancount close）；409 时渲染差额明细。 */
async function confirmClose(): Promise<void> {
  if (account.value === null || account.value.uuid === undefined || closing.value) {
    return
  }
  closing.value = true
  closeError.value = ''
  closeBalances.value = []
  try {
    await accountApi.close(account.value.uuid)
    showCloseConfirm.value = false
    notice.value = `已关户「${accountLabel(account.value)}」`
    await load()
  } catch (err) {
    closeError.value = err instanceof ApiError ? err.message : '关户失败，请稍后重试'
    if (err instanceof ApiError && err.balances !== undefined) {
      closeBalances.value = err.balances
    }
  } finally {
    closing.value = false
  }
}

function onOpeningSaved(): void {
  notice.value = '期初已保存（修改期初会由后端生成冲正 + 新建成对交易）'
  void load()
}

function goBack(): void {
  void router.back()
}

watch(
  () => session.ledgerId,
  () => {
    accounts.value = []
    transactions.value = []
    void load()
  },
)

onMounted(() => {
  void load()
})
</script>

<template>
  <section class="acctd">
    <header class="acctd__hero fb-hero">
      <button type="button" class="acctd__back" @click="goBack">‹ 返回</button>
      <div v-if="account !== null" class="acctd__hero-body">
        <div class="acctd__label">{{ account.type }} · 开户 {{ account.open_date }}<template v-if="closed"> · 已关户（{{ account.close_date }}）</template></div>
        <h1 class="acctd__name">{{ accountLabel(account) }}</h1>
        <ul class="acctd__balances">
          <li v-for="code in balanceCodes" :key="code" class="acctd__balance">
            <span>{{ code }}</span>
            <MoneyText :amount="commodityBalance(code)" :commodity="code" size="sm" />
          </li>
        </ul>
      </div>
    </header>

    <div v-if="loadError" class="fb-card acctd__state acctd__state--error">
      <p>{{ loadError }}</p>
      <button class="fb-btn-ghost" type="button" @click="load">重新加载</button>
    </div>
    <div v-else-if="loading" class="fb-card acctd__state">正在加载账户详情…</div>

    <template v-else-if="account !== null">
      <div class="fb-card acctd__card">
        <button type="button" class="acctd__action" :disabled="!canManage" @click="openOpening">期初余额设置</button>
        <button type="button" class="acctd__action acctd__action--ghost" :disabled="!canCalibrate" @click="openBalancePanel">余额校准</button>
        <button type="button" class="acctd__action acctd__action--ghost" @click="openInGlobalTxns">在全局流水中查看本账户</button>
        <button type="button" class="acctd__action acctd__action--danger" :disabled="!canManage" @click="openCloseConfirm">
          关闭账户（Beancount close）
        </button>
        <p v-if="notice" class="acctd__notice" role="status">{{ notice }}</p>
        <p v-if="closed" class="acctd__hint">已关户账户保留全部历史交易，仅只读。</p>
      </div>

      <div v-if="showBalancePanel" class="fb-card acctd__card acctd__balance-panel">
        <h3>余额校准</h3>
        <p class="acctd__hint">口径为「截至 D 日初（前一日日终）」：累计只统计 D 之前的交易，补平分录自动落在 D-1。</p>
        <div class="acctd__balance-fields">
          <label class="acctd__field">
            <span>指定日期 D</span>
            <input v-model="balanceAsOf" class="fb-input" type="date" />
          </label>
          <label class="acctd__field">
            <span>币种</span>
            <select v-model="balanceCommodity" class="fb-input">
              <option v-for="code in balanceCommodityOptions" :key="code" :value="code">{{ code }}</option>
            </select>
          </label>
          <label class="acctd__field">
            <span>目标余额（可带负号）</span>
            <input v-model="balanceTarget" class="fb-input" type="text" placeholder="如 12350.00" />
          </label>
          <button class="fb-btn-ghost" type="button" :disabled="balanceLoading" @click="loadBalancePreview">刷新预检</button>
        </div>

        <p v-if="balanceLoading" class="acctd__hint">正在加载预检…</p>
        <p v-if="balancePreviewText" class="acctd__preview">{{ balancePreviewText }} {{ balanceCommodity }}</p>
        <p v-if="balanceError" class="acctd__warn acctd__warn--error" role="alert">{{ balanceError }}</p>
        <p v-if="balanceNotice" class="acctd__notice" role="status">{{ balanceNotice }}</p>

        <div v-if="balancePreview !== null && balancePreview.cumulative.length > 0" class="acctd__diff">
          <p class="acctd__diff-label">各币种日初累计：</p>
          <p v-for="item in balancePreview.cumulative" :key="item.commodity" class="acctd__hint">
            {{ item.commodity }} {{ item.amount }}
          </p>
        </div>

        <div v-if="balanceHistory.length > 0" class="acctd__diff">
          <p class="acctd__diff-label">校准版本历史：</p>
          <ul class="acctd__list">
            <li v-for="item in balanceHistory" :key="item.transaction_uuid" class="acctd__row">
              <span class="acctd__row-info">
                <span class="acctd__row-desc">{{ item.version }} · {{ item.reversed ? '已失效（被新版本冲正）' : '当前生效' }}</span>
                <span class="acctd__row-meta">
                  {{ item.created_at }} · {{ item.created_by_name || '—' }}
                  <template v-if="item.entries && item.entries.length > 0">
                    · 差额 <template v-for="entry in item.entries" :key="entry.commodity">{{ entry.commodity }} {{ entry.amount }} </template>
                  </template>
                </span>
              </span>
            </li>
          </ul>
        </div>

        <div class="acctd__confirm-actions">
          <button type="button" class="fb-btn-ghost" @click="showBalancePanel = false">收起</button>
          <button
            type="button"
            class="fb-btn-primary"
            :disabled="balanceSubmitting || balancePreviewText === ''"
            @click="openBalanceConfirm"
          >生成校准交易</button>
        </div>
      </div>

      <div v-if="showBalanceConfirm" class="fb-card acctd__card acctd__confirm">
        <h3>确认生成校准交易</h3>
        <p class="acctd__warn">{{ balancePreviewText }} {{ balanceCommodity }}</p>
        <p v-if="laterTxns" class="acctd__warn acctd__warn--error">
          此操作会改变 D 之后的所有余额，请确认目标值无误。
        </p>
        <p class="acctd__hint">
          将新增一笔普通交易（日期 {{ balanceAsOf }} 的前一日），差额记入 Equity:Opening-Balances；
          同一日期再次设置会冲正旧校准并生成新版本，不覆盖原交易。
        </p>
        <div class="acctd__confirm-actions">
          <button type="button" class="fb-btn-ghost" @click="showBalanceConfirm = false">取消</button>
          <button type="button" class="fb-btn-primary" :disabled="balanceSubmitting" @click="confirmBalance">
            {{ balanceSubmitting ? '生成中…' : '确认生成' }}
          </button>
        </div>
      </div>

      <div v-if="showCloseConfirm" class="fb-card acctd__card acctd__confirm">
        <h3>确认关闭账户</h3>
        <p class="acctd__warn">该账户出现在 <strong>{{ affectedCount }}</strong> 笔未删除交易中；关闭后会置 close_date 并保留全部交易引用，操作前请确认余额已清零。</p>
        <div v-if="closeError" class="acctd__close-error">
          <p class="acctd__warn acctd__warn--error">{{ closeError }}</p>
          <div v-if="closeBalances.length > 0" class="acctd__diff">
            <p class="acctd__diff-label">按币种差额明细：</p>
            <table>
              <thead><tr><th>币种</th><th>差额</th></tr></thead>
              <tbody>
                <tr v-for="diff in closeBalances" :key="diff.commodity">
                  <td>{{ diff.commodity }}</td>
                  <td><MoneyText :amount="diff.amount" :commodity="diff.commodity" size="sm" /></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="acctd__confirm-actions">
          <button type="button" class="fb-btn-ghost" @click="showCloseConfirm = false">取消</button>
          <button type="button" class="fb-btn-primary" :disabled="closing" @click="confirmClose">
            {{ closing ? '关闭中…' : '确认关户' }}
          </button>
        </div>
      </div>

      <div class="fb-card acctd__card">
        <h3>该账户流水（{{ accountTxns.length }} 笔）</h3>
        <p v-if="accountTxns.length === 0" class="acctd__empty">暂无流水。</p>
        <ul v-else class="acctd__list">
          <li v-for="txn in accountTxns" :key="txn.id" class="acctd__row">
            <span class="acctd__row-info">
              <span class="acctd__row-desc">{{ txn.date }} · {{ txn.description }}</span>
              <span class="acctd__row-meta">{{ kindLabel(txn) }}</span>
            </span>
            <span class="acctd__row-balance">
              <span class="acctd__row-balance-label">余额</span>
              <MoneyText :amount="runningBalanceOf(txn)" :commodity="session.defaultCommodity" size="sm" />
            </span>
            <MoneyText
              :amount="rowPosting(txn).amount"
              :commodity="rowPosting(txn).commodity"
              size="sm"
            />
          </li>
        </ul>
      </div>
    </template>

    <AccountForm
      v-if="showOpeningForm && account !== null"
      mode="opening"
      :account="account"
      @close="showOpeningForm = false"
      @saved="onOpeningSaved"
    />
  </section>
</template>

<style scoped>
.acctd {
  padding-bottom: 20px;
}

.acctd__hero {
  padding: calc(16px + env(safe-area-inset-top, 0px)) 20px 20px;
  border-radius: 0 0 24px 24px;
}

.acctd__back {
  border: none;
  background: var(--fb-on-hero-pill);
  color: var(--fb-white);
  border-radius: var(--fb-radius-pill);
  padding: 5px 12px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}

.acctd__hero-body {
  margin-top: 14px;
}

.acctd__label {
  font-size: 12px;
  color: var(--fb-on-hero-muted);
}

.acctd__name {
  margin: 6px 0 0;
  font-size: 20px;
  font-weight: 800;
}

.acctd__balances {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.acctd__balance {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--fb-on-hero-muted);
}

.acctd__balance :deep(.money-text) {
  color: var(--fb-white);
}

.acctd__balance :deep(.money-text--negative) {
  color: var(--fb-white);
}

.acctd__card {
  margin-top: 14px;
  padding: 14px 16px;
}

.acctd__card h3 {
  margin: 0 0 10px;
  font-size: 14px;
  font-weight: 600;
}

.acctd__action {
  width: 100%;
  height: 44px;
  margin-bottom: 10px;
  border: none;
  border-radius: var(--fb-radius-input);
  background: var(--fb-blue);
  color: var(--fb-white);
  font-size: 14px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
}

.acctd__action:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.acctd__action--ghost {
  background: var(--fb-card);
  color: var(--fb-blue);
  border: 1px solid var(--fb-blue);
}

.acctd__action--danger {
  background: var(--fb-danger);
}

.acctd__notice {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--fb-blue);
}

.acctd__hint {
  margin: 8px 0 0;
  font-size: 11px;
  color: var(--fb-sub);
}

.acctd__confirm h3 {
  color: var(--fb-warn);
}

.acctd__warn {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--fb-ink);
}

.acctd__warn--error {
  color: var(--fb-danger);
}

.acctd__diff-label {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--fb-danger);
  font-weight: 600;
}

.acctd__diff table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.acctd__diff th,
.acctd__diff td {
  text-align: left;
  padding: 4px 8px;
  border-bottom: 1px solid var(--fb-line);
}

.acctd__confirm-actions {
  display: flex;
  gap: 10px;
}

.acctd__confirm-actions > button {
  flex: 1;
}

.acctd__balance-panel {
  border: 1px solid var(--fb-line);
}

.acctd__balance-fields {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
  margin-top: 10px;
}

.acctd__field {
  flex: 1;
  min-width: 120px;
  font-size: 12px;
  color: var(--fb-sub);
}

.acctd__field span {
  display: block;
  margin-bottom: 4px;
}

.acctd__field .fb-input {
  width: 100%;
}

.acctd__preview {
  margin: 12px 0 0;
  padding: 8px 12px;
  border-radius: var(--fb-radius-input);
  background: var(--fb-green-soft);
  color: var(--fb-green-ink);
  font-size: 12px;
  line-height: 1.7;
}

.acctd__list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.acctd__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--fb-line);
}

.acctd__row:last-child {
  border-bottom: none;
}

.acctd__row-info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

/* running balance：仅 PC 宽屏显示余额列，移动端折叠（批 2.5 修 4b） */
.acctd__row-balance {
  display: none;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  flex-shrink: 0;
}

.acctd__row-balance-label {
  font-size: 10px;
  color: var(--fb-sub);
}

@media (min-width: 1024px) {
  .acctd__row-balance {
    display: inline-flex;
  }
}

.acctd__row-desc {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.acctd__row-meta {
  font-size: 11px;
  color: var(--fb-sub);
}

.acctd__empty {
  margin: 0;
  padding: 14px 0;
  text-align: center;
  font-size: 12px;
  color: var(--fb-sub);
}

.acctd__state {
  margin-top: 14px;
  padding: 20px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--fb-sub);
}

.acctd__state--error {
  color: var(--fb-danger);
}

.acctd__state p {
  margin: 0 0 12px;
}
</style>
