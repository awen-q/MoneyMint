<script setup lang="ts">
/**
 * C-01 记一笔（最终稿：H5 全屏暖纸账本 + Beancount 双录）
 *
 * - 形态：CSS 断点决定 <1024 全屏 H5 / >=1024 居中 460px 弹窗；JS 仅同步 --vvh。
 * - 视觉：暖纸色板只在本浮层 / 小票作用域生效（tokens.css），不做全站换肤。
 * - 账户：真实数据源 accountApi.list() 的 AccountView；name 是 ASCII 导出名，
 *   display_name 是中文展示名；零硬编码示例账户。
 * - 派生链：form/rows → buildPostings / balanceGroups / buildPostingViews →
 *   buildBeanSnippet → canSubmit → 主操作 disabled。全程 core/Money 定点。
 * - 交互：主操作全局唯一（简化态键盘内保存 / 高级态底部全宽保存互斥）；
 *   无「取消」按钮，关闭只靠 ✕ + 点遮罩自身。
 * - 幂等 / 离线 / 编辑冲正 / 草稿恢复沿用既有口径，选择器契约保持不变。
 */
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'

import {
  accountApi,
  commodityApi,
  newIdempotencyKey,
  transactionApi,
  type TransactionCreateResult,
} from '@/api/client'
import { ApiError } from '@/api/errors'
import type {
  AccountView,
  CommodityView,
  CreateTransactionRequest,
  TransactionView,
  TxnFlag,
} from '@/api/types'
import { currencySymbol, formatMoney, Money } from '@/core/Money'
import {
  accountLabel,
  advancedRowsReady,
  allBalanceGroupsBalanced,
  balanceDiffByCommodity,
  balanceGroups,
  buildPostingViews,
  buildPostings,
  displayEntryOf,
  evaluateAmountExpression,
  resolveAccountCommodity,
  todayString,
  type AdvancedRow,
  type BalanceGroup,
  type PostingDraft,
  type PostingView,
  type RecordForm,
  type RecordKind,
} from '@/core/record'
import { recordFundAccounts } from '@/core/accounts'
import { buildBeanSnippet } from '@/core/bean'
import { clearDraft, readDefaultAccounts, readDraft, setDefaultAccount, writeDraft, type DefaultAccountKind } from '@/core/storage'
import { usePrivacyStore } from '@/stores/privacy'
import { useRecordSheetStore } from '@/stores/recordSheet'
import { useSessionStore } from '@/stores/session'
import { useSyncStore } from '@/stores/sync'
import AdvancedPostings from '@/components/AdvancedPostings.vue'
import PostingPreview from '@/components/PostingPreview.vue'
import ReceiptSlip from '@/components/ReceiptSlip.vue'

const props = withDefaults(
  defineProps<{
    /** auto：按 1024 断点自动切换；其余用于强制指定容器形态。 */
    variant?: 'auto' | 'dialog' | 'sheet' | 'fullscreen'
  }>(),
  { variant: 'auto' },
)

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'saved', result: TransactionCreateResult): void
  /** 编辑保存成功（修改 = 冲正 + 新建），参数为被改交易 uuid。 */
  (event: 'updated', originalUuid: string): void
}>()

const session = useSessionStore()
const sheet = useRecordSheetStore()
const privacy = usePrivacyStore()

const accounts = ref<AccountView[]>([])
const commodities = ref<string[]>([])
const loading = ref(false)
const loadError = ref('')
const submitting = ref(false)
const submitError = ref('')
const notice = ref('')
const showSuccess = ref(false)
/** 由 visualViewport 同步的可视高度（px）；仅用于生命周期诊断，CSS 变量写在 documentElement。 */
const vvh = ref('')
const kbdOpen = ref(false)
/** 自定义数字键盘是否展开：默认收起，让简化态表单一屏可见；高级 / 编辑态不受此状态影响。 */
const keypadOpen = ref(false)

/** 保存成功后的票面快照（与表单解耦，复制/再记不影响展示）。 */
interface ReceiptSnapshot {
  stamp: string
  stampSub: string
  tone: 'green' | 'amber' | 'blue' | 'red'
  kindLabel: string
  amount: string
  commodity: string
  rows: Array<{ label: string; value?: string; tags?: string[] }>
  postings: Array<{ account: string; commodity: string; amount: string }>
  /** 与折叠预览逐字一致的 bean 片段（票面新增区）。 */
  bean: string
  footLines: string[]
  statusLine: string
  statusTone: 'amber' | 'blue'
}

const receipt = ref<ReceiptSnapshot | null>(null)

