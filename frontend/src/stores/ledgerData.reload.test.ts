// @vitest-environment jsdom
/**
 * T03 回归：ledgerData 只订阅全局脏标记，复用 reload() 的 SWR / epoch / pending 口径。
 *
 * 三条必须同时成立：
 * 1. 置脏时页面 visible → 立即 reload（前台实时性，不靠切页/聚焦）；
 * 2. 页面 hidden 时置脏 → 不 reload，回前台 checkAndReload() 补偿一次；
 * 3. 即时触发与激活检查由消费水位去重，且刷新期间旧快照不被清空。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

import { checkAndReload, dirtyByLedger, markDirty } from './dataFreshness'
import { useLedgerDataStore } from './ledgerData'
import { useSessionStore } from './session'
import type {
  AccountListResponse,
  AccountView,
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

function account(id: number): AccountView {
  return {
    id,
    name: `Assets:A${id}`,
    type: 'Assets',
    uuid: `a-${id}`,
    open_date: '2026-01-01',
    sort_order: id,
  }
}
function txn(id: number): TransactionView {
  return {
    id,
    uuid: `txn-${id}`,
    date: '2026-11-20',
    flag: '*',
    description: `交易${id}`,
    created_by_name: '阿文',
    postings: [{ account_id: 1, account: 'Assets:A1', commodity: 'CNY', amount: '1.00' }],
  }
}
function accountRes(ids: number[]): AccountListResponse {
  return { accounts: ids.map(account) }
}
function txnRes(ids: number[]): TransactionListResponse {
  return { transactions: ids.map(txn) }
}

async function settle(): Promise<void> {
  await nextTick()
  await Promise.resolve()
  await nextTick()
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

/**
 * 排空上一用例遗留的补齐段定时器（批 I 两段加载）：必须排在 mockReset 之前，
 * 让遗留回调带着旧 mock 的可解析返回值 + epoch 守卫安全落地。
 */
async function drainTimers(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
  await Promise.resolve()
}

let visibility: {
  mockReturnValue(value: DocumentVisibilityState): unknown
  mockRestore(): unknown
} | null = null

beforeEach(async () => {
  await drainTimers()
  setActivePinia(createPinia())
  localStorage.clear()
  h.accountList.mockReset()
  h.txnList.mockReset()
  h.txnListPage.mockReset()
  h.me.mockReset()
  h.ledgerList.mockReset()
  h.setLedgerIdProvider.mockReset()
  h.accountList.mockResolvedValue(accountRes([1]))
  h.txnList.mockResolvedValue(txnRes([1]))
  // 批 I：首段窗口腿默认空窗口
  h.txnListPage.mockResolvedValue({ transactions: [] })
  visibility = vi.spyOn(document, 'visibilityState', 'get')
  visibility.mockReturnValue('visible')
})

afterEach(() => {
  visibility?.mockRestore()
  visibility = null
  vi.unstubAllGlobals()
})

describe('ledgerData：脏标记订阅', () => {
  it('visible 时置脏即时 reload；SWR 不闪骨架、数据换新；激活检查不重复拉', async () => {
    const session = useSessionStore()
    session.ledgerId = 301
    const data = useLedgerDataStore()
    await data.ensure()
    await settle() // 等补齐段落地，快照进入「全量态」再测置脏刷新
    expect(h.accountList).toHaveBeenCalledTimes(1)

    h.accountList.mockResolvedValue(accountRes([1, 2]))
    h.txnList.mockResolvedValue(txnRes([1, 2]))
    markDirty('local-write', 301)
    await settle()

    expect(h.accountList).toHaveBeenCalledTimes(2)
    expect(data.loaded).toBe(true)
    expect(data.accounts).toHaveLength(2)
    expect(data.txns).toHaveLength(2)
    expect(checkAndReload(301)).toBe(false)
    expect(h.accountList).toHaveBeenCalledTimes(2)
  })

  it('hidden 时置脏不拉；回 visible 后 checkAndReload 补一次', async () => {
    const session = useSessionStore()
    session.ledgerId = 302
    const data = useLedgerDataStore()
    await data.ensure()
    await settle() // 等补齐段落地，快照进入「全量态」再测置脏刷新
    expect(h.accountList).toHaveBeenCalledTimes(1)

    visibility?.mockReturnValue('hidden')
    h.accountList.mockResolvedValue(accountRes([1, 2]))
    markDirty('cross-tab', 302)
    await settle()
    expect(h.accountList).toHaveBeenCalledTimes(1)

    visibility?.mockReturnValue('visible')
    expect(checkAndReload(302)).toBe(true)
    await settle()
    expect(h.accountList).toHaveBeenCalledTimes(2)
    expect(data.accounts).toHaveLength(2)
  })

  it('脏标记账本隔离：B 的快照不消费 A 的脏标记', async () => {
    const session = useSessionStore()
    session.ledgerId = 303
    const data = useLedgerDataStore()
    await data.ensure()

    markDirty('local-write', 304)
    await settle()
    expect(h.accountList).toHaveBeenCalledTimes(1)
    expect(data.accounts).toHaveLength(1)

    markDirty('local-write', 303)
    await settle()
    expect(h.accountList).toHaveBeenCalledTimes(2)
    expect(dirtyByLedger[303].version).toBe(1)
  })

  it('reload 失败不缓存：下一次置脏能重新发请求', async () => {
    const session = useSessionStore()
    session.ledgerId = 305
    const data = useLedgerDataStore()
    await data.ensure()
    await settle() // 等补齐段落地：旧快照 = 全量 [txn1]

    h.accountList.mockRejectedValueOnce(new Error('boom'))
    markDirty('local-write', 305)
    await settle()
    expect(data.error).not.toBe('')
    expect(data.loaded).toBe(true)
    expect(data.txns).toHaveLength(1)

    h.accountList.mockResolvedValue(accountRes([1, 2]))
    markDirty('local-write', 305)
    await settle()
    expect(h.accountList).toHaveBeenCalledTimes(3)
    expect(data.error).toBe('')
    expect(data.accounts).toHaveLength(2)
  })
})
