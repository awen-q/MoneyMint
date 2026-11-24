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
import { createMemoryHistory, createRouter, type Router } from 'vue-router'

import StatsView from '@/views/StatsView.vue'
import { MAX_LIVE_CHARTS, liveChartCount, resetLiveChartCount } from '@/core/charts/liveCount'
import { usePeriodStore } from '@/stores/period'
import { useSessionStore } from '@/stores/session'

/**
 * StatsView 在 setup 里就调了 `useRouter()`（下钻要 push 到搜索账单），
 * 所以挂载必须提供 router，否则会报 `injection "Symbol(router)" not found`。
 *
 * 这条以前只是控制台噪音；`setupVueWarn.ts`（`vite.config.ts:74` 接线）把
 * `[Vue warn]` 提升为失败后，本文件 7 条用例曾整体变红 ——
 * **缺陷是老的，只是以前没人把它当错误**。
 */
function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/search', name: 'search', component: { template: '<div />' } },
      // 兜底：下钻 push 的目标若尚未定义，也不该让用例因「无匹配路由」而炸
      { path: '/:pathMatch(.*)*', component: { template: '<div />' } },
    ],
  })
}

const h = vi.hoisted(() => ({
  accountList: vi.fn(),
  txnList: vi.fn(),
  txnListPage: vi.fn(),
  me: vi.fn(),
  ledgerList: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  changePassword: vi.fn(),
  setLedgerIdProvider: vi.fn(),
  /** 只替换 echarts 的 initChart，其它导出（含 liveCount）保持真实实现。 */
  initChart: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  accountApi: { list: h.accountList },
  transactionApi: { list: h.txnList, listPage: h.txnListPage },
  authApi: {
    me: h.me,
    login: h.login,
    logout: h.logout,
    changePassword: h.changePassword,
  },
  ledgerApi: { list: h.ledgerList },
  setLedgerIdProvider: h.setLedgerIdProvider,
}))

/**
 * 图表层只换 `initChart`，**保留真实的 `acquireChart` / `liveChartCount`**。
 *
 * 这一点是本文件下面那两条峰值用例的命门：在册计数是纯 JS（`core/charts/liveCount.ts`），
 * 不需要 echarts 运行时、也不需要 canvas 桩。若把整个模块 mock 成 `initChart → null`，
 * 组件的 `ensureInstance` 会在 `acquireChart` 之前就返回，计数恒为 0 ——
 * 于是「峰值 ≤ 4」的断言永远绿，**测的是 0 ≤ 4 这种空话**。
 */
vi.mock('@/core/charts/echarts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/charts/echarts')>()
  return { ...actual, initChart: h.initChart }
})

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

/**
 * 等两段都落地（批 I 两段加载）：
 * - 两轮 flushPromises 让首段（窗口段）完成；
 * - 再等一轮 **setTimeout 宏任务**让补齐段的兜底定时器触发——flush-promises 用
 *   setImmediate（check 相），与 setTimeout 的相对次序不保证，必须用 setTimeout
 *   显式排序（先注册的 1ms 定时器先触发）；
 * - 最后一轮 flushPromises 等补齐段触发的渲染 / 微任务链收尾（fullReady → 图表挂载）。
 */
async function flushBothSegments(): Promise<void> {
  await flushPromises()
  await flushPromises()
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
  await flushPromises()
}

/**
 * 挂载并等两段都落地：统计页聚合守 fullReady，不等补齐段整页都会停在「聚合中」骨架。
 */
async function mountView(): Promise<ReturnType<typeof mount>> {
  const wrapper = mount(StatsView, {
    global: {
      plugins: [makeRouter()],
      stubs: {
        TrendChart: true,
        DonutChart: true,
        BarChart: true,
        MonthPicker: true,
      },
    },
  })
  await flushBothSegments()
  return wrapper
}

/** 排空上一用例遗留的补齐段定时器（批 I）：必须排在 mockReset 之前。 */
async function drainTimers(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
  await Promise.resolve()
}