const KIND_LABELS: Record<RecordKind, string> = {
  expense: '支出 EXPENSE',
  income: '收入 INCOME',
  transfer: '转账 TRANSFER',
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** 保存时刻（本地时区 `YYYY-MM-DD HH:mm:ss`）。 */
function nowText(): string {
  const now = new Date()
  const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
  return `${date} ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`
}

/** 票尾流水号：uuid 去连字符取前 8 位（`loc-` 前缀不展示）。 */
function shortCode(uuid: string): string {
  const raw = uuid.indexOf('loc-') === 0 ? uuid.slice(4) : uuid
  const compact = raw.split('-').join('')
  return compact === '' ? '--------' : compact.slice(0, 8)
}

/** 中文名优先（既有 accountLabel 口径），小票分录表沿用。 */
function accountNameOf(accountId: number): string {
  for (const account of accounts.value) {
    if (account.id === accountId) {
      return accountLabel(account)
    }
  }
  return `账户 #${accountId}`
}

// ---------- 0.6.0 S6：编辑态（修改 = 冲正 + 新建） ----------
const editingTxn = computed<TransactionView | null>(() => sheet.editingTxn)
/** 用 != null 宽松判定：旧测试替身 / 异常环境下 editingTxn 为 undefined 时按新建态处理。 */
const isEditing = computed(() => editingTxn.value != null)

const form = reactive<RecordForm>({
  kind: 'expense',
  amountExpression: '',
  date: todayString(),
  flag: '*',
  description: '',
  tags: [],
  categoryAccountId: null,
  fundAccountId: null,
  transferFromAccountId: null,
  transferToAccountId: null,
  advancedPostings: [],
})

const advancedMode = ref(false)
const advancedError = ref('')

/** 进入编辑态后，待账户列表就绪即预填（日期 / flag / 描述 / 标签 / 分录走高级双录）。 */
function prefillFromEditTxn(): void {
  const txn = editingTxn.value
  if (txn === null) {
    return
  }
  form.date = txn.date
  form.flag = txn.flag === '!' ? '!' : '*'
  form.description = txn.description
  form.tags = Array.isArray(txn.tags) ? txn.tags.slice() : []
  form.advancedPostings = txn.postings.map((posting) => ({
    accountId: posting.account_id,
    amount: posting.amount,
    commodity: posting.commodity === undefined || posting.commodity === '' ? session.defaultCommodity : posting.commodity,
  }))
  advancedMode.value = true
  keypadOpen.value = false
}

// 幂等键生命周期：提交成功 / 表单语义变化后换新键，纯网络重试复用。
let idempotencyKey: string | null = null
let lastPayloadJson = ''

const tabs: Array<{ key: RecordKind; label: string }> = [
  { key: 'expense', label: '支出' },
  { key: 'income', label: '收入' },
  { key: 'transfer', label: '转账' },
]
const keyboardKeys: string[] = [
  '7', '8', '9', '⌫',
  '4', '5', '6', '＋',
  '1', '2', '3', '－',
  '.', '0', '再记', '保存',
]

const containerClass = computed(() =>
  props.variant === 'auto' ? 'rs-mask--auto' : `rs-mask--${props.variant}`,
)

const openAccounts = computed(() => accounts.value.filter((account) => !account.close_date))
const expenseAccounts = computed(() => openAccounts.value.filter((account) => account.type === 'Expenses'))
const incomeAccounts = computed(() => openAccounts.value.filter((account) => account.type === 'Income'))
const fundAccounts = computed(() => recordFundAccounts(accounts.value))
const categoryOptions = computed(() =>
  form.kind === 'income' ? incomeAccounts.value : expenseAccounts.value,
)
/** 九宫格只取前 9 个（不足按实际数量渲染并给空态）。 */
const categoryGrid = computed(() => categoryOptions.value.slice(0, 9))

const selectedCategory = computed(() =>
  categoryOptions.value.find((account) => account.id === form.categoryAccountId),
)
/** 已选回显：中文主文案 + 真实导出名小字。 */
const selectedCategoryLabel = computed(() => {
  const found = selectedCategory.value
  return found === undefined ? '' : accountLabel(found)
})
const selectedCategoryName = computed(() =>
  selectedCategory.value === undefined ? '' : selectedCategory.value.name,
)

const amountMoney = computed<Money>(() => {
  if (form.amountExpression === '') {
    return Money.zero()
  }
  try {
    return evaluateAmountExpression(form.amountExpression)
  } catch {
    return Money.zero()
  }
})
const amountDisplay = computed(() => amountMoney.value.formatAmount())
const currency = computed(() => {
  const symbol = currencySymbol(session.defaultCommodity)
  return symbol !== '' ? symbol : session.defaultCommodity
})
const commodityCode = computed(() => (session.defaultCommodity === '' ? 'CNY' : session.defaultCommodity))

const snapshot = (): RecordForm => ({ ...form, tags: form.tags.slice(), advancedPostings: (form.advancedPostings ?? []).map((row) => ({ ...row })) })

/** 简化态分录（buildPostings 失败时不参与派生，由 previewError 给出原因）。 */
const preview = computed<PostingDraft[]>(() => {
  if (accounts.value.length === 0) {
    return []
  }
  try {
    return buildPostings(snapshot(), accounts.value, session.defaultCommodity)
  } catch {
    return []
  }
})
const previewError = computed<string>(() => {
  if (accounts.value.length === 0) {
    return '账户列表加载中…'
  }
  if (advancedMode.value) {
    return ''
  }
  try {
    buildPostings(snapshot(), accounts.value, session.defaultCommodity)
    return ''
  } catch (err) {
    return err instanceof Error ? err.message : '表单校验失败'
  }
})

/** 高级态的草稿分录（含未选账户 / 不平），供配平卡与预览实时展示。 */
const advancedDrafts = computed<PostingDraft[]>(() =>
  (form.advancedPostings ?? []).map((row) => {
    const account = accounts.value.find((item) => item.id === row.accountId)
    return {
      accountId: row.accountId === null ? -1 : row.accountId,
      accountName: account === undefined ? '' : accountLabel(account),
      commodity: row.commodity === '' || row.commodity === undefined ? commodityCode.value : row.commodity,
      amount: row.amount === '' ? '0.00' : row.amount,
    }
  }),
)

/** 当前生效分录：简化态走 buildPostings，高级态走逐行草稿。 */
const activePostings = computed<PostingDraft[]>(() => (advancedMode.value ? advancedDrafts.value : preview.value))
const postingViews = computed<PostingView[]>(() =>
  buildPostingViews(
    activePostings.value.map((posting) => ({
      accountId: posting.accountId,
      commodity: posting.commodity,
      amount: posting.amount,
    })),
    accounts.value,
  ),
)
const balanceGroupList = computed<BalanceGroup[]>(() => balanceGroups(activePostings.value))
const balanced = computed(() => allBalanceGroupsBalanced(balanceGroupList.value))

/** bean 片段：account.name（真实 ASCII 导出名），中文标签走 tags 元数据行。 */
const beanText = computed(() =>
  buildBeanSnippet({
    date: form.date,
    flag: form.flag === '!' ? '!' : '*',
    description: form.description.trim() === '' ? defaultDescription() : form.description.trim(),
    tags: form.tags,
    postings: activePostings.value.map((posting) => {
      const account = accounts.value.find((item) => item.id === posting.accountId)
      return {
        accountName: account === undefined ? '' : account.name,
        amount: posting.amount,
        commodity: posting.commodity,
      }
    }),
  }),
)

/** 高级态守门：与 AdvancedPostings 共用 core/record 的 advancedRowsReady，避免两处漂移。 */
const advancedCanSubmit = computed(() => advancedRowsReady(form.advancedPostings ?? [], commodityCode.value))

const canSubmit = computed(
  () =>
    !submitting.value &&
    accounts.value.length > 0 &&
    session.ledgerId !== null &&
    !session.isViewer &&
    (advancedMode.value ? advancedCanSubmit.value : preview.value.length > 0),
)

const tagsText = computed(() => form.tags.join(' '))
const categorySelectValue = computed(() =>
  form.categoryAccountId === null ? '' : String(form.categoryAccountId),
)
const fundValue = computed(() => (form.fundAccountId === null ? '' : String(form.fundAccountId)))
const transferFromValue = computed(() =>
  form.transferFromAccountId === null ? '' : String(form.transferFromAccountId),
)
const transferToValue = computed(() =>
  form.transferToAccountId === null ? '' : String(form.transferToAccountId),
)

function resetIdempotencyKey(): void {
  idempotencyKey = null
  lastPayloadJson = ''
}

function clearDraftIfPossible(): void {
  if (session.ledgerId !== null) {
    clearDraft(session.ledgerId)
  }
}

/** 恢复草稿（不含凭据），逐字段类型校验；flag 也进快照，避免刷新丢失。 */
function restoreDraft(): void {
  if (session.ledgerId === null) {
    return
  }
  const draft = readDraft<Partial<RecordForm>>(session.ledgerId)
  if (draft === null) {
    return
  }
  if (draft.kind === 'expense' || draft.kind === 'income' || draft.kind === 'transfer') {
    form.kind = draft.kind
  }
  if (typeof draft.amountExpression === 'string') {
    form.amountExpression = draft.amountExpression
  }
  if (typeof draft.date === 'string' && draft.date !== '') {
    form.date = draft.date
  }
  if (draft.flag === '*' || draft.flag === '!') {
    form.flag = draft.flag
  }
  if (typeof draft.description === 'string') {
    form.description = draft.description
  }
  if (Array.isArray(draft.tags)) {
    form.tags = draft.tags.filter((tag): tag is string => typeof tag === 'string')
  }
  if (typeof draft.categoryAccountId === 'number') {
    form.categoryAccountId = draft.categoryAccountId
  }
  if (typeof draft.fundAccountId === 'number') {
    form.fundAccountId = draft.fundAccountId
  }
  if (typeof draft.transferFromAccountId === 'number') {
    form.transferFromAccountId = draft.transferFromAccountId
  }
  if (typeof draft.transferToAccountId === 'number') {
    form.transferToAccountId = draft.transferToAccountId
  }
  if (Array.isArray(draft.advancedPostings)) {
    const rows: AdvancedRow[] = []
    for (const row of draft.advancedPostings) {
      if (
        typeof row === 'object' &&
        row !== null &&
        typeof (row as { accountId?: unknown }).accountId === 'number' &&
        typeof (row as { amount?: unknown }).amount === 'string'
      ) {
        rows.push({
          accountId: (row as { accountId: number }).accountId,
          amount: (row as { amount: string }).amount,
          commodity: typeof (row as { commodity?: unknown }).commodity === 'string'
            ? (row as { commodity: string }).commodity
            : '',
        })
      }
    }
    form.advancedPostings = rows
  }
  notice.value = '已恢复上次未提交的表单草稿'
}

/** 按 uuid 反查可用账户 id；已删除 / 已关户返回 null。 */
function defaultAccountId(uuid: string | undefined): number | null {
  if (uuid === undefined || uuid === '') {
    return null
  }
  for (const account of accounts.value) {
    if (account.uuid === uuid && !account.close_date) {
      return account.id
    }
  }
  return null
}

function uuidOf(accountId: number | null): string {
  if (accountId === null) {
    return ''
  }
  for (const account of accounts.value) {
    if (account.id === accountId && typeof account.uuid === 'string') {
      return account.uuid
    }
  }
  return ''
}

/** 默认账户预选：草稿已指定优先，失效记忆回退首个可用并提示。 */
function applyDefaultAccounts(): void {
  const id = session.ledgerId
  if (id === null) {
    return
  }
  const defaults = readDefaultAccounts(id)
  const categoryIds: number[] = categoryOptions.value.map((account) => account.id)
  const fundIds: number[] = fundAccounts.value.map((account) => account.id)
  let invalid = false

  const applyField = (
    field: 'categoryAccountId' | 'transferFromAccountId' | 'transferToAccountId',
    uuid: string | undefined,
    allowed: number[],
  ): void => {
    if (form[field] !== null || uuid === undefined || uuid === '') {
      return
    }
    const found = defaultAccountId(uuid)
    if (found !== null && allowed.indexOf(found) >= 0) {
      form[field] = found
    } else if (found === null) {
      invalid = true
    }
  }

  applyField('categoryAccountId', form.kind === 'income' ? defaults.income : defaults.expense, categoryIds)
  applyField('transferFromAccountId', defaults.transferOut, fundIds)
  applyField('transferToAccountId', defaults.transferIn, fundIds)
  if (invalid) {
    notice.value = '默认账户已失效，已回退为首个可用账户'
  }
}

function rememberDefaults(): void {
  const id = session.ledgerId
  if (id === null) {
    return
  }
  if (form.kind === 'transfer') {
    setDefaultAccount(id, 'transferOut', uuidOf(form.transferFromAccountId))
    setDefaultAccount(id, 'transferIn', uuidOf(form.transferToAccountId))
  } else {
    const kind: DefaultAccountKind = form.kind
    setDefaultAccount(id, kind, uuidOf(form.categoryAccountId))
  }
}

async function loadAccounts(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const res = await accountApi.list()
    accounts.value = Array.isArray(res.accounts) ? res.accounts : []
    if (isEditing.value) {
      prefillFromEditTxn()
      loading.value = false
      return
    }
    applyDefaultAccounts()
    if (form.fundAccountId === null && fundAccounts.value.length > 0) {
      form.fundAccountId = fundAccounts.value[0].id
    }
    if (form.categoryAccountId === null && categoryOptions.value.length > 0) {
      form.categoryAccountId = categoryOptions.value[0].id
    }
    if (form.transferFromAccountId === null && fundAccounts.value.length > 0) {
      form.transferFromAccountId = fundAccounts.value[0].id
    }
    if (form.transferToAccountId === null && fundAccounts.value.length > 1) {
      form.transferToAccountId = fundAccounts.value[1].id
    }
  } catch (err) {
    loadError.value = err instanceof ApiError ? err.message : '账户列表加载失败'
  } finally {
    loading.value = false
  }
}

/**
 * 币种列表：commodityApi.list() 优先，失败 / 未 mock 时兜底账本默认币种与 CNY 去重。
 * 既有测试的 @/api/client mock 只提供 accountApi/transactionApi，故必须做存在性守卫。
 */
