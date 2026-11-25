// @vitest-environment jsdom
/**
 * 当日交易抽屉回归（老板 2026-11 决策：点日弹底部 sheet，外部列表不变）。
 *
 * 强断言四类契约：
 * 1. 标题带「月日 · 笔数」，关闭态不渲染 dialog；
 * 2. 行走 `drawer` 档：副行不截断（多枚标签全在），且点行能跳详情；
 * 3. 空日给出「当日无交易」而不是空白；
 * 4. ESC / 遮罩 / 关闭按钮都走 close，滚动锁由 SelectSheet 底座负责；
 * 5. 隐私遮罩沿用 privacy store，抽屉里不泄露金额真值。
 */
import { createPinia, setActivePinia } from 'pinia'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AccountView, TransactionView } from '@/api/types'
import { PRIVACY_MASK } from '@/core/privacy'
import { usePrivacyStore } from '@/stores/privacy'

import DayTransactionsSheet from './DayTransactionsSheet.vue'

enableAutoUnmount(afterEach)

const ACCOUNTS: AccountView[] = [
  {
    id: 1,
    uuid: 'u-bank',
    name: 'Assets:Bank',
    type: 'Assets',
    open_date: '2026-01-01',
    sort_order: 1,
  },
  {
    id: 2,
    uuid: 'u-food',
    name: 'Expenses:Food',
    type: 'Expenses',
    open_date: '2026-01-01',
    sort_order: 2,
  },
]

function txn(id: number, tags: string[] = []): TransactionView {
  return {
    id,
    uuid: `t-${id}`,
    date: '2026-11-15',
    flag: '*',
    description: `午餐 ${id}`,
    created_by_name: '林小满',
    tags,
    postings: [
      { account_id: 1, account: 'Assets:Bank', commodity: 'CNY', amount: '-12.50' },
      { account_id: 2, account: 'Expenses:Food', commodity: 'CNY', amount: '12.50' },
    ],
  }
}

const TXNS = [txn(11, ['早餐', '外食', '工作日']), txn(12), txn(13)]

function mountSheet(
  overrides: Partial<{
    open: boolean
    day: number | null
    txns: TransactionView[]
  }> = {},
) {
  const pinia = createPinia()
  setActivePinia(pinia)
  return mount(DayTransactionsSheet, {
    props: {
      open: overrides.open ?? true,
      month: 11,
      day: overrides.day === undefined ? 15 : overrides.day,
      txns: overrides.txns ?? TXNS,
      accounts: ACCOUNTS,
    },
    global: { plugins: [pinia] },
  })
}

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
  document.body.style.position = ''
  document.body.style.top = ''
  document.body.style.overflow = ''
  Object.defineProperty(window, 'scrollTo', {
    value: vi.fn(),
    writable: true,
    configurable: true,
  })
})

describe('DayTransactionsSheet：标题与行', () => {
  it('open=false 不渲染 dialog；open=true 标题带月日与笔数', () => {
    expect(mountSheet({ open: false }).find('[role="dialog"]').exists()).toBe(false)

    const wrapper = mountSheet()
    const dialog = wrapper.find('[role="dialog"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.attributes('aria-modal')).toBe('true')
    expect(wrapper.find('.ss-title').text()).toBe('11月15日 · 3 笔')
    expect(wrapper.find('[data-testid="day-transactions-sheet"]').exists()).toBe(true)
  })

  it('三笔都渲染为 drawer 档，按 id 倒序，标签全量不截断', () => {
    const wrapper = mountSheet()
    const rows = wrapper.findAll('.txn-row')
    expect(rows).toHaveLength(3)
    expect(rows.every((row) => row.classes().includes('txn-row--drawer'))).toBe(true)
    expect(rows.map((row) => row.find('.txn-row__title').text())).toEqual([
      '午餐 13',
      '午餐 12',
      '午餐 11',
    ])
    // bill 档只允许 1 枚标签；drawer 档必须全给，否则「当日完整信息」是空话
    expect(rows[2].findAll('.txn-row__meta-item').map((node) => node.text())).toEqual([
      '2026-11-15',
      '支出',
      'Expenses:Food',
      'Assets:Bank',
      '早餐',
      '外食',
      '工作日',
      '林小满',
    ])
  })

  it('点行 emit open-detail，带的是该行交易 id', async () => {
    const wrapper = mountSheet()
    await wrapper.findAll('.txn-row')[1].trigger('click')
    expect(wrapper.emitted('open-detail')).toEqual([[12]])
  })
})

describe('DayTransactionsSheet：关闭与空态', () => {
  it('无交易的日期显示空态，不渲染空列表', () => {
    const wrapper = mountSheet({ txns: [] })
    expect(wrapper.find('.ss-title').text()).toBe('11月15日 · 0 笔')
    expect(wrapper.find('.daytx__empty').text()).toBe('当日无交易')
    expect(wrapper.findAll('.txn-row')).toHaveLength(0)
  })

  it('ESC / 点遮罩 / 关闭按钮各触发一次 close', async () => {
    const wrapper = mountSheet()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.find('.ss-mask').trigger('click')
    await wrapper.find('.ss-close').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(3)
    // 面板内部点击不算关
    await wrapper.find('.ss-panel').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(3)
  })

  it('打开时锁 body 滚动，关闭后清理内联样式', async () => {
    const wrapper = mountSheet()
    expect(document.body.style.position).toBe('fixed')
    expect(document.body.style.overflow).toBe('hidden')
    await wrapper.setProps({ open: false })
    expect(document.body.style.position).toBe('')
    expect(document.body.style.overflow).toBe('')
  })
})

describe('DayTransactionsSheet：隐私遮罩', () => {
  it('隐私开启后抽屉不出现真值，读屏也拿不到', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(DayTransactionsSheet, {
      props: { open: true, month: 11, day: 15, txns: TXNS, accounts: ACCOUNTS },
      global: { plugins: [pinia] },
    })
    usePrivacyStore(pinia).setEnabled(true)
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain(PRIVACY_MASK)
    // 副行里仍可看到日期 / 分类，但金额真值必须消失
    expect(wrapper.text()).not.toContain('12.50')
    expect(wrapper.findAll('.money-text--masked')).toHaveLength(3)
    expect(wrapper.findAll('.money-text')[0].attributes('aria-label')).toBe('金额已隐藏')
  })
})
