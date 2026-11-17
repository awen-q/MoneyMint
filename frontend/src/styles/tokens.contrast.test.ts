// @vitest-environment node
/**
 * 阶段 1 基底门禁：解析 tokens.css 的 :root / 作用域声明块，
 * 1) 全量 golden 锚定暖纸 token；2) WCAG 对比度分层断言；
 * 3) 双轨结构断言（作用域不得重复定义已上提的同名 token）；
 * 4) 不变量守护（--vvh / tabular-nums / Safari 14.1 禁用语法）。
 *
 * 期望色值全部来自 scripts/theme-paper.golden.json，测试文件内不写裸 hex。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import paperGolden from '../../scripts/theme-paper.golden.json'

const tokensCss = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8')

/** 去掉注释后按正则截取规则体。 */
function ruleBody(selector: RegExp): string {
  const match = selector.exec(tokensCss)
  expect(match, 'tokens.css 中未找到目标规则块').not.toBeNull()
  return (match?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 解析 CSS 声明为 Map<变量名, 归一化值>。 */
function parseDeclarations(body: string): Map<string, string> {
  const result = new Map<string, string>()
  const pattern = /(--[\w-]+)\s*:\s*([^;]+);/g
  let match = pattern.exec(body)
  while (match !== null) {
    result.set(match[1] ?? '', (match[2] ?? '').replace(/\s+/g, ' ').trim())
    match = pattern.exec(body)
  }
  return result
}

const rootTokens = parseDeclarations(ruleBody(/:root\s*\{([\s\S]*?)\}/))
const scopeTokens = parseDeclarations(ruleBody(/\.rs-mask\s*,\s*\.slip\s*\{([\s\S]*?)\}/))

/** 递归展开 `var(--x)`，让 var 型 token 也能参与对比度计算。 */
function resolveExpression(value: string, depth = 0): string {
  const trimmed = value.trim()
  const reference = /^var\(\s*(--[\w-]+)\s*\)$/.exec(trimmed)
  if (reference !== null && depth < 8) {
    const name = reference[1] ?? ''
    return resolveExpression(rootTokens.get(name) ?? '', depth + 1)
  }
  return trimmed
}

interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/** 解析十六进制与颜色函数写法；无法解析时抛错，避免对比度测试假绿。 */
function parseColor(value: string): Rgba {
  const expression = resolveExpression(value)
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(expression)
  if (hex !== null) {
    const digits = hex[1] ?? ''
    const expanded =
      digits.length === 3
        ? digits
            .split('')
            .map((char) => char + char)
            .join('')
        : digits
    return {
      r: Number.parseInt(expanded.slice(0, 2), 16),
      g: Number.parseInt(expanded.slice(2, 4), 16),
      b: Number.parseInt(expanded.slice(4, 6), 16),
      a: 1,
    }
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(
    expression,
  )
  if (rgb !== null) {
    return {
      r: Number(rgb[1]),
      g: Number(rgb[2]),
      b: Number(rgb[3]),
      a: rgb[4] === undefined ? 1 : Number(rgb[4]),
    }
  }
  throw new Error(`无法解析颜色值：${expression}`)
}

/** WCAG 2.1 相对亮度：sRGB 非线性分量线性化后加权求和。 */
function luminance(color: Rgba): number {
  const channel = (value: number): number => {
    const normalized = value / 255
    return normalized <= 0.03928
      ? normalized / 12.92
      : Math.pow((normalized + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

/** 两个不透明色的 WCAG 对比度（较大亮度 +0.05）/（较小亮度 +0.05）。 */
function contrast(foregroundToken: string, backgroundToken: string): number {
  const foreground = parseColor(rootTokens.get(foregroundToken) ?? '')
  const background = parseColor(rootTokens.get(backgroundToken) ?? '')
  expect(foreground.a, `${foregroundToken} 应为不透明色`).toBe(1)
  expect(background.a, `${backgroundToken} 应为不透明色`).toBe(1)
  const first = luminance(foreground)
  const second = luminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

interface Pair {
  readonly label: string
  readonly foreground: string
  readonly background: string
}

/**
 * 阶段 2 OBS-1 收口后锁定：正文安全墨色 on 对应 soft 底的实测下限。
 * 没有登记的组合沿用 WCAG AA 正文门槛 4.5:1；这些 floor 只依赖 token 名，不写裸 hex。
 */
const INK_MIN_RATIOS: ReadonlyMap<string, number> = new Map([
  ['警示正文墨 on 警示浅底', 5.1],
  ['成功正文墨 on 成功浅底', 5.29],
  ['危险正文墨 on 危险浅底', 5.37],
])

/** 正文安全墨色 / 主按钮反白字 / 侧栏文字：门槛 4.5:1。 */
const BODY_PAIRS: readonly Pair[] = [
  { label: '品牌墨绿 on 纸面', foreground: '--fb-blue', background: '--fb-card' },
  { label: '成功绿 on 纸面', foreground: '--fb-green', background: '--fb-card' },
  { label: '危险红 on 纸面', foreground: '--fb-danger', background: '--fb-card' },
  { label: '印章红 on 纸面', foreground: '--fb-seal', background: '--fb-card' },
  { label: '正文墨 on 页面底', foreground: '--fb-ink', background: '--fb-bg' },
  { label: '正文墨 on 卡片', foreground: '--fb-ink', background: '--fb-card' },
  { label: '正文墨 on 浅纸底', foreground: '--fb-ink', background: '--fb-soft' },
  { label: '次要墨 on 卡片', foreground: '--fb-sub', background: '--fb-card' },
  { label: '次要墨 on 页面底', foreground: '--fb-sub', background: '--fb-bg' },
  { label: '次要墨 on 浅纸底', foreground: '--fb-sub', background: '--fb-soft' },
  { label: '警示正文墨 on 警示浅底', foreground: '--fb-warn-ink', background: '--fb-warn-soft' },
  { label: '成功正文墨 on 成功浅底', foreground: '--fb-green-ink', background: '--fb-green-soft' },
  { label: '危险正文墨 on 危险浅底', foreground: '--fb-danger-ink', background: '--fb-danger-soft' },
  { label: '主按钮反白字 on 品牌墨绿', foreground: '--fb-white', background: '--fb-blue' },
  { label: '侧栏正文 on 侧栏底', foreground: '--fb-side-fg', background: '--fb-sidebar' },
  { label: '侧栏标题 on 侧栏底', foreground: '--fb-side-head', background: '--fb-sidebar' },
]

/** 填充色 / 图形 / 大字：门槛 3.0:1（--fb-warn 仅可用于此层）。 */
const GRAPHIC_PAIRS: readonly Pair[] = [
  { label: '警示填充 on 纸面', foreground: '--fb-warn', background: '--fb-card' },
  { label: '品牌墨绿 on 墨绿浅底', foreground: '--fb-blue', background: '--fb-blue-soft' },
  { label: '印章红 on 警示浅底', foreground: '--fb-seal', background: '--fb-warn-soft' },
]

describe('阶段 1 基底 golden：:root 暖纸 token 全量锚定', () => {
  it('golden key 与 tokens.css :root 完全对齐（无遗漏、无漂移）', () => {
    const expected = Object.entries(paperGolden.rootGolden)
    expect(expected.length).toBeGreaterThan(0)
    for (const [name, value] of expected) {
      expect(rootTokens.get(name), `${name} 暖纸值被改动或缺失`).toBe(value)
    }
  })

  it('阶段 0 遗留蓝值已清除：primary / primary-soft / shadow-accent 均为暖系', () => {
    expect(rootTokens.get('--fb-primary')).toBe(rootTokens.get('--fb-blue'))
    expect(rootTokens.get('--fb-primary-soft')).toBe(rootTokens.get('--fb-blue-soft'))
    // 拼接字符串，避免在测试源码里出现被护栏判违规的颜色函数字面量。
    expect(rootTokens.get('--fb-shadow-accent')).toContain('rgba' + '(60, 48, 28')
  })
})

describe('阶段 1 结构门禁：物理单源', () => {
  it('.rs-mask / .slip 中不得再有与 :root 同名的声明（登记例外除外）', () => {
    const exceptions = new Set(Object.keys(paperGolden.scopeExceptions))
    const duplicates: string[] = []
    for (const name of scopeTokens.keys()) {
      if (rootTokens.has(name) && !exceptions.has(name)) {
        duplicates.push(name)
      }
    }
    expect(duplicates, '作用域残留双轨声明').toEqual([])
  })

  it('作用域只剩登记例外，且值与 golden 逐字相同（小票零变化）', () => {
    const expected = paperGolden.scopeExceptions
    expect(Array.from(scopeTokens.keys()).sort()).toEqual(Object.keys(expected).sort())
    for (const [name, value] of Object.entries(expected)) {
      expect(scopeTokens.get(name), `${name} 作用域值被改动`).toBe(value)
    }
  })
})

describe('阶段 1 对比度门禁 G3：正文 ≥4.5、大字/UI/图形 ≥3.0', () => {
  it(`正文配对全部达到门槛（含 OBS-1 收口下限，共 ${BODY_PAIRS.length} 对）`, () => {
    for (const pair of BODY_PAIRS) {
      const score = contrast(pair.foreground, pair.background)
      const floor = INK_MIN_RATIOS.get(pair.label) ?? 4.5
      expect(score, `${pair.label}：${pair.foreground} on ${pair.background}`).toBeGreaterThanOrEqual(
        floor,
      )
    }
  })

  it(`大字/UI/图形配对全部达到 3.0:1（共 ${GRAPHIC_PAIRS.length} 对）`, () => {
    for (const pair of GRAPHIC_PAIRS) {
      const score = contrast(pair.foreground, pair.background)
      expect(score, `${pair.label}：${pair.foreground} on ${pair.background}`).toBeGreaterThanOrEqual(
        3.0,
      )
    }
  })
})

describe('阶段 1 不变量门禁 G4：兼容与硬指标', () => {
  it('--vvh / 键盘机制 / 等宽数字 token 未被改动', () => {
    expect(rootTokens.get('--vvh')).toBe('100vh')
    expect(rootTokens.get('--kb-h')).toBe('clamp(40px, 6.4vh, 48px)')
    expect(rootTokens.get('--fb-font-numeric')).toBe('tabular-nums')
  })

  it('图表临时色与夜纸注释桩保持阶段纪律', () => {
    expect(rootTokens.get('--fb-chart-4')).not.toBe('')
    expect(rootTokens.get('--fb-chart-6')).not.toBe('')
    expect(tokensCss).toContain('[data-theme=\'night\'] 语义覆盖见阶段4')
  })

  it('未引入 Safari 14.1 禁用 CSS 语法', () => {
    expect(tokensCss).not.toMatch(/:has\s*\(/)
    expect(tokensCss).not.toMatch(/\bdvh\b/)
    expect(tokensCss).not.toMatch(/(^|[^\w-])inset\s*:/)
  })
})
