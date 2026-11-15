// @vitest-environment jsdom
/**
 * 0.6.0 S4 余额校准前端回归（AC-3.1 / AC-3.6 / AC-3.7）：
 * 预检统一文案、D 之后有交易的二次确认提示、版本历史 v1/v2、提交形态。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import { todayString } from '@/core/record'
import AccountDetailView from '@/views/AccountDetailView.vue'

const h = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  close: vi.fn(),
  create: vi.fn(),
  listTxns: vi.fn(),
  balancePreview: vi.fn(),
  balanceSet: vi.fn(),
  isViewer: false,
}))

vi.mock('@/api/client', () => ({
  accountApi: { list: h.listAccounts, close: h.close, create: h.create },
  openingApi: { get: vi.fn(), set: vi.fn() },
  transactionApi: { list: h.listTxns },
  balanceApi: { preview: h.balancePreview, set: h.balanceSet },
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: '1' }, query: {} }),
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    ledgerId: 7,
    get isViewer() {
      return h.isViewer
    },
    defaultCommodity: 'CNY',
    ledgers: [{ id: 7, name: '家庭账本', opening_date: '2026-01-01', role: 'owner' }],
  }),
}))

vi.mock('@/stores/privacy', () => ({
  usePrivacyStore: () => ({ enabled: false }),
}))

const ACCOUNT = {
  id: 1,
  uuid: 'a-1',
  name: 'Assets:Cash',
  display_name: '招商储蓄',
  type: 'Assets',
  open_date: '2026-01-01',
  balances: { CNY: '0.00' },
}

// 含一笔 D 之后的交易（2099 年恒大于今日），用于二次确认提示。
const TXNS = [
  {
    id: 1, uuid: 't-1', date: '2099-01-01', flag: '*', description: '未来交易',
    created_by_name: '阿文',
    postings: [{ account_id: 1, account: 'Assets:Cash', commodity: 'CNY', amount: '10.00' }],
  },
]

const PREVIEW = {
  account_uuid: 'a-1',
  as_of_date: todayString(),
  cumulative: [{ commodity: 'CNY', amount: '12000.00' }],
  calibration: {
    exists: true,
    date: todayString(),
    version: 2,
    targets: [{ commodity: 'CNY', signed_amount: '12000.00' }],
    transaction_uuid: 'cal-v2',
    history: [
      {
        version: 'v1', transaction_uuid: 'cal-v1', created_at: '2026-11-01 10:00:00',
        created_by_name: '阿文', reversed: true,
        entries: [{ commodity: 'CNY', amount: '100.00' }],
      },
      {
        version: 'v2', transaction_uuid: 'cal-v2', created_at: '2026-11-02 10:00:00',
        created_by_name: '阿文', reversed: false,
        entries: [{ commodity: 'CNY', amount: '350.00' }],
      },
    ],
  },
}

beforeEach(() => {
  h.isViewer = false
  h.listAccounts.mockReset()
  h.close.mockReset()
  h.create.mockReset()
  h.listTxns.mockReset()
  h.balancePreview.mockReset()
  h.balanceSet.mockReset()
  h.listAccounts.mockResolvedValue({ accounts: [ACCOUNT] })
  h.listTxns.mockResolvedValue({ transactions: TXNS })
  h.balancePreview.mockResolvedValue(PREVIEW)
  h.balanceSet.mockResolvedValue({
    status: 'updated', account_uuid: 'a-1', transaction_uuid: 'cal-v3',
    reversal_uuid: 'rev-v2', version: 3, date: '2026-11-14',
    entries: [{ commodity: 'CNY', diff: '350.00' }],
  })
})

async function openPanel(wrapper: ReturnType<typeof mount>): Promise<void> {
  const button = wrapper.findAll('button').find((b) => b.text() === '余额校准')
  expect(button).toBeDefined()
  await button?.trigger('click')
  await flushPromises()
}

async function fillTarget(wrapper: ReturnType<typeof mount>, value: string): Promise<void> {
  const input = wrapper.findAll('input').find((i) => (i.element as HTMLInputElement).placeholder.includes('12350'))
  expect(input).toBeDefined()
  await input?.setValue(value)
  await flushPromises()
}

describe('S4 余额校准：预检文案 / 二次确认 / 版本历史', () => {
  it('预检文案统一「截至 D 日初（前一日日终）」，并按定点金额显示 +差额', async () => {
    const wrapper = mount(AccountDetailView, { attachTo: document.body })
    await flushPromises()
    await openPanel(wrapper)
    expect(h.balancePreview).toHaveBeenCalledTimes(1)
    await fillTarget(wrapper, '12350.00')

    const text = wrapper.text()
    expect(text).toContain(`截至 ${todayString()} 日初（前一日日终）`)
    expect(text).toContain('当前累计 12,000.00')
    expect(text).toContain('目标 12,350.00')
    expect(text).toContain('将自动补记 +350.00')
    wrapper.unmount()
  })

  it('D 之后已有交易时二次确认明确提示会改变后续余额', async () => {
    const wrapper = mount(AccountDetailView, { attachTo: document.body })
    await flushPromises()
    await openPanel(wrapper)
    await fillTarget(wrapper, '12350.00')
    const submit = wrapper.findAll('button').find((b) => b.text() === '生成校准交易')
    expect(submit).toBeDefined()
    await submit?.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('此操作会改变 D 之后的所有余额')
    wrapper.unmount()
  })

  it('版本历史展示 v1/v2、操作人、失效状态与差额原因', async () => {
    const wrapper = mount(AccountDetailView, { attachTo: document.body })
    await flushPromises()
    await openPanel(wrapper)

    const text = wrapper.text()
    expect(text).toContain('校准版本历史')
    expect(text).toContain('v1')
    expect(text).toContain('已失效（被新版本冲正）')
    expect(text).toContain('v2')
    expect(text).toContain('当前生效')
    expect(text).toContain('阿文')
    expect(text).toContain('350.00')
    wrapper.unmount()
  })

  it('确认后以 targets 数组提交，成功后刷新账户与预检', async () => {
    const wrapper = mount(AccountDetailView, { attachTo: document.body })
    await flushPromises()
    await openPanel(wrapper)
    await fillTarget(wrapper, '12350.00')
    const submit = wrapper.findAll('button').find((b) => b.text() === '生成校准交易')
    await submit?.trigger('click')
    await flushPromises()
    const confirm = wrapper.findAll('button').find((b) => b.text() === '确认生成')
    expect(confirm).toBeDefined()
    await confirm?.trigger('click')
    await flushPromises()

    expect(h.balanceSet).toHaveBeenCalledTimes(1)
    const [uuid, body] = h.balanceSet.mock.calls[0] as [
      string,
      { as_of_date: string; targets: Array<{ commodity: string; target_balance: string }> },
    ]
    expect(uuid).toBe('a-1')
    expect(body.as_of_date).toBe(todayString())
    expect(body.targets).toEqual([{ commodity: 'CNY', target_balance: '12350.00' }])
    expect(wrapper.text()).toContain('已生成 v3 校准')
    wrapper.unmount()
  })

  it('viewer 不显示可用校准入口', async () => {
    h.isViewer = true
    const wrapper = mount(AccountDetailView, { attachTo: document.body })
    await flushPromises()
    const button = wrapper.findAll('button').find((b) => b.text() === '余额校准')
    expect(button?.attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })
})
