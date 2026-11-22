// @vitest-environment node
/**
 * iOS 聚焦缩放回归：高级录入子组件自身的可聚焦控件必须 >=16px、触控 >=44px。
 *
 * Vue <style scoped> 不会注入 jsdom，getComputedStyle 读不到 SFC 规则；
 * 沿用 RecordSheet.iosFont.test.ts 的源码文本断言。父组件 .rs-body 的 16px
 * 兜底因 data-v 隔离穿透不到子组件，故这里守的是 AdvancedPostings 自身规则。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

import { describe, expect, it } from 'vitest'

const sfcSource = readFileSync(
  fileURLToPath(new URL('./AdvancedPostings.vue', import.meta.url)),
  'utf8',
)
const styleStart = sfcSource.indexOf('<style scoped>')
const styleEnd = sfcSource.indexOf('</style>', styleStart)
// 跳过开标签本身（否则第一条规则选择器会带上 "<style scoped>"），再去注释，
// 避免注释文字混进选择器列表干扰按选择器查找。
const scopedCss = sfcSource
  .slice(styleStart + '<style scoped>'.length, styleEnd)
  .replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * 按选择器取规则体，兼容逗号分隔的分组选择器。
 *
 * @param selector 精确匹配的选择器字符串（如 '.adv-row input'）
 * @returns 规则体内文；找不到时返回空串
 */
function ruleBodyFor(selector: string): string {
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g
  let match: RegExpExecArray | null = rulePattern.exec(scopedCss)
  while (match !== null) {
    const selectors = (match[1] ?? '').split(',').map((item) => item.trim())
    if (selectors.indexOf(selector) >= 0) {
      return match[2] ?? ''
    }
    match = rulePattern.exec(scopedCss)
  }
  return ''
}

/** 触控目标下限：≥44px（效果图实现为 46px）。 */
const TOUCH_MIN_RE = /min-height:\s*(4[4-9]|[5-9]\d)px/

describe('iOS 聚焦缩放回归：高级录入子组件控件字号 >=16px、触控 >=44px', () => {
  it('账户 / 金额 / 币种 / 借贷 Toggle / 翻转 / 删除控件字号均为 16px', () => {
    const selectors = [
      '.adv-row select',
      '.adv-row input',
      '.adv-row .row-cur',
      '.dir-toggle .seg',
      '.signflip',
      '.sign-hint',
      '.adv-remove',
    ]
    for (const selector of selectors) {
      const body = ruleBodyFor(selector)
      expect(body, `缺少 ${selector} 规则`).not.toBe('')
      expect(body, `${selector} 字号应为 16px`).toMatch(/font-size:\s*16px/)
    }
  })

  it('可聚焦控件与按钮触控目标不小于 44px', () => {
    for (const selector of ['.adv-row select', '.adv-row input', '.signflip', '.adv-remove']) {
      const body = ruleBodyFor(selector)
      expect(body, `${selector} 触控高度应 >=44px`).toMatch(TOUCH_MIN_RE)
    }
  })

  it('金额框保留 inputmode=decimal 且只显示剥符号后的幅值', () => {
    expect(sfcSource).toMatch(/inputmode="decimal"/)
    expect(sfcSource).not.toMatch(/inputmode="numeric"/)
    // 自定义键盘编辑态由 amountDisplayOf 逐键回填表达式；其余场景仍走剥符号幅值。
    expect(sfcSource).toMatch(/:value="amountDisplayOf\(index\)"/)
    expect(sfcSource).toMatch(/magnitudeOf\(row\.amount\)/)
  })
})

/**
 * iOS 真机专属坑：Safari 对 button 默认套 -webkit-appearance:button，
 * 自带原生内边距 / 圆角 / 渐变 / 阴影，在 flex 或 grid 子项里会错位。
 * jsdom 算不出真机样式，只能通过源码文本断言守住清除规则，防未来新增按钮遗漏。
 */
