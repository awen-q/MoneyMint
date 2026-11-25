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
import { buildBeanSnippet } from '@/core/bean'
import { t } from '@/i18n'
import {
  displayEntryOf,
  displayKindOf,
  transferRoute,
  type TransactionKind,
} from '@/core/record'
import { markDirty } from '@/stores/dataFreshness'
import { useRecordSheetStore } from '@/stores/recordSheet'
import { useSessionStore } from '@/stores/session'
import ReceiptShareSheet from '@/components/ReceiptShareSheet.vue'
import ReceiptSlip from '@/components/ReceiptSlip.vue'
import { buildShareReceipt } from '@/core/shareReceiptData'
import type { ShareReceiptData, ShareReceiptDetails } from '@/core/receiptImage'
import { usePrivacyStore } from '@/stores/privacy'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const sheet = useRecordSheetStore()
const privacy = usePrivacyStore()

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

/** 票面类型徽标（随当前语言；在渲染/调用时求值，不做模块顶层快照）。 */
function kindLabel(kind: TransactionKind): string {
  switch (kind) {
    case 'expense':
      return t('txnDetail.kindExpense')
    case 'income':
      return t('txnDetail.kindIncome')
    case 'transfer':
      return t('txnDetail.kindTransfer')
    default:
      return t('txnDetail.kindOpening')
  }
}

/** 票面印章：核对 / 待核对 / 已冲正 / 冲正（已冲正优先，与编辑入口判定同口径）。 */
const stamp = computed<{ text: string; sub: string; tone: 'green' | 'amber' | 'blue' | 'red' }>(
  () => {
    // 局部变量原名 t 会遮蔽 i18n 的 t()，改名 item。
    const item = txn.value
    if (item !== null && (item.reversed_by ?? '') !== '') {
      return { text: t('txnDetail.stampReversed'), sub: 'REVERSED', tone: 'red' }
    }
    if (item !== null && (item.reversal_of ?? '') !== '') {
      return { text: t('txnDetail.stampReversal'), sub: 'REVERSAL', tone: 'blue' }
    }
    if (item !== null && item.flag === '!') {
      return { text: t('txnDetail.stampUnchecked'), sub: 'UNCHECKED', tone: 'amber' }
    }
    return { text: t('txnDetail.stampVerified'), sub: 'VERIFIED', tone: 'green' }
  },
)

const rows = computed<Array<{ label: string; value?: string; tags?: string[] }>>(() => {
  const item = txn.value
  if (item === null) {
    return []
  }
  const list: Array<{ label: string; value?: string; tags?: string[] }> = [
    { label: t('txnDetail.rowDate'), value: item.date },
    { label: t('txnDetail.rowDescription'), value: item.description },
  ]
  if (Array.isArray(item.tags) && item.tags.length > 0) {
    list.push({ label: t('txnDetail.rowTags'), tags: item.tags })
  }
  if (kind.value === 'transfer') {
    list.push({ label: t('txnDetail.rowTransfer'), value: transferRoute(item.postings, accounts.value) })
  }
  if ((item.created_by_name ?? '') !== '') {
    list.push({ label: t('txnDetail.rowMember'), value: item.created_by_name })
  }
  return list
})

const postingRows = computed<Array<{ account: string; commodity: string; amount: string }>>(() => {
  const item = txn.value
  if (item === null) {
    return []
  }
  // 票面分录行刻意显示 Beancount 全名（而非 account_display_name）：
  // `.beancount` 可核对、可与导出文件逐行对照，这是小票的设计前提，不要改成展示名。
  return item.postings.map((posting) => ({
    account: posting.account,
    commodity: posting.commodity,
    amount: posting.amount,
  }))
})

/**
 * P0-1 原生语法片段：复用 `core/bean.ts` 的 `buildBeanSnippet`，
 * 与后端导出的 .beancount 逐字对齐（标签走 `tags: "..."` 元数据行）。
 *
 * 只取 `TransactionView` 真实存在的字段（date / flag / description / tags / postings）。
 * ^链接、成本批次 / FIFO、`@@` 兑换、金额表达式、附件在 transactions/postings
 * 表中都没有字段 —— 不编造示例、不留空占位。期初 / 余额校准身份键同样未随
 * 交易列表接口透出，故这里也不展示（不以描述文本反推语义）。
 */
const beanSnippet = computed<string>(() => {
  const item = txn.value
  if (item === null) {
    return ''
  }
  return buildBeanSnippet({
    date: item.date,
    flag: item.flag === '!' ? '!' : '*',
    description: item.description,
    tags: Array.isArray(item.tags) ? item.tags : [],
    postings: item.postings.map((posting) => ({
      accountName: posting.account,
      amount: posting.amount,
      commodity: posting.commodity,
    })),
  })
})

