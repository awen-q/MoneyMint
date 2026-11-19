// @vitest-environment jsdom
/**
 * SelectSheet 底座回归（T12）：
 * - open=false 不渲染任何弹层节点；open=true 渲染 role=dialog + aria-modal；
 * - aria-label 取 dialogLabel，未传则退回 title；
 * - ESC / 点遮罩 触发 close；
 * - 打开时 body 用 fixed + 负 top 锁滚动，关闭后内联样式清空且 scrollY 按原值精确还原；
 * - 焦点移入面板、Tab 在面板内循环、关闭后归还触发元素。
 */
import { nextTick } from 'vue'

import { mount } from '@vue/test-utils'
import { enableAutoUnmount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import SelectSheet from './SelectSheet.vue'

/** window.scrollY 在 jsdom 里恒为 0，这里改成可写，模拟「页面已滚到 240px」。 */
function setScrollY(value: number): void {
  Object.defineProperty(window, 'scrollY', { value, writable: true, configurable: true })
}

/** 记录 scrollTo 调用；jsdom 的 scrollTo 是空实现，必须替换掉才能断言还原值。 */
function stubScrollTo(): ReturnType<typeof vi.fn> {
  const spy = vi.fn()
  Object.defineProperty(window, 'scrollTo', { value: spy, writable: true, configurable: true })
  return spy
}

let scrollToSpy: ReturnType<typeof vi.fn>

// 自动卸载只能注册一次，必须在模块顶层；每个用例结束都会卸载，保证滚动锁深度归零。
enableAutoUnmount(afterEach)

beforeEach(() => {
  // 上一个用例若中途失败，body 上可能残留锁样式；在每个用例开始时统一清理。
  document.body.innerHTML = ''
  document.body.style.position = ''
  document.body.style.top = ''
  document.body.style.left = ''
  document.body.style.right = ''
  document.body.style.width = ''
  document.body.style.overflow = ''
  setScrollY(0)
  scrollToSpy = stubScrollTo()
})

describe('SelectSheet：渲染与关闭', () => {
  it('open=false 时不渲染弹层', () => {
    const wrapper = mount(SelectSheet, { props: { open: false, title: '选择月份' } })
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(wrapper.find('.ss-mask').exists()).toBe(false)
    expect(wrapper.find('.ss-panel').exists()).toBe(false)
  })

  it('open=true 时渲染 role=dialog / aria-modal，且 aria-label 取 title', () => {
    const wrapper = mount(SelectSheet, { props: { open: true, title: '选择月份' } })
    const dialog = wrapper.find('[role="dialog"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.attributes('aria-modal')).toBe('true')
    expect(dialog.attributes('aria-label')).toBe('选择月份')
    expect(wrapper.find('.ss-handle').exists()).toBe(true)
  })

  it('dialogLabel 覆盖 aria-label', () => {
    const wrapper = mount(SelectSheet, {
      props: { open: true, title: '选择月份', dialogLabel: '选择账期月份' },
    })
    expect(wrapper.find('[role="dialog"]').attributes('aria-label')).toBe('选择账期月份')
  })

  it('ESC 触发 close', () => {
    const wrapper = mount(SelectSheet, { props: { open: true, title: '选择月份' } })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('点遮罩触发 close，点面板内部不触发', async () => {
    const wrapper = mount(SelectSheet, { props: { open: true, title: '选择月份' } })
    await wrapper.find('.ss-panel').trigger('click')
    expect(wrapper.emitted('close')).toBeUndefined()
    await wrapper.find('.ss-mask').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('关闭按钮带可访问名并触发 close', async () => {
    const wrapper = mount(SelectSheet, { props: { open: true, title: '选择月份' } })
    const button = wrapper.find('.ss-close')
    expect(button.attributes('aria-label')).toBe('关闭选择月份')
    await button.trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})

describe('SelectSheet：滚动锁', () => {
  it('打开时 body 以 fixed + 负 top 锁住，关闭后清空内联样式', async () => {
    setScrollY(240)
    const wrapper = mount(SelectSheet, { props: { open: true, title: '选择月份' } })

    expect(document.body.style.position).toBe('fixed')
    expect(document.body.style.top).toBe('-240px')
    expect(document.body.style.overflow).toBe('hidden')

    await wrapper.setProps({ open: false })

    expect(document.body.style.position).toBe('')
    expect(document.body.style.top).toBe('')
    expect(document.body.style.left).toBe('')
    expect(document.body.style.right).toBe('')
    expect(document.body.style.width).toBe('')
    expect(document.body.style.overflow).toBe('')
  })

  it('关闭时按打开前的 scrollY 精确还原（误差为 0）', async () => {
    setScrollY(137)
    const wrapper = mount(SelectSheet, { props: { open: true, title: '选择月份' } })
    await wrapper.setProps({ open: false })

    expect(scrollToSpy).toHaveBeenCalledTimes(1)
    expect(scrollToSpy).toHaveBeenCalledWith(0, 137)
  })

  it('未走关闭流程直接卸载时也解锁滚动', () => {
    setScrollY(60)
    const wrapper = mount(SelectSheet, { props: { open: true, title: '选择月份' } })
    wrapper.unmount()

    expect(document.body.style.position).toBe('')
    expect(document.body.style.top).toBe('')
    expect(scrollToSpy).toHaveBeenCalledWith(0, 60)
  })
})

describe('SelectSheet：焦点管理', () => {
  // 焦点相关用例必须 attachTo document.body：脱离文档的元素在 jsdom 里拿不到焦点。
  it('打开时焦点移入面板内第一个可聚焦元素', async () => {
    const wrapper = mount(SelectSheet, {
      props: { open: true, title: '选择月份' },
      slots: { default: '<button type="button" class="slot-a">A</button>' },
      attachTo: document.body,
    })
    await nextTick()
    await nextTick()

    expect(document.activeElement).toBe(wrapper.find('.ss-close').element)
  })

  it('Tab 在面板内循环：末位再 Tab 回到首位', async () => {
    const wrapper = mount(SelectSheet, {
      props: { open: true, title: '选择月份' },
      slots: { default: '<button type="button" class="slot-a">A</button>' },
      attachTo: document.body,
    })
    await nextTick()
    await nextTick()

    const slotButton = wrapper.find('.slot-a').element as HTMLElement
    slotButton.focus()
    expect(document.activeElement).toBe(slotButton)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))
    expect(document.activeElement).toBe(wrapper.find('.ss-close').element)
  })

  it('Shift+Tab 从首位回绕到末位', async () => {
    const wrapper = mount(SelectSheet, {
      props: { open: true, title: '选择月份' },
      slots: { default: '<button type="button" class="slot-a">A</button>' },
      attachTo: document.body,
    })
    await nextTick()
    await nextTick()

    const slotButton = wrapper.find('.slot-a').element as HTMLElement
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }),
    )
    expect(document.activeElement).toBe(slotButton)
  })

  it('关闭后焦点归还触发元素', async () => {
    const wrapper = mount(SelectSheet, {
      props: { open: false, title: '选择月份' },
      attachTo: document.body,
    })
    const trigger = document.createElement('button')
    trigger.type = 'button'
    document.body.appendChild(trigger)
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    await wrapper.setProps({ open: true })
    await nextTick()
    await nextTick()
    expect(document.activeElement).toBe(wrapper.find('.ss-close').element)

    await wrapper.setProps({ open: false })
    expect(document.activeElement).toBe(trigger)
  })
})

describe('SelectSheet：插槽', () => {
  it('默认插槽渲染内容，未提供 footer 时不渲染页脚', () => {
    const wrapper = mount(SelectSheet, {
      props: { open: true, title: '选择月份' },
      slots: { default: '<p class="body-content">内容</p>' },
    })
    expect(wrapper.find('.body-content').exists()).toBe(true)
    expect(wrapper.find('.ss-foot').exists()).toBe(false)
  })

  it('提供 footer 插槽时渲染页脚', () => {
    const wrapper = mount(SelectSheet, {
      props: { open: true, title: '选择月份' },
      slots: { footer: '<button type="button" class="foot-btn">确定</button>' },
    })
    expect(wrapper.find('.ss-foot').exists()).toBe(true)
    expect(wrapper.find('.foot-btn').exists()).toBe(true)
  })
})
