/**
 * i18n 语言模块（阶段 0 试点）——模块单例，架构复刻 composables/useTheme.ts：
 *
 * - **locale 初始值是模块级字面默认 'zh-CN'**：语言检测只允许出现在 initLocale()
 *   （仅 main.ts 调用）。测试环境永不调用 initLocale，t() 恒走 zh-CN，
 *   这是「既有断言逐字节搬运零破坏」承诺的基石（shellNav.test.ts 等在 node
 *   测试环境拿到的 label 与抽取前完全一致）；
 * - t(key, params) 在无组件上下文也可用（不 inject/provide），模板与 computed
 *   内调用自动响应 locale.value 变化；
 * - setLocale 全站立即生效：写 locale + localStorage（try-catch 静默）+
 *   document.documentElement.lang + document.title。index.html 的中文 <title>
 *   是 JS 未执行兜底，本阶段刻意不修改 index.html（语言切换入口推迟到阶段 1）；
 * - 回退链：当前 locale 字典缺 key → zh-CN 字典 → 仍缺返回 key 本身；
 * - 插值只支持 {name}：Safari 16.4 才支持正则 lookbehind——实现只用
 *   /\{(\w+)\}/g 捕获组 + String.replace，禁止改成后行断言写法；
 * - 阶段 0 无复数机制、无日期本地化、不做 manifest / apple-title 国际化。
 *
 * 英文字典的搬出（体积优化）：
 * - 门禁只统计 dist/assets/*.js 的 gzip，懒 chunk 仍在 assets 下照样计入，
 *   所以 en 必须完全脱离 JS 产物：构建期由 scripts/generate-en-dict.mjs 从
 *   en.ts 生成 public/i18n/en.json，生产运行时 fetch 填充字典；
 * - `import.meta.env.MODE` 在 vite build 时被字面替换为 "production"，Rollup
 *   随即把 `USE_BUNDLED_EN ? en : {}` 折叠为 `{}` 并 tree-shake 掉整个 en 模块
 *   （en.ts 无副作用）。vitest 下 MODE === 'test'，静态 en 直接装入同一对象，
 *   6 个既有测试文件的 `setLocale('en')` 同步断言与 mutate 用例完全不变；
 * - 异步字典未就绪时 dictionaries.en 为空，t() 逐 key 回退 zh-CN；加载完成后
 *   dictionaryEpoch 自增，t() 读取它登记响应式依赖，全站同步重渲染为英文。
 *
 * 兼容约束：不用 .at() / structuredClone / 正则 lookbehind 等 Safari 14.1 缺失 API。
 */
import { ref, type Ref } from 'vue'

import { en } from './en'
import { zhCN, type MessageKey } from './zh-CN'

/** 支持的语言代码。 */
export type Locale = 'zh-CN' | 'en'

/**
 * 测试环境用静态 en 字典、生产环境用 public/i18n/en.json。
 *
 * 必须是 `import.meta.env.MODE`（Vite 构建期字面替换），不能用运行时全局判断：
 * 只有编译期常量才能让 Rollup 把 en 模块从生产产物里彻底删除。
 */
const USE_BUNDLED_EN: boolean = import.meta.env.MODE === 'test'

/** 语言注册表条目（阶段 1 的语言切换入口直接消费）。 */
export interface LocaleOption {
  /** 语言代码。 */
  code: Locale
  /** 语言自称（始终以该语言自身书写，不做翻译）。 */
  label: string
}

/** 语言注册表：顺序即阶段 1 切换入口的展示顺序。 */
export const LOCALES: LocaleOption[] = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'en', label: 'English' },
]

/** 语言偏好持久化键（localStorage；fambean.* 命名空间与主题键口径一致）。 */
export const LOCALE_STORAGE_KEY = 'fambean.locale'

/** 两语言字典注册表；zh-CN 同时是回退兜底字典。 */
const dictionaries: Record<Locale, Record<string, string>> = {
  'zh-CN': zhCN,
  // 生产初始为空：未加载完成时 t() 自动回退 zh-CN；测试仍拿到原始 en 对象。
  en: USE_BUNDLED_EN ? en : {},
}

/** 当前语言（模块单例；初始值恒为字面默认，不读存储、不做检测）。 */
const locale: Ref<Locale> = ref<Locale>('zh-CN')

/**
 * 字典版本号：t() 每次读取它登记 Vue 响应式依赖；英文字典异步填充后自增，
 * 让所有正在渲染的 t() 调用点重算。与 locale.value 分离，避免把「加载完成」
 * 误写成「切换语言」。
 */
const dictionaryEpoch: Ref<number> = ref<number>(0)

/**
 * 并发去重：多次 setLocale('en') / initLocale() 只发一次请求。
 * 失败后清空，允许下次切换语言重试（失败期间保持 zh-CN 回退）。
 */
let enLoadPromise: Promise<boolean> | null = null

/**
 * 判断未知值是否为「key → 字符串」的平层字典。
 *
 * @param value 待校验值
 * @returns 是否为字符串字典
 */
function isStringDictionary(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (typeof record[key] !== 'string') return false
  }
  return true
}

/**
 * 把外部英文字典装入注册表并广播响应式更新。导出供生产加载器与测试共用，
 * 测试可直接注入构造好的字典验证 t() 的同步行为。
 *
 * @param payload 外部字典（JSON.parse 结果）
 * @returns 是否成功装入；空字典 / 非法结构直接拒绝，保持 zh-CN 回退
 */
