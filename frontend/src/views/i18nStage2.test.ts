// @vitest-environment jsdom
/**
 * i18n 阶段 2（子批 1~3 合并）：管理页 / 账户分类域 / 数据域在 setLocale('en') 后的
 * 关键文案为英文。
 *
 * 合并说明（原 `i18nStage2.batch1|2|3.test.ts` 三份 → 本文件）：
 * - 用例一条不删，共 13 条（5 + 5 + 3），按域分三个 describe；
 * - 三份原文件各自 mock 了 `vue-router` / `@/stores/session` / `@/api/client`，
 *   同文件内同一模块只能注册一次 `vi.mock`，故此处合并为**并集 factory**
 *   （含三批视图用到的全部字段与 api 方法），不丢任何用例的依赖；
 * - 统一 `afterEach` 复位 `setLocale('zh-CN')`：测试环境默认 locale 恒为 zh-CN，
 *   凡切过语言的用例必须复位，否则污染同文件后续用例与其它文件（项目记忆）。
 */
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { accountApi } from '@/api/client'
import type { AccountView } from '@/api/types'
import { setLocale } from '@/i18n'

import AccountEditSheet from '@/components/AccountEditSheet.vue'
import AccountForm from '@/components/AccountForm.vue'
import AccountDetailView from './AccountDetailView.vue'
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

const h = vi.hoisted(() => ({
  isViewer: false,
  refreshLedgers: vi.fn().mockResolvedValue(undefined),
  selectLedger: vi.fn(),
  logout: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('vue-router', () => ({
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

vi.mock('@/api/client', () => ({
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
  transactionApi: { list: vi.fn().mockResolvedValue({ transactions: [] }) },
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
