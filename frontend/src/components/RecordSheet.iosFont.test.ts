// @vitest-environment node
/**
 * iOS 聚焦缩放回归：记一笔弹窗内所有真实表单控件字号必须 >= 16px。
 *
 * iOS Safari 在聚焦 computed font-size < 16px 的 input/select/textarea 时，
 * 会自动放大整个页面。记一笔弹窗此前受全局 .fb-input（15px）与局部
 * .rs-select（13px）影响，聚焦任一控件都会触发该行为。
 *
 * vitest 默认不把 SFC 的 <style scoped> 注入 DOM，getComputedStyle 读不到
 * 这些规则，因此这里用源码文本断言守住约束：兜底规则必须存在且为 16px，
 * 分类溢出下拉自身也不得退回 < 16px。成本低，且不依赖 DOM/CSS 引擎。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

import { describe, expect, it } from 'vitest'

const sfcSource = readFileSync(
  fileURLToPath(new URL('./RecordSheet.vue', import.meta.url)),
  'utf8',
)
const styleStart = sfcSource.indexOf('<style scoped>')
const styleEnd = sfcSource.indexOf('</style>', styleStart)
// 先去掉注释，否则注释文字会混进第一条规则的选择器列表，干扰按选择器查找。
const scopedCss = sfcSource
  .slice(styleStart, styleEnd)
  .replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * 按选择器取规则体，兼容逗号分隔的分组选择器。
 *
 * @param selector 精确匹配的选择器字符串（如 '.rs-body input'）
 * @returns 规则体内文；找不到时返回空串
 */
function ruleBodyFor(selector: string): string {
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g
  let match: RegExpExecArray | null = rulePattern.exec(scopedCss)
  while (match !== null) {
    const selectors = (match[1] ?? '')
      .split(',')
      .map((item) => item.trim())
    if (selectors.indexOf(selector) >= 0) {
      return match[2] ?? ''
    }
    match = rulePattern.exec(scopedCss)
  }
  return ''
}

describe('iOS 聚焦缩放回归：记一笔弹窗表单控件字号 >= 16px', () => {
  it('rs-body 内 input / select / textarea 均有 16px 兜底规则', () => {
    for (const control of ['input', 'select', 'textarea']) {
      const selector = `.rs-body ${control}`
      const body = ruleBodyFor(selector)
      expect(body, `缺少 ${selector} 字号兜底规则`).not.toBe('')
      expect(body, `${selector} 字号应为 16px`).toMatch(/font-size:\s*16px/)
    }
  })

  it('分类溢出下拉 .rs-select 自身字号不得小于 16px', () => {
    const body = ruleBodyFor('.rs-select')
    expect(body, '缺少 .rs-select 规则').not.toBe('')
    const sizeMatch = /font-size:\s*(\d+(?:\.\d+)?)px/.exec(body)
    expect(sizeMatch, '.rs-select 应显式声明 font-size').not.toBeNull()
    expect(Number(sizeMatch?.[1])).toBeGreaterThanOrEqual(16)
  })
})
