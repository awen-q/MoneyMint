// @vitest-environment jsdom
/**
 * P0 快捷日期条回归：本地时区、跨月、期初守门、三处联动、iOS14 门禁。
 * 票面 nowText 固定为「保存时刻」，不随 form.date 变化。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

import RecordSheet from './RecordSheet.vue'

const h = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  opening: '2026-01-01',
  editingTxn: null as unknown,
}))

vi.mock('@/api/client', () => ({
  accountApi: { list: h.list },
  transactionApi: { create: h.create, update: vi.fn() },
  newIdempotencyKey: () => 'QD-KEY',
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    ledgerId: 7,
    isViewer: false,
    needsInvite: false,
    defaultCommodity: 'CNY',
    ledgers: [{ id: 7, name: '家庭账本', opening_date: h.opening }],
    ledgerName: '家庭账本',
  }),
}))

vi.mock('@/stores/recordSheet', () => ({
  useRecordSheetStore: () => ({
    editingTxn: h.editingTxn,
    notifySaved: vi.fn(),
    notifyChanged: vi.fn(),
  }),
}))

vi.mock('@/stores/privacy', () => ({
  usePrivacyStore: () => ({ enabled: false }),
}))

const ACCOUNTS = [
  { id: 1, uuid: 'u-cash', name: 'Assets:Cash', display_name: '现金', type: 'Assets' },
  { id: 2, uuid: 'u-food', name: 'Expenses:Food', display_name: '食品', type: 'Expenses' },
]

async function mountSheet(): Promise<VueWrapper> {
  const wrapper = mount(RecordSheet)
  await flushPromises()
  return wrapper
}

function dateValue(wrapper: VueWrapper): string {
  return (wrapper.find('[data-field="date"]').element as HTMLInputElement).value
}

async function enter100AndSave(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('[data-act="amount"]').trigger('click')
  for (const key of ['1', '0', '0']) {
    const button = wrapper.findAll('.rs-key').find((b) => b.text() === key)
    await button?.trigger('click')
  }
  const save = wrapper.findAll('.rs-key').find((b) => b.text() === '保存')
  await save?.trigger('click')
  await flushPromises()
}

beforeEach(() => {
  // 只伪造 Date，保留 setTimeout/nextTick，flushPromises 才能正常工作。
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 2, 1, 10, 0, 0))
  h.opening = '2026-01-01'
  h.editingTxn = null
  h.list.mockReset().mockResolvedValue({ accounts: ACCOUNTS })
  h.create.mockReset().mockResolvedValue({
    id: 9, uuid: 't-9', date: '2026-02-28', flag: '*', description: '测试', postings: 2,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('快捷日期条：本地时区 + 三处联动', () => {
  it('今天系统日 3/1 点「昨天」得 2/28（setDate 跨月，非毫秒算术）', async () => {
    const wrapper = await mountSheet()
    expect(dateValue(wrapper)).toBe('2026-03-01')

    await wrapper.find('[data-act="date-yesterday"]').trigger('click')
    await flushPromises()

    expect(dateValue(wrapper)).toBe('2026-02-28')
    expect(wrapper.find('.head-sub').text()).toContain('2026-02-28')
    expect(wrapper.find('.js-bean').text()).toContain('2026-02-28')
    expect(wrapper.find('[data-act="date-yesterday"]').classes()).toContain('on')
    expect(wrapper.find('[data-act="date-today"]').classes()).not.toContain('on')
    wrapper.unmount()
  })

  it('「前天」按本地日历日计算，系统日 3/3 → 3/1', async () => {
    vi.setSystemTime(new Date(2026, 2, 3, 10, 0, 0))
    const wrapper = await mountSheet()
    await wrapper.find('[data-act="date-day-before"]').trigger('click')
    await flushPromises()
    expect(dateValue(wrapper)).toBe('2026-03-01')
    wrapper.unmount()
  })

  it('Bean 预览、票面 Bean 随日期联动；票面时间戳仍是保存时刻', async () => {
    const wrapper = await mountSheet()
    await wrapper.find('[data-act="date-yesterday"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.js-bean').text()).toContain('2026-02-28')

    await enter100AndSave(wrapper)
    expect(h.create).toHaveBeenCalledTimes(1)
    expect((h.create.mock.calls[0][0] as { date: string }).date).toBe('2026-02-28')
    expect(wrapper.find('.slip__bean').text()).toContain('2026-02-28')
    // nowText 是保存时刻，落在票尾 footLines，不随 form.date 变；状态章只含「已保存SAVED」。
    expect(wrapper.find('.slip__foot').text()).toContain('2026-03-01 10:00:00')
    expect(wrapper.find('.slip__stamp').text()).not.toContain('2026-03-01 10:00:00')
    wrapper.unmount()
  })
})

describe('快捷日期条：账本期初守门（前端唯一防线）', () => {
  it('前天早于期初时拒绝、不改 form.date 并给中文提示', async () => {
    vi.setSystemTime(new Date(2026, 2, 3, 10, 0, 0))
    h.opening = '2026-03-02'
    const wrapper = await mountSheet()
    expect(dateValue(wrapper)).toBe('2026-03-03')

    await wrapper.find('[data-act="date-day-before"]').trigger('click')
    await flushPromises()

    expect(dateValue(wrapper)).toBe('2026-03-03')
    expect(wrapper.text()).toContain('不能早于账本期初 2026-03-02')
    expect(wrapper.find('.js-bean').text()).not.toContain('2026-03-01')
    wrapper.unmount()
  })

  it('期初等于前天时允许（字典序比较，含等号）', async () => {
    vi.setSystemTime(new Date(2026, 2, 3, 10, 0, 0))
    h.opening = '2026-03-01'
    const wrapper = await mountSheet()
    await wrapper.find('[data-act="date-day-before"]').trigger('click')
    await flushPromises()
    expect(dateValue(wrapper)).toBe('2026-03-01')
    expect(wrapper.text()).not.toContain('不能早于账本期初')
    wrapper.unmount()
  })

  it('取不到账本期初时兜底今天，所有过去日期被保守拒绝', async () => {
    vi.setSystemTime(new Date(2026, 2, 3, 10, 0, 0))
    h.opening = ''
    const wrapper = await mountSheet()
    // form 是模块级单例，date 可能被前一个用例改写；以 mount 后的实际值为准，
    // 只断言「点过去日期被拒、form.date 不变」，不依赖固定的初始值。
    const initial = dateValue(wrapper)
    await wrapper.find('[data-act="date-yesterday"]').trigger('click')
    await flushPromises()
    expect(dateValue(wrapper)).toBe(initial)
    expect(wrapper.text()).toContain('不能早于账本期初 2026-03-03')
    wrapper.unmount()
  })
})

describe('iOS14 兼容门禁', () => {
  it('快捷日期实现未使用 UTC / DST 不安全 / 新版 API', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/RecordSheet.vue'),
      'utf8',
    )
    for (const forbidden of ['toISOString(', '.at(', 'structuredClone', 'padStart', 'Object.hasOwn']) {
      expect(source, `源码不应出现 ${forbidden}`).not.toContain(forbidden)
    }
  })
})
