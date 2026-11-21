// @vitest-environment jsdom
/**
 * 账单页回归（B2）
 *
 * 覆盖四类契约：
 * 1. **装载**：`onMounted` 必须调 `ensure()`（`!loaded → loading` 的判据让「漏调」表现为
 *    永久骨架屏，只能靠这条测试守）；切账本后回到首屏加载态并清掉日筛选。
 * 2. **四态**（v3.2）：`!loaded → loading`、`error && !loaded → error`、
 *    `txns 为空 → empty`、否则 `ready`；**有旧快照 + 刷新失败仍是 ready**，只出内联条。
 * 3. **日历**：42 格、四态渲染、双有日有收入圆点、点日过滤 + chip、再点取消。
 * 4. **数据一致性**：指标数字直接等于 `monthTotals` 返回值；折线的 `amount` 与
 *    `daySeries` 逐项相同（防「用 value*100 反算金额」回归）；隐私开启后不出现真值。
 *
 * store 用真实例（不 mock 模块），只 mock `@/api/client` 与 `vue-router`：
 * 页面与 store 的接线本身就是要验证的对象，mock 掉 store 等于把接线留在测试之外。
 */
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { daySeries, monthTotals } from '@/core/bill'
import { formatMoney } from '@/core/Money'
import { PRIVACY_MASK } from '@/core/privacy'
import type { AccountView, TransactionView } from '@/api/types'
import { useLedgerDataStore } from '@/stores/ledgerData'
import { usePeriodStore } from '@/stores/period'
import { usePrivacyStore } from '@/stores/privacy'
import { useSessionStore } from '@/stores/session'

import BillsView from './BillsView.vue'

const h = vi.hoisted(() => ({
  accountList: vi.fn(),
  txnList: vi.fn(),
  me: vi.fn(),
  ledgerList: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  changePassword: vi.fn(),
  setLedgerIdProvider: vi.fn(),
  push: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  accountApi: { list: h.accountList },
  transactionApi: { list: h.txnList },
  authApi: { me: h.me, login: h.login, logout: h.logout, changePassword: h.changePassword },
  ledgerApi: { list: h.ledgerList },
  setLedgerIdProvider: h.setLedgerIdProvider,
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: h.push }),
}))

/** 折线图桩：把收到的 `series` / `labels` 序列化到属性上，供断言读取（不建 ECharts 实例）。 */
const TrendStub = {
  name: 'TrendChart',
  props: ['title', 'chartLabel', 'labels', 'series', 'commodity', 'masked', 'state'],
  template:
    '<div class="trend-stub" :data-series="JSON.stringify(series)" :data-labels="JSON.stringify(labels)" :data-masked="String(masked)" />',
}

function makeAccount(id: number, name: string, type: AccountView['type']): AccountView {
  return { id, name, uuid: `uuid-${id}`, type, open_date: '2026-01-01', sort_order: id }
}

const ACCOUNTS: AccountView[] = [
  makeAccount(1, 'Assets:Bank', 'Assets'),
  makeAccount(2, 'Expenses:Food', 'Expenses'),
  makeAccount(3, 'Income:Salary', 'Income'),
]

/** 一笔 11-03 双有（支出 + 收入）、11-10 纯支出、11-16 纯收入。 */
const TXNS: TransactionView[] = [
  {
    id: 101,
    uuid: 't-101',
    date: '2026-11-03',
    flag: '*',
    description: '工资与午饭',
    created_by_name: '林小满',
    postings: [
      { account_id: 1, account: 'Assets:Bank', commodity: 'CNY', amount: '17533.00' },
      { account_id: 2, account: 'Expenses:Food', commodity: 'CNY', amount: '967.00' },
      { account_id: 3, account: 'Income:Salary', commodity: 'CNY', amount: '-18500.00' },
    ],
  },
  {
    id: 102,
    uuid: 't-102',
    date: '2026-11-10',
    flag: '*',
    description: '超市采购',
    created_by_name: '林小满',
    postings: [
      { account_id: 2, account: 'Expenses:Food', commodity: 'CNY', amount: '100.00' },
      { account_id: 1, account: 'Assets:Bank', commodity: 'CNY', amount: '-100.00' },
    ],
  },
  {
    id: 103,
    uuid: 't-103',
    date: '2026-11-16',
    flag: '*',
    description: '兼职收入',
    created_by_name: '陈志远',
    postings: [
      { account_id: 1, account: 'Assets:Bank', commodity: 'CNY', amount: '500.00' },
      { account_id: 3, account: 'Income:Salary', commodity: 'CNY', amount: '-500.00' },
    ],
  },
]

