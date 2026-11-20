// @vitest-environment jsdom
/**
 * TxnRow 回归（T11）：
 * - 三档各渲染一次：bill 副行单行截断、search 两行 clamp、drawer 不截断；
 * - **两枚徽章同时渲染**（被冲正的转账 → `已冲正` + `转账`），且顺序不动；
 * - `interactive: false` 时不渲染 button（drawer 默认即不可点）；
 * - 点整行 emit open；`aria-label` 含 title；
 * - `meta` 少项时不会渲染空 span（组件不做 falsy 过滤，也不会因为不过滤而出错）；
 * - 金额只经 `MoneyText`：已在 core 归一为两位定点，转账（signed=false）不自补 `+`。
 *
 * **徽章语义的两组判定**在 T38 从旧流水页迁到这里（原用例 mount 已下线的
 * `TransactionsView` 验同一件事）：`reversal 组`（已冲正 / 冲正，**互斥**）与
 * `kind 组`（转账 / 期初）**相互独立、可同时出现**，总计 0~2 枚。
 */
import { createPinia } from 'pinia'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'

import { buildTxnRow, type TxnRowView } from '@/core/txnRow'
import type { AccountView, TransactionView } from '@/api/types'
import { PRIVACY_MASK } from '@/core/privacy'
import { usePrivacyStore } from '@/stores/privacy'
import TxnRow from './TxnRow.vue'

function makeView(overrides: Partial<TxnRowView> = {}): TxnRowView {
  return {
    id: 1,
    amount: '-12.50',
    commodity: 'CNY',
    signed: true,
    title: '午饭',
    meta: [
      { kind: 'category', text: '餐饮' },
      { kind: 'member', text: '林小满' },
    ],
    badges: [],
    ...overrides,
  }
}

function mountRow(view: TxnRowView, variant: 'bill' | 'search' | 'drawer', interactive?: boolean) {
  return mount(TxnRow, {
    props: interactive === undefined ? { view, variant } : { view, variant, interactive },
    global: { plugins: [createPinia()] },
  })
}

// 隐私开关会写 localStorage；不清掉会把「已遮挡」漏进后续用例（假失败）。
beforeEach(() => {
  localStorage.clear()
})

describe('TxnRow：三档渲染', () => {
  it('bill：单行副行 + 56px 档位类', () => {
    const wrapper = mountRow(makeView(), 'bill')
    expect(wrapper.classes()).toContain('txn-row--bill')
    const meta = wrapper.find('.txn-row__meta')
    expect(meta.classes()).toContain('txn-row__meta--bill')
    expect(wrapper.find('.txn-row__title').text()).toBe('午饭')
  })

  it('search：两行 clamp 档', () => {
    const wrapper = mountRow(makeView(), 'search')
    expect(wrapper.classes()).toContain('txn-row--search')
    expect(wrapper.find('.txn-row__meta').classes()).toContain('txn-row__meta--search')
  })

  it('drawer：不截断，且默认不是 button', () => {
    const wrapper = mountRow(makeView(), 'drawer')
    expect(wrapper.classes()).toContain('txn-row--drawer')
    expect(wrapper.find('.txn-row__meta').classes()).toContain('txn-row__meta--drawer')
    expect(wrapper.element.tagName).not.toBe('BUTTON')
    expect(wrapper.find('.txn-row__arrow').exists()).toBe(false)
  })
})

describe('TxnRow：徽章', () => {
  it('两枚徽章同时渲染且保持 core 给的顺序', () => {
    const wrapper = mountRow(
      makeView({
        badges: [
          { label: '已冲正', tone: 'reversal' },
          { label: '转账', tone: 'transfer' },
        ],
      }),
      'bill',
    )
    const badges = wrapper.findAll('.txn-row__badge')
    expect(badges).toHaveLength(2)
    expect(badges.map((badge) => badge.text())).toEqual(['已冲正', '转账'])
    expect(badges[0].classes()).toContain('txn-row__badge--reversal')
    expect(badges[1].classes()).toContain('txn-row__badge--transfer')
  })

  it('无徽章时不渲染徽章容器（不留空盒子）', () => {
    const wrapper = mountRow(makeView(), 'bill')
    expect(wrapper.find('.txn-row__badges').exists()).toBe(false)
  })
})

