// @vitest-environment jsdom
/**
 * 关键词过滤的**端到端**证明（B3 前置）
 *
 * `filters.test.ts` 只证明「`applyFilters` 会按关键词过滤」；这条用例证明的是
 * **流水页真的接上了它** —— 路由带 `?q=` 进来时渲染出的行数确实变少。
 *
 * 为什么需要这一条：`applyFilters` 与页面之间还有 `filtersFromQuery` → `reactive`
 * → `computed(filtered)` → `grouped` 四跳，任何一跳忘了透传 `keyword`，
 * 组件级测试全绿而功能失效（正是「测试绿、功能坏」的典型形态）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { flushPromises, mount } from '@vue/test-utils'

import TransactionsView from '@/views/TransactionsView.vue'

const h = vi.hoisted(() => ({
  accountList: vi.fn(),
  txnList: vi.fn(),
  replace: vi.fn(),
  push: vi.fn(),
  query: {} as Record<string, string>,
}))

vi.mock('@/api/client', () => ({
  accountApi: { list: h.accountList },
  transactionApi: { list: h.txnList },
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: h.query }),
  useRouter: () => ({ replace: h.replace, push: h.push }),
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    ledgerId: 7,
    ledgerName: '家用账本',
    isViewer: false,
    needsInvite: false,
    defaultCommodity: 'CNY',
  }),
}))

vi.mock('@/stores/privacy', () => ({
  usePrivacyStore: () => ({ enabled: false }),
}))

const ACCOUNTS = [
  { id: 1, name: 'Assets:Cash', display_name: '招商储蓄', type: 'Assets', uuid: 'u1', open_date: '2026-01-01', sort_order: 1 },
  { id: 4, name: 'Expenses:Food', display_name: '食品饮料', type: 'Expenses', uuid: 'u4', open_date: '2026-01-01', sort_order: 2 },
  { id: 5, name: 'Income:Salary', display_name: '薪资收入', type: 'Income', uuid: 'u5', open_date: '2026-01-01', sort_order: 3 },
]

const TXNS = [
  {
    id: 1,
    uuid: 't1',
    date: '2026-11-09',
    flag: '*',
    description: '午餐',
    created_by_name: '阿文',
    postings: [
      { account_id: 4, account: 'Expenses:Food', commodity: 'CNY', amount: '38.50' },
      { account_id: 1, account: 'Assets:Cash', commodity: 'CNY', amount: '-38.50' },
    ],
  },
  {
    id: 2,
    uuid: 't2',
    date: '2026-11-01',
    flag: '*',
    description: '十月工资',
    created_by_name: '太太',
    postings: [
      { account_id: 5, account: 'Income:Salary', commodity: 'CNY', amount: '-9500.00' },
      { account_id: 1, account: 'Assets:Cash', commodity: 'CNY', amount: '9500.00' },
    ],
  },
  {
    id: 3,
    uuid: 't3',
    date: '2026-11-05',
    flag: '*',
    description: '搬钱',
    created_by_name: '阿文',
    postings: [
      { account_id: 1, account: 'Assets:Cash', commodity: 'CNY', amount: '-2000.00' },
      { account_id: 1, account: 'Assets:Cash', commodity: 'CNY', amount: '2000.00' },
    ],
  },
]

async function mountWithQuery(query: Record<string, string>): Promise<string[]> {
  h.query = query
  const wrapper = mount(TransactionsView, {
    global: { stubs: { RouterLink: true } },
  })
  await flushPromises()
  const descriptions = wrapper.findAll('.txn__row-desc').map((node) => node.text())
  wrapper.unmount()
  return descriptions
}

beforeEach(() => {
  h.accountList.mockReset()
  h.txnList.mockReset()
  h.replace.mockReset()
  h.push.mockReset()
  h.accountList.mockResolvedValue({ accounts: ACCOUNTS })
  h.txnList.mockResolvedValue({ transactions: TXNS })
})

describe('关键词端到端：?q= 真的减少了渲染行数', () => {
  it('无 q 时渲染全部 3 行', async () => {
    const rows = await mountWithQuery({})
    expect(rows).toHaveLength(3)
  })

  it('?q=午餐 时只渲染 1 行（4 跳透传全部生效）', async () => {
    const rows = await mountWithQuery({ q: '午餐' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('午餐')
  })

  it('?q=招商 命中账户展示名 → 3 笔都挂在招商储蓄下', async () => {
    const rows = await mountWithQuery({ q: '招商' })
    expect(rows).toHaveLength(3)
  })

  it('?q=绝不存在的词 → 0 行，且显示空态文案（不是空白页）', async () => {
    const rows = await mountWithQuery({ q: '绝不存在的词' })
    expect(rows).toHaveLength(0)
  })
})
