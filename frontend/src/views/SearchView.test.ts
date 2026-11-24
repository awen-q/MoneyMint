// @vitest-environment jsdom
/**
 * SearchView 回归（T37）：分页状态机是本页唯一的难点，所以用例集中在「时序」上。
 *
 * 六条主用例（对应 team-lead 的验收）：
 * 1. 首屏带 `limit: 20` 且无 `cursor`；「共 N 笔」取 `total` 而不是行数；
 * 2. 「加载更多」带上次 `next_cursor` 且其余筛选参数原样带上；追加后无重复 id；
 * 3. 改筛选 → 游标归零、列表清空、重新走首屏；
 * 4. **乱序响应丢弃**：先发的慢响应后到，不得覆盖后发的快响应；
 * 5. CSV 导出断言 `limit === 0`（防「复用分页状态」式优化）；
 * 6. 空态时搜索卡仍在（空态不能让人失去出口）。
 */
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TransactionListPage, TransactionView } from '@/api/types'
import { useLedgerDataStore } from '@/stores/ledgerData'
import { usePrivacyStore } from '@/stores/privacy'
import { PRIVACY_MASK } from '@/core/privacy'

import SearchView from './SearchView.vue'
import SearchFilters from '@/components/search/SearchFilters.vue'

const h = vi.hoisted(() => ({
  listPage: vi.fn(),
  list: vi.fn(),
  accountList: vi.fn(),
  ledgerList: vi.fn(),
  replace: vi.fn(),
  push: vi.fn(),
  route: { query: {} as Record<string, string> },
  downloadCsv: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  transactionApi: { list: h.list, listPage: h.listPage },
  accountApi: { list: h.accountList },
  ledgerApi: { list: h.ledgerList },
  authApi: { me: vi.fn(), login: vi.fn(), logout: vi.fn(), changePassword: vi.fn() },
  setLedgerIdProvider: vi.fn(),
}))

vi.mock('@/core/csv', async () => {
  const actual = await vi.importActual<typeof import('@/core/csv')>('@/core/csv')
  return { ...actual, downloadCsv: h.downloadCsv }
})

vi.mock('vue-router', () => ({
  useRoute: () => h.route,
  useRouter: () => ({ replace: h.replace, push: h.push }),
}))

function makeTxn(id: number): TransactionView {
  return {
    id,
    uuid: `txn-${id}`,
    date: '2026-11-16',
    flag: '*',
    description: `交易 ${id}`,
    created_by_name: '阿文',
    postings: [
      { account_id: 2, account: 'Expenses:Food', commodity: 'CNY', amount: '10.00' },
      { account_id: 1, account: 'Assets:Bank', commodity: 'CNY', amount: '-10.00' },
    ],
  }
}

function page(ids: number[], extra: Partial<TransactionListPage> = {}): TransactionListPage {
  return { transactions: ids.map(makeTxn), ...extra }
}

/** 带 `with=summary` 的响应（汇总口径 = 筛选全集）。 */
function pageWithSummary(
  ids: number[],
  total: number,
  byCommodity: Array<{ commodity: string; income: string; expense: string }>,
  extra: Partial<TransactionListPage> = {},
): TransactionListPage {
  return { transactions: ids.map(makeTxn), total, summary: { total, by_commodity: byCommodity }, ...extra }
}

