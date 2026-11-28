// @vitest-environment jsdom
/**
 * 「更多」弹层手动刷新入口：中文文案、点击只触发 refresh，不误触导航 / 账号 / 会话。
 */
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import MoreSheet from '@/components/shell/MoreSheet.vue'

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('MoreSheet 手动刷新入口', () => {
  it('渲染「刷新页面」且点击只 emit refresh', async () => {
    // SelectSheet 关闭时会精确还原 scrollY；jsdom 未实现 scrollTo。
    vi.stubGlobal('scrollTo', vi.fn())
    window.scrollTo = vi.fn()
    const wrapper = mount(MoreSheet, {
      props: { open: true },
      attachTo: document.body,
    })

    expect(wrapper.text()).toContain('刷新页面')
    const row = wrapper.findAll('button').find((button) => button.text().includes('刷新页面'))
    expect(row).toBeDefined()
    await row?.trigger('click')

    expect(wrapper.emitted('refresh')).toHaveLength(1)
    expect(wrapper.emitted('select')).toBeUndefined()
    expect(wrapper.emitted('changePassword')).toBeUndefined()
    expect(wrapper.emitted('logout')).toBeUndefined()

    wrapper.unmount()
  })
})