interface BeanSemantic {
  label: string
  value: string
}

/** 片段的语义注脚：只列列表响应里确实有值的字段。 */
const beanSemantics = computed<BeanSemantic[]>(() => {
  const item = txn.value
  if (item === null) {
    return []
  }
  const out: BeanSemantic[] = []
  if (item.flag === '!') {
    out.push({ label: t('txnDetail.beanFlagged'), value: t('txnDetail.beanFlaggedValue') })
  }
  if (item.postings.length > 2) {
    out.push({
      label: t('txnDetail.beanSplitLabel'),
      value: t('txnDetail.beanSplitValue', { n: String(item.postings.length) }),
    })
  }
  if ((item.reversal_of ?? '') !== '') {
    out.push({
      label: t('txnDetail.beanReversalLabel'),
      value: t('txnDetail.beanReversalValue', { code: shortCode(item.reversal_of ?? '') }),
    })
  }
  if ((item.reversed_by ?? '') !== '') {
    out.push({
      label: t('txnDetail.beanReversedLabel'),
      value: t('txnDetail.beanReversedValue', { code: shortCode(item.reversed_by ?? '') }),
    })
  }
  return out
})

/** 默认收起：详情层的高级视图，不干扰默认凭证视图。 */
const beanOpen = ref(false)

/** 票尾流水号：uuid 去连字符取前 8 位。 */
function shortCode(uuid: string): string {
  const compact = uuid.split('-').join('')
  return compact === '' ? '--------' : compact.slice(0, 8)
}

const footLines = computed<string[]>(() => {
  const item = txn.value
  if (item === null) {
    return []
  }
  return [`TXN ${shortCode(item.uuid)}`, `ID #${String(item.id).padStart(6, '0')}`]
})

/** 分享图：与成功页共用组装口径；详情页无 bean / 精确时间源，对应选项内容为空。 */
const shareOpen = ref(false)
const shareData = ref<ShareReceiptData | null>(null)
const shareDetails = ref<ShareReceiptDetails>({
  accountLines: [], tagLine: '', beanLines: [], preciseTime: '',
})

function openShare(): void {
  const item = txn.value
  if (item === null) {
    return
  }
  const label = kindLabel(kind.value)
  const built = buildShareReceipt({
    amount: entry.value.amount,
    commodity: entry.value.commodity,
    kindLabel: label,
    date: item.date,
    payee: item.description !== '' ? item.description : label,
    bean: '',
    tags: item.tags ?? [],
    accounts: postingRows.value.map((posting) => posting.account),
    preciseTime: '',
  }, privacy.enabled)
  shareData.value = built.data
  shareDetails.value = built.details
  shareOpen.value = true
}

async function load(): Promise<void> {
  if (txnId.value === null) {
    loadError.value = t('txnDetail.errMissingId')
    return
  }
  loading.value = true
  loadError.value = ''
  try {
    const [accountRes, txnRes] = await Promise.all([accountApi.list({ includeClosed: true }), transactionApi.list()])
    accounts.value = Array.isArray(accountRes.accounts) ? accountRes.accounts : []
    transactions.value = Array.isArray(txnRes.transactions) ? txnRes.transactions : []
    if (txn.value === null) {
      loadError.value = t('txnDetail.errNotFound')
    }
  } catch (err) {
    loadError.value = err instanceof ApiError ? err.message : t('txnDetail.errLoad')
  } finally {
    loading.value = false
  }
}

const deleting = ref(false)
const showDeleteConfirm = ref(false)

