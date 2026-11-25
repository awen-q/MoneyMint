// @vitest-environment jsdom
/**
 * 账单页回归（B2）
 *
 * 覆盖四类契约：
 * 1. **装载**：`onMounted` 必须调 `ensure()`（`!loaded → loading` 的判据让「漏调」表现为
 *    永久骨架屏，只能靠这条测试守）；切账本后回到首屏加载态并关掉当日抽屉。
 * 2. **四态**（v3.2）：`!loaded → loading`、`error && !loaded → error`、
 *    `txns 为空 → empty`、否则 `ready`；**有旧快照 + 刷新失败仍是 ready**，只出内联条。
 * 3. **日历**：42 格、四态渲染、双有日有收入圆点；点日开底部抽屉看当日交易，
 *    **外部整月列表恒定不变**（旧「就地过滤 + 查看整月 ✕」已按老板决策删除）。
 * 4. **数据一致性**：指标数字直接等于 `monthTotals` 返回值；折线的 `amount` 与
 *    `daySeries` 逐项相同（防「用 value*100 反算金额」回归）；隐私开启后不出现真值。
 * 5. **健康图标**：恒等式结论收进 banner 图标的 tone / aria-label / title，
 *    点击跳设置的数据安全页，状态条 DOM 不再存在。
 *
 * store 用真实例（不 mock 模块），只 mock `@/api/client` 与 `vue-router`：
 * 页面与 store 的接线本身就是要验证的对象，mock 掉 store 等于把接线留在测试之外。
 */
import { createPinia, setActivePinia } from 'pinia'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { daySeries, monthTotals } from '@/core/bill'
import { formatMoney } from '@/core/Money'
import { PRIVACY_MASK } from '@/core/privacy'
import type { AccountView, TransactionView } from '@/api/types'
import { useLedgerDataStore } from '@/stores/ledgerData'
import { usePeriodStore } from '@/stores/period'
import { usePrivacyStore } from '@/stores/privacy'
import { useSessionStore } from '@/stores/session'

import BillsView from './BillsView.vue'

// 抽屉打开会锁 body 滚动；每个用例结束自动卸载，保证锁深度归零。
enableAutoUnmount(afterEach)

