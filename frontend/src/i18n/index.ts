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
 * 兼容约束：不用 .at() / structuredClone 等 Safari 14.1 缺失的 API。
 */
import { ref, type Ref } from 'vue'

import { en } from './en'
import { zhCN, type MessageKey } from './zh-CN'

/** 支持的语言代码。 */
export type Locale = 'zh-CN' | 'en'

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
  en,
}

/** 当前语言（模块单例；初始值恒为字面默认，不读存储、不做检测）。 */
const locale: Ref<Locale> = ref<Locale>('zh-CN')

/**
 * 翻译函数：读当前语言字典 → 缺 key 回退 zh-CN 字典 → 仍缺返回 key 本身。
 *
 * @param key 消息键（MessageKey 由 zh-CN 字典推导）
 * @param params 插值参数（{name} → params.name）；缺失的参数保留 {name} 原样
 * @returns 译文（运行时双字典都缺 key 时返回 key 本身，便于上线前发现漏翻）
 */
export function t(key: MessageKey, params?: Record<string, string>): string {
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
}

export { locale }
