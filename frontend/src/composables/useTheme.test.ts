// @vitest-environment jsdom
/**
 * useTheme 单测（三态偏好）：旧键迁移 + 三态解析矩阵 + 系统监听 + 切换链路。
 *
 * 注意：测试源码不写裸 hex（主题护栏会误报），主题色一律从 themeTokens 常量引用。
 * module 级单例需要在每个用例前 vi.resetModules() 重新求值，才能覆盖"初值读取"。
 * matchMedia 在 beforeEach 统一移除：需要系统值 / 监听的用例显式 installMatchMedia，
 * 其余用例天然覆盖「matchMedia 不可用 → 静默降级」路径。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  THEME_COLOR_NIGHT,
  THEME_COLOR_PAPER,
  THEME_MODE_STORAGE_KEY,
  THEME_STORAGE_KEY,
} from '../styles/themeTokens'

const META_SELECTOR = 'meta[name="theme-color"]'

/** 系统暗色监听回调的事件形态（只关心 matches）。 */
type MediaListener = (event: { matches: boolean }) => void

/** 重新加载一组 useTheme + themeTokens（同一模块图实例），以便观察 themeEpoch。 */
async function loadThemeModule() {
  const tokens = await import('../styles/themeTokens')
  const composable = await import('./useTheme')
  return { tokens, composable }
}

/** 读取当前 meta theme-color。 */
function metaColor(): string | null {
  return document.querySelector<HTMLMetaElement>(META_SELECTOR)?.getAttribute('content') ?? null
}

interface MatchMediaHarness {
  /** 触发系统暗色偏好变化（同时更新 matches 与已挂接的回调）。 */
  emit(next: boolean): void
}

/**
 * 安装可控的 matchMedia mock：完整模拟现代（addEventListener）监听 API。
 */
function installMatchMedia(initialMatches: boolean): MatchMediaHarness {
  const listeners: MediaListener[] = []
  const media: {
    matches: boolean
    addEventListener?: (type: string, listener: MediaListener) => void
    removeEventListener?: (type: string, listener: MediaListener) => void
  } = { matches: initialMatches }
  media.addEventListener = vi.fn((type: string, listener: MediaListener) => {
    if (type === 'change') {
      listeners.push(listener)
    }
  })
  media.removeEventListener = vi.fn((type: string, listener: MediaListener) => {
    if (type !== 'change') {
      return
    }
    const index = listeners.indexOf(listener)
    if (index >= 0) {
      listeners.splice(index, 1)
    }
  })
  ;(window as unknown as { matchMedia: unknown }).matchMedia = vi.fn(
    () => media as unknown as MediaQueryList,
  )
  return {
    emit(next: boolean) {
      media.matches = next
      // 拷贝后再调用，防回调内摘除监听导致遍历跳变。
      for (const listener of listeners.slice()) {
        listener({ matches: next })
      }
    },
  }
}

/**
 * 旧 Safari 形态：只有 addListener / removeListener，没有 addEventListener。
 * 用于钉住「addEventListener → addListener」兼容回退路径确实走通。
 */
