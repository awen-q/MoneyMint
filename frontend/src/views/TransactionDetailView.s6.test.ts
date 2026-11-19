// @vitest-environment jsdom
/**
 * 0.6.0 S6 修改交易前端回归（编辑入口 / 固定文案 / 冲正徽章 / 提交形态）。
 *
 * 独立于既有 TransactionDetailView.test.ts（批 2 基线），只覆盖 S6 新行为：
 *   - 编辑入口不按 navigator.onLine 显隐（AC-5.4）：按钮保留、禁用态 + 固定文案；
 *   - 已冲正用固定文案「该交易已被冲正，请修改最新版本」，不得复用离线文案；
 *   - 详情页的「已冲正 / 冲正」徽章（AC-5.5）；**列表行的徽章语义已随 T38 迁到
 *     `TxnRow.test.ts`**（旧流水页下线，徽章归 `core/txnRow.ts` + `TxnRow.vue`）；
 *   - RecordSheet 编辑态提交形态：PATCH 载荷镜像 create（account_id 引用，AC-5.6）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import RecordSheet from '@/components/RecordSheet.vue'
import TrashView from '@/views/TrashView.vue'
import TransactionDetailView from '@/views/TransactionDetailView.vue'

const h = vi.hoisted(() => ({
  listTxns: vi.fn(),
  listAccounts: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  trash: vi.fn(),
  openEdit: vi.fn(),
  open: vi.fn(),
  isViewer: false,
  /** 编辑态注入点：getter 形式供 mock store 读取，用例挂载前赋值。 */
  sheetEditing: { value: null as Record<string, unknown> | null },
}))

vi.mock('@/api/client', () => ({
  accountApi: { list: h.listAccounts },
  transactionApi: {
    list: h.listTxns,
    remove: h.remove,
    update: h.update,
    create: h.create,
    trash: h.trash,
  },
  newIdempotencyKey: vi.fn(() => 'idem-1'),
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: {}, query: { id: '11' } }),
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    ledgerId: 7,
    isViewer: h.isViewer,
    defaultCommodity: 'CNY',
    ledgers: [],
  }),
}))

vi.mock('@/stores/privacy', () => ({
  usePrivacyStore: () => ({ enabled: false }),
}))

vi.mock('@/stores/recordSheet', () => ({
  useRecordSheetStore: () => ({
    get editingTxn() {
      return h.sheetEditing.value
    },
    savedEpoch: 0,
    openEdit: h.openEdit,
    open: h.open,
    close: vi.fn(),
    notifyChanged: vi.fn(),
    notifySaved: vi.fn(),
  }),
}))

const ACCOUNTS = {
  accounts: [
    { id: 1, uuid: 'a-1', name: 'Assets:Cash', display_name: '招商储蓄', type: 'Assets', open_date: '2026-01-01', sort_order: 0 },
    { id: 2, uuid: 'a-2', name: 'Expenses:Food', display_name: '食品饮料', type: 'Expenses', open_date: '2026-01-01', sort_order: 0 },
  ],
}

function txnFixture(extra: Record<string, unknown> = {}) {
  return {
    transactions: [
      {
        id: 11,
        uuid: 't-11',
        date: '2026-11-09',
        flag: '*',
        description: '午餐',
        created_by_name: '阿文',
        can_edit: true,
        postings: [
          { account_id: 2, account: 'Expenses:Food', commodity: 'CNY', amount: '38.50' },
          { account_id: 1, account: 'Assets:Cash', commodity: 'CNY', amount: '-38.50' },
        ],
        ...extra,
      },
    ],
  }
}

beforeEach(() => {
  h.isViewer = false
  h.listTxns.mockReset()
  h.listTxns.mockResolvedValue(txnFixture())
  h.listAccounts.mockReset()
  h.listAccounts.mockResolvedValue(ACCOUNTS)
  h.remove.mockReset()
  h.update.mockReset()
  h.create.mockReset()
  h.trash.mockReset()
  h.openEdit.mockReset()
})

