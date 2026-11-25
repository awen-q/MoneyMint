// @vitest-environment jsdom
/**
 * i18n 阶段 2（子批 1~3 合并）：管理页 / 账户分类域 / 数据域在 setLocale('en') 后的
 * 关键文案为英文。
 *
 * 合并说明（原 `i18nStage2.batch1|2|3.test.ts` 三份 → 本文件）：
 * - 用例一条不删，子批 1~3 共 13 条（5 + 5 + 3），子批 4 追加 4 条、子批 6a 追加 3 条，
 *   按域分七个 describe（子批 1 / 2 / 3 / 4 / 5a / 5b / 6a）；
 * - 三份原文件各自 mock 了 `vue-router` / `@/stores/session` / `@/api/client`，
 *   同文件内同一模块只能注册一次 `vi.mock`，故此处合并为**并集 factory**
 *   （含三批视图用到的全部字段与 api 方法），不丢任何用例的依赖；
 * - 统一 `afterEach` 复位 `setLocale('zh-CN')`：测试环境默认 locale 恒为 zh-CN，
 *   凡切过语言的用例必须复位，否则污染同文件后续用例与其它文件（项目记忆）。
 */
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { accountApi, transactionApi } from '@/api/client'
import type { AccountView, TransactionView, TrashItemView } from '@/api/types'
import { roleLabel } from '@/core/batch3'
import { buildLineOption } from '@/core/charts/option'
import { previewText } from '@/core/balance'
import { formatImportErrors, importSummaryRows } from '@/core/m2'
import { buildPostings, evaluateAmountExpression, type BalanceGroup, type PostingView, type SummaryAccount } from '@/core/record'
import { periodBuckets, periodLabel, type ReportTxn } from '@/core/reports'
import { tagShares, untaggedLabel } from '@/core/stats'
import { defaultAccountLabel } from '@/core/storage'
import { buildTxnRow } from '@/core/txnRow'
import { en } from '@/i18n/en'
import { setLocale, t } from '@/i18n'

import AccountEditSheet from '@/components/AccountEditSheet.vue'
import AccountForm from '@/components/AccountForm.vue'
import AdvancedPostings from '@/components/AdvancedPostings.vue'
import PostingPreview from '@/components/PostingPreview.vue'
import RecordSheet from '@/components/RecordSheet.vue'
import TxnRow from '@/components/TxnRow.vue'
import AccountDetailView from './AccountDetailView.vue'
import AssetsView from './AssetsView.vue'
import BillsView from './BillsView.vue'
import StatsView from './StatsView.vue'
import AccountsView from './AccountsView.vue'
import CategoriesView from './CategoriesView.vue'
import CommoditiesView from './CommoditiesView.vue'
import DataSafetyView from './DataSafetyView.vue'
import ImportView from './ImportView.vue'
import LedgersView from './LedgersView.vue'
import MembersView from './MembersView.vue'
import RestoreView from './RestoreView.vue'
import SessionsView from './SessionsView.vue'
import SettingsView from './SettingsView.vue'
import TrashView from './TrashView.vue'

const h = vi.hoisted(() => ({
  isViewer: false,
  refreshLedgers: vi.fn().mockResolvedValue(undefined),
  selectLedger: vi.fn(),
  logout: vi.fn().mockResolvedValue(undefined),
}))

/**
 * 五视图共享的台账快照（`ledgerData` store）。
 * 用 getter 暴露 hoisted 可变状态：用例改 `ld.txns` / `ld.accounts` 后组件读到的就是新值，
 * 不必重新 mock 模块（同一文件内 mock 只能注册一次）。
 */
const ld = vi.hoisted(() => ({
  accounts: [] as unknown[],
  txns: [] as unknown[],
  loaded: true,
  fullReady: true,
  error: '',
}))

vi.mock('vue-router', () => ({
  // RecordSheet 通过 inject(routerKey, null) 取路由；测试无需真实实例，返回 null 即可。
  routerKey: Symbol('routerKey'),
  // 子批 1/3 的页面只用 push/replace；子批 2 的详情页还用到 back。
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  // 子批 2 的 AccountDetailView 读 params.id；其余页面不读 params。
  useRoute: () => ({ query: {}, params: { id: '1' } }),
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    ledgerId: 7,
    ledgerName: 'Home',
    defaultCommodity: 'CNY',
    ledgers: [
      {
        id: 7,
        name: 'Home',
        role: 'owner',
        opening_date: '2026-01-01',
        member_count: 0,
        account_count: 2,
        transaction_count: 3,
      },
    ],
    user: {
      id: 1,
      username: 'boss',
      display_name: 'Boss',
      role: 'owner',
      is_admin: true,
      must_change_password: false,
    },
    get isViewer() {
      return h.isViewer
    },
    isOwner: true,
    needsInvite: false,
    refreshLedgers: h.refreshLedgers,
    selectLedger: h.selectLedger,
    logout: h.logout,
    markGuest: vi.fn(),
  }),
}))

vi.mock('@/stores/privacy', () => ({
  usePrivacyStore: () => ({ enabled: false }),
}))

vi.mock('@/stores/ledgerData', () => ({
  useLedgerDataStore: () => ({
    get accounts() {
      return ld.accounts
    },
    get txns() {
      return ld.txns
    },
    get loaded() {
      return ld.loaded
    },
    get fullReady() {
      return ld.fullReady
    },
    get error() {
      return ld.error
    },
    ensure: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(undefined),
    setWindowMonth: vi.fn().mockResolvedValue(undefined),
    hasMonthWindow: () => true,
  }),
}))

