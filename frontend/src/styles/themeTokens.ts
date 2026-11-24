/**
 * CSS token → JS 的唯一读桥（全站纸质暖色迁移 · 阶段 0）。
 *
 * Canvas 2D 绘制读不到 CSS 变量，因此图表组件统一从这里取色（经 getChartPalette）。
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
  chart7: string
  chart8: string
  chart9: string
  chart10: string
}

/** 报表 Canvas 绘制使用的调色板。 */
export interface ChartPalette {
  grid: string
  ink: string
  inkDeep: string
  expense: string
  income: string
  /**
   * 品牌墨绿（`--fb-blue`，历史变量名，纸感主题下语义=墨绿）。
   *
   * 资产趋势「总资产」线专用：设计稿 `assets/app.js:1212` 用 `--accent`。
   * 与 `expense` 区分开 —— `expense` 是旧报表口径（= blue），账单页的「支出」线
   * 必须用 `danger`，两者不可互相顶替。
   */
  brand: string
  /** 警示暖金（`--fb-warn`，= 设计稿 `--accent2`）：资产趋势「净资产」线。 */
  warn: string
  /** 危险红（`--fb-danger`）：支出折线 / 分类柱支出方向 / 「总负债」线。 */
  danger: string
  /** 分类色，固定 10 档顺序；由 `pickColor` 取用，禁止调用方自行取模。 */
  pie: [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ]
}

/**
 * 模块内唯一允许的 JS 色值字面量，仅当 CSS 变量读不到时兜底（jsdom / SSR / 样式未注入）。
 *
 * 阶段 1 全站纸质暖色迁移：语义色兜底值已同步为 tokens.css :root 的暖纸值。
 * 阶段 3 图表暖色化：chart4 / chart6 也已由遗留冷色换为暖褐 / 雾青，
 * 与 tokens.css 及 scripts/theme-tokens.golden.json 逐字一致；浏览器正常路径
 * 始终读 CSS 变量（单一色源），本对象只在 jsdom / SSR 等无 CSS 环境兜底。
 */
export const DEFAULT_TOKENS: Readonly<ThemeTokens> = Object.freeze({
  card: '#fdfbf4',
  ink: '#242b26',
  sub: '#5f5b50',
  line: '#ded7c6',
  blue: '#2f5d4e',
  green: '#3f7d5c',
  warn: '#c8811e',
  danger: '#b4463c',
  chart4: '#8a6d4f',
  chart6: '#5c8a86',
  chart7: '#6e7f5a',
  chart8: '#7b5a86',
  chart9: '#4a7b95',
  chart10: '#a05d4a',
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
    chart7: withFallback(readVar('--fb-chart-7'), DEFAULT_TOKENS.chart7),
    chart8: withFallback(readVar('--fb-chart-8'), DEFAULT_TOKENS.chart8),
    chart9: withFallback(readVar('--fb-chart-9'), DEFAULT_TOKENS.chart9),
    chart10: withFallback(readVar('--fb-chart-10'), DEFAULT_TOKENS.chart10),
  }
}

/**
 * 把 CSS token 映射成 Canvas 绘制用的调色板。
 *
 * inkDeep 为饼图中心主标题色（--fb-ink），ink 为坐标轴/副标题色（--fb-sub）；
 * 两者均从 CSS token 读取，阶段 1 起随暖纸主题自动变化。
 *
 * 语义色三兄弟（**不要在组件里直接给 ECharts 传 `'var(--fb-*)'` 字符串**：
 * ECharts 的 SVG renderer 会把颜色写进 `stroke` / `fill` **表现属性**，
 * 而 `var()` 在 SVG 表现属性上的解析在 Safari 14 / iOS 14 基线不可靠，
 * 可能退化为默认黑或透明。设计稿 `charts.js:18-33` 也是先 `cssVar()` 取实色再传）：
 * - `expense`  = blue（旧报表口径，勿动：`themeTokens.test.ts` 锚定）
 * - `brand`    = blue（资产趋势「总资产」）
 * - `warn`     = warn（资产趋势「净资产」，设计刻意用暖金标「答案线」）
 * - `danger`   = danger（账单「支出」折线 / 分类柱支出 / 「总负债」）
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
    brand: tokens.blue,
    warn: tokens.warn,
    danger: tokens.danger,
    pie: [
      tokens.blue,
      tokens.green,
      tokens.warn,
      tokens.chart4,
      tokens.danger,
      tokens.chart6,
      tokens.chart7,
      tokens.chart8,
      tokens.chart9,
      tokens.chart10,
    ],
  }
}

/** 深色模式重绘信号：useTheme 偏好切换 / 系统暗色变化经 refreshThemeTokens() 递增。 */
export const themeEpoch = ref<number>(0)

/**
 * 按索引取分类色，相邻同色自动顺延一档。
 *
 * 为什么需要：10 档色遇到 11 个分类时，第 11 个必然回落到 `pie[0]`。
 * 如果它正好与第 10 个相邻就出现「两块同色贴在一起」，下钻时无法确认
 * 点的是哪一块。顺延一档把「相邻撞色」降成「不相邻重复」，视觉上可接受。
 *
 * @param palette `getChartPalette().pie`
 * @param index 分类序号
 * @param previous 上一个分类实际用的颜色（用于判相邻）
 */
export function pickColor(
  palette: readonly string[],
  index: number,
  previous?: string,
): string {
  const size = palette.length
  if (size === 0) return 'currentColor'
  let slot = ((index % size) + size) % size
  let color = palette[slot]
  if (previous !== undefined && color === previous) {
    slot = (slot + 1) % size
    color = palette[slot]
  }
  return color
}

/**
 * 主题持久化键与 PWA theme-color（阶段 4）。
 * 与色值相关的字面量只允许放在本文件或 tokens.css（主题护栏白名单）。
 */
export const THEME_STORAGE_KEY = 'fambean.theme'
/**
 * 主题偏好持久化键（三态：system / light / dark）。
 * 旧键 THEME_STORAGE_KEY 仅作一次性迁移读取（night→dark、paper→light），不再写入。
 */
export const THEME_MODE_STORAGE_KEY = 'fambean.theme.mode'
export const THEME_COLOR_PAPER = '#20352c'
export const THEME_COLOR_NIGHT = '#121512'

/**
 * 刷新 token 并递增重绘信号。
 *
 * @returns 当前 token 对象
 */
export function refreshThemeTokens(): ThemeTokens {
  themeEpoch.value += 1
  return readThemeTokens()
}
