/**
 * ledgerData 两段加载（批 I）回归
 *
 * 首屏两段加载把一次 `ensure()` 拆成「窗口段 + 补齐段」，本文件钉住八条契约：
 * 1. **首段先行**：窗口请求（listPage）先发出，全量请求（list）在补齐段才发；
 * 2. **窗口参数**：from=当月 1 日 / to=当月末 / **不传 limit**（`limit` 缺省 =
 *    条件命中全量是冻结契约，窗口段靠 from/to 限定范围，绝不显式截断）；
 * 3. **补齐成功**：整体替换 txns 且 `fullReady=true`；
 * 4. **补齐失败静默**：fullReady 保持 false、`error` 不被污染、不 throw；
 * 5. **epoch 竞态三例**：窗口段在途切账本丢弃 / 补齐段在途 reload 丢弃 /
 *    setTimeout 回调过期不发请求（回调发请求前先验 epoch）；
 * 6. **reset 复位**：两段状态与窗口集合全部清空；
 * 7. **按月前缀替换**：他月行保留、窗口月旧行消失、新行并入；
 * 8. **fullReady 后 setWindowMonth 零请求**（缓存命中 noop）。
 *
 * 兼容性说明：jsdom / Node 均无 `requestIdleCallback`，store 走 `setTimeout(0)`
 * 兜底——测试因此必须等一轮**宏任务**才能看到补齐段落地（`settleBoth`）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

import { useLedgerDataStore } from '@/stores/ledgerData'
import { useSessionStore } from '@/stores/session'
import type {
  AccountListResponse,
  AccountView,
  TransactionListPage,
  TransactionListResponse,
  TransactionView,
} from '@/api/types'

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

function makeAccount(id: number): AccountView {
  return {
    id,
    name: `Assets:A${id}`,
    uuid: `uuid-${id}`,
    type: 'Assets',
    open_date: '2026-01-01',
    sort_order: id,
  }
}

function makeTxn(id: number, date: string, commodity = 'CNY'): TransactionView {
  return {
    id,
    uuid: `txn-${id}`,
    date,
    flag: '*',
    description: `交易${id}`,
    created_by_name: '阿文',
    postings: [{ account_id: 1, account: 'Assets:A1', commodity, amount: '1.00' }],
  }
}

function accountRes(accounts: AccountView[]): AccountListResponse {
  return { accounts }
}

function txnRes(transactions: TransactionView[]): TransactionListResponse {
  return { transactions }
}

function txnPage(transactions: TransactionView[]): TransactionListPage {
  return { transactions }
}

/** 手动可控的 Promise，用于构造「旧代响应晚到」的竞态。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveFn: (value: T) => void = () => undefined
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve
  })
  return { promise, resolve: resolveFn }
}

/** 让 pre-flush watch 与 Promise 链跑完（既有 ledgerData 测试同款节奏）。 */
async function settle(): Promise<void> {
  await nextTick()
  await Promise.resolve()
  await nextTick()
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

/**
 * 等两段都落地：在 settle 之上再加一轮宏任务——补齐段走 `setTimeout(0)` 兜底
 * （requestIdleCallback 在 Node / iOS 14.8 均缺席），须等它触发并收尾微任务。
 */
async function settleBoth(): Promise<void> {
  await settle()
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
  await Promise.resolve()
}

/**
 * 排空上一用例遗留的补齐段定时器：定时器回调带 epoch 守卫，但**必须排在
 * mockReset 之前**执行——旧 mock 仍有可解析的返回值，落地无副作用；
 * 若排在 reset 之后，遗留回调会拿到 undefined 响应（虽有防御性解析兜底，
 * 但会让「新用例的调用计数」被旧 store 的请求污染）。
 */
async function drainTimers(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
  await Promise.resolve()
}

/** 设备本地自然当月前缀（与 store 内部同口径，跨月跑测试也稳）。 */
function currentMonthPrefix(): string {
  const now = new Date()
  const month = now.getMonth() + 1
  return `${now.getFullYear()}-${month < 10 ? `0${month}` : String(month)}`
}

/** 当月某日（1-9 补零），供构造「落进当月窗口」的交易日期。 */
function dayInCurrentMonth(day: number): string {
  const prefix = currentMonthPrefix()
  return `${prefix}-${day < 10 ? `0${day}` : String(day)}`
}

beforeEach(async () => {
  await drainTimers()
  setActivePinia(createPinia())
  for (const fn of Object.values(h)) {
    fn.mockReset()
  }
  h.accountList.mockResolvedValue(accountRes([makeAccount(1)]))
  h.txnList.mockResolvedValue(txnRes([]))
  h.txnListPage.mockResolvedValue(txnPage([]))
})

describe('ledgerData 两段加载：首段（窗口段）先行', () => {
  it('首段先行：窗口请求先发出，全量请求在补齐段才发', async () => {
    const order: string[] = []
    h.txnListPage.mockImplementation(() => {
      order.push('window')
      return Promise.resolve(txnPage([]))
    })
    h.txnList.mockImplementation(() => {
      order.push('full')
      return Promise.resolve(txnRes([]))
    })

    const session = useSessionStore()
    session.ledgerId = 1
    const data = useLedgerDataStore()
    await data.ensure()

    // ensure() 只等首段：此刻补齐段尚未发请求，页面已可渲染当月窗口
    expect(order).toEqual(['window'])
    expect(h.txnListPage).toHaveBeenCalledTimes(1)
    expect(h.txnList).not.toHaveBeenCalled()
    expect(data.loaded).toBe(true)
    expect(data.fullReady).toBe(false)

    await settleBoth()
    expect(order).toEqual(['window', 'full'])
    expect(data.fullReady).toBe(true)
    expect(data.loading).toBe(false)
  })

  it('首段窗口参数：from=当月1日、to=当月末、不传 limit（冻结契约）', async () => {
    const session = useSessionStore()
    session.ledgerId = 1
    const data = useLedgerDataStore()
    await data.ensure()
    await settleBoth()

    expect(h.txnListPage).toHaveBeenCalledTimes(1)
    const query = h.txnListPage.mock.calls[0][0] as Record<string, unknown>
    const prefix = currentMonthPrefix()
    const lastDay = new Date(Number(prefix.slice(0, 4)), Number(prefix.slice(5, 7)), 0).getDate()
    expect(query.from).toBe(`${prefix}-01`)
    expect(query.to).toBe(`${prefix}-${lastDay < 10 ? `0${lastDay}` : String(lastDay)}`)
    // limit 缺省 = 全量：窗口段绝不显式传 limit / cursor（防静默截断）
    expect(query.limit).toBeUndefined()
    expect(query.cursor).toBeUndefined()
    // 全量端点零参签名不动：list() 依旧零参调用
    expect(h.txnList.mock.calls[0]).toEqual([])
  })

  it('挂载序（BillsView 流程）：先声明关注月再 ensure，窗口腿单飞共享只发一次', async () => {
    const session = useSessionStore()
    session.ledgerId = 1
    const data = useLedgerDataStore()
    // 与 BillsView onMounted 相同的调用形态：不 await，同步连发。
    // setWindowMonth 先注册单飞任务，ensure() 的首段窗口腿共享它，
    // 不产生「当月窗口拉两遍」。
    void data.setWindowMonth(currentMonthPrefix())
    void data.ensure()
    await settleBoth()

    expect(h.txnListPage).toHaveBeenCalledTimes(1)
    expect(h.accountList).toHaveBeenCalledTimes(1)
    expect(h.txnList).toHaveBeenCalledTimes(1)
    expect(data.loaded).toBe(true)
    expect(data.fullReady).toBe(true)
    expect(data.hasMonthWindow(currentMonthPrefix())).toBe(true)
  })
})

describe('ledgerData 两段加载：补齐段', () => {
  it('补齐成功：整体替换 txns 且 fullReady=true，首段窗口行被全量行覆盖', async () => {
    h.txnListPage.mockResolvedValue(txnPage([makeTxn(1, dayInCurrentMonth(3))]))
    h.txnList.mockResolvedValue(
      txnRes([makeTxn(1, dayInCurrentMonth(3)), makeTxn(2, '2026-10-05')]),
    )

    const session = useSessionStore()
    session.ledgerId = 1
    const data = useLedgerDataStore()
    await data.ensure()
    // 首段只有当月窗口
    expect(data.txns).toHaveLength(1)
    await settleBoth()
    // 补齐后是全量（10 月行出现）
    expect(data.txns).toHaveLength(2)
    expect(data.txns.map((txn) => txn.id)).toEqual([1, 2])
    expect(data.fullReady).toBe(true)
  })

  it('补齐失败静默：fullReady 保持 false、error 不被污染、ensure 不 throw', async () => {
    h.txnList.mockRejectedValueOnce(new TypeError('fetch failed'))

    const session = useSessionStore()
    session.ledgerId = 1
    const data = useLedgerDataStore()
    // 首段成功：ensure 不 throw
    await expect(data.ensure()).resolves.toBeUndefined()
    // 补齐段失败：静默，不写 error、不弹 UI
    await settleBoth()

    expect(data.loaded).toBe(true)
    expect(data.fullReady).toBe(false)
    expect(data.error).toBe('')
  })

  it('ensure 并发单飞仍成立：窗口腿共享，两段各自只发一次', async () => {
    const session = useSessionStore()
    session.ledgerId = 1
    const data = useLedgerDataStore()
    const first = data.ensure()
    const second = data.ensure()
    await Promise.all([first, second])
    await settleBoth()

    expect(h.accountList).toHaveBeenCalledTimes(1)
    expect(h.txnListPage).toHaveBeenCalledTimes(1)
    expect(h.txnList).toHaveBeenCalledTimes(1)
    expect(data.fullReady).toBe(true)
  })
})

describe('ledgerData 两段加载：epoch 竞态', () => {
  it('窗口段在途切账本：旧窗口响应被丢弃，不污染新账本快照', async () => {
    const slowWindow = deferred<TransactionListPage>()
    h.txnListPage.mockReturnValueOnce(slowWindow.promise)

    const session = useSessionStore()
    session.ledgerId = 1
    const data = useLedgerDataStore()
    const slow = data.ensure() // 账本 1 的首段卡在窗口腿

    // 切到账本 2：首段直接成功、补齐段落地
    h.accountList.mockResolvedValue(accountRes([makeAccount(2)]))
    session.ledgerId = 2
    await settleBoth()

    expect(data.loaded).toBe(true)
    expect(data.fullReady).toBe(true)
    expect(data.txns).toEqual([])

    // 账本 1 的慢窗口此刻才回来：必须被 epoch 丢弃
    slowWindow.resolve(txnPage([makeTxn(1, '2026-11-01')]))
    await slow
    await settle()

    expect(data.txns).toEqual([])
    expect(data.accounts.map((account) => account.id)).toEqual([2])
  })

  it('补齐段在途 reload：旧全量响应被丢弃，落地的是新代全量', async () => {
    const slowFull = deferred<TransactionListResponse>()
    h.txnList.mockReturnValueOnce(slowFull.promise)

    const session = useSessionStore()
    session.ledgerId = 1
    const data = useLedgerDataStore()
    await data.ensure() // 首段成功，补齐段已调度
    await settle() // 补齐段定时器触发，卡在慢响应
    expect(h.txnList).toHaveBeenCalledTimes(1)

    // reload：epoch+1，两段照跑
    h.txnList.mockResolvedValue(txnRes([makeTxn(9, dayInCurrentMonth(8))]))
    const refreshing = data.reload()
    // 旧补齐段此刻才回来：必须被丢弃
    slowFull.resolve(txnRes([makeTxn(7, dayInCurrentMonth(1))]))
    await refreshing
    await settleBoth()

    expect(data.fullReady).toBe(true)
    expect(data.txns.map((txn) => txn.id)).toEqual([9])
  })

  it('setTimeout 回调过期时不发全量请求（回调发请求前先验 epoch）', async () => {
    const session = useSessionStore()
    session.ledgerId = 1
    const data = useLedgerDataStore()
    await data.ensure() // 补齐段定时器已调度
    data.reset() // epoch+1：定时器回调将过期
    await settleBoth()

    // 回调先验 epoch：过期即返回，全量请求一次都不发
    expect(h.txnList).not.toHaveBeenCalled()
    expect(data.loaded).toBe(false)
    expect(data.fullReady).toBe(false)
    expect(data.txns).toEqual([])
  })
})

describe('ledgerData 两段加载：窗口合并与缓存', () => {
  it('按月前缀替换：他月行保留、窗口月旧行消失、新行并入', async () => {
    const session = useSessionStore()
    session.ledgerId = 1
    const data = useLedgerDataStore()
    // 种一份「历史快照」：9 月两行、10 月旧行（含待被窗口替换的 id 999 / 旧 id 3）
    data.txns = [
      makeTxn(1, '2026-09-05'),
      makeTxn(2, '2026-09-20'),
      makeTxn(999, '2026-10-01'),
      makeTxn(3, '2026-10-20'),
    ]
    data.fullReady = false
    // 10 月未拉过窗口 → setWindowMonth 发窗口请求，只回新行 id 888
    h.txnListPage.mockImplementation((query: { from?: string }) =>
      Promise.resolve(
        txnPage(query.from === '2026-10-01' ? [makeTxn(888, '2026-10-15')] : []),
      ),
    )

    await data.setWindowMonth('2026-10')

    // 999 / 旧 3 被该月窗口整体替换，9 月行保留
    expect(data.txns.map((txn) => txn.id)).toEqual([1, 2, 888])
    expect(data.hasMonthWindow('2026-10')).toBe(true)
    expect(data.hasMonthWindow('2026-09')).toBe(false)
  })

  it('fullReady 后 setWindowMonth 零请求（缓存命中 noop）', async () => {
    const session = useSessionStore()
    session.ledgerId = 1
    const data = useLedgerDataStore()
    await data.ensure()
    await settleBoth()
    expect(data.fullReady).toBe(true)
    const callsBefore = h.txnListPage.mock.calls.length

    await data.setWindowMonth('2025-01')

    // mock 计数=0 增量：全量态下任何月份都已覆盖，声明关注月不发请求
    expect(h.txnListPage.mock.calls.length).toBe(callsBefore)
    expect(h.txnList).toHaveBeenCalledTimes(1)
  })

  it('setWindowMonth 单飞：同月并发只发一次窗口请求', async () => {
    const session = useSessionStore()
    session.ledgerId = 1
    const data = useLedgerDataStore()
    await Promise.all([data.setWindowMonth('2026-10'), data.setWindowMonth('2026-10')])

    expect(h.txnListPage).toHaveBeenCalledTimes(1)
    expect(h.txnListPage.mock.calls[0][0]).toEqual({ from: '2026-10-01', to: '2026-10-31' })
  })

  it('hasMonthWindow：首段落地后当月为 true、他月 false；补齐前声明他月会拉该月窗口', async () => {
    h.txnListPage.mockImplementation((query: { from?: string }) =>
      Promise.resolve(
        txnPage(query.from === '2026-10-01' ? [makeTxn(5, '2026-10-12')] : []),
      ),
    )
    const session = useSessionStore()
    session.ledgerId = 1
    const data = useLedgerDataStore()
    await data.ensure() // 首段：当月窗口落地（空窗口也算「已拉」）

    expect(data.loaded).toBe(true)
    expect(data.hasMonthWindow(currentMonthPrefix())).toBe(true)
    expect(data.hasMonthWindow('2026-10')).toBe(false)

    await data.setWindowMonth('2026-10')
    expect(data.hasMonthWindow('2026-10')).toBe(true)
    expect(data.txns.map((txn) => txn.id)).toEqual([5])
  })

  it('reset() 复位两段状态：fullReady=false、数据清空、窗口集合清空', async () => {
    h.txnListPage.mockResolvedValue(txnPage([makeTxn(1, dayInCurrentMonth(3))]))
    h.txnList.mockResolvedValue(txnRes([makeTxn(1, dayInCurrentMonth(3))]))

    const session = useSessionStore()
    session.ledgerId = 1
    const data = useLedgerDataStore()
    await data.ensure()
    await settleBoth()
    expect(data.fullReady).toBe(true)
    expect(data.hasMonthWindow(currentMonthPrefix())).toBe(true)

    data.reset()

    expect(data.accounts).toEqual([])
    expect(data.txns).toEqual([])
    expect(data.loaded).toBe(false)
    expect(data.fullReady).toBe(false)
    expect(data.hasMonthWindow(currentMonthPrefix())).toBe(false)
  })

  it('reload 不清 fullReady：全量态首段按月替换、其余月份行保留，补齐段整体回写', async () => {
    h.txnListPage.mockResolvedValue(txnPage([makeTxn(11, '2026-11-02')]))
    h.txnList.mockResolvedValue(
      txnRes([makeTxn(1, '2026-10-05'), makeTxn(11, '2026-11-02')]),
    )

    const session = useSessionStore()
    session.ledgerId = 1
    const data = useLedgerDataStore()
    await data.ensure()
    await settleBoth()
    expect(data.fullReady).toBe(true)
    expect(data.txns).toHaveLength(2)

    // 用户切到 2026-10：全量态下 setWindowMonth 是 noop，只记录关注月
    await data.setWindowMonth('2026-10')
    // reload 首段重拉 2026-10 窗口（该月旧行被替换），补齐段稍后整体回写
    h.txnListPage.mockResolvedValue(txnPage([makeTxn(888, '2026-10-20')]))
    await data.reload()

    // reload 不清除 fullReady：页面继续显示旧快照（SWR），当月窗口先刷新
    expect(data.fullReady).toBe(true)
    expect(data.txns.map((txn) => txn.id)).toEqual([11, 888])
    await settleBoth()

    expect(data.txns).toHaveLength(2)
    expect(data.fullReady).toBe(true)
  })
})
