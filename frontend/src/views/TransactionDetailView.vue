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
import { ApiError, codeMessage } from '@/api/errors'
import type { AccountView, TagEditItem, TagEditResponse, TransactionView } from '@/api/types'
import { formatSessionTime } from '@/core/batch3'
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
import TagInlineEditor from '@/components/TagInlineEditor.vue'
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

/**
 * 冲正了当前这笔「原交易」的那条记录，用于详情页的「修改记录」行。
 *
 * 数据来源：本页 `load()` 已经拉过全量列表（`transactionApi.list()`），而后端
 * `ListTransactions` 只过滤 `deleted_at IS NULL`、**不排除冲正交易**，所以冲正
 * 记录通常就在 `transactions` 里，不必再发一次请求。
 *
 * 找不到（例如冲正记录被清进了回收站）→ 返回 null；调用方据此**不加行、不报错**。
 * 当前交易本身没有被冲正（`reversed_by` 为空）→ 同样返回 null。
 */
const reversalTxn = computed<TransactionView | null>(() => {
  const item = txn.value
  if (item === null || (item.reversed_by ?? '') === '') {
    return null
  }
  return transactions.value.find((t) => t.uuid === item.reversed_by) ?? null
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
    // 冲正交易本身不是「谁记的这笔账」，而是「谁发起的这次修改」：
    // 沿用「记账人」会让用户以为某成员真的记了一笔叫「冲正:面包烘焙」的支出。
    const isReversal = (item.reversal_of ?? '') !== ''
    list.push({
      label: isReversal ? t('txnDetail.rowInitiator') : t('txnDetail.rowMember'),
      value: item.created_by_name,
    })
  }
  // 「修改记录」：当前交易被冲正时，指出是谁在什么时候改的。
  // 冲正记录不在列表里（被清进回收站等）→ 整行不加。
  if (reversalTxn.value !== null) {
    const who = (reversalTxn.value.created_by_name ?? '') !== ''
      ? reversalTxn.value.created_by_name
      : t('txnDetail.modifiedByUnknown')
    // created_at 是服务端 UTC 串（`YYYY-MM-DD HH:MM:SS`，无时区后缀）。
    // **不能**直接 slice(0,10)：UTC 与本地（东八区）差 8 小时，
    // 北京时间 00:00–07:59 记的账对应 UTC 前一天 16:00–23:59，
    // 直接取 UTC 日期会显示成前一天。白天记的账不受影响。
    // 复用 core/batch3.ts 那套 parseServerTime/formatSessionTime 转本地时区再取日期，
    // 与 SessionsView / DataSafetyView 一致；解析失败时该函数返回占位符，
    // 正则不匹配 → 退化为只显示人名。
    const raw = (reversalTxn.value.created_at ?? '').trim()
    const local = formatSessionTime(raw)
    const when = /^\d{4}-\d{2}-\d{2}/.test(local) ? local.slice(0, 10) : ''
    list.push({
      label: t('txnDetail.rowModifiedBy'),
      value: when !== '' ? `${who} · ${when}` : who,
    })
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

// ---------- 标签原地更新 P0（注解层，与上面的经济事实编辑物理隔离） ----------

/** 就地编辑器默认收起；入口与整包 PATCH 按钮各占一行，互不复用。 */
const tagEditorOpen = ref(false)

/**
 * 标签编辑入口状态：权限直接复用服务端 `can_edit`。
 * 已冲正 / 期初 / 校准 / 非本人 → can_edit=false → forbidden；
 * P0 离线 → offline **禁用 + 专属文案**，与经济事实的「修改需联网」刻意区分。
 * navigator.onLine 只用于提示，服务端 CAS + 权限才是安全边界。
 */
const tagEditState = computed<'ready' | 'offline' | 'forbidden'>(() => {
  const item = txn.value
  if (item === null || item.can_edit !== true) {
    return 'forbidden'
  }
  if (!online.value) {
    return 'offline'
  }
  return 'ready'
})

const tagEditDisabled = computed(() => tagEditState.value !== 'ready')

const tagEditHint = computed<string>(() => {
  switch (tagEditState.value) {
    case 'offline':
      return t('tagEdit.offlineDisabled')
    case 'forbidden':
      return t('tagEdit.forbidden')
    default:
      return t('tagEdit.detailHint')
  }
})

function openTagEditor(): void {
  if (txn.value === null || tagEditDisabled.value) {
    return
  }
  tagEditorOpen.value = true
}

/**
 * 保存成功：只用响应回显的 tags 替换当前视图的标签字段。
 * **绝不插入 / 复制交易行**，uuid 与 postings 原样保留，主流水仍「一笔 = 一行」。
 */
function onTagSaved(response: TagEditResponse): void {
  const item = txn.value
  if (item === null) {
    return
  }
  const updated: TransactionView = {
    ...item,
    tags: response.tags.slice(),
    tags_updated_at: response.tags_updated_at,
  }
  const index = transactions.value.findIndex((candidate) => candidate.id === item.id)
  if (index >= 0) {
    const next = transactions.value.slice()
    next[index] = updated
    transactions.value = next
  }
  // 审计面板下次展开时重新拉取，避免显示刚改动前的旧记录。
  tagEditsLoaded.value = false
  notice.value = t('tagEdit.noticeSaved')
}

// ---------- 二级「编辑记录」面板（默认收起，与原生语法片段同款交互） ----------

const tagEditsOpen = ref(false)
const tagEdits = ref<TagEditItem[]>([])
const tagEditsLoaded = ref(false)
const tagEditsLoading = ref(false)
const tagEditsError = ref('')

function toggleTagEdits(): void {
  tagEditsOpen.value = !tagEditsOpen.value
  if (tagEditsOpen.value && !tagEditsLoaded.value && !tagEditsLoading.value) {
    void loadTagEdits()
  }
}

/** 按需从服务端拉审计；viewer 可读。不进主流水 / 搜索 / 导出 / loadEntity。 */
async function loadTagEdits(): Promise<void> {
  const item = txn.value
  if (item === null) {
    return
  }
  tagEditsLoading.value = true
  tagEditsError.value = ''
  try {
    const res = await transactionApi.listTagEdits(item.uuid)
    tagEdits.value = Array.isArray(res.edits) ? res.edits : []
    tagEditsLoaded.value = true
  } catch (err) {
    tagEditsError.value =
      err instanceof ApiError
        ? codeMessage(err.code ?? '') || err.message
        : t('tagEdit.historyLoadFailed')
  } finally {
    tagEditsLoading.value = false
  }
}

/** 审计行的人类可读元信息（时间戳走本地时区，与登录设备页同口径）。 */
function historyMeta(edit: TagEditItem): string {
  const who = (edit.actor_name ?? '') !== '' ? edit.actor_name : t('tagEdit.historyUnknownActor')
  const when = formatSessionTime(edit.ts ?? '')
  const device = (edit.device_id ?? '') !== '' ? edit.device_id : t('tagEdit.historyNoDevice')
  return t('tagEdit.historyMeta', { who, when, device })
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
    tagEditorOpen.value = false
    tagEditsOpen.value = false
    tagEditsLoaded.value = false
    tagEdits.value = []
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

      <!--
        标签原地更新 P0：小票标签 chip 区旁的「编辑标签」入口。
        与下方「修改这笔交易」（整包 PATCH / RecordSheet）物理隔离：
        本入口只提交 tags + base_tags，不产生冲正行，uuid 不变。
      -->
      <div class="detail__tags" data-testid="tag-edit-entry">
        <span class="detail__tags-label">{{ t('txnDetail.rowTags') }}</span>
        <div class="detail__tags-chips">
          <span v-for="tag in txn.tags ?? []" :key="tag" class="detail__tags-chip">{{ tag }}</span>
          <span v-if="(txn.tags ?? []).length === 0" class="detail__tags-empty">{{ t('tagEdit.empty') }}</span>
        </div>
        <button
          type="button"
          class="detail__tags-edit"
          data-testid="tag-edit-open"
          :disabled="tagEditDisabled"
          @click="openTagEditor"
        >{{ t('tagEdit.editButton') }}</button>
      </div>
      <p
        class="detail__tags-hint"
        :class="{ 'detail__hint--warn': tagEditDisabled }"
        data-testid="tag-edit-hint"
      >{{ tagEditHint }}</p>

      <TagInlineEditor
        v-if="tagEditorOpen"
        :uuid="txn.uuid"
        :tags="txn.tags ?? []"
        :can-edit="txn.can_edit === true"
        @saved="onTagSaved"
        @close="tagEditorOpen = false"
      />

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

      <!--
        二级「编辑记录」：默认收起，与原生语法片段同款折叠交互。
        只读审计（viewer 可读），绝不进主流水 / 搜索筛选 / .beancount 导出。
      -->
      <section class="detail__history" data-testid="tag-edit-history">
        <button
          type="button"
          class="detail__bean-toggle detail__history-toggle"
          :aria-expanded="tagEditsOpen"
          @click="toggleTagEdits"
        >
          <span class="detail__history-title">{{ t('tagEdit.historyTitle') }}</span>
          <span class="detail__history-toggle-text">
            {{ tagEditsOpen ? t('tagEdit.historyToggleCollapse') : t('tagEdit.historyToggleExpand') }}
          </span>
        </button>
        <div v-if="tagEditsOpen" class="detail__history-body">
          <p class="detail__bean-note">{{ t('tagEdit.historyLegacyHint') }}</p>
          <p v-if="tagEditsLoading" class="detail__bean-note">{{ t('tagEdit.historyLoading') }}</p>
          <p v-else-if="tagEditsError !== ''" class="detail__bean-note detail__history-error" role="alert">{{ tagEditsError }}</p>
          <p v-else-if="tagEdits.length === 0" class="detail__bean-note">{{ t('tagEdit.historyEmpty') }}</p>
          <ul v-else class="detail__history-list">
            <li v-for="edit in tagEdits" :key="edit.id" class="detail__history-item">
              <div class="detail__history-line">
                <span class="detail__history-action">{{ t('tagEdit.historyActionReplace') }}</span>
                <span class="detail__history-meta">{{ historyMeta(edit) }}</span>
              </div>
              <div class="detail__history-tags">
                <span
                  v-for="tag in edit.old_tags"
                  :key="`old-${tag}`"
                  class="detail__history-tag detail__history-tag--old"
                >{{ tag }}</span>
                <span class="detail__history-arrow" aria-hidden="true">→</span>
                <span
                  v-for="tag in edit.new_tags"
                  :key="`new-${tag}`"
                  class="detail__history-tag detail__history-tag--new"
                >{{ tag }}</span>
                <span
                  v-if="edit.old_tags.length === 0 && edit.new_tags.length === 0"
                  class="detail__history-tag"
                >{{ t('tagEdit.empty') }}</span>
              </div>
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

/* 标签原地更新 P0：chip 区旁的轻量编辑入口（与整包 PATCH 按钮分行隔离）。 */
.detail__tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  width: 100%;
  max-width: 340px;
  margin: 14px auto 0;
  padding: 10px 12px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-card);
  background: var(--fb-card);
}

.detail__tags-label {
  flex: none;
  color: var(--fb-sub);
  font-size: 11px;
}

.detail__tags-chips {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
}

.detail__tags-chip {
  display: inline-block;
  padding: 2px 7px;
  border: 1px solid var(--fb-blue-line);
  border-radius: var(--fb-radius-pill);
  background: var(--fb-blue-soft);
  color: var(--fb-blue);
  font-size: 11px;
}

.detail__tags-empty {
  color: var(--fb-sub);
  font-size: 11px;
}

.detail__tags-edit {
  flex: none;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--fb-blue-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-card);
  color: var(--fb-blue);
  font-family: inherit;
  font-size: 11.5px;
  cursor: pointer;
}

