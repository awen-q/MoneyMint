// @vitest-environment jsdom
/**
 * 批 3 组件回归：§14.5 #5 默认账户预选
 *
 * 守住：记一笔打开时按账本命名空间的默认账户预选分类；
 * 记忆的 uuid 已失效（账户被删除 / 关户）时回退首个可用分类并提示。
 * 本文件用真实 localStorage（只 mock API 与 stores），验证端到端读写链路。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import RecordSheet from './RecordSheet.vue'
import { readDefaultAccounts, writeDefaultAccounts } from '@/core/storage'

const h = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  editingTxn: null as unknown,
}))

vi.mock('@/api/client', () => ({
  accountApi: { list: h.list },
  transactionApi: { create: h.create, update: h.update },
  newIdempotencyKey: () => 'QA-KEY',
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    ledgerId: 7,
    isViewer: false,
    needsInvite: false,
    defaultCommodity: 'CNY',
    ledgers: [{ id: 7, name: '家庭账本', opening_date: '2026-01-01' }],
    ledgerName: '家庭账本',
  }),
}))

vi.mock('@/stores/recordSheet', () => ({
  useRecordSheetStore: () => ({
    editingTxn: h.editingTxn,
    notifySaved: vi.fn(),
    notifyChanged: vi.fn(),
  }),
}))

vi.mock('@/stores/privacy', () => ({
  usePrivacyStore: () => ({ enabled: false }),
}))

// 分类顺序固定：食品（id=2）、交通（id=3）。
const ACCOUNTS = [
  { id: 1, uuid: 'u-cash', name: 'Assets:Cash', display_name: '现金', type: 'Assets' },
  { id: 2, uuid: 'u-food', name: 'Expenses:Food', display_name: '食品', type: 'Expenses' },
  { id: 3, uuid: 'u-travel', name: 'Expenses:Travel', display_name: '交通', type: 'Expenses' },
  { id: 4, uuid: 'u-salary', name: 'Income:Salary', display_name: '薪资', type: 'Income' },
  // 第二张资金账户：验证 fund 记忆选的是 uuid 而非 fundAccounts[0]。
  { id: 5, uuid: 'u-card', name: 'Assets:Card', display_name: '招行卡', type: 'Assets' },
]

function selectedIndex(wrapper: ReturnType<typeof mount>): number {
  const cats = wrapper.findAll('.rs-cat')
  for (let i = 0; i < cats.length; i += 1) {
    if (cats[i].classes().indexOf('on') >= 0) {
      return i
    }
  }
  return -1
}

beforeEach(() => {
  localStorage.clear()
  h.list.mockReset()
  h.create.mockReset()
  h.update.mockReset()
  h.editingTxn = null
  h.list.mockResolvedValue({ accounts: ACCOUNTS })
  h.create.mockResolvedValue({
    id: 9, uuid: 't-9', date: '2026-11-21', flag: '*', description: '测试', postings: 2,
  })
  h.update.mockResolvedValue({
    uuid: 't-new', new_uuid: 't-new', id: 10, date: '2026-11-21', postings: 2,
  })
})

describe('批3-K：默认账户预选（§14.5 #5）', () => {
  it('按 uuid 预选分类，而不是永远取第一个', async () => {
    writeDefaultAccounts(7, { expense: 'u-travel' })
    const wrapper = mount(RecordSheet)
    await flushPromises()
    expect(selectedIndex(wrapper)).toBe(1)
    wrapper.unmount()
  })

  it('记忆的账户已删除时回退首个可用分类并给出提示', async () => {
    writeDefaultAccounts(7, { expense: 'u-deleted' })
    const wrapper = mount(RecordSheet)
    await flushPromises()
    expect(selectedIndex(wrapper)).toBe(0)
    expect(wrapper.text()).toContain('默认账户已失效，已回退为首个可用账户')
    wrapper.unmount()
  })

  it('已关户账户不可作为默认账户', async () => {
    writeDefaultAccounts(7, { expense: 'u-travel' })
    const closed = ACCOUNTS.map((account) =>
      account.id === 3 ? { ...account, close_date: '2026-11-01' } : account,
    )
    h.list.mockResolvedValue({ accounts: closed })
    const wrapper = mount(RecordSheet)
    await flushPromises()
    expect(selectedIndex(wrapper)).toBe(0)
    wrapper.unmount()
  })

  it('没有记忆时保持原有「首个可用分类」行为', async () => {
    const wrapper = mount(RecordSheet)
    await flushPromises()
    expect(selectedIndex(wrapper)).toBe(0)
    expect(wrapper.text()).not.toContain('默认账户已失效')
    wrapper.unmount()
  })
})

describe('P0：资金账户记忆（fund 位，支出/收入共用）', () => {
  function selectedFund(wrapper: ReturnType<typeof mount>): string {
    const select = wrapper.find('select[data-field="fund"]')
    return (select.element as HTMLSelectElement).value
  }

  it('命中记忆的 u-card，而不是 fundAccounts[0]', async () => {
    writeDefaultAccounts(7, { fund: 'u-card' })
    const wrapper = mount(RecordSheet)
    await flushPromises()
    expect(selectedFund(wrapper)).toBe('5')
    wrapper.unmount()
  })

  it('记忆账户已关户 / 删除时回退首个可用资金账户并提示', async () => {
    writeDefaultAccounts(7, { fund: 'u-gone' })
    const wrapper = mount(RecordSheet)
    await flushPromises()
    expect(selectedFund(wrapper)).toBe('1')
    expect(wrapper.text()).toContain('默认账户已失效，已回退为首个可用账户')
    wrapper.unmount()
  })

  it('保存成功后写入 fund 记忆', async () => {
    const wrapper = mount(RecordSheet)
    await flushPromises()
    await wrapper.find('[data-act="amount"]').trigger('click')
    for (const key of ['1', '0', '0']) {
      const button = wrapper.findAll('.rs-key').find((b) => b.text() === key)
      await button?.trigger('click')
    }
    await wrapper.find('select[data-field="fund"]').setValue('5')
    const save = wrapper.findAll('.rs-key').find((b) => b.text() === '保存')
    await save?.trigger('click')
    await flushPromises()
    expect(h.create).toHaveBeenCalledTimes(1)
    expect(readDefaultAccounts(7).fund).toBe('u-card')
    wrapper.unmount()
  })

  it('编辑态保存不污染 fund 记忆', async () => {
    writeDefaultAccounts(7, { fund: 'u-cash' })
    h.editingTxn = {
      uuid: 't-1', date: '2026-11-20', flag: '*', description: '原交易', tags: [],
      postings: [
        { account_id: 1, commodity: 'CNY', amount: '-10.00' },
        { account_id: 2, commodity: 'CNY', amount: '10.00' },
      ],
    }
    const wrapper = mount(RecordSheet)
    await flushPromises()
    expect(wrapper.text()).toContain('修改交易')
    await wrapper.find('.js-save').trigger('click')
    await flushPromises()
    expect(h.update).toHaveBeenCalledTimes(1)
    expect(h.create).not.toHaveBeenCalled()
    expect(readDefaultAccounts(7).fund).toBe('u-cash')
    wrapper.unmount()
  })

  it('转账保存也写 fund（不按 kind 拆分记忆）', async () => {
    const wrapper = mount(RecordSheet)
    await flushPromises()
    // fund 下拉只在支出/收入态渲染（转账态换成转出/转入两行）。
    // 先在支出态选中 u-card；switchKind 不碰 fundAccountId，
    // 切到转账后保存仍应无条件写 fund 记忆。
    await wrapper.find('select[data-field="fund"]').setValue('5')
    const tab = wrapper.findAll('[data-act="tab"]').find((b) => b.text() === '转账')
    await tab?.trigger('click')
    await wrapper.find('[data-act="amount"]').trigger('click')
    for (const key of ['1', '0', '0']) {
      const button = wrapper.findAll('.rs-key').find((b) => b.text() === key)
      await button?.trigger('click')
    }
    const save = wrapper.findAll('.rs-key').find((b) => b.text() === '保存')
    await save?.trigger('click')
    await flushPromises()
    expect(h.create).toHaveBeenCalledTimes(1)
    expect(readDefaultAccounts(7).fund).toBe('u-card')
    wrapper.unmount()
  })
})