beforeEach(async () => {
  await drainTimers()
  setActivePinia(createPinia())
  h.accountList.mockReset()
  h.txnList.mockReset()
  h.txnListPage.mockReset()
  h.accountList.mockResolvedValue({ accounts: ACCOUNTS })
  h.txnList.mockResolvedValue({ transactions: TXNS })
  // 批 I：首段窗口腿默认空窗口
  h.txnListPage.mockResolvedValue({ transactions: [] })
  useSessionStore().ledgerId = 7
  // 固定到 2026-11，避开「当月/未来月」随时间变化的抖动
  usePeriodStore().setStatsMonth(2026, 11)
})

describe('T48 StatsView：数据来源与分页口径', () => {
  it('只调一次 ensure，且请求不带任何分页参数（首屏绝不传 limit）', async () => {
    await mountView()
    expect(h.accountList).toHaveBeenCalledTimes(1)
    expect(h.txnList).toHaveBeenCalledTimes(1)
    // 分页参数必须缺席——一旦有人塞 { limit } / { cursor }，聚合就只覆盖当前页。
    // 注意 `accountApi.list` 现在会带 `{ includeClosed: true }`（账本全量快照需要
    // 关户账户，见 ledgerData.includeClosed.test.ts）；这里只断言**没有分页参数**，
    // 不要改成 `toEqual([])`——那会把「快照要含关户」这条正当行为判成缺陷。
    expect(h.txnList.mock.calls[0]).toEqual([])
    const accountOpts = h.accountList.mock.calls[0][0] as Record<string, unknown> | undefined
    expect(accountOpts?.limit).toBeUndefined()
    expect(accountOpts?.cursor).toBeUndefined()
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

/**
 * 批 I 两段加载：聚合计算守 `fullReady`。
 *
 * 补齐段完成前 `txns` 只有「已拉窗口」的月份，拿它算「当季 / 当年」聚合会静默
 * 出**错数**（日均、占比、标签分面全错却不报错）——所以 fullReady=false 时整页
 * 走四态 loading 骨架（文案「正在聚合数据…」），补齐完成后恢复现行渲染。
 */
describe('批 I 两段加载：聚合守 fullReady', () => {
  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolveFn: (value: T) => void = () => undefined
    const promise = new Promise<T>((resolve) => {
      resolveFn = resolve
    })
    return { promise, resolve: resolveFn }
  }

  /** 补齐态挂载：全量请求悬停，页面停在「聚合中」骨架。 */
  async function mountPending(): Promise<{
    wrapper: ReturnType<typeof mount>
    resolveFull: (value: { transactions: unknown[] }) => void
  }> {
    const slowFull = deferred<{ transactions: unknown[] }>()
    h.txnList.mockImplementation(() => slowFull.promise)
    const wrapper = mount(StatsView, {
      global: {
        plugins: [makeRouter()],
        stubs: { TrendChart: true, DonutChart: true, BarChart: true, MonthPicker: true },
      },
    })
    // 等补齐段定时器触发并悬停在慢响应上：fullReady 停在 false
    await flushBothSegments()
    return {
      wrapper,
      resolveFull: (value: { transactions: unknown[] }) => {
        slowFull.resolve(value)
      },
    }
  }

  it('补齐中（fullReady=false）整页聚合骨架，不渲染半窗指标', async () => {
    const { wrapper } = await mountPending()
    expect(wrapper.text()).toContain('正在聚合数据…')
    // 半窗快照绝不能渲染成指标（11 月窗口只有部分数据时会算出错数）
    expect(wrapper.find('.stats-metrics').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('900.00')
    // 骨架不能变成死路：工具卡（周期 / 月份）仍在 StateCard 之外
    expect(wrapper.find('.period-seg').exists()).toBe(true)
    wrapper.unmount()
  })

  it('补齐完成（fullReady=true）恢复现行渲染', async () => {
    const { wrapper, resolveFull } = await mountPending()
    expect(wrapper.text()).toContain('正在聚合数据…')

    resolveFull({ transactions: TXNS })
    await flushPromises()

    expect(wrapper.text()).not.toContain('正在聚合数据…')
    expect(wrapper.text()).toContain('900.00')
    expect(wrapper.find('.stats-metrics').exists()).toBe(true)
    wrapper.unmount()
  })

  it('补齐中渲染「双环 + 排行」骨架组合，而非呼吸点文字档（骨架屏批）', async () => {
    const { wrapper } = await mountPending()

    expect(wrapper.find('.stats__skel').exists()).toBe(true)
    expect(wrapper.findAll('.skel--chart')).toHaveLength(2)
    expect(wrapper.findAll('.skel--line').length).toBeGreaterThanOrEqual(3)
    // 不再渲染 StateCard 的呼吸点文字档；读屏文案保留
    expect(wrapper.find('.sc-loading').exists()).toBe(false)
    expect(wrapper.text()).toContain('正在聚合数据…')
    wrapper.unmount()
  })

  it('补齐完成后骨架组合消失（双环骨架换回真实卡片）', async () => {
    const { wrapper, resolveFull } = await mountPending()
    expect(wrapper.find('.stats__skel').exists()).toBe(true)

    resolveFull({ transactions: TXNS })
    await flushPromises()

    expect(wrapper.find('.stats__skel').exists()).toBe(false)
    expect(wrapper.find('.stats-metrics').exists()).toBe(true)
    wrapper.unmount()
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

/* ==========================================================================
 * 图表实例峰值（liveChartCount）
 *
 * 为什么单独一组、而且必须**不 stub** 图表组件：上面那些用例把
 * `TrendChart/DonutChart/BarChart` 全 stub 成占位符，实例数恒为 0，
 * 对「峰值 ≤ 4」这条约束零证明力。这里让真实组件挂上去，只替换 initChart。
 *
 * 约束来自 `core/charts/liveCount.ts`：`MAX_LIVE_CHARTS = 4`，当初按
 * 「statTrend + donutE + donutI + catBar」算出。本组用例把这个约定钉在
 * **页面级**：单组件测试测不到「一页同时挂几张」。
 * ========================================================================== */

/** 假实例：组件只用到这五个方法（setOption / on / off / resize / dispose）。 */
function fakeChart() {
  return {
    setOption: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
  }
}

/**
 * 挂载真实图表组件的 StatsView。
 *
 * `attachTo: document.body` 是必需的：图表组件在 `await initChart()` 之后会复检
 * `target.isConnected`，脱离文档的容器会被判定为「已卸载」→ dispose 且不计数，
 * 计数又会变成恒 0（同样的空话陷阱）。
 */
async function mountWithRealCharts(): Promise<ReturnType<typeof mount>> {
  const wrapper = mount(StatsView, {
    attachTo: document.body,
    global: { plugins: [makeRouter()], stubs: { MonthPicker: true } },
  })
  // 等两段都落地（聚合守 fullReady，图表只在 ready 态挂载）
  await flushBothSegments()
  return wrapper
}

describe('T48 StatsView：图表实例峰值不超过 liveCount 上限', () => {
  beforeEach(() => {
    resetLiveChartCount()
    h.initChart.mockReset()
    h.initChart.mockImplementation(async () => fakeChart())
  })

  it('「统计」子页峰值恰好 4（趋势 1 + 双环 2 + 柱 1），未超上限', async () => {
    const wrapper = await mountWithRealCharts()

    // 断言**精确值**而不是只断言 ≤4：后者在「一张图都没挂」时也成立，
    // 会变成永远绿的空话（本文件原先 stub 掉图表就正是这种状态）。
    expect(liveChartCount()).toBe(4)
    expect(liveChartCount()).toBeLessThanOrEqual(MAX_LIVE_CHARTS)

    wrapper.unmount()
    expect(liveChartCount()).toBe(0)
  })

  it('「标签」子页峰值恰好 2，且离开后归零', async () => {
    const wrapper = await mountWithRealCharts()
    usePeriodStore().setStatsTab('tag')
    await flushPromises()

    expect(liveChartCount()).toBe(2)

    wrapper.unmount()
    expect(liveChartCount()).toBe(0)
  })

  it('反复切子页不累积：4 → 2 → 4 → 2 …（泄漏才会把实例数拖上去）', async () => {
    const wrapper = await mountWithRealCharts()
    const period = usePeriodStore()
    const seen: number[] = [liveChartCount()]

    for (let i = 0; i < 3; i += 1) {
      period.setStatsTab('tag')
      await flushPromises()
      seen.push(liveChartCount())
      period.setStatsTab('stat')
      await flushPromises()
      seen.push(liveChartCount())
    }

    // 逐次断言而不是只看末值：只看末值的话，4→6→8→4 这种「中途泄漏又回落」
    // 会被漏掉，而中途峰值正是会把内存顶上去的时刻。
    //
    // 这条断言的真正价值在于它同时钉住了**泄漏斜率**：
    // 把 liveCount 的 release 改成 no-op 后，这里实测得到
    //   [4, 6, 10, 12, 16, 18, 22]   ← 每切到标签子页 +2、每切回统计 +4
    // 也就是「每次切换固定多留 2 个实例」的线性增长，而不是偶发抖动。
    // 一个能显示斜率的观测值，比「≤ 4」这种单点上界有用得多：
    // 上界只回答「这次超没超」，斜率回答「下一次会不会超、多久超」。
    expect(seen).toEqual([4, 2, 4, 2, 4, 2, 4])

    wrapper.unmount()
    expect(liveChartCount()).toBe(0)
  })
})

/**
 * 审计 P4：标签子页的「点击行下钻」以前是 `@drill="() => undefined"` ——
 * 整块可点、cursor 是 pointer、`:hover` 有反馈，但点了什么都不发生。
 * 一个可点的东西不响应，用户会以为页面卡住了 —— 所以这里钉住「点了会跳」。
 */
describe('P4 标签下钻 → 搜索账单页', () => {
  it('点标签行 → push 到 search，带该标签 + 当月窗口', async () => {
    const router = makeRouter()
    const wrapper = mount(StatsView, {
      global: {
        plugins: [router],
        stubs: { TrendChart: true, DonutChart: true, BarChart: true, MonthPicker: true },
      },
    })
    await flushBothSegments()
    usePeriodStore().setStatsTab('tag')
    await flushPromises()

    const rows = wrapper.findAll('.tag-panel__row-btn')
    expect(rows.length).toBeGreaterThan(0)
    const family = rows.find((row) => row.text().includes('家庭'))
    expect(family).toBeDefined()
    await family?.trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/search')
    // 窗口必须是**当前月**的两个端点（年周期才展开成 01-01 / 12-31）
    expect(router.currentRoute.value.query.from).toBe('2026-11-01')
    expect(router.currentRoute.value.query.to).toBe('2026-11-30')
    expect(router.currentRoute.value.query.tag).toBe('家庭')
  })

  it('「年」周期下钻：窗口展开成整年（`YYYY-MM` 直接当 from 会被 DATE_RE 丢掉）', async () => {
    const router = makeRouter()
    const wrapper = mount(StatsView, {
      global: {
        plugins: [router],
        stubs: { TrendChart: true, DonutChart: true, BarChart: true, MonthPicker: true },
      },
    })
    await flushBothSegments()
    // 先切「年」，再切「标签」子页
    await wrapper.findAll('.period-seg__btn')[2].trigger('click')
    usePeriodStore().setStatsTab('tag')
    await flushPromises()

    const rows = wrapper.findAll('.tag-panel__row-btn')
    const family = rows.find((row) => row.text().includes('家庭'))
    await family?.trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.query.from).toBe('2026-01-01')
    expect(router.currentRoute.value.query.to).toBe('2026-12-31')
  })
})
