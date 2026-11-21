/**
 * Canvas 2D 分享票面绘制：零依赖、离线可用、iOS 14 行为确定。
 *
 * 两条硬约束：
 * 1. 只画「显示串」——金额在本模块入口就是格式化后的文本（遮挡时为遮挡符），
 *    模块内不 import formatMoney、不碰原始 amount，杜绝真值泄漏。
 * 2. 色值全部由调用方从 CSS token 解析后传入 palette；本文件不出现任何
 *    色值字面量，主题护栏扫描通过（换肤后画布自动跟随）。
 */
import type { ShareReceiptData, ShareReceiptDetails, ShareReceiptLine } from './receiptImage'

export interface ReceiptPalette {
  paper: string
  ink: string
  sub: string
  line: string
  edge: string
  green: string
  warn: string
  white: string
  mono: string
}

export const RECEIPT_W = 340
export const RECEIPT_PAD = 22
const LINE_H = 26
const BASE_H = 292
const BEAN_LINE_H = 16

/** 按内容量算画布逻辑高度（CSS px，乘 dpr 前的尺寸）。 */
export function receiptHeight(lines: ShareReceiptLine[], details: ShareReceiptDetails): number {
  const beanBlock = details.beanLines.length > 0 ? details.beanLines.length * BEAN_LINE_H + 34 : 0
  return BASE_H + lines.length * LINE_H + beanBlock
}

/**
 * 从 CSS 变量读成画布色板。paper 系 token 定义在 `.rs-mask, .slip` 作用域
 * （见 tokens.css 的 scopeExceptions），不在 :root，因此必须传作用域样式；
 * jsdom 读不到变量时回退到颜色名（仅供测试），源码不出现 hex / rgb 字面量。
 */
export function readReceiptPalette(scope: CSSStyleDeclaration): ReceiptPalette {
  const read = (name: string, fallback: string): string => {
    const value = scope.getPropertyValue(name).trim()
    return value === '' ? fallback : value
  }
  return {
    paper: read('--fb-paper', 'white'),
    ink: read('--fb-paper-ink', 'black'),
    sub: read('--fb-paper-sub', 'gray'),
    line: read('--fb-paper-line', 'gray'),
    edge: read('--fb-paper-edge', 'white'),
    green: read('--fb-green', 'green'),
    warn: read('--fb-warn', 'orange'),
    white: read('--fb-white', 'white'),
    mono: read('--fb-paper-mono', 'monospace'),
  }
}

/**
 * 配置画布：逻辑尺寸 RECEIPT_W × height，物理尺寸乘 dpr；dpr 上限 3 防止
 * 超大屏导出几千万像素。返回已 scale 的 ctx。
 */
export function setupReceiptCanvas(
  canvas: HTMLCanvasElement,
  height: number,
  dpr: number,
): CanvasRenderingContext2D | null {
  const ctx = canvas.getContext('2d')
  if (ctx === null) {
    return null
  }
  const ratio = Math.min(3, Math.max(1, dpr))
  canvas.width = Math.round(RECEIPT_W * ratio)
  canvas.height = Math.round(height * ratio)
  ctx.scale(ratio, ratio)
  return ctx
}

function dashed(ctx: CanvasRenderingContext2D, y: number, color: string): void {
  ctx.save()
  ctx.beginPath()
  ctx.setLineDash([3, 3])
  ctx.strokeStyle = color
  ctx.moveTo(RECEIPT_PAD, y)
  ctx.lineTo(RECEIPT_W - RECEIPT_PAD, y)
  ctx.stroke()
  ctx.restore()
}

/** 撕纸齿边：交替半圆，矢量输出，不依赖 CSS 渐变（html2canvas 才会失真）。 */
function toothEdge(ctx: CanvasRenderingContext2D, y: number, color: string, up: boolean): void {
  ctx.save()
  ctx.fillStyle = color
  const step = 12
  for (let x = 0; x <= RECEIPT_W; x += step) {
    ctx.beginPath()
    ctx.arc(x, y, 6, up ? Math.PI : 0, up ? 0 : Math.PI)
    ctx.fill()
  }
  ctx.restore()
}

/**
 * 绘制完整票面。纯函数式：只依赖入参，不读全局 store / DOM / 时钟。
 * 印章用 save/translate/rotate/restore，收图人看到的是中性「已记账」。
 */
