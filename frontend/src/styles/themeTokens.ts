/**
 * CSS token → JS 的唯一读桥（全站纸质暖色迁移 · 阶段 0）。
 *
 * Canvas 2D 绘制读不到 CSS 变量，因此 ReportCharts 等组件统一从这里取色。
 * 唯一色值字面量集中在 DEFAULT_TOKENS，仅当 getPropertyValue 返回空串时兜底
 * （jsdom / SSR / 样式尚未注入），保证阶段 0 视觉零变化。
 *
 * 兼容约束：不使用 .at() / structuredClone 等 Safari 14.1 / iOS 14 缺失的 API。
 */
import { ref } from 'vue'

/** 与 tokens.css :root 一一对应的强类型 token 集合。 */
export interface ThemeTokens {
  card: string
  ink: string
  sub: string
  line: string
  blue: string
  green: string
  warn: string
  danger: string
  chart4: string
  chart6: string
}

/** 报表 Canvas 绘制使用的调色板。 */
export interface ChartPalette {
  grid: string
  ink: string
  inkDeep: string
  expense: string
  income: string
  pie: [string, string, string, string, string, string]
}

/**
 * 模块内唯一允许的 JS 色值字面量（旧科技蓝值，仅作兜底）。
 * 阶段 3 换暖值时只需改 tokens.css，这里保持旧值以确保 jsdom/SSR 行为稳定。
 */
export const DEFAULT_TOKENS: Readonly<ThemeTokens> = Object.freeze({
  card: '#ffffff',
  ink: '#1a1d1f',
  sub: '#6b7280',
  line: '#e5e7eb',
  blue: '#3b6ef6',
  green: '#2ba471',
  warn: '#e8590c',
  danger: '#d93025',
  chart4: '#8b5cf6',
  chart6: '#0ea5e9',
})

/**
 * 读取根元素上的 CSS 变量值。
 *
 * @param name CSS 变量名，如 '--fb-blue'
 * @returns 去掉首尾空白的变量值；SSR / 无 DOM 环境返回空串
 */
export function readVar(name: string): string {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
    return ''
  }
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/**
 * 空串回退到旧值，避免 jsdom / SSR 下 Canvas 拿到非法颜色。
 *
 * @param raw readVar 的原始结果
 * @param fallback DEFAULT_TOKENS 中的兜底值
 * @returns 实际使用的颜色字符串
 */
function withFallback(raw: string, fallback: string): string {
  return raw.length > 0 ? raw : fallback
}

/**
 * 一次性读取全部图表相关 token。
 *
 * @returns 强类型 token 对象；未注入 CSS 时逐项使用 DEFAULT_TOKENS
 */
export function readThemeTokens(): ThemeTokens {
  return {
    card: withFallback(readVar('--fb-card'), DEFAULT_TOKENS.card),
    ink: withFallback(readVar('--fb-ink'), DEFAULT_TOKENS.ink),
    sub: withFallback(readVar('--fb-sub'), DEFAULT_TOKENS.sub),
    line: withFallback(readVar('--fb-line'), DEFAULT_TOKENS.line),
    blue: withFallback(readVar('--fb-blue'), DEFAULT_TOKENS.blue),
    green: withFallback(readVar('--fb-green'), DEFAULT_TOKENS.green),
    warn: withFallback(readVar('--fb-warn'), DEFAULT_TOKENS.warn),
    danger: withFallback(readVar('--fb-danger'), DEFAULT_TOKENS.danger),
    chart4: withFallback(readVar('--fb-chart-4'), DEFAULT_TOKENS.chart4),
    chart6: withFallback(readVar('--fb-chart-6'), DEFAULT_TOKENS.chart6),
  }
}

/**
 * 把 CSS token 映射成 Canvas 绘制用的调色板。
 *
 * inkDeep 为饼图中心主标题色（原 #1a1d1f = --fb-ink），
 * ink 为坐标轴/副标题色（原 #6b7280 = --fb-sub）；阶段 0 必须逐像素保持旧值。
 *
 * @param tokens readThemeTokens() 的结果
 * @returns Canvas 调色板
 */
export function getChartPalette(tokens: ThemeTokens): ChartPalette {
  return {
    grid: tokens.line,
    ink: tokens.sub,
    inkDeep: tokens.ink,
    expense: tokens.blue,
    income: tokens.green,
    pie: [tokens.blue, tokens.green, tokens.warn, tokens.chart4, tokens.danger, tokens.chart6],
  }
}

/** 阶段 4 深色模式重绘信号；本次只定义，不接切换 UI。 */
export const themeEpoch = ref<number>(0)

/**
 * 刷新 token 并递增重绘信号。
 *
 * @returns 当前 token 对象
 */
export function refreshThemeTokens(): ThemeTokens {
  themeEpoch.value += 1
  return readThemeTokens()
}
