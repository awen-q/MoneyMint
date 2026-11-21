// @vitest-environment jsdom
/**
 * 0.6.0 S2 / C-03：账户表单只收中文显示名，自动生成 ASCII 合法全名；
 * 「＋ 增加下级」入口预填父项、类型继承、parent_uuid 必传（根为显式空串）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import type { AccountView } from '@/api/types'
import AccountForm from '@/components/AccountForm.vue'

const h = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  isOwner: true,
}))

vi.mock('@/api/client', () => ({
  accountApi: { create: h.create, close: vi.fn(), list: h.list },
  openingApi: { get: vi.fn(), set: vi.fn() },
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    ledgerId: 7,
    isViewer: false,
    isOwner: h.isOwner,
    defaultCommodity: 'CNY',
    ledgers: [{ id: 7, name: '测试账本', opening_date: '2026-01-01', role: 'owner' }],
  }),
}))

vi.mock('@/components/MoneyText.vue', () => ({
  default: {
    props: ['amount', 'commodity', 'size'],
    template: '<span class="money-stub">{{ amount }}</span>',
  },
}))

const PARENT: AccountView = {
  id: 5,
  uuid: 'p-1',
  name: 'Expenses:Food',
  display_name: '餐饮',
  type: 'Expenses',
  open_date: '2026-01-01',
  sort_order: 0,
}

async function submitWithName(wrapper: ReturnType<typeof mount>, label: string): Promise<void> {
  const nameInput = wrapper.findAll('input').find((i) => (i.element as HTMLInputElement).type === 'text')
  expect(nameInput).toBeDefined()
  await nameInput?.setValue(label)
  const save = wrapper.findAll('button').find((b) => b.text() === '保存')
  expect(save).toBeDefined()
  await save?.trigger('click')
  await flushPromises()
}

beforeEach(() => {
  h.isOwner = true
  h.create.mockReset()
  h.list.mockReset()
  h.list.mockResolvedValue({ accounts: [] })
  h.create.mockResolvedValue({
    id: 9,
    uuid: 'new-1',
    name: 'Assets:Item1',
    type: 'Assets',
    open_date: '2026-01-01',
  })
})

describe('中文展示名 → ASCII 合法全名（C-03 / AC-2.3）', () => {
  it('无父账户：name 自动生成 ASCII 全名，display_name 保留中文，parent_uuid 显式为空串', async () => {
    const wrapper = mount(AccountForm, { props: { mode: 'create' } })
    await flushPromises()
    await submitWithName(wrapper, '招商储蓄')

    expect(h.create).toHaveBeenCalledTimes(1)
    const body = h.create.mock.calls[0][0] as {
      name: string
      display_name: string
      parent_uuid: string
      type: string
    }
    expect(body.name).toMatch(/^Assets:Item\d+$/)
    expect(body.display_name).toBe('招商储蓄')
    expect(body.parent_uuid).toBe('')
    expect(body.type).toBe('Assets')
    wrapper.unmount()
  })

  it('传入 parent：父项预填、类型继承且置灰，parent_uuid 落父 uuid', async () => {
    const wrapper = mount(AccountForm, { props: { mode: 'create', parent: PARENT } })
    await flushPromises()

    expect(wrapper.text()).toContain('增加下级')
    const typeSelect = wrapper.findAll('select')[0]
    expect((typeSelect.element as HTMLSelectElement).disabled).toBe(true)
    expect((typeSelect.element as HTMLSelectElement).value).toBe('Expenses')

    await submitWithName(wrapper, '早餐')

    const body = h.create.mock.calls[0][0] as {
      name: string
      display_name: string
      parent_uuid: string
      type: string
    }
    expect(body.name).toMatch(/^Expenses:Food:Item\d+$/)
    expect(body.display_name).toBe('早餐')
    expect(body.parent_uuid).toBe('p-1')
    expect(body.type).toBe('Expenses')
    wrapper.unmount()
  })

  it('已存在同名全名时自动递增序号，不落库后才报重名', async () => {
    h.list.mockResolvedValue({
      accounts: [{ ...PARENT, id: 1, uuid: 'x-1', name: 'Expenses:Food:Item1' }],
    })
    const wrapper = mount(AccountForm, { props: { mode: 'create', parent: PARENT } })
    await flushPromises()
    await submitWithName(wrapper, '零食')

    const body = h.create.mock.calls[0][0] as { name: string }
    expect(body.name).toBe('Expenses:Food:Item2')
    wrapper.unmount()
  })
})

describe('P0 可选 ASCII 英文账号（owner 可见，服务端守门）', () => {
  async function submitAscii(
    wrapper: ReturnType<typeof mount>,
    label: string,
    ascii: string,
  ): Promise<void> {
    const display = wrapper.findAll('input').find((i) => (i.element as HTMLInputElement).type === 'text')
    expect(display).toBeDefined()
    await display?.setValue(label)
    const asciiInput = wrapper.find('input.af-ascii')
    expect(asciiInput.exists()).toBe(true)
    await asciiInput.setValue(ascii)
    const save = wrapper.findAll('button').find((b) => b.text() === '保存')
    await save?.trigger('click')
    await flushPromises()
  }

  it('owner 填 Food：落库 name = Expenses:Food', async () => {
    const wrapper = mount(AccountForm, { props: { mode: 'create' } })
    await flushPromises()
    await wrapper.findAll('select')[0].setValue('Expenses')
    await submitAscii(wrapper, '餐饮', 'Food')

    expect(h.create).toHaveBeenCalledTimes(1)
    const body = h.create.mock.calls[0][0] as { name: string; display_name: string }
    expect(body.name).toBe('Expenses:Food')
    expect(body.display_name).toBe('餐饮')
    wrapper.unmount()
  })

  it('有上级填 Drinks：落库 name = 父全名:Drinks', async () => {
    const wrapper = mount(AccountForm, { props: { mode: 'create', parent: PARENT } })
    await flushPromises()
    await submitAscii(wrapper, '饮品', 'Drinks')

    const body = h.create.mock.calls[0][0] as { name: string }
    expect(body.name).toBe('Expenses:Food:Drinks')
    wrapper.unmount()
  })

  it('非法值只给中文前置提示，不阻断提交（400 由服务端裁决）', async () => {
    const wrapper = mount(AccountForm, { props: { mode: 'create' } })
    await flushPromises()
    await submitAscii(wrapper, '餐饮', 'food')

    expect(wrapper.text()).toContain('大写字母或数字开头')
    expect(h.create).toHaveBeenCalledTimes(1)
    expect((h.create.mock.calls[0][0] as { name: string }).name).toBe('Assets:food')
    wrapper.unmount()
  })

  it('非 owner 不渲染输入框，仍走 ItemN', async () => {
    h.isOwner = false
    const wrapper = mount(AccountForm, { props: { mode: 'create' } })
    await flushPromises()
    expect(wrapper.find('input.af-ascii').exists()).toBe(false)
    await submitWithName(wrapper, '招商储蓄')
    expect((h.create.mock.calls[0][0] as { name: string }).name).toMatch(/^Assets:Item\d+$/)
    wrapper.unmount()
  })
})
