// @vitest-environment jsdom
/**
 * M2 组件回归：P-19 导入向导（ImportView）
 *
 * 守住 m2-plan §5 / RK-M2-04：解析失败整体拒绝且**一次列出全部错误行**；
 * 有效时展示账本名（去重后）与计数；疑似重复导入仅提示不阻断。
 * 0.6.0 S5：新增 target=current|new 目标切换（默认 current）。
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

// 视图里「去账本页查看」走具名路由，用 memory router 挂载验证跳转。
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
    title: '家庭账本',
    target: 'new',
    ledger_name: '家庭账本',
    new_accounts: 3,
    reuse_accounts: 0,
    new_transactions: 12,
    skip_transactions: 0,
    new_commodities: 2,
    pad_balance: [],
    conflicts: [],
    duplicate: false,
  })
  h.execute.mockResolvedValue({
    mode: 'new',
    ledger_id: 9,
    ledger_name: '家庭账本',
    import_batch_id: 'imp-1',
    created_transactions: 12,
    skipped_transactions: 0,
    reused_accounts: 0,
    new_accounts: 3,
    new_commodities: 2,
  })
})

async function pasteAndPreview(wrapper: ReturnType<typeof mount>, text: string): Promise<void> {
  await wrapper.find('textarea').setValue(text)
  await wrapper.findAll('button').find((b) => b.text() === '解析预览')!.trigger('click')
  await flushPromises()
}

// 切换到「新建独立账本」目标（账本名 / 疑似重复提示仅 new 模式展示）。
async function selectNewTarget(wrapper: ReturnType<typeof mount>): Promise<void> {
  await wrapper.findAll('button').find((b) => b.text() === '新建独立账本')!.trigger('click')
}

describe('M2-D：解析预览', () => {
  it('文本为空时预览按钮禁用', () => {
    const wrapper = mount(ImportView, { global: { plugins: [router] } })
    const btn = wrapper.findAll('button').find((b) => b.text() === '解析预览')!
    expect(btn.attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('默认目标是「导入到当前账本」并随请求上送（0.6.0 S5）', async () => {
    const wrapper = mount(ImportView, { global: { plugins: [router] } })
    expect(wrapper.text()).toContain('导入到当前账本')
    await pasteAndPreview(wrapper, 'option "title" "x"\n')
    expect(h.preview).toHaveBeenCalledWith('option "title" "x"\n', 'current')
    wrapper.unmount()
  })

  it('有效文本（new 模式）：展示去重账本名与计数', async () => {
    const wrapper = mount(ImportView, { global: { plugins: [router] } })
    await selectNewTarget(wrapper)
    await pasteAndPreview(wrapper, 'option "title" "家庭账本"\n')
    const text = wrapper.text()
    expect(text).toContain('确认导入内容')
    expect(text).toContain('家庭账本')
    expect(text).toContain('12') // 交易数
    expect(h.preview).toHaveBeenCalledWith('option "title" "家庭账本"\n', 'new')
    wrapper.unmount()
  })

  it('疑似重复导入（new 模式）：提示但不阻断（执行按钮仍可用）', async () => {
    h.preview.mockResolvedValue({
      valid: true,
      title: '家庭账本',
      target: 'new',
      ledger_name: '家庭账本 (2)',
      new_accounts: 3,
      reuse_accounts: 0,
      new_transactions: 12,
      skip_transactions: 0,
      new_commodities: 2,
      pad_balance: [],
      conflicts: [],
      duplicate: true,
    })
    const wrapper = mount(ImportView, { global: { plugins: [router] } })
    await selectNewTarget(wrapper)
    await pasteAndPreview(wrapper, 'option "title" "家庭账本"\n')
    expect(wrapper.text()).toContain('疑似重复导入')
    expect(wrapper.text()).toContain('家庭账本 (2)')
    const execBtn = wrapper.findAll('button').find((b) => b.text() === '执行导入')!
    expect(execBtn.attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })
})

describe('M2-E：整体拒绝路径（RK-M2-04）', () => {
  it('不支持语法：一次列出全部错误行号，且不给执行入口', async () => {
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
      conflicts: [],
      duplicate: false,
      errors: [
        { line: 1, msg: '不支持的指令 balance' },
        { line: 4, msg: '不支持的指令 include' },
        { line: 9, msg: '不支持 cost 注解' },
      ],
      error: '文件含不支持的语法，已整体拒绝',
    })
    const wrapper = mount(ImportView, { global: { plugins: [router] } })
    await pasteAndPreview(wrapper, 'balance\ninclude\ncost\n')
    const text = wrapper.text()
    expect(text).toContain('预检未通过，已整体拒绝')
    expect(text).toContain('第 1 行')
    expect(text).toContain('第 4 行')
    expect(text).toContain('第 9 行')
    expect(wrapper.findAll('button').find((b) => b.text() === '执行导入')).toBeUndefined()
    wrapper.unmount()
  })

  it('账本冲突（0.6.0 S5）：逐项列出冲突原因，不给执行入口', async () => {
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
        { line: 0, type: 'account_conflict', name: 'Assets:Cash', reason: '类型冲突：账本为 Liabilities，文件为 Assets' },
        { line: 5, type: 'unbalanced', name: 'CNY', reason: '币种 CNY 借贷不平，差额 50.00' },
      ],
      duplicate: false,
    })
    const wrapper = mount(ImportView, { global: { plugins: [router] } })
    await pasteAndPreview(wrapper, 'open Assets:Cash\n')
    const text = wrapper.text()
    expect(text).toContain('预检未通过，已整体拒绝')
    expect(text).toContain('账户冲突')
    expect(text).toContain('Assets:Cash')
    expect(text).toContain('借贷不平')
    expect(wrapper.findAll('button').find((b) => b.text() === '执行导入')).toBeUndefined()
    wrapper.unmount()
  })
})

describe('M2-F：执行与结果', () => {
  it('执行成功（new 模式）：展示结果卡，「去账本页查看」跳具名路由', async () => {
    const wrapper = mount(ImportView, { global: { plugins: [router] } })
    await selectNewTarget(wrapper)
    await pasteAndPreview(wrapper, 'option "title" "家庭账本"\n')
    await wrapper.findAll('button').find((b) => b.text() === '执行导入')!.trigger('click')
    await flushPromises()

    expect(h.execute).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('导入完成')
    expect(wrapper.text()).toContain('家庭账本')

    await wrapper.findAll('button').find((b) => b.text() === '去账本页查看')!.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('ledgers')
    wrapper.unmount()
  })

  it('执行失败：展示映射文案，预检结果不被清除', async () => {
    h.execute.mockRejectedValue(new ApiError(500, '服务端导入失败'))
    const wrapper = mount(ImportView, { global: { plugins: [router] } })
    await pasteAndPreview(wrapper, 'option "title" "家庭账本"\n')
    await wrapper.findAll('button').find((b) => b.text() === '执行导入')!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('服务端导入失败，未产生任何账本')
    expect(wrapper.text()).toContain('确认导入内容')
    wrapper.unmount()
  })
})