export function drawShareReceipt(
  ctx: CanvasRenderingContext2D,
  data: ShareReceiptData,
  lines: ShareReceiptLine[],
  details: ShareReceiptDetails,
  palette: ReceiptPalette,
): void {
  const height = receiptHeight(lines, details)

  // 纸面 + 齿边
  ctx.fillStyle = palette.paper
  ctx.fillRect(0, 0, RECEIPT_W, height)
  toothEdge(ctx, 0, palette.paper, true)
  toothEdge(ctx, height, palette.paper, false)

  // 热敏纸横纹：低透明横线（用 globalAlpha，不用 rgba 字面量）
  ctx.save()
  ctx.globalAlpha = 0.35
  ctx.strokeStyle = palette.edge
  for (let y = 4; y < height; y += 3) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(RECEIPT_W, y)
    ctx.stroke()
  }
  ctx.restore()

  // 印章：旋转圆框 + 中性文案
  ctx.save()
  ctx.translate(RECEIPT_W - 62, 62)
  ctx.rotate(-13 * Math.PI / 180)
  ctx.strokeStyle = palette.green
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(0, 0, 30, 0, Math.PI * 2)
  ctx.stroke()
  ctx.fillStyle = palette.green
  ctx.font = `700 14px ${palette.mono}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(data.stamp, 0, 0)
  ctx.restore()

  // 品牌
  ctx.fillStyle = palette.ink
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.font = `700 15px ${palette.mono}`
  ctx.fillText('家庭账本', RECEIPT_W / 2, 40)
  ctx.fillStyle = palette.sub
  ctx.font = `400 9px ${palette.mono}`
  ctx.fillText('FAMBEAN · SHARE RECEIPT', RECEIPT_W / 2, 56)

  // 金额（显示串，隐私遮挡时这里就是遮挡符）
  ctx.fillStyle = palette.ink
  ctx.font = `700 34px ${palette.mono}`
  ctx.fillText(data.amountText, RECEIPT_W / 2, 118)
  ctx.fillStyle = palette.sub
  ctx.font = `400 11px ${palette.mono}`
  ctx.fillText(data.kindLabel, RECEIPT_W / 2, 140)

  dashed(ctx, 158, palette.line)

  // 明细行：默认只有日期与分类展示名；敏感行由 collectShareLines 按开关拼入
  ctx.font = `400 12px ${palette.mono}`
  lines.forEach((line, index) => {
    const y = 184 + index * LINE_H
    ctx.fillStyle = palette.sub
    ctx.textAlign = 'left'
    ctx.fillText(line.label, RECEIPT_PAD, y)
    ctx.fillStyle = palette.ink
    ctx.textAlign = 'right'
    ctx.fillText(line.value, RECEIPT_W - RECEIPT_PAD, y)
  })

  // Beancount 片段（只有勾选才传进来；未勾选时 details.beanLines 为空）
  if (details.beanLines.length > 0) {
    const top = 184 + lines.length * LINE_H + 10
    dashed(ctx, top, palette.line)
    ctx.textAlign = 'left'
    ctx.fillStyle = palette.sub
    ctx.font = `400 9px ${palette.mono}`
    details.beanLines.forEach((line, index) => {
      ctx.fillText(line, RECEIPT_PAD, top + 20 + index * BEAN_LINE_H)
    })
  }

  dashed(ctx, height - 66, palette.line)
  ctx.textAlign = 'center'
  ctx.fillStyle = palette.sub
  ctx.font = `400 10px ${palette.mono}`
  ctx.fillText('— 感 谢 记 账 —', RECEIPT_W / 2, height - 42)
  ctx.fillStyle = palette.green
  ctx.font = `400 9px ${palette.mono}`
  ctx.fillText('借贷平衡 · 已校验', RECEIPT_W / 2, height - 24)
}

/**
 * 导出 PNG Blob。Safari 14 对 toBlob 支持不稳，失败回退 toDataURL 再转 Blob；
 * 两者都失败时返回 null，由组件层出兜底提示，绝不白点。
 */
export function exportReceiptBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      if (typeof canvas.toBlob === 'function') {
        canvas.toBlob((blob) => {
          if (blob !== null) {
            resolve(blob)
            return
          }
          resolve(fallbackToDataUrl(canvas))
        }, 'image/png')
        return
      }
      resolve(fallbackToDataUrl(canvas))
    } catch {
      resolve(null)
    }
  })
}

function fallbackToDataUrl(canvas: HTMLCanvasElement): Blob | null {
  try {
    const url = canvas.toDataURL('image/png')
    if (url === '' || url.indexOf('data:image/png') !== 0) {
      return null
    }
    const binary = atob(url.slice(url.indexOf(',') + 1))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i)
    }
    return new Blob([bytes], { type: 'image/png' })
  } catch {
    return null
  }
}

/** 文件名只含日期与固定前缀，不含交易 id / 账号，避免从文件名泄露。 */
export function shareReceiptFileName(date: string): string {
  const safe = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : 'receipt'
  return `fambean-${safe}.png`
}