async function loadCommodities(): Promise<void> {
  const found: string[] = []
  try {
    if (commodityApi !== undefined && typeof commodityApi.list === 'function') {
      const res = await commodityApi.list()
      const list: CommodityView[] = Array.isArray(res.commodities) ? res.commodities : []
      for (const item of list) {
        if (typeof item.symbol === 'string' && item.symbol !== '' && found.indexOf(item.symbol) < 0) {
          found.push(item.symbol)
        }
      }
    }
  } catch {
    // 币种列表只影响高级态下拉，失败走兜底，不阻塞记账。
  }
  for (const fallback of [session.defaultCommodity, 'CNY']) {
    if (fallback !== '' && found.indexOf(fallback) < 0) {
      found.push(fallback)
    }
  }
  commodities.value = found
}

function selectedId(event: Event): number | null {
  const target = event.target as HTMLSelectElement
  if (target.value === '') {
    return null
  }
  const id = Number(target.value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function onCategorySelect(event: Event): void {
  form.categoryAccountId = selectedId(event)
}

function onFundSelect(event: Event): void {
  form.fundAccountId = selectedId(event)
}

function onTransferFrom(event: Event): void {
  form.transferFromAccountId = selectedId(event)
}

function onTransferTo(event: Event): void {
  form.transferToAccountId = selectedId(event)
}

/** 标签兼容空格与中英文逗号（[\s,，]+），导出统一单空格。 */
function onTagsChange(event: Event): void {
  const raw = (event.target as HTMLInputElement).value
  const parts = raw.split(/[\s,，]+/)
  const tags: string[] = []
  for (const part of parts) {
    const trimmed = part.trim()
    if (trimmed !== '') {
      tags.push(trimmed)
    }
  }
  form.tags = tags
}

function selectCategory(id: number): void {
  form.categoryAccountId = id
}

function switchKind(kind: RecordKind): void {
  form.kind = kind
  if (kind === 'income' || kind === 'expense') {
    const defaults = session.ledgerId === null ? {} : readDefaultAccounts(session.ledgerId)
    const preferred = defaultAccountId(kind === 'income' ? defaults.income : defaults.expense)
    const options = kind === 'income' ? incomeAccounts.value : expenseAccounts.value
    const allowed = preferred !== null && options.some((account) => account.id === preferred)
    form.categoryAccountId = allowed && preferred !== null ? preferred : options.length > 0 ? options[0].id : null
  }
  submitError.value = ''
  notice.value = ''
}

function currentSegment(expr: string): string {
  let start = 0
  for (let i = expr.length - 1; i >= 0; i -= 1) {
    const ch = expr.charAt(i)
    if (ch === '+' || ch === '-') {
      start = i + 1
      break
    }
  }
  return expr.slice(start)
}

function pressKey(key: string): void {
  if (key === '保存' || key === '再记') {
    // 主操作守门：键盘动作键与底部保存条共用 canSubmit。
    if (!canSubmit.value) {
      return
    }
    void submit(key === '再记')
    return
  }
  if (key === '⌫') {
    form.amountExpression = form.amountExpression.slice(0, -1)
    return
  }
  if (key === '＋' || key === '－') {
    const last = form.amountExpression.slice(-1)
    if (last === '+' || last === '-') {
      form.amountExpression = form.amountExpression.slice(0, -1)
    }
    if (form.amountExpression === '') {
      return
    }
    form.amountExpression += key === '＋' ? '+' : '-'
    return
  }
  const segment = currentSegment(form.amountExpression)
  if (key === '.') {
    if (segment.indexOf('.') >= 0) {
      return
    }
    form.amountExpression += segment === '' ? '0.' : '.'
    return
  }
  if (/^[0-9]$/.test(key)) {
    const dot = segment.indexOf('.')
    if (dot >= 0 && segment.length - dot - 1 >= 2) {
      return
    }
    form.amountExpression += key
  }
}

function isActionKey(key: string): boolean {
  return key === '保存' || key === '再记'
}

function keyClass(key: string): string {
  if (key === '保存') {
    return 'rs-key rs-key--save js-save'
  }
  if (key === '再记') {
    return 'rs-key rs-key--again'
  }
  if (key === '⌫' || key === '＋' || key === '－') {
    return 'rs-key rs-key--op'
  }
  return 'rs-key'
}

function defaultDescription(): string {
  if (form.kind === 'transfer') {
    return '转账'
  }
  const category = categoryOptions.value.find((account) => account.id === form.categoryAccountId)
  return category === undefined ? '记一笔' : accountLabel(category)
}

function balanceText(account: AccountView): string {
  if (privacy.enabled) {
    return '••••'
  }
  const balances = account.balances
  if (balances === undefined) {
    return formatMoney('0.00', session.defaultCommodity)
  }
  const value = balances[session.defaultCommodity]
  return formatMoney(value === undefined ? '0.00' : value, session.defaultCommodity)
}

function catIcon(account: AccountView): string {
  return account.icon !== undefined && account.icon !== '' ? account.icon : '📁'
}

function isThirdLevel(account: AccountView): boolean {
  return account.name.indexOf(':') >= 0 && (account.parent_uuid !== undefined && account.parent_uuid !== '')
}

// ─────────── 高级双录：父组件持有 rows，子组件受控 ───────────

function rowsWithCommodity(rows: Array<{ accountId: number | null; amount: string; commodity?: string }>): AdvancedRow[] {
  return rows.map((row) => {
    const account = accounts.value.find((item) => item.id === row.accountId)
    const commodity = row.commodity !== undefined && row.commodity !== ''
      ? row.commodity
      : account === undefined
        ? commodityCode.value
        : resolveAccountCommodity(account, commodityCode.value)
    return { accountId: row.accountId, amount: row.amount, commodity }
  })
}

function defaultAdvancedRows(): AdvancedRow[] {
  const rows: AdvancedRow[] = openAccounts.value.slice(0, 2).map((account) => ({
    accountId: account.id,
    amount: '',
    commodity: resolveAccountCommodity(account, commodityCode.value),
  }))
  while (rows.length < 2) {
    const first = openAccounts.value[0]
    rows.push({
      accountId: first === undefined ? null : first.id,
      amount: '',
      commodity: first === undefined ? commodityCode.value : resolveAccountCommodity(first, commodityCode.value),
    })
  }
  return rows
}

/** 进入高级模式以简化态分录预填；退出即清空（同一 form 字段，草稿自动跟随）。 */
function toggleAdvanced(): void {
  advancedError.value = ''
  keypadOpen.value = false
  if (!advancedMode.value) {
    const current = preview.value
    form.advancedPostings = current.length > 0
      ? rowsWithCommodity(current.map((posting) => ({ accountId: posting.accountId, amount: posting.amount, commodity: posting.commodity })))
      : defaultAdvancedRows()
  } else {
    form.advancedPostings = []
  }
  advancedMode.value = !advancedMode.value
}

/** 子组件 emit 的新行写回表单（草稿 watch 自动落盘）。 */
function onAdvancedRows(next: AdvancedRow[]): void {
  form.advancedPostings = rowsWithCommodity(next)
  advancedError.value = ''
  resetIdempotencyKey()
}

/** 高级双录分录构造：账户必选 + 金额非空 + 按币种配平；不平返回 null。 */
function buildAdvancedPostings(): PostingDraft[] | null {
  advancedError.value = ''
  const rows = form.advancedPostings ?? []
  if (rows.length < 2) {
    advancedError.value = '高级双录至少需要 2 条分录'
    return null
  }
  const drafts: PostingDraft[] = []
  for (const row of rows) {
    if (row.accountId === null) {
      advancedError.value = '存在未选择账户的分录'
      return null
    }
    const account = accounts.value.find((item) => item.id === row.accountId)
    if (account === undefined) {
      advancedError.value = '分录账户不在当前账本'
      return null
    }
    if (row.amount.trim() === '') {
      advancedError.value = '存在空金额的分录'
      return null
    }
    let value: Money
    try {
      value = Money.from(row.amount)
    } catch {
      advancedError.value = '分录金额格式不正确'
      return null
    }
    if (value.isZero()) {
      advancedError.value = '分录金额不能为 0'
      return null
    }
    drafts.push({
      accountId: row.accountId,
      accountName: accountLabel(account),
      commodity: row.commodity === '' ? commodityCode.value : row.commodity,
      amount: value.toString(),
    })
  }
  const diffs = balanceDiffByCommodity(drafts)
  if (diffs.length > 0) {
    const parts: string[] = []
    for (const diff of diffs) {
      parts.push(`${diff.commodity} 差额 ${diff.diff}`)
    }
    advancedError.value = `分录不配平：${parts.join('；')}`
    return null
  }
  return drafts
}

/**
 * 按提交载荷生成票面快照。
 * mode：saved / idempotent / offline / updated（PATCH 冲正 + 新建）。
 */
function buildReceipt(
  mode: 'saved' | 'idempotent' | 'offline' | 'updated',
  payload: CreateTransactionRequest,
  uuid: string,
): ReceiptSnapshot {
  const entry = displayEntryOf(payload.postings, accounts.value)
  const commodity = entry.commodity !== '' ? entry.commodity : session.defaultCommodity
  const rows: Array<{ label: string; value?: string; tags?: string[] }> = [
    { label: '日期', value: payload.date },
    { label: '备注', value: payload.description },
  ]
  const tags = payload.tags ?? []
  if (tags.length > 0) {
    rows.push({ label: '标签', tags })
  }

  const stampMap: Record<
    typeof mode,
    { stamp: string; stampSub: string; tone: ReceiptSnapshot['tone'] }
  > = {
    saved: { stamp: '已保存', stampSub: 'SAVED', tone: 'green' },
    idempotent: { stamp: '未重复', stampSub: 'IDEMPOTENT', tone: 'blue' },
    offline: { stamp: '待同步', stampSub: 'OFFLINE', tone: 'amber' },
    updated: { stamp: '已修改', stampSub: 'UPDATED', tone: 'green' },
  }
  const stamp = stampMap[mode]

  let footLines: string[] = []
  let statusLine = ''
  let statusTone: ReceiptSnapshot['statusTone'] = 'amber'
  if (mode === 'saved') {
    const ledgerName = session.ledgerName === undefined || session.ledgerName === '' ? '家庭账本' : session.ledgerName
    footLines = [`${nowText()} · ${ledgerName}`, `TXN ${shortCode(uuid)}`]
  } else if (mode === 'idempotent') {
    footLines = [`${nowText()} · 未新增交易`, `TXN ${shortCode(uuid)}`]
    statusLine = '本次为重复提交的幂等命中，账本中仅一笔'
    statusTone = 'blue'
  } else if (mode === 'offline') {
    footLines = [`${nowText()} · 本机待推送`, `LOCAL ${shortCode(uuid)}`]
    statusLine = '当前离线，已保存在本机，联网后自动同步'
  } else {
    footLines = [`${nowText()} · 原交易已冲正`, `NEW ${shortCode(uuid)}`]
    statusLine = '修改已保存：原交易已冲正，账目以新交易为准'
    statusTone = 'blue'
  }

  return {
    stamp: stamp.stamp,
    stampSub: stamp.stampSub,
    tone: stamp.tone,
    kindLabel: KIND_LABELS[form.kind],
    amount: Money.from(entry.amount).abs().toString(),
    commodity,
    rows,
    postings: payload.postings.map((posting) => ({
      account: accountNameOf(posting.account_id),
      commodity: posting.commodity,
      amount: posting.amount,
    })),
    bean: beanText.value,
    footLines,
    statusLine,
    statusTone,
  }
}

/** 提交：幂等 / 离线 / 冲正分支；postings 全为整数 account_id，flag 随用户选择。 */
async function submit(continueAfter: boolean): Promise<void> {
  if (submitting.value) {
    return
  }
  submitError.value = ''
  if (session.isViewer) {
    submitError.value = '只读成员不能记账'
    return
  }
  if (session.ledgerId === null) {
    submitError.value = '尚未选择账本，无法提交'
    return
  }

  let postings: PostingDraft[]
  if (advancedMode.value) {
    const built = buildAdvancedPostings()
    if (built === null) {
      submitError.value = advancedError.value === '' ? '高级分录校验失败' : advancedError.value
      return
    }
    postings = built
  } else {
    try {
      postings = buildPostings(snapshot(), accounts.value, session.defaultCommodity)
    } catch (err) {
      submitError.value = err instanceof Error ? err.message : '表单校验失败'
      return
    }
  }
  const flag: TxnFlag = form.flag === '!' ? '!' : '*'
  const payload: CreateTransactionRequest = {
    date: form.date,
    flag,
    description: form.description.trim() !== '' ? form.description.trim() : defaultDescription(),
    tags: form.tags.slice(),
    postings: postings.map((posting) => ({
      account_id: posting.accountId,
      commodity: posting.commodity,
      amount: posting.amount,
    })),
  }
  const payloadJson = JSON.stringify(payload)

  // 编辑态：PATCH 冲正 + 新建，仅在线、无幂等键、无离线兜底。
  if (isEditing.value) {
    const target = editingTxn.value
    if (target === null) {
      submitError.value = '编辑会话已失效，请重新进入'
      return
    }
    submitting.value = true
    try {
      const result = await transactionApi.update(target.uuid, payload)
      sheet.notifyChanged()
      emit('updated', target.uuid)
      receipt.value = buildReceipt('updated', payload, result.new_uuid)
      showSuccess.value = true
      notice.value = '修改已保存：原交易已冲正，账目以新交易为准'
    } catch (err) {
      if (err instanceof ApiError && err.code === 'network_error') {
        submitError.value = '修改需联网，请恢复网络后重试'
      } else {
        submitError.value = err instanceof ApiError ? err.message : '修改失败，请稍后重试'
      }
    } finally {
      submitting.value = false
    }
    return
  }

  if (idempotencyKey === null || (lastPayloadJson !== '' && lastPayloadJson !== payloadJson)) {
    idempotencyKey = newIdempotencyKey()
  }
  lastPayloadJson = payloadJson

  submitting.value = true
  try {
    const result = await transactionApi.create(payload, idempotencyKey)
    clearDraftIfPossible()
    resetIdempotencyKey()
    receipt.value = buildReceipt(
      result.idempotent === true ? 'idempotent' : 'saved',
      payload,
      result.uuid,
    )
    rememberDefaults()
    sheet.notifySaved(result)
    emit('saved', result)
    if (continueAfter) {
      resetForm()
      notice.value = '已保存，可继续记一笔'
    } else {
      showSuccess.value = true
    }
  } catch (err) {
    if (err instanceof ApiError && err.code === 'network_error') {
      const offlineUuid = await saveOffline(payload)
      if (offlineUuid !== null) {
        clearDraftIfPossible()
        resetIdempotencyKey()
        rememberDefaults()
        receipt.value = buildReceipt('offline', payload, offlineUuid)
        notice.value = '当前离线，已保存在本机，联网后自动同步'
        showSuccess.value = true
        return
      }
    }
    submitError.value = err instanceof ApiError ? err.message : '保存失败，请检查网络后重试'
    if (
      err instanceof ApiError &&
      (err.code === 'idempotency_key_deleted' || err.code === 'idempotency_payload_mismatch')
    ) {
      resetIdempotencyKey()
    }
  } finally {
    submitting.value = false
  }
}

/** 离线保存：account_id → account_uuid，本地落库并入待推队列。 */
async function saveOffline(payload: CreateTransactionRequest): Promise<string | null> {
  const syncStore = useSyncStore()
  const uuidPostings: Array<{ account_uuid: string; commodity: string; amount: string }> = []
  for (const posting of payload.postings) {
    const account = accounts.value.find((item) => item.id === posting.account_id)
    if (account === undefined || account.uuid === '') {
      return null
    }
    uuidPostings.push({
      account_uuid: account.uuid,
      commodity: posting.commodity,
      amount: posting.amount,
    })
  }
  const txn = {
    uuid: `loc-${newIdempotencyKey()}`,
    date: payload.date,
    flag: payload.flag ?? '*',
    description: payload.description,
    tags: payload.tags ?? [],
    postings: uuidPostings,
  }
  await syncStore.recordTxnOffline(txn, {
    entity_type: 'transaction',
    key: txn.uuid,
    entity: { ...txn },
  })
  return txn.uuid
}

function resetForm(): void {
  form.amountExpression = ''
  form.description = ''
  form.tags = []
  form.advancedPostings = []
  resetIdempotencyKey()
  showSuccess.value = false
  receipt.value = null
  submitError.value = ''
  advancedError.value = ''
  clearDraftIfPossible()
}

function again(): void {
  resetForm()
  notice.value = '已清空金额，可继续记一笔'
}

function copyLast(): void {
  resetIdempotencyKey()
  showSuccess.value = false
  notice.value = '已复制上一笔，可修改后保存'
}

function close(): void {
  emit('close')
}

// ─────────── 形态与键盘避让：副作用必须成对清理 ───────────

function syncVv(): void {
  const viewport = typeof window === 'undefined' ? null : window.visualViewport
  const height = viewport !== null && viewport !== undefined ? viewport.height : window.innerHeight
  const next = `${Math.round(height)}px`
  vvh.value = next
  document.documentElement.style.setProperty('--vvh', next)
}

function onFocusIn(event: Event): void {
  const target = event.target as HTMLElement
  if (target !== null && typeof target.matches === 'function' && target.matches('input.inp-text, textarea.inp-text')) {
    // 系统键盘接手时收起自定义键盘，两个键盘不共存。
    keypadOpen.value = false
    kbdOpen.value = true
    document.body.classList.add('kbd-open')
  }
}

function onFocusOut(event: Event): void {
  const target = event.target as HTMLElement
  if (target !== null && typeof target.matches === 'function' && target.matches('input.inp-text, textarea.inp-text')) {
    kbdOpen.value = false
    document.body.classList.remove('kbd-open')
  }
}

/** 展开自定义键盘（简化态金额区的唯一入口）；高级 / 编辑态直接忽略。 */
function openKeypad(): void {
  if (advancedMode.value || isEditing.value) {
    return
  }
  // 反向互斥：若系统键盘因表单聚焦而弹起，先失焦（focusout 会清掉 kbd-open）。
  const active = document.activeElement as HTMLElement | null
  if (
    active !== null &&
    typeof active.matches === 'function' &&
    typeof active.blur === 'function' &&
    active.matches('input.inp-text, textarea.inp-text')
  ) {
    active.blur()
  }
  keypadOpen.value = true
}

/** 收起自定义键盘，让表单区重新占满屏幕；不影响 body.kbd-open（系统键盘另有生命周期）。 */
function hideKeypad(): void {
  keypadOpen.value = false
}

onMounted(() => {
  restoreDraft()
  void loadAccounts()
  void loadCommodities()
  syncVv()
  window.addEventListener('resize', syncVv)
  if (window.visualViewport !== undefined && window.visualViewport !== null) {
    window.visualViewport.addEventListener('resize', syncVv)
  }
  document.addEventListener('focusin', onFocusIn)
  document.addEventListener('focusout', onFocusOut)
})

onUnmounted(() => {
  window.removeEventListener('resize', syncVv)
  if (window.visualViewport !== undefined && window.visualViewport !== null) {
    window.visualViewport.removeEventListener('resize', syncVv)
  }
  document.removeEventListener('focusin', onFocusIn)
  document.removeEventListener('focusout', onFocusOut)
  document.body.classList.remove('kbd-open')
  document.documentElement.style.removeProperty('--vvh')
  kbdOpen.value = false
})

// 草稿按账本命名空间暂存，刷新可恢复。编辑态 / 成功态不写草稿；
// flag 已在 snapshot() 中，刷新后不会丢失。
watch(
  () => JSON.stringify(snapshot()),
  () => {
    if (session.ledgerId !== null && !showSuccess.value && !isEditing.value) {
      writeDraft(session.ledgerId, snapshot())
    }
  },
)

watch(
  () => session.ledgerId,
  () => {
    accounts.value = []
    commodities.value = []
    resetIdempotencyKey()
    restoreDraft()
    void loadAccounts()
    void loadCommodities()
  },
)
</script>

<template>
  <div
    class="rs-mask"
    :class="[containerClass, { 'rs-mask--receipt': showSuccess }]"
    @click.self="close"
  >
    <section
      class="rs-panel"
      :class="{ 'rs-panel--receipt': showSuccess }"
      role="dialog"
      aria-modal="true"
      aria-label="记一笔"
    >
      <!-- 成功态：票面即主体，不套白卡 / 标题栏 / 底部键盘 -->
      <div v-if="showSuccess" class="rs-receipt">
        <ReceiptSlip
          v-if="receipt !== null"
          :stamp="receipt.stamp"
          :stamp-sub="receipt.stampSub"
          :tone="receipt.tone"
          title="家庭账本"
          subtitle="FAMBEAN · DOUBLE-ENTRY JOURNAL"
          :amount="receipt.amount"
          :commodity="receipt.commodity"
          :kind-label="receipt.kindLabel"
          :rows="receipt.rows"
          :postings="receipt.postings"
          :bean="receipt.bean"
          :balanced="true"
          :foot-lines="receipt.footLines"
          :thanks="isEditing ? '— 修 改 完 成 —' : '— 感 谢 记 账 —'"
        />
        <p
          v-if="receipt !== null && receipt.statusLine !== ''"
          class="rs-receipt__status"
          :class="`rs-receipt__status--${receipt.statusTone}`"
          role="status"
        >{{ receipt.statusLine }}</p>
        <div class="rs-receipt__actions">
          <template v-if="!isEditing">
            <button type="button" class="rs-rcpt-btn rs-rcpt-btn--text" @click="close">返回</button>
            <button type="button" class="rs-rcpt-btn rs-rcpt-btn--ghost" @click="copyLast">复制上一笔</button>
            <button type="button" class="rs-rcpt-btn rs-rcpt-btn--primary" @click="again">再记一笔</button>
          </template>
          <button v-else type="button" class="rs-rcpt-btn rs-rcpt-btn--primary" @click="close">完成</button>
        </div>
      </div>

      <template v-else>
        <header class="rs-head">
          <div class="head-left">
            <span class="head-mark">¥</span>
            <div>
              <h3>{{ isEditing ? '修改交易' : '记一笔' }}</h3>
              <p class="head-sub">家庭账本 · {{ form.date }}</p>
            </div>
          </div>
          <button class="rs-close" type="button" aria-label="关闭记一笔" @click="close">✕</button>
        </header>

        <!-- 编辑态固定文案：原交易将被冲正 + 仅在线；绝不出现「已保存在本机」 -->
        <p v-if="isEditing" class="rs-editbanner" role="status">
          <span class="eb-icon">ⓘ</span>
          正在修改「{{ editingTxn?.description }}」：保存后原交易将被冲正，账目以新交易为准，仅在线提交。
        </p>

        <div class="rs-stage">
          <div class="rs-tabs" role="tablist">
            <button
              v-for="tab in tabs"
              :key="tab.key"
              type="button"
              role="tab"
              :aria-selected="form.kind === tab.key"
              :data-act="'tab'"
              :data-tab="tab.key"
              :class="{ on: form.kind === tab.key }"
              @click="switchKind(tab.key)"
            >{{ tab.label }}</button>
          </div>
          <div
            class="rs-amount"
            :class="{ 'is-zero': !canSubmit, 'rs-amount--tap': !advancedMode && !isEditing }"
            role="button"
            tabindex="0"
            data-act="amount"
            aria-label="点此输入金额"
            @click="openKeypad"
            @keydown.enter.prevent="openKeypad"
            @keydown.space.prevent="openKeypad"
          >
            <div class="amt-top">
              <span class="amt-cap">{{ form.kind === 'income' ? '收入金额' : form.kind === 'transfer' ? '转账金额' : '支出金额' }}</span>
              <span class="amt-meta"><span class="amt-cur-tag js-amount-cur">{{ commodityCode }}</span></span>
            </div>
            <div class="amt-line">
              <span class="amt-sym">{{ currency }}</span>
              <span class="amt-val js-amount">{{ amountDisplay }}</span>
              <span class="amt-caret"></span>
            </div>
            <div class="amt-sub">
              {{ advancedMode
                ? '高级模式下分录由下方逐条编辑，上方金额仅作参考；按币种合计为 0 才能保存。'
                : form.kind === 'transfer'
                  ? '转出账户减少、转入账户增加，不产生收支分类；两行分录自动配平。'
                  : form.kind === 'income'
                    ? '资金账户记正数，收入分类记负数；按币种合计为 0 才能保存。'
                    : '资金账户记负数，支出分类记正数；按币种合计为 0 才能保存。' }}
            </div>
            <div v-if="notice" class="rs-notice"><span>✓</span>{{ notice }}</div>
          </div>
        </div>

        <div v-if="loadError" class="rs-alert rs-alert--error">
          {{ loadError }}<button type="button" @click="loadAccounts">重试</button>
        </div>
        <div v-if="submitError" class="rs-alert rs-alert--error" role="alert">{{ submitError }}</div>
        <div v-if="advancedError" class="rs-alert rs-alert--error" role="alert">{{ advancedError }}</div>

        <div class="rs-body">
          <template v-if="advancedMode">
            <AdvancedPostings
              :rows="form.advancedPostings ?? []"
              :accounts="openAccounts"
              :commodities="commodities"
              :bean="beanText"
              :editing="isEditing"
              @update:rows="onAdvancedRows"
              @back="toggleAdvanced"
            />
            <!-- 日期 / flag / 标签 / 备注：与简化态共用同一 form 字段 -->
            <section class="grp">
              <div class="g-head"><span class="g-title"><i class="g-dot"></i>这笔钱的细节</span><span class="g-side">可选项</span></div>
              <div class="fld-row">
                <div class="fld">
                  <label class="fld-label">日期</label>
                  <input class="inp-text" type="date" data-field="date" v-model="form.date" aria-label="交易日期" />
                </div>
                <div class="fld">
                  <label class="fld-label">flag</label>
                  <select class="inp-text" data-field="flag" v-model="form.flag" aria-label="交易 flag">
                    <option value="*">* 已完成</option>
                    <option value="!">! 待核 / 冲正</option>
                  </select>
                </div>
              </div>
              <div class="fld">
                <label class="fld-label">标签（空格或逗号分隔）</label>
                <input
                  class="inp-text"
                  type="text"
                  :value="tagsText"
                  data-field="tags"
                  placeholder="如：日常 孩子"
                  enterkeyhint="done"
                  aria-label="标签"
                  @input="onTagsChange"
                  @change="onTagsChange"
                />
              </div>
              <div class="fld">
                <label class="fld-label">描述 / 备注</label>
                <input
                  class="inp-text"
                  type="text"
                  v-model="form.description"
                  data-field="desc"
                  placeholder="如：超市采购"
                  enterkeyhint="done"
                  aria-label="描述"
                />
              </div>
              <p class="bean-note">标签导出为 <code>tags: "..."</code> 元数据行（中文标签不走 <code>#tag</code>）。</p>
            </section>
          </template>

          <template v-else>
            <section v-if="form.kind !== 'transfer'" class="grp">
              <div class="g-head">
                <span class="g-title"><i class="g-dot"></i>记到哪</span>
                <span class="g-side">先选分类，再选资金账户</span>
              </div>
              <div class="cat-head">
                <span class="cat-hint">常用分类 · 点按即选</span>
                <span class="chip js-cat-chip">已选：{{ selectedCategoryLabel }}</span>
              </div>
              <div class="rs-cats">
                <button
                  v-for="cat in categoryGrid"
                  :key="cat.id"
                  type="button"
                  class="rs-cat"
                  :class="{ on: form.categoryAccountId === cat.id }"
                  :aria-pressed="form.categoryAccountId === cat.id"
                  data-act="cat"
                  :data-cat="cat.id"
                  @click="selectCategory(cat.id)"
                >
                  <span class="rs-cat__icon">{{ catIcon(cat) }}</span>
                  <span class="rs-cat__name">{{ accountLabel(cat) }}</span>
                </button>
                <p v-if="categoryGrid.length === 0" class="rs-muted">
                  当前账本暂无{{ form.kind === 'income' ? '收入' : '支出' }}分类账户
                </p>
              </div>
              <div class="cat-more">
                <div class="more-hint">
                  ↳ 完整列表是同一字段 · 真实导出名 <code>{{ selectedCategoryName }}</code>
                  <template v-if="selectedCategory !== undefined && isThirdLevel(selectedCategory)">（三级账户，冒号分层）</template>
                </div>
                <div class="sel sel--more">
                  <span class="sel-text js-cat-select">{{ selectedCategoryLabel }} · {{ selectedCategoryName }}</span>
                  <span class="chev"></span>
                  <select
                    class="rs-select"
                    :value="categorySelectValue"
                    data-field="category"
                    aria-label="完整分类列表"
                    @change="onCategorySelect"
                  >
                    <option value="">选择其他分类…</option>
                    <option v-for="cat in categoryOptions" :key="cat.id" :value="String(cat.id)">
                      {{ accountLabel(cat) }} · {{ cat.name }}
                    </option>
                  </select>
                </div>
              </div>
              <div class="fld">
                <label class="fld-label">资金账户 <b>必选</b></label>
                <div class="sel">
                  <span class="sel-ico">🔵</span>
                  <span class="sel-text js-fund">{{ accountNameOf(form.fundAccountId ?? -1) }}</span>
                  <select
                    class="rs-select"
                    :value="fundValue"
                    data-field="fund"
                    aria-label="资金账户"
                    @change="onFundSelect"
                  >
                    <option value="">选择资金账户</option>
                    <option v-for="acc in fundAccounts" :key="acc.id" :value="String(acc.id)">
                      {{ accountLabel(acc) }} · {{ acc.name }}（{{ balanceText(acc) }}）
                    </option>
                  </select>
                </div>
              </div>
            </section>

            <section v-else class="grp">
              <div class="g-head">
                <span class="g-title"><i class="g-dot"></i>资金流向</span>
                <span class="g-side" :class="form.transferFromAccountId === form.transferToAccountId ? 'bad' : 'ok'">
                  {{ form.transferFromAccountId === form.transferToAccountId ? '转出与转入不可相同' : '两行资产分录' }}
                </span>
              </div>
              <div class="fld">
                <label class="fld-label">转出账户 <b>必选</b></label>
                <div class="sel">
                  <span class="sel-ico">🔵</span>
                  <span class="sel-text">{{ accountNameOf(form.transferFromAccountId ?? -1) }}</span>
                  <select class="rs-select" :value="transferFromValue" data-field="from" aria-label="转出账户" @change="onTransferFrom">
                    <option value="">选择转出账户</option>
                    <option v-for="acc in fundAccounts" :key="acc.id" :value="String(acc.id)">
                      {{ accountLabel(acc) }} · {{ acc.name }}（{{ balanceText(acc) }}）
                    </option>
                  </select>
                </div>
              </div>
              <div class="transfer-mid"><span class="tline"></span><span class="tbadge">↓</span><span class="tline"></span></div>
              <div class="fld">
                <label class="fld-label">转入账户 <b>必选</b></label>
                <div class="sel">
                  <span class="sel-ico">🟢</span>
                  <span class="sel-text">{{ accountNameOf(form.transferToAccountId ?? -1) }}</span>
                  <select class="rs-select" :value="transferToValue" data-field="to" aria-label="转入账户" @change="onTransferTo">
                    <option value="">选择转入账户</option>
                    <option v-for="acc in fundAccounts" :key="acc.id" :value="String(acc.id)">
                      {{ accountLabel(acc) }} · {{ acc.name }}（{{ balanceText(acc) }}）
                    </option>
                  </select>
                </div>
              </div>
            </section>

            <section class="grp">
              <div class="g-head"><span class="g-title"><i class="g-dot"></i>这笔钱的细节</span><span class="g-side">可选项</span></div>
              <div class="fld-row">
                <div class="fld">
                  <label class="fld-label">日期</label>
                  <input class="inp-text" type="date" data-field="date" v-model="form.date" aria-label="交易日期" />
                </div>
                <div class="fld">
                  <label class="fld-label">flag</label>
                  <select class="inp-text" data-field="flag" v-model="form.flag" aria-label="交易 flag">
                    <option value="*">* 已完成</option>
                    <option value="!">! 待核 / 冲正</option>
                  </select>
                </div>
              </div>
              <div class="fld">
                <label class="fld-label">标签（空格或逗号分隔）</label>
                <input
                  class="inp-text"
                  type="text"
                  :value="tagsText"
                  data-field="tags"
                  placeholder="如：日常 孩子"
                  enterkeyhint="done"
                  aria-label="标签"
                  @input="onTagsChange"
                  @change="onTagsChange"
                />
              </div>
              <div class="fld">
                <label class="fld-label">描述 / 备注</label>
                <input class="inp-text" type="text" v-model="form.description" data-field="desc" placeholder="如：超市采购" enterkeyhint="done" aria-label="描述" />
              </div>
              <p class="bean-note">标签导出为 <code>tags: "..."</code> 元数据行（中文标签不走 <code>#tag</code>）。</p>
            </section>

            <PostingPreview
              :postings="postingViews"
              :groups="balanceGroupList"
              :bean="beanText"
              @advanced="toggleAdvanced"
            />
          </template>
        </div>

        <!-- 底部唯一操作区：简化态键盘按需展开 / 高级态全宽保存条互斥；无「取消」。 -->
        <div class="rs-dock">
          <template v-if="!advancedMode">
            <template v-if="keypadOpen">
              <div class="dock-rail">
                <span>金额 <b>¥<span class="js-rail-amt">{{ amountDisplay }}</span></b></span>
                <span class="rail-r" :class="canSubmit ? 'is-ok' : 'is-bad'">
                  <i></i><span class="js-rail-txt">{{ canSubmit ? '可保存' : (previewError === '' ? '请输入金额' : previewError) }}</span>
                </span>
                <button
                  type="button"
                  class="dock-hide"
                  data-act="hide-keypad"
                  aria-label="收起键盘，查看完整表单"
                  @click="hideKeypad"
                >收起 ⌄</button>
              </div>
              <div class="rs-keyboard">
                <button
                  v-for="key in keyboardKeys"
                  :key="key"
                  type="button"
                  :class="keyClass(key)"
                  :disabled="isActionKey(key) && !canSubmit"
                  data-act="key"
                  :data-key="key"
                  @click="pressKey(key)"
                >{{ key }}</button>
              </div>
            </template>
            <div v-else class="dock-hint">
              <button
                type="button"
                class="dock-hint__btn"
                data-act="show-keypad"
                aria-label="输入金额，展开数字键盘"
                @click="openKeypad"
              >输入金额 <span class="dock-hint__chev">›</span></button>
            </div>
          </template>
          <template v-else>
            <div class="foot-note js-foot-note">
              {{ canSubmit ? (isEditing ? '分录已配平 · 保存后原交易冲正（需联网）' : '分录已配平，可保存') : '分录未配平或账户未选全，保存已禁用' }}
            </div>
            <div class="rs-foot">
              <button
                type="button"
                class="fb-btn-primary js-save"
                :disabled="!canSubmit"
                data-act="save"
                @click="submit(false)"
              >{{ submitting ? '保存中…' : '保存' }}</button>
            </div>
          </template>
          <div class="home-bar" aria-hidden="true"></div>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
/* H5 全屏 / PC 弹窗：CSS 断点决定形态；100vh 始终兜底，--vvh 由 JS 写 px。 */
.rs-mask {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 60;
  display: flex;
  align-items: stretch;
  justify-content: center;
  background: var(--fb-mask);
}

.rs-mask--auto,
.rs-mask--fullscreen {
  align-items: stretch;
  justify-content: stretch;
}

.rs-mask--dialog,
.rs-mask--sheet {
  align-items: center;
  justify-content: center;
}

.rs-panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100vh;
  height: var(--vvh, 100vh);
  overflow: hidden;
  padding-top: var(--safe-t);
  padding-bottom: var(--safe-b);
  background-color: var(--fb-card);
  background-image: repeating-linear-gradient(0deg, var(--fb-paper-edge) 0 1px, transparent 1px 4px);
  box-shadow: var(--fb-shadow-panel);
}

.rs-mask--auto .rs-panel,
.rs-mask--fullscreen .rs-panel {
  border-radius: 0;
}

/* 头部 */
.rs-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 56px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--fb-line);
  background-color: var(--fb-card);
}