export function installEnDictionary(payload: unknown): boolean {
  if (!isStringDictionary(payload)) return false
  if (Object.keys(payload).length === 0) return false
  dictionaries.en = payload
  dictionaryEpoch.value += 1
  // 首屏切 en 时 title 是同步写的（那时字典还没到），加载完成后补写一次。
  if (locale.value === 'en' && typeof document !== 'undefined') {
    document.documentElement.lang = 'en'
    document.title = t('shell.appTitle')
  }
  return true
}

/**
 * 生产加载路径：fetch public/i18n/en.json → 校验 → 装入字典。
 *
 * 用 document.baseURI 解析相对地址，兼容部署在任意子路径与 hash 路由
 * （hash 不参与相对 URL 解析，无需手工拼 location.pathname）。
 * fetcher 可注入，测试无需真实网络即可覆盖成功 / 失败两条分支。
 *
 * @param fetcher 可注入的 fetch 实现，默认全局 fetch
 * @returns 字典是否就绪；任何异常都吞掉并返回 false（回退 zh-CN）
 */
export async function fetchEnDictionary(
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  try {
    if (typeof fetcher !== 'function' || typeof document === 'undefined') return false
    const url = new URL('i18n/en.json', document.baseURI).toString()
    const response = await fetcher(url, { cache: 'force-cache' })
    if (!response.ok) return false
    const payload: unknown = await response.json()
    return installEnDictionary(payload)
  } catch {
    // 网络错误 / JSON 损坏 / 结构非法：字典保持为空，t() 逐 key 回退 zh-CN。
    return false
  }
}

/**
 * 确保英文字典就绪（幂等）。测试环境静态字典已就位，直接返回 true，不发请求。
 *
 * @returns Promise<boolean> 字典是否可用
 */
export function ensureEnDictionary(): Promise<boolean> {
  if (USE_BUNDLED_EN || Object.keys(dictionaries.en).length > 0) {
    return Promise.resolve(true)
  }
  if (enLoadPromise !== null) return enLoadPromise
  const pending = fetchEnDictionary().then((ready: boolean): boolean => {
    if (!ready) enLoadPromise = null
    return ready
  })
  enLoadPromise = pending
  return pending
}

/**
 * 翻译函数：读当前语言字典 → 缺 key 回退 zh-CN 字典 → 仍缺返回 key 本身。
 *
 * @param key 消息键（MessageKey 由 zh-CN 字典推导）
 * @param params 插值参数（{name} → params.name）；缺失的参数保留 {name} 原样
 * @returns 译文（运行时双字典都缺 key 时返回 key 本身，便于上线前发现漏翻）
 */
export function t(key: MessageKey, params?: Record<string, string>): string {
  // 登记响应式依赖：英文字典异步填充后所有调用点重算（不改变同步返回语义）。
  void dictionaryEpoch.value
  let text: string | undefined = dictionaries[locale.value][key]
  if (text === undefined) {
    text = (zhCN as Record<string, string>)[key]
  }
  if (text === undefined) {
    // 双字典都缺：类型上不应发生，属于运行时兜底。
    return key
  }
  if (params !== undefined) {
    // Safari 16.4 才支持 lookbehind——只用捕获组 + replace，勿改后行断言写法。
    text = text.replace(/\{(\w+)\}/g, (whole: string, name: string): string => {
      const value = params[name]
      return value === undefined ? whole : value
    })
  }
  return text
}

/**
 * 切换语言并全站立即生效：写 locale + 持久化 + documentElement.lang + document.title。
 * localStorage 写失败（隐私模式 / 配额受限）静默，内存态仍生效（同 useTheme 口径）。
 *
 * @param next 目标语言
 */
export function setLocale(next: Locale): void {
  locale.value = next
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next)
    } catch {
      // 静默失败：本次会话内的语言切换仍可用。
    }
  }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = next
    document.title = t('shell.appTitle')
  }
  if (next === 'en') {
    // 同步切语言：字典未就绪期间 t() 回退 zh-CN，加载完成后由 epoch 触发重渲染。
    void ensureEnDictionary()
  }
}

/**
 * 应用启动时的语言初始化（**仅 main.ts 调用**）：
 * localStorage 合法持久值 → navigator.language 检测（zh 开头 → zh-CN，否则 en）
 * → 任何异常一律兜底 zh-CN。非法存储值视为「无值」走检测。
 * 检测只在这里发生：locale 的模块初始值恒为 'zh-CN'，测试环境永不调用本函数。
 */
export function initLocale(): void {
  let detected: Locale = 'zh-CN'
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(LOCALE_STORAGE_KEY)
      if (stored === 'zh-CN' || stored === 'en') {
        detected = stored
      } else if (typeof navigator !== 'undefined') {
        // 无存储（或非法值）：按浏览器语言检测；zh 开头 → 简体中文，否则英文。
        const lang = typeof navigator.language === 'string' ? navigator.language : ''
        detected = lang.startsWith('zh') ? 'zh-CN' : 'en'
      }
    }
  } catch {
    detected = 'zh-CN'
  }
  locale.value = detected
  if (typeof document !== 'undefined') {
    document.documentElement.lang = detected
    document.title = t('shell.appTitle')
  }
  if (detected === 'en') {
    // 刷新后持久值 en：首屏先中文回退，字典到达后自动替换为英文。
    void ensureEnDictionary()
  }
}

export { locale }
