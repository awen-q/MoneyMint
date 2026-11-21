// @vitest-environment jsdom
/**
 * Canvas 分享图回归（架构约束）：
 * - 源码无硬编码色值（主题护栏；
 * - 金额画的是传入的显示串（遮挡态原样画遮挡符），模块内不 import Money；
 * - 默认不画 bean / 完整账户 / 标签；勾选后才出现在绘制调用里；
 * - 文件名不含交易标识 / 账号；导出 toBlob 失败可回退。
 */
import { describe, expect, it, vi } from 'vitest'

import {
  drawShareReceipt,
  exportReceiptBlob,
  readReceiptPalette,
  receiptHeight,
  shareReceiptFileName,
} from './receiptCanvas'
import { collectShareLines, DEFAULT_EXTRAS, EMPTY_DETAILS, type ShareReceiptData } from './receiptImage'

function fakePalette() {
  return readReceiptPalette({
    getPropertyValue: () => '',
  } as unknown as CSSStyleDeclaration)
}

function makeCtx() {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const methods = [
    'scale', 'save', 'restore', 'beginPath', 'setLineDash', 'strokeStyle', 'fillStyle',
    'moveTo', 'lineTo', 'stroke', 'fill', 'arc', 'translate', 'rotate', 'fillRect', 'fillText',
  ]
  const ctx: Record<string, unknown> = {}
  for (const name of methods) {
    ctx[name] = (...args: unknown[]) => {
      calls.push({ method: name, args })
    }
  }
  // 属性赋值也记为调用（strokeStyle / fillStyle / font 等）
  for (const prop of ['strokeStyle', 'fillStyle', 'font', 'textAlign', 'textBaseline', 'lineWidth', 'globalAlpha']) {
    let value: unknown = ''
    Object.defineProperty(ctx, prop, {
      get: () => value,
      set: (next) => {
        value = next
        calls.push({ method: `set:${prop}`, args: [next] })
      },
    })
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}

function baseData(): ShareReceiptData {
  return {
    amountText: '¥ 128.50',
    kindLabel: '支出 EXPENSE',
    date: '2026-11-21',
    payee: '超市',
    stamp: '已记账',
    extras: { ...DEFAULT_EXTRAS },
  }
}

describe('receiptCanvas：色板与尺寸', () => {
  it('jsdom 读不到 CSS 变量时回退为颜色名，源码不写色值字面量', () => {
    const palette = fakePalette()
    expect(palette.paper).toBe('white')
    expect(palette.ink).toBe('black')
  })

  it('内容越多画布越高（bean 块另计）', () => {
    const lines = collectShareLines(baseData(), EMPTY_DETAILS)
    const short = receiptHeight(lines, EMPTY_DETAILS)
    const long = receiptHeight(lines, { ...EMPTY_DETAILS, beanLines: ['a', 'b'] })
    expect(long).toBeGreaterThan(short)
  })
})

describe('receiptCanvas：绘制内容', () => {
  it('金额画的是传入显示串；遮挡态画遮挡符，不出现原始数字', () => {
    const data = baseData()
    data.amountText = '••••••'
    const { ctx, calls } = makeCtx()
    drawShareReceipt(ctx, data, collectShareLines(data, EMPTY_DETAILS), EMPTY_DETAILS, fakePalette())
    const drawn = calls.filter((c) => c.method === 'fillText').map((c) => c.args[0])
    expect(drawn).toContain('••••••')
    expect(drawn.some((v) => String(v).includes('128.50'))).toBe(false)
  })

  it('默认不画 bean / 完整账户 / 标签', () => {
    const data = baseData()
    const details = {
      accountLines: ['Assets:Alipay'],
      tagLine: '孩子',
      beanLines: ['2026-11-21 * "超市"'],
      preciseTime: '18:30:00',
    }
    const { ctx, calls } = makeCtx()
    drawShareReceipt(ctx, data, collectShareLines(data, details), EMPTY_DETAILS, fakePalette())
    const drawn = calls.filter((c) => c.method === 'fillText').map((c) => String(c.args[0]))
    expect(drawn.some((v) => v.includes('Assets:'))).toBe(false)
    expect(drawn.some((v) => v.includes('孩子'))).toBe(false)
    expect(drawn.some((v) => v.includes('"超市"'))).toBe(false)
  })

  it('勾选 bean 后片段才进画布', () => {
    const data = baseData()
    data.extras.bean = true
    const details = { ...EMPTY_DETAILS, beanLines: ['Assets:Alipay  -128.50 CNY'] }
    const { ctx, calls } = makeCtx()
    drawShareReceipt(ctx, data, collectShareLines(data, details), details, fakePalette())
    const drawn = calls.filter((c) => c.method === 'fillText').map((c) => String(c.args[0]))
    expect(drawn.some((v) => v.includes('Assets:Alipay'))).toBe(true)
  })

  it('印章走 rotate，齿边走 arc，画布按 dpr 缩放', () => {
    const { ctx, calls } = makeCtx()
    const data = baseData()
    drawShareReceipt(ctx, data, collectShareLines(data, EMPTY_DETAILS), EMPTY_DETAILS, fakePalette())
    expect(calls.some((c) => c.method === 'rotate')).toBe(true)
    expect(calls.some((c) => c.method === 'arc')).toBe(true)
  })
})

describe('receiptCanvas：导出与文件名', () => {
  it('文件名只含日期，不含交易号 / 账户', () => {
    expect(shareReceiptFileName('2026-11-21')).toBe('fambean-2026-11-21.png')
    expect(shareReceiptFileName('')).toBe('fambean-receipt.png')
    expect(shareReceiptFileName('loc-abc-123')).toBe('fambean-receipt.png')
  })

  it('toBlob 可用时直接走 toBlob', async () => {
    const blob = new Blob(['x'], { type: 'image/png' })
    const canvas = {
      toBlob: vi.fn((cb: (b: Blob | null) => void) => cb(blob)),
      toDataURL: vi.fn(() => ''),
    } as unknown as HTMLCanvasElement
    await expect(exportReceiptBlob(canvas)).resolves.toBe(blob)
    expect(canvas.toBlob).toHaveBeenCalledTimes(1)
  })

  it('toBlob 不可用且 dataURL 非法时返回 null（不白点）', async () => {
    const canvas = {
      toBlob: undefined,
      toDataURL: vi.fn(() => 'invalid'),
    } as unknown as HTMLCanvasElement
    await expect(exportReceiptBlob(canvas)).resolves.toBeNull()
  })
})
