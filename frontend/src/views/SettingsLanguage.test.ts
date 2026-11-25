// @vitest-environment jsdom
/**
 * 设置页语言切换入口（i18n 阶段 1）：
 * - 语言行用 bilingual 标签，右侧显示当前语言自称（简体中文 / English）；
 * - 点击弹出 SelectSheet，选项来自 LOCALES 注册表，当前项高亮 aria-current；
 * - 选中 English → setLocale 立即生效（locale / documentElement.lang），弹层关闭；
 * - 语言名本身不翻译：en 下选项仍是「简体中文 / English」。
 *
 * 测试环境默认 locale 为 zh-CN；凡是切过语言的用例，afterEach 必须复位，
 * 否则会污染同文件后续用例与其它文件。
 */
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LOCALE_STORAGE_KEY, LOCALES, locale, setLocale } from '@/i18n'

import SettingsView from './SettingsView.vue'

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useRoute: () => ({ query: {}, params: {} }),
}))

vi.mock('@/api/client', () => ({
  accountApi: { list: vi.fn().mockResolvedValue({ accounts: [] }) },
  settingsApi: {
    registration: vi.fn().mockResolvedValue({ enabled: true }),
    setRegistration: vi.fn().mockResolvedValue({ enabled: true }),
  },
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    ledgerId: 7,
    ledgerName: '家用账本',
    ledgers: [{ id: 7, role: 'owner' }],
    user: { id: 1, username: 'boss', display_name: '老板', role: 'owner', is_admin: true },
    logout: vi.fn().mockResolvedValue(undefined),
  }),
}))

/** 读出语言设置行（按 bilingual 标签定位，不依赖 DOM 顺序）。 */
function languageRow(wrapper: VueWrapper) {
  const row = wrapper
    .findAll('.set__link')
    .find((node) => node.text().indexOf('语言') >= 0 || node.text().indexOf('Language') >= 0)
  if (row === undefined) {
    throw new Error('未找到语言设置行')
  }
  return row
}

/** 打开语言选择弹层并返回选项按钮。 */
async function openLanguageSheet(wrapper: VueWrapper) {
  await languageRow(wrapper).trigger('click')
  await flushPromises()
  return wrapper.findAll('.set__lang-row')
}

/** 选项展示名（只取名称 span，避开当前项右侧的对勾符号）。 */
function optionLabels(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.set__lang-name').map((node) => node.text())
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  ;(window as unknown as { matchMedia: unknown }).matchMedia = undefined
  // SelectSheet 关闭时会 scrollTo 还原滚动位置；jsdom 未实现，桩掉避免噪音。
  Object.defineProperty(window, 'scrollY', { value: 0, writable: true, configurable: true })
  Object.defineProperty(window, 'scrollTo', { value: vi.fn(), writable: true, configurable: true })
})

afterEach(() => {
  // 复位语言单例与 DOM / 存储副作用（见文件头说明）。
  locale.value = 'zh-CN'
  localStorage.removeItem(LOCALE_STORAGE_KEY)
  document.documentElement.lang = ''
  document.title = ''
  vi.restoreAllMocks()
})

describe('设置页语言行', () => {
  it('显示 bilingual 标签与当前语言自称', async () => {
    const wrapper = mount(SettingsView, { global: { stubs: { AppVersionCard: true } } })
    await flushPromises()
    const text = languageRow(wrapper).text()
    expect(text).toContain('语言 / Language')
    expect(text).toContain('简体中文')
    wrapper.unmount()
  })

  it('点开语言行 → 弹层列出 LOCALES 全部选项，当前项高亮', async () => {
    const wrapper = mount(SettingsView, { global: { stubs: { AppVersionCard: true } } })
    await flushPromises()
    const rows = await openLanguageSheet(wrapper)

    const dialog = wrapper.find('[role="dialog"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.attributes('aria-label')).toBe('选择语言')
    expect(optionLabels(wrapper)).toEqual(LOCALES.map((item) => item.label))
    expect(rows[0].classes()).toContain('set__lang-row--on')
    expect(rows[0].attributes('aria-current')).toBe('true')
    expect(rows[1].classes()).not.toContain('set__lang-row--on')
    expect(rows[1].attributes('aria-current')).toBeUndefined()
    wrapper.unmount()
  })
})

describe('设置页语言切换', () => {
  it('选 English → 全站切英文并关闭弹层', async () => {
    const wrapper = mount(SettingsView, { global: { stubs: { AppVersionCard: true } } })
    await flushPromises()
    const rows = await openLanguageSheet(wrapper)
    await rows[1].trigger('click')
    await flushPromises()

    expect(locale.value).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    // 弹层已关闭：role=dialog 从 DOM 移除
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    // 语言行标签随 locale 切换为英文版 bilingual 写法，自称显示 English
    const text = languageRow(wrapper).text()
    expect(text).toContain('Language / 语言')
    expect(text).toContain('English')
    wrapper.unmount()
  })

  it('语言名本身不翻译：en 下选项仍是「简体中文 / English」', async () => {
    setLocale('en')
    const wrapper = mount(SettingsView, { global: { stubs: { AppVersionCard: true } } })
    await flushPromises()
    const rows = await openLanguageSheet(wrapper)
    expect(rows).toHaveLength(2)
    expect(optionLabels(wrapper)).toEqual(['简体中文', 'English'])
    wrapper.unmount()
  })
})