function installLegacyMatchMedia(initialMatches: boolean): MatchMediaHarness {
  const listeners: MediaListener[] = []
  const media: {
    matches: boolean
    addEventListener?: unknown
    addListener: (listener: MediaListener) => void
    removeListener: (listener: MediaListener) => void
  } = {
    matches: initialMatches,
    addEventListener: undefined,
    addListener: vi.fn((listener: MediaListener) => {
      listeners.push(listener)
    }),
    removeListener: vi.fn((listener: MediaListener) => {
      const index = listeners.indexOf(listener)
      if (index >= 0) {
        listeners.splice(index, 1)
      }
    }),
  }
  ;(window as unknown as { matchMedia: unknown }).matchMedia = vi.fn(
    () => media as unknown as MediaQueryList,
  )
  return {
    emit(next: boolean) {
      media.matches = next
      for (const listener of listeners.slice()) {
        listener({ matches: next })
      }
    },
  }
}

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  document.head.innerHTML = ''
  const meta = document.createElement('meta')
  meta.setAttribute('name', 'theme-color')
  meta.setAttribute('content', THEME_COLOR_PAPER)
  document.head.appendChild(meta)
  // 统一移除 matchMedia，保证「无 matchMedia 静默降级」被其余用例天然覆盖。
  ;(window as unknown as { matchMedia: unknown }).matchMedia = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useTheme：偏好读取与旧键迁移', () => {
  it('无存储值时默认跟随系统（无 matchMedia → 解析浅纸），initTheme 同步空 data-theme 与浅纸 meta，且新键不落盘', async () => {
    const { composable } = await loadThemeModule()
    expect(composable.themePreference.value).toBe('system')
    expect(composable.theme.value).toBe('paper')
    expect(composable.isNight.value).toBe(false)

    composable.initTheme()
    expect(document.documentElement.dataset.theme).toBe('')
    expect(metaColor()).toBe(THEME_COLOR_PAPER)
    // 无偏好时不写新键：避免每次冷启动多一次存储写。
    expect(localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBe(null)
  })

  it('旧键 night 一次性迁移为 dark：写新键、删旧键、解析夜纸', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'night')
    const { composable } = await loadThemeModule()
    expect(composable.theme.value).toBe('night')
    expect(composable.isNight.value).toBe(true)
    expect(composable.themePreference.value).toBe('dark')
    expect(localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBe('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(null)
  })

  it('旧键 paper 一次性迁移为 light', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'paper')
    const { composable } = await loadThemeModule()
    expect(composable.theme.value).toBe('paper')
    expect(composable.isNight.value).toBe(false)
    expect(composable.themePreference.value).toBe('light')
    expect(localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBe('light')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(null)
  })

  it('旧键非法值回退 system 并清理旧键', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'unknown')
    const { composable } = await loadThemeModule()
    expect(composable.theme.value).toBe('paper')
    expect(composable.themePreference.value).toBe('system')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(null)
  })

  it('新键非法值同样回退 system', async () => {
    localStorage.setItem(THEME_MODE_STORAGE_KEY, 'bogus')
    const { composable } = await loadThemeModule()
    expect(composable.themePreference.value).toBe('system')
    expect(composable.theme.value).toBe('paper')
  })

  it('localStorage 读取抛异常时静默回退 system，不崩', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked')
    })
    const { composable } = await loadThemeModule()
    expect(composable.themePreference.value).toBe('system')
    expect(composable.theme.value).toBe('paper')
  })
})

describe('useTheme：三态解析矩阵', () => {
  it('system 偏好 + 系统暗色 → 夜纸', async () => {
    installMatchMedia(true)
    const { composable } = await loadThemeModule()
    expect(composable.theme.value).toBe('night')
    expect(composable.isNight.value).toBe(true)

    composable.initTheme()
    expect(document.documentElement.dataset.theme).toBe('night')
    expect(metaColor()).toBe(THEME_COLOR_NIGHT)
  })

  it('system 偏好 + 系统亮色 → 浅纸', async () => {
    installMatchMedia(false)
    const { composable } = await loadThemeModule()
    expect(composable.theme.value).toBe('paper')
    expect(composable.isNight.value).toBe(false)
  })

  it('light 偏好无视系统暗色 → 浅纸', async () => {
    installMatchMedia(true)
    localStorage.setItem(THEME_MODE_STORAGE_KEY, 'light')
    const { composable } = await loadThemeModule()
    expect(composable.theme.value).toBe('paper')
    expect(composable.themePreference.value).toBe('light')
  })

  it('dark 偏好无视系统亮色 → 夜纸', async () => {
    installMatchMedia(false)
    localStorage.setItem(THEME_MODE_STORAGE_KEY, 'dark')
    const { composable } = await loadThemeModule()
    expect(composable.theme.value).toBe('night')
    expect(composable.themePreference.value).toBe('dark')
  })
})

