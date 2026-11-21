// @vitest-environment jsdom
/**
 * ShellSidebar 回归（T22）：
 * - 5 项直达 + `管理 · 10` 折叠组（10 项逐条）；
 * - **不含 `aria-hidden`**（LO-15：PC 上它是唯一主导航，隐藏后读屏全丢）；
 * - 当前路由高亮（含子路径）；
 * - 只 emit，不自己跳转（可用性由 AppLayout 判定）；
 * - PC 唯一的记账入口「＋ 记一笔」仍在。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import { APP_VERSION, isPrerelease } from '@/core/appVersion'
import { NAV_MAIN } from './navItems'
import ShellSidebar from './ShellSidebar.vue'

describe('ShellSidebar：结构', () => {
  it('5 项直达 + 折叠组里 10 项', () => {
    const wrapper = mount(ShellSidebar)
    expect(wrapper.findAll('.sb__item--sub')).toHaveLength(10)
    // 5 个直达 + 10 个管理项（summary 是 <summary>，不在 button 里）
    expect(wrapper.findAll('button.sb__item')).toHaveLength(15)
    expect(wrapper.find('.sb__summary').text()).toContain('管理 · 10')
  })

  it('主导航不带 aria-hidden（读屏必须能拿到 PC 主航）', () => {
    const wrapper = mount(ShellSidebar)
    expect(wrapper.find('.sb').attributes('aria-hidden')).toBeUndefined()
    expect(wrapper.find('nav').attributes('aria-hidden')).toBeUndefined()
    expect(wrapper.find('summary').attributes('aria-hidden')).toBeUndefined()
    // 唯一允许 aria-hidden 的是纯装饰图标 span，导航项本身必须可达
    const hidden = wrapper.findAll('[aria-hidden="true"]')
    expect(hidden.length).toBeGreaterThan(0)
    for (const node of hidden) {
      expect(node.classes()).toContain('sb__ico')
    }
  })

  it('折叠组用原生 details/summary（展开态由浏览器维护）', () => {
    const wrapper = mount(ShellSidebar)
    expect(wrapper.find('details.sb__group').exists()).toBe(true)
    expect(wrapper.find('details.sb__group > summary.sb__summary').exists()).toBe(true)
  })

  it('底部常驻版本号，预览版只打角标不弹窗', () => {
    const wrapper = mount(ShellSidebar)
    expect(wrapper.find('.sb__version').text()).toMatch(/^v\d+\.\d+\.\d+/)
    expect(wrapper.find('.sb__preview').exists()).toBe(isPrerelease(APP_VERSION.version))
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
  })
})

describe('ShellSidebar：高亮', () => {
  it('精确命中当前路由', () => {
    const wrapper = mount(ShellSidebar, { props: { activePath: '/accounts' } })
    const active = wrapper.findAll('.sb__item--on')
    expect(active).toHaveLength(1)
    expect(active[0].text()).toContain('账户管理')
    expect(active[0].attributes('aria-current')).toBe('page')
  })

  it('子路径仍高亮父入口', () => {
    const wrapper = mount(ShellSidebar, { props: { activePath: '/accounts/12' } })
    expect(wrapper.findAll('.sb__item--on')[0].text()).toContain('账户管理')
  })

  it('首页只在 / 时高亮', () => {
    const onHome = mount(ShellSidebar, { props: { activePath: '/' } })
    expect(onHome.findAll('.sb__item--on')[0].text()).toContain('账单')
    const elsewhere = mount(ShellSidebar, { props: { activePath: '/settings' } })
    expect(elsewhere.findAll('.sb__item--on')[0].text()).toContain('设置')
  })
})

describe('ShellSidebar：事件', () => {
  it('点直达项 emit select，不自己 push', async () => {
    const wrapper = mount(ShellSidebar)
    await wrapper.findAll('button.sb__item')[0].trigger('click')
    const emitted = wrapper.emitted('select')
    expect(emitted).toHaveLength(1)
    expect((emitted?.[0]?.[0] as { key: string }).key).toBe(NAV_MAIN[0].key)
  })

  it('点管理项 emit 对应项', async () => {
    const wrapper = mount(ShellSidebar)
    await wrapper.findAll('.sb__item--sub')[2].trigger('click')
    const emitted = wrapper.emitted('select')
    expect(emitted?.[0]?.[0]).toMatchObject({ label: '分类管理', to: '/categories' })
  })

  it('点「＋ 记一笔」emit record（PC 唯一记账入口）', async () => {
    const wrapper = mount(ShellSidebar)
    await wrapper.find('.sb__cta').trigger('click')
    expect(wrapper.emitted('record')).toHaveLength(1)
  })
})
