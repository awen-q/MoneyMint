// @vitest-environment jsdom
/**
 * 0.6.0 S2 币种页回归（AC-4.1 / AC-4.2 / AC-4.6）：
 * 列表渲染、新增提交、409 分项中文原因、viewer 隐藏写操作。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import { ApiError } from '@/api/errors'
import CommoditiesView from '@/views/CommoditiesView.vue'

const h = vi.hoisted(() => ({
  accountList: vi.fn(),
  txnList: vi.fn(),
  cmdList: vi.fn(),
  cmdCreate: vi.fn(),
  cmdRemove: vi.fn(),
  isViewer: false,
}))

vi.mock('@/api/client', () => ({
  accountApi: { list: h.accountList },
  transactionApi: { list: h.txnList },
  commodityApi: { list: h.cmdList, create: h.cmdCreate, remove: h.cmdRemove },
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    ledgerId: 7,
    get isViewer() {
      return h.isViewer
    },
    defaultCommodity: 'CNY',
    ledgers: [{ id: 7, name: '测试账本', opening_date: '2026-01-01', role: 'owner' }],
  }),
}))

vi.mock('@/components/MoneyText.vue', () => ({
  default: {
    props: ['amount', 'commodity', 'size'],
    template: '<span class="money-stub">{{ amount }}</span>',
  },
}))

const CNY = {
  uuid: 'c-1',
  symbol: 'CNY',
  name: '人民币',
  precision: 2,
  used: true,
  is_default: true,
}

beforeEach(() => {
  h.accountList.mockReset()
  h.txnList.mockReset()
  h.cmdList.mockReset()
  h.cmdCreate.mockReset()
  h.cmdRemove.mockReset()
  h.isViewer = false
  h.accountList.mockResolvedValue({ accounts: [] })
  h.txnList.mockResolvedValue({ transactions: [] })
  h.cmdList.mockResolvedValue({ commodities: [CNY] })
})

async function mountView(): Promise<ReturnType<typeof mount>> {
  const wrapper = mount(CommoditiesView)
  await flushPromises()
  return wrapper
}

describe('币种页增删与错误文案（AC-4.x）', () => {
  it('渲染币种清单，展示默认 / 被引用徽章与新增表单', async () => {
    const wrapper = await mountView()
    expect(wrapper.text()).toContain('CNY')
    expect(wrapper.text()).toContain('默认')
    expect(wrapper.text()).toContain('被引用')
    expect(wrapper.text()).toContain('新增币种')
    wrapper.unmount()
  })

  it('输入币种代码与名称后提交 create，成功后重新加载列表', async () => {
    h.cmdCreate.mockResolvedValue({ uuid: 'c-2', symbol: 'USD', name: '美元', precision: 2 })
    const wrapper = await mountView()
    const inputs = wrapper.findAll('input')
    await inputs[0].setValue('USD')
    await inputs[1].setValue('美元')
    const add = wrapper.findAll('button').find((b) => b.text() === '添加')
    expect(add).toBeDefined()
    await add?.trigger('click')
    await flushPromises()

    expect(h.cmdCreate).toHaveBeenCalledWith({ symbol: 'USD', name: '美元' })
    expect(wrapper.text()).toContain('币种 USD 已添加')
    wrapper.unmount()
  })

  it('409 commodity_in_use 把 accounts/postings/prices/is_default 渲染成中文原因', async () => {
    h.cmdRemove.mockRejectedValue(
      new ApiError(409, '该币种已被引用', {
        code: 'commodity_in_use',
        details: {
          accounts: ['Assets:Cash'],
          postings: 3,
          prices: 1,
          is_default: true,
        },
      }),
    )
    const wrapper = await mountView()
    const del = wrapper.findAll('button').find((b) => b.text() === '删除')
    expect(del).toBeDefined()
    await del?.trigger('click')
    await flushPromises()

    const text = wrapper.text()
    expect(text).toContain('无法删除：该币种仍被引用')
    expect(text).toContain('Assets:Cash')
    expect(text).toContain('3 笔交易分录')
    expect(text).toContain('1 条价格')
    expect(text).toContain('请先在账本设置中改默认币种')
    wrapper.unmount()
  })

  it('viewer 隐藏新增与删除入口，只读聚合仍可见', async () => {
    h.isViewer = true
    const wrapper = await mountView()
    expect(wrapper.text()).toContain('CNY')
    expect(wrapper.text()).toContain('只读成员可查看币种')
    expect(wrapper.findAll('button').some((b) => b.text() === '添加')).toBe(false)
    expect(wrapper.findAll('button').some((b) => b.text() === '删除')).toBe(false)
    wrapper.unmount()
  })
})
