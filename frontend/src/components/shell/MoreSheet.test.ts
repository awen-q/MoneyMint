// @vitest-environment jsdom
/**
 * MoreSheet 回归（T23a）：
 * - 复用 SelectSheet：open=false 不渲染，open=true 得到 role=dialog + aria-label 更多；
 * - 三段结构：10 个管理项 + 修改密码 + 退出登录，段间有分隔（3 个 section）；
 * - **不放「记一笔」**（D-4：FAB 是唯一记账入口）；
 * - 三类事件：select(item) / changePassword / logout，行高满足 44px。
 */
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import MoreSheet from './MoreSheet.vue'

beforeEach(() => {
  document.body.innerHTML = ''
  document.body.style.position = ''
  document.body.style.top = ''
  document.body.style.overflow = ''
  Object.defineProperty(window, 'scrollY', { value: 0, writable: true, configurable: true })
  Object.defineProperty(window, 'scrollTo', { value: vi.fn(), writable: true, configurable: true })
})

describe('MoreSheet：渲染', () => {
  it('open=false 不渲染弹层', () => {
    const wrapper = mount(MoreSheet, { props: { open: false } })
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(wrapper.find('.ms__row').exists()).toBe(false)
  })

  it('open=true 渲染 dialog，标题与读屏名都是「更多」', () => {
    const wrapper = mount(MoreSheet, { props: { open: true } })
    const dialog = wrapper.find('[role="dialog"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.attributes('aria-modal')).toBe('true')
    expect(dialog.attributes('aria-label')).toBe('更多')
    expect(dialog.find('.ss-title').text()).toBe('更多')
  })

  it('三段结构：10 管理项 + 修改密码 + 退出登录', () => {
    const wrapper = mount(MoreSheet, { props: { open: true } })
    expect(wrapper.findAll('.ms__group')).toHaveLength(3)
    // 10 + 1 + 1
    expect(wrapper.findAll('.ms__row')).toHaveLength(12)
    expect(wrapper.text()).toContain('回收站')
    expect(wrapper.text()).toContain('设置')
    expect(wrapper.text()).toContain('修改密码')
    expect(wrapper.text()).toContain('退出登录')
  })

  it('不放「记一笔」（FAB 是唯一记账入口）', () => {
    const wrapper = mount(MoreSheet, { props: { open: true } })
    expect(wrapper.findAll('.ms__row')).toHaveLength(12)
    expect(wrapper.text()).not.toContain('记一笔')
  })
})

describe('MoreSheet：事件', () => {
  it('点管理项 emit select(item)', async () => {
    const wrapper = mount(MoreSheet, { props: { open: true } })
    await wrapper.findAll('.ms__row')[0].trigger('click')
    const emitted = wrapper.emitted('select')
    expect(emitted).toHaveLength(1)
    expect(emitted?.[0]?.[0]).toMatchObject({ label: '回收站', to: '/trash', ready: true })
  })

  it('点修改密码 emit changePassword', async () => {
    const wrapper = mount(MoreSheet, { props: { open: true } })
    const rows = wrapper.findAll('.ms__row')
    await rows[10].trigger('click')
    expect(wrapper.emitted('changePassword')).toHaveLength(1)
    expect(wrapper.emitted('select')).toBeUndefined()
  })

  it('点退出登录 emit logout', async () => {
    const wrapper = mount(MoreSheet, { props: { open: true } })
    const rows = wrapper.findAll('.ms__row')
    await rows[11].trigger('click')
    expect(wrapper.emitted('logout')).toHaveLength(1)
  })

  it('关闭按钮 emit close', async () => {
    const wrapper = mount(MoreSheet, { props: { open: true } })
    await wrapper.find('.ss-close').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
