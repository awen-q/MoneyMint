/**
 * ledgerData store 回归（切换登录 / 账本数据单例）
 *
 * 覆盖四条契约：
 * 1. 并发 `ensure()` 只发一次请求（否则切页会重复拉全量）；
 * 2. 失败**不缓存** Promise —— 一次网络抖动后再次 `ensure()` 必须能重试成功；
 * 3. `resolved` 后 `ensure()` 短路、`reload()` 强制重拉、`reset()` 清空；
 * 4. 切账本时 `reset()` + 重建，且在途的旧账本响应**不得回写**（epoch 守卫）。
 *
 * session store 依赖 `@/api/client`（setLedgerIdProvider / authApi / ledgerApi），
 * 这里整模块 mock，只保留本 store 真正用到的两个 list。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

import { ApiError } from '@/api/errors'
import { useLedgerDataStore } from '@/stores/ledgerData'
import { useSessionStore } from '@/stores/session'
import type {
  AccountListResponse,
  AccountView,
  TransactionListResponse,
  TransactionView,
} from '@/api/types'

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

function makeAccount(id: number, name: string): AccountView {
  return {
    id,
    name,
    uuid: `uuid-${id}`,
    type: 'Assets',
    open_date: '2026-01-01',
    sort_order: id,
  }
}

function makeTxn(id: number): TransactionView {
  return {
    id,
    uuid: `txn-${id}`,
    date: '2026-03-01',
    flag: '*',
    description: `交易${id}`,
    created_by_name: '阿文',
    postings: [{ account_id: 1, account: 'Assets:Bank', commodity: 'CNY', amount: '1.00' }],
  }
}

function accountRes(accounts: AccountView[]): AccountListResponse {
  return { accounts }
}

function txnRes(transactions: TransactionView[]): TransactionListResponse {
  return { transactions }
}

/** 让 Vue 的 pre-flush 调度（watch 回调）与 Promise 链都跑完。 */
async function settle(): Promise<void> {
  await nextTick()
  await Promise.resolve()
  await nextTick()
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

/** 手动可控的 Promise，用于构造「旧账本响应晚到」的竞态。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveFn: (value: T) => void = () => undefined
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve
  })
  return { promise, resolve: resolveFn }
}

beforeEach(() => {
  setActivePinia(createPinia())
  h.accountList.mockReset()
  h.txnList.mockReset()
  h.me.mockReset()
  h.ledgerList.mockReset()
  h.login.mockReset()
  h.logout.mockReset()
  h.changePassword.mockReset()
  h.setLedgerIdProvider.mockReset()
  h.txnList.mockResolvedValue(txnRes([]))
})

describe('ledgerData：单例全量快照', () => {
  it('并发 ensure() 只发一次请求，三个调用方拿到同一份数据', async () => {
    h.accountList.mockResolvedValue(accountRes([makeAccount(1, 'Assets:Bank')]))
    h.txnList.mockResolvedValue(txnRes([makeTxn(7)]))

    const session = useSessionStore()
    session.ledgerId = 1
    const data = useLedgerDataStore()

    expect(data.loaded).toBe(false)
    const first = data.ensure()
    expect(data.loading).toBe(true)
    // Pinia 的 action 包装会给每个调用返回 derived promise，故不比较 Promise 身份，
    // 只断言「三次调用只发一次请求」这一真正契约。
    const second = data.ensure()
    const third = data.ensure()

    await Promise.all([first, second, third])

    expect(h.accountList).toHaveBeenCalledTimes(1)
    expect(h.txnList).toHaveBeenCalledTimes(1)
    expect(data.loaded).toBe(true)
    expect(data.loading).toBe(false)
    expect(data.error).toBe('')
    expect(data.accounts).toHaveLength(1)
    expect(data.txns).toHaveLength(1)
    expect(data.txns[0].id).toBe(7)
  })

  it('已加载后 ensure() 短路，不再发请求；reload() 强制重拉', async () => {
    h.accountList.mockResolvedValue(accountRes([makeAccount(1, 'Assets:Bank')]))
    h.txnList.mockResolvedValue(txnRes([]))

    const session = useSessionStore()
    session.ledgerId = 1
    const data = useLedgerDataStore()
    await data.ensure()
    expect(h.accountList).toHaveBeenCalledTimes(1)

    await data.ensure()
    expect(h.accountList).toHaveBeenCalledTimes(1)

    h.accountList.mockResolvedValue(
      accountRes([makeAccount(1, 'Assets:Bank'), makeAccount(2, 'Assets:Cash')]),
    )
    await data.reload()
    expect(h.accountList).toHaveBeenCalledTimes(2)
    expect(data.accounts).toHaveLength(2)
    expect(data.loaded).toBe(true)
  })

  it('reload() 期间 loaded 保持 true：页面继续显示旧快照，不整页闪骨架', async () => {
    h.accountList.mockResolvedValue(accountRes([makeAccount(1, 'Assets:Bank')]))
    h.txnList.mockResolvedValue(txnRes([]))

    const session = useSessionStore()
    session.ledgerId = 1
    const data = useLedgerDataStore()
    await data.ensure()
    expect(data.loaded).toBe(true)

    const slowAccount = deferred<AccountListResponse>()
    const slowTxn = deferred<TransactionListResponse>()
    h.accountList.mockReturnValueOnce(slowAccount.promise)
    h.txnList.mockReturnValueOnce(slowTxn.promise)

    const refreshing = data.reload()
    // 刷新中：loading 为真但 loaded 不变、旧数据仍在（StateCard 的
    // `loading && !loaded` 因此不会误判为首次加载）。
    expect(data.loading).toBe(true)
    expect(data.loaded).toBe(true)
    expect(data.accounts).toHaveLength(1)

    slowAccount.resolve(accountRes([makeAccount(1, 'Assets:Bank'), makeAccount(2, 'Assets:Cash')]))
    slowTxn.resolve(txnRes([]))
    await refreshing

    expect(data.loading).toBe(false)
    expect(data.loaded).toBe(true)
    expect(data.accounts).toHaveLength(2)
  })

  it('失败只写 error 不抛错，且不缓存失败 Promise —— 再 ensure() 能重试成功', async () => {
    h.accountList.mockRejectedValueOnce(new ApiError(500, '服务暂时不可用'))
    h.txnList.mockResolvedValue(txnRes([]))

    const session = useSessionStore()
    session.ledgerId = 1
    const data = useLedgerDataStore()

    // 不 reject：组件只看 error。
    await expect(data.ensure()).resolves.toBeUndefined()
    expect(data.error).toBe('服务暂时不可用')
    expect(data.loaded).toBe(false)
    expect(data.loading).toBe(false)
    expect(data.accounts).toEqual([])

    // 第二次必须重新发请求（失败的 Promise 已清空 pending）。
    h.accountList.mockResolvedValue(accountRes([makeAccount(1, 'Assets:Bank')]))
    await data.ensure()
    expect(h.accountList).toHaveBeenCalledTimes(2)
    expect(data.error).toBe('')
    expect(data.loaded).toBe(true)
    expect(data.accounts).toHaveLength(1)
  })

  it('非 ApiError 异常回退中文兜底文案（不把英文异常甩给用户）', async () => {
    h.accountList.mockRejectedValue(new TypeError('fetch failed'))
    h.txnList.mockResolvedValue(txnRes([]))

    const session = useSessionStore()
    session.ledgerId = 1
    const data = useLedgerDataStore()
    await data.ensure()

    expect(data.error).toBe('账本数据加载失败，请重试')
    expect(data.loaded).toBe(false)
  })

  it('未选择账本时不发请求，error 提示「尚未选择账本」', async () => {
    const session = useSessionStore()
    expect(session.ledgerId).toBeNull()
    const data = useLedgerDataStore()

    await data.ensure()

    expect(h.accountList).not.toHaveBeenCalled()
    expect(h.txnList).not.toHaveBeenCalled()
    expect(data.error).toBe('尚未选择账本')
    expect(data.loaded).toBe(false)
    expect(data.loading).toBe(false)
  })

  it('刷新失败时旧快照必须保留：error 非空 + loaded 仍 true + 数据不丢', async () => {
    h.accountList.mockResolvedValue(accountRes([makeAccount(1, 'Assets:Bank')]))
    h.txnList.mockResolvedValue(txnRes([makeTxn(7)]))

    const session = useSessionStore()
    session.ledgerId = 1
    const data = useLedgerDataStore()
    await data.ensure()

    h.accountList.mockRejectedValueOnce(new ApiError(503, '服务暂时不可用'))
    await data.reload()

    // 关键契约（页面 cardState 依赖）：有过成功快照 → loaded 不复位，旧数据仍在。
    // 页面据此把「有快照 + 刷新失败」渲染成 ready + 内联提示条，而不是整页错误。
    expect(data.error).toBe('服务暂时不可用')
    expect(data.loaded).toBe(true)
    expect(data.accounts).toHaveLength(1)
    expect(data.txns).toHaveLength(1)
    expect(data.loading).toBe(false)

    // 重试成功后 error 立即清空（runLoad 开头就清，提示条不会残留）。
    h.accountList.mockResolvedValue(
      accountRes([makeAccount(1, 'Assets:Bank'), makeAccount(2, 'Assets:Cash')]),
    )
    await data.reload()
    expect(data.error).toBe('')
    expect(data.loaded).toBe(true)
    expect(data.accounts).toHaveLength(2)
  })

  it('reset() 清空 accounts / txns / error / loaded', async () => {
    h.accountList.mockResolvedValue(accountRes([makeAccount(1, 'Assets:Bank')]))
    h.txnList.mockResolvedValue(txnRes([makeTxn(7)]))

    const session = useSessionStore()
    session.ledgerId = 1
    const data = useLedgerDataStore()
    await data.ensure()
    expect(data.loaded).toBe(true)

    data.reset()

    expect(data.accounts).toEqual([])
    expect(data.txns).toEqual([])
    expect(data.error).toBe('')
    expect(data.loaded).toBe(false)
    expect(data.loading).toBe(false)
  })
})

describe('ledgerData：切账本自动重建', () => {
  it('ledgerId 变化触发 reset + 重新拉取，拿到新账本数据', async () => {
    h.accountList.mockResolvedValue(accountRes([makeAccount(1, '账本一银行')]))
    h.txnList.mockResolvedValue(txnRes([makeTxn(1)]))

    const session = useSessionStore()
    session.ledgerId = 1
    const data = useLedgerDataStore()
    await data.ensure()
    expect(data.accounts[0].name).toBe('账本一银行')

    h.accountList.mockResolvedValue(accountRes([makeAccount(9, '账本二现金')]))
    h.txnList.mockResolvedValue(txnRes([makeTxn(9)]))

    session.ledgerId = 2
    await settle()

    expect(h.accountList).toHaveBeenCalledTimes(2)
    expect(data.loaded).toBe(true)
    expect(data.accounts).toHaveLength(1)
    expect(data.accounts[0].name).toBe('账本二现金')
    expect(data.txns[0].id).toBe(9)
  })

  it('切账本瞬间回到首次加载态（loaded=false + 数据清空），页面的 !loaded→loading 才成立', async () => {
    h.accountList.mockResolvedValue(accountRes([makeAccount(1, '账本一银行')]))
    h.txnList.mockResolvedValue(txnRes([makeTxn(1)]))

    const session = useSessionStore()
    session.ledgerId = 1
    const data = useLedgerDataStore()
    await data.ensure()
    expect(data.loaded).toBe(true)

    // 让新账本的请求停在空中，观察切换瞬间的状态。
    const slowAccount = deferred<AccountListResponse>()
    const slowTxn = deferred<TransactionListResponse>()
    h.accountList.mockReturnValueOnce(slowAccount.promise)
    h.txnList.mockReturnValueOnce(slowTxn.promise)

    session.ledgerId = 2
    await nextTick()

    // 页面判据 `!loaded → 'loading'` 依赖这三条：必须回到首屏态，
    // 不能残留上一个账本的数据（否则切账本会看到旧账本的空态而非骨架屏）。
    expect(data.loaded).toBe(false)
    expect(data.loading).toBe(true)
    expect(data.accounts).toEqual([])
    expect(data.txns).toEqual([])
    expect(data.error).toBe('')

    slowAccount.resolve(accountRes([makeAccount(2, '账本二银行')]))
    slowTxn.resolve(txnRes([makeTxn(2)]))
    await settle()

    expect(data.loaded).toBe(true)
    expect(data.loading).toBe(false)
    expect(data.accounts[0].name).toBe('账本二银行')
  })

  it('切账本后旧账本的在途响应不回写（epoch 守卫）', async () => {
    const slowAccount = deferred<AccountListResponse>()
    const slowTxn = deferred<TransactionListResponse>()
    h.accountList.mockReturnValueOnce(slowAccount.promise)
    h.txnList.mockReturnValueOnce(slowTxn.promise)

    const session = useSessionStore()
    session.ledgerId = 1
    const data = useLedgerDataStore()
    const slow = data.ensure()
    expect(data.loading).toBe(true)

    // 切到账本 2，第二次请求立即返回。
    h.accountList.mockResolvedValue(accountRes([makeAccount(2, '账本二银行')]))
    h.txnList.mockResolvedValue(txnRes([makeTxn(2)]))
    session.ledgerId = 2
    await settle()

    expect(data.accounts[0].name).toBe('账本二银行')
    expect(data.loaded).toBe(true)

    // 账本 1 的慢响应此刻才回来，必须被丢弃。
    slowAccount.resolve(accountRes([makeAccount(1, '账本一银行')]))
    slowTxn.resolve(txnRes([makeTxn(1)]))
    await slow
    await settle()

    expect(data.accounts).toHaveLength(1)
    expect(data.accounts[0].name).toBe('账本二银行')
    expect(data.txns[0].id).toBe(2)
    expect(data.loading).toBe(false)
  })
})
