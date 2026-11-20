<script setup lang="ts">
/**
 * P-05 交易详情（批 2；0.6.0 S6 增加编辑入口；小票改版）
 *
 * - 通过 query `id` 从流水列表定位交易，票面展示全部分录（复式可视性）；
 * - 核对状态用印章表达（已核对 / 待核对 / 已冲正 / 冲正），不再用 hero 色块 + 多张白卡；
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
import {
  displayEntryOf,
  displayKindOf,
  transferRoute,
  type TransactionKind,
} from '@/core/record'
import { markDirty } from '@/stores/dataFreshness'
import { useRecordSheetStore } from '@/stores/recordSheet'
import { useSessionStore } from '@/stores/session'
import ReceiptSlip from '@/components/ReceiptSlip.vue'

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
  txn.value === null ? 'expense' : displayKindOf(txn.value.postings, accounts.value),
)
const entry = computed(() =>
  txn.value === null
    ? { amount: '0.00', commodity: session.defaultCommodity }
    : displayEntryOf(txn.value.postings, accounts.value),
)

const KIND_LABELS: Record<TransactionKind, string> = {
  expense: '支出 EXPENSE',
  income: '收入 INCOME',
  transfer: '转账 TRANSFER',
  opening: '期初 OPENING',
}

/** 票面印章：核对 / 待核对 / 已冲正 / 冲正（已冲正优先，与编辑入口判定同口径）。 */
const stamp = computed<{ text: string; sub: string; tone: 'green' | 'amber' | 'blue' | 'red' }>(
  () => {
    const t = txn.value
    if (t !== null && (t.reversed_by ?? '') !== '') {
      return { text: '已冲正', sub: 'REVERSED', tone: 'red' }
    }
    if (t !== null && (t.reversal_of ?? '') !== '') {
      return { text: '冲正', sub: 'REVERSAL', tone: 'blue' }
    }
    if (t !== null && t.flag === '!') {
      return { text: '待核对', sub: 'UNCHECKED', tone: 'amber' }
    }
    return { text: '已核对', sub: 'VERIFIED', tone: 'green' }
  },
)

const rows = computed<Array<{ label: string; value?: string; tags?: string[] }>>(() => {
  const t = txn.value
  if (t === null) {
    return []
  }
  const list: Array<{ label: string; value?: string; tags?: string[] }> = [
    { label: '日期', value: t.date },
    { label: '备注', value: t.description },
  ]
  if (Array.isArray(t.tags) && t.tags.length > 0) {
    list.push({ label: '标签', tags: t.tags })
  }
  if (kind.value === 'transfer') {
    list.push({ label: '转账', value: transferRoute(t.postings, accounts.value) })
  }
  if ((t.created_by_name ?? '') !== '') {
    list.push({ label: '记账人', value: t.created_by_name })
  }
  return list
})

const postingRows = computed<Array<{ account: string; commodity: string; amount: string }>>(() => {
  const t = txn.value
  if (t === null) {
    return []
  }
  // 票面分录行刻意显示 Beancount 全名（而非 account_display_name）：
  // `.beancount` 可核对、可与导出文件逐行对照，这是小票的设计前提，不要改成展示名。
  return t.postings.map((posting) => ({
    account: posting.account,
    commodity: posting.commodity,
    amount: posting.amount,
  }))
})

/** 票尾流水号：uuid 去连字符取前 8 位。 */
function shortCode(uuid: string): string {
  const compact = uuid.split('-').join('')
  return compact === '' ? '--------' : compact.slice(0, 8)
}

const footLines = computed<string[]>(() => {
  const t = txn.value
  if (t === null) {
    return []
  }
  return [`TXN ${shortCode(t.uuid)}`, `ID #${String(t.id).padStart(6, '0')}`]
})

async function load(): Promise<void> {
  if (txnId.value === null) {
    loadError.value = '缺少交易 id，请从流水列表进入'
    return
  }
  loading.value = true
  loadError.value = ''
  try {
    const [accountRes, txnRes] = await Promise.all([accountApi.list({ includeClosed: true }), transactionApi.list()])
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
    // 第三处断链：软删改变 transactionApi.list() 的结果但不推进 savedEpoch。
    // 置脏后页面 visible → 快照立即 reload；随后 push 回列表时 afterEach 再查一次（已消费不重复拉）。
    markDirty('local-write')
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
    <div class="detail__bar">
      <button type="button" class="detail__back" @click="goBack">‹ 返回</button>
    </div>

    <div v-if="loadError" class="fb-card detail__state detail__state--error">
      <p>{{ loadError }}</p>
      <button class="fb-btn-ghost" type="button" @click="load">重新加载</button>
    </div>
    <div v-else-if="loading" class="fb-card detail__state">正在加载交易详情…</div>

    <template v-else-if="txn !== null">
      <div class="detail__slip">
        <ReceiptSlip
          :stamp="stamp.text"
          :stamp-sub="stamp.sub"
          :tone="stamp.tone"
          title="交易凭证"
          subtitle="FAMBEAN · TRANSACTION SLIP"
          :amount="entry.amount"
          :commodity="entry.commodity"
          :signed="kind !== 'transfer'"
          :kind-label="KIND_LABELS[kind]"
          :rows="rows"
          :postings="postingRows"
          :balanced="true"
          :foot-lines="footLines"
          thanks="— 凭 证 可 核 对 —"
        />
      </div>

      <div class="detail__actions">
        <button type="button" class="detail__edit" :disabled="editDisabled" @click="onEdit">
          修改这笔交易
        </button>
        <button
          type="button"
          class="detail__delete"
          :disabled="session.isViewer"
          @click="onDelete"
        >删除这笔交易</button>
      </div>
      <p class="detail__hint" :class="{ 'detail__hint--warn': editDisabled }">{{ editHint }}</p>
      <p v-if="notice" class="detail__notice" role="status">{{ notice }}</p>

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
  padding: 0 16px calc(24px + env(safe-area-inset-bottom, 0px));
}

.detail__bar {
  padding: 14px 0 6px;
}

.detail__back {
  border: none;
  background: none;
  padding: 4px 0;
  color: var(--fb-blue);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
}

.detail__slip {
  display: flex;
  justify-content: center;
  padding: 12px 0 6px;
}

.detail__actions {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  max-width: 340px;
  margin: 18px auto 0;
}

/* 0.6.0 S6：编辑按钮与禁用文案（修改 = 冲正 + 新建）。 */
.detail__edit {
  flex: 1;
  height: 46px;
  border: none;
  border-radius: var(--fb-radius-input);
  background: var(--fb-blue);
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

.detail__delete {
  flex: 0 0 auto;
  padding: 0 14px;
  height: 46px;
  border: 1px solid var(--fb-danger);
  border-radius: var(--fb-radius-input);
  background: var(--fb-card);
  color: var(--fb-danger);
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
}

.detail__delete:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.detail__hint {
  width: 100%;
  max-width: 340px;
  margin: 10px auto 0;
  font-size: 11.5px;
  line-height: 1.8;
  color: var(--fb-sub);
  text-align: center;
}

.detail__hint--warn {
  color: var(--fb-warn);
}

.detail__notice {
  width: 100%;
  max-width: 340px;
  margin: 10px auto 0;
  font-size: 12px;
  color: var(--fb-warn);
  text-align: center;
}

.detail__card {
  margin-top: 14px;
  padding: 14px 16px;
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
