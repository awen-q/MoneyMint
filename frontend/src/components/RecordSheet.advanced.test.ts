// @vitest-environment jsdom
/**
 * 批 2.5 修 5：RecordSheet 高级双录模式。
 * - 高级模式提交前按 commodity 分组做配平校验，差额明细直出；
 * - 不平衡的提交被拦截（transactionApi.create 不被调用）；
 * - 高级模式的 postings 走与简化模式**完全相同**的提交路径（幂等键 / 草稿语义不变）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import RecordSheet from '@/components/RecordSheet.vue'

const h = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  seq: 0,
}))

vi.mock('@/api/client', () => ({
  accountApi: { list: h.list },
  transactionApi: { create: h.create, remove: vi.fn(), trash: vi.fn(), restore: vi.fn() },
  newIdempotencyKey: () => {
    h.seq += 1
    return `QA-ADV-${h.seq}`
  },
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    ledgerId: 7,
    isViewer: false,
    defaultCommodity: 'CNY',
    ledgers: [{ id: 7, name: '家用账本', opening_date: '2026-01-01' }],
  }),
}))

vi.mock('@/stores/recordSheet', () => ({
  useRecordSheetStore: () => ({ notifySaved: vi.fn(), savedEpoch: 0, open: vi.fn() }),
}))

vi.mock('@/stores/privacy', () => ({
  usePrivacyStore: () => ({ enabled: false }),
}))

vi.mock('@/core/storage', () => ({
  readDraft: () => null,
  writeDraft: () => undefined,
  clearDraft: () => undefined,
}))

const ACCOUNTS = [
  { id: 1, name: 'Assets:Cash', display_name: '现金', type: 'Assets' },
  { id: 2, name: 'Assets:Bank', display_name: '银行', type: 'Assets', commodity_restriction: 'USD' },
  { id: 3, name: 'Expenses:Food', display_name: '食品', type: 'Expenses' },
]

async function mountAdvanced(): Promise<ReturnType<typeof mount>> {
  const wrapper = mount(RecordSheet)
  await flushPromises()
  const toggle = wrapper.findAll('button').find((b) => b.text().includes('高级模式'))
  await toggle?.trigger('click')
  await flushPromises()
  return wrapper
}

async function fillRow(
  wrapper: ReturnType<typeof mount>,
  index: number,
  accountId: string,
  amount: string,
): Promise<void> {
  const rows = wrapper.findAll('.rs-adv-row')
  const row = rows[index]
  await row.find('select').setValue(accountId)
  await row.find('input').setValue(amount)
}

/**
 * 高级模式（编辑态同）没有数字键盘，唯一保存入口是底部操作区 .rs-foot
 * 的全宽主操作按钮。按新的真实用户路径定位，不再靠全局文本搜「保存」。
 */
function findSave(wrapper: ReturnType<typeof mount>): ReturnType<typeof wrapper.find> {
  const save = wrapper.find('.rs-foot button.fb-btn-primary')
  expect(save.exists()).toBe(true)
  return save as unknown as ReturnType<typeof wrapper.find>
}

beforeEach(() => {
  h.create.mockReset()
  h.list.mockReset()
  h.seq = 0
  h.list.mockResolvedValue({ accounts: ACCOUNTS })
})

