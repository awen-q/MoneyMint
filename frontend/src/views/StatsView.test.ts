// @vitest-environment jsdom
/**
 * 统计账单页装配回归（B4 / T48）
 *
 * 钉住五件必须成立的事：
 * 1. **数据只走 `ledgerData.ensure()`**：一次挂载只调一次 `accountApi.list()` /
 *    `transactionApi.list()`，且**请求不带任何分页参数**（带 `limit` 会让聚合只覆盖
 *    当前页 —— 日均、占比、标签分面全错却不报错）；
 * 2. **窗口过滤**：窗口外的交易不进五指标；
 * 3. **币种取 `period.commodity`**：切成 USD 后指标随之切换；
 * 4. **四态**：加载失败 → error（且工具卡仍渲染，空态不能变成死路）；
 * 5. **子页切换**：stat ↔ tag 走 `period.stats.tab`（跨页浏览态，不落本地 ref）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import StatsView from '@/views/StatsView.vue'
import { usePeriodStore } from '@/stores/period'
import { useSessionStore } from '@/stores/session'

const h = vi.hoisted(() => ({
  accountList: vi.fn(),
  txnList: vi.fn(),
  me: vi.fn(),
  ledgerList: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  changePassword: vi.fn(),
  setLedgerIdProvider: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  accountApi: { list: h.accountList },
  transactionApi: { list: h.txnList },
  authApi: {
    me: h.me,
    login: h.login,
    logout: h.logout,
    changePassword: h.changePassword,
  },
  ledgerApi: { list: h.ledgerList },
  setLedgerIdProvider: h.setLedgerIdProvider,
}))

const ACCOUNTS = [
  { id: 1, name: 'Assets:Cash', display_name: '现金', uuid: 'u1', type: 'Assets', open_date: '2026-01-01', sort_order: 1, balances: { CNY: '1000.00' } },
  { id: 10, name: 'Expenses:Food', display_name: '餐饮', uuid: 'u10', type: 'Expenses', open_date: '2026-01-01', sort_order: 2 },
  { id: 20, name: 'Income:Salary', display_name: '工资', uuid: 'u20', type: 'Income', open_date: '2026-01-01', sort_order: 3 },
]

function txn(
  id: number,
  date: string,
  description: string,
  postings: Array<{ account_id: number; commodity: string; amount: string }>,
  tags?: string[],
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id,
    uuid: `t${id}`,
    date,
    flag: '*',
    description,
    created_by_name: '阿文',
    postings: postings.map((posting) => ({ ...posting, account: '' })),
  }
  if (tags !== undefined) {
    base.tags = tags
  }
  return base
}

/** 2026-11 窗口内 2 笔 + 窗口外（10 月）1 笔。 */
const TXNS = [
  txn(1, '2026-11-01', '午餐', [
    { account_id: 10, commodity: 'CNY', amount: '100.00' },
    { account_id: 1, commodity: 'CNY', amount: '-100.00' },
  ], ['家庭']),
  txn(2, '2026-11-02', '工资', [
    { account_id: 1, commodity: 'CNY', amount: '900.00' },
    { account_id: 20, commodity: 'CNY', amount: '-900.00' },
  ], ['工资']),
  // 窗口外：10 月，绝不能被算进 11 月的指标
  txn(3, '2026-10-15', '九月的事', [
    { account_id: 10, commodity: 'CNY', amount: '5000.00' },
    { account_id: 1, commodity: 'CNY', amount: '-5000.00' },
  ]),
]

async function mountView(): Promise<ReturnType<typeof mount>> {
  const wrapper = mount(StatsView, {
    global: {
      stubs: {
        TrendChart: true,
        DonutChart: true,
        BarChart: true,
        MonthPicker: true,
      },
    },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  h.accountList.mockReset()
  h.txnList.mockReset()
  h.accountList.mockResolvedValue({ accounts: ACCOUNTS })
  h.txnList.mockResolvedValue({ transactions: TXNS })
  useSessionStore().ledgerId = 7
  // 固定到 2026-11，避开「当月/未来月」随时间变化的抖动
  usePeriodStore().setStatsMonth(2026, 11)
})

describe('T48 StatsView：数据来源与分页口径', () => {
  it('只调一次 ensure，且请求不带任何分页参数（首屏绝不传 limit）', async () => {
    await mountView()
    expect(h.accountList).toHaveBeenCalledTimes(1)
    expect(h.txnList).toHaveBeenCalledTimes(1)
    // 调用参数必须是「无参」——一旦有人塞 { limit } / { query }，聚合就只覆盖当前页
    expect(h.txnList.mock.calls[0]).toEqual([])
    expect(h.accountList.mock.calls[0]).toEqual([])
  })

  it('窗口过滤：10 月的交易不进 11 月指标', async () => {
    const wrapper = await mountView()
    const text = wrapper.text()
    // 11 月支出 100、收入 900 → 结余 800；若 5000 混进来会出现 5,100 之类
    expect(text).toContain('900.00')
    expect(text).toContain('100.00')
    expect(text).not.toContain('5,000.00')
  })

  it('币种取 period.commodity：USD 口径下指标为 0（该币种无数据）', async () => {
    usePeriodStore().setCommodity('USD')
    const wrapper = await mountView()
    const metrics = wrapper.find('.stats-metrics')
    expect(metrics.text()).not.toContain('900.00')
  })
})

describe('T48 StatsView：四态与出口', () => {
  it('加载失败 → 错误态，但工具卡（chips / 周期 / 月份）仍在（空态不能变成死路）', async () => {
    h.accountList.mockRejectedValue(new Error('boom'))
    const wrapper = await mountView()
    const text = wrapper.text()
    expect(text).toContain('加载失败')
    // 工具卡与 hero 在 StateCard 之外
    expect(wrapper.find('.stats-tabs').exists()).toBe(true)
    expect(wrapper.find('.period-seg').exists()).toBe(true)
    expect(text).toContain('统计账单')
  })

  it('无记录 → 空态文案与错误态不同', async () => {
    h.txnList.mockResolvedValue({ transactions: [] })
    const wrapper = await mountView()
    const text = wrapper.text()
    expect(text).toContain('当前月份没有记录。')
    expect(text).not.toContain('加载失败')
  })
})

describe('T48 StatsView：子页切换走 period store', () => {
  it('点「标签」→ period.stats.tab 变 tag，并渲染标签面板', async () => {
    const wrapper = await mountView()
    const period = usePeriodStore()
    const tabs = wrapper.findAll('.stats-tabs__btn')
    await tabs[1].trigger('click')
    expect(period.stats.tab).toBe('tag')
    await flushPromises()
    expect(wrapper.text()).toContain('标签统计')
  })

  it('切到「年」周期：每日明细让位给说明文案（逐日口径只在月存在）', async () => {
    const wrapper = await mountView()
    const periodButtons = wrapper.findAll('.period-seg__btn')
    await periodButtons[2].trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('每日明细按自然日列出，切到「月」周期查看。')
  })
})
