// @vitest-environment jsdom
/**
 * 壳层 en 渲染抽查（i18n 阶段 1）：
 * 切到 en 后壳层组件（底栏 / 侧栏 / 同步徽标）输出英文文案，
 * 且导航项 label（getter + t()）随之响应。
 *
 * 用例结束一律复位 zh-CN：测试环境默认语言是 zh-CN，不复位会污染后续文件。
 */
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import SyncBadge from '@/components/SyncBadge.vue'
import { setLocale } from '@/i18n'

import ShellSidebar from './ShellSidebar.vue'
import ShellTabs from './ShellTabs.vue'

vi.mock('@/stores/sync', () => ({
  useSyncStore: () => ({
    deadCount: 0,
    pendingCount: 2,
    status: 'idle',
  }),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

afterEach(() => {
  setLocale('zh-CN')
})

describe('壳层 en 渲染抽查', () => {
  it('ShellTabs：底栏可访问名与 FAB 为英文，Tab 短名随 navItems 切英文', () => {
    setLocale('en')
    const wrapper = mount(ShellTabs, { props: { activePath: '/' } })
    expect(wrapper.find('nav.tb').attributes('aria-label')).toBe('Bottom navigation')
    expect(wrapper.find('.tb__fab').attributes('aria-label')).toBe('New entry')
    const labels = wrapper.findAll('.tb__label').map((node) => node.text())
    expect(labels).toEqual(['Bills', 'Stats', 'Assets', 'More'])
    wrapper.unmount()
  })

  it('ShellSidebar：品牌副标题、「管理」折叠组与主导航名为英文', () => {
    setLocale('en')
    const wrapper = mount(ShellSidebar)
    expect(wrapper.find('.sb__brand-sub').text()).toBe('Shared family ledger')
    expect(wrapper.find('.sb__summary').text()).toContain('Manage · 10')
    expect(wrapper.find('nav.sb__nav').attributes('aria-label')).toBe('Main navigation')
    wrapper.unmount()
  })

  it('SyncBadge：待同步徽标文案与可访问名为英文', () => {
    setLocale('en')
    const wrapper = mount(SyncBadge)
    expect(wrapper.find('.sb__text').text()).toBe('Pending 2')
    expect(wrapper.find('.sb').attributes('aria-label')).toBe('Sync status: Pending 2')
    wrapper.unmount()
  })
})
