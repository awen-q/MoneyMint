// @vitest-environment jsdom
/**
 * useTheme 单测（阶段 4）：初值读取 + dataset/localStorage/meta 同步 + toggle + 重绘信号。
 *
 * 注意：测试源码不写裸 hex（主题护栏会误报），主题色一律从 themeTokens 常量引用。
 * module 级单例需要在每个用例前 vi.resetModules() 重新求值，才能覆盖"初值读取"。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { THEME_COLOR_NIGHT, THEME_COLOR_PAPER, THEME_STORAGE_KEY } from '../styles/themeTokens'

const META_SELECTOR = 'meta[name="theme-color"]'

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

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  document.head.innerHTML = ''
  const meta = document.createElement('meta')
  meta.setAttribute('name', 'theme-color')
  meta.setAttribute('content', THEME_COLOR_PAPER)
  document.head.appendChild(meta)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useTheme：初值读取', () => {
  it('无存储值时默认浅纸，initTheme 同步空 data-theme 与浅纸 meta', async () => {
    const { composable } = await loadThemeModule()
    expect(composable.theme.value).toBe('paper')
    expect(composable.isNight.value).toBe(false)

    composable.initTheme()
    expect(document.documentElement.dataset.theme).toBe('')
    expect(metaColor()).toBe(THEME_COLOR_PAPER)
  })

  it('localStorage 为 night 时初值即夜纸', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'night')
    const { composable } = await loadThemeModule()
    expect(composable.theme.value).toBe('night')
    expect(composable.isNight.value).toBe(true)

    composable.initTheme()
    expect(document.documentElement.dataset.theme).toBe('night')
    expect(metaColor()).toBe(THEME_COLOR_NIGHT)
  })

  it('非法存储值回退浅纸', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'unknown')
    const { composable } = await loadThemeModule()
    expect(composable.theme.value).toBe('paper')
    expect(composable.isNight.value).toBe(false)
  })
})

describe('useTheme：切换链路', () => {
  it('setTheme 同步 dataset / localStorage / meta，并触发 refreshThemeTokens', async () => {
    const { composable, tokens } = await loadThemeModule()
    const before = tokens.themeEpoch.value

    composable.setTheme('night')
    expect(composable.theme.value).toBe('night')
    expect(document.documentElement.dataset.theme).toBe('night')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('night')
    expect(metaColor()).toBe(THEME_COLOR_NIGHT)
    // refreshThemeTokens 的可观测效果：themeEpoch 递增（图表组件 watch 由此重绘）。
    expect(tokens.themeEpoch.value).toBe(before + 1)

    composable.setTheme('paper')
    expect(document.documentElement.dataset.theme).toBe('')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('paper')
    expect(metaColor()).toBe(THEME_COLOR_PAPER)
    expect(tokens.themeEpoch.value).toBe(before + 2)
  })

  it('toggleTheme 双向切换且立即持久化', async () => {
    const { composable } = await loadThemeModule()
    composable.toggleTheme()
    expect(composable.theme.value).toBe('night')
    expect(composable.isNight.value).toBe(true)
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('night')

    composable.toggleTheme()
    expect(composable.theme.value).toBe('paper')
    expect(composable.isNight.value).toBe(false)
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('paper')
  })

  it('刷新保持：新模块实例从 localStorage 读回上次主题', async () => {
    const first = await loadThemeModule()
    first.composable.setTheme('night')

    vi.resetModules()
    const second = await import('./useTheme')
    expect(second.theme.value).toBe('night')
    second.initTheme()
    expect(document.documentElement.dataset.theme).toBe('night')
    expect(metaColor()).toBe(THEME_COLOR_NIGHT)
  })

  it('模块单例：重复 import 共享同一状态', async () => {
    const first = await loadThemeModule()
    first.composable.setTheme('night')
    const again = await import('./useTheme')
    expect(again.theme.value).toBe('night')

    again.setTheme('paper')
    expect(first.composable.theme.value).toBe('paper')
  })
})
