// @vitest-environment jsdom
/**
 * 0.6.0 S2 / C-03：账户表单只收中文显示名，自动生成 ASCII 合法全名；
 * 「＋ 增加下级」入口预填父项、类型继承、parent_uuid 必传（根为显式空串）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import type { AccountView } from '@/api/types'
import { ApiError } from '@/api/errors'
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

describe('父下拉可辨识化（显示名（全名）+ 树缩进 + 「无」明示结果形态）', () => {
  const BANK: AccountView = {
    id: 5,
    uuid: 'p-1',
    name: 'Assets:Bank',
    display_name: '银行卡',
    type: 'Assets',
    open_date: '2026-01-01',
    sort_order: 0,
  }
  const CMB: AccountView = {
    id: 6,
    uuid: 'c-1',
    name: 'Assets:Bank:CMB',
    display_name: '招行卡',
    type: 'Assets',
    open_date: '2026-01-01',
    sort_order: 1,
    parent_uuid: 'p-1',
  }

  /**
   * 父下拉是第 2 个 select（第 1 个是类型）。用原始 textContent 而非
   * text()：后者会 trim()，把全角空格 U+3000 缩进前缀裁掉。
   */
  function parentOptionsOf(wrapper: ReturnType<typeof mount>): string[] {
    return wrapper
      .findAll('select')[1]
      .findAll('option')
      .map((option) => (option.element as HTMLOptionElement).textContent ?? '')
  }

  it('选项文案 = 显示名（全名），不再是裸 Beancount 全名（AC-3）', async () => {
    h.list.mockResolvedValue({ accounts: [BANK] })
    const wrapper = mount(AccountForm, { props: { mode: 'create' } })
    await flushPromises()
    const options = parentOptionsOf(wrapper)
    expect(options).toContain('银行卡（Assets:Bank）')
    expect(options.join('\n')).not.toMatch(/^Assets:Bank$/m)
    wrapper.unmount()
  })

  it('嵌套层级：子选项带全角空格缩进，DOM 顺序父先子后（AC-3）', async () => {
    h.list.mockResolvedValue({ accounts: [BANK, CMB] })
    const wrapper = mount(AccountForm, { props: { mode: 'create' } })
    await flushPromises()
    const options = parentOptionsOf(wrapper)
    const bankIndex = options.indexOf('银行卡（Assets:Bank）')
    const cmbIndex = options.indexOf('\u3000招行卡（Assets:Bank:CMB）')
    expect(bankIndex).toBeGreaterThan(-1)
    expect(cmbIndex).toBeGreaterThan(bankIndex)
    wrapper.unmount()
  })

  it('「无」选项明示生成形态，且随类型切换联动（AC-5 语义不漂移）', async () => {
    h.list.mockResolvedValue({ accounts: [BANK] })
    const wrapper = mount(AccountForm, { props: { mode: 'create' } })
    await flushPromises()
    expect(parentOptionsOf(wrapper)).toContain(
      '无 · 直接挂在类型根下（生成 Assets:新段 两段全名）',
    )
    await wrapper.findAll('select')[0].setValue('Expenses')
    expect(parentOptionsOf(wrapper)).toContain(
      '无 · 直接挂在类型根下（生成 Expenses:新段 两段全名）',
    )
    wrapper.unmount()
  })

  it('预填父项：option 文案为「显示名（全名）」且 select disabled（AC-4 / AC-5 回归）', async () => {
    const wrapper = mount(AccountForm, { props: { mode: 'create', parent: PARENT } })
    await flushPromises()
    const select = wrapper.findAll('select')[1]
    expect((select.element as HTMLSelectElement).disabled).toBe(true)
    expect(select.findAll('option')[0].text()).toBe('餐饮（Expenses:Food）')
    wrapper.unmount()
  })

  it('已关户账户不出现在父下拉（AC-6 前半）', async () => {
    h.list.mockResolvedValue({
      accounts: [BANK, { ...BANK, id: 7, uuid: 'old-1', name: 'Assets:Old', display_name: '旧卡', close_date: '2026-10-01' }],
    })
    const wrapper = mount(AccountForm, { props: { mode: 'create' } })
    await flushPromises()
    const options = parentOptionsOf(wrapper)
    expect(options).toContain('银行卡（Assets:Bank）')
    expect(options.join('\n')).not.toContain('旧卡')
    wrapper.unmount()
  })
})

describe('避重集合含已关户（FR-3 / AC-7）', () => {
  it('预置已关户 Assets:Item1 后自动命名跳过 Item1，不再 409 account_name_exists', async () => {
    h.list.mockResolvedValue({
      accounts: [
        {
          id: 8,
          uuid: 'closed-1',
          name: 'Assets:Item1',
          type: 'Assets',
          open_date: '2026-01-01',
          close_date: '2026-10-01',
          sort_order: 0,
        },
      ],
    })
    const wrapper = mount(AccountForm, { props: { mode: 'create' } })
    await flushPromises()
    await submitWithName(wrapper, '招商储蓄')

    // 避重集合来自 list({ includeClosed: true })——后端重名判定含关户行。
    expect(h.list).toHaveBeenCalledWith({ includeClosed: true })
    const body = h.create.mock.calls[0][0] as { name: string }
    expect(body.name).toBe('Assets:Item2')
    wrapper.unmount()
  })
})

describe('提交失败不丢输入（AC-8）', () => {
  it('提交被拒（409 account_name_exists）：弹层不关、close/saved 不 emit、显示名与 parent_uuid 保留、错误文案渲染', async () => {
    h.create.mockRejectedValue(
      new ApiError(409, '账户名已存在，请换一个显示名', { code: 'account_name_exists' }),
    )
    // 预填父项态：同时覆盖「类型/父不可改回显」与 payload.parent_uuid 保留。
    const wrapper = mount(AccountForm, { props: { mode: 'create', parent: PARENT } })
    await flushPromises()

    await submitWithName(wrapper, '早餐')
    await flushPromises()

    // 弹层仍开着：close / saved 均未 emit（外层 v-if 不会卸载表单）。
    expect(wrapper.find('.af-panel').exists()).toBe(true)
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(wrapper.emitted('saved')).toBeUndefined()

    // 输入保留：显示名原样回显；payload 里 parent_uuid / type 未被重置。
    const input = wrapper
      .findAll('input')
      .find((i) => (i.element as HTMLInputElement).type === 'text')
    expect((input?.element as HTMLInputElement).value).toBe('早餐')
    const body = h.create.mock.calls[0][0] as { parent_uuid: string; type: string }
    expect(body.parent_uuid).toBe('p-1')
    expect(body.type).toBe('Expenses')
    const typeSelect = wrapper.findAll('select')[0]
    expect((typeSelect.element as HTMLSelectElement).value).toBe('Expenses')

    // 错误文案渲染（ApiError.message 原样透出，非静默吞掉）。
    expect(wrapper.text()).toContain('账户名已存在，请换一个显示名')
    wrapper.unmount()
  })
})
