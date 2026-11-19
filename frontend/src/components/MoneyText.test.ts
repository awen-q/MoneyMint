// @vitest-environment jsdom
/**
 * MoneyText 回归（F-1 / AC-11 / AC-12 + 日历格简写档 LO-01）：
 * - `format="full"`（默认）行为零变化：币种符号前置、千分位、两位小数、`signed` 只作用于正数；
 * - `format="compact"` 走 `formatCompact`：不带币种符号、带 k/w 档位；
 * - **隐私遮挡优先于 format**：遮挡时只输出 `PRIVACY_MASK`，不能以简写形式漏出真值；
 * - 负数 class 判定跟着 `text` 走（compact 档同样能标出负数）。
 */
import { createPinia } from 'pinia'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { usePrivacyStore } from '@/stores/privacy'
import { PRIVACY_MASK } from '@/core/privacy'
import { beforeEach, describe, expect, it } from 'vitest'

import MoneyText from './MoneyText.vue'

/** 与组件 props 同形的局部类型：避免用 `Record<string, unknown>` 而丢掉 `amount` 的必填性。 */
interface MoneyTextProps {
  amount: string
  commodity?: string
  signed?: boolean
  privacy?: boolean
  size?: 'sm' | 'md' | 'lg'
  format?: 'full' | 'compact'
}

function factoryPinia() {
  const pinia = createPinia()
  return pinia
}

function mountMoney(props: MoneyTextProps) {
  return mount(MoneyText, {
    props,
    global: { plugins: [factoryPinia()] },
  })
}

beforeEach(() => {
  localStorage.clear()
})

describe('MoneyText：full 档（默认，行为零变化）', () => {
  it('负数符号前置到币种符号之前', () => {
    const wrapper = mountMoney({ amount: '-1234.5' })
    expect(wrapper.text()).toBe('-¥ 1,234.50')
    expect(wrapper.classes()).toContain('money-text--negative')
  })

  it('signed 只给正数加号，零不加号', () => {
    expect(mountMoney({ amount: '1234.5', signed: true }).text()).toBe('+¥ 1,234.50')
    expect(mountMoney({ amount: '0', signed: true }).text()).toBe('¥ 0.00')
  })

  it('未知币种回退为代码后缀', () => {
    expect(mountMoney({ amount: '1234.5', commodity: 'XYZ' }).text()).toBe('1,234.50 XYZ')
  })
})

describe('MoneyText：compact 档', () => {
  it('输出简写且不带币种符号', () => {
    const wrapper = mountMoney({ amount: '-1234', format: 'compact' })
    expect(wrapper.text()).toBe('-1.2k')
    expect(wrapper.text()).not.toContain('¥')
  })

  it('万元档用 w，千元以下取整元', () => {
    expect(mountMoney({ amount: '12345', format: 'compact' }).text()).toBe('1.2w')
    expect(mountMoney({ amount: '967', format: 'compact' }).text()).toBe('967')
  })

  it('compact 下负数仍带负数 class', () => {
    const wrapper = mountMoney({ amount: '-1234', format: 'compact' })
    expect(wrapper.classes()).toContain('money-text--negative')
    expect(mountMoney({ amount: '1234', format: 'compact' }).classes()).not.toContain(
      'money-text--negative',
    )
  })
})

describe('MoneyText：隐私遮挡优先于 format', () => {
  it('compact + privacy 只输出遮挡符', () => {
    const wrapper = mountMoney({ amount: '-1234', format: 'compact', privacy: true })
    expect(wrapper.text()).toBe(PRIVACY_MASK)
    expect(wrapper.text()).not.toContain('1.2k')
  })

  it('全局隐私开关同样压过 compact，且不显示负数色', async () => {
    const pinia = factoryPinia()
    const wrapper = mount(MoneyText, {
      props: { amount: '-1234', format: 'compact' },
      global: { plugins: [pinia] },
    })
    usePrivacyStore(pinia).setEnabled(true)
    await nextTick()
    expect(wrapper.text()).toBe(PRIVACY_MASK)
    expect(wrapper.classes()).not.toContain('money-text--negative')
  })

  it('遮挡时读屏文案为「金额已隐藏」，未遮挡时即金额本身', () => {
    expect(mountMoney({ amount: '-1234', format: 'compact' }).attributes('aria-label')).toBe('-1.2k')
    expect(
      mountMoney({ amount: '-1234', format: 'compact', privacy: true }).attributes('aria-label'),
    ).toBe('金额已隐藏')
  })
})
