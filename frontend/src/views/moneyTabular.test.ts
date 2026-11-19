// @vitest-environment node
/**
 * 阶段 3 等宽数字门禁（硬指标二）：金额 / 数字密集视图必须用 token 化等宽数字。
 *
 * vitest 默认不把 SFC 的 <style scoped> 注入 DOM，getComputedStyle 读不到这些规则，
 * 因此沿用 RecordSheet.iosFont.test.ts 的源码文本断言先例：按选择器取规则体并断言
 * `font-variant-numeric: var(--fb-font-numeric)` 已落地。断言只写 token 名与属性文本，
 * 不写任何色值字面量，避免被 check-theme 护栏误报。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

import { describe, expect, it } from 'vitest'

/** 唯一允许的等宽声明：值必须来自 :root token，不允许组件内硬编码。 */
const NUMERIC_DECLARATION = 'font-variant-numeric: var(--fb-font-numeric)'

interface NumericTarget {
  /** 相对本测试文件（src/views/）的 SFC 路径。 */
  readonly file: string
  /** 承载金额 / 数字的规则选择器（精确匹配，逗号分组会拆开）。 */
  readonly selectors: readonly string[]
}

/** 金额与数字密集视图 / 组件的等宽落点清单。 */
const TARGETS: readonly NumericTarget[] = [
  { file: '../components/MoneyText.vue', selectors: ['.money-text'] },
  { file: '../App.vue', selectors: ['.app-standalone__version'] },
  { file: '../views/AccountsView.vue', selectors: ['.accts__meta'] },
  {
    file: '../views/AccountDetailView.vue',
    selectors: ['.acctd__hint', '.acctd__preview', '.acctd__warn', '.acctd__row-meta'],
  },
  { file: '../views/LedgersView.vue', selectors: ['.ldg__name small', '.ldg__panel p'] },
  // 原「日历格 + 日分组头」落点随旧流水页下线（T38），由账单页日历卡等价承接
  // （同一类：格内金额、日号、日小计都要等宽，否则列会随数字宽度抖动）。
  { file: '../components/bill/BillCalendar.vue', selectors: ['.cal__day', '.cal__amount'] },
  // 原「卡头金额行」落点已随 T31 下线，由账单页的日小计行等价承接
  // （同一类：一行里混排日期/标签 + 金额，等宽才能让列不跳动）。
  { file: '../views/BillsView.vue', selectors: ['.bills__group-head'] },
  // 全站金额出现次数最多的一处：交易行右端的金额。行高与列对齐都靠它。
  { file: '../components/TxnRow.vue', selectors: ['.txn-row__amount'] },
  // 账单页主视觉数字。注意这里**只锁「结余」与「交易数量」两张卡**：
  // 收入/支出两卡直接渲染 MoneyText，已由上面的 `.money-text` 条目覆盖，
  // 不要再为它们加选择器（会变成重复覆盖）。
  { file: '../components/bill/BillMetrics.vue', selectors: ['.metrics__value'] },
  { file: '../views/ImportView.vue', selectors: ['.im__table'] },
  { file: '../views/CommoditiesView.vue', selectors: ['.cmd__table'] },
  { file: '../views/CategoriesView.vue', selectors: ['.cats__meta', '.cats__warn'] },
  { file: '../views/TrashView.vue', selectors: ['.trash__meta'] },
]

/**
 * 读取源文件文本。
 *
 * @param relativePath 相对本测试文件的路径
 * @returns UTF-8 源文本
 */
function sourceOf(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
}

/**
 * 提取 <style scoped> 正文并去掉注释，避免注释干扰选择器解析。
 *
 * @param relativePath 相对本测试文件的 SFC 路径
 * @returns 去掉注释的 scoped CSS 文本
 */
function scopedCssOf(relativePath: string): string {
  const source = sourceOf(relativePath)
  const start = source.indexOf('<style scoped>')
  const end = source.indexOf('</style>', start)
  expect(start, `${relativePath} 缺少 <style scoped>`).toBeGreaterThanOrEqual(0)
  expect(end, `${relativePath} 缺少 </style>`).toBeGreaterThan(start)
  // 跳过 <style scoped> 标签本身，否则首条规则的选择器会带上标签前缀而匹配不到。
  const contentStart = start + '<style scoped>'.length
  return source.slice(contentStart, end).replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * 按精确选择器取规则体，兼容逗号分隔的分组选择器。
 *
 * @param css 已去注释的 CSS 文本
 * @param selector 目标选择器
 * @returns 规则体内文；找不到时返回空串
 */
function ruleBodyFor(css: string, selector: string): string {
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g
  let match: RegExpExecArray | null = rulePattern.exec(css)
  while (match !== null) {
    const selectors = (match[1] ?? '')
      .split(',')
      .map((item) => item.trim())
    if (selectors.indexOf(selector) >= 0) {
      return match[2] ?? ''
    }
    match = rulePattern.exec(css)
  }
  return ''
}

describe('阶段 3 等宽数字：token 定义与落点', () => {
  it(':root 的等宽 token 未被改动', () => {
    expect(sourceOf('../styles/tokens.css')).toContain('--fb-font-numeric: tabular-nums')
  })

  for (const target of TARGETS) {
    it(`${target.file}：${target.selectors.length} 个数字落点均应用 token`, () => {
      const css = scopedCssOf(target.file)
      for (const selector of target.selectors) {
        const body = ruleBodyFor(css, selector)
        expect(body, `${target.file} 缺少 ${selector} 规则`).not.toBe('')
        expect(body, `${target.file} 的 ${selector} 未应用等宽数字`).toContain(
          NUMERIC_DECLARATION,
        )
      }
    })
  }
})
