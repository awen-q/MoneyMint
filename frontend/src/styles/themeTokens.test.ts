// @vitest-environment jsdom
/**
 * themeTokens 读桥单测：映射关系 + DEFAULT_TOKENS 兜底（jsdom 环境）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

// Golden 放在 scripts/（非 .ts/.vue/.css），既避开主题护栏扫描，
// 又不进入护栏白名单；JSON import 由 tsconfig 的 resolveJsonModule 支持。
import goldenTokens from '../../scripts/theme-tokens.golden.json'
import {
  DEFAULT_TOKENS,
  getChartPalette,
  readThemeTokens,
  readVar,
  refreshThemeTokens,
  themeEpoch,
} from './themeTokens'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('themeTokens：CSS token → JS 读桥', () => {
  it('getChartPalette 按约定映射 token', () => {
    const palette = getChartPalette(DEFAULT_TOKENS)
    expect(palette.grid).toBe(DEFAULT_TOKENS.line)
    expect(palette.ink).toBe(DEFAULT_TOKENS.sub)
    expect(palette.inkDeep).toBe(DEFAULT_TOKENS.ink)
    expect(palette.expense).toBe(DEFAULT_TOKENS.blue)
    expect(palette.income).toBe(DEFAULT_TOKENS.green)
    expect(palette.pie).toEqual([
      DEFAULT_TOKENS.blue,
      DEFAULT_TOKENS.green,
      DEFAULT_TOKENS.warn,
      DEFAULT_TOKENS.chart4,
      DEFAULT_TOKENS.danger,
      DEFAULT_TOKENS.chart6,
    ])
  })

  it('getPropertyValue 返回空串时逐项用 DEFAULT_TOKENS 兜底', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: () => '',
    } as unknown as CSSStyleDeclaration)
    expect(readVar('--fb-blue')).toBe('')
    expect(readThemeTokens()).toEqual({ ...DEFAULT_TOKENS })
  })

  it('readVar trim 变量值，未提供的变量走兜底', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: (name: string) => (name === '--fb-blue' ? '  bridge-value  ' : ''),
    } as unknown as CSSStyleDeclaration)
    expect(readVar('--fb-blue')).toBe('bridge-value')
    const tokens = readThemeTokens()
    expect(tokens.blue).toBe('bridge-value')
    expect(tokens.green).toBe(DEFAULT_TOKENS.green)
  })

  it('refreshThemeTokens 递增 themeEpoch 并返回当前 token', () => {
    const before = themeEpoch.value
    const tokens = refreshThemeTokens()
    expect(themeEpoch.value).toBe(before + 1)
    expect(tokens).toEqual(DEFAULT_TOKENS)
  })
})

describe('DEFAULT_TOKENS golden 锚定：兜底色值防变异', () => {
  it('golden 与 DEFAULT_TOKENS 的 key 集合完全相等（不多不少）', () => {
    const actualKeys = Object.keys(DEFAULT_TOKENS).sort()
    const goldenKeys = Object.keys(goldenTokens).sort()
    expect(goldenKeys).toEqual(actualKeys)
  })

  it('逐 key 断言 DEFAULT_TOKENS 等于 golden 期望值', () => {
    const keys = Object.keys(goldenTokens) as Array<keyof typeof DEFAULT_TOKENS>
    for (const key of keys) {
      expect(DEFAULT_TOKENS[key], `DEFAULT_TOKENS.${key}`).toBe(goldenTokens[key])
    }
  })

  it('jsdom 无 CSS 变量时实际兜底结果等于 golden', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: () => '',
    } as unknown as CSSStyleDeclaration)
    expect(readThemeTokens()).toEqual({ ...goldenTokens })
  })
})
