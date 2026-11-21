// @vitest-environment node
/**
 * 小票分享图接入约束（源码级）：
 * - 两个入口都在、共用同一组装函数（口径不漂移）；
 * - 金额必须经隐私开关组装，原始 amount 不直接传给分享面板；
 * - 精确时间必须只取时间串，不能把账本名塞进分享图；
 * - 敏感项默认关的逻辑留在 core，入口不擅自打开。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

import { describe, expect, it } from 'vitest'

const sheetSource = readFileSync(
  fileURLToPath(new URL('./RecordSheet.vue', import.meta.url)),
  'utf8',
)
const detailSource = readFileSync(
  fileURLToPath(new URL('../views/TransactionDetailView.vue', import.meta.url)),
  'utf8',
)

describe('分享图接入：两个入口共用口径', () => {
  it('成功页与详情页都引入 buildShareReceipt 且渲染 ReceiptShareSheet', () => {
    for (const source of [sheetSource, detailSource]) {
      expect(source).toContain('buildShareReceipt')
      expect(source).toContain('<ReceiptShareSheet')
    }
  })

  it('两个入口都按隐私开关组装金额', () => {
    for (const source of [sheetSource, detailSource]) {
      expect(source).toContain('privacy.enabled')
    }
  })

  it('成功页精确时间只截取时间串，不带账本名', () => {
    expect(sheetSource).toContain('(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})')
    expect(sheetSource).not.toContain('preciseTime: r.footLines[0]')
  })

  it('入口不硬编码打开任何敏感开关（默认全关由 core 决定）', () => {
    for (const source of [sheetSource, detailSource]) {
      expect(source).not.toMatch(/extras:\s*\{\s*bean:\s*true/)
      expect(source).not.toMatch(/extras:\s*\{\s*accounts:\s*true/)
    }
  })
})
