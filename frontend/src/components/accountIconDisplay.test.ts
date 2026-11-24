// @vitest-environment jsdom
/**
 * 三处展示接入回归（批 II，catIcon 单一来源）：
 *   - 资产页分组行（AssetGroupList）：有 icon 显示 icon、缺失兜底 📁；
 *   - 分类页（CategoriesView）行首图标 + 「编辑」入口（viewer 不渲染按钮）；
 *   - 账户详情页（AccountDetailView）页头图标 + 编辑入口存在。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import { buildAssetBreakdown } from '@/core/assets'
import type { SummaryAccount } from '@/core/record'
import type { AccountView } from '@/api/types'
import { accountApi, transactionApi } from '@/api/client'
import AssetGroupList from '@/components/assets/AssetGroupList.vue'
import CategoriesView from '@/views/CategoriesView.vue'
import AccountDetailView from '@/views/AccountDetailView.vue'

vi.mock('@/api/client', () => ({
  accountApi: { list: vi.fn(), update: vi.fn(), create: vi.fn(), close: vi.fn(), updateSortOrders: vi.fn() },
  balanceApi: { preview: vi.fn(), set: vi.fn() },
  transactionApi: { list: vi.fn() },
}))

vi.mock('@/stores/privacy', () => ({
  usePrivacyStore: () => ({ enabled: false }),
}))

let viewer = false

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    ledgerId: 1,
    isViewer: viewer,
    isOwner: true,
    defaultCommodity: 'CNY',
    ledgers: [{ id: 1, name: '家庭账本', opening_date: '2026-01-01', role: 'owner' }],
  }),
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: '1' } }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}))

const ICON_ACCOUNT: AccountView = {
  id: 1,
  uuid: 'a-1',
  name: 'Assets:Bank',
  display_name: '招商储蓄',
  type: 'Assets',
  open_date: '2026-01-01',
  icon: '🏦',
  sort_order: 0,
  balances: { CNY: '100.00' },
}

const PLAIN_ACCOUNT: AccountView = {
  id: 2,
  uuid: 'a-2',
  name: 'Assets:NoIcon',
  display_name: '无图标',
  type: 'Assets',
  open_date: '2026-01-01',
  sort_order: 1,
  balances: { CNY: '5.00' },
}

// 分类页只渲染 Expenses / Income 组，夹具须与页面过滤口径匹配。
const CAT_ICON_ACCOUNT: AccountView = {
  id: 3,
  uuid: 'a-3',
  name: 'Expenses:Food',
  display_name: '餐饮',
  type: 'Expenses',
  open_date: '2026-01-01',
  icon: '🍖',
  sort_order: 0,
  balances: { CNY: '30.00' },
}

const CAT_PLAIN_ACCOUNT: AccountView = {
  id: 4,
  uuid: 'a-4',
  name: 'Expenses:Other',
  display_name: '其他',
  type: 'Expenses',
  open_date: '2026-01-01',
  sort_order: 1,
  balances: { CNY: '0.00' },
}

beforeEach(() => {
  viewer = false
  vi.mocked(accountApi.list).mockReset()
  vi.mocked(accountApi.update).mockReset()
  vi.mocked(transactionApi.list).mockReset()
  vi.mocked(accountApi.list).mockResolvedValue({
    accounts: [ICON_ACCOUNT, PLAIN_ACCOUNT, CAT_ICON_ACCOUNT, CAT_PLAIN_ACCOUNT],
  })
  vi.mocked(transactionApi.list).mockResolvedValue({ transactions: [] })
  document.body.innerHTML = ''
})

describe('资产页分组行图标', () => {
  it('有 icon 显示 icon，缺失兜底 📁（经 buildAssetBreakdown 透传）', () => {
    const breakdown = buildAssetBreakdown([ICON_ACCOUNT, PLAIN_ACCOUNT] as SummaryAccount[], 'CNY')
    const wrapper = mount(AssetGroupList, {
      props: { groups: breakdown.groups, commodity: breakdown.commodity, masked: false },
    })
    expect(wrapper.text()).toContain('🏦')
    expect(wrapper.text()).toContain('📁')
  })
})

describe('分类页行首图标与编辑入口', () => {
  it('行首显示账户 icon（🍖 有值 / 📁 兜底）；非 viewer 渲染「编辑」按钮', async () => {
    const wrapper = mount(CategoriesView)
    await flushPromises()
    expect(wrapper.text()).toContain('🍖')
    expect(wrapper.text()).toContain('📁')
    expect(wrapper.findAll('button').some((b) => b.text() === '编辑')).toBe(true)
  })

  it('viewer：不渲染「编辑」按钮（入口隐藏）', async () => {
    viewer = true
    const wrapper = mount(CategoriesView)
    await flushPromises()
    expect(wrapper.findAll('button').some((b) => b.text() === '编辑')).toBe(false)
  })
})

describe('账户详情页页头图标', () => {
  it('页头展示账户 icon，非 viewer 有编辑展示入口', async () => {
    const wrapper = mount(AccountDetailView)
    await flushPromises()
    expect(wrapper.find('.acctd__icon').text()).toBe('🏦')
    expect(wrapper.findAll('button').some((b) => b.text().includes('编辑展示'))).toBe(true)
  })

  it('viewer：编辑展示入口隐藏（写入口不渲染，而非仅禁用）', async () => {
    viewer = true
    const wrapper = mount(AccountDetailView)
    await flushPromises()
    expect(wrapper.findAll('button').some((b) => b.text().includes('编辑展示'))).toBe(false)
    expect(wrapper.find('.acctd__icon').exists()).toBe(true)
  })
})