vi.mock('@/stores/recordSheet', () => ({
  useRecordSheetStore: () => ({
    editingTxn: null,
    notifySaved: vi.fn(),
    notifyChanged: vi.fn(),
    savedEpoch: 0,
    open: vi.fn(),
  }),
}))

vi.mock('@/api/client', () => ({
  // 子批 4：回收站确认词是后端契约常量（组件原样传给 purge/purgeTrash），
  // 与真实客户端同值，用例据此断言它**不随语言变化**。
  PURGE_CONFIRM_WORD: '删除',
  // 子批 2：账户 / 分类域
  accountApi: {
    list: vi.fn().mockResolvedValue({ accounts: [] }),
    create: vi.fn().mockResolvedValue({ id: 9, uuid: 'new-1', name: 'Assets:Item1' }),
    update: vi.fn().mockResolvedValue({ ok: true }),
    close: vi.fn().mockResolvedValue({ ok: true }),
    updateSortOrders: vi.fn().mockResolvedValue({ ok: true, updated: 0 }),
  },
  openingApi: {
    get: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue({ status: 'created' }),
  },
  balanceApi: {
    preview: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue({ status: 'created' }),
  },
  newIdempotencyKey: () => 'QA-KEY',
  transactionApi: {
    list: vi.fn().mockResolvedValue({ transactions: [] }),
    listPage: vi.fn().mockResolvedValue({
      transactions: [],
      next_cursor: undefined,
      has_more: false,
    }),
    // 子批 7：记一笔保存（任务一：默认描述不随语言漂移）
    create: vi.fn().mockResolvedValue({
      id: 9,
      uuid: 't-9',
      date: '2026-11-21',
      flag: '*',
      description: 'x',
      postings: 2,
    }),
    // 子批 4：回收站（默认空列表，用例按需 Once 覆盖）
    trash: vi.fn().mockResolvedValue({
      transactions: [],
      purge_summary: { deletable: 0, system_kept: 0, paired: 0 },
      purge_log: [],
    }),
    restore: vi.fn().mockResolvedValue({ ok: true }),
    purge: vi.fn().mockResolvedValue({ ok: true, count: 0, deleted: [], purged_postings: 0 }),
    purgeTrash: vi.fn().mockResolvedValue({ ok: true, count: 0, deleted: [], purged_postings: 0 }),
  },
  // 子批 1：管理页
  settingsApi: {
    registration: vi.fn().mockResolvedValue({ enabled: true }),
    setRegistration: vi.fn().mockResolvedValue({ enabled: true }),
  },
  sessionApi: {
    list: vi.fn().mockResolvedValue({ sessions: [] }),
    revoke: vi.fn().mockResolvedValue({ ok: true }),
    revokeOthers: vi.fn().mockResolvedValue({ revoked: 0 }),
  },
  memberApi: {
    list: vi.fn().mockResolvedValue({ members: [] }),
    add: vi.fn().mockResolvedValue({ ok: true }),
    updateRole: vi.fn().mockResolvedValue({ ok: true }),
    remove: vi.fn().mockResolvedValue({ ok: true }),
    resetPassword: vi.fn().mockResolvedValue({ ok: true }),
  },
  ledgerManageApi: {
    create: vi.fn().mockResolvedValue({ id: 8 }),
    update: vi.fn().mockResolvedValue({ ok: true }),
    remove: vi.fn().mockResolvedValue({ ok: true }),
  },
  commodityApi: {
    list: vi.fn().mockResolvedValue({ commodities: [] }),
    create: vi.fn().mockResolvedValue({ uuid: 'c-2', symbol: 'USD', precision: 2 }),
    remove: vi.fn().mockResolvedValue({ ok: true }),
  },
  // 子批 3：数据域
  backupApi: {
    list: vi.fn().mockResolvedValue({ items: [] }),
    run: vi.fn().mockResolvedValue({ ok: true }),
    download: vi.fn().mockResolvedValue(new Blob(['x'])),
  },
  exportApi: {
    beancount: vi.fn().mockResolvedValue({ blob: new Blob(['x']), balanced: true, diffs: [] }),
    archive: vi.fn().mockResolvedValue({ blob: new Blob(['x']), balanced: true, diffs: [] }),
  },
  identityApi: { check: vi.fn().mockResolvedValue({ balanced: true, diffs: [] }) },
  restoreApi: {
    preview: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue(null),
  },
  importApi: {
    preview: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue(null),
    undo: vi.fn().mockResolvedValue({}),
  },
}))

const ACCOUNT: AccountView = {
  id: 1,
  uuid: 'acc-1',
  name: 'Assets:Bank',
  display_name: '储蓄银行',
  type: 'Assets',
  open_date: '2026-01-01',
  icon: '🏦',
  sort_order: 0,
}

beforeEach(() => {
  h.isViewer = false
  document.body.innerHTML = ''
})

afterEach(() => {
  // 统一复位语言单例（项目记忆：切过 locale 必须复位）。
  setLocale('zh-CN')
  // 只清调用记录，保留 vi.fn 的 mockResolvedValue 实现（mockRestore 会清掉实现）。
  vi.clearAllMocks()
})

