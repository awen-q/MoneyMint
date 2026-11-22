// @vitest-environment jsdom
/**
 * 记一笔最终稿回归（T04）：
 * - H5 全屏 / PC 弹窗容器类与形态切换（CSS 断点，不探测设备）；
 * - 真实账户源：中文 display_name 作主文案，ASCII name 进导出预览；
 * - flag 随控件变化写入提交载荷与草稿快照；
 * - bean 片段逐字对齐 Go，中文标签走 tags 元数据行、金额无千分位；
 * - 主操作全局唯一、无「取消」、不平衡禁保存（含 disabled 原生派发守门）；
 * - --vvh / body.kbd-open 监听在 unmount 后成对清理。
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
  update: vi.fn(),
  readDraft: vi.fn(),
  writeDraft: vi.fn(),
  newKey: vi.fn(() => 'RD-KEY-1'),
  editing: { value: null as Record<string, unknown> | null },
}))

vi.mock('@/api/client', () => ({
  accountApi: { list: h.list },
  commodityApi: { list: h.listCommodities },
  transactionApi: { create: h.create, update: h.update },
  newIdempotencyKey: h.newKey,
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    ledgerId: 7,
    isViewer: false,
    defaultCommodity: 'CNY',
    ledgerName: '家庭账本',
  }),
}))

vi.mock('@/stores/recordSheet', () => ({
  useRecordSheetStore: () => ({
    get editingTxn() {
      return h.editing.value
    },
    notifySaved: vi.fn(),
    notifyChanged: vi.fn(),
  }),
}))

vi.mock('@/stores/privacy', () => ({
  usePrivacyStore: () => ({ enabled: false }),
}))

vi.mock('@/core/storage', () => ({
  readDraft: h.readDraft,
  writeDraft: h.writeDraft,
  clearDraft: vi.fn(),
  readDefaultAccounts: () => ({}),
  setDefaultAccount: vi.fn(),
}))

const ACCOUNTS = [
  { id: 1, uuid: 'u-cash', name: 'Assets:Cash', display_name: '现金', type: 'Assets', open_date: '2026-01-01', sort_order: 0 },
  { id: 2, uuid: 'u-food', name: 'Expenses:Food', display_name: '食品饮料', type: 'Expenses', open_date: '2026-01-01', sort_order: 0 },
  { id: 3, uuid: 'u-salary', name: 'Income:Salary', display_name: '工资收入', type: 'Income', open_date: '2026-01-01', sort_order: 0 },
]

const OK_RESULT = { id: 1, uuid: 'rd-1', date: '2026-11-16', postings: 2, idempotent: false }

/** 点金额区展开自定义键盘（默认收起是新交互，用例必须走真实点击路径）。 */
async function openKeypad(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('[data-act="amount"]').trigger('click')
  await flushPromises()
}

/**
 * 简化态新建默认展开键盘（规格 §5-K）；
 * 验证收起态的用例显式传 { keypad: false }，由本 helper 点真实收起键。
 */
async function mountSheet(
  props: Record<string, unknown> = {},
  options: { keypad?: boolean } = {},
): Promise<VueWrapper> {
  const wrapper = mount(RecordSheet, { props })
  await flushPromises()
  if (options.keypad === false) {
    const hide = wrapper.find('[data-act="hide-keypad"]')
    if (hide.exists()) {
      await hide.trigger('click')
    }
  }
  return wrapper
}

async function press(wrapper: VueWrapper, label: string): Promise<void> {
  const key = wrapper.findAll('.rs-key').find((button) => button.text() === label)
  expect(key, `键位 ${label} 不存在`).toBeDefined()
  await key!.trigger('click')
}

async function enterAmount(wrapper: VueWrapper, digits: string): Promise<void> {
  for (const digit of digits.split('')) {
    await press(wrapper, digit)
  }
  await flushPromises()
}

beforeEach(() => {
  h.list.mockReset()
  h.list.mockResolvedValue({ accounts: ACCOUNTS })
  h.listCommodities.mockReset()
  h.listCommodities.mockResolvedValue({ commodities: [{ symbol: 'CNY' }, { symbol: 'USD' }] })
  h.create.mockReset()
  h.create.mockResolvedValue(OK_RESULT)
  h.update.mockReset()
  h.readDraft.mockReset()
  h.readDraft.mockReturnValue(null)
  h.writeDraft.mockReset()
  h.newKey.mockClear()
  h.editing.value = null
  document.body.classList.remove('kbd-open')
  document.documentElement.style.removeProperty('--vvh')
})

