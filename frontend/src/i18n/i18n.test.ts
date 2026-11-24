// @vitest-environment jsdom
/**
 * i18n 阶段 0 试点套件：
 * - 字典完整性：zh/en 键集合恒等、无空 value、占位符集合恒等、LOCALES 注册表；
 * - t()：回退链（en 缺 key → zh-CN → key 本身）、插值 {name} 与参数缺失保留；
 * - setLocale：持久化与 document.title / documentElement.lang 联动、写失败静默；
 * - initLocale：检测矩阵（localStorage 优先 / navigator 检测 / 非法值 / 异常兜底）；
 * - 试点三文件语言切换响应（navItems / StateCard / LoginView，含「刷新后 en」
 *   生产时序回归：navItems 静态 import 先于 initLocale 求值 + label 访问时求值）。
 *
 * 「既有测试断言零破坏」的前提是「t() 在测试环境默认 zh-CN 输出原文」——
 * vitest 同一文件内共享模块单例，所以每个响应式用例结束后必须复位 locale
 * （resetTestLocale），否则会污染后续用例。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import StateCard from '@/components/shell/StateCard.vue'
// 静态 import navItems：复刻生产 import 链——navItems 的模块求值早于 initLocale()。
// label 是 getter（访问时求值），故模块求值顺序无关紧要，访问时机才决定输出。
import { MOBILE_TABS, NAV_MAIN, NAV_MANAGE } from '@/components/shell/navItems'
import LoginView from '@/views/LoginView.vue'

import { en } from './en'
import { LOCALES, LOCALE_STORAGE_KEY, initLocale, locale, setLocale, t } from './index'
import { zhCN, type MessageKey } from './zh-CN'

// LoginView 依赖（与 LoginView.batch3.test.ts 同口径）：i18n 核心用例不依赖这些模块。
vi.mock('@/api/client', () => ({
  authApi: { register: vi.fn().mockResolvedValue({ token: '', user: {} }) },
  settingsApi: { registration: vi.fn().mockResolvedValue({ enabled: true }) },
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    mustChangePassword: false,
    needsInvite: false,
    login: vi.fn().mockResolvedValue(undefined),
    bootstrap: vi.fn().mockResolvedValue(true),
  }),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useRoute: () => ({ query: {} }),
}))

/** 复位语言单例与 DOM / 存储副作用（响应式用例后必须调用，见文件头说明）。 */
function resetTestLocale(): void {
  locale.value = 'zh-CN'
  localStorage.removeItem(LOCALE_STORAGE_KEY)
  document.title = ''
  document.documentElement.lang = ''
}

/** 提取字符串中所有 {name} 占位符名（仅测试用；实现侧不得改用后行断言）。 */
function placeholderNames(text: string): string[] {
  return Array.from(text.matchAll(/\{(\w+)\}/g), (match) => match[1] as string)
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  resetTestLocale()
  vi.unstubAllGlobals()
})

describe('i18n 字典完整性', () => {
  it('zh 与 en 的键集合恒等（en 按 Record<MessageKey, string> 补齐）', () => {
    const zhKeys = Object.keys(zhCN).sort()
    const enKeys = Object.keys(en).sort()
    expect(enKeys).toEqual(zhKeys)
    expect(zhKeys.length).toBeGreaterThan(0)
  })

  it('两字典均无空 value（含纯空白）', () => {
    for (const key of Object.keys(zhCN) as MessageKey[]) {
      expect((zhCN as Record<string, string>)[key].trim().length).toBeGreaterThan(0)
      expect(en[key].trim().length).toBeGreaterThan(0)
    }
  })

  it('每条消息的占位符集合在两语言间恒等', () => {
    for (const key of Object.keys(zhCN) as MessageKey[]) {
      const zhText = (zhCN as Record<string, string>)[key]
      expect(placeholderNames(en[key]).sort()).toEqual(placeholderNames(zhText).sort())
    }
  })

  it('语言注册表覆盖两种 locale 且自称非空', () => {
    expect(LOCALES.map((item) => item.code)).toEqual(['zh-CN', 'en'])
    for (const item of LOCALES) {
      expect(item.label.trim().length).toBeGreaterThan(0)
    }
  })
})

describe('t()：回退链与插值', () => {
  it('默认 locale 为 zh-CN，输出源语言原文', () => {
    expect(locale.value).toBe('zh-CN')
    expect(t('shell.nav.bills')).toBe('账单')
    expect(t('login.errRequired')).toBe('请输入用户名和密码')
    expect(t('common.loading')).toBe('正在加载…')
  })

  it('setLocale(en) 后输出英文，与 en 字典逐键一致', () => {
    setLocale('en')
    expect(t('shell.nav.bills')).toBe(en['shell.nav.bills'])
    expect(en['shell.nav.bills']).toBe('Bills')
  })

  it('en 运行时缺 key 时回退 zh-CN 字典', () => {
    setLocale('en')
    delete (en as Record<string, string>)['common.retry']
    try {
      expect(t('common.retry')).toBe('重试')
    } finally {
      // 运行时注入必须恢复，否则污染后续键集合断言。
      en['common.retry'] = 'Retry'
    }
  })

  it('双字典都缺 key 时返回 key 本身', () => {
    expect(t('i18n.test.missing' as MessageKey)).toBe('i18n.test.missing')
  })

  it('插值 {name} 生效（en 缺 key 时经 zh-CN 回退后仍插值）', () => {
    setLocale('en')
    ;(zhCN as Record<string, string>)['i18n.test.greet'] = '你好，{name}！'
    try {
      expect(t('i18n.test.greet' as MessageKey, { name: '豆豆' })).toBe('你好，豆豆！')
    } finally {
      delete (zhCN as Record<string, string>)['i18n.test.greet']
    }
  })

  it('参数缺失时 {name} 保留原样', () => {
    ;(zhCN as Record<string, string>)['i18n.test.greet'] = '你好，{name}！'
    try {
      expect(t('i18n.test.greet' as MessageKey)).toBe('你好，{name}！')
    } finally {
      delete (zhCN as Record<string, string>)['i18n.test.greet']
    }
  })
})