.head-left {
  display: flex;
  align-items: center;
  min-width: 0;
}

.head-mark {
  width: 32px;
  height: 32px;
  margin-right: 10px;
  border: 1.5px solid var(--fb-seal);
  border-radius: 8px;
  background: var(--fb-seal-soft);
  color: var(--fb-seal);
  font-family: var(--fb-font-ledger);
  font-size: 15px;
  font-weight: 800;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
}

.rs-head h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 800;
  line-height: 1.3;
  color: var(--fb-ink-deep);
}

.head-sub {
  margin: 2px 0 0;
  font-size: 11px;
  line-height: 1.3;
  color: var(--fb-sub);
}

.rs-close {
  min-width: 44px;
  min-height: 44px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-pill);
  background: var(--fb-soft);
  color: var(--fb-sub);
  font-size: 14px;
  cursor: pointer;
}

.rs-editbanner {
  flex: 0 0 auto;
  display: flex;
  margin: 0;
  padding: 8px 14px;
  background: var(--fb-warn-soft);
  border-bottom: 1px dashed var(--fb-warn-line);
  color: var(--fb-warn-ink);
  font-size: 11.5px;
  line-height: 1.65;
}

.eb-icon {
  flex: 0 0 auto;
  margin-right: 6px;
  color: var(--fb-warn);
  font-weight: 800;
}

