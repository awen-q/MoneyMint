/**
 * 分享图组装口径：金额跟隐私开关、印章中性、敏感默认关。
 */
import { describe, expect, it } from 'vitest'

import { buildShareReceipt, type ShareSource } from './shareReceiptData'

const source: ShareSource = {
  amount: '128.50',
  commodity: 'CNY',
  kindLabel: '支出 EXPENSE',
  date: '2026-11-21',
  payee: '超市',
  bean: '2026-11-21 * "超市"\n  Assets:Alipay  -128.50 CNY',
  tags: ['日常', '孩子'],
  accounts: ['Assets:Alipay'],
  preciseTime: '2026-11-21 18:30:00',
}

describe('shareReceiptData：金额口径', () => {
  it('隐私关闭时金额走统一 formatMoney（带符号币种）', () => {
    const { data } = buildShareReceipt(source, false)
    expect(data.amountText).toBe('¥ 128.50')
  })

  it('隐私开启时金额是遮挡符，原始数字不进入 data', () => {
    const { data, details } = buildShareReceipt(source, true)
    expect(data.amountText).toBe('••••••')
    expect(JSON.stringify(data)).not.toContain('128.50')
    // bean 作为可选内容存在 details 里，但 extras 默认全关，不会进画布
    expect(data.extras.bean).toBe(false)
    expect(details.beanLines.length).toBeGreaterThan(0)
  })
})

describe('shareReceiptData：最小披露', () => {
  it('印章中性、四个敏感开关默认关', () => {
    const { data } = buildShareReceipt(source, false)
    expect(data.stamp).toBe('已记账')
    expect(data.extras).toEqual({
      accounts: false, tags: false, bean: false, preciseTime: false,
    })
  })

  it('只暴露安全字段给 data，敏感内容留在 details', () => {
    const { data, details } = buildShareReceipt(source, false)
    expect(data.payee).toBe('超市')
    expect(JSON.stringify(data)).not.toContain('Assets:')
    expect(details.accountLines).toContain('Assets:Alipay')
    expect(details.tagLine).toBe('日常 孩子')
  })
})