/** 手动可控的 Promise：用于构造乱序响应。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveFn: (value: T) => void = () => undefined
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve
  })
  return { promise, resolve: resolveFn }
}

let pinia: ReturnType<typeof createPinia>

function mountView(): VueWrapper {
  return mount(SearchView, { global: { plugins: [pinia] } })
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  localStorage.clear()
  for (const fn of Object.values(h)) {
    if (typeof fn === 'function' && 'mockReset' in fn) {
      ;(fn as ReturnType<typeof vi.fn>).mockReset()
    }
  }
  h.route.query = {}
  h.accountList.mockResolvedValue({ accounts: [] })
  h.list.mockResolvedValue({ transactions: [] })
  h.ledgerList.mockResolvedValue({ ledgers: [] })
  const data = useLedgerDataStore()
  data.accounts = []
  data.txns = []
  data.loaded = true
})

describe('SearchView：首屏与分页', () => {
  it('首屏请求带 limit: 20 且不带 cursor；「共 N 笔」取 total 不是行数', async () => {
    h.listPage.mockResolvedValue(
      pageWithSummary([1, 2, 3], 57, [{ commodity: 'CNY', income: '5000.00', expense: '3200.00' }], {
        has_more: true,
        next_cursor: 'c1',
      }),
    )
    const wrapper = mountView()
    await flushPromises()

    expect(h.listPage).toHaveBeenCalledTimes(1)
    const query = h.listPage.mock.calls[0][0] as Record<string, unknown>
    expect(query.limit).toBe(20)
    expect(query.cursor).toBeUndefined()
    // 首屏必须带 with=summary（汇总口径是筛选全集，翻页不必再算）
    expect(query.with).toBe('summary')

    expect(wrapper.findAll('.search__row')).toHaveLength(3)
    // 关键：57 来自 summary.total，不是本页 3 行
    expect(wrapper.find('.search__summary-total').text()).toBe('共 57 笔')
  })

  it('「加载更多」带上次 next_cursor，其余筛选参数原样带上，追加后无重复 id', async () => {
    h.listPage.mockResolvedValueOnce(
      page([1, 2], { total: 4, has_more: true, next_cursor: 'c1' }),
    )
    const wrapper = mountView()
    await flushPromises()

    // 换筛选后首屏：仍然有下一页（游标只表达位置，筛选每次都要重带）
    h.listPage.mockResolvedValueOnce(
      page([3, 4], { total: 4, has_more: true, next_cursor: 'c1' }),
    )
    await wrapper.find('[aria-label="类型筛选"]').setValue('expense')
    await flushPromises()

    const first = h.listPage.mock.calls[1][0] as Record<string, unknown>
    expect(first.kind).toBe('expense')
    expect(first.limit).toBe(20)
    expect(first.cursor).toBeUndefined()

    // 翻页：第二次请求必须带 cursor，且筛选原样带上
    h.listPage.mockResolvedValueOnce(page([5, 6], { total: 6, has_more: false }))
    await wrapper.find('.search__more-btn').trigger('click')
    await flushPromises()

    const second = h.listPage.mock.calls[2][0] as Record<string, unknown>
    expect(second.cursor).toBe('c1')
    expect(second.kind).toBe('expense')
    expect(second.limit).toBe(20)

    const rows = wrapper.findAll('.search__row')
    expect(rows).toHaveLength(4)
    // 追加而不是替换：前两行仍在，且没有重复渲染
    expect(new Set(rows.map((row) => row.html())).size).toBe(4)
  })

  it('改筛选 → 游标归零、列表清空、重新走首屏', async () => {
    h.listPage.mockResolvedValueOnce(page([1, 2], { total: 2, has_more: true, next_cursor: 'c1' }))
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.findAll('.search__row')).toHaveLength(2)

    const pending = deferred<TransactionListPage>()
    h.listPage.mockImplementationOnce(() => pending.promise)

    await wrapper.find('[aria-label="类型筛选"]').setValue('income')

    // 新请求已发出：此时列表已被清空（骨架态），而不是留着旧结果
    expect(h.listPage).toHaveBeenCalledTimes(2)
    const query = h.listPage.mock.calls[1][0] as Record<string, unknown>
    expect(query.cursor).toBeUndefined()
    expect(query.kind).toBe('income')
    expect(wrapper.findAll('.search__row')).toHaveLength(0)

    pending.resolve(page([9], { total: 1, has_more: false }))
    await flushPromises()
    expect(wrapper.findAll('.search__row')).toHaveLength(1)
  })

  it('乱序响应丢弃：慢的先发后到，不得覆盖后发的快响应', async () => {
    const slow = deferred<TransactionListPage>()
    const fast = deferred<TransactionListPage>()
    const wrapper = mountView() // 挂载即发第 1 笔（slow 之前还有一次，用假的挂载响应吃掉）
    await flushPromises()

    h.listPage.mockImplementationOnce(() => slow.promise)
    h.listPage.mockImplementationOnce(() => fast.promise)

    // 两次筛选变化 → 两笔请求（A=slow、B=fast）
    await wrapper.find('[aria-label="类型筛选"]').setValue('expense')
    await wrapper.find('[aria-label="类型筛选"]').setValue('income')

    fast.resolve(pageWithSummary([22], 1, [{ commodity: 'CNY', income: '0.00', expense: '1.00' }], { has_more: false }))
    await flushPromises()
    expect(wrapper.findAll('.search__row')).toHaveLength(1)

    // 慢的 A（expense）现在才回来：必须被代际丢弃
    slow.resolve(pageWithSummary([11, 12], 2, [{ commodity: 'CNY', income: '0.00', expense: '2.00' }], { has_more: false }))
    await flushPromises()
    expect(wrapper.findAll('.search__row')).toHaveLength(1)
    expect(wrapper.find('.search__summary-total').text()).toBe('共 1 笔')
  })
})

describe('SearchView：CSV 与空态出口', () => {
  it('CSV 导出用 limit: 0 二次拉全量（不复用分页状态）', async () => {
    h.listPage.mockResolvedValueOnce(page([1], { total: 1, has_more: false }))
    const wrapper = mountView()
    await flushPromises()

    h.listPage.mockResolvedValueOnce(page([1, 2, 3], { total: 3 }))
    await wrapper.find('.search__export').trigger('click')
    await flushPromises()

    const exportQuery = h.listPage.mock.calls[1][0] as Record<string, unknown>
    expect(exportQuery.limit).toBe(0)
    // 导出不应带分页游标
    expect(exportQuery.cursor).toBeUndefined()
    expect(h.downloadCsv).toHaveBeenCalledTimes(1)
  })

  it('空态时搜索卡仍在页面上（空态不能让人失去出口）', async () => {
    h.listPage.mockResolvedValue(page([], { total: 0, has_more: false }))
    const wrapper = mountView()
    await flushPromises()

    // 空态卡出现
    expect(wrapper.text()).toContain('暂无数据')
    // 但搜索框与「更多筛选」仍可用
    expect(wrapper.find('.search-bar__input').exists()).toBe(true)
    expect(wrapper.find('.search-bar__toggle').exists()).toBe(true)
  })

  it('请求失败 → error 态，且搜索卡仍在（可改条件自救）', async () => {
    h.listPage.mockRejectedValue(new Error('服务暂时不可用'))
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('加载失败')
    expect(wrapper.find('.search-bar__input').exists()).toBe(true)
  })

  it('关键词提交后同步 URL（用 filtersToQuery，不是服务端参数）', async () => {
    h.listPage.mockResolvedValue(page([1], { total: 1, has_more: false }))
    const wrapper = mountView()
    await flushPromises()

    await wrapper.find('.search-bar__input').setValue('火锅')
    await wrapper.find('.search-bar__submit').trigger('click')
    await flushPromises()

    expect(h.replace).toHaveBeenCalled()
    const payload = h.replace.mock.calls[h.replace.mock.calls.length - 1][0] as {
      query: Record<string, string>
    }
    expect(payload.query.q).toBe('火锅')
    // 服务端参数白名单里的 limit 不应出现在 URL 里
    expect(payload.query.limit).toBeUndefined()
  })
})

describe('关键词端到端（T38 从旧流水页迁移）', () => {
  const KEYWORD_TXNS: TransactionView[] = [
    {
      id: 1,
      uuid: 't1',
      date: '2026-11-09',
      flag: '*',
      description: '午餐',
      created_by_name: '阿文',
      postings: [
        { account_id: 2, account: 'Expenses:Food', commodity: 'CNY', amount: '38.50' },
        { account_id: 1, account: 'Assets:Bank', commodity: 'CNY', amount: '-38.50' },
      ],
    },
    {
      id: 2,
      uuid: 't2',
      date: '2026-11-01',
      flag: '*',
      description: '十月工资',
      created_by_name: '太太',
      postings: [
        { account_id: 3, account: 'Income:Salary', commodity: 'CNY', amount: '-9500.00' },
        { account_id: 1, account: 'Assets:Bank', commodity: 'CNY', amount: '9500.00' },
      ],
    },
    {
      id: 3,
      uuid: 't3',
      date: '2026-11-05',
      flag: '*',
      description: '搬钱',
      created_by_name: '阿文',
      postings: [
        { account_id: 1, account: 'Assets:Bank', commodity: 'CNY', amount: '-2000.00' },
        { account_id: 1, account: 'Assets:Bank', commodity: 'CNY', amount: '2000.00' },
      ],
    },
  ]

  /** 服务端按 `q` 过滤（模拟真实后端行为）。 */
  function serverFiltered(query: Record<string, unknown>): TransactionListPage {
    const q = typeof query.q === 'string' ? query.q : ''
    const rows =
      q === ''
        ? KEYWORD_TXNS
        : KEYWORD_TXNS.filter((txn) => txn.description.indexOf(q) >= 0)
    return { transactions: rows, total: rows.length, has_more: false }
  }

  it('URL 带 ?q=午餐 → 请求参数带 q，且渲染行数真的减少（URL→筛选→请求→渲染 四跳）', async () => {
    h.route.query = { q: '午餐' }
    h.listPage.mockImplementation((query: Record<string, unknown>) =>
      Promise.resolve(serverFiltered(query)),
    )

    const wrapper = mountView()
    await flushPromises()

    // ① 请求真的带上了关键词
    const query = h.listPage.mock.calls[0][0] as Record<string, unknown>
    expect(query.q).toBe('午餐')
    // ② 渲染行数随之减少（3 → 1），而不是「请求发了但界面没变」
    expect(wrapper.findAll('.search__row')).toHaveLength(1)
    expect(wrapper.text()).toContain('午餐')
  })

  it('无 q 时渲染全部 3 行（对照）', async () => {
    h.route.query = {}
    h.listPage.mockImplementation((query: Record<string, unknown>) =>
      Promise.resolve(serverFiltered(query)),
    )
    const wrapper = mountView()
    await flushPromises()
    expect((h.listPage.mock.calls[0][0] as Record<string, unknown>).q).toBeUndefined()
    expect(wrapper.findAll('.search__row')).toHaveLength(3)
  })

  it('?q=绝不存在的词 → 请求带上该词、0 行、显示空态文案（不是空白页）', async () => {
    h.route.query = { q: '绝不存在的词' }
    h.listPage.mockImplementation((query: Record<string, unknown>) =>
      Promise.resolve(serverFiltered(query)),
    )
    const wrapper = mountView()
    await flushPromises()

    expect((h.listPage.mock.calls[0][0] as Record<string, unknown>).q).toBe('绝不存在的词')
    expect(wrapper.findAll('.search__row')).toHaveLength(0)
    expect(wrapper.text()).toContain('暂无数据')
  })
})

