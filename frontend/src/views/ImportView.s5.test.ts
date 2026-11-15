// @vitest-environment jsdom
/**
 * 0.6.0 S5 导入升级回归（ImportView 目标切换 / 冲突清单 / pad-balance 预览 / 批次撤销）。
 *
 * 独立于既有 ImportView.test.ts（M2 基线），只覆盖 S5 新行为：
 *   - target=current|new 目标切换，随预检 / 执行请求上送；
 *   - current 模式摘要展示复用 / 跳过计数；
 *   - 预检冲突清单逐项渲染（AC-6.3 / AC-6.5 / AC-6.8）；
 *   - pad/balance 结构化预览表 + current 模式不支持提示（AC-6.8）；
 *   - 导入成功后的批次撤销入口与撤销结果（AC-6.9）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'

import { ApiError } from '@/api/errors'
import ImportView from './ImportView.vue'

const h = vi.hoisted(() => ({
  preview: vi.fn(),
  execute: vi.fn(),
  undo: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  importApi: { preview: h.preview, execute: h.execute, undo: h.undo },
}))

const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/ledgers', name: 'ledgers', component: { template: '<div/>' } }],
})

beforeEach(() => {
  h.preview.mockReset()
  h.execute.mockReset()
  h.undo.mockReset()
  h.preview.mockResolvedValue({
    valid: true,
    title: '',
    target: 'current',
    ledger_name: '',
    new_accounts: 1,
    reuse_accounts: 2,
    new_transactions: 4,
    skip_transactions: 1,
    new_commodities: 0,
    pad_balance: [],
    conflicts: [],
    duplicate: false,
  })
  h.execute.mockResolvedValue({
    mode: 'current',
    ledger_id: 7,
    ledger_name: '',
    import_batch_id: 'imp-abc',
    created_transactions: 4,
    skipped_transactions: 1,
    reused_accounts: 2,
    new_accounts: 1,
    new_commodities: 0,
  })
  h.undo.mockResolvedValue({
    removed_transactions: 4,
    removed_postings: 8,
    removed_prices: 1,
    removed_accounts: 1,
    removed_commodities: 1,
  })
})

async function pasteAndPreview(wrapper: ReturnType<typeof mount>, text: string): Promise<void> {
  await wrapper.find('textarea').setValue(text)
  await wrapper.findAll('button').find((b) => b.text() === '解析预览')!.trigger('click')
  await flushPromises()
}

describe('S5-A：目标切换', () => {
  it('默认 current，可切到 new，且 target 随预检与执行请求上送', async () => {
    const wrapper = mount(ImportView, { global: { plugins: [router] } })
    await pasteAndPreview(wrapper, '2024-01-01 open Assets:Cash\n')
    expect(h.preview).toHaveBeenCalledWith('2024-01-01 open Assets:Cash\n', 'current')

    await wrapper.findAll('button').find((b) => b.text() === '新建独立账本')!.trigger('click')
    await wrapper.findAll('button').find((b) => b.text() === '解析预览')!.trigger('click')
    await flushPromises()
    expect(h.preview).toHaveBeenLastCalledWith('2024-01-01 open Assets:Cash\n', 'new')

    await wrapper.findAll('button').find((b) => b.text() === '执行导入')!.trigger('click')
    await flushPromises()
    expect(h.execute).toHaveBeenCalledWith('2024-01-01 open Assets:Cash\n', 'new')
    wrapper.unmount()
  })

  it('current 模式摘要展示复用账户与跳过重复计数', async () => {
    const wrapper = mount(ImportView, { global: { plugins: [router] } })
    await pasteAndPreview(wrapper, '2024-01-01 open Assets:Cash\n')
    const text = wrapper.text()
    expect(text).toContain('复用账户')
    expect(text).toContain('跳过交易（已存在）')
    wrapper.unmount()
  })
})

describe('S5-B：冲突清单与 pad/balance 预览', () => {
  it('预检冲突逐项渲染（账户冲突 / 借贷不平），不给执行入口', async () => {
    h.preview.mockResolvedValue({
      valid: false,
      title: '',
      target: 'current',
      ledger_name: '',
      new_accounts: 0,
      reuse_accounts: 0,
      new_transactions: 0,
      skip_transactions: 0,
      new_commodities: 0,
      pad_balance: [],
      conflicts: [
        { line: 0, type: 'account_conflict', name: 'Assets:Cash', reason: '币种限制冲突：账本为 "CNY"，文件为 ""' },
        { line: 5, type: 'unbalanced', name: 'CNY', reason: '币种 CNY 借贷不平，差额 50.00' },
        { line: 0, type: 'commodity_conflict', name: 'CNY', reason: '精度冲突：账本为 2 位，文件为 4 位' },
      ],
      duplicate: false,
    })
    const wrapper = mount(ImportView, { global: { plugins: [router] } })
    await pasteAndPreview(wrapper, '2024-01-01 open Assets:Cash\n')
    const text = wrapper.text()
    expect(text).toContain('账户冲突')
    expect(text).toContain('Assets:Cash')
    expect(text).toContain('借贷不平')
    expect(text).toContain('币种冲突')
    expect(wrapper.findAll('button').find((b) => b.text() === '执行导入')).toBeUndefined()
    wrapper.unmount()
  })

  it('pad/balance 结构化预览：current 模式展示累计/差额与不支持提示', async () => {
    h.preview.mockResolvedValue({
      valid: false,
      title: '',
      target: 'current',
      ledger_name: '',
      new_accounts: 0,
      reuse_accounts: 0,
      new_transactions: 0,
      skip_transactions: 0,
      new_commodities: 0,
      pad_balance: [
        { line: 9, type: 'balance', account: 'Assets:Cash', target_amount: '0.00', cumulative: '80.00', diff: '-80.00' },
      ],
      conflicts: [
        { line: 0, type: 'pad_balance_unsupported', name: '', reason: '当前账本模式不支持 pad/balance 指令' },
      ],
      duplicate: false,
    })
    const wrapper = mount(ImportView, { global: { plugins: [router] } })
    await pasteAndPreview(wrapper, '2024-03-01 balance Assets:Cash 0 CNY\n')
    const text = wrapper.text()
    expect(text).toContain('pad / balance 指令')
    expect(text).toContain('Assets:Cash')
    expect(text).toContain('80.00')
    expect(text).toContain('不支持 pad/balance')
    wrapper.unmount()
  })
})

describe('S5-C：批次撤销（AC-6.9）', () => {
  it('导入成功后展示批次标识与撤销入口，撤销后展示回滚明细', async () => {
    const wrapper = mount(ImportView, { global: { plugins: [router] } })
    await pasteAndPreview(wrapper, '2024-01-01 open Assets:Cash\n')
    await wrapper.findAll('button').find((b) => b.text() === '执行导入')!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('imp-abc')
    const undoBtn = wrapper.findAll('button').find((b) => b.text() === '撤销本次导入')
    expect(undoBtn).toBeDefined()
    await undoBtn!.trigger('click')
    await flushPromises()

    expect(h.undo).toHaveBeenCalledWith('imp-abc')
    const text = wrapper.text()
    expect(text).toContain('已撤销')
    expect(text).toContain('交易 4')
    expect(text).toContain('账户 1')
    wrapper.unmount()
  })

  it('撤销失败（如批次不存在 404）：展示映射文案，不误报已撤销', async () => {
    h.undo.mockRejectedValue(new ApiError(404, '未找到该导入批次，无法撤销'))
    const wrapper = mount(ImportView, { global: { plugins: [router] } })
    await pasteAndPreview(wrapper, '2024-01-01 open Assets:Cash\n')
    await wrapper.findAll('button').find((b) => b.text() === '执行导入')!.trigger('click')
    await flushPromises()
    await wrapper.findAll('button').find((b) => b.text() === '撤销本次导入')!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('未找到该导入批次')
    expect(wrapper.text()).not.toContain('已撤销')
    wrapper.unmount()
  })
})