let pinia: ReturnType<typeof createPinia>
let data: ReturnType<typeof useLedgerDataStore>
let period: ReturnType<typeof usePeriodStore>
let session: ReturnType<typeof useSessionStore>

/** 让 Promise 链、store 内部的 setTimeout 收尾与 pre-flush watch 都跑完。 */
async function settle(): Promise<void> {
  await flushPromises()
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
  await flushPromises()
}

/** 挂载并把 store 状态压到「已加载 + 指定交易」，避免每个用例都走一遍异步装载。 */
function mountWith(txns: TransactionView[]): ReturnType<typeof mount> {
  data.txns = txns
  data.accounts = ACCOUNTS
  data.loaded = true
  data.loading = false
  data.error = ''
  vi.spyOn(data, 'ensure').mockResolvedValue(undefined)
  return mount(BillsView, {
    global: { plugins: [pinia], stubs: { TrendChart: TrendStub } },
  })
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  localStorage.clear()
  for (const spy of Object.values(h)) {
    spy.mockReset()
  }
  h.accountList.mockResolvedValue({ accounts: ACCOUNTS })
  h.txnList.mockResolvedValue({ transactions: TXNS })
  h.ledgerList.mockResolvedValue({ ledgers: [] })
  h.me.mockResolvedValue({ user: null })
  // 先把 ledgerId 定下来再建 data store：`ledgerData` 会在 setup 里 watch ledgerId，
  // 若先建 store 再改 id，会凭空多触发一次 reset + ensure，干扰调用次数断言。
  session = useSessionStore()
  session.ledgerId = 7
  data = useLedgerDataStore()
  period = usePeriodStore()
  period.setBillsMonth(2026, 11)
})

describe('BillsView：装载', () => {
  it('挂载时调用了 ensure()（不锁次数：切账本会再调）', async () => {
    const ensureSpy = vi.spyOn(data, 'ensure').mockResolvedValue(undefined)
    mount(BillsView, { global: { plugins: [pinia], stubs: { TrendChart: TrendStub } } })
    await flushPromises()
    expect(ensureSpy).toHaveBeenCalled()
  })

  it('首屏走真实 ensure() 时能装载出数据', async () => {
    mount(BillsView, { global: { plugins: [pinia], stubs: { TrendChart: TrendStub } } })
    await settle()
    expect(data.loaded).toBe(true)
    expect(data.txns).toHaveLength(3)
  })

  it('切账本后重新拉取（账本接口被再次调用）并清掉已选日期', async () => {
    const wrapper = mountWith(TXNS)
    await wrapper.findAll('button.cal__cell')[2].trigger('click')
    expect(wrapper.findAll('.bills__row')).toHaveLength(1)

    const callsBefore = h.txnList.mock.calls.length
    session.ledgers = [
      { id: 7, name: '家庭账本', role: 'owner', opening_date: '2026-01-01' },
      { id: 8, name: '旅行账本', role: 'editor', opening_date: '2026-01-01' },
    ]
    session.ledgerId = 8
    await settle()

    // store 内部 watch 做了 reset() + ensure()：账本接口必须被再次调用
    expect(h.txnList.mock.calls.length).toBe(callsBefore + 1)
    // 页面侧的日筛选必须清掉（否则新账本会带着旧账本的「已选 11-03」）
    expect(wrapper.find('.bills__filter-chip').exists()).toBe(false)
  })
})