const h = vi.hoisted(() => ({
  accountList: vi.fn(),
  txnList: vi.fn(),
  txnListPage: vi.fn(),
  me: vi.fn(),
  ledgerList: vi.fn(),
  identityCheck: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  changePassword: vi.fn(),
  setLedgerIdProvider: vi.fn(),
  push: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  accountApi: { list: h.accountList },
  transactionApi: { list: h.txnList, listPage: h.txnListPage },
  authApi: { me: h.me, login: h.login, logout: h.logout, changePassword: h.changePassword },
  ledgerApi: { list: h.ledgerList },
  identityApi: { check: h.identityCheck },
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

/**
 * 排空上一用例遗留的补齐段定时器（批 I 两段加载）：必须排在 mockReset 之前，
 * 让遗留回调带 epoch 守卫与旧 mock 的可解析返回值安全落地。
 */
async function drainTimers(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
  await Promise.resolve()
}

/** 挂载并把 store 状态压到「已加载 + 指定交易」，避免每个用例都走一遍异步装载。 */
function mountWith(txns: TransactionView[]): ReturnType<typeof mount> {
  data.txns = txns
  data.accounts = ACCOUNTS
  data.loaded = true
  data.loading = false
  data.error = ''
  // 批 I 两段加载：手工压入的 txns 视为「全量快照」，否则 monthPending 会把
  // 既有用例全部打到「正在聚合当月数据…」的等待态。
  data.fullReady = true
  vi.spyOn(data, 'ensure').mockResolvedValue(undefined)
  return mount(BillsView, {
    global: { plugins: [pinia], stubs: { TrendChart: TrendStub } },
  })
}

beforeEach(async () => {
  await drainTimers()
  pinia = createPinia()
  setActivePinia(pinia)
  localStorage.clear()
  document.body.style.position = ''
  document.body.style.top = ''
  document.body.style.overflow = ''
  Object.defineProperty(window, 'scrollTo', {
    value: vi.fn(),
    writable: true,
    configurable: true,
  })
  for (const spy of Object.values(h)) {
    spy.mockReset()
  }
  h.accountList.mockResolvedValue({ accounts: ACCOUNTS })
  h.txnList.mockResolvedValue({ transactions: TXNS })
  // 批 I：首段窗口腿默认空窗口
  h.txnListPage.mockResolvedValue({ transactions: [] })
  h.ledgerList.mockResolvedValue({ ledgers: [] })
  h.identityCheck.mockResolvedValue({
    balanced: true,
    diffs: [],
    posting_count: 3360,
    checked_at: '2026-11-25T00:00:00Z',
    duration_ms: 3,
  })
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

  it('切账本后重新拉取（账本接口被再次调用）并关掉当日抽屉', async () => {
    const wrapper = mountWith(TXNS)
    await wrapper.findAll('button.cal__cell')[2].trigger('click')
    expect(wrapper.find('[data-testid="day-transactions-sheet"]').exists()).toBe(true)

    const callsBefore = h.txnList.mock.calls.length
    session.ledgers = [
      { id: 7, name: '家庭账本', role: 'owner', opening_date: '2026-01-01' },
      { id: 8, name: '旅行账本', role: 'editor', opening_date: '2026-01-01' },
    ]
    session.ledgerId = 8
    await settle()

    // store 内部 watch 做了 reset() + ensure()：账本接口必须被再次调用
    expect(h.txnList.mock.calls.length).toBe(callsBefore + 1)
    // 旧账本打开的当日抽屉必须关掉，否则会拿新账本数据填旧日期
    expect(wrapper.find('[data-testid="day-transactions-sheet"]').exists()).toBe(false)
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

  it('点某日 → 打开底部抽屉显示当日交易；外部列表仍是整月 3 行', async () => {
    const wrapper = mountWith(TXNS)
    expect(wrapper.findAll('.bills__row')).toHaveLength(3)

    await wrapper.findAll('button.cal__cell')[2].trigger('click')
    // 抽屉：11-03 一笔，标题带笔数，行是 drawer 档
    const sheet = wrapper.find('[data-testid="day-transactions-sheet"]')
    expect(sheet.exists()).toBe(true)
    expect(sheet.find('.ss-title').text()).toBe('11月3日 · 1 笔')
    expect(sheet.findAll('.txn-row--drawer')).toHaveLength(1)
    expect(sheet.text()).toContain('工资与午饭')

    // 关键回归：外部列表一动不动，旧的「查看整月 ✕」日筛选条彻底不存在
    expect(wrapper.findAll('.bills__row')).toHaveLength(3)
    expect(wrapper.find('.bills__dayfilter').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('查看整月')
  })

  it('抽屉内点行跳详情；ESC 关闭后外部列表仍不变', async () => {
    const wrapper = mountWith(TXNS)
    await wrapper.findAll('button.cal__cell')[2].trigger('click')

    await wrapper.find('[data-testid="day-transactions-sheet"] .txn-row').trigger('click')
    expect(h.push).toHaveBeenCalledWith({
      name: 'transaction-detail',
      query: { id: '101' },
    })

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="day-transactions-sheet"]').exists()).toBe(false)
    expect(wrapper.findAll('.bills__row')).toHaveLength(3)
  })

  it('点无交易的日期 → 抽屉显示空态，外部列表不受影响', async () => {
    const wrapper = mountWith(TXNS)
    // 11-05 无交易
    await wrapper.findAll('button.cal__cell')[4].trigger('click')
    const sheet = wrapper.find('[data-testid="day-transactions-sheet"]')
    expect(sheet.find('.ss-title').text()).toBe('11月5日 · 0 笔')
    expect(sheet.text()).toContain('当日无交易')
    expect(wrapper.findAll('.bills__row')).toHaveLength(3)
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

/**
 * 批 I 两段加载接入（首屏窗口段 + 后台补齐）。
 *
 * 页面级契约：onMounted 先 `setWindowMonth` 再 `ensure`；monthPending 先判 loading
 * （防「当月无记录」误报）；币种下拉在补齐态降级、全量态口径不变；reload 不清
 * fullReady（SWR 不闪整页骨架）。
 */
describe('BillsView：两段加载（批 I）', () => {
  /** 手动可控的 Promise。 */
  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolveFn: (value: T) => void = () => undefined
    const promise = new Promise<T>((resolve) => {
      resolveFn = resolve
    })
    return { promise, resolve: resolveFn }
  }

  it('补齐态币种下拉降级：账户 balances 键 ∪ 当月窗口 postings 币种 ∪ 当前币种', async () => {
    const accounts: AccountView[] = [
      ...ACCOUNTS,
      {
        id: 9,
        name: 'Assets:Card',
        uuid: 'uuid-9',
        type: 'Assets',
        open_date: '2026-01-01',
        sort_order: 9,
        balances: { CNY: '10.00', USD: '5.00' },
      },
    ]
    const windowRows: TransactionView[] = [
      {
        id: 201,
        uuid: 't-201',
        date: '2026-11-05',
        flag: '*',
        description: '欧元票',
        created_by_name: '林小满',
        postings: [{ account_id: 1, account: 'Assets:Bank', commodity: 'EUR', amount: '8.00' }],
      },
    ]
    h.accountList.mockResolvedValue({ accounts })
    h.txnListPage.mockResolvedValue({ transactions: windowRows })
    // 补齐段悬停：让页面保持在补齐态（fullReady=false）
    h.txnList.mockImplementation(() => new Promise(() => undefined))

    const wrapper = mount(BillsView, {
      global: { plugins: [pinia], stubs: { TrendChart: TrendStub } },
    })
    await flushPromises()

    // 首段落地：当月窗口已并入快照，但全量还没回来
    expect(data.loaded).toBe(true)
    expect(data.fullReady).toBe(false)
    expect(data.hasMonthWindow('2026-11')).toBe(true)
    // 当前币种 CNY 优先，其余按首次出现序：账户 balances 的 USD，再窗口里的 EUR
    expect(wrapper.findAll('.bills__seg-btn').map((btn) => btn.text())).toEqual([
      'CNY',
      'USD',
      'EUR',
    ])
  })

  it('全量态币种下拉口径不变：当前币种优先，其余按全量 postings 首次出现序', async () => {
    const usdTxn: TransactionView = {
      id: 104,
      uuid: 't-104',
      date: '2026-11-20',
      flag: '*',
      description: '美元订阅',
      created_by_name: '林小满',
      postings: [{ account_id: 1, account: 'Assets:Bank', commodity: 'USD', amount: '9.99' }],
    }
    const wrapper = mountWith([...TXNS, usdTxn])
    expect(wrapper.findAll('.bills__seg-btn').map((btn) => btn.text())).toEqual(['CNY', 'USD'])
  })

  it('monthPending 时不出「暂无数据」，文案为「正在聚合当月数据…」；窗口落地后恢复', async () => {
    const slowWindow = deferred<{ transactions: TransactionView[] }>()
    h.txnListPage.mockImplementation((query: { from?: string }) =>
      query.from === '2026-11-01'
        ? Promise.resolve({ transactions: TXNS })
        : slowWindow.promise,
    )
    // 补齐段悬停，保住补齐态
    h.txnList.mockImplementation(() => new Promise(() => undefined))

    const wrapper = mount(BillsView, {
      global: { plugins: [pinia], stubs: { TrendChart: TrendStub } },
    })
    await flushPromises()
    expect(wrapper.text()).not.toContain('暂无数据')

    // 切到 10 月：该月窗口请求悬停 → monthPending，先判 loading 而不是误判 empty
    period.setBillsMonth(2026, 10)
    await flushPromises()
    expect(wrapper.text()).toContain('正在聚合当月数据…')
    expect(wrapper.text()).not.toContain('暂无数据')
    expect(wrapper.find('.metrics').exists()).toBe(false)

    // 窗口落地：恢复 ready 并渲染该月数据
    slowWindow.resolve({
      transactions: [
        {
          id: 301,
          uuid: 't-301',
          date: '2026-10-15',
          flag: '*',
          description: '十月聚餐',
          created_by_name: '林小满',
          postings: [
            { account_id: 2, account: 'Expenses:Food', commodity: 'CNY', amount: '66.00' },
          ],
        },
      ],
    })
    await flushPromises()
    expect(wrapper.text()).not.toContain('正在聚合当月数据…')
    expect(wrapper.find('.metrics').exists()).toBe(true)
  })

  it('reload 后无整页骨架（fullReady / loaded 不被清除，SWR 不闪）', async () => {
    const wrapper = mountWith(TXNS)
    expect(wrapper.findAll('.metrics__card')).toHaveLength(4)
    // reload 悬停在途：若 reload 清了 fullReady，monthPending 会把页面打成骨架
    vi.spyOn(data, 'reload').mockReturnValueOnce(new Promise<void>(() => undefined))
    data.error = '服务暂时不可用'
    await wrapper.vm.$nextTick()
    await wrapper.find('.bills__stale-btn').trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('.metrics__card')).toHaveLength(4)
    expect(wrapper.text()).not.toContain('正在聚合当月数据…')
    expect(wrapper.text()).not.toContain('正在加载')
  })
})

/**
 * 聚合骨架（骨架屏批）：monthPending 时 StateCard 的 loading 文字档换成
 * 「日历 + 指标 + 列表条」骨架组合；窗口落地即换回真实内容。
 */
describe('BillsView：聚合骨架（骨架屏批）', () => {
  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolveFn: (value: T) => void = () => undefined
    const promise = new Promise<T>((resolve) => {
      resolveFn = resolve
    })
    return { promise, resolve: resolveFn }
  }

  /** 挂载并切到 10 月（该月窗口悬停）→ monthPending 骨架态；返回解开悬停窗口的 resolve。 */
  async function mountSkeleton(): Promise<{
    wrapper: ReturnType<typeof mount>
    resolveWindow: (value: { transactions: TransactionView[] }) => void
  }> {
    const slowWindow = deferred<{ transactions: TransactionView[] }>()
    h.txnListPage.mockImplementation((query: { from?: string }) =>
      query.from === '2026-11-01'
        ? Promise.resolve({ transactions: TXNS })
        : slowWindow.promise,
    )
    // 补齐段悬停，保住补齐态
    h.txnList.mockImplementation(() => new Promise(() => undefined))

    const wrapper = mount(BillsView, {
      global: { plugins: [pinia], stubs: { TrendChart: TrendStub } },
    })
    await flushPromises()
    period.setBillsMonth(2026, 10)
    await flushPromises()
    return { wrapper, resolveWindow: slowWindow.resolve }
  }

  it('monthPending 渲染骨架组合而非文字 loading（日历块 / 4 指标卡 / 列表条）', async () => {
    const { wrapper } = await mountSkeleton()

    expect(wrapper.find('.bills__skel').exists()).toBe(true)
    expect(wrapper.find('.skel--calendar').exists()).toBe(true)
    expect(wrapper.findAll('.skel--card')).toHaveLength(4)
    expect(wrapper.findAll('.skel--line').length).toBeGreaterThanOrEqual(3)
    // 不再渲染 StateCard 的呼吸点文字档；读屏文案保留（aria-live 播报语义不变）
    expect(wrapper.find('.sc-loading').exists()).toBe(false)
    expect(wrapper.text()).toContain('正在聚合当月数据…')
    wrapper.unmount()
  })

  it('窗口落地后骨架消失、列表恢复渲染', async () => {
    const { wrapper, resolveWindow } = await mountSkeleton()
    expect(wrapper.find('.bills__skel').exists()).toBe(true)

    resolveWindow({
      transactions: [
        {
          id: 301,
          uuid: 't-301',
          date: '2026-10-15',
          flag: '*',
          description: '十月聚餐',
          created_by_name: '林小满',
          postings: [
            { account_id: 2, account: 'Expenses:Food', commodity: 'CNY', amount: '66.00' },
          ],
        },
      ],
    })
    await flushPromises()

    expect(wrapper.find('.bills__skel').exists()).toBe(false)
    expect(wrapper.findAll('.bills__row')).toHaveLength(1)
    wrapper.unmount()
  })
})

// ---------- banner 上的账本健康图标 ----------
describe('BillsView：账本健康图标', () => {
  it('balanced：绿勾 tone，口径写进 title，点图标跳数据安全页', async () => {
    const wrapper = mountWith(TXNS)
    await settle()

    // 旧状态条整块 DOM 必须消失（不再占位置）
    expect(wrapper.find('[data-testid="ledger-health"]').exists()).toBe(false)
    expect(wrapper.find('.bills__summary').exists()).toBe(false)

    const icon = wrapper.find('[data-testid="ledger-health-icon"]')
    expect(icon.exists()).toBe(true)
    expect(icon.classes()).toContain('bills__health-icon--ok')
    expect(icon.text()).toBe('✓')
    expect(icon.attributes('aria-label')).toContain('分录借贷恒等式检查')
    const hint = icon.attributes('title') ?? ''
    expect(hint).toContain('分录借贷恒等式检查通过：3360 条分录按币种借贷平衡')
    expect(hint).toContain('不是 bean-check')
    expect(hint).toContain('不是余额校准')
    expect(hint).toContain('设置的数据安全页')

    await icon.trigger('click')
    expect(h.push).toHaveBeenCalledWith({ name: 'data-safety' })
  })

  it('不平：警示 tone，title 按币种列差额且口径保留', async () => {
    h.identityCheck.mockResolvedValue({
      balanced: false,
      diffs: [
        { commodity: 'CNY', sum: '0.01' },
        { commodity: 'USD', sum: '-0.02' },
      ],
      posting_count: 3360,
      checked_at: '2026-11-25T00:00:00Z',
      duration_ms: 4,
    })
    const wrapper = mountWith(TXNS)
    await settle()

    const icon = wrapper.find('[data-testid="ledger-health-icon"]')
    expect(icon.classes()).toContain('bills__health-icon--unbalanced')
    expect(icon.text()).toBe('⚠')
    expect(icon.attributes('title')).toContain('CNY +0.01、USD -0.02')
    expect(icon.attributes('title')).toContain('不是 bean-check')
    expect(h.identityCheck).toHaveBeenCalled()
  })

  it('检查中 / 接口失败：不伪装成平衡，统一中性 tone', async () => {
    // identityApi.check() 悬停 → 保持在「检查中」
    h.identityCheck.mockImplementation(() => new Promise(() => undefined))
    const checking = mountWith(TXNS)
    expect(checking.find('[data-testid="ledger-health-icon"]').classes()).toContain(
      'bills__health-icon--unknown',
    )
    expect(checking.find('[data-testid="ledger-health-icon"]').attributes('title')).toContain(
      '正在进行分录借贷恒等式检查',
    )
    checking.unmount()

    h.identityCheck.mockRejectedValue(new Error('offline'))
    const failed = mountWith(TXNS)
    await settle()
    const icon = failed.find('[data-testid="ledger-health-icon"]')
    expect(icon.classes()).toContain('bills__health-icon--unknown')
    expect(icon.attributes('title')).toContain('分录借贷恒等式检查失败')
  })

  it('切账本后按新账本重取检查结果', async () => {
    const wrapper = mountWith(TXNS)
    await settle()
    expect(h.identityCheck).toHaveBeenCalledTimes(1)

    session.ledgers = [
      { id: 7, name: '家庭账本', role: 'owner', opening_date: '2026-01-01' },
      { id: 8, name: '旅行账本', role: 'editor', opening_date: '2026-01-01' },
    ]
    session.ledgerId = 8
    await settle()

    expect(h.identityCheck).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })
})
