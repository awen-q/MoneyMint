// @vitest-environment jsdom
/**
 * IconPicker（批 II）行为回归：
 *   - 预设宫格点击上抛该图标并高亮；
 *   - 清除按钮上抛空串（= 恢复默认 📁 的语义载体）；
 *   - 自由输入超 8 码位 → 显示提示且不上抛非法值；
 *   - 码位计数按 Array.from（与后端 Go rune 同口径）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import IconPicker from '@/components/IconPicker.vue'

function findButton(wrapper: ReturnType<typeof mount>, text: string) {
  return wrapper.findAll('button').find((b) => b.text() === text)
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('IconPicker 基础行为', () => {
  it('渲染 20 个预设宫格，点击预设上抛该图标', async () => {
    const wrapper = mount(IconPicker, { props: { modelValue: '' } })
    const cells = wrapper.findAll('.ipick__cell')
    expect(cells.length).toBe(20)
    await cells[0].trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([cells[0].text()])
    // 点击后高亮态跟随 modelValue 需父组件回写；本组件 aria-pressed 跟随 prop。
    expect(cells[0].attributes('aria-pressed')).toBe('false')
  })

  it('aria-pressed 标记当前选中预设', () => {
    const wrapper = mount(IconPicker, { props: { modelValue: '🏦' } })
    const on = wrapper.findAll('.ipick__cell').find((b) => b.text() === '🏦')
    expect(on).toBeDefined()
    expect(on?.attributes('aria-pressed')).toBe('true')
  })

  it('清除按钮上抛空串（清除语义），输入框同步归零', async () => {
    const wrapper = mount(IconPicker, { props: { modelValue: '🏦' } })
    await findButton(wrapper, '清除图标（恢复默认 📁）')?.trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([''])
  })

  it('自由输入合法值在 change 时上抛；外部 modelValue 变化回填输入框', async () => {
    const wrapper = mount(IconPicker, { props: { modelValue: '' } })
    const input = wrapper.find('.ipick__input')
    await input.setValue('🎓')
    await input.trigger('change')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['🎓'])

    await wrapper.setProps({ modelValue: '💊' })
    expect((wrapper.find('.ipick__input').element as HTMLInputElement).value).toBe('💊')
  })

  it('超 8 码位：显示 9/8 提示且不上抛非法值', async () => {
    const wrapper = mount(IconPicker, { props: { modelValue: '' } })
    const input = wrapper.find('.ipick__input')
    await input.setValue('123456789')
    await input.trigger('change')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(wrapper.text()).toContain('9/8')
    expect(wrapper.text()).toContain('不超过 8 个字符')
  })

  it('disabled：预设与清除按钮禁用', () => {
    const wrapper = mount(IconPicker, { props: { modelValue: '', disabled: true } })
    for (const cell of wrapper.findAll('button')) {
      expect(cell.attributes('disabled')).toBeDefined()
    }
  })
})
