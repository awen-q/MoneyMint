// @vitest-environment jsdom
/**
 * 设置页「外观」卡片（主题三态）：radiogroup 三段选择 + 跟随系统态生效说明。
 *
 * 使用**真实** useTheme 模块（module 单例）：通过公开 API setThemePreference 控制
 * 状态、断言 DOM / localStorage 效果，不 mock 组合式函数本身；matchMedia 在
 * beforeEach 统一移除、按用例显式安装，保证「生效：夜纸 / 浅纸」的说明可控。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

import { setThemePreference, themePreference } from '@/composables/useTheme'
import { THEME_MODE_STORAGE_KEY } from '@/styles/themeTokens'

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
  }),
}))

/** 系统暗色监听回调的事件形态（只关心 matches）。 */
type MediaListener = (event: { matches: boolean }) => void

/** 安装可控 matchMedia（仅现代监听 API，够本文件用），返回触发器。 */
function installSystemDark(initialMatches: boolean): { emit(next: boolean): void } {
  const listeners: MediaListener[] = []
  const media = {
    matches: initialMatches,
    addEventListener: (type: string, listener: MediaListener): void => {
      if (type === 'change') {
        listeners.push(listener)
      }
    },
    removeEventListener: (type: string, listener: MediaListener): void => {
      if (type !== 'change') {
        return
      }
      const index = listeners.indexOf(listener)
      if (index >= 0) {
        listeners.splice(index, 1)
      }
    },
  }
  ;(window as unknown as { matchMedia: unknown }).matchMedia = vi.fn(
    () => media as unknown as MediaQueryList,
  )
  return {
    emit(next: boolean): void {
      media.matches = next
      for (const listener of listeners.slice()) {
        listener({ matches: next })
      }
    },
  }
}

function mountView(): VueWrapper {
  return mount(SettingsView, { global: { stubs: { AppVersionCard: true } } })
}

function appearanceRadios(wrapper: VueWrapper) {
  return wrapper.findAll('[role="radiogroup"] [role="radio"]')
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  // 统一移除 matchMedia：需要系统暗色值的用例显式 installSystemDark。
  ;(window as unknown as { matchMedia: unknown }).matchMedia = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('设置页外观卡片：三段偏好选择', () => {
  it('radiogroup 语义渲染三段选项，高亮当前偏好', async () => {
    setThemePreference('light')
    const wrapper = mountView()
    await flushPromises()
    const group = wrapper.find('[role="radiogroup"]')
    expect(group.attributes('aria-label')).toBe('外观主题')
    const radios = appearanceRadios(wrapper)
    expect(radios).toHaveLength(3)
    expect(radios[0].text()).toBe('跟随系统')
    expect(radios[1].text()).toBe('浅纸')
    expect(radios[2].text()).toBe('夜纸')
    expect(radios[1].attributes('aria-checked')).toBe('true')
    expect(radios[0].attributes('aria-checked')).toBe('false')
    expect(radios[2].attributes('aria-checked')).toBe('false')
    wrapper.unmount()
  })

  it('点选「夜纸」→ 偏好持久化为 dark，data-theme 与 aria-checked 同步', async () => {
    setThemePreference('light')
    const wrapper = mountView()
    await flushPromises()
    await appearanceRadios(wrapper)[2].trigger('click')
    expect(localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('night')
    const radios = appearanceRadios(wrapper)
    expect(radios[2].attributes('aria-checked')).toBe('true')
    expect(radios[1].attributes('aria-checked')).toBe('false')
    wrapper.unmount()
  })

  it('跟随系统（系统暗色）说明显示实际生效主题「生效：夜纸」', async () => {
    installSystemDark(true)
    setThemePreference('system')
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.text()).toContain('当前跟随系统（生效：夜纸）')
    expect(appearanceRadios(wrapper)[0].attributes('aria-checked')).toBe('true')
    wrapper.unmount()
  })

  it('跟随系统（系统亮色）说明显示「生效：浅纸」', async () => {
    installSystemDark(false)
    setThemePreference('system')
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.text()).toContain('当前跟随系统（生效：浅纸）')
    expect(document.documentElement.dataset.theme).toBe('')
    wrapper.unmount()
  })

  it('显式选择后说明切换为普通文案，点击即全站生效', async () => {
    const harness = installSystemDark(true)
    setThemePreference('system')
    const wrapper = mountView()
    await flushPromises()
    await appearanceRadios(wrapper)[1].trigger('click')
    expect(themePreference.value).toBe('light')
    expect(wrapper.text()).not.toContain('当前跟随系统')
    expect(wrapper.text()).toContain('切换后立即生效')
    expect(document.documentElement.dataset.theme).toBe('')

    // 系统再切暗也不影响显式浅纸偏好（监听已随偏好摘除）。
    harness.emit(false)
    expect(themePreference.value).toBe('light')
    wrapper.unmount()
  })
})
