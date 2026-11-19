// @vitest-environment jsdom
/**
 * YearPicker 回归（T14）：
 * - 12 年一页，最后一页只渲染到 maxYear；
 * - 首页「上一页」禁用、末页「下一页」禁用；
 * - 点年份 emit select(year) 并紧接着 emit close；
 * - 越界 value 会被夹到 [minYear, maxYear]，不会出现空白页。
 */
import { mount } from '@vue/test-utils'
import { enableAutoUnmount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import YearPicker from './YearPicker.vue'

// 自动卸载只能注册一次，必须在模块顶层。
enableAutoUnmount(afterEach)

beforeEach(() => {
  document.body.innerHTML = ''
  Object.defineProperty(window, 'scrollY', { value: 0, writable: true, configurable: true })
  Object.defineProperty(window, 'scrollTo', { value: vi.fn(), writable: true, configurable: true })
})

describe('YearPicker：翻页边界', () => {
  it('首页「上一页」禁用', () => {
    const wrapper = mount(YearPicker, {
      props: { open: true, value: 2026, minYear: 2026, maxYear: 2050 },
    })
    const arrows = wrapper.findAll('.yp-arrow')
    expect(arrows).toHaveLength(2)
    expect(arrows[0].attributes('disabled')).toBeDefined()
    expect(arrows[1].attributes('disabled')).toBeUndefined()
    expect(wrapper.findAll('.yp-cell')).toHaveLength(12)
    expect(wrapper.find('.yp-year__label').text()).toBe('2026 – 2037')
  })

  it('末页「下一页」禁用，且最后一页只渲染到 maxYear', async () => {
    const wrapper = mount(YearPicker, {
      props: { open: true, value: 2026, minYear: 2026, maxYear: 2050 },
    })
    await wrapper.findAll('.yp-arrow')[1].trigger('click')
    await wrapper.findAll('.yp-arrow')[1].trigger('click')

    const arrows = wrapper.findAll('.yp-arrow')
    expect(wrapper.find('.yp-year__label').text()).toBe('2050')
    expect(wrapper.findAll('.yp-cell')).toHaveLength(1)
    expect(arrows[0].attributes('disabled')).toBeUndefined()
    expect(arrows[1].attributes('disabled')).toBeDefined()
  })

  it('中间页两侧箭头都可用', async () => {
    const wrapper = mount(YearPicker, {
      props: { open: true, value: 2026, minYear: 2026, maxYear: 2050 },
    })
    await wrapper.findAll('.yp-arrow')[1].trigger('click')

    const arrows = wrapper.findAll('.yp-arrow')
    expect(arrows[0].attributes('disabled')).toBeUndefined()
    expect(arrows[1].attributes('disabled')).toBeUndefined()
    expect(wrapper.find('.yp-year__label').text()).toBe('2038 – 2049')
  })
})

describe('YearPicker：选择', () => {
  it('点年份 emit select(year) 并关闭', async () => {
    // 页首 = 2024（minYear 对齐），第三格即 2026
    const wrapper = mount(YearPicker, {
      props: { open: true, value: 2024, minYear: 2024, maxYear: 2100 },
    })
    await wrapper.findAll('.yp-cell')[2].trigger('click')

    expect(wrapper.emitted('select')).toHaveLength(1)
    expect(wrapper.emitted('select')?.[0]).toEqual([2026])
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('当前选中年份高亮', () => {
    const wrapper = mount(YearPicker, {
      props: { open: true, value: 2025, minYear: 2024, maxYear: 2100 },
    })
    const cells = wrapper.findAll('.yp-cell')
    expect(cells[1].classes()).toContain('yp-cell--on')
    expect(cells[0].classes()).not.toContain('yp-cell--on')
  })

  it('越界 value 夹到 minYear，页面不空', () => {
    const wrapper = mount(YearPicker, {
      props: { open: true, value: 1900, minYear: 2025, maxYear: 2050 },
    })
    expect(wrapper.findAll('.yp-cell').length).toBeGreaterThan(0)
    expect(wrapper.findAll('.yp-cell')[0].text()).toBe('2025')
  })
})