describe('批 2.5 修 5：高级双录', () => {
  it('进入高级模式以简化模式分录预填；配平提交走与简化模式相同路径（幂等键）', async () => {
    h.create.mockResolvedValue({ id: 1, uuid: 't-1', date: '2026-11-10', postings: 2 })
    const wrapper = await mountAdvanced()

    // 预填：账户未加载完成前进入会兜底两条空行；这里直接填写两条配平分录。
    await fillRow(wrapper, 0, '3', '38.50')
    await fillRow(wrapper, 1, '1', '-38.50')

    await findSave(wrapper).trigger('click')
    await flushPromises()

    expect(h.create).toHaveBeenCalledTimes(1)
    const [payload, key] = h.create.mock.calls[0]
    expect(key).toBe('QA-ADV-1')
    expect(payload.postings).toEqual([
      { account_id: 3, commodity: 'CNY', amount: '38.50' },
      { account_id: 1, commodity: 'CNY', amount: '-38.50' },
    ])
  })

  it('不平衡（按币种合计非 0）提交被拦截，差额明细直出且不发起请求', async () => {
    const wrapper = await mountAdvanced()
    await fillRow(wrapper, 0, '3', '100.00')
    await fillRow(wrapper, 1, '1', '-30.00')

    const save = findSave(wrapper)
    // 最终稿：不平衡时主操作 disabled（新增守门断言，覆盖不降低）。
    expect((save.element as HTMLButtonElement).disabled).toBe(true)
    // VTU 2.5.1 的 trigger() 对 disabled 按钮不派发事件；用原生 dispatchEvent
    // 强制走到 submit 内部的 buildAdvancedPostings 守门，才能真正验证不发请求。
    save.element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(h.create).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('分录不配平')
    expect(wrapper.text()).toContain('CNY 差额 70.00')
  })

  it('新增分录清空金额后点「贷」→ 页面不崩溃，Bean 预览仍渲染且保存被拦截', async () => {
    const wrapper = await mountAdvanced()
    const add = wrapper.findAll('button').find((b) => b.text().includes('添加分录'))
    await add?.trigger('click')
    await flushPromises()

    // 这就是老板报的崩页链：空幅值 + 贷方向若写成裸 "-"，beanAmount 的
    // Money.from 会抛 RangeError，令 beanText computed 崩溃、整页卡死。
    await wrapper.findAll('.rs-adv-row')[2].find('[data-rf="amt"]').setValue('')
    await flushPromises()
    await wrapper.findAll('.rs-adv-row')[2].find('[data-dir="credit"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('.js-bean').exists()).toBe(true)
    expect(wrapper.find('.js-bean').text()).toContain('<待选账户> 0.00 CNY')
    expect((findSave(wrapper).element as HTMLButtonElement).disabled).toBe(true)
    wrapper.unmount()
  })

  it('金额输入中途的 `12.` 不使 Bean 预览崩溃（非法中间态按 0.00 预览）', async () => {
    const wrapper = await mountAdvanced()
    await fillRow(wrapper, 0, '3', '12.')
    await flushPromises()

    expect(wrapper.find('.js-bean').exists()).toBe(true)
    expect(wrapper.find('.js-bean').text()).toContain('Expenses:Food 0.00 CNY')
    expect((findSave(wrapper).element as HTMLButtonElement).disabled).toBe(true)
    wrapper.unmount()
  })

  it('跨币种各自配平即可通过（USD 账户自动带出 commodity_restriction）', async () => {
    h.create.mockResolvedValue({ id: 2, uuid: 't-2', date: '2026-11-10', postings: 4 })
    const wrapper = await mountAdvanced()
    // 默认只有 2 行：添加两行做两组币种。
    const add = wrapper.findAll('button').find((b) => b.text().includes('添加分录'))
    await add?.trigger('click')
    await add?.trigger('click')
    await flushPromises()

    await fillRow(wrapper, 0, '1', '-100.00')
    await fillRow(wrapper, 1, '3', '100.00')
    await fillRow(wrapper, 2, '2', '-10.00')
    await fillRow(wrapper, 3, '2', '10.00')

    await findSave(wrapper).trigger('click')
    await flushPromises()

    expect(h.create).toHaveBeenCalledTimes(1)
    const [payload] = h.create.mock.calls[0]
    // USD 账户（commodity_restriction）自动带出 USD。
    expect(payload.postings).toEqual([
      { account_id: 1, commodity: 'CNY', amount: '-100.00' },
      { account_id: 3, commodity: 'CNY', amount: '100.00' },
      { account_id: 2, commodity: 'USD', amount: '-10.00' },
      { account_id: 2, commodity: 'USD', amount: '10.00' },
    ])
  })
})
