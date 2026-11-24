<script setup lang="ts">
/**
 * C-01 记一笔（最终稿：H5 全屏暖纸账本 + Beancount 双录）
 *
 * - 形态：CSS 断点决定 <900 全屏 H5 / >=900 主区居中 460px 弹窗；JS 仅同步 --vvh。
 * - 视觉：暖纸色板只在本浮层 / 小票作用域生效（tokens.css），不做全站换肤。
 * - 账户：真实数据源 accountApi.list() 的 AccountView；name 是 ASCII 导出名，
 *   display_name 是中文展示名；零硬编码示例账户。
 * - 派生链：form/rows → buildPostings / balanceGroups / buildPostingViews →
 *   buildBeanSnippet → canSubmit → 主操作 disabled。全程 core/Money 定点。
 * - 交互：主操作全局唯一（简化态键盘内保存 / 高级态底部全宽保存互斥）；
 *   无「取消」按钮，关闭只靠 ✕ + 点遮罩自身。
 * - 幂等 / 离线 / 编辑冲正 / 草稿恢复沿用既有口径，选择器契约保持不变。
 */
import { computed, inject, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { routerKey } from 'vue-router'

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
  magnitudeOf,
  resolveAccountCommodity,
  todayString,
  type AdvancedRow,
  type BalanceGroup,
  type PostingDraft,
  type PostingView,
  type RecordForm,
  type RecordKind,
} from '@/core/record'
import { catIcon, recordFundAccounts } from '@/core/accounts'
import { buildBeanSnippet } from '@/core/bean'
import { clearDraft, readDefaultAccounts, readDraft, setDefaultAccount, writeDraft, type DefaultAccountKind } from '@/core/storage'
import { usePrivacyStore } from '@/stores/privacy'
import { useRecordSheetStore } from '@/stores/recordSheet'
import { useSessionStore } from '@/stores/session'
import { useSyncStore } from '@/stores/sync'
import AdvancedPostings from '@/components/AdvancedPostings.vue'
import PostingPreview from '@/components/PostingPreview.vue'
import ReceiptShareSheet from '@/components/ReceiptShareSheet.vue'
import ReceiptSlip from '@/components/ReceiptSlip.vue'
import { buildShareReceipt } from '@/core/shareReceiptData'
import type { ShareReceiptData, ShareReceiptDetails } from '@/core/receiptImage'

const props = withDefaults(
  defineProps<{
    /** auto：按 900 断点自动切换（与侧栏一致）；其余用于强制指定容器形态。 */
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
/**
 * 账本 / 币种 chip 只读，点击即跳管理页。
 * 走 SPA 路由（hash 历史），不触发整页刷新；测试替身未装 router 时静默忽略。
 */
const router = inject(routerKey, null)
function navigateTo(path: string): void {
  if (router === null) {
    return
  }
  void router.push(path)
}

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
/** 简化态新建默认展开键盘（规格 §5-K）；高级 / 编辑态仍强制收起。 */
const keypadOpen = ref(true)
/**
 * 高级行内键盘（v2.1 §12-1）：**独立**于 keypadOpen，后者只服务简化态。
 * activeRowIndex 与 AdvancedPostings 的 activeRow prop 联动，焦点行整行描边。
 */
const advancedKeypadOpen = ref(false)
const activeRowIndex = ref(-1)
const advancedPostingsRef = ref<InstanceType<typeof AdvancedPostings> | null>(null)
/** 浮层 portal 的宿主元素引用（脱离 document 挂载时字符串选择器会失效）。 */
const portalHostEl = ref<HTMLElement | null>(null)

/** 浮层类型：移动底部弹层 / PC chip 锚定下拉共用同一状态。 */
type PopoverKind = '' | 'date' | 'fund' | 'tags' | 'flag' | 'category'
const activePopover = ref<PopoverKind>('')
/** 资金浮层服务哪个字段（简化态资金 chip / 转账转出、转入）。 */
const fundPopoverTarget = ref<'fund' | 'from' | 'to'>('fund')
/** 分类完整列表搜索词（匹配 display_name / name）。 */
const categorySearch = ref('')
/** 标签浮层里除当前 form.tags 外见过的标签（不新增 API，随草稿 / 编辑回显累积）。 */
const knownTags = ref<string[]>([])
const newTagText = ref('')
/** 表达式小字：非聚焦时显示美化文案，聚焦时切成可输入 `+` 的原始串。 */
const exprFocused = ref(false)
const exprInput = ref<HTMLInputElement | null>(null)
/** `=` 求值后的状态：按数字清空重输、按运算符续算、再按 = 无操作。 */
const afterEquals = ref(false)
/** 求值与日期的行内错误（保存守门一并读取）。 */
const evalError = ref('')
const dateError = ref('')
/** 日期浮层日历当前月份 `YYYY-MM`。 */
const calendarMonth = ref('')

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

/** 分享面板：数据从票面快照组装，金额按隐私开关算成显示串，敏感内容默认全关。 */
const shareOpen = ref(false)
const shareData = ref<ShareReceiptData | null>(null)
const shareDetails = ref<ShareReceiptDetails>({
  accountLines: [], tagLine: '', beanLines: [], preciseTime: '',
})

function openShare(): void {
  const r = receipt.value
  if (r === null) {
    return
  }
  // 分类展示名：备注优先（用户可见），没有备注时用类型标签，绝不取完整科目名。
  const descRow = r.rows.find((row) => row.label === '备注')
  const payee = descRow?.value !== undefined && descRow.value !== '' ? descRow.value : r.kindLabel
  const tagRow = r.rows.find((row) => row.label === '标签')
  /**
   * 精确时间从票尾第一行提取（形如「2026-11-21 18:30:00 · 家庭账本」），
   * 只取到秒的时间串，不能把账本名一起塞进分享图。
   */
  const timeMatch = r.footLines[0]?.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/)
  const built = buildShareReceipt({
    amount: r.amount,
    commodity: r.commodity,
    kindLabel: r.kindLabel,
    date: r.rows.find((row) => row.label === '日期')?.value ?? '',
    payee,
    bean: r.bean,
    tags: tagRow?.tags ?? [],
    accounts: r.postings.map((posting) => posting.account),
    preciseTime: timeMatch?.[1] ?? '',
  }, privacy.enabled)
  shareData.value = built.data
  shareDetails.value = built.details
  shareOpen.value = true
}

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
    // 编辑态回填同样归一化：异常后端数据不得让 row.amount 变成非 string 流进 UI。
    amount: typeof posting.amount === 'string' ? posting.amount : '',
    commodity: posting.commodity === undefined || posting.commodity === '' ? session.defaultCommodity : posting.commodity,
  }))
  for (const tag of form.tags) {
    if (knownTags.value.indexOf(tag) < 0) {
      knownTags.value.push(tag)
    }
  }
  advancedMode.value = true
  keypadOpen.value = false
  advancedKeypadOpen.value = false
  activeRowIndex.value = -1
  activePopover.value = ''
}

// 幂等键生命周期：提交成功 / 表单语义变化后换新键，纯网络重试复用。
let idempotencyKey: string | null = null
let lastPayloadJson = ''

const tabs: Array<{ key: RecordKind; label: string }> = [
  { key: 'expense', label: '支出' },
  { key: 'income', label: '收入' },
  { key: 'transfer', label: '转账' },
]
/** 4×5 键位：前四行数字 / 运算，第五行动作条（规格 §5-K）。 */
const keyboardKeys: string[] = [
  '7', '8', '9', '⌫',
  '4', '5', '6', '×',
  '1', '2', '3', '÷',
  '.', '0', '=', '−',
  '+', '再记', '高级双录', '保存',
]
/** 键盘运算键（内部表达式统一半角 + - * /，键面显示 × ÷ − +）。 */
const OPERATOR_KEYS: Record<string, string> = {
  '×': '*',
  '÷': '/',
  '−': '-',
  '+': '+',
}
/** 高级行内键盘：复用前四行数字 / 运算键 + 第五行「+」（§5-E 四则缺一不可），
 * 末尾「完成」按钮与 + 同行占 3 格（grid-column: 2/-1），共 5 行 18 格。 */
const advancedKeypadKeys: string[] = keyboardKeys.slice(0, 17)

const containerClass = computed(() =>
  props.variant === 'auto' ? 'rs-mask--auto' : `rs-mask--${props.variant}`,
)

/**
 * 记账可选账户：**排除已关户**。
 *
 * ⚠️ 这里能拦住关户账户依赖两个前提，改任何一条都要重看本处：
 * ① 本组件**自己调 `accountApi.list()`**（默认不含关户），不走 `ledgerData` 的
 *    includeClosed 快照；
 * ② `accountApi.list` 的默认值仍是「排除关户」（见 `api/client.ts` 的 accountApi.list）。
 * 两条都成立时这里是「双保险的第二道」；若将来改走 store，这道过滤就变成唯一防线。
 */
