// @vitest-environment jsdom
/**
 * P1 同步徽标：文案必须带「数量 + 下一步」，按可处置状态分档。
 * 旧 store 桩（无 retryingCount）保持既有文案，避免壳层 i18n 抽查回归。
 */
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import SyncBadge from '@/components/SyncBadge.vue'

interface MockTopError {
  code: string
  message: string
  at: number
  phase: string
}

const h = vi.hoisted(() => ({
  sync: {
    deadCount: 0,
    pendingCount: 0,
    retryingCount: 0 as number | undefined,
    topError: undefined as MockTopError | undefined,
    status: 'idle' as string,
  },
  push: vi.fn(),
}))

vi.mock('@/stores/sync', () => ({ useSyncStore: () => h.sync }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: h.push }) }))

beforeEach(() => {
  h.sync.deadCount = 0
  h.sync.pendingCount = 0
  h.sync.retryingCount = 0
  h.sync.topError = undefined
  h.sync.status = 'idle'
  h.push.mockClear()
})

async function render(): Promise<ReturnType<typeof mount>> {
  const wrapper = mount(SyncBadge)
  await nextTick()
  return wrapper
}

describe('P1：SyncBadge 可处置状态文案', () => {
  it('全部正常 → 无徽标', async () => {
    const wrapper = await render()
    expect(wrapper.find('.sb').exists()).toBe(false)
  })

  it('仅重试中 → 「N 笔重试中」，警告色，不写「同步失败」', async () => {
    h.sync.pendingCount = 3
    h.sync.retryingCount = 3
    const wrapper = await render()
    expect(wrapper.find('.sb__text').text()).toBe('3 笔重试中')
    expect(wrapper.find('.sb__dot').classes()).toContain('sb__dot--warn')
    expect(wrapper.text()).not.toContain('同步失败')
  })

  it('仅死信 → 严重文案；混合 → 两类数量并列', async () => {
    h.sync.deadCount = 2
    const deadOnly = await render()
    expect(deadOnly.find('.sb__text').text()).toBe('同步受阻 · 2 笔需处理')
    expect(deadOnly.find('.sb__dot').classes()).toContain('sb__dot--err')
    deadOnly.unmount()

    h.sync.retryingCount = 4
    h.sync.pendingCount = 4
    const mixed = await render()
    expect(mixed.find('.sb__text').text()).toBe('同步受阻 · 2 笔需处理 · 4 笔重试中')
    mixed.unmount()
  })

  it('顶层错误 → 短原因 + pending chip 副标', async () => {
    h.sync.topError = { code: 'network_error', message: 'net down', at: 1, phase: 'pull' }
    h.sync.retryingCount = 1
    h.sync.pendingCount = 1
    const wrapper = await render()
    expect(wrapper.find('.sb__text').text()).toContain('网络连接失败')
    expect(wrapper.find('.sb__sub').text()).toBe('待同步 1')
    expect(wrapper.text()).not.toContain('同步失败')
  })

  it('旧 store 桩无 retryingCount → 保留旧文案', async () => {
    h.sync.retryingCount = undefined
    h.sync.pendingCount = 2
    const wrapper = await render()
    expect(wrapper.find('.sb__text').text()).toBe('待同步 2')
  })
})
