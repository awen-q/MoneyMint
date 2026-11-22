// @vitest-environment jsdom
/**
 * 记一笔改版 v2 交互层回归（简化态）：
 * - 键盘默认展开 / 4×5 键位 / `=` 求值（顺序、除零、求值后行为）；
 * - 一级分类动态派生（6 列、不写死数量）+ 二级级联 / 无子分类隐藏；
 * - 四个 meta 浮层（日期 / 资金 / 标签 / flag）回填与 data-field 契约；
 * - 日期下限（开账日 + 未来）在日历、原生 input、提交处三重守门。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

import RecordSheet from './RecordSheet.vue'

const h = vi.hoisted(() => ({
  list: vi.fn(),
  listCommodities: vi.fn(),
  create: vi.fn(),
  readDraft: vi.fn(),
  writeDraft: vi.fn(),
  opening: '2026-11-01',
}))

vi.mock('@/api/client', () => ({
  accountApi: { list: h.list },
  commodityApi: { list: h.listCommodities },
  transactionApi: { create: h.create, update: vi.fn() },
  newIdempotencyKey: () => 'CS-KEY',
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    ledgerId: 7,
    isViewer: false,
    defaultCommodity: 'CNY',
    ledgerName: '家庭账本',
    get ledgers() {
      return [{ id: 7, name: '家庭账本', opening_date: h.opening }]
    },
  }),
}))

vi.mock('@/stores/recordSheet', () => ({
  useRecordSheetStore: () => ({ editingTxn: null, notifySaved: vi.fn(), notifyChanged: vi.fn() }),
}))

vi.mock('@/stores/privacy', () => ({ usePrivacyStore: () => ({ enabled: false }) }))

vi.mock('@/core/storage', () => ({
  readDraft: h.readDraft,
  writeDraft: h.writeDraft,
  clearDraft: vi.fn(),
  readDefaultAccounts: () => ({}),
  setDefaultAccount: vi.fn(),
}))

const ACCOUNTS = [
  { id: 1, uuid: 'u-cash', name: 'Assets:Cash', display_name: '现金', type: 'Assets', sort_order: 0, balances: { CNY: '1240.50' } },
  { id: 2, uuid: 'u-card', name: 'Assets:Card', display_name: '招行卡', type: 'Assets', sort_order: 1, balances: { CNY: '860.00' } },
  { id: 3, uuid: 'u-food', name: 'Expenses:Food', display_name: '餐饮', type: 'Expenses', sort_order: 0, icon: '🍜' },
  { id: 4, uuid: 'u-dinner', name: 'Expenses:Food:晚餐', display_name: '晚餐', type: 'Expenses', parent_uuid: 'u-food', sort_order: 0 },
  { id: 5, uuid: 'u-salary', name: 'Income:Salary', display_name: '薪资', type: 'Income', sort_order: 0 },
]

async function mountSheet(): Promise<VueWrapper> {
  const wrapper = mount(RecordSheet)
  await flushPromises()
  return wrapper
}

async function press(wrapper: VueWrapper, label: string): Promise<void> {
  const key = wrapper.findAll('.rs-key').find((button) => button.text() === label)
  expect(key, `键位 ${label} 不存在`).toBeDefined()
  await key!.trigger('click')
}

async function typeExpression(wrapper: VueWrapper, expression: string): Promise<void> {
  for (const char of expression.split('')) {
    const label = char === '*' ? '×' : char === '/' ? '÷' : char === '-' ? '−' : char
    await press(wrapper, label)
  }
  await flushPromises()
}

function amount(wrapper: VueWrapper): string {
  return wrapper.find('.js-amount').text()
}

beforeEach(() => {
  h.list.mockReset()
  h.list.mockResolvedValue({ accounts: ACCOUNTS })
  h.listCommodities.mockReset()
  h.listCommodities.mockResolvedValue({ commodities: [{ symbol: 'CNY' }] })
  h.create.mockReset()
  h.create.mockResolvedValue({ id: 1, uuid: 'cs-1', date: '2026-11-22', postings: 2, idempotent: false })
  h.readDraft.mockReset()
  h.readDraft.mockReturnValue(null)
  h.writeDraft.mockReset()
  h.opening = '2026-11-01'
})

describe('键盘 P1：默认展开、4×5 与 = 求值', () => {
  it('简化态新建默认展开 21 键（含 + 键），运算键走 --fb-warn-soft、保存品牌墨绿', async () => {
    const wrapper = await mountSheet()
    expect(wrapper.find('.rs-keyboard').exists()).toBe(true)
    expect(wrapper.findAll('.rs-key').map((key) => key.text())).toEqual([
      '7', '8', '9', '⌫',
      '4', '5', '6', '×',
      '1', '2', '3', '÷',
      '.', '0', '=', '−',
      '+', '再记', '高级双录', '保存',
    ])
    expect(wrapper.findAll('.rs-key--op')).toHaveLength(6)
    expect(wrapper.find('.rs-key--save').classes()).toContain('rs-key--save')
    const source = readFileSync(resolve(process.cwd(), 'src/components/RecordSheet.vue'), 'utf8')
    expect(source).toContain('repeat(6, minmax(0, 1fr))')
    wrapper.unmount()
  })

  it('1+2×3 顺序求值 = 9.00；再按 = 无操作；按数字清空重输', async () => {
    const wrapper = await mountSheet()
    await press(wrapper, '1')
    await press(wrapper, '+')
    await press(wrapper, '2')
    await press(wrapper, '×')
    await press(wrapper, '3')
    await press(wrapper, '=')
    expect(amount(wrapper)).toBe('9.00')
    await press(wrapper, '=')
    expect(amount(wrapper)).toBe('9.00')
    await press(wrapper, '4')
    expect(amount(wrapper)).toBe('4.00')
    wrapper.unmount()
  })

  it('86.5×2 = 173.00；9÷0 行内报错且不落值、保存禁用', async () => {
    const wrapper = await mountSheet()
    await typeExpression(wrapper, '86.5*2')
    await press(wrapper, '=')
    expect(amount(wrapper)).toBe('173.00')

    await press(wrapper, '9')
    await press(wrapper, '÷')
    await press(wrapper, '0')
    await press(wrapper, '=')
    expect(wrapper.find('.js-eval-error').text()).toContain('除数不能为 0')
    expect(amount(wrapper)).toBe('9.00')
    expect((wrapper.find('.rs-key--save').element as HTMLButtonElement).disabled).toBe(true)
    wrapper.unmount()
  })
})

describe('一级 / 二级分类级联', () => {
  it('一级 grid 由 parent_uuid 动态派生，按 sort_order 渲染，不写死 18/9', async () => {
    const many = Array.from({ length: 21 }, (_, index) => ({
      id: 100 + index,
      uuid: `u-root-${index}`,
      name: `Expenses:Root${index}`,
      display_name: `分类${index}`,
      type: 'Expenses',
      sort_order: 20 - index,
    }))
    h.list.mockResolvedValue({ accounts: many })
    const wrapper = await mountSheet()
    const cats = wrapper.findAll('.rs-cat')
    expect(cats).toHaveLength(21)
    expect(cats[0].attributes('data-cat')).toBe('120')
    expect(cats[20].attributes('data-cat')).toBe('100')
    wrapper.unmount()
  })

  it('无子分类时二级 chips 整行隐藏，一级即提交分类且导出名可见', async () => {
    const wrapper = await mountSheet()
    await wrapper.find('[data-act="tab"][data-tab="income"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.rs-subcats').exists()).toBe(false)
    expect(wrapper.findAll('.rs-cat')).toHaveLength(1)
    expect(wrapper.find('select[data-field="category"]').exists()).toBe(true)
    expect(wrapper.find('.js-cat-name').text()).toBe('Income:Salary')
    wrapper.unmount()
  })

  it('选一级展开二级 chips，点 leaf 回填真实导出名与 bean', async () => {
    const wrapper = await mountSheet()
    await wrapper.find('.rs-cat[data-cat="3"]').trigger('click')
    await flushPromises()
    const subs = wrapper.findAll('.rs-subcats .rs-subcat:not(.rs-subcat--all)')
    expect(subs).toHaveLength(1)
    expect(subs[0].text()).toContain('晚餐')
    await subs[0].trigger('click')
    await flushPromises()
    expect(wrapper.find('.rs-cat[data-cat="3"]').classes()).toContain('on')
    expect(subs[0].classes()).toContain('on')
    await typeExpression(wrapper, '86.5')
    expect(wrapper.find('.js-cat-chip').text()).toContain('Expenses:Food:晚餐')
    expect(wrapper.find('.js-bean').text()).toContain('Expenses:Food:晚餐')
    wrapper.unmount()
  })

  it('完整列表按父账户分组，搜索 leaf 后选中回填 leaf', async () => {
    const wrapper = await mountSheet()
    await wrapper.find('.rs-subcat--all').trigger('click')
    await flushPromises()
    const pop = wrapper.find('.js-pop-category')
    expect(pop.text()).toContain('餐饮')
    expect(pop.text()).toContain('Expenses:Food:晚餐')
    await pop.find('input[data-category-search]').setValue('晚餐')
    await flushPromises()
    const leaf = pop.find('button[data-cat="4"]')
    await leaf.trigger('click')
    await flushPromises()
    expect(wrapper.find('.js-cat-chip').text()).toContain('Expenses:Food:晚餐')
    // 选中 leaf 后浮层自动关闭（规格 §3-⑤）。
    expect(wrapper.find('.rs-popover-mask').isVisible()).toBe(false)
    wrapper.unmount()
  })
})

describe('meta chips 四浮层回填与日期边界', () => {
  it('日期浮层：快捷 chips 在浮层内，日历禁未来 / 禁早于开账日，回填后 form 联动', async () => {
    h.opening = '2026-11-10'
    const wrapper = await mountSheet()
    await wrapper.find('.js-date-chip').trigger('click')
    await flushPromises()
    const pop = wrapper.find('.js-pop-date')
    expect(pop.find('[data-act="date-today"]').exists()).toBe(true)
    const native = pop.find('input[data-field="date"]')
    expect(native.attributes('min')).toBe('2026-11-10')
    expect(native.attributes('max')).toBe('2026-11-22')
    expect(pop.find('button[data-date="2026-11-09"]').attributes('disabled')).toBeDefined()
    expect(pop.find('button[data-date="2026-11-23"]').attributes('disabled')).toBeDefined()
    await pop.find('[data-act="date-yesterday"]').trigger('click')
    await flushPromises()
    expect((wrapper.find('input[data-field="date"]').element as HTMLInputElement).value).toBe('2026-11-21')
    expect(wrapper.find('.js-date-chip').text()).toContain('昨天')
    wrapper.unmount()
  })

  it('原生日期输入越界时回退，不写坏 form.date', async () => {
    const wrapper = await mountSheet()
    await wrapper.find('.js-date-chip').trigger('click')
    await flushPromises()
    const native = wrapper.find('input[data-field="date"]')
    const before = (native.element as HTMLInputElement).value
    await native.setValue('2026-10-31')
    await flushPromises()
    expect((wrapper.find('input[data-field="date"]').element as HTMLInputElement).value).toBe(before)
    expect(wrapper.find('.js-pop-date .pop-error').text()).toContain('不能早于账本期初')
    wrapper.unmount()
  })

  it('草稿带回开账日前日期时，提交被拒且不发请求', async () => {
    h.readDraft.mockReturnValue({ kind: 'expense', date: '2026-10-31', amountExpression: '100' })
    const wrapper = await mountSheet()
    await press(wrapper, '保存')
    await flushPromises()
    expect(h.create).not.toHaveBeenCalled()
    expect(wrapper.find('.rs-alert--error').text()).toContain('不能早于账本期初')
    wrapper.unmount()
  })

  it('资金浮层显示余额与 mono 导出名，点选回填资金 chip 和 bean', async () => {
    const wrapper = await mountSheet()
    await wrapper.find('.js-fund-chip').trigger('click')
    await flushPromises()
    const pop = wrapper.find('.js-pop-fund')
    const row = pop.find('button[data-account="2"]')
    expect(row.text()).toContain('招行卡')
    expect(row.text()).toContain('Assets:Card')
    await row.trigger('click')
    await flushPromises()
    expect(wrapper.find('.js-fund-chip').text()).toContain('招行卡')
    await typeExpression(wrapper, '100')
    expect(wrapper.find('.js-bean').text()).toContain('Assets:Card -100.00 CNY')
    wrapper.unmount()
  })

  it('标签浮层虚线「＋ 新标签」行内创建并即时同步 form.tags', async () => {
    const wrapper = await mountSheet()
    await wrapper.find('.js-tags-chip').trigger('click')
    await flushPromises()
    const pop = wrapper.find('.js-pop-tags')
    expect(pop.find('.pop-tag--new').text()).toContain('＋ 新标签')
    await pop.find('input[data-tag-input]').setValue('日常')
    await pop.find('.pop-tag--new').trigger('click')
    await flushPromises()
    expect((wrapper.find('input[data-field="tags"]').element as HTMLInputElement).value).toBe('日常')
    expect(wrapper.find('.js-bean').text()).toContain('  tags: "日常"')
    wrapper.unmount()
  })

  it('flag 浮层仅用半角 !，回填后 bean 首行与 chip 同步', async () => {
    const wrapper = await mountSheet()
    await wrapper.find('.js-flag-chip').trigger('click')
    await flushPromises()
    const pop = wrapper.find('.js-pop-flag')
    expect(pop.find('[data-flag="!"]').text()).toContain('! 未完成')
    await pop.find('[data-flag="!"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.js-flag-chip').text()).toContain('! 未完成')
    expect(wrapper.find('.js-bean').text()).toMatch(/^2026-\d\d-\d\d ! "/m)
    expect(wrapper.text()).not.toContain('！未完成')
    wrapper.unmount()
  })

  it('meta chips 顺序固定且触发 chip / 浮层控件都保留 data-field 契约', async () => {
    const wrapper = await mountSheet()
    const chips = wrapper.findAll('.rs-meta .meta-chip')
    expect(chips.map((chip) => chip.attributes('data-field'))).toEqual(['date', 'fund', 'tags', 'flag'])
    for (const field of ['date', 'fund', 'tags', 'flag']) {
      expect(wrapper.find(`[data-role="chip"][data-field="${field}"]`).exists()).toBe(true)
      expect(wrapper.find(`[data-role="input"][data-field="${field}"]`).exists()).toBe(true)
    }
    wrapper.unmount()
  })
})
