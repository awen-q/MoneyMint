// @vitest-environment node
/**
 * 阶段 3 图表暖色化门禁：六色饼图在纸底上的图形对比度 + 单一色源一致性。
 *
 * 色值只从 scripts/theme-tokens.golden.json 与 tokens.css 读取，测试源码内
 * 不出现任何色值字面量（check-theme 护栏会扫描 src/**\/*.ts）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

import { describe, expect, it } from 'vitest'

import goldenTokens from '../../scripts/theme-tokens.golden.json'
import { DEFAULT_TOKENS } from './themeTokens'

interface Rgb {
  r: number
  g: number
  b: number
}

const tokensCss = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8')
const themeTokensSource = readFileSync(
  fileURLToPath(new URL('./themeTokens.ts', import.meta.url)),
  'utf8',
)
// 被扫描的「色源消费者」清单（T49 起旧报表页与其图表组件已下线，改扫统计页的
// 双环卡片：它同样经 `getChartPalette(readThemeTokens())` 取色）。
// 清单过时会让本测试**静默少扫一个文件**（不报错），改清单时请同步本注释。
const donutRankSource = readFileSync(
  fileURLToPath(new URL('../components/stats/DonutRankCard.vue', import.meta.url)),
  'utf8',
)

/** 截取 :root 规则体并解析为 Map<变量名, 值>。 */
function rootDeclarations(): Map<string, string> {
  const body = /:root\s*\{([\s\S]*?)\}/.exec(tokensCss)?.[1] ?? ''
  const result = new Map<string, string>()
  const pattern = /(--[\w-]+)\s*:\s*([^;]+);/g
  let match = pattern.exec(body)
  while (match !== null) {
    result.set(match[1] ?? '', (match[2] ?? '').trim())
    match = pattern.exec(body)
  }
  return result
}

/** 解析 #rrggbb；解析失败直接抛错，避免对比度测试假绿。 */
function parseHex(value: string): Rgb {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim())
  if (match === null) {
    throw new Error(`无法解析颜色值：${value}`)
  }
  const digits = match[1] ?? ''
  return {
    r: Number.parseInt(digits.slice(0, 2), 16),
    g: Number.parseInt(digits.slice(2, 4), 16),
    b: Number.parseInt(digits.slice(4, 6), 16),
  }
}

/** WCAG 2.1 相对亮度。 */
function luminance(color: Rgb): number {
  const channel = (value: number): number => {
    const normalized = value / 255
    return normalized <= 0.03928
      ? normalized / 12.92
      : Math.pow((normalized + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

/** 两个不透明色的对比度。 */
function contrast(foreground: string, background: string): number {
  const first = luminance(parseHex(foreground))
  const second = luminance(parseHex(background))
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

/** 饼图十色顺序：与 getChartPalette().pie 一一对应（B1 由 6 档扩到 10 档）。 */
const PIE_KEYS = [
  'blue',
  'green',
  'warn',
  'chart4',
  'danger',
  'chart6',
  'chart7',
  'chart8',
  'chart9',
  'chart10',
] as const

describe('阶段 3 图表暖色：单一色源与纸底对比度', () => {
  it('chart4 / chart6 在 CSS token、JS 兜底与 golden 三处逐字一致', () => {
    const cssTokens = rootDeclarations()
    expect(cssTokens.get('--fb-chart-4')).toBe(goldenTokens.chart4)
    expect(cssTokens.get('--fb-chart-6')).toBe(goldenTokens.chart6)
    expect(DEFAULT_TOKENS.chart4).toBe(goldenTokens.chart4)
    expect(DEFAULT_TOKENS.chart6).toBe(goldenTokens.chart6)
  })

  it('十色饼图在纸底上的图形对比度全部 ≥ 3.0:1', () => {
    const paper = rootDeclarations().get('--fb-card') ?? ''
    expect(paper).not.toBe('')
    const ratios = PIE_KEYS.map((key) => ({
      key,
      ratio: contrast(goldenTokens[key], paper),
    }))
    for (const item of ratios) {
      expect(item.ratio, `${item.key} on --fb-card`).toBeGreaterThanOrEqual(3.0)
    }
    // fog-cyan 是阶段 3 换暖的重点：由旧冷色的 2.68:1 提升到 3.73:1。
    // 用按键查找而不是「取数组最后一个」——扩色后顺序变了，脆弱断言会假红。
    const chart6 = ratios.find((item) => item.key === 'chart6')
    expect(chart6?.ratio.toFixed(2)).toBe('3.73')
  })

  it('Canvas 调色板与 DOM 图例共用同一组 token，无组件色值副本', () => {
    // 断子串而不是整行：pie 已改为多行数组（10 档可读性更好），
    // 但「每一档都从 token 取名、不自造色值」这个意图必须保留。
    for (const token of ['chart4', 'chart6', 'chart7', 'chart8', 'chart9', 'chart10']) {
      expect(themeTokensSource).toContain(`tokens.${token}`)
    }
    // 守卫迁移（T49）：旧报表页下线后，「CSS 变量 → Canvas 调色板」这个唯一入口
    // 由统计页的双环卡片承接，断言随之改指向它 —— 是迁移而非取消。
    expect(donutRankSource).toContain('getChartPalette(readThemeTokens())')
    expect(donutRankSource).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})
