// @vitest-environment jsdom
/**
 * P1 同步页契约：四段渲染、失败子集过滤、分组作用域、摘要三数一致、
 * 折叠阈值、二次确认与导出全文。正常 pending 绝不出现在失败列表。
 */
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import SyncStatusView from '@/views/SyncStatusView.vue'

interface MockEntry {
  id: number
  ledger_id: number
  state: 'pending' | 'dead'
  attempts: number
  next_retry_at: number
  last_error_code?: string
  last_error?: string
  display_label?: string
  entity_type?: string
  created_at?: number
  state_changed_at?: number
  change: { entity_type: string; key: string; entity: Record<string, unknown> }
}

const h = vi.hoisted(() => ({
  sync: {
    status: 'ok' as string,
    lastSyncAt: 1_700_000_000_000,
    pendingCount: 0,
    deadCount: 0,
    pendingItems: [] as MockEntry[],
    deadItems: [] as MockEntry[],
    retryingItems: [] as MockEntry[],
    retryingCount: 0,
    quietCount: 0,
    topError: undefined as { code: string; message: string; at: number; phase: string } | undefined,
    lastSyncSummary: undefined as
      | { success: number; retry: number; dead: number; at: number }
      | undefined,
    loadQueues: vi.fn().mockResolvedValue(undefined),
    syncNow: vi.fn().mockResolvedValue('ok'),
    retryPending: vi.fn().mockResolvedValue(undefined),
    reviveDead: vi.fn().mockResolvedValue(undefined),
    discardDead: vi.fn().mockResolvedValue(undefined),
  },
  health: vi.fn().mockResolvedValue({ status: 'ok', instance_id: 'ins-1' }),
}))

vi.mock('@/stores/sync', () => ({ useSyncStore: () => h.sync }))
vi.mock('@/stores/session', () => ({ useSessionStore: () => ({ ledgerName: '测试账本' }) }))
vi.mock('@/api/client', () => ({ syncStatusApi: { health: h.health } }))

function failed(id: number, label = `失败条目${id}`, code = 'server_busy'): MockEntry {
  return {
    id,
    ledger_id: 1,
    state: 'pending',
    attempts: 2,
    next_retry_at: 1_700_000_030_000 + id,
    last_error_code: code,
    last_error: '服务端繁忙，请稍后再试',
    display_label: label,
    entity_type: 'transaction',
    change: { entity_type: 'transaction', key: `k${id}`, entity: { uuid: `k${id}` } },
  }
}

function healthy(id: number): MockEntry {
  return {
    id,
    ledger_id: 1,
    state: 'pending',
    attempts: 0,
    next_retry_at: 0,
    display_label: `正常条目${id}`,
    entity_type: 'transaction',
    change: { entity_type: 'transaction', key: `h${id}`, entity: { uuid: `h${id}` } },
  }
}

function dead(id: number, changedAt = 1_700_000_000_000 + id): MockEntry {
  return {
    id,
    ledger_id: 1,
    state: 'dead',
    attempts: 1,
    next_retry_at: 0,
    last_error_code: 'account_closed',
    last_error: '账户已关闭，完整错误详情需要导出和复制',
    display_label: `死信${id}`,
    entity_type: 'transaction',
    state_changed_at: changedAt,
    change: { entity_type: 'transaction', key: `d${id}`, entity: { uuid: `d${id}` } },
  }
}

function setState(overrides: Partial<typeof h.sync> = {}): void {
  h.sync.status = 'ok'
  h.sync.lastSyncAt = 1_700_000_000_000
  h.sync.pendingCount = 0
  h.sync.deadCount = 0
  h.sync.pendingItems = []
  h.sync.deadItems = []
  h.sync.retryingItems = []
  h.sync.retryingCount = 0
  h.sync.quietCount = 0
  h.sync.topError = undefined
  h.sync.lastSyncSummary = undefined
  Object.assign(h.sync, overrides)
  h.sync.loadQueues.mockClear()
  h.sync.retryPending.mockClear()
  h.sync.reviveDead.mockClear()
  h.sync.discardDead.mockClear()
}

