// @vitest-environment jsdom
/**
 * 资产页装配回归（B5 / T53，入口部分 B6 / A-2）
 *
 * 覆盖六件必须成立的事：
 * 1. **数据只走 `ledgerData.ensure()`**：一次挂载只调一次 `accountApi.list()`（并发去重）；
 * 2. **四态判据**：加载失败 → error；`loaded` 后无资产账户 → empty，且**两者文案不同**；
 * 3. **`AssetHero` 在 `StateCard` 之外**：error / empty 时净资产区仍然渲染（空态不能藏答案）；
 * 4. **币种取 `period`**：把 period 切成 USD 后，hero 与小计按 USD 口径渲染；
 * 5. **隐私遮挡生效**：开启后金额显示遮挡符，不出现真实数字；
 * 6. **「资产统计 ›」入口存在且走命名路由**（B6 / A-2）：`/assets/stats` 可达而页内没有
 *    入口 = 功能被藏起来。此条与 `shellNav.test.ts` 的「路由可解析 + 导航 ready」构成
 *    双向守卫：删路由 → 那边红；删入口 → 这里红。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import AssetsView from '@/views/AssetsView.vue'
import { useSessionStore } from '@/stores/session'
import { usePeriodStore } from '@/stores/period'
import { usePrivacyStore } from '@/stores/privacy'
import { writeLedgerId } from '@/core/storage'
import { PRIVACY_MASK } from '@/core/privacy'

const h = vi.hoisted(() => ({
  accountList: vi.fn(),
  accountCreate: vi.fn(),
  txnList: vi.fn(),
  me: vi.fn(),
  ledgerList: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  changePassword: vi.fn(),
  setLedgerIdProvider: vi.fn(),
  push: vi.fn(),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: h.push, replace: h.push }),
  useRoute: () => ({ query: {}, path: '/assets', name: 'assets' }),
}))

// 注意：AccountForm（创建弹层）内部 import 了 openingApi——mock 工厂缺
// named export 会让整个测试文件在 import 阶段直接崩（设计文档点名的确定性风险）。
vi.mock('@/api/client', () => ({
  accountApi: { list: h.accountList, create: h.accountCreate },
  openingApi: { get: vi.fn(), set: vi.fn() },
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

describe('AssetsView：「资产统计 ›」入口（B6 / A-2）', () => {
  beforeEach(() => {
    h.push.mockReset()
  })

  it('工具卡里有入口，文案与稿子一致（`资产统计 ›`）', async () => {
    const wrapper = await mountView()
    const link = wrapper.find('.assets__link')
    expect(link.exists()).toBe(true)
    expect(link.text()).toBe('资产统计 ›')
  })

  it('点击走**命名路由** asset-stats（不是拼字符串 /assets/stats）', async () => {
    const wrapper = await mountView()
    await wrapper.find('.assets__link').trigger('click')
    expect(h.push).toHaveBeenCalledTimes(1)
    // 断言整个对象：拼字符串路径的实现会 push('/assets/stats')，此处直接红，
    // 而不会被「反正跳过去了」蒙混过关（路由改名时字符串会静默失效）。
    expect(h.push).toHaveBeenCalledWith({ name: 'asset-stats' })
  })

  it('入口在四态之外：加载失败时入口仍然在（错误态不能把出口一起关掉）', async () => {
    h.accountList.mockRejectedValue(new Error('boom'))
    const wrapper = await mountView()
    expect(wrapper.text()).toContain('加载失败')
    expect(wrapper.find('.assets__link').exists()).toBe(true)
  })
})

describe('AssetsView：创建入口（FR-1，AC-1 / AC-2）', () => {
  const NEW_ACCOUNT = account(
    9,
    'Assets:Bank2',
    'Assets',
    { CNY: '0.00' },
    { display_name: '测试二级' },
  )

  /**
   * 角色门禁用真实 session store 构造：isViewer / isOwner 只从
   * `ledgers[].role` 派生（user.role 恒空串不可作数），且要求 user 非空。
   * markDirty 的账本分桶依赖 localStorage 里持久化的账本 id，一并写入，
   * 否则 AC-2 的「markDirty → reload」链路在测试里不会触发。
   */
  function actAs(role: 'owner' | 'viewer'): void {
    const session = useSessionStore()
    session.user = {
      id: 1,
      username: 'demo',
      display_name: '一家之主',
      role: '',
      is_admin: role === 'owner',
      must_change_password: false,
    }
    session.ledgers = [
      { id: 7, name: '一家三口', default_commodity: 'CNY', opening_date: '2026-01-01', role },
    ]
    session.ledgerId = 7
    localStorage.clear()
    writeLedgerId(7)
  }

  beforeEach(() => {
    h.accountCreate.mockReset()
    h.accountCreate.mockResolvedValue({
      id: 9,
      uuid: 'uuid-9',
      name: 'Assets:Bank2',
      type: 'Assets',
      open_date: '2026-01-01',
    })
    actAs('owner')
  })

  it('owner：工具卡有「＋ 新建账户」按钮，点击弹出 AccountForm（AC-1）', async () => {
    const wrapper = await mountView()
    const button = wrapper.find('.assets__create')
    expect(button.exists()).toBe(true)
    expect(button.text()).toBe('＋ 新建账户')
    expect(wrapper.find('.af-panel').exists()).toBe(false)
    await button.trigger('click')
    expect(wrapper.find('.af-panel').exists()).toBe(true)
    wrapper.unmount()
  })

  it('viewer：工具卡按钮与空态动作按钮都不渲染（DOM 断言，AC-1）', async () => {
    actAs('viewer')
    h.accountList.mockResolvedValue({
      accounts: [account(9, 'Expenses:Food', 'Expenses', { CNY: '1.00' })],
    })
    const wrapper = await mountView()
    expect(wrapper.find('.assets__create').exists()).toBe(false)
    expect(wrapper.text()).toContain('还没有资产或负债账户')
    expect(wrapper.find('.sc-btn').exists()).toBe(false)
    wrapper.unmount()
  })

  it('空态直达：StateCard 空态动作按钮点击后弹出 AccountForm（FR-1）', async () => {
    h.accountList.mockResolvedValue({
      accounts: [account(9, 'Expenses:Food', 'Expenses', { CNY: '1.00' })],
    })
    const wrapper = await mountView()
    const action = wrapper.find('.sc-btn')
    expect(action.exists()).toBe(true)
    expect(action.text()).toBe('＋ 新建账户')
    await action.trigger('click')
    expect(wrapper.find('.af-panel').exists()).toBe(true)
    wrapper.unmount()
  })

  it('AC-2 提交链路：父=无 → POST body parent_uuid===\'\' 且 name=Assets:Bank2；成功后弹窗关闭、列表原地出现新账户', async () => {
    const wrapper = await mountView()

    // mockResolvedValueOnce 是全局 FIFO 队列，按调用顺序消费：设置队列后
    // 第 1 次调用 = AccountForm 自身的父下拉 + 避重集合拉取（点击创建时），
    // 第 2 次 = markDirty 触发的 reload（返回含新账户的快照）。
    // 队列必须在 mountView 之后排定——ensure 是 mount 时的第 1 次调用，
    // 走基础 mock，不吃队列。
    h.accountList
      .mockResolvedValueOnce({ accounts: ACCOUNTS })
      .mockResolvedValueOnce({ accounts: [...ACCOUNTS, NEW_ACCOUNT] })

    await wrapper.find('.assets__create').trigger('click')
    expect(wrapper.find('.af-panel').exists()).toBe(true)

    // 显示名是表单里第一个 text 输入框；owner 额外填 ASCII 段 Bank2。
    const inputs = wrapper.findAll('input')
    const display = inputs.find((i) => (i.element as HTMLInputElement).type === 'text')
    expect(display).toBeDefined()
    await display?.setValue('测试二级')
    const ascii = wrapper.find('input.af-ascii')
    expect(ascii.exists()).toBe(true)
    await ascii.setValue('Bank2')

    const save = wrapper.findAll('button').find((b) => b.text() === '保存')
    expect(save).toBeDefined()
    await save?.trigger('click')
    await flushPromises()

    expect(h.accountCreate).toHaveBeenCalledTimes(1)
    const body = h.accountCreate.mock.calls[0][0] as {
      name: string
      display_name: string
      parent_uuid: string
      type: string
    }
    expect(body.name).toBe('Assets:Bank2')
    expect(body.display_name).toBe('测试二级')
    expect(body.parent_uuid).toBe('')
    expect(body.type).toBe('Assets')

    // 弹窗已关、数据经 ledgerData 既有失效链路原地刷新（无页面级直调）。
    expect(wrapper.find('.af-panel').exists()).toBe(false)
    expect(wrapper.text()).toContain('测试二级')
    expect(h.accountList).toHaveBeenCalledTimes(3)
    wrapper.unmount()
  })
})