/* 金额舞台 */
.rs-stage {
  position: relative;
  flex: 0 0 auto;
  overflow: hidden;
  padding: 10px 14px 12px;
  background-color: var(--fb-paper);
  background-image: repeating-linear-gradient(0deg, var(--fb-paper-edge) 0 1px, transparent 1px 4px),
    linear-gradient(180deg, var(--fb-soft) 0%, var(--fb-paper) 100%);
  border-bottom: 1px solid var(--fb-line-strong);
}

.rs-stage::before {
  content: '账';
  position: absolute;
  right: 10px;
  bottom: -26px;
  width: 92px;
  height: 92px;
  border: 2px solid var(--fb-seal-soft);
  border-radius: 50%;
  color: var(--fb-seal-soft);
  font-size: 44px;
  font-weight: 800;
  line-height: 88px;
  text-align: center;
  transform: rotate(-14deg);
  pointer-events: none;
  z-index: 0;
}

.rs-tabs,
.rs-amount {
  position: relative;
  z-index: 1;
}

.rs-tabs {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 2px;
  padding: 3px;
  margin-bottom: 10px;
  background: var(--fb-soft);
  border: 1px solid var(--fb-line);
  border-radius: 11px;
}

.rs-tabs button {
  min-height: 38px;
  border: none;
  background: transparent;
  color: var(--fb-sub);
  border-radius: 8px;
  padding: 5px 10px;
  font-size: 12.5px;
  font-family: inherit;
  cursor: pointer;
}

