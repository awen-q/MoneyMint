// @vitest-environment jsdom
/**
 * 详情页「修改记录」与冲正发起人标注回归。
 *
 * 背景：编辑交易是「冲正 + 新建」两步。用户在被冲正的原交易详情里看不到
 * 「谁在什么时候改的」；而冲正交易自己的详情又把发起人标成「记账人」，
 * 容易让人以为某成员真的记了一笔叫「冲正:面包烘焙」的支出。
 *
 * 本文件锁 5 条：
 * 1. 原交易被冲正 + 列表里能找到冲正记录 → 出现「修改记录」行，值含人名与日期；
 * 2. 冲正记录 created_by_name 为空 → 人名退化为「某成员」；
 * 3. 找不到冲正记录（如已进回收站）→ 不加行、不抛错；
 * 4. 详情本身是冲正交易 → 标签为「发起人」而非「记账人」；
 * 5. 普通交易 → 无「修改记录」行、「记账人」标签不变。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

import { formatSessionTime } from '@/core/batch3'
import TransactionDetailView from '@/views/TransactionDetailView.vue'

/**
 * 冲正记录的写入时间，形状来自后端 `TransactionView.created_at`
 * （`internal/service/transaction.go`，SQLite `datetime('now')` 的 **UTC** 串）。
 *
 * 期望值用 `formatSessionTime` 现算而非写死：该函数会把 UTC 串转成本地时区，
 * 写死日期会让用例在非东八区的机器上失败（UTC 05:22 在 UTC-8 已是前一日）。
 */
const REVERSAL_UTC = '2026-11-26 05:22:44'
const REVERSAL_LOCAL_DATE = formatSessionTime(REVERSAL_UTC).slice(0, 10)

const h = vi.hoisted(() => ({
  listTxns: vi.fn(),
  listAccounts: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  accountApi: { list: h.listAccounts },
  transactionApi: {
    list: h.listTxns,
    remove: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    trash: vi.fn(),
  },
  newIdempotencyKey: vi.fn(() => 'idem-r'),
}))

vi.mock('vue-router', () => ({
  routerKey: Symbol.for('router'),
  useRoute: () => ({ params: {}, query: { id: '11' } }),
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    ledgerId: 7,
    isViewer: false,
    defaultCommodity: 'CNY',
    ledgers: [],
  }),
}))

vi.mock('@/stores/privacy', () => ({ usePrivacyStore: () => ({ enabled: false }) }))

vi.mock('@/stores/recordSheet', () => ({
  useRecordSheetStore: () => ({
    editingTxn: null,
    savedEpoch: 0,
    openEdit: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
    notifyChanged: vi.fn(),
    notifySaved: vi.fn(),
  }),
}))

vi.mock('@/stores/dataFreshness', () => ({ markDirty: vi.fn() }))

const ACCOUNTS = {
  accounts: [
    { id: 1, uuid: 'a-1', name: 'Assets:Cash', display_name: '招商储蓄', type: 'Assets', open_date: '2026-01-01', sort_order: 0 },
    { id: 2, uuid: 'a-2', name: 'Expenses:Food', display_name: '食品饮料', type: 'Expenses', open_date: '2026-01-01', sort_order: 0 },
  ],
}

/** 详情页当前展示的交易（id 与 useRoute 的 id 对齐）。 */
function detailTxn(extra: Record<string, unknown> = {}) {
  return {
    id: 11,
    uuid: 't-11',
    date: '2026-11-10',
    flag: '*',
    description: '面包烘焙',
    created_by_name: '阿文',
    can_edit: true,
    postings: [
      { account_id: 2, account: 'Expenses:Food', commodity: 'CNY', amount: '38.50' },
      { account_id: 1, account: 'Assets:Cash', commodity: 'CNY', amount: '-38.50' },
    ],
    ...extra,
  }
}

/** 冲正交易（uuid = 原交易的 reversed_by）。 */
function reversalTxn(extra: Record<string, unknown> = {}) {
  return {
    id: 12,
    uuid: 'rev-1',
    date: '2026-11-26',
    flag: '*',
    description: '冲正: 面包烘焙',
    created_by_name: '张三',
    // 字段名与形状对齐后端 TransactionView.created_at（UTC）。
    created_at: REVERSAL_UTC,
    reversal_of: 't-11',
    postings: [
      { account_id: 2, account: 'Expenses:Food', commodity: 'CNY', amount: '-38.50' },
      { account_id: 1, account: 'Assets:Cash', commodity: 'CNY', amount: '38.50' },
    ],
    ...extra,
  }
}