describe('SearchView：汇总卡（T36）', () => {
  it('summary 缺失 → 整块不渲染（不显示「共 0 笔」）', async () => {
    h.listPage.mockResolvedValue(page([1, 2], { has_more: false }))
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.find('.search__summary').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('共 0 笔')
  })

  it('多币种按行展示，各自带币种 chip，且不做跨币种合计', async () => {
    h.listPage.mockResolvedValue(
      pageWithSummary([1, 2], 2, [
        { commodity: 'CNY', income: '5000.00', expense: '3200.00' },
        { commodity: 'USD', income: '120.00', expense: '30.00' },
      ]),
    )
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.find('.search__summary-total').text()).toBe('共 2 笔')
    const rows = wrapper.findAll('.search__summary-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].find('.search__summary-chip').text()).toBe('CNY')
    expect(rows[1].find('.search__summary-chip').text()).toBe('USD')
    // 定点串直显（不 parseFloat 再格式化）：$120.00 / $30.00 原样出现
    expect(rows[1].text()).toContain('$ 120.00')
    expect(rows[1].text()).toContain('$ 30.00')
    // 绝不出现跨币种求和（5000+120 之类）
    expect(wrapper.text()).not.toContain('5,120')
  })

  it('隐私遮挡：金额被遮，但「共 N 笔」不遮（笔数不是金额）', async () => {
    h.listPage.mockResolvedValue(
      pageWithSummary([1], 1, [{ commodity: 'CNY', income: '5000.00', expense: '3200.00' }]),
    )
    const wrapper = mountView()
    await flushPromises()

    usePrivacyStore(pinia).setEnabled(true)
    await flushPromises()

    expect(wrapper.find('.search__summary').text()).toContain(PRIVACY_MASK)
    expect(wrapper.find('.search__summary').text()).not.toContain('5,000.00')
    // 笔数不被遮
    expect(wrapper.find('.search__summary-total').text()).toBe('共 1 笔')
  })

  it('翻页请求不再带 with=summary（汇总口径与页无关，少一次聚合）', async () => {
    h.listPage.mockResolvedValueOnce(
      pageWithSummary([1], 3, [{ commodity: 'CNY', income: '0.00', expense: '1.00' }], {
        has_more: true,
        next_cursor: 'c1',
      }),
    )
    const wrapper = mountView()
    await flushPromises()

    h.listPage.mockResolvedValueOnce(page([2, 3], { has_more: false }))
    await wrapper.find('.search__more-btn').trigger('click')
    await flushPromises()

    const moreQuery = h.listPage.mock.calls[1][0] as Record<string, unknown>
    expect(moreQuery.with).toBeUndefined()
    expect(moreQuery.cursor).toBe('c1')
    // 汇总仍是首屏那份，不因翻页而改变
    expect(wrapper.find('.search__summary-total').text()).toBe('共 3 笔')
  })
})

