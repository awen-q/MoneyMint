// @vitest-environment jsdom
/**
 * 记账弹窗父级解析兜底回归（账本 `一家三口` 真实故障）。
 *
 * 背景：批量导入的账户 `parent_uuid` 为 NULL（后端未回指父级），但 name 是
 * Beancount 冒号层级（`Expenses:Food:Dining`）。`RecordSheet` 原先只认
 * `parent_uuid`，于是这类三级账户全被当成一级塞进 grid、二级 chips 不出现；
 * 而 `CategoriesView` / `AccountsView` 走 `buildAccountTree` 有冒号兜底 ——
 * 两套规则不一致，用户在分类管理页能看到父子、在记账弹窗看不到。
 *
 * 本文件锁定"与 buildAccountTree 同规则"：parent_uuid 优先，缺失按 name 冒号兜底，
 * 找不到父则视为根（孤儿作根）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

import RecordSheet from './RecordSheet.vue'

const h = vi.hoisted(() => ({
  list: vi.fn(),
  listCommodities: vi.fn(),
  create: vi.fn(),
  readDraft: vi.fn(),
  writeDraft: vi.fn(),
  opening: '2026-11-01',
}))

vi.mock('@/api/client', () => ({
  accountApi: { list: h.list },
  commodityApi: { list: h.listCommodities },
  transactionApi: { create: h.create, update: vi.fn() },
  newIdempotencyKey: () => 'PF-KEY',
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    ledgerId: 9,
    isViewer: false,
    defaultCommodity: 'CNY',
    ledgerName: '一家三口',
    get ledgers() {
      return [{ id: 9, name: '一家三口', opening_date: h.opening }]
    },
  }),
}))

vi.mock('@/stores/recordSheet', () => ({
  useRecordSheetStore: () => ({ editingTxn: null, notifySaved: vi.fn(), notifyChanged: vi.fn() }),
}))

vi.mock('@/stores/privacy', () => ({ usePrivacyStore: () => ({ enabled: false }) }))

vi.mock('@/core/storage', () => ({
  readDraft: h.readDraft,
  writeDraft: h.writeDraft,
  clearDraft: vi.fn(),
  readDefaultAccounts: () => ({}),
  setDefaultAccount: vi.fn(),
}))

/**
 * 故障现场：父子都是批量导入，`parent_uuid` 全为空字符串，
 * 层级只体现在 name 的冒号上。
 */
const ORPHAN_CHILD_ACCOUNTS = [
  {
    id: 1,
    uuid: 'u-cash',
    name: 'Assets:Cash',
    display_name: '现金',
    type: 'Assets',
    sort_order: 0,
    balances: { CNY: '100.00' },
  },
  {
    id: 10,
    uuid: 'u-food',
    name: 'Expenses:Food',
    display_name: '饮食',
    type: 'Expenses',
    sort_order: 0,
    icon: '🍜',
    parent_uuid: '',
  },
  {
    id: 11,
    uuid: 'u-dining',
    name: 'Expenses:Food:Dining',
    display_name: '下馆子',
    type: 'Expenses',
    sort_order: 0,
    parent_uuid: '',
  },
  {
    id: 12,
    uuid: 'u-groceries',
    name: 'Expenses:Food:Groceries',
    display_name: '买菜',
    type: 'Expenses',
    sort_order: 1,
    parent_uuid: '',
  },
]

/** 孤儿作根：只有 `Expenses:Housing:Mortgage`，账本里没有 `Expenses:Housing`。 */
const ORPHAN_ROOT_ACCOUNTS = [
  {
    id: 1,
    uuid: 'u-cash',
    name: 'Assets:Cash',
    display_name: '现金',
    type: 'Assets',
    sort_order: 0,
    balances: { CNY: '100.00' },
  },
  {
    id: 20,
    uuid: 'u-mortgage',
    name: 'Expenses:Housing:Mortgage',
    display_name: '房贷',
    type: 'Expenses',
    sort_order: 0,
    parent_uuid: '',
  },
]

async function mountSheet(): Promise<VueWrapper> {
  const wrapper = mount(RecordSheet)
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  h.list.mockReset()
  h.list.mockResolvedValue({ accounts: ORPHAN_CHILD_ACCOUNTS })
  h.listCommodities.mockReset()
  h.listCommodities.mockResolvedValue({ commodities: [{ symbol: 'CNY' }] })
  h.create.mockReset()
  h.readDraft.mockReset()
  h.readDraft.mockReturnValue(null)
  h.writeDraft.mockReset()
  h.opening = '2026-11-01'
})

describe('父级解析兜底：parent_uuid 缺失时按 name 冒号推导', () => {
  it('三级账户 parent_uuid 为空时仍挂到同名父级下：一级只出「饮食」，点开有「下馆子」', async () => {
    const wrapper = await mountSheet()

    // 一级 grid 只应有「饮食」一个支出分类；修复前 `Expenses:Food:Dining` /
    // `Expenses:Food:Groceries` 也会被当成一级，于是这里是 3 个。
    const roots = wrapper.findAll('.rs-cat')
    expect(roots, `一级应只有 1 项，实际：${roots.map((r) => r.text()).join(' | ')}`).toHaveLength(1)
    expect(roots[0]!.text()).toContain('饮食')

    // 点开一级后二级 chips 必须出现，且包含两个子项。
    await roots[0]!.trigger('click')
    await flushPromises()
    expect(wrapper.find('.rs-subcats').exists()).toBe(true)
    const subs = wrapper.findAll('.rs-subcats .rs-subcat:not(.rs-subcat--all)')
    const texts = subs.map((sub) => sub.text())
    expect(texts.join(' | ')).toContain('下馆子')
    expect(texts.join(' | ')).toContain('买菜')
    expect(subs).toHaveLength(2)

    wrapper.unmount()
  })

  it('找不到父级时孤儿作根：只有 Expenses:Housing:Mortgage 时它作为一级出现', async () => {
    h.list.mockResolvedValue({ accounts: ORPHAN_ROOT_ACCOUNTS })
    const wrapper = await mountSheet()

    const roots = wrapper.findAll('.rs-cat')
    expect(roots).toHaveLength(1)
    expect(roots[0]!.text()).toContain('房贷')

    // 没有子分类 → 二级行整行隐藏（沿用既有契约）
    expect(wrapper.find('.rs-subcats').exists()).toBe(false)

    wrapper.unmount()
  })

  it('parent_uuid 正常时不受兜底影响（回归保护）', async () => {
    h.list.mockResolvedValue({
      accounts: [
        ORPHAN_CHILD_ACCOUNTS[0]!,
        {
          id: 30,
          uuid: 'u-travel',
          name: 'Expenses:Travel',
          display_name: '交通',
          type: 'Expenses',
          sort_order: 0,
          parent_uuid: '',
        },
        {
          id: 31,
          uuid: 'u-bus',
          name: 'Expenses:Travel:Bus',
          display_name: '公交',
          type: 'Expenses',
          sort_order: 0,
          parent_uuid: 'u-travel',
        },
      ],
    })
    const wrapper = await mountSheet()

    const roots = wrapper.findAll('.rs-cat')
    expect(roots).toHaveLength(1)
    expect(roots[0]!.text()).toContain('交通')

    await roots[0]!.trigger('click')
    await flushPromises()
    const subs = wrapper.findAll('.rs-subcats .rs-subcat:not(.rs-subcat--all)')
    expect(subs).toHaveLength(1)
    expect(subs[0]!.text()).toContain('公交')

    wrapper.unmount()
  })
})