async function render(): Promise<VueWrapper> {
  const wrapper = mount(SyncStatusView)
  await flushPromises()
  return wrapper
}

beforeEach(() => setState())

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('P1：四段信息架构', () => {
  it('顶层错误 / 重试中 / 死信 / 摘要四段按序渲染', async () => {
    setState({
      topError: { code: 'network_error', message: 'net down', at: 1, phase: 'pull' },
      pendingItems: [failed(1)],
      deadItems: [dead(9)],
      pendingCount: 2,
      deadCount: 1,
      quietCount: 1,
      lastSyncSummary: { success: 1, retry: 1, dead: 1, at: 2 },
    })
    const wrapper = await render()
    const sections = wrapper.findAll('[data-section]').map((node) => node.attributes('data-section'))
    expect(sections.slice(0, 4)).toEqual(['top-error', 'retry', 'dead', 'summary'])
    expect(wrapper.find('.syn__top-reason').text()).toContain('网络')
    expect(wrapper.find('.syn__top-error details').text()).toContain('network_error')
    expect(wrapper.find('.syn__quiet').text()).toContain('1 条正常排队')
  })

  it('失败子集过滤：正常 pending 不进重试列表', async () => {
    setState({
      pendingItems: [healthy(1), failed(2, '失败-2', 'validation'), healthy(3)],
      pendingCount: 3,
      quietCount: 2,
    })
    const wrapper = await render()
    const rows = wrapper.findAll('.syn__retry .syn__row')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain('失败-2')
    expect(wrapper.find('.syn__retry').text()).not.toContain('正常条目')
    expect(wrapper.find('.syn__retry h2').text()).toContain('1 笔')
  })

  it('摘要条三数与列表行数一致；点「知道了」收起为单行', async () => {
    setState({
      pendingItems: [failed(1)],
      deadItems: [dead(2)],
      pendingCount: 2,
      deadCount: 1,
      quietCount: 1,
      lastSyncSummary: { success: 3, retry: 1, dead: 1, at: 42 },
    })
    const wrapper = await render()
    expect(wrapper.find('.syn__summary-text').text()).toBe('本次同步 · 成功 3 笔 · 待重试 1 笔 · 需处理 1 笔')
    expect(wrapper.findAll('.syn__retry .syn__row')).toHaveLength(1)
    expect(wrapper.findAll('.syn__dead .syn__row')).toHaveLength(1)
    await wrapper.find('.syn__summary-bar button').trigger('click')
    expect(wrapper.find('.syn__summary-text').exists()).toBe(false)
    expect(wrapper.find('.syn__summary-collapsed').text()).toContain('已收起')
  })

  it('分组阈值：单组 6 条只显示 5 条 + 展开剩余 1 条', async () => {
    setState({
      pendingItems: [1, 2, 3, 4, 5, 6].map((id) => failed(id)),
      pendingCount: 6,
      lastSyncSummary: { success: 0, retry: 6, dead: 0, at: 7 },
    })
    const wrapper = await render()
    expect(wrapper.findAll('.syn__retry .syn__row')).toHaveLength(5)
    expect(wrapper.find('.syn__retry .syn__more').text()).toContain('展开剩余 1 条')
    await wrapper.find('.syn__retry .syn__more').trigger('click')
    await nextTick()
    expect(wrapper.findAll('.syn__retry .syn__row')).toHaveLength(6)
  })
})