describe('useTheme：切换与系统监听', () => {
  it('setThemePreference(dark) 同步 dataset / 新键 / meta 并递增 themeEpoch；light 同步；旧键不参与写路径', async () => {
    const { composable, tokens } = await loadThemeModule()
    const before = tokens.themeEpoch.value

    composable.setThemePreference('dark')
    expect(composable.theme.value).toBe('night')
    expect(composable.themePreference.value).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('night')
    expect(localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBe('dark')
    expect(metaColor()).toBe(THEME_COLOR_NIGHT)
    // refreshThemeTokens 的可观测效果：themeEpoch 递增（图表组件 watch 由此重绘）。
    expect(tokens.themeEpoch.value).toBe(before + 1)

    composable.setThemePreference('light')
    expect(document.documentElement.dataset.theme).toBe('')
    expect(localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBe('light')
    expect(metaColor()).toBe(THEME_COLOR_PAPER)
    expect(tokens.themeEpoch.value).toBe(before + 2)
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(null)
  })

  it('setThemePreference(system) 立即按系统值解析并持久化 system 偏好', async () => {
    installMatchMedia(true)
    const { composable } = await loadThemeModule()
    composable.setThemePreference('dark')
    composable.setThemePreference('system')
    expect(composable.themePreference.value).toBe('system')
    expect(composable.theme.value).toBe('night')
    expect(document.documentElement.dataset.theme).toBe('night')
    expect(localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBe('system')
  })

  it('system 态系统切暗：主题 / DOM / meta / epoch 跟随，且不写 localStorage', async () => {
    const harness = installMatchMedia(false)
    const { composable, tokens } = await loadThemeModule()
    composable.setThemePreference('system')
    const before = tokens.themeEpoch.value

    harness.emit(true)
    expect(composable.theme.value).toBe('night')
    expect(document.documentElement.dataset.theme).toBe('night')
    expect(metaColor()).toBe(THEME_COLOR_NIGHT)
    expect(tokens.themeEpoch.value).toBe(before + 1)
    expect(localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBe('system')

    harness.emit(false)
    expect(composable.theme.value).toBe('paper')
    expect(document.documentElement.dataset.theme).toBe('')
    expect(metaColor()).toBe(THEME_COLOR_PAPER)
    expect(tokens.themeEpoch.value).toBe(before + 2)
  })

  it('非 system 态已摘除监听：系统变化不影响主题；切回 system 后重新生效', async () => {
    const harness = installMatchMedia(false)
    const { composable } = await loadThemeModule()
    composable.setThemePreference('system')
    harness.emit(true)
    expect(composable.theme.value).toBe('night')

    composable.setThemePreference('light')
    expect(composable.theme.value).toBe('paper')
    harness.emit(false)
    expect(composable.theme.value).toBe('paper')

    composable.setThemePreference('system')
    expect(composable.theme.value).toBe('paper')
    harness.emit(true)
    expect(composable.theme.value).toBe('night')
  })

  it('旧 Safari 只有 addListener 时走兼容回退，监听同样生效', async () => {
    const harness = installLegacyMatchMedia(false)
    const { composable } = await loadThemeModule()
    composable.setThemePreference('system')
    harness.emit(true)
    expect(composable.theme.value).toBe('night')
    expect(document.documentElement.dataset.theme).toBe('night')
  })

  it('window.matchMedia 不可用时 setThemePreference(system) 静默不崩', async () => {
    const { composable } = await loadThemeModule()
    expect(() => composable.setThemePreference('system')).not.toThrow()
    expect(composable.theme.value).toBe('paper')
    expect(localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBe('system')
  })

  it('localStorage 写入抛异常：内存态与 DOM 照常生效，不崩', async () => {
    const { composable, tokens } = await loadThemeModule()
    const before = tokens.themeEpoch.value
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    composable.setThemePreference('dark')
    expect(composable.theme.value).toBe('night')
    expect(composable.themePreference.value).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('night')
    expect(metaColor()).toBe(THEME_COLOR_NIGHT)
    expect(tokens.themeEpoch.value).toBe(before + 1)
    expect(localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBe(null)
  })

  it('刷新保持：新模块实例从新键读回上次偏好', async () => {
    const first = await loadThemeModule()
    first.composable.setThemePreference('dark')

    vi.resetModules()
    const second = await import('./useTheme')
    expect(second.theme.value).toBe('night')
    expect(second.themePreference.value).toBe('dark')
    second.initTheme()
    expect(document.documentElement.dataset.theme).toBe('night')
    expect(metaColor()).toBe(THEME_COLOR_NIGHT)
  })

  it('模块单例：重复 import 共享同一状态', async () => {
    const first = await loadThemeModule()
    first.composable.setThemePreference('dark')
    const again = await import('./useTheme')
    expect(again.theme.value).toBe('night')
    expect(again.themePreference.value).toBe('dark')

    again.setThemePreference('light')
    expect(first.composable.theme.value).toBe('paper')
    expect(first.composable.themePreference.value).toBe('light')
  })

  it('兼容入口 setTheme：映射为显式 light / dark 偏好', async () => {
    const { composable } = await loadThemeModule()
    composable.setTheme('night')
    expect(composable.themePreference.value).toBe('dark')
    expect(composable.theme.value).toBe('night')
    expect(localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBe('dark')

    composable.setTheme('paper')
    expect(composable.themePreference.value).toBe('light')
    expect(composable.theme.value).toBe('paper')
  })
})
