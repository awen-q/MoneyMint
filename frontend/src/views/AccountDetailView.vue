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
import { affectedTransactionCount, balanceOf, catIcon, isClosed } from '@/core/accounts'
import { balanceDiff, hasTransactionsAfter, isPlainDecimal, previewText } from '@/core/balance'
import { formatSessionTime } from '@/core/batch3'
import { Money } from '@/core/Money'
import {
  accountLabel,
  accountRunningBalances,
  displayKindOf,
  postingAmountForAccount,
  todayString,
} from '@/core/record'
import { t } from '@/i18n'
import { markDirty } from '@/stores/dataFreshness'
import { useSessionStore } from '@/stores/session'
import MoneyText from '@/components/MoneyText.vue'
import AccountForm from '@/components/AccountForm.vue'
import AccountEditSheet from '@/components/AccountEditSheet.vue'

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
// 批 II：展示字段编辑入口（账户详情页 + 分类页行操作双入口之一）。
const showEditSheet = ref(false)
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
// 负债正目标的强制确认勾选（改目标值或收起面板即重置，防「勾选后再改数」绕过确认）。
const liabilityConfirmChecked = ref(false)

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

/** 展示字段编辑（批 II）：已关户也可改（纯展示字段），viewer 隐藏入口。 */
const canEditVisual = computed(() => !session.isViewer)

function openEditSheet(): void {
  if (!canEditVisual.value) {
    return
  }
  notice.value = ''
  showEditSheet.value = true
}

/** 编辑保存成功：markDirty 由 AccountEditSheet 调用；这里收敛本页数据。 */
async function onEditSaved(): Promise<void> {
  showEditSheet.value = false
  await load()
}

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

/**
 * 负债账户目标余额为正数：疑似方向填反（本系统欠款记为负数）。
 * 用 Money.from 解析判断（定点口径，禁浮点），非法串一律视为不命中；仅 Liabilities 生效。
 */
const liabilityPositiveTarget = computed(() => {
  if (account.value === null || account.value.type !== 'Liabilities') {
    return false
  }
  try {
    const value = Money.from(balanceTarget.value)
    return !value.isZero() && !value.isNegative()
  } catch {
    return false
  }
})

// 目标值改动 / 确认面板收起时重置负债方向确认勾选。
watch(balanceTarget, () => {
  liabilityConfirmChecked.value = false
})
watch(showBalanceConfirm, (open) => {
  if (!open) {
    liabilityConfirmChecked.value = false
  }
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
  return t('accountDetail.errBalance')
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
  // 展示标签走 displayKindOf：还款主体 + 小额优惠的复合交易显示「转账」，
  // 统计 / postings / 后端 kind 口径均不受影响。
  const kind = displayKindOf(txn.postings, accounts.value)
  if (kind === 'transfer') {
    return t('accountDetail.kindTransfer')
  }
  if (kind === 'opening') {
    return t('accountDetail.kindOpening')
  }
  return kind === 'income' ? t('accountDetail.kindIncome') : t('accountDetail.kindExpense')
}

function commodityBalance(code: string): string {
  return account.value === null ? '0.00' : balanceOf(account.value, code)
}

async function load(): Promise<void> {
  if (accountId.value === null) {
    loadError.value = t('accountDetail.errMissingId')
    return
  }
  loading.value = true
  loadError.value = ''
  try {
    const [accountRes, txnRes] = await Promise.all([accountApi.list({ includeClosed: true }), transactionApi.list()])
    accounts.value = Array.isArray(accountRes.accounts) ? accountRes.accounts : []
    transactions.value = Array.isArray(txnRes.transactions) ? txnRes.transactions : []
    if (account.value === null) {
      loadError.value = t('accountDetail.errNotFound')
    }
  } catch (err) {
    loadError.value = err instanceof ApiError ? err.message : t('accountDetail.errLoad')
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
    notice.value = t('accountDetail.errCalibrateNotAllowed')
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
    balanceError.value = t('accountDetail.errTargetInvalid')
    return
  }
  balanceError.value = ''
  liabilityConfirmChecked.value = false
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
      ? t('accountDetail.noticeCalibrated', { version: String(result.version) })
      : t('accountDetail.noticeCalibratedTxn', { date: result.date })
    markDirty('local-write')
    await Promise.all([load(), loadBalancePreview()])
  } catch (err) {
    balanceError.value = balanceMessageOf(err)
  } finally {
    balanceSubmitting.value = false
  }
}