.rs-tabs button.on {
  background: var(--fb-card);
  color: var(--fb-brand);
  font-weight: 800;
  box-shadow: var(--fb-shadow-tab), inset 0 -2px 0 var(--fb-brand);
}

.amt-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.amt-cap {
  font-size: 11.5px;
  color: var(--fb-sub);
  letter-spacing: 1px;
}

.amt-cur-tag {
  padding: 2px 8px;
  border: 1px solid var(--fb-line-strong);
  border-radius: 3px;
  background: var(--fb-card);
  color: var(--fb-sub);
  font-size: 10px;
  letter-spacing: 1px;
  font-family: var(--fb-font-mono);
}

.amt-line {
  position: relative;
  display: flex;
  align-items: baseline;
  margin-top: 4px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--fb-line-strong);
}

.amt-line::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -4px;
  border-bottom: 1px solid var(--fb-line);
}

.amt-sym {
  font-size: 20px;
  color: var(--fb-sub);
  margin-right: 6px;
}

.amt-val {
  font-family: var(--fb-font-ledger);
  font-size: clamp(36px, 11vw, 43px);
  font-weight: 700;
  line-height: 1.25;
  letter-spacing: -1px;
  font-variant-numeric: var(--fb-font-numeric);
  color: var(--fb-ink-deep);
  overflow-wrap: anywhere;
}