.detail__tags-edit:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.detail__tags-hint {
  width: 100%;
  max-width: 340px;
  margin: 8px auto 0;
  color: var(--fb-sub);
  font-size: 11px;
  line-height: 1.7;
  text-align: center;
}

/* 二级编辑记录：与原生语法片段同款折叠区，默认收起。 */
.detail__history {
  width: 100%;
  max-width: 340px;
  margin: 12px auto 0;
}

.detail__history-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.detail__history-title {
  font-weight: 600;
}

.detail__history-toggle-text {
  font-size: 11px;
}

.detail__history-body {
  margin-top: 8px;
  padding: 10px 12px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-card);
  background: var(--fb-soft);
}

.detail__history-error {
  color: var(--fb-danger);
}

.detail__history-list {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}

.detail__history-item {
  padding: 8px 0;
  border-top: 1px dotted var(--fb-line);
}

.detail__history-item:first-child {
  border-top: none;
}

.detail__history-line {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.detail__history-action {
  color: var(--fb-ink);
  font-size: 11.5px;
  font-weight: 600;
}

.detail__history-meta {
  color: var(--fb-sub);
  font-size: 10.5px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.detail__history-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  margin-top: 5px;
}

.detail__history-tag {
  padding: 1px 6px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-pill);
  color: var(--fb-sub);
  font-size: 10.5px;
}

.detail__history-tag--old {
  border-color: var(--fb-line-strong);
  text-decoration: line-through;
}

.detail__history-tag--new {
  border-color: var(--fb-blue-line);
  background: var(--fb-blue-soft);
  color: var(--fb-blue);
}

.detail__history-arrow {
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
