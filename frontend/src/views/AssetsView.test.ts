// @vitest-environment jsdom
/**
 * 资产页装配回归（B5 / T53）
 *
 * 覆盖五件必须成立的事：
 * 1. **数据只走 `ledgerData.ensure()`**：一次挂载只调一次 `accountApi.list()`（并发去重）；
 * 2. **四态判据**：加载失败 → error；`loaded` 后无资产账户 → empty，且**两者文案不同**；
 * 3. **`AssetHero` 在 `StateCard` 之外**：error / empty 时净资产区仍然渲染（空态不能藏答案）；
 * 4. **币种取 `period`**：把 period 切成 USD 后，hero 与小计按 USD 口径渲染；
 * 5. **隐私遮挡生效**：开启后金额显示遮挡符，不出现真实数字。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import AssetsView from '@/views/AssetsView.vue'
import { useSessionStore } from '@/stores/session'
import { usePeriodStore } from '@/stores/period'
import { usePrivacyStore } from '@/stores/privacy'
import { PRIVACY_MASK } from '@/core/privacy'

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

function account(
  id: number,
  name: string,
  type: string,
  balances: Record<string, string>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name,
    display_name: `显示${id}`,
    uuid: `uuid-${id}`,
    type,
    open_date: '2026-01-01',
    sort_order: id,
    balances,
    ...extra,
  }
}

const ACCOUNTS = [
  account(1, 'Assets:Bank:CNY', 'Assets', { CNY: '12000.00' }),
  account(2, 'Assets:Bank:Multi', 'Assets', { CNY: '800.00', USD: '150.00' }),
  account(3, 'Assets:OldCard', 'Assets', { CNY: '200.00' }, { close_date: '2026-10-01' }),
  account(5, 'Liabilities:Mortgage', 'Liabilities', { CNY: '-300000.00' }),
  account(7, 'Expenses:Food', 'Expenses', { CNY: '99.00' }),
]

async function mountView(): Promise<ReturnType<typeof mount>> {
  const wrapper = mount(AssetsView)
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  h.accountList.mockReset()
  h.txnList.mockReset()
  h.accountList.mockResolvedValue({ accounts: ACCOUNTS })
  h.txnList.mockResolvedValue({ transactions: [] })
  // ledgerData 需要账本上下文才发请求
  useSessionStore().ledgerId = 7
})

describe('AssetsView：数据与四态', () => {
  it('挂载只调一次 accountApi.list（走 ensure 的单例去重，不自己拉数据）', async () => {
    const wrapper = await mountView()
    expect(h.accountList).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('资产')
  })

  it('加载失败 → 整页错误态文案，但净资产区仍在（空态不能藏答案）', async () => {
    h.accountList.mockRejectedValue(new Error('boom'))
    const wrapper = await mountView()
    const text = wrapper.text()
    expect(text).toContain('加载失败')
    expect(text).toContain('请检查网络后重试。')
    // hero 固定在 StateCard 之外：错误态也渲染 hero 独有的口径说明。
    // 注意断言的是 `ΣAssets + ΣLiabilities`（只在 AssetHero 里出现），
    // 不能用「净资产」——页头说明里也有这三个字，那样断言会假绿。
    expect(text).toContain('ΣAssets + ΣLiabilities')
  })

  it('无资产账户 → 空态文案与错误态**不同**（不把故障伪装成结论）', async () => {
    h.accountList.mockResolvedValue({
      accounts: [account(9, 'Expenses:Food', 'Expenses', { CNY: '1.00' })],
    })
    const wrapper = await mountView()
    const text = wrapper.text()
    expect(text).toContain('还没有资产或负债账户')
    expect(text).not.toContain('加载失败')
    // 空态同样保留 hero（同样只认 hero 独有的口径说明）
    expect(text).toContain('ΣAssets + ΣLiabilities')
  })

  it('ready：净资产 = ΣAssets + ΣLiabilities（负号如实），负债行负号保留', async () => {
    const wrapper = await mountView()
    const text = wrapper.text()
    // 12000 + 800 + 200 + (-300000) = -287000
    expect(text).toContain('287,000.00')
    expect(text).toContain('净资产为负')
    // 账户展示名来自 accounts（display_name 优先）
    expect(text).toContain('显示1')
    expect(text).toContain('显示5')
    // 支出分类账户不进资产列表
    expect(text).not.toContain('显示7')
  })

  it('外币单列：USD 行打币种 chip，且说明文案列出币种', async () => {
    const wrapper = await mountView()
    const text = wrapper.text()
    expect(text).toContain('USD')
    expect(text).toContain('不计入 CNY 合计')
  })

  it('关户仍列出并标注（不隐藏，避免「钱去哪了」）', async () => {
    const wrapper = await mountView()
    const text = wrapper.text()
    expect(text).toContain('显示3')
    expect(text).toContain('已关户')
    expect(text).toContain('含 1 个已关户账户')
  })

  it('币种取 period：切成 USD 后小计与 hero 都按 USD 口径', async () => {
    usePeriodStore().setCommodity('USD')
    const wrapper = await mountView()
    const text = wrapper.text()
    // USD 口径下资产小计只有 150.00，负债小计 0.00，净资产 150.00
    expect(text).toContain('150.00')
    expect(text).toContain('（USD 口径）')
  })

  it('allowFallback=false：选中的币种无数据时 hero 按该币种给 0.00，不回退到 CNY 数字', async () => {
    usePeriodStore().setCommodity('JPY')
    const wrapper = await mountView()
    // 只看 hero 区域：口径不切换 —— 标题写 JPY，数字就必须是 JPY 的 0.00
    const heroText = wrapper.find('.asset-hero').text()
    expect(heroText).toContain('（JPY 口径）')
    expect(heroText).toContain('0.00')
    expect(heroText).not.toContain('12,000.00')
    // 列表侧则**应当**仍能看到 CNY 余额 —— 那是「外币单列」，不是回退
    expect(wrapper.text()).toContain('12,000.00')
    expect(wrapper.text()).toContain('CNY')
    // 反向护栏：该账本没有任何 JPY 余额，因此**不允许**出现带 JPY 标签的行
    // （否则就是「JPY 标签 + 非 0 金额」，正是回退行为会造成的静默改口）。
    const codes = wrapper.findAll('.asset-row__code').map((node) => node.text())
    expect(codes).not.toContain('JPY')
    // 明细仍按各自真实币种展示（外币单列），只是 hero 口径不切
    expect(codes.indexOf('CNY') >= 0).toBe(true)
  })

  it('隐私遮挡：开启后不出现真实金额，只出现遮挡符', async () => {
    usePrivacyStore().setEnabled(true)
    const wrapper = await mountView()
    const text = wrapper.text()
    expect(text).toContain(PRIVACY_MASK)
    expect(text).not.toContain('12,000.00')
    expect(text).not.toContain('300,000.00')
  })
})
