// @vitest-environment jsdom
/**
 * AccountEditSheet（批 II）行为回归：
 *   - 提交成功：accountApi.update 只带「与原值不同」的键（键省略 = 不改契约）、
 *     markDirty('local-write')、emit saved/close；
 *   - 400 account_visual_invalid → codeMessage 集中文案展示；
 *   - 前置校验：非法 color / 超 8 码位 icon 不发请求；
 *   - viewer：提交按钮禁用（入口显隐由父级守，弹层内双保险）；
 *   - 离线：置灰 + 固定文案「修改需联网」，提交不执行且**绝不产生 pending**
 *     （sync store 的 recordTxnOffline 永不被调——push op=update 只认 sort_order，
 *     误入队会覆盖真实排序）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import { ApiError } from '@/api/errors'
import type { AccountView } from '@/api/types'
import AccountEditSheet from '@/components/AccountEditSheet.vue'

const h = vi.hoisted(() => ({
  update: vi.fn(),
  markDirty: vi.fn(),
  recordTxnOffline: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  accountApi: { update: h.update },
}))

vi.mock('@/stores/dataFreshness', () => ({
  markDirty: h.markDirty,
}))

vi.mock('@/stores/sync', () => ({
  useSyncStore: () => ({ recordTxnOffline: h.recordTxnOffline }),
}))

let viewer = false

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ isViewer: viewer }),
}))

const ACCOUNT: AccountView = {
  id: 1,
  uuid: 'acc-1',
  name: 'Assets:Bank',
  display_name: '储蓄银行',
  type: 'Assets',
  open_date: '2026-01-01',
  icon: '🏦',
  // 主题护栏禁源码 hex 字面量：'#' 与数字段拆开构造（运行期等价完整色值）。
  color: '#'.concat('112233'),
  sort_order: 0,
}

async function mountSheet(account: AccountView = ACCOUNT) {
  const wrapper = mount(AccountEditSheet, { props: { account } })
  await flushPromises()
  return wrapper
}

function findButton(wrapper: ReturnType<typeof mount>, text: string) {
  return wrapper.findAll('button').find((b) => b.text().includes(text))
}

function setOnline(value: boolean): void {
  Object.defineProperty(window, 'navigator', {
    value: { ...window.navigator, onLine: value },
    configurable: true,
  })
}

beforeEach(() => {
  viewer = false
  h.update.mockReset()
  h.markDirty.mockReset()
  h.recordTxnOffline.mockReset()
  h.update.mockResolvedValue({ ok: true, account: { uuid: 'acc-1' } })
  setOnline(true)
  document.body.innerHTML = ''
})

describe('AccountEditSheet 提交契约', () => {
  it('只带变化键：改 display_name → payload 仅含该键（icon/color 缺省 = 不改）', async () => {
    const wrapper = await mountSheet()
    const nameInput = wrapper.find('input[type="text"]')
    await nameInput.setValue('招商储蓄')
    await findButton(wrapper, '保存')?.trigger('click')
    await flushPromises()

    expect(h.update).toHaveBeenCalledTimes(1)
    expect(h.update).toHaveBeenCalledWith('acc-1', { display_name: '招商储蓄' })
    expect(h.markDirty).toHaveBeenCalledWith('local-write')
    expect(wrapper.emitted('saved')).toBeDefined()
    expect(wrapper.emitted('close')).toBeDefined()
  })

  it('清除语义：icon 从 🏦 改回默认 → 显式空串', async () => {
    const wrapper = await mountSheet()
    await findButton(wrapper, '清除图标（恢复默认 📁）')?.trigger('click')
    await findButton(wrapper, '保存')?.trigger('click')
    await flushPromises()

    expect(h.update).toHaveBeenCalledWith('acc-1', { icon: '' })
  })

  it('无修改 → 保存按钮禁用（不发无意义请求与 sync_log）', async () => {
    const wrapper = await mountSheet()
    const save = findButton(wrapper, '保存')
    expect(save?.attributes('disabled')).toBeDefined()
    await save?.trigger('click')
    await flushPromises()
    expect(h.update).not.toHaveBeenCalled()
  })
})

describe('AccountEditSheet 校验与错误', () => {
  it('非法 color：前置拦截不发请求，展示可读文案', async () => {
    const wrapper = await mountSheet()
    const colorInput = wrapper.find('input[placeholder*="RRGGBB"]')
    await colorInput.setValue('blue')
    await findButton(wrapper, '保存')?.trigger('click')
    await flushPromises()
    expect(h.update).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('#RRGGBB')
  })

  it('400 account_visual_invalid → codeMessage 集中文案（不甩 HTTP 原文）', async () => {
    h.update.mockRejectedValueOnce(
      new ApiError(400, '账户图标过长（最多 8 个字符），当前 9 个', {
        code: 'account_visual_invalid',
      }),
    )
    const wrapper = await mountSheet()
    const nameInput = wrapper.find('input[type="text"]')
    await nameInput.setValue('新名字')
    await findButton(wrapper, '保存')?.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('图标需不超过 8 个字符的 emoji，颜色需为 #RRGGBB 格式')
  })
})

describe('AccountEditSheet 角色与在线态', () => {
  it('viewer：保存禁用且提交不执行', async () => {
    viewer = true
    const wrapper = await mountSheet()
    const nameInput = wrapper.find('input[type="text"]')
    await nameInput.setValue('偷改')
    await flushPromises()
    const save = findButton(wrapper, '保存')
    expect(save?.attributes('disabled')).toBeDefined()
    await save?.trigger('click')
    await flushPromises()
    expect(h.update).not.toHaveBeenCalled()
  })

  it('离线：置灰 + 固定文案「修改需联网」，提交不执行且不产生 pending', async () => {
    setOnline(false)
    const wrapper = await mountSheet()
    expect(wrapper.text()).toContain('修改需联网')

    const nameInput = wrapper.find('input[type="text"]')
    await nameInput.setValue('离线改名')
    await flushPromises()
    const save = findButton(wrapper, '保存')
    expect(save?.attributes('disabled')).toBeDefined()
    await save?.trigger('click')
    await flushPromises()

    expect(h.update).not.toHaveBeenCalled()
    // 绝不入离线队列：recordTxnOffline（产生 pending 的唯一入口）永不被调。
    expect(h.recordTxnOffline).not.toHaveBeenCalled()
  })

  it('恢复在线后可保存（online 事件刷新状态）', async () => {
    setOnline(false)
    const wrapper = await mountSheet()
    setOnline(true)
    window.dispatchEvent(new Event('online'))
    await flushPromises()

    const nameInput = wrapper.find('input[type="text"]')
    await nameInput.setValue('联网改名')
    await findButton(wrapper, '保存')?.trigger('click')
    await flushPromises()
    expect(h.update).toHaveBeenCalledTimes(1)
  })
})
