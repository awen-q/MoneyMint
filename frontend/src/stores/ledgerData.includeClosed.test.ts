/**
 * `ledgerData` 必须把**已关户账户**也拉进快照（T55 前置 / include_closed 修复）。
 *
 * 这条用例证明的是「修复真的生效」，而不是间接指标：
 * mock 的 `accountApi.list` **按真实服务端语义实现**——不传 `includeClosed` 时
 * 只返未关户账户，传了才返关户账户。因此：
 * - 若 `ledgerData` 去掉 `{ includeClosed: true }`，快照里就没有那个关户 uuid，用例红；
 * - 若只断言「closedCount > 0」这类间接指标，改动被回退时可能仍然绿。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import type { AccountView, TransactionListResponse } from '@/api/types'
import { useLedgerDataStore } from '@/stores/ledgerData'
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
  authApi: { me: h.me, login: h.login, logout: h.logout, changePassword: h.changePassword },
  ledgerApi: { list: h.ledgerList },
  setLedgerIdProvider: h.setLedgerIdProvider,
}))

function account(id: number, name: string, type: AccountView['type'], closeDate?: string): AccountView {
  const base: AccountView = {
    id,
    name,
    uuid: `uuid-${id}`,
    type,
    open_date: '2026-01-01',
    sort_order: id,
  }
  return closeDate === undefined ? base : { ...base, close_date: closeDate }
}

/** 按真实服务端语义返回：只有显式 includeClosed 才包含关户账户。 */
function serverList(opts: { includeClosed?: boolean } = {}): Promise<{ accounts: AccountView[] }> {
  const open = account(1, 'Assets:Bank', 'Assets')
  const closed = account(2, 'Assets:Old', 'Assets', '2026-06-30')
  return Promise.resolve({ accounts: opts.includeClosed === true ? [open, closed] : [open] })
}

beforeEach(() => {
  setActivePinia(createPinia())
  for (const fn of Object.values(h)) {
    fn.mockReset()
  }
  h.accountList.mockImplementation(serverList)
  h.txnList.mockResolvedValue({ transactions: [] } as TransactionListResponse)
  h.ledgerList.mockResolvedValue({ ledgers: [] })
  h.me.mockResolvedValue({ user: null })
})

describe('ledgerData：关户账户进快照', () => {
  it('快照里有关户账户（数据源请求带 includeClosed: true）', async () => {
    const session = useSessionStore()
    session.ledgerId = 1
    const data = useLedgerDataStore()
    await data.ensure()

    // ① 请求确实要了关户账户
    expect(h.accountList).toHaveBeenCalledWith({ includeClosed: true })
    // ② 快照里真的有那个关户账户（对着 uuid 断言，这是本次修复的「因」）
    expect(data.accounts.map((item) => item.uuid)).toContain('uuid-2')
    expect(data.accounts.some((item) => (item.close_date ?? '') !== '')).toBe(true)
  })
})
