/**
 * 角色门禁修复（D-14 / AC-5.7）与账本兜底（AC-1.4 / R3）回归。
 *
 * 修复前 isViewer 取自 `user.role`，而 `/api/auth/me` 恒返回空串，导致 viewer
 * 看到可点但点了报 403 的按钮（后端 middleware 仍是权威防线）。修复后从
 * `ledgers[ledgerId].role` 派生；这里用真实 store + mock 的 client 覆盖
 * 跨账本切换、恒空 user.role、以及软删后兜底到最小有效账本。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useSessionStore } from '@/stores/session'
import type { LedgerView, UserInfo } from '@/api/types'

const h = vi.hoisted(() => ({
  me: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  changePassword: vi.fn(),
  list: vi.fn(),
  setLedgerIdProvider: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  authApi: {
    login: h.login,
    me: h.me,
    logout: h.logout,
    changePassword: h.changePassword,
  },
  ledgerApi: { list: h.list },
  setLedgerIdProvider: h.setLedgerIdProvider,
}))

function makeUser(role: string): UserInfo {
  return {
    id: 2,
    username: 'awen',
    display_name: '阿文',
    role: role as UserInfo['role'],
    is_admin: false,
    must_change_password: false,
  }
}

function makeLedger(id: number, role: LedgerView['role']): LedgerView {
  return {
    id,
    name: `账本${id}`,
    opening_date: '2026-01-01',
    role,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  h.me.mockReset()
  h.login.mockReset()
  h.logout.mockReset()
  h.changePassword.mockReset()
  h.list.mockReset()
  h.setLedgerIdProvider.mockReset()
})

describe('D-14：isViewer 从当前账本角色派生', () => {
  it('user.role 恒空时，切到 viewer 账本即为 viewer，切回 owner 即恢复', async () => {
    h.me.mockResolvedValue({ user: makeUser('') })
    h.list.mockResolvedValue({
      ledgers: [makeLedger(1, 'owner'), makeLedger(2, 'viewer')],
    })

    const session = useSessionStore()
    await session.bootstrap()

    expect(session.ledgerId).toBe(1)
    expect(session.isViewer).toBe(false)

    session.selectLedger(2)
    expect(session.isViewer).toBe(true)

    session.selectLedger(1)
    expect(session.isViewer).toBe(false)
  })

  it('回归保护：user.role 即使是 viewer，当前账本为 owner 时也不应判为 viewer', async () => {
    h.me.mockResolvedValue({ user: makeUser('viewer') })
    h.list.mockResolvedValue({ ledgers: [makeLedger(1, 'owner')] })

    const session = useSessionStore()
    await session.bootstrap()

    expect(session.user?.role).toBe('viewer')
    expect(session.isViewer).toBe(false)
  })

  it('未登录 / 未选择账本时 isViewer 恒为 false', () => {
    const session = useSessionStore()
    expect(session.isViewer).toBe(false)
  })
})

describe('P0：isOwner 从当前账本角色派生（与 isViewer 同源）', () => {
  it('user.role 恒空时切账本：owner → editor → viewer，isOwner 仅 owner 为真', async () => {
    h.me.mockResolvedValue({ user: makeUser('') })
    h.list.mockResolvedValue({
      ledgers: [makeLedger(1, 'owner'), makeLedger(2, 'editor'), makeLedger(3, 'viewer')],
    })
    const session = useSessionStore()
    await session.bootstrap()

    expect(session.isOwner).toBe(true)
    session.selectLedger(2)
    expect(session.isOwner).toBe(false)
    session.selectLedger(3)
    expect(session.isOwner).toBe(false)
    expect(session.isViewer).toBe(true)
    session.selectLedger(1)
    expect(session.isOwner).toBe(true)
  })

  it('未登录 / 未选择账本时 isOwner 恒为 false', () => {
    const session = useSessionStore()
    expect(session.isOwner).toBe(false)
  })
})

describe('AC-1.4 / R3：refreshLedgers 兜底到最小有效账本', () => {
  it('清单乱序时仍选最小 id（不依赖服务端排序）', async () => {
    h.me.mockResolvedValue({ user: makeUser('') })
    h.list.mockResolvedValue({
      ledgers: [makeLedger(7, 'owner'), makeLedger(3, 'editor'), makeLedger(9, 'viewer')],
    })

    const session = useSessionStore()
    await session.bootstrap()

    expect(session.ledgerId).toBe(3)
  })

  it('当前账本被删除后再次刷新，切到剩余最小有效账本', async () => {
    h.me.mockResolvedValue({ user: makeUser('') })
    h.list
      .mockResolvedValueOnce({ ledgers: [makeLedger(1, 'owner'), makeLedger(5, 'owner')] })
      .mockResolvedValueOnce({ ledgers: [makeLedger(5, 'owner')] })

    const session = useSessionStore()
    await session.bootstrap()
    expect(session.ledgerId).toBe(1)

    await session.refreshLedgers()
    expect(session.ledgerId).toBe(5)
    expect(session.isViewer).toBe(false)
  })

  it('清单为空时清空账本 id（等待邀请态）', async () => {
    h.me.mockResolvedValue({ user: makeUser('') })
    h.list.mockResolvedValue({ ledgers: [] })

    const session = useSessionStore()
    await session.bootstrap()

    expect(session.ledgerId).toBeNull()
    expect(session.needsInvite).toBe(true)
  })
})