const openAccounts = computed(() => accounts.value.filter((account) => !account.close_date))
const expenseAccounts = computed(() => openAccounts.value.filter((account) => account.type === 'Expenses'))
const incomeAccounts = computed(() => openAccounts.value.filter((account) => account.type === 'Income'))
const fundAccounts = computed(() => recordFundAccounts(accounts.value))
const categoryOptions = computed(() =>
  form.kind === 'income' ? incomeAccounts.value : expenseAccounts.value,
)
/** 按 sort_order 升序（缺失按 0），同一顺序用于一级 grid / 二级 chips / 完整列表。 */
function bySortOrder(left: AccountView, right: AccountView): number {
  const a = typeof left.sort_order === 'number' ? left.sort_order : 0
  const b = typeof right.sort_order === 'number' ? right.sort_order : 0
  return a - b
}

/**
 * 一级分类：accountApi.list() 中 type ∈ {Expenses, Income} 且 parent_uuid 为空的账户。
 * 数量由账本数据决定，不写死 18 / 9（规格 §4）。
 */
const rootCategories = computed<AccountView[]>(() =>
  categoryOptions.value
    .filter((account) => account.parent_uuid === undefined || account.parent_uuid === '')
    .slice()
    .sort(bySortOrder),
)

/** 当前一级：已选 leaf 反查 parent；无记忆则默认高亮第一项但不自动提交。 */
const activeRootId = computed<number | null>(() => {
  const selected = accounts.value.find((account) => account.id === form.categoryAccountId)
  if (selected !== undefined && selected.parent_uuid !== undefined && selected.parent_uuid !== '') {
    const parent = accounts.value.find((account) => account.uuid === selected.parent_uuid)
    if (parent !== undefined && rootCategories.value.some((root) => root.id === parent.id)) {
      return parent.id
    }
  }
  if (selected !== undefined && rootCategories.value.some((root) => root.id === selected.id)) {
    return selected.id
  }
  return rootCategories.value.length > 0 ? rootCategories.value[0].id : null
})

/** 二级 chips：当前一级的直接子账户；无子分类时调用方整行隐藏。 */
const subCategories = computed<AccountView[]>(() => {
  const root = rootCategories.value.find((account) => account.id === activeRootId.value)
  if (root === undefined || root.uuid === '') {
    return []
  }
  return categoryOptions.value
    .filter((account) => account.parent_uuid === root.uuid)
    .slice()
    .sort(bySortOrder)
})

/** 完整分类列表：按父账户分组，当前 tab 相关类在前。 */
interface CategoryGroup {
  key: string
  label: string
  mono: string
  accounts: AccountView[]
}
const categoryGroups = computed<CategoryGroup[]>(() => {
  const keyword = categorySearch.value.trim().toLowerCase()
  const matched = categoryOptions.value.filter((account) => {
    if (keyword === '') {
      return true
    }
    return (
      accountLabel(account).toLowerCase().indexOf(keyword) >= 0 ||
      account.name.toLowerCase().indexOf(keyword) >= 0
    )
  })
  const groups: CategoryGroup[] = []
  const indexByKey: { [key: string]: number } = {}
  for (const account of matched) {
    const parent = account.parent_uuid === undefined || account.parent_uuid === ''
      ? undefined
      : accounts.value.find((item) => item.uuid === account.parent_uuid)
    const key = parent === undefined ? `root-${account.id}` : `parent-${parent.uuid}`
    let index = indexByKey[key]
    if (index === undefined) {
      index = groups.length
      indexByKey[key] = index
      groups.push({
        key,
        label: parent === undefined ? accountLabel(account) : accountLabel(parent),
        mono: parent === undefined ? account.name : parent.name,
        accounts: [],
      })
    }
    groups[index].accounts.push(account)
  }
  return groups
})

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
/** 求值失败时保留上一次成功落值，绝不把「除数不能为 0」写成 0.00。 */
const lastValidAmount = ref('0.00')
const amountDisplay = computed(() =>
  evalError.value === '' ? amountMoney.value.formatAmount() : lastValidAmount.value,
)
watch(() => form.amountExpression, () => {
  if (evalError.value !== '') {
    return
  }
  if (form.amountExpression === '') {
    lastValidAmount.value = '0.00'
    return
  }
  try {
    const parsed = evaluateAmountExpression(form.amountExpression)
    lastValidAmount.value = parsed.formatAmount()
  } catch {
    // 表达式拼到一半（如 `12.` / `9/0`）时保留上一笔有效金额。
  }
})
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

/**
 * Bean 预览专用金额兜底：空串 / 非法定点串（如 `12.`、裸 `-`）按 0.00 展示。
 *
 * buildBeanSnippet → beanAmount → Money.from 没有 try/catch，任何非法串都会
 * 让 beanText computed 抛错，进而整棵组件树渲染崩溃（页面卡死）。
 * 合法串原样返回，保证 -0.00 等往返形态不变；提交仍由 buildAdvancedPostings 守门。
 */
function previewAmount(amount: string): string {
  if (typeof amount !== 'string' || amount.trim() === '') {
    return '0.00'
  }
  try {
    Money.from(amount)
    return amount
  } catch {
    return '0.00'
  }
}