/** 按 label 取票面 rows 某一行的值；不存在返回 null。 */
function rowValue(wrapper: VueWrapper, label: string): string | null {
  const labels = wrapper.findAll('.slip__rows-label')
  const values = wrapper.findAll('.slip__rows-value')
  for (let i = 0; i < labels.length; i += 1) {
    if (labels[i]!.text() === label) {
      return values[i]!.text()
    }
  }
  return null
}

beforeEach(() => {
  h.listTxns.mockReset()
  h.listAccounts.mockReset()
  h.listAccounts.mockResolvedValue(ACCOUNTS)
})

describe('详情页「修改记录」', () => {
  it('原交易被冲正且能找到冲正记录：显示「张三 · 2026-11-26」', async () => {
    h.listTxns.mockResolvedValue({
      transactions: [detailTxn({ reversed_by: 'rev-1' }), reversalTxn()],
    })
    const wrapper = mount(TransactionDetailView)
    await flushPromises()

    expect(rowValue(wrapper, '修改记录')).toBe(`张三 · ${REVERSAL_LOCAL_DATE}`)
    wrapper.unmount()
  })

  it('冲正记录 created_by_name 为空：人名退化为「某成员」，日期仍显示', async () => {
    h.listTxns.mockResolvedValue({
      transactions: [detailTxn({ reversed_by: 'rev-1' }), reversalTxn({ created_by_name: '' })],
    })
    const wrapper = mount(TransactionDetailView)
    await flushPromises()

    expect(rowValue(wrapper, '修改记录')).toBe(`某成员 · ${REVERSAL_LOCAL_DATE}`)
    wrapper.unmount()
  })

  it('created_at 缺失：只显示人名，不出现半截日期', async () => {
    h.listTxns.mockResolvedValue({
      transactions: [detailTxn({ reversed_by: 'rev-1' }), reversalTxn({ created_at: '' })],
    })
    const wrapper = mount(TransactionDetailView)
    await flushPromises()

    expect(rowValue(wrapper, '修改记录')).toBe('张三')
    expect(wrapper.text()).not.toContain('张三 ·')
    wrapper.unmount()
  })

  it('reversed_by 有值但列表里找不到该冲正记录：不加行且不抛错', async () => {
    h.listTxns.mockResolvedValue({
      transactions: [detailTxn({ reversed_by: 'rev-missing' })],
    })
    const wrapper = mount(TransactionDetailView)
    await flushPromises()

    expect(rowValue(wrapper, '修改记录')).toBeNull()
    // 页面本体仍正常渲染（没有被异常打断）。
    expect(wrapper.text()).toContain('面包烘焙')
    wrapper.unmount()
  })
})

describe('冲正交易的发起人标注', () => {
  it('详情本身是冲正交易：标签是「发起人」而不是「记账人」', async () => {
    // 详情指向的交易自身就带 reversal_of（即它是冲正交易），
    // 此时 created_by_name 的语义是「谁发起了这次修改」，不是「谁记了这笔账」。
    h.listTxns.mockResolvedValue({
      transactions: [detailTxn({ reversal_of: 'orig-9', description: '冲正: 面包烘焙' })],
    })
    const wrapper = mount(TransactionDetailView)
    await flushPromises()

    expect(rowValue(wrapper, '发起人')).toBe('阿文')
    expect(rowValue(wrapper, '记账人')).toBeNull()
    wrapper.unmount()
  })

  it('普通交易：无「修改记录」行，「记账人」标签不变', async () => {
    h.listTxns.mockResolvedValue({ transactions: [detailTxn()] })
    const wrapper = mount(TransactionDetailView)
    await flushPromises()

    expect(rowValue(wrapper, '修改记录')).toBeNull()
    expect(rowValue(wrapper, '记账人')).toBe('阿文')
    expect(rowValue(wrapper, '发起人')).toBeNull()
    wrapper.unmount()
  })
})
