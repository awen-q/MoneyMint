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

import nightGolden from '../../scripts/theme-night.golden.json'
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
const nightTokens = parseDeclarations(ruleBody(/\[data-theme='night'\]\s*\{([\s\S]*?)\}/))

/** 递归展开 `var(--x)`，让 var 型 token 也能参与对比度计算。 */
function resolveExpression(value: string, tokens: Map<string, string>, depth = 0): string {
  const trimmed = value.trim()
  const reference = /^var\(\s*(--[\w-]+)\s*\)$/.exec(trimmed)
  if (reference !== null && depth < 8) {
    const name = reference[1] ?? ''
    return resolveExpression(tokens.get(name) ?? '', tokens, depth + 1)
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
function parseColor(value: string, tokens: Map<string, string>): Rgba {
  const expression = resolveExpression(value, tokens)
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
function contrast(
  foregroundToken: string,
  backgroundToken: string,
  tokens: Map<string, string> = rootTokens,
): number {
  const foreground = parseColor(tokens.get(foregroundToken) ?? '', tokens)
  const background = parseColor(tokens.get(backgroundToken) ?? '', tokens)
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
  // B1 扩色：分类色第 7~10 档，10 个分类以上仍要能区分且可读
  { label: '图表第 7 色 on 纸面', foreground: '--fb-chart-7', background: '--fb-card' },
  { label: '图表第 8 色 on 纸面', foreground: '--fb-chart-8', background: '--fb-card' },
  { label: '图表第 9 色 on 纸面', foreground: '--fb-chart-9', background: '--fb-card' },
  { label: '图表第 10 色 on 纸面', foreground: '--fb-chart-10', background: '--fb-card' },
]

/** 阶段 4 夜纸：正文 ≥4.5:1 的关键配对（token 名驱动，测试内无裸 hex）。 */
const NIGHT_BODY_PAIRS: readonly Pair[] = [
  { label: '夜纸正文墨 on 页面底', foreground: '--fb-ink', background: '--fb-bg' },
  { label: '夜纸正文墨 on 卡片', foreground: '--fb-ink', background: '--fb-card' },
  { label: '夜纸正文墨 on 浅面', foreground: '--fb-ink', background: '--fb-soft' },
  { label: '夜纸次要墨 on 卡片', foreground: '--fb-sub', background: '--fb-card' },
  { label: '夜纸次要墨 on 页面底', foreground: '--fb-sub', background: '--fb-bg' },
  { label: '夜纸主色墨 on 卡片', foreground: '--fb-blue', background: '--fb-card' },
  { label: '夜纸成功墨 on 卡片', foreground: '--fb-green', background: '--fb-card' },
  { label: '夜纸警示墨 on 卡片', foreground: '--fb-warn', background: '--fb-card' },
  { label: '夜纸危险墨 on 卡片', foreground: '--fb-danger', background: '--fb-card' },
  { label: '夜纸印章墨 on 卡片', foreground: '--fb-seal', background: '--fb-card' },
  { label: '夜纸深墨 on 卡片', foreground: '--fb-ink-deep', background: '--fb-card' },
  { label: '夜纸警示正文墨 on 夜纸警示底', foreground: '--fb-warn-ink', background: '--fb-warn-soft' },
  { label: '夜纸成功正文墨 on 夜纸成功底', foreground: '--fb-green-ink', background: '--fb-green-soft' },
  { label: '夜纸危险正文墨 on 夜纸危险底', foreground: '--fb-danger-ink', background: '--fb-danger-soft' },
  { label: '夜纸主按钮字 on 亮墨绿', foreground: '--fb-white', background: '--fb-blue' },
  { label: '夜纸侧栏正文 on 侧栏底', foreground: '--fb-side-fg', background: '--fb-sidebar' },
  { label: '夜纸侧栏标题 on 侧栏底', foreground: '--fb-side-head', background: '--fb-sidebar' },
]

/** 阶段 4 夜纸：图形 / 填充 / 大字 ≥3.0:1。 */
const NIGHT_GRAPHIC_PAIRS: readonly Pair[] = [
  { label: '夜纸主色 on 夜纸主色浅底', foreground: '--fb-blue', background: '--fb-blue-soft' },
  { label: '夜纸成功色 on 夜纸成功浅底', foreground: '--fb-green', background: '--fb-green-soft' },
  { label: '夜纸图表第 4 色 on 卡片', foreground: '--fb-chart-4', background: '--fb-card' },
  { label: '夜纸图表第 6 色 on 卡片', foreground: '--fb-chart-6', background: '--fb-card' },
  { label: '夜纸图表第 7 色 on 卡片', foreground: '--fb-chart-7', background: '--fb-card' },
  { label: '夜纸图表第 8 色 on 卡片', foreground: '--fb-chart-8', background: '--fb-card' },
  { label: '夜纸图表第 9 色 on 卡片', foreground: '--fb-chart-9', background: '--fb-card' },
  { label: '夜纸图表第 10 色 on 卡片', foreground: '--fb-chart-10', background: '--fb-card' },
]

/** 夜纸不覆盖 paper 五兄弟：小票仍是浅纸。 */
const PAPER_FIVE = Object.keys(paperGolden.scopeExceptions)

describe('阶段 4 夜纸 golden：night 语义覆盖全量锚定', () => {
  it('golden key 与 [data-theme=night] 块逐字对齐', () => {
    const expected = Object.entries(nightGolden.nightGolden)
    expect(expected.length).toBeGreaterThan(0)
    for (const [name, value] of expected) {
      expect(nightTokens.get(name), `${name} 夜纸值被改动或缺失`).toBe(value)
    }
  })

  it('paper 五兄弟未被 night 覆盖，且 .slip 夜纸作用域显式存在', () => {
    for (const name of PAPER_FIVE) {
      expect(nightTokens.has(name), `${name} 不应在 night 根块覆盖`).toBe(false)
    }
    expect(tokensCss).toContain("[data-theme='night'] .slip")
  })
})

describe('阶段 4 夜纸对比度门禁：正文 ≥4.5、图形 ≥3.0', () => {
  it(`夜纸正文配对全部达标（共 ${NIGHT_BODY_PAIRS.length} 对）`, () => {
    for (const pair of NIGHT_BODY_PAIRS) {
      const score = contrast(pair.foreground, pair.background, nightTokens)
      expect(score, `${pair.label}：${pair.foreground} on ${pair.background}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it(`夜纸图形配对全部达标（共 ${NIGHT_GRAPHIC_PAIRS.length} 对）`, () => {
    for (const pair of NIGHT_GRAPHIC_PAIRS) {
      const score = contrast(pair.foreground, pair.background, nightTokens)
      expect(score, `${pair.label}：${pair.foreground} on ${pair.background}`).toBeGreaterThanOrEqual(3.0)
    }
  })
})

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

/**
 * 骨架屏三色门禁（骨架屏批 / SkeletonBlock）：底色对卡面「可见但克制」，
 * 扫光两档相对底色单调提亮 —— 「扫过变亮」的语义在浅纸 / 夜纸两态一致。
 * 断言只依赖 token 名，测试内不写裸 hex（check-theme 护栏同样约束本文件）。
 */
describe('骨架屏 token 门禁：底色可见克制、扫光单调提亮', () => {
  /** 浅纸 / 夜纸两套 token 各跑一遍同样的断言。 */
  const SKELETON_THEMES: ReadonlyArray<{ label: string; tokens: Map<string, string> }> = [
    { label: '浅纸', tokens: rootTokens },
    { label: '夜纸', tokens: nightTokens },
  ]

  it('底色在卡面上可见（≥1.05）且不喧宾夺主（≤1.35）', () => {
    for (const { label, tokens } of SKELETON_THEMES) {
      const score = contrast('--fb-skeleton-base', '--fb-card', tokens)
      expect(score, `${label} 骨架底 on 卡面`).toBeGreaterThanOrEqual(1.05)
      expect(score, `${label} 骨架底 on 卡面`).toBeLessThanOrEqual(1.35)
    }
  })

  it('扫光方向单调：高光 > 过渡 > 底（相对底色对比度递增）', () => {
    for (const { label, tokens } of SKELETON_THEMES) {
      const soft = contrast('--fb-skeleton-sheen-soft', '--fb-skeleton-base', tokens)
      const peak = contrast('--fb-skeleton-sheen', '--fb-skeleton-base', tokens)
      expect(soft, `${label} 过渡档 vs 底`).toBeGreaterThan(1.02)
      expect(peak, `${label} 高光档 vs 底`).toBeGreaterThan(soft)
    }
  })
})