/** 高级态的草稿分录（含未选账户 / 不平），供配平卡与预览实时展示。 */
const advancedDrafts = computed<PostingDraft[]>(() =>
  (form.advancedPostings ?? []).map((row) => {
    const account = accounts.value.find((item) => item.id === row.accountId)
    return {
      accountId: row.accountId === null ? -1 : row.accountId,
      accountName: account === undefined ? '' : accountLabel(account),
      commodity: row.commodity === '' || row.commodity === undefined ? commodityCode.value : row.commodity,
      amount: previewAmount(row.amount),
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
    evalError.value === '' &&
    dateError.value === '' &&
    accounts.value.length > 0 &&
    session.ledgerId !== null &&
    !session.isViewer &&
    (advancedMode.value ? advancedCanSubmit.value : preview.value.length > 0),
)

/** 表达式小字：内部半角运算符映射成图册键面文案。 */
const expressionDisplay = computed(() =>
  form.amountExpression
    .replace(/\*/g, ' × ')
    .replace(/\//g, ' ÷ ')
    .replace(/\+/g, ' + ')
    .replace(/-/g, ' − ')
    .replace(/\s+/g, ' ')
    .trim(),
)

/** 三态预览条：配平 / 按币种差额（正差额显式带 +）。 */
interface DiffView {
  commodity: string
  text: string
}
const diffViews = computed<DiffView[]>(() =>
  balanceDiffByCommodity(
    activePostings.value.map((posting) => ({
      commodity: posting.commodity,
      amount: posting.amount,
    })),
  ).map((diff) => {
    const value = Money.from(diff.diff)
    return {
      commodity: diff.commodity,
      text: value.isNegative() ? value.toString() : `+${value.toString()}`,
    }
  }),
)
const previewBalanced = computed(
  () => diffViews.value.length === 0 && activePostings.value.length >= 2,
)

const tagsText = computed(() => form.tags.join(' '))
/** chip 文案：今天 / 昨天 / 前天，其余原样 YYYY-MM-DD。 */
const dateChipLabel = computed(() => {
  if (form.date === quickDate(0)) {
    return '今天'
  }
  if (form.date === quickDate(1)) {
    return '昨天'
  }
  if (form.date === quickDate(2)) {
    return '前天'
  }
  return form.date
})
const fundChipLabel = computed(() => accountNameOf(form.fundAccountId ?? -1))
const flagChipLabel = computed(() => (form.flag === '!' ? '! 未完成' : '* 已完成'))
/** 标签浮层选项：已知标签 + 当前选中，去重且保持稳定顺序。 */
const tagOptions = computed<string[]>(() => {
  const result: string[] = []
  for (const tag of knownTags.value.concat(form.tags)) {
    if (tag !== '' && result.indexOf(tag) < 0) {
      result.push(tag)
    }
  }
  return result
})
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
  for (const tag of form.tags) {
    if (knownTags.value.indexOf(tag) < 0) {
      knownTags.value.push(tag)
    }
  }
  notice.value = '已恢复上次未提交的表单草稿'
}

/** 按 uuid 反查可用账户 id；已删除 / 已关户返回 null。 */
function defaultAccountId(uuid: string | undefined): number | null {
  if (uuid === undefined || uuid === '') {
    return null
  }
  for (const account of accounts.value) {
    // 提交前再校验一次：即使下拉被绕过（例如草稿恢复带回旧 uuid），也不允许
    // 把已关户账户写进新交易。关户账户的来源见 `openAccounts` 上方的前提说明。
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
    field: 'categoryAccountId' | 'transferFromAccountId' | 'transferToAccountId' | 'fundAccountId',
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
  applyField('fundAccountId', defaults.fund, fundIds)
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
  // 资金账户记忆不按 kind / 分类拆分：支出与收入共用同一个 fund 位；
  // uuidOf 找不到（null / 账户被并发删除）返回空串，setDefaultAccount 自动跳过。
  // 调用点只在线 / 离线保存成功处，均在编辑态 return 之后，编辑态不污染记忆。
  setDefaultAccount(id, 'fund', uuidOf(form.fundAccountId))
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

/** 资金浮层中的契约 select 按当前服务对象回填字段并关闭浮层。 */
function onFundPopoverSelect(event: Event): void {
  const id = selectedId(event)
  if (fundPopoverTarget.value === 'from') {
    form.transferFromAccountId = id
  } else if (fundPopoverTarget.value === 'to') {
    form.transferToAccountId = id
  } else {
    form.fundAccountId = id
  }
  closePopover()
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
  for (const tag of tags) {
    if (knownTags.value.indexOf(tag) < 0) {
      knownTags.value.push(tag)
    }
  }
}

function selectFlag(flag: '*' | '!'): void {
  form.flag = flag
  closePopover()
}

function selectCategory(id: number): void {
  form.categoryAccountId = id
  closePopover()
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

/**
 * 账本期初日期：与 CategoriesView.ledgerOpening 同口径，按当前 ledgerId
 * 从 session.ledgers 派生；取不到时兜底今天——保守拒绝所有过去日期。
 * 这是快捷日期 chip 的唯一守门（原生 date input 仍可自由录入）。
 */
function ledgerOpening(): string {
  // 测试替身 / 未加载账本列表时 ledgers 可能缺失；取不到即按兜底今天处理。
  const ledgers = Array.isArray(session.ledgers) ? session.ledgers : []
  for (const ledger of ledgers) {
    if (ledger.id === session.ledgerId && ledger.opening_date !== '') {
      return ledger.opening_date
    }
  }
  return todayString()
}

/** 本地时区日期（禁用 UTC 序列化 / 毫秒算术 / 新版补零 API，兼容 iOS14）。 */
function quickDate(daysAgo: number): string {
  const base = new Date()
  base.setDate(base.getDate() - daysAgo)
  return `${base.getFullYear()}-${pad2(base.getMonth() + 1)}-${pad2(base.getDate())}`
}

/** 日期可选下限：账本 opening_date，取不到才兜底今天（沿用 ledgerOpening 口径）。 */
const minDate = computed(() => ledgerOpening())
/** 未来禁选：上限恒为今天。 */
const maxDate = computed(() => todayString())

/** 合法且可提交的日期：格式 + 下限 + 上限，原生 input / 日历 / 提交共用。 */
function isDateAllowed(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= minDate.value && value <= maxDate.value
}

/** 原生 date input 的即时守门：越界回退到上一个合法值并给行内提示。 */
function onDateInput(event: Event): void {
  const value = (event.target as HTMLInputElement).value
  if (isDateAllowed(value)) {
    form.date = value
    dateError.value = ''
    notice.value = ''
    return
  }
  dateError.value = value > maxDate.value ? '日期不能晚于今天' : `日期不能早于账本期初 ${minDate.value}`
  ;(event.target as HTMLInputElement).value = form.date
}

/** PC 锚定下拉位置（由触发 chip 的 getBoundingClientRect 派生，不另立断点）。 */
const popoverStyle = ref<Record<string, string>>({})
function setPopoverAnchor(event: Event): void {
  const element = event.currentTarget as HTMLElement | null
  if (element === null || typeof element.getBoundingClientRect !== 'function') {
    return
  }
  const rect = element.getBoundingClientRect()
  const width = Math.max(250, Math.round(rect.width))
  // 右缘溢出时改为右对齐，保证下拉完整落在视口内。
  const viewportWidth = typeof window === 'undefined' ? width + 24 : window.innerWidth
  const left = Math.min(Math.round(rect.left), Math.max(12, viewportWidth - width - 12))
  // 下缘溢出时向上翻转（PC 锚定下拉同样不得被视口截断）。
  const viewportHeight = typeof window === 'undefined' ? 768 : window.innerHeight
  const estimatedHeight = 360
  const top = rect.bottom + estimatedHeight + 12 <= viewportHeight
    ? Math.round(rect.bottom + 6)
    : Math.max(12, Math.round(rect.top - estimatedHeight - 6))
  popoverStyle.value = {
    '--pop-left': `${left}px`,
    '--pop-top': `${top}px`,
    '--pop-width': `${width}px`,
  }
}

/** 浮层开关：同一时刻只有一个浮层，点当前 chip 即收起。 */
function togglePopover(kind: Exclude<PopoverKind, ''>, event?: Event): void {
  if (event !== undefined) {
    setPopoverAnchor(event)
  }
  if (kind === 'date' && activePopover.value !== 'date') {
    calendarMonth.value = form.date.slice(0, 7)
  }
  activePopover.value = activePopover.value === kind ? '' : kind
}

function closePopover(): void {
  activePopover.value = ''
}

/** PC 锚定下拉的 Esc 关闭（移动底部弹层保留遮罩点击）。 */
function onGlobalKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && activePopover.value !== '') {
    closePopover()
  }
}

function openFundPopover(target: 'fund' | 'from' | 'to', event?: Event): void {
  fundPopoverTarget.value = target
  togglePopover('fund', event)
}

/** 资金浮层行选择：回填对应 form 字段并关闭浮层。 */
function selectFundAccount(id: number): void {
  if (fundPopoverTarget.value === 'from') {
    form.transferFromAccountId = id
  } else if (fundPopoverTarget.value === 'to') {
    form.transferToAccountId = id
  } else {
    form.fundAccountId = id
  }
  resetIdempotencyKey()
  closePopover()
}

/** 标签浮层多选（即时同步 form.tags，关闭不丢）。 */
function toggleTag(tag: string): void {
  const index = form.tags.indexOf(tag)
  if (index >= 0) {
    form.tags.splice(index, 1)
  } else {
    form.tags.push(tag)
  }
  if (knownTags.value.indexOf(tag) < 0) {
    knownTags.value.push(tag)
  }
  resetIdempotencyKey()
}

/** 虚线「＋ 新标签」行内创建并勾选。 */
function createTag(): void {
  const tag = newTagText.value.trim()
  if (tag === '') {
    return
  }
  if (knownTags.value.indexOf(tag) < 0) {
    knownTags.value.push(tag)
  }
  if (form.tags.indexOf(tag) < 0) {
    form.tags.push(tag)
  }
  newTagText.value = ''
  resetIdempotencyKey()
}

/** 快捷日期只写 form.date 一处：页头、Bean 片段、小票 Bean 均由它派生。 */
function applyQuickDate(daysAgo: number): void {
  const candidate = quickDate(daysAgo)
  const opening = ledgerOpening()
  if (candidate < opening || candidate > maxDate.value) {
    notice.value = candidate > maxDate.value ? '日期不能晚于今天' : `日期不能早于账本期初 ${opening}`
    return
  }
  form.date = candidate
  dateError.value = ''
  notice.value = ''
  closePopover()
}

/** 日历单元格：前导空位 + 当月日；越界日禁用，今天描边，选中实心。 */
interface CalendarCell {
  key: string
  day: number | null
  date: string
  disabled: boolean
}
const calendarCells = computed<CalendarCell[]>(() => {
  const month = calendarMonth.value === '' ? form.date.slice(0, 7) : calendarMonth.value
  const year = Number(month.slice(0, 4))
  const mon = Number(month.slice(5, 7))
  const base = new Date(year, mon - 1, 1)
  const cells: CalendarCell[] = []
  for (let i = 0; i < base.getDay(); i += 1) {
    cells.push({ key: `blank-${i}`, day: null, date: '', disabled: true })
  }
  const daysInMonth = new Date(year, mon, 0).getDate()
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${month}-${pad2(day)}`
    cells.push({ key: date, day, date, disabled: !isDateAllowed(date) })
  }
  return cells
})

function shiftCalendarMonth(delta: number): void {
  const month = calendarMonth.value === '' ? form.date.slice(0, 7) : calendarMonth.value
  const next = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + delta, 1)
  calendarMonth.value = `${next.getFullYear()}-${pad2(next.getMonth() + 1)}`
}

function selectCalendarDate(date: string): void {
  if (!isDateAllowed(date)) {
    return
  }
  form.date = date
  dateError.value = ''
  notice.value = ''
  closePopover()
}

/** 当前运算段（最后一位运算符之后），用于小数点去重与两位小数限制。 */
function currentSegment(expr: string): string {
  let start = 0
  for (let i = expr.length - 1; i >= 0; i -= 1) {
    const ch = expr.charAt(i)
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      start = i + 1
      break
    }
  }
  return expr.slice(start)
}

function isOperator(char: string): boolean {
  return char === '+' || char === '-' || char === '*' || char === '/'
}

/** 点美化表达式切换到输入框，供 4×5 键位缺失的 `+` 走物理键盘。 */
function focusExpression(): void {
  exprFocused.value = true
  if (exprInput.value !== null && typeof exprInput.value.focus === 'function') {
    exprInput.value.focus()
  }
}

/** 表达式小字输入框：仅收合法字符。 */
function onExpressionInput(event: Event): void {
  const input = event.target as HTMLInputElement
  const cleaned = input.value.replace(/[^0-9.+\-*/]/g, '')
  if (input.value !== cleaned) {
    input.value = cleaned
  }
  markEditing()
  form.amountExpression = cleaned
}

/** 任何编辑键都解除 `=` 后的续算态并清掉求值错误。 */
function markEditing(): void {
  afterEquals.value = false
  evalError.value = ''
}

/**
 * `=`：调用 core 的定点求值（顺序求值、2 位舍入、结果取绝对值），
 * 成功写回纯数字串；失败只显示行内错误，不落值、保存禁用。
 */
function evaluateNow(): void {
  if (afterEquals.value || form.amountExpression === '') {
    return
  }
  try {
    const result = evaluateAmountExpression(form.amountExpression)
    form.amountExpression = result.toString()
    evalError.value = ''
    afterEquals.value = true
  } catch (err) {
    evalError.value = err instanceof Error ? err.message : '金额表达式不正确'
  }
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
  if (key === '高级双录') {
    toggleAdvanced()
    return
  }
  if (key === '=') {
    evaluateNow()
    return
  }
  if (key === '⌫') {
    markEditing()
    form.amountExpression = form.amountExpression.slice(0, -1)
    return
  }
  const operator = OPERATOR_KEYS[key]
  if (operator !== undefined) {
    if (form.amountExpression === '') {
      return
    }
    markEditing()
    const last = form.amountExpression.slice(-1)
    if (isOperator(last)) {
      form.amountExpression = form.amountExpression.slice(0, -1) + operator
      return
    }
    form.amountExpression += operator
    return
  }

  let expression = form.amountExpression
  if (afterEquals.value) {
    // 规格 §5-E：`=` 后按数字（含小数点）清空重输；按运算符已在上面续算。
    expression = ''
  }
  markEditing()
  const segment = currentSegment(expression)
  if (key === '.') {
    if (segment.indexOf('.') >= 0) {
      form.amountExpression = expression
      return
    }
    form.amountExpression = expression + (segment === '' ? '0.' : '.')
    return
  }
  if (/^[0-9]$/.test(key)) {
    const dot = segment.indexOf('.')
    if (dot >= 0 && segment.length - dot - 1 >= 2) {
      form.amountExpression = expression
      return
    }
    form.amountExpression = expression + key
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
  if (key === '高级双录') {
    return 'rs-key rs-key--advanced'
  }
  if (key === '⌫' || key === '×' || key === '÷' || key === '−' || key === '+' || key === '=') {
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
    return {
      accountId: row.accountId,
      amount: typeof row.amount === 'string' ? row.amount : '',
      commodity,
    }
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
  closeAdvancedKeypad()
  activePopover.value = ''
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

// ─────────── 高级行内键盘（§12-1）：独立状态，PC 端直接物理输入 ───────────

/** PC = dialog / ≥900 断点，沿用容器形态，不另立断点。 */
function isPcForm(): boolean {
  if (props.variant === 'dialog') {
    return true
  }
  if (props.variant === 'sheet' || props.variant === 'fullscreen') {
    return false
  }
  return typeof window !== 'undefined' && window.innerWidth >= 900
}

/** 点行内金额框：移动端开自定义键盘（系统键盘不介入），PC 忽略。 */
function onAdvancedFocusAmount(index: number, _element: HTMLInputElement): void {
  if (isPcForm() || isEditing.value) {
    return
  }
  activeRowIndex.value = index
  advancedKeypadOpen.value = true
  keypadOpen.value = false
}

function closeAdvancedKeypad(): void {
  // 收起即结算：任何路径收起键盘（完成 / 删除焦点行 / 返回简化 / 重置），
  // 焦点行未落值的表达式都先就地求值，避免输入框显示 placeholder 0.00
  // 而角落小字还悬着数字。finishActiveRow 对无表达式 / 已落值行为幂等。
  advancedPostingsRef.value?.finishActiveRow()
  advancedKeypadOpen.value = false
  activeRowIndex.value = -1
}

/** 焦点行之前的行被删：焦点行内容左移一位，同步下标保持键盘继续编辑同一行。 */
function onActiveRowShift(next: number): void {
  activeRowIndex.value = next
}

/** 键盘按键转发给子组件的焦点行；求值与写回都留在 AdvancedPostings。 */
function pressAdvancedKey(key: string): void {
  if (!advancedKeypadOpen.value) {
    return
  }
  advancedPostingsRef.value?.pressActiveKey(key)
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
    if (typeof row.amount !== 'string' || row.amount.trim() === '') {
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
    // 编辑态无类型概念（冲正 + 新建），票面类型标签固定为「修改 EDIT」。
    kindLabel: isEditing.value ? '修改 EDIT' : KIND_LABELS[form.kind],
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
  // 提交处再次守门：浮层绕过后也不允许未来 / 早于开账日的日期落库。
  // 编辑态回填的是历史交易日期，不受「新记一笔」的下限约束（冲正 + 新建口径不变）。
  if (!isEditing.value && !isDateAllowed(form.date)) {
    submitError.value = form.date > maxDate.value ? '日期不能晚于今天' : `日期不能早于账本期初 ${minDate.value}`
    return
  }
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
  // 「再记一笔」回到简化态默认口径：高级态残留会让面板变成 0 行死状态
  //（无金额输入框、无「高级双录」键、保存恒禁用）。简化态新建默认展开键盘（§5-K）。
  advancedMode.value = false
  keypadOpen.value = true
  resetIdempotencyKey()
  showSuccess.value = false
  receipt.value = null
  submitError.value = ''
  advancedError.value = ''
  evalError.value = ''
  dateError.value = ''
  afterEquals.value = false
  activePopover.value = ''
  closeAdvancedKeypad()
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

/**
 * 交给系统键盘接手的控件选择器。
 *
 * - 简化态金额 / 描述输入带 inp-text；
 * - 高级态金额框在子组件 AdvancedPostings 内，只有 data-rf="amt"（无 inp-text）。
 *
 * focusin / focusout 挂在 document 上冒泡，能捕获子组件输入框；进出场判定与自定义键盘
 * 反向互斥共用本常量，避免任一处漏改导致 body.kbd-open 与 --vvh 脱节
 * （系统键盘缩了 panel，压缩样式却没启用）。
 */
const SYSTEM_KEYBOARD_TARGET = "input.inp-text, textarea.inp-text, input[data-rf='amt']"

/**
 * 高级行内键盘展开时，行金额框归自定义键盘管：
 * 即使因 click / focus 冒泡触发 focusin，也不得切到系统键盘态（§7(b) / §12-1）。
 */
function isAdvancedKeypadAmount(target: HTMLElement): boolean {
  return advancedKeypadOpen.value && target.matches("input[data-rf='amt']")
}

function syncVv(): void {
  const viewport = typeof window === 'undefined' ? null : window.visualViewport
  const height = viewport !== null && viewport !== undefined ? viewport.height : window.innerHeight
  const next = `${Math.round(height)}px`
  vvh.value = next
  document.documentElement.style.setProperty('--vvh', next)
}

function onFocusIn(event: Event): void {
  const target = event.target as HTMLElement
  if (
    target !== null &&
    typeof target.matches === 'function' &&
    target.matches(SYSTEM_KEYBOARD_TARGET) &&
    !isAdvancedKeypadAmount(target)
  ) {
    // 系统键盘接手时收起自定义键盘，两个键盘不共存。
    keypadOpen.value = false
    kbdOpen.value = true
    document.body.classList.add('kbd-open')
  }
}

function onFocusOut(event: Event): void {
  const target = event.target as HTMLElement
  if (
    target !== null &&
    typeof target.matches === 'function' &&
    target.matches(SYSTEM_KEYBOARD_TARGET) &&
    !isAdvancedKeypadAmount(target)
  ) {
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
    active.matches(SYSTEM_KEYBOARD_TARGET)
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
  document.addEventListener('keydown', onGlobalKeydown)
})

onUnmounted(() => {
  window.removeEventListener('resize', syncVv)
  if (window.visualViewport !== undefined && window.visualViewport !== null) {
    window.visualViewport.removeEventListener('resize', syncVv)
  }
  document.removeEventListener('focusin', onFocusIn)
  document.removeEventListener('focusout', onFocusOut)
  document.removeEventListener('keydown', onGlobalKeydown)
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
            <button type="button" class="rs-rcpt-btn rs-rcpt-btn--ghost" @click="openShare">分享图</button>
            <button type="button" class="rs-rcpt-btn rs-rcpt-btn--ghost" @click="copyLast">复制上一笔</button>
            <button type="button" class="rs-rcpt-btn rs-rcpt-btn--primary" @click="again">再记一笔</button>
          </template>
          <button v-else type="button" class="rs-rcpt-btn rs-rcpt-btn--primary" @click="close">完成</button>
        </div>
      </div>

      <ReceiptShareSheet
        v-if="shareOpen && shareData !== null"
        :data="shareData"
        :details="shareDetails"
        @close="shareOpen = false"
      />

      <!-- 成功态只渲染票面与操作按钮：表单分支必须排除 showSuccess，
           否则整张表单（Tabs / 金额舞台 / 高级双录 / dock）会排在票面下方，
           面板 overflow-y:auto 一滚就露出来（保存成功后底部还有布局的根因）。 -->
      <template v-else-if="!showSuccess">
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

        <!-- 编辑态无类型 Tab 与金额舞台：Beancount 交易无类型字段，类型由分录本身表达，
             配平检查交给下方高级双录。新建态（!isEditing）恒渲染，视觉零变化。 -->
        <div v-if="!isEditing" class="rs-stage">
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
              <button
                type="button"
                class="amt-chip js-ledger-chip"
                data-act="ledger-chip"
                aria-label="管理账本"
                @click.stop="navigateTo('/ledgers')"
              >▣ {{ session.ledgerName === undefined || session.ledgerName === '' ? '家庭账本' : session.ledgerName }}</button>
              <button
                type="button"
                class="amt-chip js-commodity-chip"
                data-act="commodity-chip"
                aria-label="管理币种"
                @click.stop="navigateTo('/commodities')"
              >CNY {{ currency }}</button>
            </div>
            <div class="amt-cap">{{ form.kind === 'income' ? '收入金额' : form.kind === 'transfer' ? '转账金额' : '支出金额' }}</div>
            <div class="amt-line">
              <span class="amt-sym">{{ currency }}</span>
              <span class="amt-val js-amount">{{ amountDisplay }}</span>
              <span class="amt-caret"></span>
            </div>
            <!-- 4×5 键位没有独立 + 键（图册口径）：展示态用美化文案，聚焦后切输入框。 -->
            <div
              v-if="expressionDisplay !== '' && !exprFocused"
              class="amt-expr js-expr-view"
              role="button"
              tabindex="0"
              @click="focusExpression"
              @keydown.enter.prevent="focusExpression"
            >{{ expressionDisplay }}</div>
            <input
              v-show="exprFocused || expressionDisplay === ''"
              ref="exprInput"
              class="amt-expr js-expr"
              type="text"
              :value="form.amountExpression"
              placeholder="表达式可输入 + - * /"
              aria-label="金额表达式，可输入加号"
              autocomplete="off"
              @click.stop
              @focus="exprFocused = true; hideKeypad()"
              @blur="exprFocused = false"
              @input="onExpressionInput"
            />
            <div v-if="evalError" class="amt-error js-eval-error" role="alert">{{ evalError }}</div>
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
              ref="advancedPostingsRef"
              :rows="form.advancedPostings ?? []"
              :accounts="openAccounts"
              :commodities="commodities"
              :bean="beanText"
              :editing="isEditing"
              :active-row="activeRowIndex"
              :keypad-active="advancedKeypadOpen"
              @update:rows="onAdvancedRows"
              @back="toggleAdvanced"
              @focus-amount="onAdvancedFocusAmount"
              @keypad-done="closeAdvancedKeypad"
              @active-row-shift="onActiveRowShift"
            />
            <!-- 日期 / flag / 标签 / 备注：与简化态共用同一 form 字段 -->
            <section class="grp">
              <div class="g-head"><span class="g-title"><i class="g-dot"></i>这笔钱的细节</span><span class="g-side">可选项</span></div>
              <div class="fld-row">
                <div class="fld">
                  <label class="fld-label">日期</label>
                  <input class="inp-text" type="date" data-field="date" v-model="form.date" aria-label="交易日期" />
                  <div class="date-chips" role="group" aria-label="快捷日期">
                    <button type="button" data-act="date-today" :class="{ on: form.date === quickDate(0) }" @click="applyQuickDate(0)">今天</button>
                    <button type="button" data-act="date-yesterday" :class="{ on: form.date === quickDate(1) }" @click="applyQuickDate(1)">昨天</button>
                    <button type="button" data-act="date-day-before" :class="{ on: form.date === quickDate(2) }" @click="applyQuickDate(2)">前天</button>
                  </div>
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
                <span class="cat-hint">一级分类 · 点按即选</span>
                <span class="chip js-cat-chip">已选：{{ selectedCategoryLabel }} <code>{{ selectedCategoryName }}</code></span>
              </div>
              <!-- 一级 grid：根分类由 accountApi.list() 的 parent_uuid 动态派生，6 列。 -->
              <div class="rs-cats">
                <button
                  v-for="cat in rootCategories"
                  :key="cat.id"
                  type="button"
                  class="rs-cat"
                  :class="{ on: activeRootId === cat.id }"
                  :aria-pressed="activeRootId === cat.id"
                  data-act="cat"
                  :data-cat="cat.id"
                  @click="selectCategory(cat.id)"
                >
                  <span class="rs-cat__icon" :style="cat.color === undefined ? undefined : { color: cat.color }">{{ catIcon(cat) }}</span>
                  <span class="rs-cat__name">{{ accountLabel(cat) }}</span>
                  <span class="rs-cat__mono">{{ cat.name }}</span>
                </button>
                <p v-if="rootCategories.length === 0" class="rs-muted">
                  当前账本暂无{{ form.kind === 'income' ? '收入' : '支出' }}分类账户
                </p>
              </div>
              <!-- 二级 chips：无子分类整行隐藏，一级本身即提交分类。 -->
              <div v-if="subCategories.length > 0" class="rs-subcats" role="group" aria-label="二级分类">
                <button
                  v-for="sub in subCategories"
                  :key="sub.id"
                  type="button"
                  class="rs-subcat"
                  :class="{ on: form.categoryAccountId === sub.id }"
                  :aria-pressed="form.categoryAccountId === sub.id"
                  data-act="cat"
                  :data-cat="sub.id"
                  @click="selectCategory(sub.id)"
                >{{ catIcon(sub) }} {{ accountLabel(sub) }}</button>
                <button type="button" class="rs-subcat rs-subcat--all" data-popover="category" @click="togglePopover('category', $event)">全部 ▾</button>
              </div>
              <div v-else class="cat-more">
                <button type="button" class="rs-subcat rs-subcat--all" data-popover="category" @click="togglePopover('category', $event)">全部 ▾</button>
                <span class="more-hint">真实导出名 <code class="js-cat-name">{{ selectedCategoryName }}</code></span>
              </div>
            </section>

            <section v-else class="grp">
              <div class="g-head">
                <span class="g-title"><i class="g-dot"></i>资金流向</span>
                <span class="g-side" :class="form.transferFromAccountId === form.transferToAccountId ? 'bad' : 'ok'">
                  {{ form.transferFromAccountId === form.transferToAccountId ? '转出与转入不可相同' : '两行资产分录' }}
                </span>
              </div>
              <div class="transfer-chips">
                <button type="button" class="transfer-chip js-from-chip" data-field="from" data-role="chip" @click="openFundPopover('from', $event)">
                  🔵 {{ accountNameOf(form.transferFromAccountId ?? -1) }}
                </button>
                <span class="transfer-arrow">→</span>
                <button type="button" class="transfer-chip js-to-chip" data-field="to" data-role="chip" @click="openFundPopover('to', $event)">
                  🟢 {{ accountNameOf(form.transferToAccountId ?? -1) }}
                </button>
              </div>
              <div class="fld">
                <label class="fld-label">转出账户 <b>必选</b></label>
                <div class="sel">
                  <span class="sel-ico">🔵</span>
                  <span class="sel-text">{{ accountNameOf(form.transferFromAccountId ?? -1) }}</span>
                  <select class="rs-select" :value="transferFromValue" data-field="from" data-role="input" aria-label="转出账户" @change="onTransferFrom">
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
                  <select class="rs-select" :value="transferToValue" data-field="to" data-role="input" aria-label="转入账户" @change="onTransferTo">
                    <option value="">选择转入账户</option>
                    <option v-for="acc in fundAccounts" :key="acc.id" :value="String(acc.id)">
                      {{ accountLabel(acc) }} · {{ acc.name }}（{{ balanceText(acc) }}）
                    </option>
                  </select>
                </div>
              </div>
            </section>

            <!-- meta chips：日期 → 资金 → 标签 → flag，flex-wrap 自然换行。 -->
            <section class="rs-meta" aria-label="交易附加信息">
              <button type="button" class="meta-chip js-date-chip" data-field="date" data-role="chip" data-popover="date" @click="togglePopover('date', $event)">📅 {{ dateChipLabel }}</button>
              <button type="button" class="meta-chip js-fund-chip" data-field="fund" data-role="chip" data-popover="fund" @click="openFundPopover('fund', $event)">🏦 {{ fundChipLabel }}</button>
              <button type="button" class="meta-chip js-tags-chip" data-field="tags" data-role="chip" data-popover="tags" @click="togglePopover('tags', $event)">🏷 {{ tagsText === '' ? '＋ 标签' : tagsText }}</button>
              <button type="button" class="meta-chip js-flag-chip" data-field="flag" data-role="chip" data-popover="flag" @click="togglePopover('flag', $event)">{{ flagChipLabel }}</button>
            </section>

            <section class="grp">
              <div class="g-head"><span class="g-title"><i class="g-dot"></i>这笔钱的细节</span><span class="g-side">可选项</span></div>
              <div class="fld">
                <label class="fld-label">描述 / 备注</label>
                <input class="inp-text" type="text" v-model="form.description" data-field="desc" data-role="input" placeholder="和朋友一起吃晚餐" enterkeyhint="done" aria-label="描述" />
              </div>
              <p class="bean-note">标签导出为 <code>tags: "..."</code> 元数据行（中文标签不走 <code>#tag</code>）。</p>
            </section>

            <PostingPreview
              :postings="postingViews"
              :groups="balanceGroupList"
              :bean="beanText"
              @advanced="toggleAdvanced"
            />
            <div class="rs-preview js-preview" :class="previewBalanced ? 'is-ok' : 'is-bad'" role="status">
              <template v-if="previewBalanced">✓ 配平</template>
              <template v-else>
                {{ previewError === '' ? '不平' : previewError }}
                <span v-for="diff in diffViews" :key="diff.commodity" class="rs-preview__diff">
                  {{ diff.commodity }} 差额 {{ diff.text }}
                </span>
              </template>
            </div>

            <!-- 浮层 portal 到 mask 层宿主，避开 .rs-panel overflow:hidden / .rs-body overflow-y:auto 裁剪；
                 容器常驻 DOM（v-show）以保留 data-field 契约，仅激活态可见。 -->
            <Teleport v-if="portalHostEl" :to="portalHostEl">
            <div v-show="activePopover !== ''" class="rs-popover-mask" @click.self="closePopover">
              <div class="rs-popover" :style="popoverStyle" role="dialog" aria-label="编辑选项">
                <div class="pop-handle"></div>
                <button type="button" class="pop-close" aria-label="关闭浮层" @click="closePopover">✕</button>

                <div v-show="activePopover === 'date'" class="pop-body js-pop-date">
                  <h4>选择日期</h4>
                  <div class="date-chips" role="group" aria-label="快捷日期">
                    <button type="button" data-act="date-today" :class="{ on: form.date === quickDate(0) }" @click="applyQuickDate(0)">今天</button>
                    <button type="button" data-act="date-yesterday" :class="{ on: form.date === quickDate(1) }" @click="applyQuickDate(1)">昨天</button>
                    <button type="button" data-act="date-day-before" :class="{ on: form.date === quickDate(2) }" @click="applyQuickDate(2)">前天</button>
                  </div>
                  <div class="cal-head">
                    <button type="button" aria-label="上个月" @click="shiftCalendarMonth(-1)">‹</button>
                    <span class="cal-title">{{ calendarMonth === '' ? form.date.slice(0, 7) : calendarMonth }}</span>
                    <button type="button" aria-label="下个月" @click="shiftCalendarMonth(1)">›</button>
                  </div>
                  <div class="cal-grid">
                    <span v-for="label in ['日', '一', '二', '三', '四', '五', '六']" :key="label" class="cal-week">{{ label }}</span>
                    <template v-for="cell in calendarCells" :key="cell.key">
                      <span v-if="cell.day === null" class="cal-day cal-day--blank"></span>
                      <button
                        v-else
                        type="button"
                        class="cal-day"
                        :class="{ on: form.date === cell.date, today: cell.date === quickDate(0) }"
                        :disabled="cell.disabled"
                        :data-date="cell.date"
                        @click="selectCalendarDate(cell.date)"
                      >{{ cell.day }}</button>
                    </template>
                  </div>
                  <p v-if="dateError" class="pop-error" role="alert">{{ dateError }}</p>
                  <label class="pop-label">精确日期
                    <input
                      class="inp-text"
                      type="date"
                      :value="form.date"
                      :min="minDate"
                      :max="maxDate"
                      data-field="date"
                      data-role="input"
                      aria-label="交易日期"
                      @input="onDateInput"
                    />
                  </label>
                </div>

                <div v-show="activePopover === 'fund'" class="pop-body js-pop-fund">
                  <h4>资金账户</h4>
                  <button
                    v-for="acc in fundAccounts"
                    :key="acc.id"
                    type="button"
                    class="pop-row"
                    :class="{ on: (fundPopoverTarget === 'from' ? form.transferFromAccountId : fundPopoverTarget === 'to' ? form.transferToAccountId : form.fundAccountId) === acc.id }"
                    :data-account="acc.id"
                    @click="selectFundAccount(acc.id)"
                  >
                    <span class="pop-row__icon">{{ catIcon(acc) }}</span>
                    <span class="pop-row__main">{{ accountLabel(acc) }} <b>{{ balanceText(acc) }}</b></span>
                    <code class="pop-row__mono">{{ acc.name }}</code>
                    <span v-if="(fundPopoverTarget === 'from' ? form.transferFromAccountId : fundPopoverTarget === 'to' ? form.transferToAccountId : form.fundAccountId) === acc.id" class="pop-row__check">✓</span>
                  </button>
                  <label class="pop-label">账户字段（契约控件）
                    <select
                      class="inp-text"
                      :value="fundPopoverTarget === 'from' ? transferFromValue : fundPopoverTarget === 'to' ? transferToValue : fundValue"
                      data-field="fund"
                      data-role="input"
                      aria-label="资金账户"
                      @change="onFundPopoverSelect"
                    >
                      <option value="">选择资金账户</option>
                      <option v-for="acc in fundAccounts" :key="acc.id" :value="String(acc.id)">
                        {{ accountLabel(acc) }} · {{ acc.name }}（{{ balanceText(acc) }}）
                      </option>
                    </select>
                  </label>
                </div>

                <div v-show="activePopover === 'tags'" class="pop-body js-pop-tags">
                  <h4>标签</h4>
                  <div class="tag-list">
                    <button
                      v-for="tag in tagOptions"
                      :key="tag"
                      type="button"
                      class="pop-tag"
                      :class="{ on: form.tags.indexOf(tag) >= 0 }"
                      :data-tag="tag"
                      @click="toggleTag(tag)"
                    >{{ tag }} <span v-if="form.tags.indexOf(tag) >= 0">✓</span></button>
                    <button type="button" class="pop-tag pop-tag--new" @click="createTag">＋ 新标签</button>
                  </div>
                  <input
                    v-model="newTagText"
                    class="inp-text"
                    type="text"
                    data-tag-input="new"
                    placeholder="输入新标签后点「＋ 新标签」"
                    enterkeyhint="done"
                    aria-label="新标签"
                    @keydown.enter.prevent="createTag"
                  />
                  <label class="pop-label">标签字段（契约控件）
                    <input
                      class="inp-text"
                      type="text"
                      :value="tagsText"
                      data-field="tags"
                      data-role="input"
                      placeholder="如：日常 孩子"
                      enterkeyhint="done"
                      aria-label="标签"
                      @input="onTagsChange"
                      @change="onTagsChange"
                    />
                  </label>
                </div>

                <div v-show="activePopover === 'flag'" class="pop-body js-pop-flag">
                  <h4>交易状态</h4>
                  <button type="button" class="pop-row" :class="{ on: form.flag === '*' }" data-flag="*" @click="selectFlag('*')">
                    <b>* 已完成</b><span>已确认入账</span><span v-if="form.flag === '*'" class="pop-row__check">✓</span>
                  </button>
                  <button type="button" class="pop-row" :class="{ on: form.flag === '!' }" data-flag="!" @click="selectFlag('!')">
                    <b>! 未完成</b><span>待确认核对</span><span v-if="form.flag === '!'" class="pop-row__check">✓</span>
                  </button>
                  <label class="pop-label">flag 字段（契约控件）
                    <select class="inp-text" data-field="flag" data-role="input" v-model="form.flag" aria-label="交易 flag">
                      <option value="*">* 已完成</option>
                      <option value="!">! 未完成</option>
                    </select>
                  </label>
                </div>

                <div v-show="activePopover === 'category'" class="pop-body js-pop-category">
                  <h4>全部{{ form.kind === 'income' ? '收入' : '支出' }}分类</h4>
                  <input
                    v-model="categorySearch"
                    class="inp-text"
                    type="search"
                    data-category-search="1"
                    placeholder="搜索中文名或导出名"
                    aria-label="搜索分类"
                  />
                  <div v-for="group in categoryGroups" :key="group.key" class="cat-group">
                    <div class="cat-group__head">{{ group.label }} <code>{{ group.mono }}</code></div>
                    <button
                      v-for="cat in group.accounts"
                      :key="cat.id"
                      type="button"
                      class="pop-row"
                      :class="{ on: form.categoryAccountId === cat.id }"
                      data-act="cat"
                      :data-cat="cat.id"
                      @click="selectCategory(cat.id)"
                    >
                      <span class="pop-row__icon">{{ catIcon(cat) }}</span>
                      <span class="pop-row__main">{{ accountLabel(cat) }}</span>
                      <code class="pop-row__mono">{{ cat.name }}</code>
                      <span v-if="form.categoryAccountId === cat.id" class="pop-row__check">✓</span>
                    </button>
                  </div>
                  <label class="pop-label">分类字段（契约控件）
                    <select
                      class="inp-text"
                      :value="categorySelectValue"
                      data-field="category"
                      data-role="input"
                      aria-label="完整分类列表"
                      @change="onCategorySelect"
                    >
                      <option value="">选择其他分类…</option>
                      <option v-for="cat in categoryOptions" :key="cat.id" :value="String(cat.id)">
                        {{ accountLabel(cat) }} · {{ cat.name }}
                      </option>
                    </select>
                  </label>
                </div>
              </div>
            </div>
            </Teleport>
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
            <!-- 高级键盘展开：临时替代底部全宽保存条（§12-1 / §5-B），无保存键。 -->
            <template v-if="advancedKeypadOpen">
              <div class="dock-rail">
                <span>第 {{ activeRowIndex + 1 }} 行金额 <b>¥<span class="js-adv-rail-amt">{{ magnitudeOf(form.advancedPostings?.[activeRowIndex]?.amount ?? '') }}</span></b></span>
                <span class="rail-r is-ok"><i></i><span class="js-adv-rail-txt">行内四则 · 完成后保存条复现</span></span>
              </div>
              <div class="rs-keyboard rs-keyboard--advanced js-adv-keypad">
                <button
                  v-for="key in advancedKeypadKeys"
                  :key="key"
                  type="button"
                  :class="keyClass(key)"
                  data-act="key"
                  :data-key="key"
                  @click="pressAdvancedKey(key)"
                >{{ key }}</button>
                <button
                  type="button"
                  class="rs-key rs-key--done js-adv-keypad-done"
                  data-act="advanced-keypad-done"
                  data-key="完成"
                  @click="closeAdvancedKeypad"
                >完成</button>
              </div>
            </template>
            <template v-else>
              <div class="rs-preview rs-preview--dock js-preview" :class="previewBalanced ? 'is-ok' : 'is-bad'" role="status">
                <template v-if="previewBalanced">✓ 配平</template>
                <template v-else>
                  {{ previewError === '' ? '不平' : previewError }}
                  <span v-for="diff in diffViews" :key="diff.commodity" class="rs-preview__diff">
                    {{ diff.commodity }} 差额 {{ diff.text }}
                  </span>
                </template>
              </div>
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
          </template>
          <div class="home-bar" aria-hidden="true"></div>
        </div>
      </template>
    </section>
    <!-- 浮层 portal 宿主：位于 mask 内、panel 外，不受弹窗 overflow 裁剪。 -->
    <div ref="portalHostEl" class="rs-portal-host"></div>
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

/* 浮层 portal 宿主：零尺寸固定定位，不参与 mask 的 flex 布局，也不裁剪子元素。
   ⚠️ fixed 元素自身会创建层叠上下文：若宿主停在 z-index:auto(0)，浮层内部的
   z-index:70 只在这个 0 层上下文里生效，仍会被面板内 .rs-tabs/.rs-amount 的
   z-index:1 盖住（矮屏底部浮层上缘压到金额区时必然暴露）。宿主层级必须高于
   面板内任意层级，浮层才能真正置顶。 */
.rs-portal-host {
  position: fixed;
  top: 0;
  left: 0;
  width: 0;
  height: 0;
  z-index: 70;
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

/* 安卓真机：--vvh 取 visualViewport.height，地址栏收起/展开或浏览器自带底部
   工具栏时它小于 layout 视口，面板高度 < inset:0 的遮罩高度 → 底部露出一截
   页面内容（半透明遮罩下透出账单列表；TabBar 已由 AppLayout v-show 隐藏）。
   系统键盘未弹出（body 无 kbd-open）时让面板铺满遮罩，缝隙归零；
   系统键盘弹出时仍回落 --vvh 收缩，保证面板整体在键盘上方可见。
   max-width 作用域避开 PC（≥900 已有 height:auto + max-height:720 的弹窗口径）。 */
@media (max-width: 899.98px) {
  body:not(.kbd-open) .rs-mask--auto .rs-panel,
  body:not(.kbd-open) .rs-mask--fullscreen .rs-panel {
    height: auto;
    min-height: 100%;
  }
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

.amt-chip {
  min-height: 26px;
  padding: 2px 9px;
  border: 1px solid var(--fb-brand-line);
  border-radius: var(--fb-radius-pill);
  background: var(--fb-card);
  color: var(--fb-brand);
  font-family: inherit;
  font-size: 10.5px;
  font-weight: 700;
  cursor: pointer;
}

.amt-expr {
  width: 100%;
  min-height: 20px;
  padding: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--fb-sub);
  font-family: var(--fb-font-mono);
  /* 物理键盘输入口同样遵守 iOS 16px 防缩放。 */
  font-size: 16px;
  line-height: 1.5;
}

.amt-error {
  margin-top: 2px;
  color: var(--fb-danger-ink);
  font-size: 11.5px;
  line-height: 1.5;
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
  grid-template-columns: repeat(6, minmax(0, 1fr));
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

.rs-cat__mono {
  max-width: 100%;
  margin-top: 2px;
  color: var(--fb-sub);
  font-family: var(--fb-font-mono);
  font-size: 8.5px;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rs-subcats {
  display: flex;
  gap: 6px;
  margin-top: 9px;
  padding-bottom: 4px;
  overflow-x: auto;
  white-space: nowrap;
  scrollbar-width: none;
}

.rs-subcats::-webkit-scrollbar {
  display: none;
}

.rs-subcat {
  flex: 0 0 auto;
  min-height: 34px;
  padding: 4px 10px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-pill);
  background: var(--fb-card);
  color: var(--fb-ink);
  font-family: inherit;
  font-size: 11.5px;
  cursor: pointer;
}

.rs-subcat.on {
  border-color: var(--fb-brand);
  background: var(--fb-brand-soft);
  color: var(--fb-brand);
  font-weight: 800;
}

.rs-subcat--all {
  border-style: dashed;
  border-color: var(--fb-brand-line);
  background: var(--fb-brand-soft);
  color: var(--fb-brand);
  font-weight: 700;
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

.date-chips {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.date-chips button {
  flex: 1;
  min-height: 44px;
  padding: 0 6px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-card);
  color: var(--fb-sub);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.date-chips button.on {
  border-color: var(--fb-seal);
  background: var(--fb-seal-soft);
  color: var(--fb-seal);
  font-weight: 700;
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
/* scoped 隔离使上面的规则穿透不到子组件，追加深度兜底防未来遗漏 */
.rs-body :deep(input),
.rs-body :deep(select) {
  font-size: 16px;
}

.rs-select {
  min-height: 40px;
  padding: 8px 12px;
  font-size: 16px;
}

/* meta chips：固定顺序，自然换行 */
.rs-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-bottom: 12px;
}

.meta-chip,
.transfer-chip {
  min-height: 36px;
  padding: 5px 12px;
  border: 1px solid var(--fb-line-strong);
  border-radius: var(--fb-radius-pill);
  background: var(--fb-card);
  color: var(--fb-ink);
  font-family: inherit;
  font-size: 11.5px;
  cursor: pointer;
}

.meta-chip:active,
.transfer-chip:active {
  border-color: var(--fb-brand);
}

.transfer-chips {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-bottom: 10px;
}

.transfer-arrow {
  color: var(--fb-sub);
  font-size: 14px;
}

/* 复式预览条：✓ 配平 / 按币种差额 */
.rs-preview {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 7px 12px;
  border-radius: var(--fb-radius-input);
  font-size: 11.5px;
  line-height: 1.5;
}

.rs-preview.is-ok {
  background: var(--fb-brand-soft);
  color: var(--fb-brand);
}

.rs-preview.is-bad {
  background: var(--fb-danger-soft);
  color: var(--fb-danger-ink);
}

.rs-preview__diff {
  font-family: var(--fb-font-numeric);
  font-weight: 800;
}

.rs-preview--dock {
  margin: 8px 12px 0;
}

/* 浮层：移动底部弹层；PC 用锚点变量降级为 chip 下方锚定下拉。 */
.rs-popover-mask {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 70;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: var(--fb-mask);
}

.rs-popover {
  position: relative;
  width: 100%;
  max-height: 72vh;
  overflow-y: auto;
  padding: 16px 14px 18px;
  border-radius: var(--fb-radius-card) var(--fb-radius-card) 0 0;
  background: var(--fb-card);
  box-shadow: var(--fb-shadow-panel);
}

.pop-handle {
  width: 40px;
  height: 4px;
  margin: -8px auto 10px;
  border-radius: var(--fb-radius-pill);
  background: var(--fb-line-strong);
}

.pop-close {
  position: absolute;
  top: 8px;
  right: 10px;
  min-width: 32px;
  min-height: 32px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-pill);
  background: var(--fb-soft);
  color: var(--fb-sub);
  font-family: inherit;
  cursor: pointer;
}

.pop-body h4 {
  margin: 0 36px 10px 0;
  color: var(--fb-ink-deep);
  font-size: 13px;
  line-height: 1.5;
}

.pop-label {
  display: block;
  margin-top: 12px;
  color: var(--fb-sub);
  font-size: 11px;
}

.pop-label .inp-text {
  margin-top: 5px;
}

.pop-error {
  margin: 6px 0 0;
  color: var(--fb-danger-ink);
  font-size: 11px;
}

.pop-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 44px;
  padding: 6px 10px;
  border: 1px solid transparent;
  border-bottom-color: var(--fb-line);
  background: transparent;
  color: var(--fb-ink);
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.pop-row.on {
  border-color: var(--fb-brand-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-brand-soft);
  color: var(--fb-brand);
}

.pop-row__icon {
  flex: 0 0 auto;
  font-size: 16px;
}

.pop-row__main {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pop-row__main b {
  margin-left: 6px;
  font-family: var(--fb-font-numeric);
  font-weight: 700;
}

.pop-row__mono,
.cat-group__head code {
  flex: 0 0 auto;
  color: var(--fb-sub);
  font-family: var(--fb-font-mono);
  font-size: 9.5px;
}

.pop-row__check {
  flex: 0 0 auto;
  color: var(--fb-brand);
  font-weight: 800;
}

.cal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 10px 0 6px;
}

.cal-head button {
  min-width: 36px;
  min-height: 32px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-card);
  color: var(--fb-brand);
  font-family: inherit;
  cursor: pointer;
}

.cal-title {
  color: var(--fb-ink-deep);
  font-family: var(--fb-font-mono);
  font-size: 12px;
}

.cal-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 3px;
}

.cal-week,
.cal-day {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 34px;
  border-radius: var(--fb-radius-input);
  font-size: 11.5px;
}

.cal-week {
  color: var(--fb-sub);
}

.cal-day {
  border: 1px solid transparent;
  background: var(--fb-soft);
  color: var(--fb-ink);
  font-family: inherit;
  cursor: pointer;
}

.cal-day.today {
  border-color: var(--fb-brand);
}

.cal-day.on {
  border-color: var(--fb-brand);
  background: var(--fb-brand);
  color: var(--fb-white);
  font-weight: 800;
}

.cal-day:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.cal-day--blank {
  background: transparent;
}

.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}

.pop-tag {
  min-height: 34px;
  padding: 4px 10px;
  border: 1px solid var(--fb-line-strong);
  border-radius: var(--fb-radius-pill);
  background: var(--fb-card);
  color: var(--fb-ink);
  font-family: inherit;
  font-size: 11.5px;
  cursor: pointer;
}

.pop-tag.on {
  border-color: var(--fb-brand);
  background: var(--fb-brand-soft);
  color: var(--fb-brand);
  font-weight: 800;
}

.pop-tag--new {
  border-style: dashed;
  border-color: var(--fb-brand-line);
  color: var(--fb-brand);
}

.cat-group {
  margin-top: 10px;
}

.cat-group__head {
  padding: 4px 0;
  color: var(--fb-ink-deep);
  font-size: 11.5px;
  font-weight: 800;
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
  /* 4×5 键位：压缩行高，保持与旧 4 行键盘近似的总高度。 */
  grid-auto-rows: calc(var(--kb-h) * 0.84);
  gap: 6px;
  padding: 8px 10px 10px;
  background: transparent;
}

.rs-key {
  min-height: calc(var(--kb-h) * 0.84);
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

/* 视觉上的 ✓ 走伪元素，按钮 text() 仍为「保存」，兼容既有契约测试。 */
.rs-key--save::after {
  content: '✓';
  margin-left: 3px;
}

.rs-key--advanced {
  background: var(--fb-soft);
  border-color: var(--fb-brand-line);
  color: var(--fb-brand);
  font-size: 11.5px;
  font-weight: 800;
}

/* 高级行内键盘动作条：「完成」与第五行「+」同行，占第 2~4 列（+ 占第 1 列），
   不承载保存语义。若用 1/-1 整行会让 17 键多出一行、键盘过高。 */
.rs-key--done {
  grid-column: 2 / -1;
  background: var(--fb-brand);
  border-color: var(--fb-brand);
  color: var(--fb-white);
  font-size: 13px;
  font-weight: 800;
  letter-spacing: 1px;
  box-shadow: var(--fb-shadow-brand);
  appearance: none;
  -webkit-appearance: none;
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

/* ≥900：与侧栏断点一致。用 padding-left 把 flex 居中基准移到右侧主区：
   遮罩背景仍覆盖全屏，panel 在主区内居中，且不引入 transform 包含块。 */
@media (min-width: 900px) {
  .rs-mask--auto {
    align-items: center;
    padding-left: var(--fb-sidebar-w);
  }
  .rs-mask--auto .rs-panel,
  .rs-mask--dialog .rs-panel {
    width: 460px;
    max-width: 92%;
    /* 键盘常驻后内容最小高度 ≈ head + stage + 5 行键 dock ≈ 600px；
       固定 520px + overflow:hidden 会把 dock 底部整段裁掉。改为内容自适应 +
       视口上限，超出的空间全由 .rs-body 收缩并独立滚动，dock 永远完整可见。 */
    height: auto;
    max-height: min(720px, calc(var(--vvh, 100vh) - 16px));
    border-radius: 18px;
  }
  /* PC 上 body 必须能把纵向空间让给常驻键盘（基础规则 min-height:96px 会
     把 dock 顶出裁剪区）；overflow-y:auto 保留，表单内部照常滚动。 */
  .rs-mask--auto .rs-body,
  .rs-mask--dialog .rs-body {
    min-height: 0;
  }
  /* PC 图册：紧凑键盘。设计稿键高约 27px，移动端 --kb-h（40~48px）放大到 34~40px
     才把表单区挤成一小条；只在 PC 容器作用域把 --kb-h 压到 37px（×0.84 ≈ 31px），
     配合 4px gap / 6+8px 内边距让键盘区从 ~244px 降到 ~185px，腾出的高度自动
     回到 body。移动端 <900px 不受影响，仍走 tokens.css 的 clamp。 */
  .rs-mask--auto,
  .rs-mask--dialog {
    --kb-h: 37px;
  }
  .rs-mask--auto .rs-keyboard,
  .rs-mask--dialog .rs-keyboard {
    grid-auto-rows: calc(var(--kb-h) * 0.84);
    gap: 4px;
    padding: 6px 10px 8px;
  }
  .rs-mask--auto .rs-key,
  .rs-mask--dialog .rs-key {
    min-height: calc(var(--kb-h) * 0.84);
    font-size: 14px;
  }
  .rs-mask--auto .rs-key--op,
  .rs-mask--dialog .rs-key--op {
    font-size: 13px;
  }
  .rs-mask--auto .rs-key--again,
  .rs-mask--dialog .rs-key--again {
    font-size: 11.5px;
  }
  .rs-mask--auto .rs-key--save,
  .rs-mask--dialog .rs-key--save,
  .rs-mask--auto .rs-key--done,
  .rs-mask--dialog .rs-key--done {
    font-size: 12px;
  }
  .rs-mask--auto .rs-key--advanced,
  .rs-mask--dialog .rs-key--advanced {
    font-size: 11px;
  }
  .rs-mask--auto .rs-panel--receipt,
  .rs-mask--dialog .rs-panel--receipt {
    width: 100%;
    max-width: 340px;
    height: 100%;
    border-radius: 0;
  }

  /* PC：浮层 = chip 锚定下拉，固定定位避开弹窗 overflow:hidden 裁剪。 */
  .rs-popover-mask {
    align-items: flex-start;
    justify-content: flex-start;
    background: var(--fb-bg-transparent);
  }

  .rs-popover {
    position: fixed;
    top: var(--pop-top, 120px);
    left: var(--pop-left, 50%);
    width: var(--pop-width, 250px);
    min-width: 250px;
    max-height: min(420px, 70vh);
    border: 1px solid var(--fb-line);
    border-radius: var(--fb-radius-card);
    box-shadow: var(--fb-shadow-panel);
  }

  .pop-handle {
    display: none;
  }
}
</style>
