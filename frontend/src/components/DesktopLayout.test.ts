// @vitest-environment node
/**
 * PC 布局源码断言：侧栏锁高 / 主区内滚动 / 记一笔弹窗主区居中。
 *
 * jsdom 无布局引擎，getBoundingClientRect 与媒体查询均不可靠，
 * 故沿用源码文本断言守住 CSS 契约；真实视觉效果仍需在 900/1024 边界人工验收。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

import { describe, expect, it } from 'vitest'

function scopedCssOf(fileName: string): string {
  const source = readFileSync(fileURLToPath(new URL(`./${fileName}`, import.meta.url)), 'utf8')
  const openTag = '<style scoped>'
  const start = source.indexOf(openTag)
  const end = source.indexOf('</style>', start)
  // 跳过开标签本身，否则第一条规则的选择器会变成 "<style scoped> .layout"。
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

describe('Bug A：PC（>=900）侧栏锁视口、仅主区内容滚动', () => {
  const css = scopedCssOf('AppLayout.vue')
  const pc = mediaBlockFor(css, 900)

  it('@media(min-width:900) 内 .layout 锁 100vh 且 overflow:hidden', () => {
    expect(pc, '缺少 @media(min-width:900) 块').not.toBe('')
    const body = ruleBodyIn(pc, '.layout')
    expect(body, '缺少 PC .layout 规则').not.toBe('')
    expect(body).toMatch(/height:\s*100vh/)
    expect(body).toMatch(/overflow:\s*hidden/)
    expect(body).toMatch(/min-height:\s*0/)
  })

  it('.layout__main 归零 min-height；.layout__content 内容内滚', () => {
    expect(ruleBodyIn(pc, '.layout__main')).toMatch(/min-height:\s*0/)
    const content = ruleBodyIn(pc, '.layout__content')
    expect(content).toMatch(/overflow-y:\s*auto/)
    expect(content).toMatch(/min-height:\s*0/)
    expect(content).toMatch(/overscroll-behavior:\s*contain/)
  })

  it('移动端（<900）基础规则不动：文档流 + 94px 底栏留白仍在', () => {
    const withoutPc = css.replace(pc, '')
    const base = ruleBodyIn(withoutPc, '.layout__content')
    expect(base).toMatch(/padding-bottom:\s*calc\(94px \+ env\(safe-area-inset-bottom, 0px\)\)/)
    // 基础 .layout 仍是 min-height，锁高只发生在 PC 媒体块内。
    expect(ruleBodyIn(withoutPc, '.layout')).toMatch(/min-height:\s*100vh/)
  })
})

describe('Bug B：记一笔弹窗断点统一 900，且相对右侧主区居中', () => {
  const css = scopedCssOf('RecordSheet.vue')
  const pc = mediaBlockFor(css, 900)

  it('断点由 1024 改为 900', () => {
    expect(mediaBlockFor(css, 900)).not.toBe('')
    expect(css).not.toMatch(/@media\s*\(min-width:\s*1024px\)/)
  })

  it('.rs-mask--auto 用 --fb-sidebar-w 把居中基准移到右侧主区', () => {
    const auto = ruleBodyIn(pc, '.rs-mask--auto')
    expect(auto, 'PC 块内缺少 .rs-mask--auto 规则').not.toBe('')
    expect(auto).toMatch(/align-items:\s*center/)
    expect(auto).toMatch(/padding-left:\s*var\(--fb-sidebar-w/)
  })

  it('全屏 / 键盘弹起 / 小票规则未被破坏', () => {
    expect(ruleBodyIn(css, '.rs-mask--fullscreen')).not.toBe('')
    expect(css).toMatch(/body\.kbd-open\s+\.rs-stage/)
    // 小票规则在 PC 块内按原样保留（逗号分组取其中一项）。
    expect(ruleBodyIn(pc, '.rs-mask--dialog .rs-panel--receipt')).not.toBe('')
  })
})