describe('BillsView：四态（v3.2）', () => {
  it('!loaded → loading', () => {
    vi.spyOn(data, 'ensure').mockResolvedValue(undefined)
    data.loaded = false
    data.loading = true
    const wrapper = mount(BillsView, {
      global: { plugins: [pinia], stubs: { TrendChart: TrendStub } },
    })
    expect(wrapper.text()).toContain('正在加载')
    expect(wrapper.find('.metrics').exists()).toBe(false)
  })

  it('error 且从未成功加载过 → 整页 error', () => {
    vi.spyOn(data, 'ensure').mockResolvedValue(undefined)
    data.loaded = false
    data.error = '账本数据加载失败，请重试'
    const wrapper = mount(BillsView, {
      global: { plugins: [pinia], stubs: { TrendChart: TrendStub } },
    })
    expect(wrapper.text()).toContain('加载失败')
  })

  it('该月无交易 → empty', () => {
    const wrapper = mountWith([])
    expect(wrapper.text()).toContain('暂无数据')
    expect(wrapper.find('.metrics').exists()).toBe(false)
  })

  it('有数据 → ready，渲染日历与指标', () => {
    const wrapper = mountWith(TXNS)
    expect(wrapper.findAll('.cal__cell')).toHaveLength(42)
    expect(wrapper.findAll('.metrics__card')).toHaveLength(4)
  })

  it('有旧快照 + 刷新失败 → 仍是 ready，只出内联提示条', () => {
    const wrapper = mountWith(TXNS)
    data.error = '服务暂时不可用'
    return wrapper.vm.$nextTick().then(() => {
      expect(wrapper.findAll('.metrics__card')).toHaveLength(4)
      expect(wrapper.text()).not.toContain('加载失败')
      const banner = wrapper.find('.bills__stale')
      expect(banner.exists()).toBe(true)
      expect(banner.text()).toContain('刷新失败，当前显示的是上次数据')
    })
  })

  it('内联条的重试按钮调 reload 而不是 ensure', async () => {
    const wrapper = mountWith(TXNS)
    // mountWith 里 ensure 已被桩掉并在挂载时调用过一次；记下次数，只验证「点击没有再调」
    const ensureSpy = vi.mocked(data.ensure)
    const ensureCallsBefore = ensureSpy.mock.calls.length
    const reloadSpy = vi.spyOn(data, 'reload').mockResolvedValue(undefined)
    data.error = '服务暂时不可用'
    await wrapper.vm.$nextTick()

    await wrapper.find('.bills__stale-btn').trigger('click')
    expect(reloadSpy).toHaveBeenCalled()
    // ensure() 在 loaded===true 时会短路，点它等于没反应
    expect(ensureSpy.mock.calls.length).toBe(ensureCallsBefore)
  })
})

describe('BillsView：日历', () => {
  it('42 格，无交易的当月日只显示日号', () => {
    const wrapper = mountWith(TXNS)
    const inMonth = wrapper.findAll('button.cal__cell')
    // 11 月 30 天
    expect(inMonth).toHaveLength(30)
    // 11-05 无交易 → 无金额、无圆点
    expect(inMonth[4].find('.cal__amount').exists()).toBe(false)
    expect(inMonth[4].find('.cal__dot').exists()).toBe(false)
  })

  it('双有日给出支出侧文字 + 收入圆点', () => {
    const wrapper = mountWith(TXNS)
    const day3 = wrapper.findAll('button.cal__cell')[2]
    expect(day3.classes()).toContain('cal__cell--both')
    expect(day3.find('.cal__dot').exists()).toBe(true)
    expect(day3.find('.cal__amount').text()).toBe('-967')
    expect(day3.attributes('aria-label')).toContain('收入')
    const amounts = day3.findAll('.cal__amount')
    expect(amounts).toHaveLength(2)
    expect(amounts[1].text()).toBe('+1.9w')
    expect(amounts[1].classes()).toContain('cal__amount--income')
  })

  it('纯收入日显示 + 号，纯支出日显示 - 号', () => {
    const wrapper = mountWith(TXNS)
    const cells = wrapper.findAll('button.cal__cell')
    expect(cells[9].find('.cal__amount').text()).toBe('-100')
    expect(cells[9].classes()).toContain('cal__cell--expense-only')
    expect(cells[15].find('.cal__amount').text()).toBe('+500')
    expect(cells[15].classes()).toContain('cal__cell--income-only')
  })

  it('点某日 → 列表只剩该日并出现日筛选行；再点同日 → 恢复整月', async () => {
    const wrapper = mountWith(TXNS)
    expect(wrapper.findAll('.bills__row')).toHaveLength(3)

    await wrapper.findAll('button.cal__cell')[2].trigger('click')
    expect(wrapper.findAll('.bills__row')).toHaveLength(1)
    // 稿 app.js:634「已选 11-03 · 1 笔」：笔数必须跟着变
    const chip = wrapper.find('.bills__dayfilter-chip')
    expect(chip.text()).toContain('已选 11-03')
    expect(chip.text()).toContain('1 笔')

    await wrapper.findAll('button.cal__cell')[2].trigger('click')
    expect(wrapper.findAll('.bills__row')).toHaveLength(3)
    expect(wrapper.find('.bills__dayfilter-chip').exists()).toBe(false)
  })

  it('点「查看整月 ✕」也能取消日期筛选', async () => {
    const wrapper = mountWith(TXNS)
    await wrapper.findAll('button.cal__cell')[2].trigger('click')
    expect(wrapper.findAll('.bills__row')).toHaveLength(1)
    await wrapper.find('.bills__dayfilter-clear').trigger('click')
    expect(wrapper.findAll('.bills__row')).toHaveLength(3)
    expect(wrapper.find('.bills__dayfilter').exists()).toBe(false)
  })
})

