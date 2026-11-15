// @vitest-environment jsdom
/**
 * 0.6.0 S2 / AC-2.5：分类页新建与 AccountForm 统一，同样传 parent_uuid；
 * 中文显示名生成 ASCII 合法全名；core/accounts.ts 的冒号兜底不参与主路径。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import type { AccountView } from '@/api/types'
import CategoriesView from '@/views/CategoriesView.vue'

const h = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  close: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  accountApi: { list: h.list, create: h.create, close: h.close },
  transactionApi: { create: vi.fn() },
  newIdempotencyKey: () => 'S2-KEY',
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

const FOOD: AccountView = {
  id: 1,
  uuid: 'u-food',
  name: 'Expenses:Food',
  display_name: '餐饮',
  type: 'Expenses',
  open_date: '2026-01-01',
  sort_order: 0,
  balances: {},
}

beforeEach(() => {
  h.list.mockReset()
  h.create.mockReset()
  h.close.mockReset()
  localStorage.clear()
  h.list.mockResolvedValue({ accounts: [FOOD] })
  h.create.mockResolvedValue({
    id: 2,
    uuid: 'u-new',
    name: 'Expenses:Item1',
    type: 'Expenses',
    open_date: '2026-01-01',
  })
})

async function submitNew(wrapper: ReturnType<typeof mount>, label: string): Promise<void> {
  const input = wrapper.find('input.cats__name')
  await input.setValue(label)
  const button = wrapper.findAll('button').find((b) => b.text() === '创建')
  expect(button).toBeDefined()
  await button?.trigger('click')
  await flushPromises()
}

describe('分类页新建传 parent_uuid（AC-2.5）', () => {
  it('无上级：parent_uuid 为显式空串，name 为 ASCII 合法全名，display_name 为中文', async () => {
    const wrapper = mount(CategoriesView)
    await flushPromises()
    await submitNew(wrapper, '早餐')

    expect(h.create).toHaveBeenCalledTimes(1)
    const body = h.create.mock.calls[0][0] as {
      name: string
      display_name: string
      parent_uuid: string
      type: string
    }
    expect(body.parent_uuid).toBe('')
    expect(body.name).toMatch(/^Expenses:Item\d+$/)
    expect(body.display_name).toBe('早餐')
    expect(body.type).toBe('Expenses')
    wrapper.unmount()
  })

  it('选中上级：parent_uuid 落父 uuid，类型与全名继承父项', async () => {
    const wrapper = mount(CategoriesView)
    await flushPromises()
    const selects = wrapper.findAll('select')
    // 第一个是类型，第二个是上级分类。
    await selects[1].setValue('1')
    await submitNew(wrapper, '零食')

    const body = h.create.mock.calls[0][0] as {
      name: string
      parent_uuid: string
      type: string
    }
    expect(body.parent_uuid).toBe('u-food')
    expect(body.name).toMatch(/^Expenses:Food:Item\d+$/)
    expect(body.type).toBe('Expenses')
    wrapper.unmount()
  })
})
