<script setup lang="ts">
/**
 * P-05 交易详情（批 2；0.6.0 S6 增加编辑入口）
 *
 * - 通过 query `id` 从流水列表定位交易，展示全部分录（复式可视性）；
 * - 软删走 `DELETE /api/transactions/{uuid}`（列表已透出 uuid），
 *   删除前二次确认，删除后可在回收站恢复；
 * - 编辑入口（AC-5.4）：不按 navigator.onLine 显隐——在线 GET 成功 → 按
 *   服务端 can_edit；离线 → 按钮保留、禁用态 + 固定文案「修改需联网」；
 *   已冲正 → 固定文案「该交易已被冲正，请修改最新版本」（不复用离线文案）；
 *   修改走 RecordSheet 编辑态（PATCH 冲正 + 新建），仅在线。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { accountApi, transactionApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { AccountView, TransactionView } from '@/api/types'
import { accountLabel, displayEntryOf, transactionKind, transferRoute } from '@/core/record'
import { useRecordSheetStore } from '@/stores/recordSheet'
import { useSessionStore } from '@/stores/session'
import MoneyText from '@/components/MoneyText.vue'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const sheet = useRecordSheetStore()

const accounts = ref<AccountView[]>([])
const transactions = ref<TransactionView[]>([])
const loading = ref(false)
const loadError = ref('')
const notice = ref('')

const txnId = computed<number | null>(() => {
  const raw = route.query.id
  const value = typeof raw === 'string' ? raw : ''
  if (value === '' || !/^\d+$/.test(value)) {
    return null
  }
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
})

const txn = computed<TransactionView | null>(() => {
  if (txnId.value === null) {
    return null
  }
  for (const item of transactions.value) {
    if (item.id === txnId.value) {
      return item
    }
  }
  return null
})

const kind = computed(() =>
  txn.value === null ? 'expense' : transactionKind(txn.value.postings, accounts.value),
)
const entry = computed(() =>
  txn.value === null
    ? { amount: '0.00', commodity: session.defaultCommodity }
    : displayEntryOf(txn.value.postings, accounts.value),
)
const meta = computed(() => {
  if (txn.value === null) {
    return ''
  }
  return kind.value === 'transfer'
    ? transferRoute(txn.value.postings, accounts.value)
    : `记账人 ${txn.value.created_by_name}`
})

function typeOf(accountId: number): string {
  for (const account of accounts.value) {
    if (account.id === accountId) {
      return account.type
    }
  }
  return ''
}

async function load(): Promise<void> {
  if (txnId.value === null) {
    loadError.value = '缺少交易 id，请从流水列表进入'
    return
  }
  loading.value = true
  loadError.value = ''
  try {
    const [accountRes, txnRes] = await Promise.all([accountApi.list(), transactionApi.list()])
    accounts.value = Array.isArray(accountRes.accounts) ? accountRes.accounts : []
    transactions.value = Array.isArray(txnRes.transactions) ? txnRes.transactions : []
    if (txn.value === null) {
      loadError.value = '未找到该交易（可能已被删除）'
    }
  } catch (err) {
    loadError.value = err instanceof ApiError ? err.message : '交易详情加载失败'
  } finally {
    loading.value = false
  }
}

const deleting = ref(false)
const showDeleteConfirm = ref(false)

/** 软删前二次确认；删除后可在回收站恢复（uuid 由列表接口透出）。 */
function onDelete(): void {
  if (session.isViewer) {
    notice.value = '只读成员不能删除交易'
    return
  }
  notice.value = ''
  showDeleteConfirm.value = true
}

async function confirmDelete(): Promise<void> {
  if (txn.value === null || deleting.value) {
    return
  }
  deleting.value = true
  try {
    await transactionApi.remove(txn.value.uuid)
    showDeleteConfirm.value = false
    void router.push({ name: 'transactions' })
  } catch (err) {
    notice.value = err instanceof ApiError ? `删除失败：${err.message}` : '删除失败，请稍后重试'
  } finally {
    deleting.value = false
  }
}

function goBack(): void {
  void router.back()
}

// ---------- 0.6.0 S6 编辑入口（AC-5.4 / AC-5.2） ----------