describe('容器形态与主操作唯一', () => {
  it('默认 auto 容器铺 H5 全屏，简化态无 .rs-foot、无「取消」', async () => {
    const wrapper = await mountSheet({}, { keypad: false })
    expect(wrapper.find('.rs-mask').classes()).toContain('rs-mask--auto')
    expect(wrapper.find('.rs-panel').exists()).toBe(true)
    expect(wrapper.find('.rs-keyboard').exists()).toBe(false)
    await openKeypad(wrapper)
    expect(wrapper.find('.rs-keyboard').exists()).toBe(true)
    expect(wrapper.find('.rs-foot').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('取消')
    const saves = wrapper.findAll('button').filter((button) => button.text() === '保存')
    expect(saves).toHaveLength(1)
    wrapper.unmount()
  })

  it('variant 显式覆盖生效；高级态无键盘、仅底部一条全宽保存条', async () => {
    const wrapper = await mountSheet({ variant: 'dialog' })
    expect(wrapper.find('.rs-mask').classes()).toContain('rs-mask--dialog')
    const toggle = wrapper.findAll('button').find((button) => button.text().includes('高级双录'))
    await toggle!.trigger('click')
    await flushPromises()
    expect(wrapper.find('.rs-keyboard').exists()).toBe(false)
    expect(wrapper.find('.rs-foot button.fb-btn-primary').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('取消')
    wrapper.unmount()
  })

  it('键位严格为 4×5+动作条：7 8 9 ⌫ / 4 5 6 × / 1 2 3 ÷ / . 0 = − / + 再记 高级双录 保存', async () => {
    const wrapper = await mountSheet()
    const keys = wrapper.findAll('.rs-key').map((button) => button.text())
    expect(keys).toEqual([
      '7', '8', '9', '⌫',
      '4', '5', '6', '×',
      '1', '2', '3', '÷',
      '.', '0', '=', '−',
      '+', '再记', '高级双录', '保存',
    ])
    wrapper.unmount()
  })
})

describe('自定义数字键盘：新建态默认展开，收起 / 展开入口保留', () => {
  it('简化态新建默认展开键盘，且始终只有一个保存入口', async () => {
    const wrapper = await mountSheet()
    expect(wrapper.find('.rs-keyboard').exists()).toBe(true)
    expect(wrapper.find('.rs-foot').exists()).toBe(false)
    expect(wrapper.find('.rs-body').exists()).toBe(true)
    expect(wrapper.find('[data-act="hide-keypad"]').exists()).toBe(true)
    expect(wrapper.findAll('button').filter((button) => button.text() === '保存')).toHaveLength(1)
    wrapper.unmount()
  })

  it('点金额区保持展开，20 个键位顺序保持不变', async () => {
    const wrapper = await mountSheet()
    await wrapper.find('[data-act="amount"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.rs-keyboard').exists()).toBe(true)
    const keys = wrapper.findAll('.rs-key').map((button) => button.text())
    expect(keys).toEqual([
      '7', '8', '9', '⌫',
      '4', '5', '6', '×',
      '1', '2', '3', '÷',
      '.', '0', '=', '−',
      '+', '再记', '高级双录', '保存',
    ])
    wrapper.unmount()
  })

  it('收起态提示条可展开，展开态「收起」按钮可收回', async () => {
    const wrapper = await mountSheet({}, { keypad: false })
    expect(wrapper.find('[data-act="show-keypad"]').exists()).toBe(true)
    await wrapper.find('[data-act="show-keypad"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.rs-keyboard').exists()).toBe(true)
    await wrapper.find('[data-act="hide-keypad"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.rs-keyboard').exists()).toBe(false)
    expect(wrapper.find('[data-act="show-keypad"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('展开 / 收起两态「保存」均不超过 1 个，展开后仍走原提交路径', async () => {
    const wrapper = await mountSheet({}, { keypad: false })
    const saveCount = (): number => wrapper.findAll('button').filter((button) => button.text() === '保存').length
    expect(saveCount()).toBe(0)
    await openKeypad(wrapper)
    expect(saveCount()).toBe(1)
    expect(wrapper.find('.rs-key--save').exists()).toBe(true)
    await enterAmount(wrapper, '100')
    await press(wrapper, '保存')
    await flushPromises()
    expect(h.create).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('表单控件聚焦自动收起自定义键盘，body.kbd-open 生命周期不受影响', async () => {
    const wrapper = mount(RecordSheet, { attachTo: document.body })
    await flushPromises()
    await openKeypad(wrapper)
    expect(wrapper.find('.rs-keyboard').exists()).toBe(true)

    const tags = wrapper.find('input[data-field="tags"]')
    tags.element.dispatchEvent(new Event('focusin', { bubbles: true }))
    await flushPromises() // keypadOpen 走响应式渲染，focusin 后需等 DOM 更新
    expect(wrapper.find('.rs-keyboard').exists()).toBe(false)
    expect(document.body.classList.contains('kbd-open')).toBe(true)
    tags.element.dispatchEvent(new Event('focusout', { bubbles: true }))
    expect(document.body.classList.contains('kbd-open')).toBe(false)

    wrapper.unmount()
  })

  it('高级态与编辑态不受 keypadOpen 影响，仍只有 .rs-foot 保存条', async () => {
    const wrapper = await mountSheet({}, { keypad: false })
    // 键盘收起时走预览条上的高级入口；展开时走键盘「高级双录」键。
    const toggle = wrapper.find('[data-act="advanced"]')
    expect(toggle.exists()).toBe(true)
    await toggle.trigger('click')
    await flushPromises()
    await wrapper.find('[data-act="amount"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.rs-keyboard').exists()).toBe(false)
    expect(wrapper.find('.rs-foot button.fb-btn-primary').exists()).toBe(true)
    expect(wrapper.findAll('button').filter((button) => button.text() === '保存')).toHaveLength(1)
    wrapper.unmount()

    h.editing.value = {
      uuid: 't-e',
      date: '2026-11-16',
      flag: '*',
      description: '午餐',
      tags: [],
      postings: [
        { account_id: 2, account: 'Expenses:Food', commodity: 'CNY', amount: '38.50' },
        { account_id: 1, account: 'Assets:Cash', commodity: 'CNY', amount: '-38.50' },
      ],
    }
    const editing = await mountSheet({}, { keypad: false })
    expect(editing.find('.rs-keyboard').exists()).toBe(false)
    expect(editing.find('.rs-foot button.fb-btn-primary').exists()).toBe(true)
    expect(editing.findAll('button').filter((button) => button.text() === '保存')).toHaveLength(1)
    editing.unmount()
    h.editing.value = null
  })
})

describe('真实账户源与 bean 预览', () => {
  it('九宫格显示中文 display_name，完整列表与 bean 使用 ASCII name', async () => {
    const wrapper = await mountSheet()
    const cats = wrapper.findAll('.rs-cat')
    expect(cats.length).toBeGreaterThan(0)
    expect(cats[0].text()).toContain('食品饮料')
    expect(cats[0].classes()).toContain('on')
    expect(wrapper.find('select[data-field="category"] option[value="2"]').text()).toContain('Expenses:Food')

    await enterAmount(wrapper, '100')
    const bean = wrapper.find('.js-bean').text()
    expect(bean).toContain('Expenses:Food 100.00 CNY')
    expect(bean).toContain('Assets:Cash -100.00 CNY')
    expect(bean).not.toMatch(/[0-9],[0-9]{3}/)
    wrapper.unmount()
  })

  it('标签兼容空格与中英文逗号，导出统一单空格的 tags 元数据行', async () => {
    const wrapper = await mountSheet()
    await enterAmount(wrapper, '100')
    const tagsInput = wrapper.find('input[data-field="tags"]')
    await tagsInput.setValue('日常，孩子 通勤')
    await flushPromises()
    const bean = wrapper.find('.js-bean').text()
    expect(bean).toContain('  tags: "日常 孩子 通勤"')
    expect(bean).not.toContain('#日常')
    wrapper.unmount()
  })

  it('账户列表为空时显示空态而非稿内示例账户', async () => {
    h.list.mockResolvedValue({ accounts: [] })
    const wrapper = await mountSheet()
    expect(wrapper.text()).toContain('当前账本暂无支出分类账户')
    expect(wrapper.text()).not.toContain('Expenses:Groceries')
    wrapper.unmount()
  })
})

describe('flag 透传与草稿快照', () => {
  it('flag 切到 ! 后写入 create 载荷；预览首行同步变化', async () => {
    const wrapper = await mountSheet()
    await enterAmount(wrapper, '100')
    await wrapper.find('select[data-field="flag"]').setValue('!')
    await flushPromises()
    expect(wrapper.find('.js-bean').text()).toMatch(/^2026-\d\d-\d\d ! "/m)

    await press(wrapper, '保存')
    await flushPromises()
    expect(h.create).toHaveBeenCalledTimes(1)
    expect((h.create.mock.calls[0][0] as Record<string, unknown>).flag).toBe('!')
    wrapper.unmount()
  })

  it('草稿快照包含 flag，刷新恢复后控件回显', async () => {
    const wrapper = await mountSheet()
    await wrapper.find('select[data-field="flag"]').setValue('!')
    await flushPromises()
    const last = h.writeDraft.mock.calls[h.writeDraft.mock.calls.length - 1]
    expect(last).toBeDefined()
    expect((last[1] as Record<string, unknown>).flag).toBe('!')

    h.readDraft.mockReturnValue({ flag: '!', amountExpression: '88', kind: 'expense' })
    const restored = await mountSheet()
    expect((restored.find('select[data-field="flag"]').element as HTMLSelectElement).value).toBe('!')
    restored.unmount()
    wrapper.unmount()
  })
})

describe('配平守门与禁用态', () => {
  it('高级态不平衡时保存 disabled，原生派发点击也不发请求', async () => {
    const wrapper = await mountSheet()
    const toggle = wrapper.findAll('button').find((button) => button.text().includes('高级双录'))
    await toggle!.trigger('click')
    await flushPromises()

    const rows = wrapper.findAll('.rs-adv-row')
    await rows[0].find('[data-rf="amt"]').setValue('100.00')
    await rows[1].find('[data-rf="amt"]').setValue('-30.00')
    await flushPromises()

    const save = wrapper.find('.rs-foot button.fb-btn-primary')
    expect((save.element as HTMLButtonElement).disabled).toBe(true)
    expect(wrapper.find('.js-check').text()).toContain('70.00')

    save.element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(h.create).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('分录不配平')
    wrapper.unmount()
  })

  it('auto-balance 补行账户留空 → 保存保持 disabled', async () => {
    const wrapper = await mountSheet()
    const toggle = wrapper.findAll('button').find((button) => button.text().includes('高级双录'))
    await toggle!.trigger('click')
    await flushPromises()
    const rows = wrapper.findAll('.rs-adv-row')
    await rows[0].find('[data-rf="amt"]').setValue('100.00')
    await rows[1].find('[data-rf="amt"]').setValue('-30.00')
    await flushPromises()

    await wrapper.find('[data-act="auto-balance"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.rs-adv-row')).toHaveLength(3)
    expect((wrapper.find('.rs-foot button.fb-btn-primary').element as HTMLButtonElement).disabled).toBe(true)
    expect(wrapper.find('[data-rf="acc"]').element).toBeDefined()
    expect(h.create).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

describe('形态与键盘避让的副作用清理', () => {
  it('--vvh 有 100vh 之后的 px 兜底；卸载后移除 --vvh 与 kbd-open 与监听', async () => {
    // 键盘避让监听挂在 document 上，VTU 默认挂载到游离节点，需 attachTo 才能走完整冒泡链。
    const wrapper = mount(RecordSheet, { attachTo: document.body })
    await flushPromises()
    const vv = document.documentElement.style.getPropertyValue('--vvh')
    expect(vv).toMatch(/^\d+px$/)

    const tags = wrapper.find('input[data-field="tags"]')
    expect(tags.element.matches('input.inp-text')).toBe(true)
    tags.element.dispatchEvent(new Event('focusin', { bubbles: true }))
    expect(document.body.classList.contains('kbd-open')).toBe(true)
    tags.element.dispatchEvent(new Event('focusout', { bubbles: true }))
    expect(document.body.classList.contains('kbd-open')).toBe(false)

    tags.element.dispatchEvent(new Event('focusin', { bubbles: true }))
    wrapper.unmount()
    expect(document.body.classList.contains('kbd-open')).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--vvh')).toBe('')
  })

  it('键盘态选择器覆盖高级金额框 data-rf="amt"，且三处判定共用同一常量', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/RecordSheet.vue'), 'utf8')
    // 常量同时纳入简化态 inp-text 与高级态金额框钩子。
    expect(source).toMatch(/input\.inp-text, textarea\.inp-text, input\[data-rf='amt'\]/)
    // onFocusIn / onFocusOut / openKeypad 反向互斥必须共用常量，防止任一处漏改再度脱节。
    expect(source.match(/matches\(SYSTEM_KEYBOARD_TARGET\)/g) ?? []).toHaveLength(3)
    expect(source).not.toMatch(/matches\(['"]input\.inp-text, textarea\.inp-text['"]\)/)
  })

  it('高级录入金额框聚焦进入键盘态、失焦退出（跨子组件冒泡）', async () => {
    // focusin 监听挂在 document 上，VTU 默认游离节点无法冒泡，必须 attachTo。
    const wrapper = mount(RecordSheet, { attachTo: document.body })
    await flushPromises()
    const toggle = wrapper.findAll('button').find((button) => button.text().includes('高级双录'))
    expect(toggle, '高级双录切换按钮不存在').toBeDefined()
    await toggle!.trigger('click')
    await flushPromises()

    const amtInput = wrapper.find('input[data-rf="amt"]')
    expect(amtInput.exists(), '高级金额框不存在').toBe(true)
    expect(document.body.classList.contains('kbd-open')).toBe(false)

    amtInput.element.dispatchEvent(new Event('focusin', { bubbles: true }))
    expect(document.body.classList.contains('kbd-open')).toBe(true)
    amtInput.element.dispatchEvent(new Event('focusout', { bubbles: true }))
    expect(document.body.classList.contains('kbd-open')).toBe(false)

    wrapper.unmount()
  })
})

describe('编辑态（冲正 + 新建）：无类型 Tab 与金额舞台', () => {
  /** Beancount 交易无类型字段：编辑态类型未知，去掉顶部 Tab 与金额舞台，类型交给分录 + 配平。 */
  const EDIT_TXN = {
    uuid: 't-edit',
    date: '2026-11-16',
    flag: '*',
    description: '午餐',
    tags: ['日常'],
    postings: [
      { account_id: 2, account: 'Expenses:Food', commodity: 'CNY', amount: '38.50' },
      { account_id: 1, account: 'Assets:Cash', commodity: 'CNY', amount: '-38.50' },
    ],
  }

  it('编辑态移除 rs-stage（类型 Tab + 金额舞台），保留冲正横幅与高级双录分录', async () => {
    h.editing.value = EDIT_TXN
    const wrapper = await mountSheet({}, { keypad: false })
    // ① 不存在类型 Tab；② 不存在金额舞台（含 rs-stage 容器整块）。
    expect(wrapper.find('.rs-tabs').exists()).toBe(false)
    expect(wrapper.find('.rs-amount').exists()).toBe(false)
    expect(wrapper.find('.rs-stage').exists()).toBe(false)
    // ③ 冲正横幅存在且带原交易描述。
    expect(wrapper.find('.rs-editbanner').exists()).toBe(true)
    expect(wrapper.find('.rs-editbanner').text()).toContain('午餐')
    // ④ 高级双录渲染：预填两行分录，且无「返回简化模式」入口（带回类型暗示）。
    expect(wrapper.find('.js-advrows').exists()).toBe(true)
    expect(wrapper.findAll('.rs-adv-row')).toHaveLength(2)
    expect(wrapper.find('[data-act="back-simple"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('返回简化模式')
    wrapper.unmount()
    h.editing.value = null
  })

  it('编辑态保存走 update（冲正），票面类型标签固定为「修改 EDIT」', async () => {
    h.editing.value = EDIT_TXN
    h.update.mockReset()
    h.update.mockResolvedValue({ new_uuid: 't-new' })
    const wrapper = await mountSheet({}, { keypad: false })
    const save = wrapper.find('.rs-foot button.fb-btn-primary')
    expect(save.exists()).toBe(true)
    await save.trigger('click')
    await flushPromises()
    expect(h.update).toHaveBeenCalledTimes(1)
    // 钉死：编辑绝不走新建幂等路径（冲正 + 新建语义下 create 必须零调用）。
    expect(h.create).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('修改 EDIT')
    expect(wrapper.text()).not.toContain('支出 EXPENSE')
    wrapper.unmount()
    h.editing.value = null
  })

  it('编辑态保存失败：错误提示 alert 不随 rs-stage 移除而丢失', async () => {
    h.editing.value = EDIT_TXN
    h.update.mockRejectedValueOnce(new Error('net down'))
    const wrapper = await mountSheet({}, { keypad: false })
    const save = wrapper.find('.rs-foot button.fb-btn-primary')
    expect(save.exists()).toBe(true)
    await save.trigger('click')
    await flushPromises()
    // rs-alert 容器在 rs-stage 之外，编辑态移除 stage 后保存失败信息仍可见。
    const alert = wrapper.find('.rs-alert--error')
    expect(alert.exists()).toBe(true)
    expect(alert.text()).toContain('修改失败')
    wrapper.unmount()
    h.editing.value = null
  })

  it('新建态回归保护：rs-stage / 类型 Tab / 金额舞台仍按原结构渲染', async () => {
    const wrapper = await mountSheet({}, { keypad: false })
    expect(wrapper.find('.rs-stage').exists()).toBe(true)
    expect(wrapper.find('.rs-tabs').exists()).toBe(true)
    expect(wrapper.findAll('.rs-tabs button')).toHaveLength(3)
    expect(wrapper.find('.rs-amount').exists()).toBe(true)
    expect(wrapper.find('.rs-editbanner').exists()).toBe(false)
    wrapper.unmount()
  })
})
