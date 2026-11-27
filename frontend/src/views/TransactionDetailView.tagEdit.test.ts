// @vitest-environment jsdom
/**
 * 标签原地更新 P0 —— 详情页 US1 / US2 视图层用例。
 *
 * US1（改错别字 / 加标签）：chip 区旁进入轻量编辑器 → 提交 tags + base_tags →
 *   用响应回显更新 chip；主流水仍 1 行、can_edit 保持 true；二级编辑记录可见。
 * US2（删标签）：清空全部标签提交 tags: []；筛选立即失效由服务端 ?tag= 保证，
 *   前端本层只断言视图与请求形态。
 * 横切：离线入口禁用且文案与经济事实「修改需联网」区分；can_edit=false 禁用；
 *   409 conflict 展示 current_tags 并可新 base 重试。
 *
 * 硬边界用例：标签保存绝不调用整包 transactionApi.update（PATCH 冲正路径）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import { ApiError } from '@/api/errors'
import { buildTxnRow } from '@/core/txnRow'
import TxnRow from '@/components/TxnRow.vue'
import TransactionDetailView from '@/views/TransactionDetailView.vue'

const h = vi.hoisted(() => ({
  listTxns: vi.fn(),
  listAccounts: vi.fn(),
  updateTags: vi.fn(),
  listTagEdits: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  accountApi: { list: h.listAccounts },
  transactionApi: {
    list: h.listTxns,
    remove: h.remove,
    update: h.update,
    updateTags: h.updateTags,
    listTagEdits: h.listTagEdits,
  },
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

vi.mock('@/stores/privacy', () => ({
  usePrivacyStore: () => ({ enabled: false }),
}))

vi.mock('@/stores/recordSheet', () => ({
  useRecordSheetStore: () => ({
    savedEpoch: 0,
    openEdit: vi.fn(),
    open: vi.fn(),
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
        tags: ['餐饮'],
        postings: [
          { account_id: 2, account: 'Expenses:Food', commodity: 'CNY', amount: '38.50' },
          { account_id: 1, account: 'Assets:Cash', commodity: 'CNY', amount: '-38.50' },
        ],
        ...extra,
      },
    ],
  }
}

function setOnline(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', { value, configurable: true })
}

async function mountDetail(extra: Record<string, unknown> = {}) {
  h.listTxns.mockResolvedValue(txnFixture(extra))
  const wrapper = mount(TransactionDetailView)
  await flushPromises()
  return wrapper
}

async function openEditor(wrapper: ReturnType<typeof mount>): Promise<void> {
  const entry = wrapper.find('[data-testid="tag-edit-open"]')
  expect(entry.attributes('disabled')).toBeUndefined()
  await entry.trigger('click')
  await flushPromises()
  expect(wrapper.find('[data-testid="tag-inline-editor"]').exists()).toBe(true)
}

beforeEach(() => {
  setOnline(true)
  localStorage.clear()
  h.listAccounts.mockReset().mockResolvedValue(ACCOUNTS)
  h.listTxns.mockReset().mockResolvedValue(txnFixture())
  h.updateTags.mockReset().mockResolvedValue({
    uuid: 't-11',
    tags: ['周末', '餐饮'],
    tags_updated_at: '2026-11-27T09:31:12.345Z',
    edit_id: 42,
  })
  h.listTagEdits.mockReset().mockResolvedValue({
    edits: [
      {
        id: 42,
        action: 'replace',
        old_tags: ['餐饮'],
        new_tags: ['周末', '餐饮'],
        actor_id: 7,
        actor_name: '张伟',
        device_id: 'dev-iphone-01',
        ts: '2026-11-27T09:31:12.345Z',
      },
    ],
  })
  h.update.mockReset()
  h.remove.mockReset()
})

afterEach(() => {
  setOnline(true)
})

describe('US1：详情页就地改标签', () => {
  it('chip 旁有独立「编辑标签」入口，与整包「修改这笔交易」按钮不合并', async () => {
    const wrapper = await mountDetail()
    const entry = wrapper.find('[data-testid="tag-edit-entry"]')
    expect(entry.exists()).toBe(true)
    expect(entry.text()).toContain('餐饮')
    expect(entry.text()).toContain('编辑标签')
    // 经济事实按钮仍在，且是另一个按钮。
    expect(wrapper.findAll('button').some((b) => b.text() === '修改这笔交易')).toBe(true)
    expect(wrapper.find('[data-testid="tag-inline-editor"]').exists()).toBe(false)
  })

  it('加标签：提交规范化 tags + 进入时快照 base_tags，用响应回显更新 chip', async () => {
    const wrapper = await mountDetail()
    await openEditor(wrapper)

    const input = wrapper.find('#tag-inline-input-t-11')
    await input.setValue('  周末  ')
    const addBtn = wrapper.findAll('button').find((b) => b.text() === '添加')!
    await addBtn.trigger('click')
    await wrapper.find('[data-testid="tag-save"]').trigger('click')
    await flushPromises()

    expect(h.updateTags).toHaveBeenCalledTimes(1)
    expect(h.updateTags).toHaveBeenCalledWith(
      't-11',
      expect.objectContaining({
        tags: ['周末', '餐饮'],
        base_tags: ['餐饮'],
        device_id: expect.any(String),
      }),
    )
    // 用响应回显而非本地拼接；编辑器关闭，chip 区立即显示新值。
    expect(wrapper.find('[data-testid="tag-inline-editor"]').exists()).toBe(false)
    const entry = wrapper.find('[data-testid="tag-edit-entry"]')
    expect(entry.text()).toContain('周末')
    expect(entry.text()).toContain('餐饮')
    expect(wrapper.find('[data-testid="tag-edit-hint"]').text()).toContain('仍可再次编辑')
    // 硬边界：绝不碰整包 PATCH。
    expect(h.update).not.toHaveBeenCalled()
  })

  it('trim / 丢空 / 精确去重（大小写敏感）后再提交', async () => {
    const wrapper = await mountDetail()
    await openEditor(wrapper)
    const input = wrapper.find('#tag-inline-input-t-11')
    await input.setValue('   周末   ')
    await wrapper.findAll('button').find((b) => b.text() === '添加')!.trigger('click')
    await input.setValue('周末')
    await wrapper.findAll('button').find((b) => b.text() === '添加')!.trigger('click')
    await input.setValue('   ')
    await wrapper.findAll('button').find((b) => b.text() === '添加')!.trigger('click')
    await wrapper.find('[data-testid="tag-save"]').trigger('click')
    await flushPromises()
    expect(h.updateTags.mock.calls[0][1].tags).toEqual(['周末', '餐饮'])
  })

  it('主流水仍 1 行：PUT 后 uuid 与交易条数不变，can_edit 保持 true', async () => {
    const wrapper = await mountDetail()
    await openEditor(wrapper)
    await wrapper.find('[data-testid="tag-save"]').trigger('click')
    await flushPromises()
    expect(h.listTxns.mock.results[0].value).toBeDefined()
    const entry = wrapper.find('[data-testid="tag-edit-entry"]')
    expect(entry.attributes('disabled')).toBeUndefined()
    // 小票票尾仍是同一 uuid 的短码（shortCode('t-11') = 't11'）。
    expect(wrapper.text()).toContain('TXN t11')
    expect(wrapper.findAll('[data-testid="tag-edit-entry"]')).toHaveLength(1)
  })

  it('二级「编辑记录」默认收起，展开才拉 GET 并渲染 old → new / actor / ts', async () => {
    const wrapper = await mountDetail()
    const history = wrapper.find('[data-testid="tag-edit-history"]')
    expect(history.exists()).toBe(true)
    expect(history.find('.detail__history-body').exists()).toBe(false)
    expect(h.listTagEdits).not.toHaveBeenCalled()

    await history.find('button').trigger('click')
    await flushPromises()

    expect(h.listTagEdits).toHaveBeenCalledTimes(1)
    expect(h.listTagEdits).toHaveBeenCalledWith('t-11')
    const body = history.find('.detail__history-body')
    expect(body.text()).toContain('修改标签')
    expect(body.text()).toContain('餐饮')
    expect(body.text()).toContain('周末')
    expect(body.text()).toContain('张伟')
    expect(body.text()).toContain('dev-iphone-01')
    // 升级前无记录的一行说明，避免误以为从来没改过。
    expect(body.text()).toContain('升级前的标签改动没有记录')
  })
})

describe('US2：删标签（tags: []）', () => {
  it('移除全部标签后提交空数组，chip 区显示「暂无标签」', async () => {
    // 用响应回显的空 tags 更新视图（服务端规范化后回显，前端不自行拼）。
    h.updateTags.mockResolvedValue({
      uuid: 't-11',
      tags: [],
      tags_updated_at: '2026-11-27T09:40:00.000Z',
      edit_id: 43,
    })
    const wrapper = await mountDetail()
    await openEditor(wrapper)
    await wrapper.find('.tag-inline__chip-remove').trigger('click')
    await wrapper.find('[data-testid="tag-save"]').trigger('click')
    await flushPromises()

    expect(h.updateTags.mock.calls[0][1]).toEqual(
      expect.objectContaining({ tags: [], base_tags: ['餐饮'] }),
    )
    expect(wrapper.find('[data-testid="tag-edit-entry"]').text()).toContain('暂无标签')
    expect(h.update).not.toHaveBeenCalled()
  })

  it('编辑记录保留删除动作（old=[A] / new=[]）', async () => {
    h.listTagEdits.mockResolvedValue({
      edits: [
        {
          id: 43,
          action: 'replace',
          old_tags: ['餐饮'],
          new_tags: [],
          actor_id: 7,
          actor_name: '张伟',
          device_id: '',
          ts: '2026-11-27T10:00:00.000Z',
        },
      ],
    })
    const wrapper = await mountDetail()
    await wrapper.find('[data-testid="tag-edit-history"] button').trigger('click')
    await flushPromises()
    const body = wrapper.find('.detail__history-body')
    expect(body.text()).toContain('张伟')
    expect(body.text()).toContain('餐饮')
    expect(body.text()).toContain('未记录')
  })
})

describe('横切：离线 / 权限 / 冲突', () => {
  it('P0 离线：入口禁用 + 专属文案，与经济事实「修改需联网」明确区分', async () => {
    setOnline(false)
    const wrapper = await mountDetail()
    const entry = wrapper.find('[data-testid="tag-edit-open"]')
    expect(entry.attributes('disabled')).toBeDefined()
    const hint = wrapper.find('[data-testid="tag-edit-hint"]').text()
    expect(hint).toBe('标签编辑暂需联网，离线编辑将在后续版本支持')
    expect(hint).not.toBe('修改需联网')
    // 经济事实按钮保留且仍用原文案。
    expect(wrapper.text()).toContain('修改需联网')
    await entry.trigger('click')
    expect(wrapper.find('[data-testid="tag-inline-editor"]').exists()).toBe(false)
  })

  it('can_edit=false（viewer / 已冲正）：入口禁用并复用服务端判定', async () => {
    const wrapper = await mountDetail({ can_edit: false })
    expect(wrapper.find('[data-testid="tag-edit-open"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="tag-edit-hint"]').text()).toBe('当前账号无权修改该交易的标签')
  })

  it('409 conflict：展示 current_tags，允许以最新值为新 base 重试', async () => {
    h.updateTags
      .mockRejectedValueOnce(
        new ApiError(409, '标签已被他人更新', {
          code: 'txn_tags_conflict',
          details: {
            current_tags: ['餐饮', '孩子'],
            current_tags_updated_at: '2026-11-27T10:00:00.000Z',
          },
        }),
      )
      .mockResolvedValueOnce({
        uuid: 't-11',
        tags: ['周末', '餐饮', '孩子'],
        tags_updated_at: '2026-11-27T10:01:00.000Z',
        edit_id: 43,
      })

    const wrapper = await mountDetail()
    await openEditor(wrapper)
    const input = wrapper.find('#tag-inline-input-t-11')
    await input.setValue('周末')
    await wrapper.findAll('button').find((b) => b.text() === '添加')!.trigger('click')
    await wrapper.find('[data-testid="tag-save"]').trigger('click')
    await flushPromises()

    const panel = wrapper.find('[data-testid="tag-conflict"]')
    expect(panel.exists()).toBe(true)
    expect(panel.text()).toContain('孩子')
    expect(panel.text()).toContain('标签已被他人更新')
    expect(h.updateTags).toHaveBeenCalledTimes(1)

    const retry = panel.findAll('button').find((b) => b.text() === '用最新标签重试')!
    await retry.trigger('click')
    await flushPromises()

    expect(h.updateTags).toHaveBeenCalledTimes(2)
    expect(h.updateTags.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        base_tags: ['餐饮', '孩子'],
        tags: ['周末', '餐饮'],
      }),
    )
    expect(wrapper.find('[data-testid="tag-edit-entry"]').text()).toContain('周末')
  })

  it('列表 chip 进入同一个编辑器：现取完整 tags 作为 base，不触发整行 open', async () => {
    const view = buildTxnRow(
      {
        id: 11,
        uuid: 't-11',
        date: '2026-11-09',
        flag: '*',
        description: '午餐',
        created_by_name: '阿文',
        can_edit: true,
        tags: ['餐饮'],
        postings: [
          { account_id: 2, account: 'Expenses:Food', commodity: 'CNY', amount: '38.50' },
          { account_id: 1, account: 'Assets:Cash', commodity: 'CNY', amount: '-38.50' },
        ],
      },
      ACCOUNTS.accounts,
      'bill',
    )
    const wrapper = mount(TxnRow, { props: { view, variant: 'bill' } })
    const chip = wrapper.find('.txn-row__tag-chip')
    expect(chip.exists()).toBe(true)
    await chip.trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="tag-inline-editor"]').exists()).toBe(true)
    expect(wrapper.emitted('open')).toBeUndefined()
    // 编辑器 base_tags 来自现取的完整 tags，而非 bill 档截断后的展示值。
    await wrapper.find('[data-testid="tag-save"]').trigger('click')
    await flushPromises()
    expect(h.updateTags.mock.calls[0][1].base_tags).toEqual(['餐饮'])
  })

  it('409 且 current_tags 已等于目标 tags：按结果幂等视为成功，不报错', async () => {
    h.updateTags.mockRejectedValueOnce(
      new ApiError(409, '标签已被他人更新', {
        code: 'txn_tags_conflict',
        details: { current_tags: ['餐饮'], current_tags_updated_at: '2026-11-27T10:00:00.000Z' },
      }),
    )
    const wrapper = await mountDetail()
    await openEditor(wrapper)
    // 目标未改动（仍等于进入时的 ['餐饮']），重放撞 409 应视为成功。
    await wrapper.find('[data-testid="tag-save"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="tag-inline-editor"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tag-conflict"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tag-edit-entry"]').text()).toContain('餐饮')
  })
})
