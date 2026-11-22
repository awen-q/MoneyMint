// @vitest-environment jsdom
/**
 * 规格 §12 高级双录输入交互（批次二）：
 * - 行账户 / 币种浮层（全账户五类分组 + 搜索 / 已启用币种）；
 * - 行级三态红边、差额正数直出、新增行空金额；
 * - 行内 §5-E 表达式（顺序求值 / 2 位定点 / 除零行内报错 / = 后数字清空重输）；
 * - 焦点行 readonly + focus-amount / keypad-done 契约。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

import AdvancedPostings from './AdvancedPostings.vue'
import type { AdvancedRow } from '@/core/record'

const ACCOUNTS = [
  { id: 1, uuid: 'a1', name: 'Assets:WeChat', display_name: '微信', icon: '🟢', type: 'Assets' as const, open_date: '2026-01-01', sort_order: 0 },
  { id: 2, uuid: 'a2', name: 'Assets:Bank', display_name: '银行', type: 'Assets' as const, open_date: '2026-01-01', sort_order: 0, commodity_restriction: 'USD' },
  { id: 3, uuid: 'a3', name: 'Liabilities:CreditCard', display_name: '信用卡', type: 'Liabilities' as const, open_date: '2026-01-01', sort_order: 0 },
  { id: 4, uuid: 'a4', name: 'Equity:Opening-Balances', display_name: '期初余额', icon: '⚖️', type: 'Equity' as const, open_date: '2026-01-01', sort_order: 0 },
  { id: 5, uuid: 'a5', name: 'Income:Salary', display_name: '薪资', type: 'Income' as const, open_date: '2026-01-01', sort_order: 0 },
  { id: 6, uuid: 'a6', name: 'Expenses:Food:晚餐', display_name: '晚餐', type: 'Expenses' as const, open_date: '2026-01-01', sort_order: 0 },
]

function rows(input: Array<[number | null, string, string]>): AdvancedRow[] {
  return input.map(([accountId, amount, commodity]) => ({ accountId, amount, commodity }))
}

function mountRows(
  initial: AdvancedRow[],
  options: { activeRow?: number; keypadActive?: boolean } = {},
): VueWrapper {
  return mount(AdvancedPostings, {
    props: {
      rows: initial,
      accounts: ACCOUNTS,
      commodities: ['CNY', 'USD'],
      bean: '预览',
      activeRow: options.activeRow ?? -1,
      keypadActive: options.keypadActive ?? false,
    },
  })
}

function lastRows(wrapper: VueWrapper): AdvancedRow[] {
  const emitted = wrapper.emitted('update:rows')
  return (emitted === undefined ? [] : (emitted[emitted.length - 1][0] ?? [])) as AdvancedRow[]
}

function popover(): HTMLElement | null {
  return document.body.querySelector('.adv-popover')
}

async function press(wrapper: VueWrapper, key: string): Promise<void> {
  const vm = wrapper.vm as unknown as { pressActiveKey: (key: string) => void }
  vm.pressActiveKey(key)
  await flushPromises()
}

afterEach(() => {
  document.querySelectorAll('.adv-popover-mask').forEach((element) => element.remove())
})

describe('§12-3 / §12-4：行账户 / 币种浮层', () => {
  it('账户 chip 打开 Teleport 底部弹层：全部账户五类分组 + 期初余额 + 当前项打勾', async () => {
    const wrapper = mountRows(rows([[1, '-100.00', 'CNY'], [6, '100.00', 'CNY']]))
    const chip = wrapper.findAll('.rs-adv-row')[0].find('[data-rf="acc"][data-role="chip"]')
    expect(chip.exists()).toBe(true)
    expect(chip.attributes('data-rf')).toBe('acc')
    await chip.trigger('click')
    await flushPromises()

    const floating = popover()
    expect(floating).not.toBeNull()
    expect(floating?.getAttribute('data-popover')).toBe('acc')
    expect(floating?.getAttribute('data-row')).toBe('0')
    const heads = Array.from(floating?.querySelectorAll('.adv-group__head') ?? []).map((node) => node.textContent ?? '')
    expect(heads).toHaveLength(5)
    expect(heads.join('|')).toContain('ASSETS')
    expect(heads.join('|')).toContain('LIABILITIES')
    expect(heads.join('|')).toContain('INCOME')
    expect(heads.join('|')).toContain('EXPENSES')
    expect(heads.join('|')).toContain('EQUITY')

    const opening = floating?.querySelector('[data-account="4"]')
    expect(opening?.textContent).toContain('期初余额')
    expect(opening?.textContent).toContain('Equity:Opening-Balances')
    const checked = floating?.querySelector('[data-account="1"]')
    expect(checked?.className).toContain('on')
    wrapper.unmount()
  })

  it('账户浮层顶部搜索按 display_name / name 过滤；点选回填该行账户并联动币种', async () => {
    const wrapper = mountRows(rows([[1, '-100.00', 'CNY'], [6, '100.00', 'CNY']]))
    await wrapper.findAll('.rs-adv-row')[0]
      .find('[data-rf="acc"][data-role="chip"]').trigger('click')
    await flushPromises()

    const search = document.body.querySelector('.adv-search') as HTMLInputElement
    search.value = 'USD'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    // commodity_restriction 不在搜索字段内，中文 / mono 命中才可。
    expect(document.body.querySelector('[data-account="2"]')).toBeNull()
    search.value = '银行'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    expect(document.body.querySelector('[data-account="2"]')).not.toBeNull()

    const option = document.body.querySelector('[data-account="2"]') as HTMLElement
    option.click()
    await flushPromises()
    expect(lastRows(wrapper)[0]).toMatchObject({ accountId: 2, commodity: 'USD' })
    expect(popover()).toBeNull()
    wrapper.unmount()
  })

  it('币种 chip 打开同形态浮层，选项为已启用币种；点选只改该行 commodity', async () => {
    const wrapper = mountRows(rows([[1, '-100.00', 'CNY'], [6, '100.00', 'CNY']]))
    await wrapper.findAll('.rs-adv-row')[1]
      .find('[data-rf="cur"][data-role="chip"]').trigger('click')
    await flushPromises()

    const floating = popover()
    expect(floating?.getAttribute('data-popover')).toBe('cur')
    expect(floating?.getAttribute('data-row')).toBe('1')
    const codes = Array.from(floating?.querySelectorAll('[data-commodity]') ?? []).map((node) => node.getAttribute('data-commodity'))
    expect(codes).toEqual(['CNY', 'USD'])
    ;(document.body.querySelector('[data-commodity="USD"]') as HTMLElement).click()
    await flushPromises()
    const next = lastRows(wrapper)
    expect(next[1].commodity).toBe('USD')
    expect(next[0].commodity).toBe('CNY')
    wrapper.unmount()
  })

  it('Esc 关闭浮层（PC 锚定下拉契约）', async () => {
    const wrapper = mountRows(rows([[1, '-100.00', 'CNY'], [6, '100.00', 'CNY']]))
    await wrapper.findAll('.rs-adv-row')[0]
      .find('[data-rf="acc"][data-role="chip"]').trigger('click')
    await flushPromises()
    expect(popover()).not.toBeNull()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(popover()).toBeNull()
    wrapper.unmount()
  })
})

describe('§12-6：行级三态与差额', () => {
  it('账户未选 / 金额空的行容器挂红边 class，正常行无红边', () => {
    const wrapper = mountRows(rows([[null, '', 'CNY'], [6, '100.00', 'CNY']]))
    const rowEls = wrapper.findAll('.rs-adv-row')
    expect(rowEls[0].classes()).toContain('rs-adv-row--invalid')
    expect(rowEls[1].classes()).not.toContain('rs-adv-row--invalid')
    wrapper.unmount()
  })

  it('差额正数直接显示 +12.00（不平按币种逐行列出）', () => {
    const wrapper = mountRows(rows([
      [1, '-500.00', 'CNY'],
      [2, '500.00', 'CNY'],
      [6, '12.00', 'CNY'],
    ]))
    expect(wrapper.find('.js-check').text()).toContain('差额')
    expect(wrapper.find('.js-check').text()).toContain('+12.00')
    expect((wrapper.vm as unknown as { canSubmit: boolean }).canSubmit).toBe(false)
    wrapper.unmount()
  })

  it('新增行默认账户未选 / 金额空 / 币种 CNY', async () => {
    const wrapper = mountRows(rows([[1, '-100.00', 'CNY'], [6, '100.00', 'CNY']]))
    await wrapper.find('[data-act="add-row"]').trigger('click')
    await flushPromises()
    expect(lastRows(wrapper)[2]).toEqual({ accountId: null, amount: '', commodity: 'CNY' })
    wrapper.unmount()
  })
})

describe('§12-1 / §12-2：行内表达式与自定义键盘联动', () => {
  it('点金额框 emit focus-amount(index, el)；焦点行 readonly，防止系统键盘唤起', async () => {
    const wrapper = mountRows(
      rows([[1, '-100.00', 'CNY'], [6, '100.00', 'CNY']]),
      { activeRow: 0, keypadActive: true },
    )
    const inputs = wrapper.findAll('[data-rf="amt"]')
    expect(inputs[0].attributes('readonly')).toBeDefined()
    expect(inputs[1].attributes('readonly')).toBeUndefined()
    expect(wrapper.findAll('.rs-adv-row')[0].classes()).toContain('rs-adv-row--focus')

    await inputs[1].trigger('click')
    const emitted = wrapper.emitted('focus-amount')
    expect(emitted).toBeDefined()
    expect(emitted?.[0][0]).toBe(1)
    expect(emitted?.[0][1]).toBeInstanceOf(HTMLInputElement)
    wrapper.unmount()
  })

  it('86.5×2 顺序求值写回该行 -173.00，表达式小字带箭头', async () => {
    const wrapper = mountRows(
      rows([[1, '-100.00', 'CNY'], [6, '100.00', 'CNY']]),
      { activeRow: 0, keypadActive: true },
    )
    for (const key of ['8', '6', '.', '5', '×', '2']) {
      await press(wrapper, key)
    }
    expect(wrapper.find('.js-adv-expr').text()).toContain('86.5 × 2')
    await press(wrapper, '=')
    expect(lastRows(wrapper)[0].amount).toBe('-173.00')
    expect(lastRows(wrapper)[1].amount).toBe('100.00')
    expect(wrapper.find('.js-adv-expr').text()).toContain('→ 173.00')
    wrapper.unmount()
  })

  it('1+2×3 顺序求值（不启用乘除优先级）= 9.00', async () => {
    const wrapper = mountRows(
      rows([[1, '0.01', 'CNY'], [6, '-0.01', 'CNY']]),
      { activeRow: 0, keypadActive: true },
    )
    for (const key of ['1', '+', '2', '×', '3', '=']) {
      await press(wrapper, key)
    }
    expect(lastRows(wrapper)[0].amount).toBe('9.00')
    wrapper.unmount()
  })

  it('9÷0 除零行内报错，不落值、不 emit 行更新', async () => {
    const wrapper = mountRows(
      rows([[1, '-100.00', 'CNY'], [6, '100.00', 'CNY']]),
      { activeRow: 0, keypadActive: true },
    )
    for (const key of ['9', '÷', '0', '=']) {
      await press(wrapper, key)
    }
    expect(wrapper.find('.js-adv-eval-error').text()).toBe('除数不能为 0')
    expect(wrapper.emitted('update:rows')).toBeUndefined()
    expect(
      (wrapper.findAll('[data-rf="amt"]')[0].element as HTMLInputElement).value,
    ).toBe('100.00')
    wrapper.unmount()
  })

  it('= 后按数字清空重输，再按 = 只求值新数字', async () => {
    const wrapper = mountRows(
      rows([[1, '-100.00', 'CNY'], [6, '100.00', 'CNY']]),
      { activeRow: 0, keypadActive: true },
    )
    for (const key of ['8', '6', '.', '5', '×', '2', '=']) {
      await press(wrapper, key)
    }
    expect(lastRows(wrapper)[0].amount).toBe('-173.00')
    await press(wrapper, '5')
    expect(wrapper.find('.js-adv-expr').text()).toContain('5')
    expect(wrapper.find('.js-adv-expr').text()).not.toContain('86.5')
    await press(wrapper, '=')
    expect(lastRows(wrapper)[0].amount).toBe('-5.00')
    wrapper.unmount()
  })

  it('焦点行被删除 / 返回简化模式时 emit keypad-done 收起键盘', async () => {
    const wrapper = mountRows(
      rows([[1, '-100.00', 'CNY'], [6, '100.00', 'CNY'], [5, '0.00', 'CNY']]),
      { activeRow: 0, keypadActive: true },
    )
    await wrapper.findAll('[data-act="remove-row"]')[0].trigger('click')
    expect(wrapper.emitted('keypad-done')).toBeDefined()
    wrapper.unmount()

    const second = mountRows(rows([[1, '-100.00', 'CNY'], [6, '100.00', 'CNY']]), { activeRow: 0, keypadActive: true })
    await second.find('[data-act="back-simple"]').trigger('click')
    expect(second.emitted('keypad-done')).toBeDefined()
    second.unmount()
  })
})