describe('setLocale：持久化与 DOM 联动', () => {
  it('切换 en：写 localStorage、documentElement.lang 与英文标题', () => {
    setLocale('en')
    expect(locale.value).toBe('en')
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    expect(document.title).toBe(en['shell.appTitle'])
    expect(document.title).toBe('Family Ledger')
  })

  it('切回 zh-CN：标题回到中文原文（与 index.html 兜底逐字节一致）', () => {
    setLocale('zh-CN')
    expect(document.title).toBe('家庭记账')
    expect(document.documentElement.lang).toBe('zh-CN')
  })

  it('localStorage 写入抛异常时静默，内存态与 DOM 仍生效', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded')
      },
      removeItem: () => {},
    })
    expect(() => setLocale('en')).not.toThrow()
    expect(locale.value).toBe('en')
    expect(document.title).toBe('Family Ledger')
  })
})

describe('initLocale：检测矩阵（生产仅 main.ts 调用，此处显式调用验证）', () => {
  it('localStorage 合法值优先：en 与 zh-CN 均直接生效', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'en')
    initLocale()
    expect(locale.value).toBe('en')
    resetTestLocale()
    localStorage.setItem(LOCALE_STORAGE_KEY, 'zh-CN')
    initLocale()
    expect(locale.value).toBe('zh-CN')
  })

  it('无存储时按 navigator.language 检测：zh 开头 → zh-CN，否则 en', () => {
    vi.stubGlobal('navigator', { language: 'zh-TW' })
    initLocale()
    expect(locale.value).toBe('zh-CN')
    vi.stubGlobal('navigator', { language: 'en-US' })
    initLocale()
    expect(locale.value).toBe('en')
  })

  it('存储值非法（如 fr）视为无值，走 navigator 检测', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'fr')
    vi.stubGlobal('navigator', { language: 'en-US' })
    initLocale()
    expect(locale.value).toBe('en')
  })

  it('localStorage 读取抛异常时兜底 zh-CN，标题同步中文', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage broken')
      },
      setItem: () => {},
      removeItem: () => {},
    })
    initLocale()
    expect(locale.value).toBe('zh-CN')
    expect(document.title).toBe('家庭记账')
  })
})

describe('试点文件语言切换响应', () => {
  it('刷新后 en（生产时序回归）：navItems 经静态 import 先于 initLocale 求值，label 在访问时才调 t() → 英文', () => {
    // 复刻生产刷新时序（QA P2 缺陷回归）：main.ts 的 import 链先求值 navItems
    // （本文件顶部静态 import 同理），随后 initLocale() 读 localStorage 持久值 en，
    // 最后渲染访问 label。getter 形态下求值时机 = 访问时机，「模块求值快照早于
    // initLocale → 刷新后壳层仍中文」的缺陷不再可能。
    localStorage.setItem(LOCALE_STORAGE_KEY, 'en')
    initLocale()
    expect(NAV_MAIN.map((item) => item.label)).toEqual([
      'Bills',
      'Search',
      'Stats',
      'Assets',
      'Asset Stats',
    ])
    expect(NAV_MANAGE[0].label).toBe('Trash')
    expect(MOBILE_TABS[3].label).toBe('More')
  })

  it('navItems label 为访问时求值：不重载模块，切 locale 立即反映（渲染响应式）', () => {
    expect(NAV_MAIN[0].label).toBe('账单')
    setLocale('en')
    expect(NAV_MAIN[0].label).toBe('Bills')
    expect(MOBILE_TABS[3].label).toBe('More')
  })

  it('StateCard：en 下内置四态默认文案为英文', () => {
    setLocale('en')
    const loading = mount(StateCard, { props: { state: 'loading' } })
    expect(loading.text()).toContain('Loading…')
    loading.unmount()
    const error = mount(StateCard, { props: { state: 'error' } })
    expect(error.find('.sc-box__title').text()).toBe('Load failed')
    expect(error.find('.sc-btn').text()).toBe('Retry')
    error.unmount()
    const empty = mount(StateCard, { props: { state: 'empty' } })
    expect(empty.find('.sc-box__title').text()).toBe('No data yet')
    empty.unmount()
  })

  it('LoginView：en 下提交按钮与切换链接为英文', async () => {
    setLocale('en')
    const wrapper = mount(LoginView)
    await flushPromises()
    expect(wrapper.find('.auth__submit').text()).toBe('Sign in')
    expect(wrapper.find('.auth__switch').text()).toBe('No account? Sign up')
    wrapper.unmount()
  })
})
