// @vitest-environment jsdom
/**
 * AccountForm create 模式的图标提交契约（批 II）：
 *   - 选中预设 → create body 带 icon 键；
 *   - 不选图标 → create body **不发 icon 键**（缺省语义交给后端落 NULL，
 *     与「冒烟脚本不传 icon/color 不受影响」同口径）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import AccountForm from '@/components/AccountForm.vue'

const h = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  accountApi: { create: h.create, list: h.list, close: vi.fn() },
  openingApi: { get: vi.fn(), set: vi.fn() },
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    ledgerId: 7,
    isViewer: false,
    isOwner: false,
    defaultCommodity: 'CNY',
    ledgers: [{ id: 7, name: '家庭账本', opening_date: '2026-01-01', role: 'owner' }],
  }),
}))

vi.mock('@/stores/privacy', () => ({
  usePrivacyStore: () => ({ enabled: false }),
}))

async function mountCreateForm() {
  const wrapper = mount(AccountForm, { props: { mode: 'create' } })
  await flushPromises()
  return wrapper
}

async function fillAndSubmit(wrapper: ReturnType<typeof mount>): Promise<void> {
  const nameInput = wrapper.findAll('input').find((i) => i.attributes('placeholder') === '如：招商储蓄 / 早餐')
  expect(nameInput).toBeDefined()
  await nameInput?.setValue('测试账户')
  const save = wrapper.findAll('button').find((b) => b.text() === '保存')
  await save?.trigger('click')
  await flushPromises()
}

beforeEach(() => {
  h.create.mockReset()
  h.list.mockReset()
  h.list.mockResolvedValue({ accounts: [] })
  h.create.mockResolvedValue({
    id: 9, uuid: 'new-1', name: 'Assets:Item1', display_name: '测试账户',
    type: 'Assets', open_date: '2026-01-01',
  })
  document.body.innerHTML = ''
})

describe('AccountForm create 图标契约（批 II）', () => {
  it('选中预设 → create body 带 icon 键', async () => {
    const wrapper = await mountCreateForm()
    const cell = wrapper.findAll('.ipick__cell').find((b) => b.text() === '🏦')
    expect(cell).toBeDefined()
    await cell?.trigger('click')
    await fillAndSubmit(wrapper)

    expect(h.create).toHaveBeenCalledTimes(1)
    const body = h.create.mock.calls[0][0] as Record<string, unknown>
    expect(body.icon).toBe('🏦')
    expect(body.parent_uuid).toBe('')
  })

  it('不选图标 → create body 不发 icon 键（缺省不发键）', async () => {
    const wrapper = await mountCreateForm()
    await fillAndSubmit(wrapper)

    expect(h.create).toHaveBeenCalledTimes(1)
    const body = h.create.mock.calls[0][0] as Record<string, unknown>
    expect('icon' in body ? body.icon : undefined).toBeUndefined()
    expect(Object.keys(body)).not.toContain('icon')
  })
})
