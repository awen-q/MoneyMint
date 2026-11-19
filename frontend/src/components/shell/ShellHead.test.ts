// @vitest-environment jsdom
/**
 * ShellHead 回归（T21）：
 * - 品牌 + 账本行 + 三小件（待同步 / 隐私 / 更多）；
 * - **不放页名**（LO-16）：顶栏不出现 h1，也不重复页面级标题；
 * - 隐私按钮 `aria-pressed` 与 `aria-label` 随状态切换（读屏能听出当前含义）；
 * - 「⋯」只 emit more，自己不实现菜单（与底栏「更多」共用一个弹层）。
 */
import { createPinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ShellHead from './ShellHead.vue'

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    ledgerName: '家庭账本',
    user: { username: 'lin', display_name: '林小满' },
  }),
}))

function mountHead() {
  return mount(ShellHead, {
    global: {
      plugins: [createPinia()],
      // SyncBadge 内部读 sync store 与 router，与本次断言无关，桩掉
      stubs: { SyncBadge: { template: '<span class="sync-stub" />' } },
    },
  })
}

beforeEach(() => {
  localStorage.clear()
})

describe('ShellHead：信息结构', () => {
  it('渲染品牌与账本行（含当前用户）', () => {
    const wrapper = mountHead()
    expect(wrapper.find('.hd__brand').text()).toBe('FamBean')
    expect(wrapper.find('.hd__ledger').text()).toBe('当前账本：家庭账本 · 林小满')
  })

  it('顶栏不放页名：没有 h1', () => {
    const wrapper = mountHead()
    expect(wrapper.find('h1').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('总览')
  })

  it('右侧三小件齐全：同步徽标 + 隐私 + 更多', () => {
    const wrapper = mountHead()
    expect(wrapper.find('.sync-stub').exists()).toBe(true)
    expect(wrapper.findAll('.hd__icon')).toHaveLength(2)
  })
})

describe('ShellHead：隐私开关', () => {
  it('初始为未遮挡，aria-pressed=false、label=隐藏金额', () => {
    const wrapper = mountHead()
    const button = wrapper.findAll('.hd__icon')[0]
    expect(button.attributes('aria-pressed')).toBe('false')
    expect(button.attributes('aria-label')).toBe('隐藏金额')
  })

  it('点一下切到遮挡态，label 变为「显示金额」', async () => {
    const wrapper = mountHead()
    const button = wrapper.findAll('.hd__icon')[0]
    await button.trigger('click')
    expect(button.attributes('aria-pressed')).toBe('true')
    expect(button.attributes('aria-label')).toBe('显示金额')
  })
})

describe('ShellHead：更多', () => {
  it('「⋯」emit more 且带可访问名', async () => {
    const wrapper = mountHead()
    const more = wrapper.findAll('.hd__icon')[1]
    expect(more.attributes('aria-label')).toBe('更多操作')
    await more.trigger('click')
    expect(wrapper.emitted('more')).toHaveLength(1)
  })
})