describe('SearchView：移动端返回条', () => {
  it('渲染返回条并回账单页（用 push 而不是 history.back）', async () => {
    h.listPage.mockResolvedValue(page([], { has_more: false }))
    const wrapper = mountView()
    await flushPromises()

    const back = wrapper.find('.search__back-btn')
    expect(back.exists()).toBe(true)
    expect(back.text()).toContain('返回账单')
    await back.trigger('click')
    expect(h.push).toHaveBeenCalledWith({ name: 'bills' })
  })
})

/**
 * 审计 P1：chips 是给人看的，**不能显示裸 id**。
 *
 * 这组用例存在的理由：`filters.account` 只存 id 是**对的**（URL 只该有 id），
 * 但渲染层偷懒拼 ``账户 id：3`` 时没有任何测试会红 —— 功能全对、文案不可读。
 */
describe('SearchView：已选条件 chips 显示名称（P1）', () => {
  function seedAccounts(): void {
    const data = useLedgerDataStore()
    data.accounts = [
      {
        id: 3,
        uuid: 'acc-3',
        name: 'Assets:Bank:CMB',
        display_name: '招商银行卡',
        type: 'Assets',
        open_date: '2020-01-01',
        sort_order: 1,
      },
      {
        id: 7,
        uuid: 'acc-7',
        name: 'Expenses:Food:Coffee',
        type: 'Expenses',
        open_date: '2020-01-01',
        sort_order: 2,
      },
    ]
  }

  it('账户显示 display_name，分类回落 account.name', async () => {
    seedAccounts()
    h.route.query = { account: '3', category: '7' }
    h.listPage.mockResolvedValue(page([1]))
    const wrapper = mountView()
    await flushPromises()

    const chips = wrapper.findAll('.search-bar__chip').map((chip) => chip.text())
    expect(chips.some((text) => text.includes('账户：招商银行卡'))).toBe(true)
    expect(chips.some((text) => text.includes('分类：Expenses:Food:Coffee'))).toBe(true)
    // 反向断言：任何 chip 都不该出现「id：」
    expect(chips.some((text) => text.includes('id：'))).toBe(false)
  })

  it('账户已不在列表里（已删除）时保留 id 并标注，不留空', async () => {
    seedAccounts()
    h.route.query = { account: '99' }
    h.listPage.mockResolvedValue(page([1]))
    const wrapper = mountView()
    await flushPromises()

    const chips = wrapper.findAll('.search-bar__chip').map((chip) => chip.text())
    expect(chips.some((text) => text.includes('账户：#99（已删除）'))).toBe(true)
  })
})