describe('BillsView：数据一致性', () => {
  it('指标 4 项与 monthTotals 返回值逐字一致', () => {
    const wrapper = mountWith(TXNS)
    const totals = monthTotals(TXNS, 'CNY')
    const cards = wrapper.findAll('.metrics__card')
    expect(cards[0].text()).toContain(formatMoney(totals.income, 'CNY'))
    expect(cards[1].text()).toContain(formatMoney(totals.expense, 'CNY'))
    expect(cards[2].text()).toContain(formatMoney(totals.balance, 'CNY'))
    expect(cards[3].text()).toContain(`${totals.count} 笔`)
  })

  it('折线 series 的 amount 与 daySeries 逐项相同（防 value*100 反算）', () => {
    const wrapper = mountWith(TXNS)
    const series = JSON.parse(wrapper.find('.trend-stub').attributes('data-series') ?? '[]') as Array<{
      name: string
      points: Array<{ value: number; amount: string }>
    }>
    const points = daySeries(TXNS, 2026, 11, 'CNY')
    expect(series).toHaveLength(2)
    expect(series[1].name).toBe('支出')
    expect(series[1].points.map((point) => point.amount)).toEqual(
      points.map((point) => point.expense),
    )
    expect(series[0].points.map((point) => point.amount)).toEqual(
      points.map((point) => point.income),
    )
    // amount 是权威串，value 只是绘图用的数
    expect(series[1].points[2].value).toBe(967)
  })

  it('折线 labels 是 1..当月天数', () => {
    const wrapper = mountWith(TXNS)
    const labels = JSON.parse(wrapper.find('.trend-stub').attributes('data-labels') ?? '[]') as string[]
    expect(labels).toHaveLength(30)
    expect(labels[0]).toBe('1')
    expect(labels[29]).toBe('30')
  })

  it('隐私开启：日历格与所有金额位都不出现真值', async () => {
    const wrapper = mountWith(TXNS)
    usePrivacyStore(pinia).setEnabled(true)
    await wrapper.vm.$nextTick()

    const html = wrapper.text()
    expect(html).toContain(PRIVACY_MASK)
    expect(html).not.toContain('967')
    expect(html).not.toContain('1,067.00')
    expect(html).not.toContain('18,500.00')
    // 日历格的读屏文案也不得含真值
    const day3 = wrapper.findAll('button.cal__cell')[2]
    expect(day3.attributes('aria-label')).toBe('11月3日，金额已隐藏')
    // 双有日：收入第二行与「有收入」圆点都不得泄露
    expect(day3.findAll('.cal__amount')).toHaveLength(1)
    expect(day3.find('.cal__amount--income').exists()).toBe(false)
    expect(day3.find('.cal__dot').exists()).toBe(false)
  })

  it('折线在遮挡态收到 masked=true', async () => {
    const wrapper = mountWith(TXNS)
    expect(wrapper.find('.trend-stub').attributes('data-masked')).toBe('false')
    usePrivacyStore(pinia).setEnabled(true)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.trend-stub').attributes('data-masked')).toBe('true')
  })
})

describe('BillsView：工具卡与列表', () => {
  it('翻月调用 period.setBillsMonth 并跨年进位', async () => {
    const wrapper = mountWith(TXNS)
    await wrapper.find('button[aria-label="上个月"]').trigger('click')
    expect(period.bills.month).toBe(10)
    expect(period.bills.year).toBe(2026)
  })

  it('行点击跳到交易详情并带 id（列表按日倒序，首行是最新的 11-16）', async () => {
    const wrapper = mountWith(TXNS)
    await wrapper.findAll('.txn-row')[0].trigger('click')
    expect(h.push).toHaveBeenCalledWith({
      name: 'transaction-detail',
      query: { id: '103' },
    })
  })

  it('列表按日倒序分组，组头带日小计', () => {
    const wrapper = mountWith(TXNS)
    const heads = wrapper.findAll('.bills__group-date').map((node) => node.text())
    expect(heads).toEqual(['11月16日', '11月10日', '11月3日'])
  })
})
