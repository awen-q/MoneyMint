// @vitest-environment jsdom
/**
 * MonthPicker 回归（T13）：
 * - 12 宫格（3 列 × 4 行）恒定渲染；
 * - 年份箭头在 minYear / maxYear 边界 disabled，翻年后边界互换；
 * - 点月份 emit `select({year, month})` 并紧接着 emit close；
 * - 有数据月份右上角打点，无数据月份无点；
 * - 当前选中月份高亮。
 */
import { mount } from '@vue/test-utils'
import { enableAutoUnmount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import MonthPicker from './MonthPicker.vue'

// 自动卸载只能注册一次，必须在模块顶层。
enableAutoUnmount(afterEach)

beforeEach(() => {
  document.body.innerHTML = ''
  Object.defineProperty(window, 'scrollY', { value: 0, writable: true, configurable: true })
  Object.defineProperty(window, 'scrollTo', { value: vi.fn(), writable: true, configurable: true })
})

describe('MonthPicker：年份边界', () => {
  it('minYear 边界时「上一年」禁用、「下一年」可用', () => {
    const wrapper = mount(MonthPicker, {
      props: { open: true, value: { year: 2025, month: 8 }, minYear: 2025, maxYear: 2026 },
    })
    const arrows = wrapper.findAll('.mp-arrow')
    expect(arrows).toHaveLength(2)
    expect(arrows[0].attributes('disabled')).toBeDefined()
    expect(arrows[1].attributes('disabled')).toBeUndefined()
    expect(wrapper.find('.mp-year__label').text()).toBe('2025 年')
  })

  it('翻到 maxYear 后边界互换', async () => {
    const wrapper = mount(MonthPicker, {
      props: { open: true, value: { year: 2025, month: 8 }, minYear: 2025, maxYear: 2026 },
    })
    await wrapper.findAll('.mp-arrow')[1].trigger('click')

    const arrows = wrapper.findAll('.mp-arrow')
    expect(wrapper.find('.mp-year__label').text()).toBe('2026 年')
    expect(arrows[0].attributes('disabled')).toBeUndefined()
    expect(arrows[1].attributes('disabled')).toBeDefined()
  })

  it('越界点击箭头不会改变浏览年份', async () => {
    const wrapper = mount(MonthPicker, {
      props: { open: true, value: { year: 2025, month: 8 }, minYear: 2025, maxYear: 2025 },
    })
    await wrapper.findAll('.mp-arrow')[0].trigger('click')
    expect(wrapper.find('.mp-year__label').text()).toBe('2025 年')
  })
})

describe('MonthPicker：选择', () => {
  it('12 个月份格子恒定渲染', () => {
    const wrapper = mount(MonthPicker, {
      props: { open: true, value: { year: 2026, month: 1 }, minYear: 2000, maxYear: 2100 },
    })
    expect(wrapper.findAll('.mp-cell')).toHaveLength(12)
  })

  it('点月份 emit 正确 payload 并关闭', async () => {
    const wrapper = mount(MonthPicker, {
      props: { open: true, value: { year: 2026, month: 1 }, minYear: 2000, maxYear: 2100 },
    })
    await wrapper.findAll('.mp-cell')[7].trigger('click')

    expect(wrapper.emitted('select')).toHaveLength(1)
    expect(wrapper.emitted('select')?.[0]).toEqual([{ year: 2026, month: 8 }])
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('翻年后选中的是翻到的年份', async () => {
    const wrapper = mount(MonthPicker, {
      props: { open: true, value: { year: 2025, month: 3 }, minYear: 2000, maxYear: 2100 },
    })
    await wrapper.findAll('.mp-arrow')[1].trigger('click')
    await wrapper.findAll('.mp-cell')[2].trigger('click')

    expect(wrapper.emitted('select')?.[0]).toEqual([{ year: 2026, month: 3 }])
  })

  it('当前选中月份高亮', () => {
    const wrapper = mount(MonthPicker, {
      props: { open: true, value: { year: 2026, month: 3 }, minYear: 2000, maxYear: 2100 },
    })
    const cells = wrapper.findAll('.mp-cell')
    expect(cells[2].classes()).toContain('mp-cell--on')
    expect(cells[3].classes()).not.toContain('mp-cell--on')
    expect(cells[2].attributes('aria-pressed')).toBe('true')
  })
})

describe('MonthPicker：数据打点', () => {
  it('有数据月份打点，无数据月份不打点', () => {
    const wrapper = mount(MonthPicker, {
      props: {
        open: true,
        value: { year: 2026, month: 1 },
        minYear: 2000,
        maxYear: 2100,
        monthsWithData: ['2026-08', '2026-09'],
      },
    })
    const cells = wrapper.findAll('.mp-cell')
    expect(wrapper.findAll('.mp-cell__dot')).toHaveLength(2)
    expect(cells[7].find('.mp-cell__dot').exists()).toBe(true)
    expect(cells[8].find('.mp-cell__dot').exists()).toBe(true)
    expect(cells[0].find('.mp-cell__dot').exists()).toBe(false)
    expect(cells[7].classes()).toContain('mp-cell--has')
    // 打点信息有文字等价物，读屏不丢信息
    expect(cells[7].attributes('aria-label')).toBe('2026 年 8 月，有数据')
  })

  it('打点跟随浏览年份变化', async () => {
    const wrapper = mount(MonthPicker, {
      props: {
        open: true,
        value: { year: 2025, month: 1 },
        minYear: 2000,
        maxYear: 2100,
        monthsWithData: ['2026-08'],
      },
    })
    expect(wrapper.findAll('.mp-cell__dot')).toHaveLength(0)
    await wrapper.findAll('.mp-arrow')[1].trigger('click')
    expect(wrapper.findAll('.mp-cell__dot')).toHaveLength(1)
  })
})