/**
 * 批 I 两段加载：筛选项区域（标签 / 成员）守 `fullReady`。
 *
 * 标签 / 成员全集来自 `data.txns` 全量快照；补齐完成前只有「已拉窗口」的月份，
 * 拿半集当全集会让用户以为「没有别的标签可选」。补齐中先给基础项（空选项），
 * 补齐完成后恢复现行全集。执行与 CSV 不受影响（走服务端 listPage，不依赖本地快照）。
 */
describe('SearchView：筛选项守 fullReady（批 I 两段加载）', () => {
  function seedTxns(): void {
    const seeded: TransactionView[] = [
      {
        id: 1,
        uuid: 'txn-1',
        date: '2026-11-16',
        flag: '*',
        description: '午餐',
        created_by_name: '阿文',
        tags: ['家庭'],
        postings: [{ account_id: 2, account: 'Expenses:Food', commodity: 'CNY', amount: '10.00' }],
      },
    ]
    const data = useLedgerDataStore()
    data.txns = seeded
  }

  it('补齐中（fullReady=false）标签/成员下拉不给半集', async () => {
    seedTxns()
    const data = useLedgerDataStore()
    data.fullReady = false
    const wrapper = mountView()
    await flushPromises()

    const filters = wrapper.findComponent(SearchFilters)
    expect(filters.exists()).toBe(true)
    expect(filters.props('tags')).toEqual([])
    expect(filters.props('members')).toEqual([])
  })

  it('补齐完成（fullReady=true）恢复标签/成员全集', async () => {
    seedTxns()
    const data = useLedgerDataStore()
    data.fullReady = true
    const wrapper = mountView()
    await flushPromises()

    const filters = wrapper.findComponent(SearchFilters)
    expect(filters.exists()).toBe(true)
    expect(filters.props('tags')).toEqual(['家庭'])
    expect(filters.props('members')).toEqual(['阿文'])
  })
})