afterEach(() => {
  // 恢复可能被个别用例改写的 navigator.onLine（defineProperty 可覆写回默认在线态）。
  setOnline(true)
})

function setOnline(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', {
    value,
    configurable: true,
  })
}

describe('S6-A：详情页编辑入口（AC-5.4 / AC-5.2）', () => {
  it('can_edit=true：按钮可用，点击经 store.openEdit 打开编辑态', async () => {
    const wrapper = mount(TransactionDetailView)
    await flushPromises()
    const editBtn = wrapper.findAll('button').find((b) => b.text() === '修改这笔交易')!
    expect(editBtn.attributes('disabled')).toBeUndefined()
    await editBtn.trigger('click')
    expect(h.openEdit).toHaveBeenCalledTimes(1)
    expect(h.openEdit.mock.calls[0][0]).toMatchObject({ uuid: 't-11', can_edit: true })
    wrapper.unmount()
  })

  it('已冲正：按钮禁用 + 固定文案「该交易已被冲正，请修改最新版本」（不复用离线文案）', async () => {
    h.listTxns.mockResolvedValue(txnFixture({ can_edit: true, reversed_by: 'rev-1' }))
    const wrapper = mount(TransactionDetailView)
    await flushPromises()
    const editBtn = wrapper.findAll('button').find((b) => b.text() === '修改这笔交易')!
    expect(editBtn.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('该交易已被冲正，请修改最新版本')
    expect(wrapper.text()).not.toContain('修改需联网')
    await editBtn.trigger('click')
    expect(h.openEdit).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('离线：按钮保留但禁用 + 固定文案「修改需联网」（不按 onLine 隐藏入口）', async () => {
    setOnline(false)
    const wrapper = mount(TransactionDetailView)
    await flushPromises()
    const editBtn = wrapper.findAll('button').find((b) => b.text() === '修改这笔交易')!
    expect(editBtn).toBeDefined() // 按钮保留
    expect(editBtn.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('修改需联网')
    await editBtn.trigger('click')
    expect(h.openEdit).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('can_edit 缺省（服务端未授权）：禁用 + 无权文案', async () => {
    h.listTxns.mockResolvedValue(txnFixture({ can_edit: undefined }))
    const wrapper = mount(TransactionDetailView)
    await flushPromises()
    const editBtn = wrapper.findAll('button').find((b) => b.text() === '修改这笔交易')!
    expect(editBtn.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('当前账号无权修改该交易')
    wrapper.unmount()
  })
})

describe('S6-B：冲正徽章（AC-5.5）', () => {
  it('详情页：reversed_by → 「已冲正」；reversal_of → 「冲正」；普通交易无徽章', async () => {
    const plain = mount(TransactionDetailView)
    await flushPromises()
    expect(plain.text()).not.toContain('已冲正')
    expect(plain.text()).not.toContain('冲正正') // 防误匹配
    plain.unmount()

    h.listTxns.mockResolvedValue(txnFixture({ can_edit: false, reversed_by: 'rev-1' }))
    const reversed = mount(TransactionDetailView)
    await flushPromises()
    expect(reversed.text()).toContain('已冲正')
    reversed.unmount()

    h.listTxns.mockResolvedValue(txnFixture({ can_edit: false, reversal_of: 't-10' }))
    const reversal = mount(TransactionDetailView)
    await flushPromises()
    expect(reversal.text()).toContain('冲正')
    reversal.unmount()
  })
})

describe('S6-D：回收站 can_restore 显隐（AC-5.8）', () => {
  function trashFixture(canRestore: boolean | undefined) {
    return {
      transactions: [
        {
          uuid: 't-9',
          date: '2026-11-01',
          flag: '*',
          description: '已删交易',
          tags: [],
          deleted_at: '2026-11-02T10:00:00Z',
          created_by_name: '阿文',
          can_restore: canRestore,
          postings: [],
        },
      ],
    }
  }

  it('can_restore=true：恢复按钮可见；viewer（false）：按钮隐藏但仍可查看列表', async () => {
    h.trash.mockResolvedValue(trashFixture(true))
    const editor = mount(TrashView)
    await flushPromises()
    expect(editor.text()).toContain('已删交易')
    expect(editor.findAll('button').some((b) => b.text() === '恢复')).toBe(true)
    editor.unmount()

    h.trash.mockResolvedValue(trashFixture(false))
    const viewer = mount(TrashView)
    await flushPromises()
    expect(viewer.text()).toContain('已删交易') // viewer 仍可查看回收站
    expect(viewer.findAll('button').some((b) => b.text() === '恢复')).toBe(false)
    expect(viewer.text()).toContain('只读成员不能恢复')
    viewer.unmount()
  })
})

describe('S6-C：RecordSheet 编辑态提交形态（AC-5.6 / AC-5.4）', () => {
  const editTxnFixture = () => ({
    id: 11,
    uuid: 't-11',
    date: '2026-11-09',
    flag: '*',
    description: '午餐',
    created_by_name: '阿文',
    can_edit: true,
    postings: [
      { account_id: 2, account: 'Expenses:Food', commodity: 'CNY', amount: '38.50' },
      { account_id: 1, account: 'Assets:Cash', commodity: 'CNY', amount: '-38.50' },
    ],
  })

  beforeEach(() => {
    h.sheetEditing.value = null
  })

  it('编辑态挂载：预填并展示冲正提示；PATCH 以原 uuid 调用、载荷镜像 create（account_id 引用）', async () => {
    h.update.mockResolvedValue({ original_uuid: 't-11', reversal_uuid: 'rev-1', new_uuid: 't-new' })
    h.sheetEditing.value = editTxnFixture()
    const wrapper = mount(RecordSheet)
    await flushPromises()

    expect(wrapper.text()).toContain('修改交易')
    expect(wrapper.text()).toContain('原交易将被冲正')
    expect(wrapper.text()).toContain('午餐')

    // 键盘「保存」→ submit → 编辑分支（PATCH，无幂等键、无离线兜底）。
    // 编辑态进入高级双录，键盘隐藏，唯一保存入口在底部操作区 .rs-foot。
    const saveBtn = wrapper.find('.rs-foot button.fb-btn-primary')
    await saveBtn.trigger('click')
    await flushPromises()

    expect(h.update).toHaveBeenCalledTimes(1)
    expect(h.update.mock.calls[0][0]).toBe('t-11')
    const body = h.update.mock.calls[0][1] as Record<string, unknown>
    expect(body.description).toBe('午餐')
    expect(body.date).toBe('2026-11-09')
    expect(body.postings).toEqual([
      { account_id: 2, commodity: 'CNY', amount: '38.50' },
      { account_id: 1, commodity: 'CNY', amount: '-38.50' },
    ])
    expect(Object.keys(body)).toEqual(
      expect.arrayContaining(['date', 'flag', 'description', 'postings']),
    )
    expect(Object.keys(body)).not.toContain('uuid')
    expect(Object.keys(body)).not.toContain('created_by')
    expect(Object.keys(body)).not.toContain('ledger_id')
    // 编辑分支绝不走离线 create 兜底（AC-5.4：saveOffline 语义不受影响、编辑不触达）。
    expect(h.create).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('网络失败：固定文案「修改需联网，请恢复网络后重试」，绝不落入离线保存', async () => {
    const { ApiError } = await import('@/api/errors')
    h.update.mockRejectedValue(new ApiError(0, 'network', { code: 'network_error' }))
    h.sheetEditing.value = editTxnFixture()
    const wrapper = mount(RecordSheet)
    await flushPromises()

    // 编辑态进入高级双录，键盘隐藏，唯一保存入口在底部操作区 .rs-foot。
    const saveBtn = wrapper.find('.rs-foot button.fb-btn-primary')
    await saveBtn.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('修改需联网，请恢复网络后重试')
    expect(wrapper.text()).not.toContain('已保存在本机')
    expect(h.create).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