describe('i18n 阶段 2 子批 1：管理页英文化', () => {
  it('设置页：标题 / 外观 / 退出登录为英文', async () => {
    setLocale('en')
    const wrapper: VueWrapper = mount(SettingsView, {
      global: { stubs: { AppVersionCard: true } },
    })
    await flushPromises()
    expect(wrapper.find('.set__title').text()).toBe('Settings')
    expect(wrapper.text()).toContain('Appearance')
    expect(wrapper.text()).toContain('Sign out')
    wrapper.unmount()
  })

  it('登录设备页：标题与刷新按钮为英文', async () => {
    setLocale('en')
    const wrapper = mount(SessionsView)
    await flushPromises()
    expect(wrapper.find('.ses__title').text()).toBe('Signed-in devices')
    expect(wrapper.text()).toContain('Refresh')
    wrapper.unmount()
  })

  it('成员管理页：标题与邀请按钮为英文', async () => {
    setLocale('en')
    const wrapper = mount(MembersView)
    await flushPromises()
    expect(wrapper.find('.mem__title').text()).toBe('Members')
    expect(wrapper.text()).toContain('Invite member')
    wrapper.unmount()
  })

  it('账本管理页：标题与新建按钮为英文', async () => {
    setLocale('en')
    const wrapper = mount(LedgersView)
    await flushPromises()
    expect(wrapper.find('.ldg__title').text()).toBe('Ledgers')
    expect(wrapper.text()).toContain('New ledger')
    wrapper.unmount()
  })

  it('币种管理页：标题与新增区为英文', async () => {
    setLocale('en')
    const wrapper = mount(CommoditiesView, {
      global: { stubs: { MoneyText: true } },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('Currencies · ledger default CNY')
    expect(wrapper.text()).toContain('New currency')
    wrapper.unmount()
  })
})

describe('i18n 阶段 2 子批 2：账户 / 分类域英文化', () => {
  it('分类管理页：页头与新建区为英文', async () => {
    setLocale('en')
    const wrapper = mount(CategoriesView)
    await flushPromises()
    expect(wrapper.text()).toContain('Categories · categories are type accounts')
    expect(wrapper.text()).toContain('New category')
    wrapper.unmount()
  })

  it('账户管理页：页头标题与新建按钮为英文', async () => {
    setLocale('en')
    const wrapper = mount(AccountsView)
    await flushPromises()
    expect(wrapper.text()).toContain('Accounts · Home')
    expect(wrapper.text()).toContain('+ New account')
    wrapper.unmount()
  })

  it('账户表单：标题、类型选项与保存按钮为英文', async () => {
    setLocale('en')
    const wrapper = mount(AccountForm, { props: { mode: 'create' } })
    await flushPromises()
    expect(wrapper.text()).toContain('New account')
    expect(wrapper.text()).toContain('Assets')
    expect(wrapper.findAll('button').some((b) => b.text() === 'Save')).toBe(true)
    wrapper.unmount()
  })

  it('账户展示编辑弹层：标题与保存按钮为英文', async () => {
    setLocale('en')
    const wrapper = mount(AccountEditSheet, { props: { account: ACCOUNT } })
    await flushPromises()
    expect(wrapper.text()).toContain('Edit display · Assets:Bank')
    expect(wrapper.findAll('button').some((b) => b.text() === 'Save')).toBe(true)
    wrapper.unmount()
  })

  it('账户详情页：返回与关户按钮为英文', async () => {
    setLocale('en')
    vi.mocked(accountApi.list).mockResolvedValueOnce({ accounts: [ACCOUNT] })
    const wrapper = mount(AccountDetailView, { attachTo: document.body })
    await flushPromises()
    expect(wrapper.text()).toContain('‹ Back')
    expect(wrapper.text()).toContain('Close account (Beancount close)')
    wrapper.unmount()
  })
})

describe('i18n 阶段 2 子批 3：数据域英文化', () => {
  it('数据安全页：标题与导出 / 导入入口为英文', async () => {
    setLocale('en')
    const wrapper = mount(DataSafetyView)
    await flushPromises()
    expect(wrapper.find('.ds__title').text()).toBe('Data safety')
    expect(wrapper.text()).toContain('Export Beancount')
    expect(wrapper.text()).toContain('Import Beancount')
    wrapper.unmount()
  })

  it('还原备份页：标题与第一步选文件说明为英文', async () => {
    setLocale('en')
    const wrapper = mount(RestoreView)
    await flushPromises()
    expect(wrapper.find('.rs__title').text()).toBe('Restore backup')
    expect(wrapper.text()).toContain('Select a backup file')
    expect(wrapper.text()).toContain('Start check')
    wrapper.unmount()
  })

  it('导入 Beancount 页：标题与目标切换按钮为英文', async () => {
    setLocale('en')
    const wrapper = mount(ImportView)
    await flushPromises()
    expect(wrapper.find('.im__title').text()).toBe('Import Beancount')
    expect(wrapper.text()).toContain('Import into current ledger')
    expect(wrapper.text()).toContain('Create new ledger')
    wrapper.unmount()
  })
})

describe('i18n 阶段 2 子批 4：交易域英文化', () => {
  // 账户只需要 buildTxnRow 判类型与展示名的字段（SummaryAccount 的结构子集）。
  const BANK: AccountView = {
    id: 1,
    uuid: 'acc-bank',
    name: 'Assets:Bank',
    display_name: 'Bank',
    type: 'Assets',
    open_date: '2026-01-01',
    sort_order: 0,
  }
  const CASH: AccountView = {
    id: 5,
    uuid: 'acc-cash',
    name: 'Assets:Cash',
    display_name: 'Cash',
    type: 'Assets',
    open_date: '2026-01-01',
    sort_order: 1,
  }
  const FOOD: AccountView = {
    id: 2,
    uuid: 'acc-food',
    name: 'Expenses:Food',
    display_name: 'Food',
    type: 'Expenses',
    open_date: '2026-01-01',
    sort_order: 2,
  }
  const ACCOUNTS_T: AccountView[] = [BANK, CASH, FOOD]

  function txnFixture(overrides: Partial<TransactionView> = {}): TransactionView {
    const base: TransactionView = {
      id: 1,
      uuid: 'u-1',
      date: '2026-11-09',
      flag: '*',
      description: '',
      created_by_name: 'Wen',
      postings: [
        { account_id: 2, account: 'Expenses:Food', commodity: 'CNY', amount: '10.00' },
        { account_id: 1, account: 'Assets:Bank', commodity: 'CNY', amount: '-10.00' },
      ],
    }
    return { ...base, ...overrides }
  }

  /** 回收站记录（字段形状与 TrashItemView 对齐）。 */
  function trashItem(overrides: Partial<TrashItemView> = {}): TrashItemView {
    return {
      uuid: 't-1',
      date: '2026-11-01',
      flag: '*',
      description: 'Deleted breakfast',
      tags: [],
      deleted_at: '2026-11-02T10:00:00Z',
      created_by_name: 'Wen',
      postings: [],
      can_restore: true,
      ...overrides,
    }
  }

  /** SelectSheet 关闭时调用 window.scrollTo；jsdom 未实现，替换成 spy 消除噪音。 */
  function stubScroll(): void {
    Object.defineProperty(window, 'scrollTo', { value: vi.fn(), writable: true, configurable: true })
  }

  it('core/txnRow：切 en 后类型标签 / 徽章 / 兜底标题随语言求值（非模块快照）', () => {
    setLocale('en')
    const expense = buildTxnRow(txnFixture(), ACCOUNTS_T, 'search')
    expect(expense.meta.find((item) => item.kind === 'type')).toEqual({
      kind: 'type',
      text: 'Expense',
    })

    // 被冲正的转账：reversal 组 + kind 组各一枚，均为英文。
    const transfer = txnFixture({
      reversed_by: 'rev-1',
      postings: [
        { account_id: 1, account: 'Assets:Bank', commodity: 'CNY', amount: '-100.00' },
        { account_id: 5, account: 'Assets:Cash', commodity: 'CNY', amount: '100.00' },
      ],
    })
    const row = buildTxnRow(transfer, ACCOUNTS_T, 'search')
    expect(row.badges.map((badge) => badge.label)).toEqual(['Reversed', 'Transfer'])
    expect(row.meta.find((item) => item.kind === 'type')?.text).toBe('Transfer')

    // 无备注且账户未加载 → 兜底标题（旧实现是模块顶层中文常量，切语言不会变）。
    expect(buildTxnRow(txnFixture({ description: '' }), [], 'bill').title).toBe(
      'Untitled transaction',
    )
  })

  it('TxnRow：en 下渲染英文徽章与可访问名后缀', () => {
    setLocale('en')
    const wrapper = mount(TxnRow, {
      props: {
        view: {
          id: 1,
          amount: '-12.50',
          commodity: 'CNY',
          signed: true,
          title: 'Lunch',
          meta: [{ kind: 'category', text: 'Food' }],
          badges: [{ label: 'Reversed', tone: 'reversal' as const }],
        },
        variant: 'bill',
      },
      global: { plugins: [createPinia()] },
    })
    expect(wrapper.find('.txn-row__badge').text()).toBe('Reversed')
    expect(wrapper.text()).toContain('View details')
    wrapper.unmount()
  })

  it('回收站：en 下页头 / 系统交易标记 / 审计为英文', async () => {
    setLocale('en')
    stubScroll()
    vi.mocked(transactionApi.trash).mockResolvedValueOnce({
      transactions: [trashItem({ is_system: true, can_purge: false })],
      purge_summary: { deletable: 0, system_kept: 1, paired: 0 },
      purge_log: [
        {
          uuid: 'g-1',
          description: 'gone',
          amount_note: '-10.00 CNY',
          was_in_trash: true,
          actor_name: '',
          purged_at: '2026-11-03T09:00:00Z',
        },
      ],
    })
    const wrapper = mount(TrashView)
    await flushPromises()
    expect(wrapper.text()).toContain('Trash · 1 deleted')
    expect(wrapper.text()).toContain('System transaction · cannot be permanently deleted')
    expect(wrapper.text()).toContain('Permanent deletion log')
    // 操作人空串回落「Unknown member」（不留空档）。
    expect(wrapper.text()).toContain('Unknown member')
    expect(wrapper.findAll('button').some((btn) => btn.text() === 'Restore')).toBe(true)
    wrapper.unmount()
  })

  it('回收站：en 下永久删除仍以字面量「删除」提交（后端契约常量不本地化）', async () => {
    setLocale('en')
    stubScroll()
    vi.mocked(transactionApi.trash).mockResolvedValueOnce({
      transactions: [trashItem({ can_purge: true })],
      purge_summary: { deletable: 1, system_kept: 0, paired: 0 },
      purge_log: [],
    })
    const wrapper = mount(TrashView)
    await flushPromises()

    await wrapper.find('[aria-label="More actions"]').trigger('click')
    const menuEntry = wrapper.findAll('button').find((btn) => btn.text() === 'Delete permanently')
    expect(menuEntry).toBeTruthy()
    await menuEntry!.trigger('click')
    // 二次确认的解释性文案为英文（strong 内的「不可恢复」也随语言）。
    expect(wrapper.text()).toContain('cannot be undone')

    vi.mocked(transactionApi.trash).mockResolvedValueOnce({
      transactions: [],
      purge_summary: { deletable: 0, system_kept: 0, paired: 0 },
      purge_log: [],
    })
    const confirm = wrapper
      .findAll('button')
      .find((btn) => btn.text() === 'Confirm permanent deletion')
    await confirm!.trigger('click')
    await flushPromises()

    // 确认词仍是中文「删除」：后端 TrimSpace 严等该字面量，en 下 t() 化会永远校验失败。
    expect(transactionApi.purge).toHaveBeenCalledWith('t-1', '删除')
    wrapper.unmount()
  })
})

describe('i18n 阶段 2 子批 5a：core 收尾', () => {
  it('core/batch3.roleLabel：en 下四种角色为英文', () => {
    setLocale('en')
    expect(roleLabel('owner')).toBe('Owner')
    expect(roleLabel('editor')).toBe('Editor')
    expect(roleLabel('viewer')).toBe('View only')
    expect(roleLabel('')).toBe('Not in a ledger')
  })

  it('core/balance.previewText：en 下整句与插值金额随语言（非模块快照）', () => {
    setLocale('en')
    const text = previewText('2026-03-01', '12000.00', '12350.00')
    expect(text).toContain('As of the start of 2026-03-01')
    expect(text).toContain('current cumulative 12,000.00')
    expect(text).toContain('target 12,350.00')
    expect(text).toContain('auto-adjust by +350.00')
  })

  it('core/m2.formatImportErrors：en 下行号文案随语言', () => {
    setLocale('en')
    expect(formatImportErrors([{ line: 3, msg: 'unsupported directive' }])).toEqual([
      'Line 3: unsupported directive',
    ])
  })

  it('core/m2.importSummaryRows：en 下五行标签随语言求值', () => {
    setLocale('en')
    const rows = importSummaryRows({
      valid: true,
      title: '',
      target: 'current',
      ledger_name: '',
      new_accounts: 2,
      reuse_accounts: 1,
      new_transactions: 5,
      skip_transactions: 1,
      new_commodities: 1,
      pad_balance: [],
      conflicts: [],
      duplicate: false,
      errors: [],
    })
    expect(rows.map((r) => r.label)).toEqual([
      'New accounts',
      'Reused accounts',
      'New transactions',
      'Skipped transactions (already exist)',
      'New currencies',
    ])
  })
})

describe('i18n 阶段 2 子批 5b：core 剩余', () => {
  it('core/reports：周标签 / 月刻度 / 区间文案在 en 下随语言求值（非模块快照）', () => {
    setLocale('en')
    const week = periodBuckets('week', new Date(2026, 10, 11))
    expect(week[0].label).toBe('Mon')
    expect(week[6].label).toBe('Sun')
    // 年刻度：12 个月份名，同样访问时求值。
    expect(periodBuckets('year', new Date(2026, 0, 1))[0].label).toBe('Jan')
    expect(periodLabel('month', new Date(2026, 10, 11))).toBe('11/2026')
    // 切回 zh-CN 后立即恢复原文（证明没有模块级常量快照）。
    setLocale('zh-CN')
    expect(periodBuckets('week', new Date(2026, 10, 11))[0].label).toBe('周一')
  })

  it('core/stats：untaggedLabel 是函数，tagShares 的未打标签桶随语言', () => {
    setLocale('en')
    expect(untaggedLabel()).toBe('Untagged')

    const accounts: SummaryAccount[] = [
      { id: 2, name: 'Expenses:Food', type: 'Expenses' },
    ]
    const txns: ReportTxn[] = [
      {
        id: 1,
        date: '2026-11-01',
        description: 'no tag',
        created_by_name: '',
        postings: [{ account_id: 2, commodity: 'CNY', amount: '10.00' }],
      },
    ]
    const shares = tagShares(txns, accounts, 'CNY')
    const untagged = shares.find((share) => share.isUntagged)
    expect(untagged === undefined ? '' : untagged.tag).toBe('Untagged')
    expect(untagged === undefined ? '' : untagged.expense).toBe('10.00')
  })

  it('core/storage：默认账户位显示名随语言（纯 UI 文案，不入账本数据）', () => {
    setLocale('en')
    expect(defaultAccountLabel('fund')).toBe('Default fund account')
    setLocale('zh-CN')
    expect(defaultAccountLabel('fund')).toBe('默认资金账户')
  })

  it('core/record：RangeError 中文消息迁入字典后 en 下输出英文（含插值标签）', () => {
    setLocale('en')
    expect(() => evaluateAmountExpression('')).toThrow(
      'Amount may contain only digits, a decimal point, and + - * /',
    )
    // 缺资金账户：插值标签随语言，整句为英文。
    expect(() =>
      buildPostings(
        {
          kind: 'expense',
          amountExpression: '10',
          date: '2026-11-01',
          description: '',
          tags: [],
          categoryAccountId: 1,
          fundAccountId: null,
          transferFromAccountId: null,
          transferToAccountId: null,
        },
        [{ id: 1, name: 'Expenses:Food', type: 'Expenses' }],
        'CNY',
      ),
    ).toThrow('Please select the fund account')
  })
})

describe('i18n 阶段 2 子批 6a：分录编辑器英文化', () => {
  /** 五类账户各一枚：高级浮层按类型分组，组头标题也需要随语言。 */
  const TYPE_ACCOUNTS: AccountView[] = [
    { id: 1, uuid: 'e1', name: 'Assets:Bank', display_name: 'Bank', type: 'Assets', open_date: '2026-01-01', sort_order: 0 },
    { id: 2, uuid: 'e2', name: 'Liabilities:Credit', display_name: 'Credit', type: 'Liabilities', open_date: '2026-01-01', sort_order: 0 },
    { id: 3, uuid: 'e3', name: 'Income:Salary', display_name: 'Salary', type: 'Income', open_date: '2026-01-01', sort_order: 0 },
    { id: 4, uuid: 'e4', name: 'Expenses:Food', display_name: 'Food', type: 'Expenses', open_date: '2026-01-01', sort_order: 0 },
    { id: 5, uuid: 'e5', name: 'Equity:Opening', display_name: 'Opening', type: 'Equity', open_date: '2026-01-01', sort_order: 0 },
  ]

  function advProps() {
    return {
      rows: [
        { accountId: 1, amount: '-10.00', commodity: 'CNY' },
        { accountId: 4, amount: '10.00', commodity: 'CNY' },
      ],
      accounts: TYPE_ACCOUNTS,
      commodities: ['CNY'],
      bean: 'preview',
    }
  }

  it('AdvancedPostings：en 下标题 / 配平卡 / 增行按钮 / 差额行随语言', async () => {
    setLocale('en')
    const wrapper = mount(AdvancedPostings, { props: advProps() })
    await flushPromises()
    // 两段 .g-title：先「双录分录」后「配平检查」。
    expect(wrapper.findAll('.g-title')[0].text()).toBe('Double-entry postings')
    expect(wrapper.findAll('.g-title')[1].text()).toBe('Balance check')
    expect(wrapper.find('.js-bal-tag').text()).toBe('✓ Balanced')
    expect(wrapper.text()).toContain('+ Add posting')
    expect(wrapper.find('.js-check').text()).toContain('CNY debit total (+)')
    // 契约 select 的首个 option 是占位项（真实账户名仍是数据，不译）。
    expect(wrapper.find('option').text()).toBe('Select account…')
    wrapper.unmount()
  })

  it('AdvancedPostings：en 下账户浮层标题 / 五类组头 / 搜索占位符随语言', async () => {
    setLocale('en')
    const wrapper = mount(AdvancedPostings, { props: advProps() })
    await flushPromises()
    await wrapper.find('[data-rf="acc"][data-role="chip"]').trigger('click')
    await flushPromises()

    const floating = document.body.querySelector('.adv-popover')
    expect(floating).not.toBeNull()
    expect(floating?.querySelector('.adv-pop-head b')?.textContent).toBe('Select account (row 1)')
    const heads = Array.from(floating?.querySelectorAll('.adv-group__head') ?? []).map(
      (node) => node.textContent ?? '',
    )
    expect(heads).toHaveLength(5)
    expect(heads).toContain('ASSETS · Assets')
    expect(heads).toContain('EQUITY · Equity')
    expect((floating?.querySelector('.adv-search') as HTMLInputElement).placeholder).toBe(
      'Search display_name / name',
    )
    expect(floating?.querySelector('.adv-pop-close')?.getAttribute('aria-label')).toBe(
      'Close picker',
    )
    wrapper.unmount()
  })

  it('PostingPreview：en 下表头 / 借贷徽标 / 空态账户 / 合计行 / bean 说明为英文', () => {
    setLocale('en')
    const placeholder: SummaryAccount = { id: -1, name: '', type: '' }
    const postings: PostingView[] = [
      { account: placeholder, name: '', label: '', amount: '10.00', commodity: 'CNY', isDebit: true },
      { account: placeholder, name: 'Assets:Bank', label: 'Bank', amount: '-10.00', commodity: 'CNY', isDebit: false },
    ]
    const groups: BalanceGroup[] = [
      { commodity: 'CNY', sum: '0.00', pos: '10.00', neg: '-10.00', rows: 2, balanced: true },
    ]
    const wrapper = mount(PostingPreview, {
      props: { postings, groups, bean: 'Assets:Bank -10.00 CNY' },
    })

    expect(wrapper.find('.g-title').text()).toBe('Posting preview · double entry')
    expect(wrapper.find('.js-bal-tag').text()).toBe('✓ Balanced')
    const signs = wrapper.findAll('.p-sign')
    expect(signs[0].text()).toBe('Debit')
    expect(signs[1].text()).toBe('Credit')
    expect(wrapper.findAll('.p-main b')[0].text()).toBe('Account not selected')
    expect(wrapper.find('.bal-chip').text()).toContain('2 postings')
    expect(wrapper.find('.bal-chip').text()).toContain('✓ Balanced per currency (sum = 0)')
    expect(wrapper.find('.bean-note').text()).toContain('each posting is account amount currency')
    wrapper.unmount()
  })
})

describe('i18n 阶段 2 子批 7：五视图英文化', () => {
  /** 五视图共用的账户（资产 / 支出 / 收入 / 负债各一）。 */
  const VIEW_ACCOUNTS: AccountView[] = [
    { id: 1, uuid: 'v-bank', name: 'Assets:Bank', display_name: 'Bank', type: 'Assets', open_date: '2026-01-01', sort_order: 0, balances: { CNY: '12000.00' } },
    { id: 2, uuid: 'v-food', name: 'Expenses:Food', display_name: 'Food', type: 'Expenses', open_date: '2026-01-01', sort_order: 1 },
    { id: 3, uuid: 'v-salary', name: 'Income:Salary', display_name: 'Salary', type: 'Income', open_date: '2026-01-01', sort_order: 2 },
    { id: 4, uuid: 'v-loan', name: 'Liabilities:Loan', display_name: 'Loan', type: 'Liabilities', open_date: '2026-01-01', sort_order: 3, balances: { CNY: '-1000.00' } },
  ]

  function twoDigits(value: number): string {
    return value < 10 ? `0${value}` : String(value)
  }

  /** 当前月的一笔支出：账单 / 统计页的窗口过滤都按「当月」判 ready。 */
  function currentMonthTxn(): TransactionView {
    const now = new Date()
    return {
      id: 1,
      uuid: 'v-txn-1',
      date: `${now.getFullYear()}-${twoDigits(now.getMonth() + 1)}-15`,
      flag: '*',
      description: 'Lunch',
      created_by_name: 'Wen',
      postings: [
        { account_id: 2, account: 'Expenses:Food', commodity: 'CNY', amount: '10.00' },
        { account_id: 1, account: 'Assets:Bank', commodity: 'CNY', amount: '-10.00' },
      ],
    }
  }

  /** 折线图桩：把 series 序列化到属性上（不建 ECharts 实例）。 */
  const TrendStub = {
    name: 'TrendChart',
    props: ['title', 'note', 'chartLabel', 'labels', 'series', 'commodity', 'masked', 'height', 'wideHeight'],
    template: '<div class="trend-stub" :data-series="JSON.stringify(series)" :data-title="title" />',
  }

  function seriesNames(wrapper: VueWrapper): string[] {
    const raw = wrapper.find('.trend-stub').attributes('data-series') ?? '[]'
    const parsed = JSON.parse(raw) as Array<{ name: string }>
    return parsed.map((item) => item.name)
  }

  beforeEach(() => {
    ld.accounts = VIEW_ACCOUNTS
    ld.txns = [currentMonthTxn()]
    ld.loaded = true
    ld.fullReady = true
    ld.error = ''
  })

  it('账单页：en 下标题 / 卡头为英文，折线系列名随语言（切语言即重取）', async () => {
    const wrapper = mount(BillsView, {
      global: { plugins: [createPinia()], stubs: { TrendChart: TrendStub } },
    })
    await flushPromises()
    // 先断言 zh-CN 原文（测试环境默认），再切 en 验证「不是模块快照」。
    expect(wrapper.find('.bills__title').text()).toBe('账单')
    expect(seriesNames(wrapper)).toEqual(['收入', '支出'])

    setLocale('en')
    await flushPromises()
    expect(wrapper.find('.bills__title').text()).toBe(en['shell.nav.bills'])
    expect(wrapper.find('.bills__card-title').text()).toBe(en['bills.monthDetail'])
    expect(wrapper.find('.bills__group-date').text()).toBe(en['bills.groupDate']
      .replace('{month}', String(new Date().getMonth() + 1))
      .replace('{day}', '15'))
    // 图表标签跟随：series 名称来自 t()，切语言后折线桩收到英文名。
    expect(seriesNames(wrapper)).toEqual([en['common.income'], en['common.expense']])
    wrapper.unmount()
  })

  it('统计页：en 下页名 / 指标 / 折线系列名为英文', async () => {
    setLocale('en')
    const wrapper = mount(StatsView, {
      global: {
        plugins: [createPinia()],
        stubs: {
          TrendChart: TrendStub,
          DonutRankCard: true,
          CategoryBarCard: true,
          DailyTable: true,
          MemberCard: true,
          TrialBalanceCard: true,
        },
      },
    })
    await flushPromises()
    expect(wrapper.find('.stats__title').text()).toBe(en['shell.nav.stats'])
    expect(wrapper.text()).toContain(en['stats.avgExpense'])
    expect(seriesNames(wrapper)).toEqual([en['common.income'], en['common.expense']])
    wrapper.unmount()
  })

  it('资产页：en 下页名 / 总览 / 净资产标签为英文', async () => {
    setLocale('en')
    const wrapper = mount(AssetsView, {
      global: { plugins: [createPinia()], stubs: { AccountForm: true } },
    })
    await flushPromises()
    expect(wrapper.find('.assets__title').text()).toBe(en['shell.nav.assets'])
    expect(wrapper.find('.assets__card-title').text()).toBe(en['assets.overview'])
    expect(wrapper.find('.asset-hero__label').text()).toBe(
      en['assets.netWorthLabel'].replace('{commodity}', 'CNY'),
    )
    expect(wrapper.text()).toContain(en['assets.totalAssets'])
    wrapper.unmount()
  })

  it('图表 option：系列名由 t() 求值，切 en 后构造函数输出英文（重绘入口）', () => {
    // 颜色用 CSS 关键字：theme.guard 会扫描源码里的十六进制色值，测试文件同样受管。
    const colors = {
      grid: 'gainsboro',
      ink: 'black',
      inkDeep: 'black',
      expense: 'firebrick',
      income: 'seagreen',
    }
    function build(): Array<{ name: string }> {
      const option = buildLineOption({
        labels: ['1'],
        series: [{ name: t('common.income'), color: 'seagreen', points: [{ value: 1, amount: '1.00' }] }],
        colors,
        commodity: 'CNY',
      }) as { series: Array<{ name: string }> }
      return option.series
    }
    setLocale('zh-CN')
    expect(build()[0].name).toBe('收入')
    setLocale('en')
    expect(build()[0].name).toBe('Income')
  })

  it('记一笔：en 下保存写入的默认描述仍是原中文（数据不随 UI 语言漂移）', async () => {
    setLocale('en')
    localStorage.clear()
    const RECORD_ACCOUNTS: AccountView[] = [
      { id: 1, uuid: 'r-cash', name: 'Assets:Cash', display_name: 'Cash', type: 'Assets', open_date: '2026-01-01', sort_order: 0 },
      { id: 5, uuid: 'r-bank', name: 'Assets:Bank', display_name: 'Bank', type: 'Assets', open_date: '2026-01-01', sort_order: 1 },
      { id: 2, uuid: 'r-food', name: 'Expenses:Food', display_name: 'Food', type: 'Expenses', open_date: '2026-01-01', sort_order: 2 },
    ]
    vi.mocked(accountApi.list).mockResolvedValueOnce({ accounts: RECORD_ACCOUNTS })
    const wrapper = mount(RecordSheet, { global: { plugins: [createPinia()] } })
    await flushPromises()
    expect(wrapper.findAll('.rs-tabs button').map((btn) => btn.text())).toContain('Transfer')

    const tab = wrapper.findAll('[data-act="tab"]').find((btn) => btn.text() === 'Transfer')
    await tab?.trigger('click')
    await wrapper.find('[data-act="amount"]').trigger('click')
    for (const key of ['1', '0', '0']) {
      const button = wrapper.findAll('.rs-key').find((item) => item.text() === key)
      await button?.trigger('click')
    }
    await wrapper.find('.js-save').trigger('click')
    await flushPromises()

    expect(vi.mocked(transactionApi.create)).toHaveBeenCalledTimes(1)
    const payload = vi.mocked(transactionApi.create).mock.calls[0][0] as { description: string }
    // 默认描述是写入账本数据（会被 .beancount 导出）的字段，刻意不 i18n。
    expect(payload.description).toBe('转账')
    wrapper.unmount()
  })
})

describe('i18n 阶段 2 子批 6b：记一笔英文化', () => {
  /** 记账弹窗需要至少一个支出 / 一个资产账户，九宫格与资金账户才有内容。 */
  const RECORD_ACCOUNTS: AccountView[] = [
    { id: 1, uuid: 'r-cash', name: 'Assets:Cash', display_name: 'Cash', type: 'Assets', open_date: '2026-01-01', sort_order: 0 },
    { id: 2, uuid: 'r-food', name: 'Expenses:Food', display_name: 'Food', type: 'Expenses', open_date: '2026-01-01', sort_order: 0 },
  ]

  it('记一笔：en 下模式 Tab 为英文', async () => {
    setLocale('en')
    vi.mocked(accountApi.list).mockResolvedValueOnce({ accounts: RECORD_ACCOUNTS })
    const wrapper = mount(RecordSheet, { global: { plugins: [createPinia()] } })
    await flushPromises()
    expect(wrapper.findAll('.rs-tabs button').map((btn) => btn.text())).toEqual([
      'Expense',
      'Income',
      'Transfer',
    ])
    expect(wrapper.find('.rs-head h3').text()).toBe('New entry')
    wrapper.unmount()
  })

  it('记一笔：en 下数字键盘保存键与金额可访问名为英文', async () => {
    setLocale('en')
    vi.mocked(accountApi.list).mockResolvedValueOnce({ accounts: RECORD_ACCOUNTS })
    const wrapper = mount(RecordSheet, { global: { plugins: [createPinia()] } })
    await flushPromises()
    expect(wrapper.find('.rs-key--save').text()).toBe('Save')
    expect(wrapper.find('[data-act="amount"]').attributes('aria-label')).toBe('Tap to enter amount')
    wrapper.unmount()
  })

  it('记一笔：en 下金额区说明与校验提示为英文', async () => {
    setLocale('en')
    vi.mocked(accountApi.list).mockResolvedValueOnce({ accounts: RECORD_ACCOUNTS })
    const wrapper = mount(RecordSheet, { global: { plugins: [createPinia()] } })
    await flushPromises()
    // 支出态金额区说明（RecordSheet 字典）与行内校验（core/record）均为英文。
    expect(wrapper.find('.amt-sub').text()).toBe(
      'Fund accounts take negative amounts and expense categories positive; saving requires each currency to sum to 0.',
    )
    expect(wrapper.find('.js-rail-txt').text()).toContain('Amount may contain only digits')
    wrapper.unmount()
  })
})