/** 软删前二次确认；删除后可在回收站恢复（uuid 由列表接口透出）。 */
function onDelete(): void {
  if (session.isViewer) {
    notice.value = t('txnDetail.errViewerDelete')
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
    notice.value =
      err instanceof ApiError
        ? t('txnDetail.errDeleteWithMessage', { message: err.message })
        : t('txnDetail.errDelete')
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
      return t('txnDetail.editHintReversed')
    case 'offline':
      // 固定文案（AC-5.4）。
      return t('txnDetail.editHintOffline')
    case 'forbidden':
      return t('txnDetail.editHintForbidden')
    default:
      return t('txnDetail.editHintReady')
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
      <button type="button" class="detail__back" @click="goBack">{{ t('txnDetail.back') }}</button>
    </div>

    <div v-if="loadError" class="fb-card detail__state detail__state--error">
      <p>{{ loadError }}</p>
      <button class="fb-btn-ghost" type="button" @click="load">{{ t('txnDetail.retry') }}</button>
    </div>
    <div v-else-if="loading" class="fb-card detail__state">{{ t('txnDetail.loading') }}</div>

    <template v-else-if="txn !== null">
      <div class="detail__slip">
        <ReceiptSlip
          :stamp="stamp.text"
          :stamp-sub="stamp.sub"
          :tone="stamp.tone"
          :title="t('txnDetail.slipTitle')"
          :subtitle="t('txnDetail.slipSubtitle')"
          :amount="entry.amount"
          :commodity="entry.commodity"
          :signed="kind !== 'transfer'"
          :kind-label="kindLabel(kind)"
          :rows="rows"
          :postings="postingRows"
          :balanced="true"
          :foot-lines="footLines"
          :thanks="t('txnDetail.slipThanks')"
        />
      </div>

      <!-- P0-1：默认收起的原生语法片段。列表 / 搜索页不渲染，默认视图保持干净。 -->
      <section class="detail__bean" data-testid="bean-snippet">
        <button
          type="button"
          class="detail__bean-toggle"
          :aria-expanded="beanOpen"
          @click="beanOpen = !beanOpen"
        >{{ beanOpen ? t('txnDetail.beanToggleCollapse') : t('txnDetail.beanToggleExpand') }}</button>
        <div v-if="beanOpen" class="detail__bean-body">
          <p class="detail__bean-note">{{ t('txnDetail.beanNote') }}</p>
          <pre class="detail__bean-code">{{ beanSnippet }}</pre>
          <ul v-if="beanSemantics.length > 0" class="detail__bean-meta">
            <li v-for="item in beanSemantics" :key="item.label">
              <span>{{ item.label }}</span>
              <span>{{ item.value }}</span>
            </li>
          </ul>
        </div>
      </section>

      <div class="detail__actions">
        <button type="button" class="detail__edit" :disabled="editDisabled" @click="onEdit">
          {{ t('txnDetail.edit') }}
        </button>
        <button type="button" class="detail__share" @click="openShare">{{ t('txnDetail.share') }}</button>
        <button
          type="button"
          class="detail__delete"
          :disabled="session.isViewer"
          @click="onDelete"
        >{{ t('txnDetail.delete') }}</button>
      </div>

      <ReceiptShareSheet
        v-if="shareOpen && shareData !== null"
        :data="shareData"
        :details="shareDetails"
        @close="shareOpen = false"
      />
      <p class="detail__hint" :class="{ 'detail__hint--warn': editDisabled }">{{ editHint }}</p>
      <p v-if="notice" class="detail__notice" role="status">{{ notice }}</p>

      <div v-if="showDeleteConfirm" class="fb-card detail__card detail__confirm">
        <h3>{{ t('txnDetail.confirmDelete') }}</h3>
        <p class="detail__warn">
          {{ t('txnDetail.deleteConfirmBody', { name: txn.description, date: txn.date }) }}
        </p>
        <div class="detail__confirm-actions">
          <button class="fb-btn-ghost" type="button" @click="showDeleteConfirm = false">{{ t('txnDetail.cancel') }}</button>
          <button class="fb-btn-primary" type="button" :disabled="deleting" @click="confirmDelete">
            {{ deleting ? t('txnDetail.deleting') : t('txnDetail.confirmDelete') }}
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

/* P0-1：原生语法片段（详情层高级视图，默认收起，不抢凭证视觉重心）。 */
.detail__bean {
  width: 100%;
  max-width: 340px;
  margin: 12px auto 0;
}

.detail__bean-toggle {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-card);
  color: var(--fb-blue);
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.detail__bean-toggle:focus-visible {
  outline: 2px solid var(--fb-blue);
  outline-offset: 2px;
}

.detail__bean-body {
  margin-top: 8px;
  padding: 10px 12px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-card);
  background: var(--fb-soft);
}

.detail__bean-note {
  margin: 0 0 8px;
  color: var(--fb-sub);
  font-size: 11px;
  line-height: 1.6;
}

.detail__bean-code {
  margin: 0;
  overflow-x: auto;
  color: var(--fb-ink);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.7;
  white-space: pre;
}

.detail__bean-meta {
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}

.detail__bean-meta li {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 3px 0;
  color: var(--fb-sub);
  font-size: 11px;
}

.detail__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  width: 100%;
  max-width: 340px;
  margin: 18px auto 0;
}

.detail__share {
  flex: 1 0 100%;
  height: 46px;
  border: 1px solid var(--fb-blue-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-card);
  color: var(--fb-blue);
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
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
  /* 与修改/分享同宽：整行铺满（此前 flex:0 0 auto 贴内容，比上面两个按钮短）。 */
  flex: 1 0 100%;
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
