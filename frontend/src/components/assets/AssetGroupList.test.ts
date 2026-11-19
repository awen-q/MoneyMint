// @vitest-environment jsdom
/**
 * AssetGroupList 组头回归（审计 A-7 / 稿 1164-1168）
 *
 * 两条：
 * 1. **账户数按账户去重，不按行数**：行粒度是「账户 × 币种」，一个账户的
 *    CNY + USD 会出两行；数行数会让「2 个账户」在列表里只有 1 个名字，
 *    用户会以为漏了人。
 * 2. **「另有 $X（USD）」按币种各算各的**：金额来自 `core/assets.ts` 的
 *    `foreignSubtotals`，组件只是搬上屏 —— 组件里没有任何金额加法。
 */
import { createPinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import type { AssetGroup, AssetRow } from '@/core/assets'

import AssetGroupList from './AssetGroupList.vue'

function row(overrides: Partial<AssetRow> & { accountId: number; commodity: string; amount: string }): AssetRow {
  return {
    label: `账户${overrides.accountId}`,
    fullName: `Assets:Acc${overrides.accountId}`,
    isForeign: overrides.commodity !== 'CNY',
    closed: false,
    ...overrides,
  }
}

function group(overrides: Partial<AssetGroup> = {}): AssetGroup {
  return {
    type: 'Assets',
    label: '资产',
    subtotal: '12000.00',
    rows: [row({ accountId: 1, commodity: 'CNY', amount: '12000.00' })],
    foreignRows: [],
    foreignSubtotals: [],
    ...overrides,
  }
}

function mountList(groups: AssetGroup[]) {
  return mount(AssetGroupList, {
    global: { plugins: [createPinia()] },
    props: { groups, commodity: 'CNY', masked: false },
  })
}

describe('AssetGroupList：组头', () => {
  it('一个账户两个币种 = 1 个账户（不是 2 行）', () => {
    const wrapper = mountList([
      group({
        // 同一账户 id=2 的 CNY 与 USD 两行
        rows: [
          row({ accountId: 1, commodity: 'CNY', amount: '12000.00' }),
          row({ accountId: 2, commodity: 'CNY', amount: '800.00' }),
        ],
        foreignRows: [row({ accountId: 2, commodity: 'USD', amount: '150.00' })],
        foreignSubtotals: [{ commodity: 'USD', amount: '150.00' }],
      }),
    ])
    const count = wrapper.find('.asset-group__count').text()
    expect(count).toContain('2 个账户')
    // 反向断言：3 行 ≠ 3 个账户
    expect(count).not.toContain('3 个账户')
  })

  it('有外币时补「另有 $150.00（USD）」；没有外币时整句不出现', () => {
    const withFx = mountList([
      group({
        rows: [row({ accountId: 1, commodity: 'CNY', amount: '12000.00' })],
        foreignRows: [row({ accountId: 3, commodity: 'USD', amount: '150.00' })],
        foreignSubtotals: [{ commodity: 'USD', amount: '150.00' }],
      }),
    ])
    const text = withFx.find('.asset-group__count').text()
    expect(text).toContain('另有')
    expect(text).toContain('150.00')
    expect(text).toContain('（USD）')

    const noFx = mountList([group()])
    expect(noFx.find('.asset-group__count').text()).not.toContain('另有')
  })

  it('多币种外币各出一条「另有」，不合并成一个数', () => {
    const wrapper = mountList([
      group({
        rows: [],
        foreignRows: [
          row({ accountId: 3, commodity: 'USD', amount: '150.00' }),
          row({ accountId: 4, commodity: 'EUR', amount: '40.00' }),
        ],
        foreignSubtotals: [
          { commodity: 'EUR', amount: '40.00' },
          { commodity: 'USD', amount: '150.00' },
        ],
      }),
    ])
    const items = wrapper.findAll('.asset-group__fx')
    expect(items).toHaveLength(2)
    expect(items[0].text()).toContain('（EUR）')
    expect(items[1].text()).toContain('（USD）')
  })

  it('组小计仍在组头右侧（没被「另有」挤掉）', () => {
    const wrapper = mountList([
      group({
        rows: [row({ accountId: 1, commodity: 'CNY', amount: '12000.00' })],
        foreignSubtotals: [{ commodity: 'USD', amount: '150.00' }],
      }),
    ])
    expect(wrapper.find('.asset-group__subtotal').text()).toContain('12,000.00')
  })
})
