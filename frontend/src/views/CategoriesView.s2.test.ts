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
  isOwner: true,
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
    isOwner: h.isOwner,
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
  h.isOwner = true
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

describe('P0 可选 ASCII 英文账号（分类页，owner 可见）', () => {
  async function submitAscii(
    wrapper: ReturnType<typeof mount>,
    label: string,
    ascii: string,
  ): Promise<void> {
    await wrapper.find('input.cats__name').setValue(label)
    const asciiInput = wrapper.find('input.cats__ascii')
    expect(asciiInput.exists()).toBe(true)
    await asciiInput.setValue(ascii)
    const button = wrapper.findAll('button').find((b) => b.text() === '创建')
    await button?.trigger('click')
    await flushPromises()
  }

  it('owner 填 Food：落库 name = Expenses:Food', async () => {
    const wrapper = mount(CategoriesView)
    await flushPromises()
    await submitAscii(wrapper, '餐饮', 'Food')
    expect((h.create.mock.calls[0][0] as { name: string }).name).toBe('Expenses:Food')
    wrapper.unmount()
  })

  it('有上级填 Drinks：落库 name = <父名>:Drinks', async () => {
    const wrapper = mount(CategoriesView)
    await flushPromises()
    await wrapper.findAll('select')[1].setValue('1')
    await submitAscii(wrapper, '饮品', 'Drinks')
    expect((h.create.mock.calls[0][0] as { name: string }).name).toBe('Expenses:Food:Drinks')
    wrapper.unmount()
  })

  it('非法值只提示不阻断，服务端 400 才是权威', async () => {
    const wrapper = mount(CategoriesView)
    await flushPromises()
    await wrapper.find('input.cats__name').setValue('餐饮')
    await wrapper.find('input.cats__ascii').setValue('food')
    // 提交前给出提示，但不禁用按钮、不拦截请求；成功后服务端返回 400 才是权威。
    expect(wrapper.text()).toContain('大写字母或数字开头')
    const button = wrapper.findAll('button').find((b) => b.text() === '创建')
    await button?.trigger('click')
    await flushPromises()
    expect(h.create).toHaveBeenCalledTimes(1)
    expect((h.create.mock.calls[0][0] as { name: string }).name).toBe('Expenses:food')
    wrapper.unmount()
  })

  it('非 owner 不渲染英文账号输入框', async () => {
    h.isOwner = false
    const wrapper = mount(CategoriesView)
    await flushPromises()
    expect(wrapper.find('input.cats__ascii').exists()).toBe(false)
    await submitNew(wrapper, '早餐')
    expect((h.create.mock.calls[0][0] as { name: string }).name).toMatch(/^Expenses:Item\d+$/)
    wrapper.unmount()
  })
})

describe('上级下拉可辨识化（与 AccountForm 统一口径，AC-9）', () => {
  /** 上级下拉是第 2 个 select（第 1 个是类型）。 */
  function parentOptionsOf(wrapper: ReturnType<typeof mount>): string[] {
    return wrapper
      .findAll('select')[1]
      .findAll('option')
      .map((option) => option.text())
  }

  it('上级选项文案 = 显示名（全名）', async () => {
    const wrapper = mount(CategoriesView)
    await flushPromises()
    expect(parentOptionsOf(wrapper)).toContain('餐饮（Expenses:Food）')
    wrapper.unmount()
  })

  it('「无上级」明示生成形态，随类型切换联动', async () => {
    const wrapper = mount(CategoriesView)
    await flushPromises()
    expect(parentOptionsOf(wrapper)).toContain(
      '无 · 直接挂在类型根下（生成 Expenses:新段 两段全名）',
    )
    await wrapper.findAll('select')[0].setValue('Income')
    expect(parentOptionsOf(wrapper)).toContain(
      '无 · 直接挂在类型根下（生成 Income:新段 两段全名）',
    )
    wrapper.unmount()
  })
})