/** 在线状态：仅用于禁用态与固定文案，绝不用于隐藏编辑入口。 */
const online = ref(true)

function syncOnline(): void {
  online.value = navigator.onLine
}

const editState = computed<'ready' | 'reversed' | 'offline' | 'forbidden'>(() => {
  const t = txn.value
  if (t !== null && (t.reversed_by ?? '') !== '') {
    return 'reversed' // D-15：已冲正判定优先于角色，文案固定
  }
  if (!online.value) {
    return 'offline'
  }
  return t !== null && t.can_edit === true ? 'ready' : 'forbidden'
})

const editDisabled = computed(() => editState.value !== 'ready')

const editHint = computed<string>(() => {
  switch (editState.value) {
    case 'reversed':
      // 固定文案（AC-5.4）：不得复用离线文案。
      return '该交易已被冲正，请修改最新版本'
    case 'offline':
      // 固定文案（AC-5.4）。
      return '修改需联网'
    case 'forbidden':
      return '当前账号无权修改该交易'
    default:
      return '修改 = 冲正 + 新建：保存后原交易保留，账目以新交易为准'
  }
})

function onEdit(): void {
  if (txn.value === null || editDisabled.value) {
    return
  }
  sheet.openEdit(txn.value)
}

onMounted(() => {
  syncOnline()
  window.addEventListener('online', syncOnline)
  window.addEventListener('offline', syncOnline)
  void load()
})

onUnmounted(() => {
  window.removeEventListener('online', syncOnline)
  window.removeEventListener('offline', syncOnline)
})

watch(
  () => session.ledgerId,
  () => {
    accounts.value = []
    transactions.value = []
    void load()
  },
)

// 编辑保存成功后刷新详情（RecordSheet 编辑态经 store.notifyChanged 推进 savedEpoch）。
watch(
  () => sheet.savedEpoch,
  () => {
    void load()
  },
)
</script>

<template>
  <section class="detail">
    <header class="detail__hero fb-hero">
      <button type="button" class="detail__back" @click="goBack">‹ 返回</button>
      <div class="detail__hero-body" v-if="txn !== null">
        <div class="detail__label">{{ txn.date }} · {{ txn.flag === '!' ? '待核对' : '已核对' }}</div>
        <MoneyText
          class="detail__amount"
          :amount="entry.amount"
          :commodity="entry.commodity"
          size="lg"
          :signed="kind !== 'transfer'"
        />
        <div class="detail__meta">
          <span v-if="(txn.reversed_by ?? '') !== ''" class="detail__badge">已冲正</span>
          <span v-else-if="(txn.reversal_of ?? '') !== ''" class="detail__badge">冲正</span>
          <span v-if="kind === 'transfer'" class="detail__badge">转账</span>
          <span v-else-if="kind === 'opening'" class="detail__badge">期初</span>
          {{ txn.description }} · {{ meta }}
        </div>
      </div>
    </header>

    <div v-if="loadError" class="fb-card detail__state detail__state--error">
      <p>{{ loadError }}</p>
      <button class="fb-btn-ghost" type="button" @click="load">重新加载</button>
    </div>
    <div v-else-if="loading" class="fb-card detail__state">正在加载交易详情…</div>

    <template v-else-if="txn !== null">
      <div class="fb-card detail__card">
        <h3>分录（{{ txn.postings.length }} 条）</h3>
        <ul class="detail__postings">
          <li v-for="(posting, index) in txn.postings" :key="index" class="detail__posting">
            <span class="detail__posting-name">
              {{ accountLabel({ id: posting.account_id, name: posting.account, type: typeOf(posting.account_id) }) }}
              <span class="detail__posting-type">{{ typeOf(posting.account_id) }}</span>
            </span>
            <MoneyText :amount="posting.amount" :commodity="posting.commodity" size="sm" />
          </li>
        </ul>
      </div>

      <!-- 0.6.0 S6 编辑入口（AC-5.4）：按钮保留、禁用态 + 固定文案，绝不按在线状态隐藏。 -->
      <div class="fb-card detail__card">
        <button
          type="button"
          class="detail__edit"
          :disabled="editDisabled"
          @click="onEdit"
        >修改这笔交易</button>
        <p class="detail__hint" :class="{ 'detail__hint--warn': editDisabled }">{{ editHint }}</p>
      </div>

      <div class="fb-card detail__card">
        <button type="button" class="detail__delete" :disabled="session.isViewer" @click="onDelete">删除这笔交易（软删）</button>
        <p v-if="notice" class="detail__notice" role="status">{{ notice }}</p>
        <p class="detail__hint">删除后的交易可在「回收站」中恢复。</p>
      </div>

      <div v-if="showDeleteConfirm" class="fb-card detail__card detail__confirm">
        <h3>确认删除</h3>
        <p class="detail__warn">
          将软删「{{ txn.description }}」（{{ txn.date }}）；删除后可在回收站恢复，确认继续？
        </p>
        <div class="detail__confirm-actions">
          <button class="fb-btn-ghost" type="button" @click="showDeleteConfirm = false">取消</button>
          <button class="fb-btn-primary" type="button" :disabled="deleting" @click="confirmDelete">
            {{ deleting ? '删除中…' : '确认删除' }}
          </button>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.detail {
  padding-bottom: 20px;
}

