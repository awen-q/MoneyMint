// @vitest-environment jsdom
/**
 * ShellTabs 回归（T23）：
 * - 4 个 Tab + 中央 FAB，且 **FAB 是第 3 个 DOM 子节点**（LO-14：3 等分里塞
 *   54px 上溢 FAB 会压住中间格文字，所以必须是 5 格且 FAB 居第 3 格）；
 * - FAB emit record（唯一记账入口）、「更多」emit more 且不 emit select；
 * - 路由 Tab 只 emit select，不自己 push；
 * - 当前 Tab 高亮口径。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import { MOBILE_TABS } from './navItems'
import ShellTabs from './ShellTabs.vue'

describe('ShellTabs：结构', () => {
  it('4 个 Tab，文案顺序为 账单 / 统计 / 资产 / 更多', () => {
    const wrapper = mount(ShellTabs)
    const labels = wrapper.findAll('.tb__tab').map((tab) => tab.find('.tb__label').text())
    expect(labels).toEqual(['账单', '统计', '资产', '更多'])
  })

  it('FAB 是第 3 个 DOM 子节点（视觉即第 3 格）', () => {
    const wrapper = mount(ShellTabs)
    const children = Array.from(wrapper.find('.tb').element.children)
    expect(children).toHaveLength(5)
    expect((children[2] as HTMLElement).classList.contains('tb__fab')).toBe(true)
    expect(children[2].getAttribute('aria-label')).toBe('记一笔')
  })
})

describe('ShellTabs：事件', () => {
  it('FAB emit record', async () => {
    const wrapper = mount(ShellTabs)
    await wrapper.find('.tb__fab').trigger('click')
    expect(wrapper.emitted('record')).toHaveLength(1)
  })

  it('「更多」emit more 且不 emit select', async () => {
    const wrapper = mount(ShellTabs)
    const tabs = wrapper.findAll('.tb__tab')
    await tabs[3].trigger('click')
    expect(wrapper.emitted('more')).toHaveLength(1)
    expect(wrapper.emitted('select')).toBeUndefined()
  })

  it('路由 Tab emit 对应项（可用性由父级判定，组件不拦）', async () => {
    const wrapper = mount(ShellTabs)
    await wrapper.findAll('.tb__tab')[1].trigger('click')
    const emitted = wrapper.emitted('select')
    expect(emitted).toHaveLength(1)
    expect(emitted?.[0]?.[0]).toMatchObject({ key: MOBILE_TABS[1].key, to: '/stats' })
  })
})

describe('ShellTabs：高亮', () => {
  it('当前路径对应的 Tab 高亮，其余不高亮', () => {
    const wrapper = mount(ShellTabs, { props: { activePath: '/assets' } })
    const tabs = wrapper.findAll('.tb__tab')
    expect(tabs[2].classes()).toContain('tb__tab--on')
    expect(tabs[0].classes()).not.toContain('tb__tab--on')
    expect(tabs[2].attributes('aria-current')).toBe('page')
  })

  it('首页高亮第一个 Tab', () => {
    const wrapper = mount(ShellTabs, { props: { activePath: '/' } })
    expect(wrapper.findAll('.tb__tab')[0].classes()).toContain('tb__tab--on')
  })

  it('「更多」永不高亮（它不是路由）', () => {
    const wrapper = mount(ShellTabs, { props: { activePath: '/more' } })
    expect(wrapper.findAll('.tb__tab')[3].classes()).not.toContain('tb__tab--on')
  })
})
