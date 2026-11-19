/**
 * period store 回归（跨页浏览态单源）
 *
 * 逐条锁死重置契约：
 * - 切账本：年 / 月 / `stats.tab` **保留**，`commodity` 重置为该账本默认币种；
 * - 切月：bills 与 stats 各自独立，互不影响；
 * - 切币种：bills 与 stats **同时**变（跨页币种单源）；
 * - `resetAll()`：回到当前年月 + CNY + tab='stat'。
 *
 * 时间用 `vi.useFakeTimers` + `vi.setSystemTime` 固定，避免用例随真实日期漂移。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

import { usePeriodStore } from '@/stores/period'
import { useSessionStore } from '@/stores/session'
import type { LedgerView } from '@/api/types'

const h = vi.hoisted(() => ({
  me: vi.fn(),
  ledgerList: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  changePassword: vi.fn(),
  setLedgerIdProvider: vi.fn(),
  accountList: vi.fn(),
  txnList: vi.fn(),
}))

// session store 依赖 `@/api/client`；period store 只用 session，故整模块 mock 即可。
vi.mock('@/api/client', () => ({
  authApi: {
    me: h.me,
    login: h.login,
    logout: h.logout,
    changePassword: h.changePassword,
  },
  ledgerApi: { list: h.ledgerList },
  setLedgerIdProvider: h.setLedgerIdProvider,
  accountApi: { list: h.accountList },
  transactionApi: { list: h.txnList },
}))

/** 固定的「现在」：2026-03-15 12:00Z（各时区都落在 2026 年 3 月）。 */
const NOW = new Date('2026-03-15T12:00:00Z')
const NOW_YEAR = NOW.getFullYear()
const NOW_MONTH = NOW.getMonth() + 1

function makeLedger(id: number, defaultCommodity?: string): LedgerView {
  const ledger: LedgerView = {
    id,
    name: `账本${id}`,
    opening_date: '2026-01-01',
    role: 'owner',
  }
  if (defaultCommodity !== undefined) {
    ledger.default_commodity = defaultCommodity
  }
  return ledger
}