.amt-caret {
  width: 2px;
  height: 30px;
  margin-left: 5px;
  background: var(--fb-brand);
  border-radius: 2px;
  opacity: 0.75;
  flex: 0 0 auto;
}

.rs-amount.is-zero .amt-val {
  color: var(--fb-sub);
  opacity: 0.7;
}

/* 简化态金额区是键盘入口；高级 / 编辑态不挂 pointer，以免误导为可点。 */
.rs-amount--tap {
  cursor: pointer;
}

.rs-amount--tap:active .amt-val {
  opacity: 0.7;
}

.amt-sub {
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--fb-sub);
  margin-top: 7px;
}

.rs-notice {
  display: flex;
  align-items: center;
  margin-top: 10px;
  padding: 7px 10px;
  border: 1px solid var(--fb-brand-line);
  border-left: 3px solid var(--fb-green);
  border-radius: 6px;
  background: var(--fb-green-soft);
  color: var(--fb-green);
  font-size: 11px;
  line-height: 1.5;
}

/* 主体：唯一滚动区 */
.rs-body {
  flex: 1 1 auto;
  min-height: 0;
  min-height: 96px;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  padding: 12px 12px 16px;
  background: var(--fb-bg);
  scrollbar-width: thin;
  scrollbar-color: var(--fb-line-strong) transparent;
}

.rs-body::-webkit-scrollbar {
  width: 4px;
}

.rs-body::-webkit-scrollbar-thumb {
  background: var(--fb-line-strong);
  border-radius: 2px;
}

.rs-alert {
  flex: 0 0 auto;
  margin: 8px 12px 0;
  padding: 8px 12px;
  border-radius: var(--fb-radius-input);
  font-size: 12px;
  line-height: 1.6;
  background: var(--fb-soft);
  color: var(--fb-ink);
}

.rs-alert--error {
  background: var(--fb-danger-soft);
  color: var(--fb-danger);
}

.rs-alert button {
  border: none;
  background: transparent;
  color: var(--fb-brand);
  font-family: inherit;
  cursor: pointer;
  text-decoration: underline;
}

/* 表单卡片 / 分类 / 账户 */
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

.cat-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  margin-bottom: 9px;
}

.cat-hint {
  font-size: 11.5px;
  color: var(--fb-sub);
}

.chip {
  padding: 5px 10px;
  border: 1px solid var(--fb-seal);
  border-radius: 4px;
  background: var(--fb-seal-soft);
  color: var(--fb-seal);
  font-size: 11px;
  font-weight: 800;
  max-width: 58%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rs-cats {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 6px;
}

.rs-cat {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 72px;
  padding: 10px 2px 8px;
  border: 1.5px solid transparent;
  border-radius: 12px;
  background: var(--fb-soft);
  font-family: inherit;
  cursor: pointer;
}

.rs-cat:active {
  transform: scale(0.96);
}

.rs-cat.on {
  border-color: var(--fb-brand);
  background: var(--fb-brand-soft);
  box-shadow: var(--fb-shadow-card);
}

.rs-cat.on::after {
  content: '✓';
  position: absolute;
  top: 3px;
  right: 4px;
  width: 16px;
  height: 16px;
  border-radius: var(--fb-radius-pill);
  background: var(--fb-brand);
  color: var(--fb-white);
  font-size: 9px;
  font-weight: 800;
  line-height: 16px;
  text-align: center;
}

.rs-cat__icon {
  width: 32px;
  height: 32px;
  border: 1px solid var(--fb-line);
  border-radius: 10px;
  background: var(--fb-card);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  line-height: 1;
}

.rs-cat__name {
  margin-top: 5px;
  font-size: 11.5px;
  line-height: 1.3;
  color: var(--fb-ink);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rs-cat.on .rs-cat__name {
  color: var(--fb-brand);
  font-weight: 800;
}

.rs-muted {
  color: var(--fb-sub);
  font-size: 12px;
}

.cat-more {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed var(--fb-line);
}

.more-hint {
  font-size: 11px;
  line-height: 1.6;
  color: var(--fb-sub);
  margin-bottom: 6px;
}

.more-hint code,
.bean-note code {
  font-family: var(--fb-font-mono);
  color: var(--fb-ink-deep);
}

/* 下拉：视觉是纸面 sel 盒，真实控件 .rs-select 覆盖其上（16px 防 iOS 缩放） */
.sel {
  position: relative;
  display: flex;
  align-items: center;
  min-height: 46px;
  padding: 0 11px;
  border: 1.5px solid var(--fb-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-card);
  box-shadow: var(--fb-shadow-inset);
  font-size: 12.5px;
  color: var(--fb-ink);
  overflow: hidden;
}

.sel--more {
  background: var(--fb-green-soft);
  border-color: var(--fb-brand-line);
  color: var(--fb-brand);
  font-weight: 700;
}

.sel-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sel-ico {
  margin-right: 7px;
  font-size: 13px;
}

.chev {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  margin-left: 8px;
  border-right: 1.5px solid var(--fb-sub);
  border-bottom: 1.5px solid var(--fb-sub);
  transform: rotate(45deg) translateY(-2px);
}

.rs-select {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  border: none;
  background: transparent;
  color: transparent;
  font-size: 16px;
  cursor: pointer;
  appearance: none;
}

.rs-select option {
  color: var(--fb-ink);
}

.fld {
  margin-top: 11px;
}

.fld-label {
  display: block;
  margin-bottom: 6px;
  font-size: 11.5px;
  color: var(--fb-sub);
  letter-spacing: 0.3px;
}

.fld-label b {
  margin-left: 4px;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--fb-seal-soft);
  color: var(--fb-seal);
  font-size: 10px;
  font-weight: 700;
}

.fld-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.fld-row .fld {
  margin-top: 0;
}

.inp-text {
  width: 100%;
  min-height: 46px;
  padding: 0 11px;
  border: 1.5px solid var(--fb-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-card);
  color: var(--fb-ink);
  font-family: inherit;
  box-shadow: var(--fb-shadow-inset);
}

.inp-text::placeholder {
  color: var(--fb-sub);
}

.transfer-mid {
  display: flex;
  align-items: center;
  margin: 10px 0;
}

.tline {
  flex: 1;
  border-top: 1px dashed var(--fb-line-strong);
}

.tbadge {
  width: 24px;
  height: 24px;
  margin: 0 8px;
  border: 1px solid var(--fb-brand-line);
  border-radius: 6px;
  background: var(--fb-brand-soft);
  color: var(--fb-brand);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 800;
}

.bean-note {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--fb-sub);
}