describe('iOS 按钮 appearance 回归：清除原生外观 + 显式行高', () => {
  const guardedSelectors = [
    '.dir-toggle .seg',
    '.signflip',
    '.adv-remove',
    '.add-row',
    '.auto-row',
    '.g-link',
    // v2.1 行浮层 / 行内 chip 新增按钮同样清掉 iOS 原生外观。
    '.acc-chip',
    '.cur-chip',
    '.adv-pop-close',
    '.adv-option',
  ]

  it('全部按钮规则都含 appearance:none（含 -webkit- 前缀）与 line-height', () => {
    for (const selector of guardedSelectors) {
      const body = ruleBodyFor(selector)
      expect(body, `缺少 ${selector} 规则`).not.toBe('')
      expect(body, `${selector} 应清掉 iOS 原生 appearance`)
        .toMatch(/(?:^|;)\s*-webkit-appearance:\s*none\s*;/)
      expect(body, `${selector} 应清掉标准 appearance`)
        .toMatch(/(?:^|;)\s*appearance:\s*none\s*;/)
      expect(body, `${selector} 应显式设置行高，避免 iOS 文字垂直偏移`)
        .toMatch(/(?:^|;)\s*line-height:\s*1(?:\.2)?\s*;/)
    }
  })

  it('模板里新增 button 必须落在守门选择器内，防止漏加 appearance 清除', () => {
    const buttons = sfcSource.match(/<button\b[^>]*>/g) ?? []
    expect(buttons.length).toBeGreaterThan(0)
    for (const tag of buttons) {
      const classMatch = tag.match(/class="([^"]*)"/)
      const classes = classMatch === null ? [] : (classMatch[1] ?? '').split(/\s+/).filter(Boolean)
      expect(
        classes.some((name) => guardedSelectors.some((selector) => selector.endsWith(`.${name}`))),
        `按钮缺少 appearance 守门: ${tag}`,
      ).toBe(true)
    }
  })

  it('修复 appearance 未削弱 16px 字号与 44px 触控目标', () => {
    for (const selector of ['.dir-toggle .seg', '.signflip', '.adv-remove']) {
      const body = ruleBodyFor(selector)
      expect(body, `${selector} 字号应保持 16px`).toMatch(/font-size:\s*16px/)
    }
    for (const selector of ['.signflip', '.adv-remove']) {
      expect(ruleBodyFor(selector), `${selector} 触控高度应 >=44px`).toMatch(TOUCH_MIN_RE)
    }
  })
})

/**
 * iOS 借贷 Toggle 选中态色块偏移回归：WebKit 下 flex:1 对 <button> 按内容固有宽度
 * 分配，选中色块会缩在格子左侧。修复为 Grid 两等分 + .seg 显式几何。
 * jsdom 无真实布局，沿用源码文本断言（见文件头说明）。
 */
describe('iOS 借贷 Toggle 布局回归：Grid 两等分 + seg 显式几何', () => {
  /** 压缩空白，避免断言被换行 / 缩进干扰。 */
  function compact(text: string): string {
    return text.replace(/\s+/g, '')
  }

  it('.dir-toggle 使用 Grid 两等分列宽，不再依赖 flex 分配', () => {
    const body = compact(ruleBodyFor('.dir-toggle'))
    expect(body, '缺少 .dir-toggle 规则').not.toBe('')
    expect(body, '.dir-toggle 应为 display:grid').toContain('display:grid;')
    expect(body, '.dir-toggle 应为两等分 Grid 列')
      .toContain('grid-template-columns:repeat(2,minmax(0,1fr));')
    expect(body, '.dir-toggle 不应再是 flex 容器').not.toContain('display:flex;')
    expect(body, '保留 gap:2px').toContain('gap:2px;')
    expect(body, '保留 padding:3px').toContain('padding:3px;')
  })

  it('.seg 显式撑满 grid 单元且清除 button 默认几何', () => {
    const body = compact(ruleBodyFor('.dir-toggle .seg'))
    expect(body, '缺少 .dir-toggle .seg 规则').not.toBe('')
    for (const declaration of [
      'width:100%;',
      'height:100%;',
      'min-width:0;',
      'padding:0;',
      'margin:0;',
      'display:flex;',
      'align-items:center;',
      'justify-content:center;',
    ]) {
      expect(body, `.seg 应含 ${declaration}`).toContain(declaration)
    }
    expect(body, '.seg 不应保留 flex:1（grid 下无效且会误导）').not.toContain('flex:1;')
  })

  it('结构修复未削弱 16px 字号、appearance 清除、触控高度与选中态配色', () => {
    const seg = compact(ruleBodyFor('.dir-toggle .seg'))
    expect(seg, '.seg 字号应保持 16px').toContain('font-size:16px;')
    expect(seg, '.seg 应清掉 iOS 原生 appearance').toContain('-webkit-appearance:none;')
    expect(seg, '.seg 应清掉标准 appearance').toContain('appearance:none;')
    expect(seg, '.seg 应显式设置行高').toContain('line-height:1.2;')
    expect(compact(ruleBodyFor('.dir-toggle')), 'Toggle 触控高度应 >=44px')
      .toMatch(/min-height:(4[4-9]|[5-9]\d)px/)
    expect(compact(ruleBodyFor('.dir-toggle .seg.debit.on')), '借方选中态应为 --fb-brand')
      .toContain('background:var(--fb-brand);')
    expect(compact(ruleBodyFor('.dir-toggle .seg.credit.on')), '贷方选中态应为 --fb-seal')
      .toContain('background:var(--fb-seal);')
  })

  it('同排 grid 单元按钮 .signflip / .adv-remove 同样显式居中撑满', () => {
    for (const selector of ['.signflip', '.adv-remove']) {
      const body = compact(ruleBodyFor(selector))
      for (const declaration of [
        'width:100%;',
        'height:100%;',
        'padding:0;',
        'margin:0;',
        'display:flex;',
        'align-items:center;',
        'justify-content:center;',
      ]) {
        expect(body, `${selector} 应含 ${declaration}`).toContain(declaration)
      }
    }
  })
})
