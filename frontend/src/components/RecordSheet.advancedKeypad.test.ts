// @vitest-environment jsdom
/**
 * 规格 §12-1 / §1 / §7(c)：RecordSheet 高级行内键盘与 PC 浮层 portal。
 * - 移动端点行金额框 → 独立 advancedKeypadOpen，替代保存条，不唤起系统键盘；
 * - PC 行内物理输入，无内嵌键盘；弹窗高度内容自适应 + 视口上限，保证常驻 5 行键盘完整；
 * - 浮层 portal 到 mask 层宿主，不被 .rs-panel / .rs-body 的 overflow 裁剪，且层级高于金额区。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import RecordSheet from '@/components/RecordSheet.vue'

const h = vi.hoisted(() => ({ list: vi.fn(), commodityList: vi.fn(), create: vi.fn() }))

vi.mock('@/api/client', () => ({
  accountApi: { list: h.list },
  commodityApi: { list: h.commodityList },
  transactionApi: { create: h.create, update: vi.fn(), remove: vi.fn(), trash: vi.fn(), restore: vi.fn() },
  newIdempotencyKey: () => 'KEY-1',
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    ledgerId: 7,
    ledgerName: '家庭账本',
    isViewer: false,
    defaultCommodity: 'CNY',
    ledgers: [{ id: 7, name: '家庭账本', opening_date: '2026-01-01' }],
  }),
}))

vi.mock('@/stores/recordSheet', () => ({
  useRecordSheetStore: () => ({ notifySaved: vi.fn(), notifyChanged: vi.fn(), savedEpoch: 0, open: vi.fn() }),
}))

vi.mock('@/stores/privacy', () => ({ usePrivacyStore: () => ({ enabled: false }) }))
vi.mock('@/core/storage', () => ({
  readDraft: () => null,
  writeDraft: () => undefined,
  clearDraft: () => undefined,
  readDefaultAccounts: () => ({}),
  setDefaultAccount: () => undefined,
}))

const ACCOUNTS = [
  { id: 1, uuid: 'a1', name: 'Assets:WeChat', display_name: '微信', type: 'Assets', open_date: '2026-01-01', sort_order: 0 },
  { id: 2, uuid: 'a2', name: 'Assets:Bank', display_name: '银行', type: 'Assets', open_date: '2026-01-01', sort_order: 0, commodity_restriction: 'USD' },
  { id: 3, uuid: 'a3', name: 'Expenses:Food:晚餐', display_name: '晚餐', type: 'Expenses', open_date: '2026-01-01', sort_order: 0 },
  { id: 4, uuid: 'a4', name: 'Equity:Opening-Balances', display_name: '期初余额', type: 'Equity', open_date: '2026-01-01', sort_order: 0 },
]

function setWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
}

async function mountAdvanced(attach = false): Promise<VueWrapper> {
  const wrapper = mount(RecordSheet, attach ? { attachTo: document.body } : {})
  await flushPromises()
  const toggle = wrapper.findAll('button').find((button) => button.text().includes('高级双录'))
  expect(toggle, '高级双录入口不存在').toBeDefined()
  await toggle?.trigger('click')
  await flushPromises()
  return wrapper
}

async function pressKey(wrapper: VueWrapper, key: string): Promise<void> {
  const button = wrapper.findAll('.js-adv-keypad [data-act="key"]').find((item) => item.attributes('data-key') === key)
  expect(button, `键盘缺少按键 ${key}`).toBeDefined()
  await button?.trigger('click')
  await flushPromises()
}

beforeEach(() => {
  h.list.mockReset()
  h.commodityList.mockReset()
  h.create.mockReset()
  h.list.mockResolvedValue({ accounts: ACCOUNTS })
  h.commodityList.mockResolvedValue({ commodities: [{ symbol: 'CNY' }, { symbol: 'USD' }] })
  document.body.classList.remove('kbd-open')
  setWidth(1024)
})

afterEach(() => {
  document.body.classList.remove('kbd-open')
  document.querySelectorAll('.adv-popover-mask').forEach((element) => element.remove())
})

describe('§12-1：移动端高级行内键盘', () => {
  it('点行金额框 → 独立键盘吸附，替代保存条，无再记/高级双录/保存键', async () => {
    setWidth(500)
    const wrapper = await mountAdvanced()
    expect(wrapper.find('.js-adv-keypad').exists()).toBe(false)
    expect(wrapper.find('.rs-foot button').exists()).toBe(true)

    await wrapper.findAll('.rs-adv-row')[0].find('[data-rf="amt"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('.js-adv-keypad').exists()).toBe(true)
    expect(wrapper.find('.js-adv-keypad-done').text()).toBe('完成')
    expect(wrapper.find('.rs-foot button').exists()).toBe(false)
    expect(wrapper.findAll('.js-adv-keypad [data-key="再记"]')).toHaveLength(0)
    expect(wrapper.findAll('.js-adv-keypad [data-key="高级双录"]')).toHaveLength(0)
    expect(wrapper.findAll('.js-adv-keypad [data-key="保存"]')).toHaveLength(0)
    expect(wrapper.findAll('.js-adv-keypad [data-act="key"]')).toHaveLength(17)
    wrapper.unmount()
  })

  it('高级键盘键序锁定：前四行数字/运算 + 第五行「+」，含加号且无动作键混入', async () => {
    setWidth(500)
    const wrapper = await mountAdvanced()
    await wrapper.findAll('.rs-adv-row')[0].find('[data-rf="amt"]').trigger('click')
    await flushPromises()
    const order = wrapper.findAll('.js-adv-keypad [data-act="key"]').map((key) => key.attributes('data-key'))
    expect(order).toEqual(['7', '8', '9', '⌫', '4', '5', '6', '×', '1', '2', '3', '÷', '.', '0', '=', '−', '+'])
    wrapper.unmount()
  })

  it('焦点行整行高亮描边 + 金额框 readonly；完成时收起键盘并复现保存条', async () => {
    setWidth(500)
    const wrapper = await mountAdvanced()
    const row = wrapper.findAll('.rs-adv-row')[0]
    await row.find('[data-rf="amt"]').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.rs-adv-row')[0].classes()).toContain('rs-adv-row--focus')
    expect(wrapper.findAll('.rs-adv-row')[1].classes()).not.toContain('rs-adv-row--focus')
    // 移动端所有行金额框恒 readonly：focus 先于 click，不能让 iOS 系统键盘抢先弹出。
    expect(wrapper.findAll('[data-rf="amt"]')[0].attributes('readonly')).toBeDefined()
    expect(wrapper.findAll('[data-rf="amt"]')[1].attributes('readonly')).toBeDefined()

    await wrapper.find('.js-adv-keypad-done').trigger('click')
    await flushPromises()
    expect(wrapper.find('.js-adv-keypad').exists()).toBe(false)
    expect(wrapper.find('.rs-foot button').exists()).toBe(true)
    expect(wrapper.findAll('.rs-adv-row')[0].classes()).not.toContain('rs-adv-row--focus')
    wrapper.unmount()
  })

  it('行内 5+3 → = 8.00：加法键可用且只写焦点行', async () => {
    setWidth(500)
    const wrapper = await mountAdvanced()
    await wrapper.findAll('.rs-adv-row')[0].find('[data-rf="amt"]').trigger('click')
    await flushPromises()
    for (const key of ['5', '+', '3', '=']) {
      await pressKey(wrapper, key)
    }
    const amounts = wrapper.findAll('[data-rf="amt"]')
    expect((amounts[0].element as HTMLInputElement).value).toBe('8.00')
    expect((amounts[1].element as HTMLInputElement).value).toBe('')
    wrapper.unmount()
  })

  it('行内 86.5×2 → 173.00 只写焦点行；= 后保存条仍由 core 守门', async () => {
    setWidth(500)
    const wrapper = await mountAdvanced()
    await wrapper.findAll('.rs-adv-row')[0].find('[data-rf="amt"]').trigger('click')
    await flushPromises()
    for (const key of ['8', '6', '.', '5', '×', '2', '=']) {
      await pressKey(wrapper, key)
    }
    const amounts = wrapper.findAll('[data-rf="amt"]')
    expect((amounts[0].element as HTMLInputElement).value).toBe('173.00')
    expect((amounts[1].element as HTMLInputElement).value).toBe('')
    await wrapper.find('.js-adv-keypad-done').trigger('click')
    await flushPromises()
    expect((wrapper.find('.rs-foot button').element as HTMLButtonElement).disabled).toBe(true)
    wrapper.unmount()
  })

  it('高级键盘激活时 focusin 不误判为系统键盘（body.kbd-open 不置位）', async () => {
    setWidth(500)
    const wrapper = await mountAdvanced(true)
    const amt = wrapper.findAll('[data-rf="amt"]')[0]
    await amt.trigger('click')
    await flushPromises()
    expect(wrapper.find('.js-adv-keypad').exists()).toBe(true)

    amt.element.dispatchEvent(new Event('focusin', { bubbles: true }))
    expect(document.body.classList.contains('kbd-open')).toBe(false)
    expect(wrapper.find('.rs-keyboard:not(.rs-keyboard--advanced)').exists()).toBe(false)
    amt.element.dispatchEvent(new Event('focusout', { bubbles: true }))
    expect(document.body.classList.contains('kbd-open')).toBe(false)
    wrapper.unmount()
  })
})

describe('§12-1 PC / §1：物理键盘直输与 portal 承载', () => {
  it('PC 点行金额框不展开内嵌键盘，输入框可编辑', async () => {
    setWidth(1200)
    const wrapper = await mountAdvanced()
    const amt = wrapper.findAll('[data-rf="amt"]')[0]
    await amt.trigger('click')
    await flushPromises()
    expect(wrapper.find('.js-adv-keypad').exists()).toBe(false)
    expect(amt.attributes('readonly')).toBeUndefined()
    wrapper.unmount()
  })

  it('简化态浮层 portal 到 mask 宿主，不在 .rs-panel / .rs-body 内被裁剪', async () => {
    // 简化态才有 meta chips（日期 / 账户 / 标签 / flag / 分类）。
    const wrapper = mount(RecordSheet)
    await flushPromises()
    await wrapper.find('.js-date-chip').trigger('click')
    await flushPromises()
    const host = wrapper.find('.rs-portal-host')
    expect(host.exists()).toBe(true)
    expect(host.find('.rs-popover-mask').exists()).toBe(true)
    expect(wrapper.find('.rs-panel .rs-popover-mask').exists()).toBe(false)
    expect(wrapper.find('.rs-body .rs-popover-mask').exists()).toBe(false)
    wrapper.unmount()
  })

  it('PC 行账户浮层 Teleport 到 body，锚定坐标带翻转变量且可选到期初余额', async () => {
    setWidth(1200)
    const wrapper = await mountAdvanced()
    const chip = wrapper.findAll('.rs-adv-row')[0].find('[data-rf="acc"][data-role="chip"]')
    await chip.trigger('click')
    await flushPromises()
    const floating = document.body.querySelector('.adv-popover') as HTMLElement | null
    expect(floating).not.toBeNull()
    expect(floating?.getAttribute('data-popover')).toBe('acc')
    expect(floating?.style.getPropertyValue('--pop-left')).not.toBe('')
    expect(floating?.style.getPropertyValue('--pop-top')).not.toBe('')
    expect(floating?.style.getPropertyValue('--pop-width')).not.toBe('')

    const opening = floating?.querySelector('[data-account="4"]') as HTMLElement | null
    expect(opening?.textContent).toContain('Equity:Opening-Balances')
    opening?.click()
    await flushPromises()
    expect(document.body.querySelector('.adv-popover')).toBeNull()
    expect(wrapper.findAll('.rs-adv-row')[0].text()).toContain('期初余额')
    wrapper.unmount()
  })

  it('PC 弹窗高度自适应 + 视口上限，键盘不被裁切且内部滚动保留', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/RecordSheet.vue'), 'utf8')
    // 固定 height:min(520px,88vh) + overflow:hidden 会把 5 行键盘 dock 整段裁掉。
    expect(source).not.toMatch(/height:\s*min\(520px,\s*88vh\)/)
    expect(source).toMatch(/height:\s*auto;/)
    expect(source).toMatch(/max-height:\s*min\(720px,\s*calc\(var\(--vvh,\s*100vh\)\s*-\s*16px\)\)/)
    // PC 上 body 必须让位于常驻键盘，但仍保留自身滚动。
    expect(source).toMatch(/\.rs-mask--auto \.rs-body[\s\S]*?min-height:\s*0/)
    expect(source).toMatch(/\.rs-body[\s\S]*?overflow-y:\s*auto/)
    // fixed 宿主自身创建层叠上下文，必须抬升 z-index 才能盖过金额区 z-index:1。
    expect(source).toMatch(/\.rs-portal-host\s*\{[^}]*z-index:\s*70/)
    expect(source).toMatch(/<Teleport v-if="portalHostEl" :to="portalHostEl">/)
  })
})

describe('BUG-3：高级态保存成功 →「再记一笔」回简化态默认口径', () => {
  it('advancedMode 复位、行内键盘收起、高级双录键回归、简化键盘默认展开', async () => {
    setWidth(500)
    h.create.mockResolvedValue({
      id: 11,
      uuid: 'u-again',
      date: '2026-11-22',
      postings: 2,
      idempotent: false,
    })
    const wrapper = await mountAdvanced()
    // 第 1 行 +5.00；第 2 行先录入再切贷方 → -5.00，配平可保存。
    await wrapper.findAll('.rs-adv-row')[0].find('[data-rf="amt"]').trigger('click')
    await flushPromises()
    for (const key of ['5', '=']) {
      await pressKey(wrapper, key)
    }
    await wrapper.findAll('.rs-adv-row')[1].find('[data-rf="amt"]').trigger('click')
    await flushPromises()
    // 默认第 2 行账户是 USD 限制户，换成 CNY 户才能与第 1 行按币种配平。
    await wrapper.findAll('.rs-adv-row')[1].find('select.acc-contract').setValue('3')
    await flushPromises()
    for (const key of ['5', '=']) {
      await pressKey(wrapper, key)
    }
    await wrapper.findAll('.rs-adv-row')[1].find('[data-rf="dir"][data-dir="credit"]').trigger('click')
    await flushPromises()
    // 「完成」收起行内键盘，底部保存条复现。
    await wrapper.find('.js-adv-keypad-done').trigger('click')
    await flushPromises()
    expect(wrapper.find('.js-save').attributes('disabled')).toBeUndefined()

    await wrapper.find('.js-save').trigger('click')
    await flushPromises()
    expect(wrapper.find('.rs-rcpt-btn--primary').exists()).toBe(true)
    await wrapper.find('.rs-rcpt-btn--primary').trigger('click')
    await flushPromises()

    expect(wrapper.find('.js-advrows').exists()).toBe(false)
    expect(wrapper.find('.js-adv-keypad').exists()).toBe(false)
    expect(wrapper.find('.rs-keyboard').exists()).toBe(true)
    expect(wrapper.findAll('[data-key="高级双录"]')).toHaveLength(1)
    expect(wrapper.findAll('[data-key="保存"]')).toHaveLength(1)
    wrapper.unmount()
  })
})
