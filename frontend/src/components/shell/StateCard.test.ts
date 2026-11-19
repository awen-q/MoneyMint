// @vitest-environment jsdom
/**
 * StateCard 回归（T17）：
 * - loading：一行「正在加载…」+ role=status；
 * - error：标题「加载失败」+ 说明 + 默认「重试」按钮，**绝不渲染任何金额**（无 ¥、无数字）；
 *   error 态也不渲染默认插槽——调用方把金额节点塞进插槽也透不出来；
 * - empty：默认「暂无数据」，动作按钮仅在传 actionText 时出现；
 * - ready：渲染默认插槽；
 * - 点动作按钮 emit action。
 */
import { mount } from '@vue/test-utils'
import { enableAutoUnmount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import StateCard from './StateCard.vue'

// 自动卸载只能注册一次，必须在模块顶层。
enableAutoUnmount(afterEach)

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('StateCard：loading', () => {
  it('渲染「正在加载…」并带 role=status', () => {
    const wrapper = mount(StateCard, { props: { state: 'loading' } })
    expect(wrapper.text()).toContain('正在加载')
    expect(wrapper.find('[role="status"]').exists()).toBe(true)
    // 加载中同样不出现金额占位
    expect(wrapper.text()).not.toContain('¥')
  })
})

describe('StateCard：error 态红线', () => {
  it('标题默认「加载失败」，且整块不含 ¥ 与任何数字金额', () => {
    const wrapper = mount(StateCard, {
      props: { state: 'error', desc: '网络异常，请稍后重试' },
    })
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('加载失败')
    expect(wrapper.text()).toContain('网络异常，请稍后重试')
    expect(wrapper.text()).not.toContain('¥')
    expect(wrapper.text()).not.toMatch(/[0-9]/)
  })

  it('error 态不渲染默认插槽（金额节点塞进来也透不出）', () => {
    const wrapper = mount(StateCard, {
      props: { state: 'error' },
      slots: { default: '<p class="amount">¥0.00</p>' },
    })
    expect(wrapper.find('.amount').exists()).toBe(false)
    expect(wrapper.html()).not.toContain('¥')
  })

  it('点重试 emit action', async () => {
    const wrapper = mount(StateCard, { props: { state: 'error' } })
    const button = wrapper.find('.sc-btn')
    expect(button.text()).toBe('重试')
    await button.trigger('click')
    expect(wrapper.emitted('action')).toHaveLength(1)
  })

  it('actionDisabled 时按钮禁用且点击无效', async () => {
    const wrapper = mount(StateCard, { props: { state: 'error', actionDisabled: true } })
    const button = wrapper.find('.sc-btn')
    expect(button.attributes('disabled')).toBeDefined()
    await button.trigger('click')
    // 原生 disabled 按钮不触发 click 处理器
    expect(wrapper.emitted('action')).toBeUndefined()
  })
})

describe('StateCard：empty', () => {
  it('默认标题「暂无数据」，未传 actionText 时不显示按钮', () => {
    const wrapper = mount(StateCard, { props: { state: 'empty' } })
    expect(wrapper.find('.sc-box__title').text()).toBe('暂无数据')
    expect(wrapper.find('.sc-btn').exists()).toBe(false)
  })

  it('传 actionText 时渲染动作按钮并可 emit action', async () => {
    const wrapper = mount(StateCard, {
      props: { state: 'empty', actionText: '记一笔' },
    })
    await wrapper.find('.sc-btn').trigger('click')
    expect(wrapper.find('.sc-btn').text()).toBe('记一笔')
    expect(wrapper.emitted('action')).toHaveLength(1)
  })
})

describe('StateCard：ready', () => {
  it('渲染默认插槽且不出现占位框', () => {
    const wrapper = mount(StateCard, {
      props: { state: 'ready' },
      slots: { default: '<p class="payload">内容</p>' },
    })
    expect(wrapper.find('.payload').exists()).toBe(true)
    expect(wrapper.find('.sc-box').exists()).toBe(false)
    expect(wrapper.find('.sc-loading').exists()).toBe(false)
  })
})