describe('P1：分组批量与二次确认', () => {
  it('全选限本组，不跨组', async () => {
    setState({
      pendingItems: [failed(1), failed(2)],
      deadItems: [dead(3), dead(4)],
      pendingCount: 2,
      deadCount: 2,
    })
    const wrapper = await render()
    await wrapper.find('.syn__select-all-retry').setValue(true)
    await nextTick()
    const retryChecks = wrapper.findAll('.syn__retry .syn__row input[type="checkbox"]')
    const deadChecks = wrapper.findAll('.syn__dead .syn__row input[type="checkbox"]')
    expect(retryChecks.every((node) => (node.element as HTMLInputElement).checked)).toBe(true)
    expect(deadChecks.some((node) => (node.element as HTMLInputElement).checked)).toBe(false)

    // 反向：死信全选不改动重试组的选中状态。
    await wrapper.find('.syn__select-all-dead').setValue(true)
    await nextTick()
    expect(wrapper.findAll('.syn__dead .syn__row input[type="checkbox"]').every((node) => (node.element as HTMLInputElement).checked)).toBe(true)

    await wrapper.find('.syn__batch-retry').trigger('click')
    expect(h.sync.retryPending).toHaveBeenCalledTimes(1)
    expect(h.sync.retryPending).toHaveBeenCalledWith([1, 2])
  })

  it('批量丢弃弹窗含条数与不可恢复警示，确认后才落库', async () => {
    setState({ deadItems: [dead(1), dead(2)], deadCount: 2 })
    const wrapper = await render()
    await wrapper.find('.syn__select-all-dead').setValue(true)
    await wrapper.find('.syn__batch-discard').trigger('click')
    expect(wrapper.find('[role="dialog"]').text()).toContain('2 条')
    expect(wrapper.find('[role="dialog"]').text()).toContain('不可恢复')
    expect(h.sync.discardDead).not.toHaveBeenCalled()
    await wrapper.find('[role="dialog"] .syn__btn--danger').trigger('click')
    // 死信按失败时间倒序，选中顺序即展示顺序；断言集合而非排列。
    expect(h.sync.discardDead).toHaveBeenCalledTimes(1)
    expect(h.sync.discardDead.mock.calls[0][0].slice().sort()).toEqual([1, 2])
  })
})

describe('P1：导出与复制', () => {
  it('死信导出 txt 带 last_error 全文', async () => {
    let captured: Blob | undefined
    Object.defineProperty(URL, 'createObjectURL', {
      value: (blob: Blob) => {
        captured = blob
        return 'blob:test'
      },
      configurable: true,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: () => undefined,
      configurable: true,
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    setState({
      deadItems: [dead(1)],
      deadCount: 1,
    })
    const wrapper = await render()
    await wrapper.find('.syn__dead .syn__head-actions button').trigger('click')
    expect(captured).toBeDefined()
    // jsdom 的 Blob 没有 text()：用 FileReader 读取导出的文本。
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result ?? ''))
      reader.onerror = () => reject(reader.error ?? new Error('read blob failed'))
      reader.readAsText(captured as Blob)
    })
    expect(text).toContain('last_error=账户已关闭，完整错误详情需要导出和复制')
  })

  it('复制错误详情走 clipboard，失败时给降级提示', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    setState({ pendingItems: [failed(1)], pendingCount: 1 })
    const wrapper = await render()
    await wrapper.find('.syn__retry .syn__row-actions .syn__link').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.syn__notice').text()).toBe('已复制错误详情')

    writeText.mockRejectedValueOnce(new Error('blocked'))
    await wrapper.find('.syn__retry .syn__row-actions .syn__link').trigger('click')
    await flushPromises()
    expect(wrapper.find('.syn__notice').text()).toBe('复制失败，请手动选择错误详情')
  })

  it('立即重试后按钮进入冷却，避免连点风暴', async () => {
    setState({ pendingItems: [failed(1)], pendingCount: 1 })
    const wrapper = await render()
    const button = wrapper.find('.syn__retry .syn__row-actions button')
    await button.trigger('click')
    await flushPromises()
    expect(h.sync.retryPending).toHaveBeenCalledWith([1])
    expect(wrapper.find('.syn__retry .syn__row-actions button').attributes('disabled')).toBeDefined()
  })
})
