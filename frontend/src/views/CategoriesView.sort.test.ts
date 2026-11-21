// @vitest-environment jsdom
/**
 * P0 分类拖拽落库回归：
 *   - 拖动后按 type 整组提交 uuid + 0-based sort_order；
 *   - localStorage 草稿存 uuid，成功提示不再声称「本设备生效」；
 *   - 旧 number[] 草稿被丢弃，回落到服务端 sort_order（IndexOf(uuid) 静默失效防护）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import type { AccountView } from '@/api/types'
import CategoriesView from '@/views/CategoriesView.vue'

const h = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  close: vi.fn(),
  updateSortOrders: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  accountApi: {
    list: h.list,
    create: h.create,
    close: h.close,
    updateSortOrders: h.updateSortOrders,
  },
  transactionApi: { create: vi.fn() },
  newIdempotencyKey: () => 'SORT-KEY',
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    ledgerId: 7,
    isViewer: false,
    defaultCommodity: 'CNY',
    ledgers: [{ id: 7, name: '测试账本', opening_date: '2026-01-01', role: 'owner' }],
    needsInvite: false,
  }),
}))

vi.mock('@/stores/recordSheet', () => ({
  useRecordSheetStore: () => ({ notifySaved: vi.fn(), savedEpoch: 0, open: vi.fn() }),
}))

vi.mock('@/stores/privacy', () => ({
  usePrivacyStore: () => ({ enabled: false }),
}))

vi.mock('@/components/MoneyText.vue', () => ({
  default: {
    props: ['amount', 'commodity', 'size'],
    template: '<span class="money-stub">{{ amount }}</span>',
  },
}))

function account(uuid: string, index: number): AccountView {
  return {
    id: index + 1,
    uuid,
    name: `Expenses:Item${index + 1}`,
    display_name: uuid,
    type: 'Expenses',
    open_date: '2026-01-01',
    sort_order: index,
    balances: {},
  }
}

const ORDER_KEY = 'fambean.category_order.7'

beforeEach(() => {
  localStorage.clear()
  h.list.mockReset().mockResolvedValue({
    accounts: [account('u-a', 0), account('u-b', 1), account('u-c', 2)],
  })
  h.create.mockReset()
  h.close.mockReset()
  h.updateSortOrders.mockReset().mockResolvedValue({ ok: true, updated: 3 })
})

describe('分类拖拽按 type 整组落库（P0）', () => {
  it('拖动首行到末位：提交 uuid 顺序 + 0-based sort_order，草稿存 uuid', async () => {
    const wrapper = mount(CategoriesView)
    await flushPromises()
    const rows = wrapper.findAll('li.cats__row')
    expect(rows).toHaveLength(3)

    await rows[0].trigger('dragstart')
    await rows[2].trigger('drop')
    await flushPromises()

    expect(h.updateSortOrders).toHaveBeenCalledTimes(1)
    expect(h.updateSortOrders.mock.calls[0][0]).toEqual({
      orders: [
        { uuid: 'u-b', sort_order: 0 },
        { uuid: 'u-c', sort_order: 1 },
        { uuid: 'u-a', sort_order: 2 },
      ],
    })
    // 提交成功后清除该组草稿，避免本端旧草稿盖掉其他端后续顺序。
    expect(JSON.parse(localStorage.getItem(ORDER_KEY) ?? '{}')).toEqual({})
    expect(wrapper.find('.cats__notice').text()).toContain('其他端刷新后同步')
    expect(wrapper.find('.cats__notice').text()).not.toContain('本设备生效')
    wrapper.unmount()
  })

  it('提交失败：保留本地草稿并说明同步失败，不伪装成功', async () => {
    h.updateSortOrders.mockRejectedValueOnce(new Error('offline'))
    const wrapper = mount(CategoriesView)
    await flushPromises()
    const rows = wrapper.findAll('li.cats__row')
    await rows[0].trigger('dragstart')
    await rows[1].trigger('drop')
    await flushPromises()

    expect(JSON.parse(localStorage.getItem(ORDER_KEY) ?? '{}').Expenses).toEqual([
      'u-b',
      'u-a',
      'u-c',
    ])
    expect(wrapper.find('.cats__notice').text()).toContain('同步失败')
    wrapper.unmount()
  })

  it('旧 number[] 草稿被降级清理，列表回落服务端 sort_order', async () => {
    localStorage.setItem(ORDER_KEY, JSON.stringify({ Expenses: [3, 1, 2] }))
    const wrapper = mount(CategoriesView)
    await flushPromises()

    const labels = wrapper.findAll('li.cats__row .cats__name').map((node) => node.text())
    expect(labels[0]).toContain('u-a')
    expect(localStorage.getItem(ORDER_KEY)).toBeNull()

    // 降级后拖动仍按 uuid 整组提交，不会因 indexOf(uuid)===-1 静默失效。
    const rows = wrapper.findAll('li.cats__row')
    await rows[0].trigger('dragstart')
    await rows[1].trigger('drop')
    await flushPromises()
    expect(h.updateSortOrders.mock.calls[0][0].orders).toEqual([
      { uuid: 'u-b', sort_order: 0 },
      { uuid: 'u-a', sort_order: 1 },
      { uuid: 'u-c', sort_order: 2 },
    ])
    wrapper.unmount()
  })
})