describe('TxnRow：交互与无障碍', () => {
  it('可点时是 button，点整行 emit open', async () => {
    const wrapper = mountRow(makeView(), 'bill')
    expect(wrapper.element.tagName).toBe('BUTTON')
    await wrapper.trigger('click')
    expect(wrapper.emitted('open')).toHaveLength(1)
  })

  it('interactive: false 时是 div，点击不 emit', async () => {
    const wrapper = mountRow(makeView(), 'bill', false)
    expect(wrapper.element.tagName).not.toBe('BUTTON')
    await wrapper.trigger('click')
    expect(wrapper.emitted('open')).toBeUndefined()
  })

  it('可点时不出 aria-label（否则会覆盖内容名称），名称由内容构成', () => {
    const wrapper = mountRow(makeView({ title: '超市采购' }), 'search')
    // 有 aria-label 就会吞掉金额/徽章/副行，所以这里必须为空
    expect(wrapper.attributes('aria-label')).toBeUndefined()
    const name = wrapper.text()
    expect(name).toContain('超市采购')
    expect(name).toContain('-¥ 12.50')
    expect(name).toContain('餐饮')
    expect(name).toContain('查看详情')
  })

  it('遮挡态下名称里的金额位是遮挡符，不是真值（AC-11）', async () => {
    const pinia = createPinia()
    const wrapper = mount(TxnRow, {
      props: { view: makeView({ amount: '-1234.50' }), variant: 'bill' },
      global: { plugins: [pinia] },
    })
    usePrivacyStore(pinia).setEnabled(true)
    await nextTick()

    const name = wrapper.text()
    expect(name).toContain(PRIVACY_MASK)
    expect(name).not.toContain('1,234.50')
    expect(wrapper.find('.txn-row__amount').text()).toBe(PRIVACY_MASK)
  })

  it('不可点时既无 aria-label、无箭头，也没有「查看详情」（div 不该有按钮语义）', () => {
    const wrapper = mountRow(makeView(), 'drawer', false)
    expect(wrapper.attributes('aria-label')).toBeUndefined()
    expect(wrapper.find('.txn-row__arrow').exists()).toBe(false)
    expect(wrapper.find('.txn-row__a11y').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('查看详情')
  })
})

describe('TxnRow：副行与金额', () => {
  it('meta 只有 2 项时正好渲染 2 个非空项，不出空 span', () => {
    const wrapper = mountRow(makeView(), 'bill')
    const items = wrapper.findAll('.txn-row__meta-item')
    expect(items).toHaveLength(2)
    expect(items.map((item) => item.text())).toEqual(['餐饮', '林小满'])
    for (const item of items) {
      expect(item.text().trim()).not.toBe('')
    }
  })

  it('bill 档副行渲染全部 3 项（分类 · 成员 · 至多 1 标签）', () => {
    const wrapper = mountRow(
      makeView({
        meta: [
          { kind: 'category', text: '餐饮' },
          { kind: 'member', text: '林小满' },
          { kind: 'tag', text: '报销' },
        ],
      }),
      'bill',
    )
    const texts = wrapper.findAll('.txn-row__meta-item').map((item) => item.text())
    expect(texts).toEqual(['餐饮', '林小满', '报销'])
  })

  it('bill 档仍有长度上限（core 将来多给字段时的保险），且按顺序丢弃尾部', () => {
    const wrapper = mountRow(
      makeView({
        meta: [
          { kind: 'category', text: '餐饮' },
          { kind: 'member', text: '林小满' },
          { kind: 'tag', text: '报销' },
          { kind: 'tag', text: '旅行' },
        ],
      }),
      'bill',
    )
    const texts = wrapper.findAll('.txn-row__meta-item').map((item) => item.text())
    expect(texts).toEqual(['餐饮', '林小满', '报销'])
  })

  it('search / drawer 不降级，标签照常渲染', () => {
    const view = makeView({
      meta: [
        { kind: 'date', text: '2026-08-01' },
        { kind: 'type', text: '支出' },
        { kind: 'tag', text: '报销' },
      ],
    })
    expect(mountRow(view, 'search').findAll('.txn-row__meta-item')).toHaveLength(3)
    expect(mountRow(view, 'drawer').findAll('.txn-row__meta-item')).toHaveLength(3)
  })

  it('金额走 MoneyText 且不自补符号：signed=false 时不出现 +', () => {
    const wrapper = mountRow(makeView({ amount: '1000.00', signed: false }), 'bill')
    const text = wrapper.find('.txn-row__amount').text()
    expect(text).toBe('¥ 1,000.00')
    expect(text).not.toContain('+')
  })

  it('三种金额形态按 core 语义透传（支出 / 收入 / 转账）', () => {
    // 支出：amount 为负，signed=true，负号本来就显示
    expect(
      mountRow(makeView({ amount: '-123.45', signed: true }), 'bill')
        .find('.txn-row__amount')
        .text(),
    ).toBe('-¥ 123.45')
    // 收入：amount 为正 + signed=true → 显式加号
    expect(
      mountRow(makeView({ amount: '800.00', signed: true }), 'bill')
        .find('.txn-row__amount')
        .text(),
    ).toBe('+¥ 800.00')
    // 转账：amount 已由 core 取绝对值，signed=false → 不带任何符号
    expect(
      mountRow(makeView({ amount: '500.00', signed: false }), 'drawer')
        .find('.txn-row__amount')
        .text(),
    ).toBe('¥ 500.00')
  })

  it('已归一金额原样呈现（12.5 → 由 core 归一，组件不再二次格式）', () => {
    const wrapper = mountRow(makeView({ amount: '-1234.50', signed: true }), 'bill')
    expect(wrapper.find('.txn-row__amount').text()).toBe('-¥ 1,234.50')
  })

  it('commodity 为空串时照原样渲染（不回退成账本主币种）', () => {
    // core 允许 commodity 为 ''（空 postings / 旧响应）；此时应出裸金额，
    // 不能偷偷套用账本主币种 —— 否则跨币种账本会把「$12」标成「¥12」。
    const wrapper = mountRow(makeView({ amount: '-1234.50', commodity: '' }), 'bill')
    const text = wrapper.find('.txn-row__amount').text()
    expect(text).toBe('-1,234.50')
    expect(text).not.toContain('¥')
  })
})

describe('TxnRow：徽章语义（T38 从旧流水页迁移）', () => {
  const ACCOUNTS: AccountView[] = [
    { id: 1, name: 'Assets:Bank', uuid: 'u1', type: 'Assets', open_date: '2026-01-01', sort_order: 1 },
    { id: 2, name: 'Expenses:Food', uuid: 'u2', type: 'Expenses', open_date: '2026-01-01', sort_order: 2 },
    { id: 3, name: 'Equity:Opening', uuid: 'u3', type: 'Equity', open_date: '2026-01-01', sort_order: 3 },
  ]

  function makeTxn(overrides: Partial<TransactionView> = {}): TransactionView {
    return {
      id: 1,
      uuid: 't-1',
      date: '2026-11-09',
      flag: '*',
      description: '原交易',
      created_by_name: '阿文',
      postings: [
        { account_id: 2, account: 'Expenses:Food', commodity: 'CNY', amount: '10.00' },
        { account_id: 1, account: 'Assets:Bank', commodity: 'CNY', amount: '-10.00' },
      ],
      ...overrides,
    }
  }

  function badgesOf(txn: TransactionView): string[] {
    return buildTxnRow(txn, ACCOUNTS, 'search').badges.map((badge) => badge.label)
  }

  it('reversed_by 非空 → 「已冲正」（reversal 组只有一个，不与「冲正」并存）', () => {
    expect(badgesOf(makeTxn({ reversed_by: 'rev-1' }))).toEqual(['已冲正'])
  })

  it('reversal_of 非空且未被冲正 → 「冲正」', () => {
    expect(badgesOf(makeTxn({ reversal_of: 't-0' }))).toEqual(['冲正'])
  })

  it('两组独立：被冲正的转账同时出「已冲正」+「转账」', () => {
    const transfer = makeTxn({
      reversed_by: 'rev-1',
      postings: [
        { account_id: 1, account: 'Assets:Bank', commodity: 'CNY', amount: '-2000.00' },
        { account_id: 1, account: 'Assets:Bank', commodity: 'CNY', amount: '2000.00' },
      ],
    })
    expect(badgesOf(transfer)).toEqual(['已冲正', '转账'])
  })

  it('期初交易出「期初」；普通支出无徽章', () => {
    const opening = makeTxn({
      postings: [
        { account_id: 1, account: 'Assets:Bank', commodity: 'CNY', amount: '500.00' },
        { account_id: 3, account: 'Equity:Opening', commodity: 'CNY', amount: '-500.00' },
      ],
    })
    expect(badgesOf(opening)).toEqual(['期初'])
    expect(badgesOf(makeTxn())).toEqual([])
  })

  it('徽章渲染到 DOM：两枚并排、按 core 顺序、tone 类正确', () => {
    const view = makeView()
    const transfer = makeTxn({
      reversed_by: 'rev-1',
      postings: [
        { account_id: 1, account: 'Assets:Bank', commodity: 'CNY', amount: '-2000.00' },
        { account_id: 1, account: 'Assets:Bank', commodity: 'CNY', amount: '2000.00' },
      ],
    })
    const built = buildTxnRow(transfer, ACCOUNTS, 'search')
    const wrapper = mount(TxnRow, {
      props: { view: { ...view, badges: built.badges }, variant: 'search' },
      global: { plugins: [createPinia()] },
    })
    const badges = wrapper.findAll('.txn-row__badge')
    expect(badges.map((badge) => badge.text())).toEqual(['已冲正', '转账'])
    expect(badges[0].classes()).toContain('txn-row__badge--reversal')
    expect(badges[1].classes()).toContain('txn-row__badge--transfer')
  })
})

describe('TxnRow：复合交易展示标签（Bug2 回归）', () => {
  it('core 判为 transfer 的行渲染出「转账」meta，且不自补正号', () => {
    const accounts: AccountView[] = [
      { id: 1, name: 'Assets:Bank', uuid: 'u1', type: 'Assets', open_date: '2026-01-01', sort_order: 1 },
      { id: 3, name: 'Income:Discount', uuid: 'u3', type: 'Income', open_date: '2026-01-01', sort_order: 3 },
      { id: 6, name: 'Liabilities:Card', uuid: 'u6', type: 'Liabilities', open_date: '2026-01-01', sort_order: 6 },
    ]
    const compound: TransactionView = {
      id: 99,
      uuid: 'txn-99',
      date: '2026-11-20',
      flag: '*',
      description: '还信用卡',
      created_by_name: '阿文',
      postings: [
        { account_id: 1, account: 'Assets:Bank', commodity: 'CNY', amount: '-4997.00' },
        { account_id: 6, account: 'Liabilities:Card', commodity: 'CNY', amount: '5000.00' },
        { account_id: 3, account: 'Income:Discount', commodity: 'CNY', amount: '-3.00' },
      ],
    }
    const built = buildTxnRow(compound, accounts, 'search')
    const wrapper = mount(TxnRow, {
      props: { view: built, variant: 'search' },
      global: { plugins: [createPinia()] },
    })
    expect(wrapper.text()).toContain('转账')
    expect(wrapper.text()).not.toContain('收入')
    expect(built.signed).toBe(false)
    expect(built.badges).toEqual([])
  })
})