/* iOS Safari：聚焦 computed font-size < 16px 的控件会整页缩放。
   本组件所有真实表单控件都在 .rs-body 内，统一 16px 兜底。 */
.rs-body input,
.rs-body select,
.rs-body textarea {
  font-size: 16px;
}

.rs-select {
  min-height: 40px;
  padding: 8px 12px;
  font-size: 16px;
}

/* 底部操作区 */
.rs-dock {
  flex: 0 0 auto;
  padding-bottom: var(--safe-b);
  background-color: var(--fb-paper);
  background-image: repeating-linear-gradient(0deg, var(--fb-paper-edge) 0 1px, transparent 1px 4px);
  border-top: 1px solid var(--fb-line-strong);
  box-shadow: var(--fb-shadow-dock);
}

.dock-rail {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 12px;
  border-bottom: 1px solid var(--fb-line);
  font-size: 11px;
  color: var(--fb-sub);
}

.dock-rail b {
  margin-left: 4px;
  color: var(--fb-ink-deep);
  font-size: 12px;
  font-variant-numeric: var(--fb-font-numeric);
}

.rail-r {
  display: flex;
  align-items: center;
  white-space: nowrap;
}

.rail-r i {
  width: 6px;
  height: 6px;
  margin-right: 6px;
  border-radius: 50%;
  background: var(--fb-sub);
}

.rail-r.is-ok {
  color: var(--fb-green);
  font-weight: 700;
}

.rail-r.is-ok i {
  background: var(--fb-green);
}

.rail-r.is-bad {
  color: var(--fb-danger);
  font-weight: 700;
}

.rail-r.is-bad i {
  background: var(--fb-danger);
}

/* 收起态：只留一条极简引导，不重复显示金额，也不额外冒出第二个保存按钮。 */
.dock-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 40px;
  padding: 6px 12px;
}

.dock-hint__btn {
  min-height: 28px;
  padding: 2px 10px;
  border: 1px dashed var(--fb-brand-line);
  border-radius: var(--fb-radius-pill);
  background: var(--fb-brand-soft);
  color: var(--fb-brand);
  font-family: inherit;
  font-size: 12px;
  font-weight: 800;
  cursor: pointer;
}

.dock-hint__chev {
  display: inline-block;
  margin-left: 4px;
  font-size: 14px;
  line-height: 1;
}

.dock-hide {
  flex: 0 0 auto;
  min-height: 28px;
  padding: 2px 8px;
  border: 1px solid var(--fb-line-strong);
  border-radius: var(--fb-radius-pill);
  background: var(--fb-card);
  color: var(--fb-brand);
  font-family: inherit;
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
  cursor: pointer;
}

.rs-keyboard {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  grid-auto-rows: var(--kb-h);
  gap: 6px;
  padding: 8px 10px 10px;
  background: transparent;
}

.rs-key {
  min-height: var(--kb-h);
  border: 1px solid var(--fb-line);
  border-radius: 10px;
  background: var(--fb-card);
  color: var(--fb-ink);
  font-size: 17px;
  font-family: inherit;
  font-variant-numeric: var(--fb-font-numeric);
  box-shadow: var(--fb-shadow-key);
  cursor: pointer;
}

.rs-key:active {
  transform: scale(0.97);
}

.rs-key--op {
  background: var(--fb-warn-soft);
  border-color: var(--fb-warn-line);
  color: var(--fb-warn-ink);
  font-size: 15px;
}

.rs-key--again {
  background: var(--fb-soft);
  border-color: var(--fb-line);
  color: var(--fb-sub);
  font-size: 12.5px;
  font-weight: 800;
}

.rs-key--save {
  background: var(--fb-brand);
  border-color: var(--fb-brand);
  color: var(--fb-white);
  font-size: 13px;
  font-weight: 800;
  letter-spacing: 1px;
  box-shadow: var(--fb-shadow-brand), 0 2px 0 var(--fb-ink-deep);
}

.rs-key:disabled,
.fb-btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  box-shadow: none;
}

.foot-note {
  padding: 8px 14px 0;
  background: var(--fb-paper);
  font-size: 11px;
  color: var(--fb-sub);
  text-align: center;
}

.rs-foot {
  display: flex;
  padding: 8px 12px 10px;
  background: var(--fb-paper);
}

.rs-foot > button {
  flex: 1;
  min-height: 48px;
}

.home-bar {
  width: 96px;
  height: 4px;
  margin: 0 auto 6px;
  border-radius: var(--fb-radius-pill);
  background: var(--fb-line-strong);
}

/* 成功态 */
.rs-receipt {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin: auto 0;
  padding: 8px 0 4px;
}

.rs-mask--receipt {
  align-items: center;
  justify-content: center;
  background: var(--fb-mask-strong);
}

.rs-panel--receipt {
  height: 100%;
  padding: 16px 14px;
  background: transparent;
  box-shadow: none;
  border-radius: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  align-items: center;
}

.rs-receipt__status {
  width: 100%;
  max-width: 340px;
  margin: 16px auto 0;
  padding: 8px 12px;
  border: 1px solid var(--fb-warn-line);
  border-radius: 8px;
  background: var(--fb-warn-soft);
  color: var(--fb-warn-ink);
  font-size: 11px;
  line-height: 1.6;
  text-align: center;
}

.rs-receipt__status--blue {
  background: var(--fb-blue-soft);
  border-color: var(--fb-blue-line);
  color: var(--fb-brand);
}

/* flex gap 为 HEAD 既有写法（原值 10px），按约束保留不动。 */
.rs-receipt__actions {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  max-width: 340px;
  margin: 14px auto 0;
}

.rs-rcpt-btn {
  min-height: 44px;
  border-radius: var(--fb-radius-input);
  font-family: inherit;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}

.rs-rcpt-btn--text {
  flex: 0 0 auto;
  padding: 0 6px;
  border: none;
  background: transparent;
  color: var(--fb-white);
  font-size: 11.5px;
  font-weight: 400;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.rs-rcpt-btn--ghost {
  flex: 0 0 auto;
  padding: 0 12px;
  border: 1px solid var(--fb-white);
  background: var(--fb-on-hero-pill);
  color: var(--fb-white);
}

.rs-rcpt-btn--primary {
  flex: 1;
  border: 1px solid var(--fb-brand);
  background: var(--fb-brand);
  color: var(--fb-white);
  letter-spacing: 1px;
  box-shadow: var(--fb-shadow-brand);
}

/* 矮屏压缩：键盘不让内容区归零 */
@media (max-height: 680px) {
  .rs-stage {
    padding: 8px 12px 10px;
  }
  .rs-tabs {
    margin-bottom: 8px;
  }
  .amt-val {
    font-size: 34px;
  }
  .amt-caret {
    height: 26px;
  }
  .rs-cat {
    min-height: 60px;
    padding: 6px 1px 5px;
  }
  .rs-cat__icon {
    width: 28px;
    height: 28px;
    font-size: 16px;
  }
  .grp {
    padding: 11px 10px 10px;
    margin-bottom: 10px;
  }
  .rs-body {
    padding: 10px 10px 12px;
  }
}

@media (max-height: 600px) {
  .amt-sub,
  .g-note {
    display: none;
  }
  .rs-stage {
    padding: 6px 12px 8px;
  }
  .rs-cat {
    min-height: 54px;
  }
  .rs-body {
    min-height: 0;
    padding-top: 8px;
    padding-bottom: 8px;
  }
  .rs-keyboard {
    padding: 6px 10px 8px;
    gap: 4px;
  }
}

@media (max-width: 380px) {
  .rs-cats {
    gap: 4px;
  }
  .rs-cat {
    min-height: 68px;
  }
  .rs-cat__name {
    font-size: 11px;
  }
}

/* 系统键盘弹起：压缩金额舞台腾出空间 */
body.kbd-open .rs-stage {
  padding-top: 4px;
  padding-bottom: 5px;
}
body.kbd-open .amt-sub,
body.kbd-open .rs-notice,
body.kbd-open .rs-tabs {
  display: none;
}
body.kbd-open .rs-body {
  padding-top: 8px;
}

/* ≥1024：居中 460px 弹窗（形态由 CSS 决定，不探测设备） */
@media (min-width: 1024px) {
  .rs-mask--auto {
    align-items: center;
  }
  .rs-mask--auto .rs-panel,
  .rs-mask--dialog .rs-panel {
    width: 460px;
    max-width: 92%;
    height: 88%;
    border-radius: 18px;
  }
  .rs-mask--auto .rs-panel--receipt,
  .rs-mask--dialog .rs-panel--receipt {
    width: 100%;
    max-width: 340px;
    height: 100%;
    border-radius: 0;
  }
}
</style>
