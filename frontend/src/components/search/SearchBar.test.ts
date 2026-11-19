// @vitest-environment jsdom
/**
 * SearchBar 回归（T34）：
 * - 输入防抖：连打两次只发一次 `search`；
 * - **回车与「搜索」按钮立即生效**，且取消待发的防抖（否则会重复发一次）；
 * - chips 渲染与单独移除（读屏名带条件文案）；
 * - 「更多筛选」`aria-expanded` / `aria-controls` 成对维护，插槽内容随之显隐；
 * - 卸载后不再 emit（防打无主请求）。
 */
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import SearchBar from './SearchBar.vue'

const CHIPS = [
  { key: 'tag', label: '标签：出差' },
  { key: 'kind', label: '类型：支出' },
]

function mountBar(props: Record<string, unknown> = {}) {
  return mount(SearchBar, {
    props: { keyword: '', chips: [], ...props },
    slots: { default: '<div class="slot-more">筛选网格</div>' },
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SearchBar：关键词提交', () => {
  it('输入后防抖到期才 emit 一次；连打两次只发一次', async () => {
    const wrapper = mountBar({ debounceMs: 300 })
    const input = wrapper.find('input')

    await input.setValue('火')
    await input.setValue('火锅')
    expect(wrapper.emitted('search')).toBeUndefined()

    vi.advanceTimersByTime(299)
    expect(wrapper.emitted('search')).toBeUndefined()

    vi.advanceTimersByTime(1)
    const emitted = wrapper.emitted('search')
    expect(emitted).toHaveLength(1)
    expect(emitted?.[0]).toEqual(['火锅'])
  })

  it('回车立即生效，且取消待发的防抖（不重复发）', async () => {
    const wrapper = mountBar({ debounceMs: 300 })
    const input = wrapper.find('input')

    await input.setValue('火锅')
    await input.trigger('keydown.enter')

    expect(wrapper.emitted('search')).toHaveLength(1)
    vi.advanceTimersByTime(1000)
    expect(wrapper.emitted('search')).toHaveLength(1)
  })

  it('「搜索」按钮立即生效，同样不重复发', async () => {
    const wrapper = mountBar({ debounceMs: 300 })
    await wrapper.find('input').setValue('火锅')

    await wrapper.find('.search-bar__submit').trigger('click')
    expect(wrapper.emitted('search')).toHaveLength(1)

    vi.advanceTimersByTime(1000)
    expect(wrapper.emitted('search')).toHaveLength(1)
  })

  it('外部 keyword 变化会同步到输入框（受控）', async () => {
    const wrapper = mountBar({ keyword: '旧值' })
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('旧值')
    await wrapper.setProps({ keyword: '新值' })
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('新值')
  })

  it('卸载后不再 emit（防无主请求）', async () => {
    const wrapper = mountBar({ debounceMs: 300 })
    await wrapper.find('input').setValue('火锅')
    wrapper.unmount()
    vi.advanceTimersByTime(1000)
    expect(wrapper.emitted('search')).toBeUndefined()
  })
})

describe('SearchBar：chips 与折叠', () => {
  it('渲染 chips，点 ✕ 回传对应 key，读屏名带条件文案', async () => {
    const wrapper = mountBar({ chips: CHIPS })
    const chips = wrapper.findAll('.search-bar__chip')
    expect(chips).toHaveLength(2)
    expect(chips[0].text()).toContain('标签：出差')

    const close = chips[0].find('.search-bar__chip-x')
    expect(close.attributes('aria-label')).toBe('移除筛选：标签：出差')
    await close.trigger('click')
    expect(wrapper.emitted('remove-chip')?.[0]).toEqual(['tag'])
  })

  it('chips 容器是 aria-live=polite（条件变化会被读屏播报）', () => {
    const wrapper = mountBar({ chips: CHIPS })
    expect(wrapper.find('.search-bar__chips').attributes('aria-live')).toBe('polite')
  })

  it('无 chips 时不渲染 chips 与「清除全部条件」', () => {
    const wrapper = mountBar({ chips: [] })
    expect(wrapper.find('.search-bar__chips').exists()).toBe(false)
    expect(wrapper.find('.search-bar__reset-btn').exists()).toBe(false)
  })

  it('「更多筛选」维护 aria-expanded / aria-controls，并控制插槽显隐', async () => {
    const wrapper = mountBar({ moreId: 'search-more' })
    const toggle = wrapper.find('.search-bar__toggle')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(toggle.attributes('aria-controls')).toBe('search-more')

    const more = wrapper.find('#search-more')
    expect((more.element as HTMLElement).style.display).toBe('none')

    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect((more.element as HTMLElement).style.display).not.toBe('none')
    // 插槽内容确实在折叠区里
    expect(more.find('.slot-more').exists()).toBe(true)
  })

  it('点「清除全部条件」emit clear', async () => {
    const wrapper = mountBar({ chips: CHIPS })
    await wrapper.find('.search-bar__reset-btn').trigger('click')
    expect(wrapper.emitted('clear')).toHaveLength(1)
  })
})
