// @vitest-environment node
/**
 * Beancount 预览片段契约测试：逐字钉死 internal/export/beancount.go:246-258。
 * 任何格式漂移（千分位、中文标签写成 #tag、flag 丢失、金额精度变化）都必须在此红灯。
 */
import { describe, expect, it } from 'vitest'

import { beanAmount, buildBeanSnippet, joinTags } from './bean'

describe('beanAmount：定点两位、无千分位、无指数', () => {
  it('正数 / 负数 / 零均输出纯数字', () => {
    expect(beanAmount('128.5')).toBe('128.50')
    expect(beanAmount('-128.50')).toBe('-128.50')
    expect(beanAmount('0')).toBe('0.00')
  })

  it('大数禁止千分位（bean-check 不接受 2,680.00）', () => {
    expect(beanAmount('2680.00')).toBe('2680.00')
    expect(beanAmount('-2680')).toBe('-2680.00')
  })
})

describe('joinTags：等价 Go joinTags', () => {
  it('清洗空项 / 首尾空白后用单空格拼接', () => {
    expect(joinTags([' 日常 ', '', '  ', '孩子'])).toBe('日常 孩子')
  })

  it('全空返回空串', () => {
    expect(joinTags([])).toBe('')
    expect(joinTags(['', '   '])).toBe('')
  })
})

describe('buildBeanSnippet：与 Go 导出格式逐字一致', () => {
  it('标准支出：date flag "desc" + tags 元数据 + 两条 posting', () => {
    const actual = buildBeanSnippet({
      date: '2026-11-16',
      flag: '*',
      description: '超市采购',
      tags: ['日常', '孩子'],
      postings: [
        { accountName: 'Assets:Alipay', amount: '-128.50', commodity: 'CNY' },
        { accountName: 'Expenses:Food', amount: '128.50', commodity: 'CNY' },
      ],
    })
    expect(actual).toBe(
      [
        '2026-11-16 * "超市采购"',
        '  tags: "日常 孩子"',
        '  Assets:Alipay -128.50 CNY',
        '  Expenses:Food 128.50 CNY',
      ].join('\n'),
    )
  })

  it('无标签时不输出 tags 行', () => {
    const actual = buildBeanSnippet({
      date: '2026-11-16',
      flag: '!',
      description: '待核分录',
      tags: [],
      postings: [
        { accountName: 'Assets:Cash', amount: '-36.00', commodity: 'CNY' },
        { accountName: 'Expenses:Transport', amount: '36.00', commodity: 'CNY' },
      ],
    })
    expect(actual).toBe(
      [
        '2026-11-16 ! "待核分录"',
        '  Assets:Cash -36.00 CNY',
        '  Expenses:Transport 36.00 CNY',
      ].join('\n'),
    )
  })

  it('flag 两态随输入变化（不写死 *）', () => {
    const input = {
      date: '2026-11-16',
      description: '工资',
      tags: ['收入'],
      postings: [
        { accountName: 'Assets:Bank', amount: '2680.00', commodity: 'CNY' },
        { accountName: 'Income:Salary', amount: '-2680.00', commodity: 'CNY' },
      ],
    }
    expect(buildBeanSnippet({ ...input, flag: '*' })).toContain('2026-11-16 * "工资"')
    expect(buildBeanSnippet({ ...input, flag: '!' })).toContain('2026-11-16 ! "工资"')
  })

  it('双引号按 Go %q 转义；中文标签仍在 tags 元数据行，不是 #tag', () => {
    const actual = buildBeanSnippet({
      date: '2026-11-16',
      flag: '*',
      description: '买了"零食"',
      tags: ['日常', '孩子'],
      postings: [
        { accountName: 'Assets:Cash', amount: '-10.00', commodity: 'CNY' },
        { accountName: 'Expenses:Food', amount: '10.00', commodity: 'CNY' },
      ],
    })
    expect(actual).toContain('2026-11-16 * "买了\\"零食\\""')
    expect(actual).toContain('  tags: "日常 孩子"')
    expect(actual).not.toContain('#tag')
    expect(actual).not.toContain('#日常')
  })

  it('多币种逐行保留各自 commodity，金额纯数字', () => {
    const actual = buildBeanSnippet({
      date: '2026-11-16',
      flag: '*',
      description: '换汇',
      tags: [],
      postings: [
        { accountName: 'Assets:Cash', amount: '-100.00', commodity: 'CNY' },
        { accountName: 'Expenses:Travel', amount: '100.00', commodity: 'CNY' },
        { accountName: 'Assets:Bank', amount: '-10.00', commodity: 'USD' },
        { accountName: 'Income:Refund', amount: '10.00', commodity: 'USD' },
      ],
    })
    expect(actual).toContain('  Assets:Cash -100.00 CNY')
    expect(actual).toContain('  Assets:Bank -10.00 USD')
    expect(actual).not.toMatch(/[0-9],[0-9]{3}/)
  })

  it('未选账户显示占位符，便于 bean-check 前置拦截', () => {
    const actual = buildBeanSnippet({
      date: '2026-11-16',
      flag: '*',
      description: '待选',
      tags: [],
      postings: [{ accountName: '', amount: '1.00', commodity: 'CNY' }],
    })
    expect(actual).toContain('  <待选账户> 1.00 CNY')
  })
})