.detail__hero {
  padding: calc(16px + env(safe-area-inset-top, 0px)) 20px 20px;
  border-radius: 0 0 24px 24px;
}

.detail__back {
  border: none;
  background: var(--fb-on-hero-pill);
  color: var(--fb-white);
  border-radius: var(--fb-radius-pill);
  padding: 5px 12px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}

.detail__hero-body {
  margin-top: 14px;
}

.detail__label {
  font-size: 12px;
  color: var(--fb-on-hero-muted);
}

.detail__amount {
  margin-top: 4px;
  color: var(--fb-white);
}

.detail__amount :deep(.money-text--negative) {
  color: var(--fb-white);
}

.detail__meta {
  margin-top: 10px;
  font-size: 12px;
  color: var(--fb-on-hero-muted);
}

.detail__badge {
  display: inline-block;
  margin-right: 6px;
  padding: 1px 7px;
  border-radius: var(--fb-radius-pill);
  background: var(--fb-on-hero-pill);
  font-size: 10px;
  font-weight: 600;
}

.detail__card {
  margin-top: 14px;
  padding: 14px 16px;
}

.detail__card h3 {
  margin: 0 0 10px;
  font-size: 14px;
  font-weight: 600;
}

.detail__postings {
  list-style: none;
  margin: 0;
  padding: 0;
}

.detail__posting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--fb-line);
}

.detail__posting:last-child {
  border-bottom: none;
}

.detail__posting-name {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail__posting-type {
  font-size: 10px;
  color: var(--fb-sub);
  flex-shrink: 0;
}

.detail__delete {
  width: 100%;
  height: 44px;
  border: none;
  border-radius: var(--fb-radius-input);
  background: var(--fb-danger);
  color: var(--fb-white);
  font-size: 14px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
}

/* 0.6.0 S6：编辑按钮与禁用文案（修改 = 冲正 + 新建）。 */
.detail__edit {
  width: 100%;
  height: 44px;
  border: none;
  border-radius: var(--fb-radius-input);
  background: var(--fb-primary, #4c6ef5);
  color: var(--fb-white);
  font-size: 14px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
}

.detail__edit:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.detail__hint--warn {
  color: var(--fb-warn);
}

.detail__delete:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.detail__notice {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--fb-warn);
}

.detail__hint {
  margin: 8px 0 0;
  font-size: 11px;
  color: var(--fb-sub);
  line-height: 1.7;
}

.detail__confirm h3 {
  margin: 0 0 8px;
  font-size: 14px;
  color: var(--fb-warn);
}

.detail__warn {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--fb-ink);
}

.detail__confirm-actions {
  display: flex;
  gap: 10px;
}

.detail__confirm-actions > button {
  flex: 1;
}

.detail__state {
  margin-top: 14px;
  padding: 20px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--fb-sub);
}

.detail__state--error {
  color: var(--fb-danger);
}

.detail__state p {
  margin: 0 0 12px;
}
</style>
