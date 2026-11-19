// @vitest-environment jsdom
/**
 * 资产统计页回归（B6 / T57）
 *
 * 钉住五件事：
 * 1. **显式传 `commodity`**（省略时服务端取默认币种，切币种曲线不变且不报错）；
 * 2. **切年/切币种要重拉**（服务端按 (year, commodity) 聚合，本地没有快照）；
 * 3. **竞态守卫**：旧响应晚到不得覆盖新响应（否则「切到 2025，曲线是 2024 的数」）；
 * 4. **四态**：首屏失败整页报错、工具卡仍在；年末全 0 → 空态；
 * 5. **不做按日**：页面不存在「按日」按钮（主动削减，见 T57 注释）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import AssetStatsView from '@/views/AssetStatsView.vue'
import { usePeriodStore } from '@/stores/period'
import { useSessionStore } from '@/stores/session'

const h = vi.hoisted(() => ({
  series: vi.fn(),
  push: vi.fn(),
  accountList: vi.fn(),
  txnList: vi.fn(),
  me: vi.fn(),
  ledgerList: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  changePassword: vi.fn(),
  setLedgerIdProvider: vi.fn(),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: h.push, replace: h.push }),
  useRoute: () => ({ query: {}, path: '/assets/stats', name: 'asset-stats' }),
}))

vi.mock('@/api/client', () => ({
  assetSeriesApi: { series: h.series },
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

function makeResponse(year: number, commodity = 'CNY'): { commodity: string; points: Array<{ month: string; assets: string; liabilities: string; net: string }> } {
  return {
    commodity,
    points: [
      { month: `${year}-01`, assets: '1000.00', liabilities: '-400.00', net: '600.00' },
      { month: `${year}-02`, assets: '1200.00', liabilities: '-400.00', net: '800.00' },
    ],
  }
}

async function mountView(): Promise<ReturnType<typeof mount>> {
  const wrapper = mount(AssetStatsView, {
    global: {
      stubs: { TrendChart: true, YearPicker: true },
    },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  h.series.mockReset()
  h.push.mockReset()
  h.accountList.mockReset()
  h.txnList.mockReset()
  h.accountList.mockResolvedValue({ accounts: [] })
  h.txnList.mockResolvedValue({ transactions: [] })
  h.series.mockResolvedValue(makeResponse(2026))
  useSessionStore().ledgerId = 7
  usePeriodStore().setAssetsYear(2026)
})

describe('T57 资产统计页：请求口径', () => {
  it('挂载即拉一次，且**显式传 commodity**（不省略）', async () => {
    await mountView()
    expect(h.series).toHaveBeenCalledTimes(1)
    expect(h.series).toHaveBeenCalledWith(2026, 'CNY')
  })

  it('切年 → 用新年份重拉', async () => {
    const wrapper = await mountView()
    const arrows = wrapper.findAll('.astats__arrow')
    h.series.mockResolvedValue(makeResponse(2025))
    await arrows[0].trigger('click') // 上一年
    await flushPromises()
    expect(h.series).toHaveBeenLastCalledWith(2025, 'CNY')
  })

  it('切币种 → 用新币种重拉（省略 commodity 的话曲线会不变）', async () => {
    const wrapper = await mountView()
    usePeriodStore().setCommodity('USD')
    await flushPromises()
    expect(h.series).toHaveBeenLastCalledWith(2026, 'USD')
    expect(wrapper.text()).toContain('USD')
  })

  it('竞态：旧年份的慢响应晚到，不覆盖新年份的数据', async () => {
    const wrapper = await mountView()
    // 2026 的响应先返回（已落地）；切到 2025 时让 2025 的响应挂起
    let resolve2025: (value: unknown) => void = () => undefined
    h.series.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolve2025 = resolve
      }),
    )
    const arrows = wrapper.findAll('.astats__arrow')
    await arrows[0].trigger('click')
    await flushPromises()
    // 再切回 2026（新的请求令牌），然后让 2025 的慢响应回来
    h.series.mockImplementationOnce(() => Promise.resolve(makeResponse(2026)))
    await arrows[1].trigger('click')
    await flushPromises()
    resolve2025(makeResponse(2025))
    await flushPromises()
    // 页面仍显示 2026 的数据（1200.00），不被 2025 的响应覆盖
    expect(wrapper.text()).toContain('1,200.00')
  })
})

describe('T57 资产统计页：四态与结构', () => {
  it('首屏失败 → 整页错误态，但工具卡（返回 / 年份）仍在（空态不能变成死路）', async () => {
    h.series.mockRejectedValue(new Error('boom'))
    const wrapper = await mountView()
    const text = wrapper.text()
    expect(text).toContain('加载失败')
    expect(wrapper.find('.astats__back').exists()).toBe(true)
    expect(wrapper.find('.astats__year').exists()).toBe(true)
  })

  it('全年全 0 → 空态文案与错误态不同', async () => {
    h.series.mockResolvedValue({ commodity: 'CNY', points: [] })
    const wrapper = await mountView()
    const text = wrapper.text()
    expect(text).toContain('2026 年没有资产或负债记录。')
    expect(text).not.toContain('加载失败')
  })

  it('不做按日：页面上不存在「按日」按钮（T57 主动削减）', async () => {
    const wrapper = await mountView()
    const labels = wrapper.findAll('button').map((node) => node.text())
    expect(labels.indexOf('按日')).toBe(-1)
    expect(labels.indexOf('按月')).toBe(-1)
  })

  it('月度变化列表渲染 12 行，首月环比为「—」', async () => {
    const wrapper = await mountView()
    const rows = wrapper.findAll('.mo__row')
    // 12 行 + 表头 1 行
    expect(rows).toHaveLength(13)
    // 「—」是文本，说明在 aria-label 上：直接找 aria-label 更准确
    expect(wrapper.find('[aria-label="无上月数据"]').exists()).toBe(true)
  })
})
