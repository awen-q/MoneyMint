// @vitest-environment jsdom
/**
 * P-05 软删走通自测（批 2 追加）：列表透出交易 uuid 后，
 * 详情页软删入口解除置灰，确认后 DELETE 恰好以该 uuid 调用一次并返回列表。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import TransactionDetailView from '@/views/TransactionDetailView.vue'

const h = vi.hoisted(() => ({
  remove: vi.fn(),
  listTxns: vi.fn(),
  listAccounts: vi.fn(),
  push: vi.fn(),
  isViewer: false,
}))

vi.mock('@/api/client', () => ({
  accountApi: { list: h.listAccounts },
  transactionApi: { list: h.listTxns, remove: h.remove },
}))

vi.mock('vue-router', () => ({
  routerKey: Symbol.for('router'),
  useRoute: () => ({ params: {}, query: { id: '11' } }),
  useRouter: () => ({ back: vi.fn(), push: h.push, replace: vi.fn() }),
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    ledgerId: 7,
    isViewer: h.isViewer,
    defaultCommodity: 'CNY',
    ledgers: [],
  }),
}))

vi.mock('@/stores/privacy', () => ({
  usePrivacyStore: () => ({ enabled: false }),
}))

// 0.6.0 S6：详情页新增编辑入口（recordSheet 编辑态）；基线用例不触达，替身即可。
vi.mock('@/stores/recordSheet', () => ({
  useRecordSheetStore: () => ({
    editingTxn: null,
    savedEpoch: 0,
    openEdit: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
    notifySaved: vi.fn(),
    notifyChanged: vi.fn(),
  }),
}))

const ACCOUNTS = {
  accounts: [
    { id: 1, uuid: 'a-1', name: 'Assets:Cash', display_name: '招商储蓄', type: 'Assets', open_date: '2026-01-01', sort_order: 0 },
    { id: 2, uuid: 'a-2', name: 'Expenses:Food', display_name: '食品饮料', type: 'Expenses', open_date: '2026-01-01', sort_order: 0 },
  ],
}

const TXNS = {
  transactions: [
    {
      id: 11,
      uuid: 't-11',
      date: '2026-11-09',
      flag: '*',
      description: '午餐',
      created_by_name: '阿文',
      postings: [
        { account_id: 2, account: 'Expenses:Food', commodity: 'CNY', amount: '38.50' },
        { account_id: 1, account: 'Assets:Cash', commodity: 'CNY', amount: '-38.50' },
      ],
    },
  ],
}

beforeEach(() => {
  h.isViewer = false
  h.remove.mockReset()
  h.remove.mockResolvedValue({ ok: true })
  h.listTxns.mockReset()
  h.listTxns.mockResolvedValue(TXNS)
  h.listAccounts.mockReset()
  h.listAccounts.mockResolvedValue(ACCOUNTS)
  h.push.mockReset()
})

describe('P-05 软删（uuid 解锁后）', () => {
  it('软删入口可用；确认后 remove 恰好以交易 uuid 调用一次并返回列表', async () => {
    const wrapper = mount(TransactionDetailView, { attachTo: document.body })
    await flushPromises()

    expect(wrapper.text()).toContain('午餐')
    const deleteBtn = wrapper.findAll('button').find((b) => b.text().includes('删除这笔交易'))
    expect(deleteBtn?.attributes('disabled')).toBeUndefined()

    await deleteBtn?.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('确认删除')

    const confirmBtn = wrapper.findAll('button').find((b) => b.text() === '确认删除')
    await confirmBtn?.trigger('click')
    await flushPromises()

    expect(h.remove).toHaveBeenCalledTimes(1)
    expect(h.remove).toHaveBeenCalledWith('t-11')
    expect(h.push).toHaveBeenCalledWith({ name: 'transactions' })
  })

  it('只读成员：删除入口禁用且点击不发起请求', async () => {
    h.isViewer = true
    const wrapper = mount(TransactionDetailView, { attachTo: document.body })
    await flushPromises()

    const deleteBtn = wrapper.findAll('button').find((b) => b.text().includes('删除这笔交易'))
    expect(deleteBtn?.attributes('disabled')).toBeDefined()
    await deleteBtn?.trigger('click')
    await flushPromises()
    expect(h.remove).not.toHaveBeenCalled()
  })
})

// ---------- P0-1：原生语法片段（默认收起，只在详情层展示） ----------
describe('P0-1 原生语法片段', () => {
  async function mountDetail(): Promise<ReturnType<typeof mount>> {
    const wrapper = mount(TransactionDetailView, { attachTo: document.body })
    await flushPromises()
    return wrapper
  }

  async function expand(wrapper: ReturnType<typeof mount>): Promise<void> {
    const toggle = wrapper.find('[data-testid="bean-snippet"] button')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    await toggle.trigger('click')
    await flushPromises()
  }

  it('默认收起：折叠区存在但不渲染片段，展开后才出现与导出一致的 posting 行', async () => {
    const wrapper = await mountDetail()
    const section = wrapper.find('[data-testid="bean-snippet"]')
    expect(section.exists()).toBe(true)
    expect(section.find('pre').exists()).toBe(false)
    expect(section.text()).toContain('展开原生语法片段')

    await expand(wrapper)

    const code = section.find('pre').text()
    expect(code).toBe(
      [
        '2026-11-09 * "午餐"',
        '  Expenses:Food 38.50 CNY',
        '  Assets:Cash -38.50 CNY',
      ].join('\n'),
    )
    // 无字段语义绝不编造：^链接 / 成本批次 / @@ 兑换 / #tag 一个都不能出现
    expect(code).not.toContain('#')
    expect(code).not.toContain('^')
    expect(code).not.toContain('@@')
    expect(code).not.toContain('FIFO')
    expect(section.text()).not.toContain('成本批次')
  })

  it('标签走 tags 元数据行；Flagged、多 posting、冲正语义只列真实字段', async () => {
    h.listTxns.mockResolvedValue({
      transactions: [
        {
          id: 11,
          uuid: 't-12',
          date: '2026-11-10',
          flag: '!',
          description: '退货退款',
          created_by_name: '阿文',
          tags: ['日常', '孩子'],
          reversal_of: 'a1b2c3d4-1111-2222-3333-444455556666',
          postings: [
            { account_id: 2, account: 'Expenses:Food', commodity: 'CNY', amount: '-12.00' },
            { account_id: 1, account: 'Assets:Cash', commodity: 'CNY', amount: '9.00' },
            { account_id: 3, account: 'Income:Refund', commodity: 'CNY', amount: '3.00' },
          ],
        },
      ],
    })
    const wrapper = await mountDetail()
    await expand(wrapper)

    const section = wrapper.find('[data-testid="bean-snippet"]')
    const code = section.find('pre').text()
    expect(code).toContain('2026-11-10 ! "退货退款"')
    expect(code).toContain('  tags: "日常 孩子"')
    expect(code).not.toContain('#tag')
    expect(code).not.toContain('#日常')
    expect(code.split('\n')).toHaveLength(5) // 交易头 + tags 行 + 3 条 posting
    expect(section.text()).toContain('Flagged')
    expect(section.text()).toContain('分录拆分')
    expect(section.text()).toContain('冲正交易')
    expect(section.text()).toContain('TXN a1b2c3d4')
  })

  it('已被冲正时列新交易号；标签为空不输出 tags 行', async () => {
    h.listTxns.mockResolvedValue({
      transactions: [
        {
          id: 11,
          uuid: 't-13',
          date: '2026-11-11',
          flag: '*',
          description: '旧版交易',
          created_by_name: '阿文',
          reversed_by: 'ffffffff-1111-2222-3333-444455556666',
          postings: [
            { account_id: 2, account: 'Expenses:Food', commodity: 'CNY', amount: '1.00' },
            { account_id: 1, account: 'Assets:Cash', commodity: 'CNY', amount: '-1.00' },
          ],
        },
      ],
    })
    const wrapper = await mountDetail()
    await expand(wrapper)

    const section = wrapper.find('[data-testid="bean-snippet"]')
    expect(section.find('pre').text()).not.toContain('tags:')
    expect(section.text()).toContain('已被冲正')
    expect(section.text()).toContain('TXN ffffffff')
    expect(section.text()).not.toContain('期初 OPENING')
  })
})