function openOpening(): void {
  if (session.isViewer) {
    notice.value = t('accountDetail.errViewerOpening')
    return
  }
  if (closed.value) {
    notice.value = t('accountDetail.errClosedOpening')
    return
  }
  notice.value = ''
  showOpeningForm.value = true
}

function openCloseConfirm(): void {
  if (session.isViewer) {
    notice.value = t('accountDetail.errViewerClose')
    return
  }
  if (closed.value) {
    notice.value = t('accountDetail.errAlreadyClosed')
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
    notice.value = t('accountDetail.noticeClosed', { name: accountLabel(account.value) })
    markDirty('local-write')
    await load()
  } catch (err) {
    closeError.value = err instanceof ApiError ? err.message : t('accountDetail.errClose')
    if (err instanceof ApiError && err.balances !== undefined) {
      closeBalances.value = err.balances
    }
  } finally {
    closing.value = false
  }
}

function onOpeningSaved(): void {
  notice.value = t('accountDetail.noticeOpeningSaved')
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
      <button type="button" class="acctd__back" @click="goBack">{{ t('accountDetail.back') }}</button>
      <div v-if="account !== null" class="acctd__hero-body">
        <div class="acctd__label">{{ t('accountDetail.meta', { type: account.type, date: account.open_date }) }}<template v-if="closed">{{ t('accountDetail.closedMeta', { date: account.close_date ?? '' }) }}</template></div>
        <h1 class="acctd__name">
          <span
            class="acctd__icon"
            :style="account.color ? { color: account.color } : undefined"
            aria-hidden="true"
          >{{ catIcon(account) }}</span>
          {{ accountLabel(account) }}
        </h1>
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
      <button class="fb-btn-ghost" type="button" @click="load">{{ t('common.reload') }}</button>
    </div>
    <div v-else-if="loading" class="fb-card acctd__state">{{ t('accountDetail.loading') }}</div>

    <template v-else-if="account !== null">
      <div class="fb-card acctd__card">
        <button type="button" class="acctd__action" :disabled="!canManage" @click="openOpening">{{ t('accountDetail.openingSetting') }}</button>
        <button type="button" class="acctd__action acctd__action--ghost" :disabled="!canCalibrate" @click="openBalancePanel">{{ t('accountDetail.balanceCalibrate') }}</button>
        <button type="button" class="acctd__action acctd__action--ghost" @click="openInGlobalTxns">{{ t('accountDetail.viewInGlobal') }}</button>
        <button v-if="canEditVisual" type="button" class="acctd__action acctd__action--ghost" @click="openEditSheet">{{ t('accountDetail.editVisual') }}</button>
        <button type="button" class="acctd__action acctd__action--danger" :disabled="!canManage" @click="openCloseConfirm">
          {{ t('accountDetail.closeAccount') }}
        </button>
        <p v-if="notice" class="acctd__notice" role="status">{{ notice }}</p>
        <p v-if="closed" class="acctd__hint">{{ t('accountDetail.closedHint') }}</p>
      </div>

      <div v-if="showBalancePanel" class="fb-card acctd__card acctd__balance-panel">
        <h3>{{ t('accountDetail.balanceCalibrate') }}</h3>
        <p class="acctd__hint">{{ t('accountDetail.calibrateHint') }}</p>
        <div class="acctd__balance-fields">
          <label class="acctd__field">
            <span>{{ t('accountDetail.asOfDate') }}</span>
            <input v-model="balanceAsOf" class="fb-input" type="date" />
          </label>
          <label class="acctd__field">
            <span>{{ t('common.commodity') }}</span>
            <select v-model="balanceCommodity" class="fb-input">
              <option v-for="code in balanceCommodityOptions" :key="code" :value="code">{{ code }}</option>
            </select>
          </label>
          <label class="acctd__field">
            <span>{{ t('accountDetail.targetLabel') }}</span>
            <input v-model="balanceTarget" class="fb-input" type="text" :placeholder="t('accountDetail.targetPlaceholder')" />
          </label>
          <button class="fb-btn-ghost" type="button" :disabled="balanceLoading" @click="loadBalancePreview">{{ t('accountDetail.refreshPreview') }}</button>
        </div>

        <p v-if="balanceLoading" class="acctd__hint">{{ t('accountDetail.loadingPreview') }}</p>
        <p v-if="balancePreviewText" class="acctd__preview">{{ balancePreviewText }} {{ balanceCommodity }}</p>
        <p v-if="balanceError" class="acctd__warn acctd__warn--error" role="alert">{{ balanceError }}</p>
        <p v-if="balanceNotice" class="acctd__notice" role="status">{{ balanceNotice }}</p>

        <div v-if="balancePreview !== null && balancePreview.cumulative.length > 0" class="acctd__diff">
          <p class="acctd__diff-label">{{ t('accountDetail.cumulativeLabel') }}</p>
          <p v-for="item in balancePreview.cumulative" :key="item.commodity" class="acctd__hint">
            {{ item.commodity }} {{ item.amount }}
          </p>
        </div>

        <div v-if="balanceHistory.length > 0" class="acctd__diff">
          <p class="acctd__diff-label">{{ t('accountDetail.historyLabel') }}</p>
          <ul class="acctd__list">
            <li v-for="item in balanceHistory" :key="item.transaction_uuid" class="acctd__row">
              <span class="acctd__row-info">
                <span class="acctd__row-desc">{{ item.version }} · {{ item.reversed ? t('accountDetail.reversed') : t('accountDetail.active') }}</span>
                <span class="acctd__row-meta">
                  {{ formatSessionTime(item.created_at ?? '') }} · {{ item.created_by_name || '—' }}
                  <template v-if="item.entries && item.entries.length > 0">
                    · {{ t('accountDetail.diffLabel') }} <template v-for="entry in item.entries" :key="entry.commodity">{{ entry.commodity }} {{ entry.amount }} </template>
                  </template>
                </span>
              </span>
            </li>
          </ul>
        </div>

        <div class="acctd__confirm-actions">
          <button type="button" class="fb-btn-ghost" @click="showBalancePanel = false">{{ t('accountDetail.collapse') }}</button>
          <button
            type="button"
            class="fb-btn-primary"
            :disabled="balanceSubmitting || balancePreviewText === ''"
            @click="openBalanceConfirm"
          >{{ t('accountDetail.generate') }}</button>
        </div>
      </div>

      <div v-if="showBalanceConfirm" class="fb-card acctd__card acctd__confirm">
        <h3>{{ t('accountDetail.confirmTitle') }}</h3>
        <p class="acctd__warn">{{ balancePreviewText }} {{ balanceCommodity }}</p>
        <p v-if="laterTxns" class="acctd__warn acctd__warn--error">
          {{ t('accountDetail.confirmLaterWarn') }}
        </p>
        <!-- 负债账户目标余额为正：疑似方向填反，强制显式确认后才能生成。 -->
        <p v-if="liabilityPositiveTarget" class="acctd__warn acctd__warn--error" role="alert">
          {{ t('accountDetail.liabilityWarn') }}
        </p>
        <label v-if="liabilityPositiveTarget" class="acctd__confirm-check">
          <input v-model="liabilityConfirmChecked" type="checkbox" />
          <span>{{ t('accountDetail.liabilityConfirm') }}</span>
        </label>
        <p class="acctd__hint">
          {{ t('accountDetail.confirmHint', { date: balanceAsOf }) }}
        </p>
        <div class="acctd__confirm-actions">
          <button type="button" class="fb-btn-ghost" @click="showBalanceConfirm = false">{{ t('common.cancel') }}</button>
          <button
            type="button"
            class="fb-btn-primary"
            :disabled="balanceSubmitting || (liabilityPositiveTarget && !liabilityConfirmChecked)"
            @click="confirmBalance"
          >
            {{ balanceSubmitting ? t('accountDetail.generating') : t('accountDetail.confirmGenerate') }}
          </button>
        </div>
      </div>

      <div v-if="showCloseConfirm" class="fb-card acctd__card acctd__confirm">
        <h3>{{ t('accountDetail.closeConfirmTitle') }}</h3>
        <p class="acctd__warn">{{ t('accountDetail.closeConfirmBefore') }}<strong>{{ affectedCount }}</strong>{{ t('accountDetail.closeConfirmAfter') }}</p>
        <div v-if="closeError" class="acctd__close-error">
          <p class="acctd__warn acctd__warn--error">{{ closeError }}</p>
          <div v-if="closeBalances.length > 0" class="acctd__diff">
            <p class="acctd__diff-label">{{ t('accountDetail.balanceDiffLabel') }}</p>
            <table>
              <thead><tr><th>{{ t('common.commodity') }}</th><th>{{ t('common.diff') }}</th></tr></thead>
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
          <button type="button" class="fb-btn-ghost" @click="showCloseConfirm = false">{{ t('common.cancel') }}</button>
          <button type="button" class="fb-btn-primary" :disabled="closing" @click="confirmClose">
            {{ closing ? t('accountDetail.closing') : t('accountDetail.confirmClose') }}
          </button>
        </div>
      </div>

      <div class="fb-card acctd__card">
        <h3>{{ t('accountDetail.txnsTitle', { n: String(accountTxns.length) }) }}</h3>
        <p v-if="accountTxns.length === 0" class="acctd__empty">{{ t('accountDetail.txnsEmpty') }}</p>
        <ul v-else class="acctd__list">
          <li v-for="txn in accountTxns" :key="txn.id" class="acctd__row">
            <span class="acctd__row-info">
              <span class="acctd__row-desc">{{ txn.date }} · {{ txn.description }}</span>
              <span class="acctd__row-meta">{{ kindLabel(txn) }}</span>
            </span>
            <span class="acctd__row-balance">
              <span class="acctd__row-balance-label">{{ t('accountDetail.runningBalance') }}</span>
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

    <!-- 批 II：展示字段编辑弹层（在线-only；离线态由弹层内置灰） -->
    <AccountEditSheet
      v-if="showEditSheet && account !== null"
      :account="account"
      @close="showEditSheet = false"
      @saved="onEditSaved"
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

/* 批 II 页头图标：行内展示，随账户 color 染色（缺省继承墨色）。 */
.acctd__icon {
  display: inline-block;
  margin-right: 8px;
  font-size: 20px;
  line-height: 1;
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
  /* 余额校准预检的各币种累计金额是纯文本渲染，数字等宽避免竖列跳动。 */
  font-variant-numeric: var(--fb-font-numeric);
}

.acctd__confirm h3 {
  color: var(--fb-warn);
}

.acctd__warn {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--fb-ink);
  /* 预检文案内嵌目标余额，等宽数字保证逐行对齐。 */
  font-variant-numeric: var(--fb-font-numeric);
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

/* 负债正目标的强制确认勾选行。
   文字取主墨色 --fb-ink 而非 --fb-sub：它是必须被注意到才能继续的确认门槛，
   与相邻说明性小字刻意差一档色阶，将来「统一色阶」时不要合并这两处。 */
.acctd__confirm-check {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
  font-size: 12px;
  color: var(--fb-ink);
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
  font-variant-numeric: var(--fb-font-numeric);
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
  /* 校准历史行的差额金额在元信息里，跟进等宽口径。 */
  font-variant-numeric: var(--fb-font-numeric);
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
