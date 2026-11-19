// @vitest-environment jsdom
/**
 * LedgerSwitcher 回归（T15）：
 * - 当前账本行打对勾（其余行没有）；
 * - 点其他账本 emit select(id) 并紧接着 close；
 * - 点当前账本不重复触发 select；
 * - 角色徽标口径：owner 所有者 / editor 可编辑 / viewer 只读，未登记角色不渲染徽标；
 * - id 是 number 还是 string 都认定为同一个账本（后端与路由参数口径不一致时不误切）。
 */
import { mount } from '@vue/test-utils'
import { enableAutoUnmount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import LedgerSwitcher from './LedgerSwitcher.vue'

const LEDGERS = [
  { id: 7, name: '家庭账本', role: 'owner' },
  { id: 8, name: '旅行账本', role: 'editor' },
  { id: 9, name: '公司账本', role: 'viewer' },
  { id: 10, name: '旧账本' },
]

// 自动卸载只能注册一次，必须在模块顶层。
enableAutoUnmount(afterEach)

beforeEach(() => {
  document.body.innerHTML = ''
  Object.defineProperty(window, 'scrollY', { value: 0, writable: true, configurable: true })
  Object.defineProperty(window, 'scrollTo', { value: vi.fn(), writable: true, configurable: true })
})

describe('LedgerSwitcher：当前账本', () => {
  it('只有当前账本行打对勾并标记 aria-current', () => {
    const wrapper = mount(LedgerSwitcher, {
      props: { open: true, ledgers: LEDGERS, currentId: 7 },
    })
    const rows = wrapper.findAll('.ls-row')
    expect(rows).toHaveLength(4)
    expect(rows[0].find('.ls-check').exists()).toBe(true)
    expect(rows[1].find('.ls-check').exists()).toBe(false)
    expect(rows[0].attributes('aria-current')).toBe('true')
    expect(rows[1].attributes('aria-current')).toBeUndefined()
  })

  it('点当前账本不 emit select', async () => {
    const wrapper = mount(LedgerSwitcher, {
      props: { open: true, ledgers: LEDGERS, currentId: 7 },
    })
    await wrapper.findAll('.ls-row')[0].trigger('click')
    expect(wrapper.emitted('select')).toBeUndefined()
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('currentId 为字符串时仍认定为当前账本', () => {
    const wrapper = mount(LedgerSwitcher, {
      props: { open: true, ledgers: LEDGERS, currentId: '7' },
    })
    expect(wrapper.findAll('.ls-row')[0].find('.ls-check').exists()).toBe(true)
  })
})

describe('LedgerSwitcher：切换', () => {
  it('点其他账本 emit select(id) 并关闭', async () => {
    const wrapper = mount(LedgerSwitcher, {
      props: { open: true, ledgers: LEDGERS, currentId: 7 },
    })
    await wrapper.findAll('.ls-row')[1].trigger('click')

    expect(wrapper.emitted('select')).toHaveLength(1)
    expect(wrapper.emitted('select')?.[0]).toEqual([8])
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('角色徽标文案按 role 映射', () => {
    const wrapper = mount(LedgerSwitcher, {
      props: { open: true, ledgers: LEDGERS, currentId: 7 },
    })
    const rows = wrapper.findAll('.ls-row')
    expect(rows[0].find('.ls-badge').text()).toBe('所有者')
    expect(rows[1].find('.ls-badge').text()).toBe('可编辑')
    expect(rows[2].find('.ls-badge').text()).toBe('只读')
    // 未登记 role：不渲染徽标，也不猜一个权限
    expect(rows[3].find('.ls-badge').exists()).toBe(false)
  })

  it('空列表显示占位文案且不渲染任何行', () => {
    const wrapper = mount(LedgerSwitcher, { props: { open: true, ledgers: [], currentId: 7 } })
    expect(wrapper.find('.ls-empty').text()).toBe('暂无账本')
    expect(wrapper.findAll('.ls-row')).toHaveLength(0)
  })
})
