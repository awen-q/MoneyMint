// @vitest-environment node
/**
 * PC 顶栏源码契约（≥900）：账本行与三小件合成一行、上方空白带收回。
 *
 * jsdom 无布局引擎，媒体查询与真实高度都不可靠，沿用 DesktopLayout.test.ts 的
 * 源码文本断言守住 CSS 契约；视觉验收仍在 900/1024 边界人工做。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

import { describe, expect, it } from 'vitest'

function scopedCssOf(relativePath: string): string {
  const source = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
  const openTag = '<style scoped>'
  const start = source.indexOf(openTag)
  const end = source.indexOf('</style>', start)
  return source.slice(start + openTag.length, end).replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 抽取 `@media (min-width: Npx) { ... }` 的规则体（大括号配平）。 */
function mediaBlockFor(css: string, width: number): string {
  const start = css.indexOf(`@media (min-width: ${width}px)`)
  if (start < 0) {
    return ''
  }
  const open = css.indexOf('{', start)
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') {
      depth += 1
    } else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) {
        return css.slice(open + 1, i)
      }
    }
  }
  return ''
}

/** 在给定 CSS 片段内按选择器取规则体（兼容逗号分组）。 */
function ruleBodyIn(css: string, selector: string): string {
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g
  let match: RegExpExecArray | null = rulePattern.exec(css)
  while (match !== null) {
    const selectors = (match[1] ?? '').split(',').map((item) => item.trim())
    if (selectors.indexOf(selector) >= 0) {
      return match[2] ?? ''
    }
    match = rulePattern.exec(css)
  }
  return ''
}

const headCss = scopedCssOf('./ShellHead.vue')
const pc = mediaBlockFor(headCss, 900)

describe('Bug A：PC 顶栏压成一行', () => {
  it('≥900 的 .hd 是 flex 行容器，高度 44px，padding-top 显式覆盖 safe-area', () => {
    expect(pc, '缺少 @media(min-width:900) 块').not.toBe('')
    const hd = ruleBodyIn(pc, '.hd')
    expect(hd, '缺少 PC .hd 规则').not.toBe('')
    expect(hd).toMatch(/display:\s*flex/)
    expect(hd).toMatch(/align-items:\s*center/)
    expect(hd).toMatch(/justify-content:\s*space-between/)
    expect(hd).toMatch(/gap:\s*12px/)
    expect(hd).toMatch(/min-height:\s*44px/)
    expect(hd).toMatch(/padding:\s*6px 24px/)
    expect(hd).toMatch(/padding-top:\s*6px/)
  })

  it('账本行用 order:-1 视觉左移，三小件由父级 space-between 右推', () => {
    expect(ruleBodyIn(pc, '.hd__ledger')).toMatch(/order:\s*-1/)
    expect(ruleBodyIn(pc, '.hd__ledger')).toMatch(/margin:\s*0/)
    expect(ruleBodyIn(pc, '.hd__tools')).toMatch(/margin-left:\s*0/)
    expect(ruleBodyIn(pc, '.hd__row')).toMatch(/min-height:\s*0/)
  })

  it('PC 鼠标目标 32×32；移动端基础触控区与 safe-area padding 不动', () => {
    const icon = ruleBodyIn(pc, '.hd__icon')
    expect(icon).toMatch(/width:\s*32px/)
    expect(icon).toMatch(/height:\s*32px/)
    expect(icon).toMatch(/padding:\s*1px/)

    const base = headCss.replace(pc, '')
    const baseIcon = ruleBodyIn(base, '.hd__icon')
    expect(baseIcon).toMatch(/width:\s*44px/)
    expect(baseIcon).toMatch(/height:\s*44px/)
    expect(ruleBodyIn(base, '.hd')).toMatch(/padding-top:\s*max\(12px, env\(safe-area-inset-top, 0px\)\)/)
  })

  it('AppLayout 的 PC 内容区上内边距收到 16px，横向仍是 28px', () => {
    const layoutPc = mediaBlockFor(scopedCssOf('../AppLayout.vue'), 900)
    const content = ruleBodyIn(layoutPc, '.layout__content')
    expect(content).toMatch(/padding:\s*26px 28px/)
    expect(content).toMatch(/padding-top:\s*16px/)
  })
})