/** 等 Vue 的 pre-flush 调度（watch 回调）跑完。 */
async function flush(): Promise<void> {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  setActivePinia(createPinia())
  h.me.mockReset()
  h.ledgerList.mockReset()
  h.login.mockReset()
  h.logout.mockReset()
  h.changePassword.mockReset()
  h.setLedgerIdProvider.mockReset()
  h.accountList.mockReset()
  h.txnList.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('period：初始值', () => {
  it('以当前年月初始化，币种兜底 CNY，tab 默认 stat', () => {
    useSessionStore()
    const period = usePeriodStore()

    expect(period.bills).toEqual({ year: NOW_YEAR, month: NOW_MONTH, commodity: 'CNY' })
    expect(period.stats).toEqual({
      year: NOW_YEAR,
      month: NOW_MONTH,
      commodity: 'CNY',
      tab: 'stat',
    })
    expect(period.assets).toEqual({ year: NOW_YEAR })
  })
})

describe('period：切月各自独立', () => {
  it('账单页切月不影响统计页，统计页切月也不回写账单页', () => {
    useSessionStore()
    const period = usePeriodStore()

    period.setBillsMonth(2025, 7)
    expect(period.bills.year).toBe(2025)
    expect(period.bills.month).toBe(7)
    // 统计页原封不动。
    expect(period.stats.year).toBe(NOW_YEAR)
    expect(period.stats.month).toBe(NOW_MONTH)

    period.setStatsMonth(2024, 11)
    expect(period.stats.year).toBe(2024)
    expect(period.stats.month).toBe(11)
    // 账单页仍停在 2025-07。
    expect(period.bills.year).toBe(2025)
    expect(period.bills.month).toBe(7)

    // 资产统计页只按年，切月不应波及。
    expect(period.assets.year).toBe(NOW_YEAR)
  })

  it('非法年月被夹到合法区间，不污染状态', () => {
    useSessionStore()
    const period = usePeriodStore()

    period.setBillsMonth(2025, 13)
    expect(period.bills.month).toBe(12)

    period.setBillsMonth(2025, 0)
    expect(period.bills.month).toBe(1)

    period.setBillsMonth(Number.NaN, Number.NaN)
    expect(period.bills.year).toBe(2025)
    expect(period.bills.month).toBe(1)

    period.setAssetsYear(Number.NaN)
    expect(period.assets.year).toBe(NOW_YEAR)

    period.setAssetsYear(2023)
    expect(period.assets.year).toBe(2023)
  })
})

describe('period：币种单源（关键）', () => {
  it('setCommodity 同时改 bills 与 stats', () => {
    useSessionStore()
    const period = usePeriodStore()

    period.setCommodity('USD')

    expect(period.bills.commodity).toBe('USD')
    expect(period.stats.commodity).toBe('USD')
    // 只读别名与两页恒等（资产页等第三方页面用它，不必猜该读 bills 还是 stats）
    expect(period.commodity).toBe('USD')
  })

  it('setCommodity("") 保持原币种；resetCommodity 两页一起改', () => {
    useSessionStore()
    const period = usePeriodStore()

    period.setCommodity('EUR')
    period.setCommodity('')
    expect(period.bills.commodity).toBe('EUR')
    expect(period.stats.commodity).toBe('EUR')

    period.resetCommodity('JPY')
    expect(period.bills.commodity).toBe('JPY')
    expect(period.stats.commodity).toBe('JPY')

    // 空默认值兜底 CNY，绝不出现空币种。
    period.resetCommodity('')
    expect(period.bills.commodity).toBe('CNY')
    expect(period.stats.commodity).toBe('CNY')
  })

  it('setStatsTab 只切下钻视图，不动币种与月份', () => {
    useSessionStore()
    const period = usePeriodStore()

    period.setStatsMonth(2025, 5)
    period.setCommodity('USD')
    period.setStatsTab('tag')

    expect(period.stats.tab).toBe('tag')
    expect(period.stats.year).toBe(2025)
    expect(period.stats.month).toBe(5)
    expect(period.stats.commodity).toBe('USD')
  })
})

describe('period：切账本重置契约', () => {
  it('切账本保留年 / 月 / tab，commodity 重置为该账本默认币种', async () => {
    const session = useSessionStore()
    const period = usePeriodStore()

    period.setBillsMonth(2025, 7)
    period.setStatsMonth(2025, 9)
    period.setStatsTab('tag')
    period.setCommodity('USD')
    period.setAssetsYear(2022)

    session.ledgers = [makeLedger(1, 'EUR')]
    session.ledgerId = 1
    await flush()

    expect(period.bills).toEqual({ year: 2025, month: 7, commodity: 'EUR' })
    expect(period.stats).toEqual({
      year: 2025,
      month: 9,
      commodity: 'EUR',
      tab: 'tag',
    })
    // 资产统计年份与切账本无关，保留。
    expect(period.assets.year).toBe(2022)
  })

  it('新账本没有默认币种时回退 CNY', async () => {
    const session = useSessionStore()
    const period = usePeriodStore()

    session.ledgers = [makeLedger(1, 'EUR'), makeLedger(2)]
    session.ledgerId = 1
    await flush()
    expect(period.bills.commodity).toBe('EUR')

    period.setCommodity('USD')
    session.ledgerId = 2
    await flush()

    expect(period.bills.commodity).toBe('CNY')
    expect(period.stats.commodity).toBe('CNY')
  })
})

describe('period：resetAll', () => {
  it('全部回到当前年月 + CNY + tab=stat（读取调用时刻的真实日期）', () => {
    useSessionStore()
    const period = usePeriodStore()

    period.setBillsMonth(2020, 1)
    period.setStatsMonth(2019, 2)
    period.setStatsTab('tag')
    period.setCommodity('USD')
    period.setAssetsYear(2018)

    vi.setSystemTime(new Date('2027-11-05T12:00:00Z'))
    const later = new Date('2027-11-05T12:00:00Z')

    period.resetAll()

    expect(period.bills).toEqual({
      year: later.getFullYear(),
      month: later.getMonth() + 1,
      commodity: 'CNY',
    })
    expect(period.stats).toEqual({
      year: later.getFullYear(),
      month: later.getMonth() + 1,
      commodity: 'CNY',
      tab: 'stat',
    })
    expect(period.assets).toEqual({ year: later.getFullYear() })
  })
})
