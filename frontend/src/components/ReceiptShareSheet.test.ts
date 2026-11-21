// @vitest-environment jsdom
/**
 * 分享面板回归：默认最小披露 / 敏感项勾选 / 能力缺失时兜底不白点。
 */
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ReceiptShareSheet from './ReceiptShareSheet.vue'
import { DEFAULT_EXTRAS, EMPTY_DETAILS, type ShareReceiptData } from '@/core/receiptImage'

const data: ShareReceiptData = {
  amountText: '¥ 128.50',
  kindLabel: '支出 EXPENSE',
  date: '2026-11-21',
  payee: '超市',
  stamp: '已记账',
  extras: { ...DEFAULT_EXTRAS },
}

const details = {
  accountLines: ['Assets:Alipay'],
  tagLine: '孩子',
  beanLines: ['Assets:Alipay  -128.50 CNY'],
  preciseTime: '18:30:00',
}

const blob = new Blob(['png'], { type: 'image/png' })
const drawTexts: string[] = []

beforeEach(() => {
  drawTexts.length = 0
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:preview'),
    revokeObjectURL: vi.fn(),
  })
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({
      scale: vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(),
      setLineDash: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
      fill: vi.fn(), arc: vi.fn(), translate: vi.fn(), rotate: vi.fn(), fillRect: vi.fn(),
      fillText: vi.fn((text: string) => { drawTexts.push(text) }),
      strokeStyle: '', fillStyle: '', font: '', textAlign: '', textBaseline: '',
      lineWidth: 1, globalAlpha: 1,
    }),
  })
  Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
    configurable: true,
    value: (cb: (b: Blob | null) => void) => cb(blob),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function mountSheet() {
  return mount(ReceiptShareSheet, { props: { data, details } })
}

describe('ReceiptShareSheet：默认最小披露', () => {
  it('四个敏感项默认全关，默认不画敏感内容', async () => {
    const wrapper = mountSheet()
    await wrapper.vm.$nextTick()
    const checked = wrapper.findAll('input[type="checkbox"]').filter((box) => (box.element as HTMLInputElement).checked)
    expect(checked).toHaveLength(0)
    expect(drawTexts.some((t) => t.includes('Assets:'))).toBe(false)
    expect(drawTexts.some((t) => t.includes('孩子'))).toBe(false)
    expect(wrapper.text()).toContain('默认只含金额、类型、日期和分类展示名')
  })

  it('勾选 Beancount 片段后重绘，片段进画布并出敏感提示', async () => {
    const wrapper = mountSheet()
    await wrapper.vm.$nextTick()
    drawTexts.length = 0
    const boxes = wrapper.findAll('input[type="checkbox"]')
    await boxes[3].setValue(true)
    await wrapper.vm.$nextTick()
    expect(drawTexts.some((t) => t.includes('Assets:Alipay'))).toBe(true)
    expect(wrapper.text()).toContain('已包含敏感信息')
  })
})

describe('ReceiptShareSheet：兜底', () => {
  it('不支持系统分享时给出明确提示', async () => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined })
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined })
    const wrapper = mountSheet()
    await wrapper.vm.$nextTick()
    await wrapper.findAll('.shr__btn')[1].trigger('click')
    expect(wrapper.text()).toContain('不支持图片分享')
  })

  it('复制文字小票成功时反馈（文字来自显示串）', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const wrapper = mountSheet()
    await wrapper.vm.$nextTick()
    await wrapper.findAll('.shr__btn')[0].trigger('click')
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0][0]).toContain('¥ 128.50')
    expect(wrapper.text()).toContain('文字小票已复制')
  })

  it('关闭按钮 emit close', async () => {
    const wrapper = mountSheet()
    await wrapper.find('.shr__close').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
