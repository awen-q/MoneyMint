/**
 * 主题状态（阶段 4）：浅纸 / 夜纸完整可切换。
 *
 * 设计要点：
 * - module 级单例，设置页切换后全站（含所有 View / Canvas）共享同一份状态；
 * - 初值读 localStorage（key = THEME_STORAGE_KEY），无值默认 paper；
 * - setTheme 同步 dataset / localStorage / <meta name="theme-color">，
 *   并调用 refreshThemeTokens() 递增 themeEpoch，触发图表组件重绘；
 * - initTheme 在应用启动时把已持久化主题补写回 DOM（此时组件未挂载，不触发重绘）。
 *
 * 兼容约束：不用 .at() / structuredClone 等 Safari 14.1 缺失的 API。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'

import {
  THEME_COLOR_NIGHT,
  THEME_COLOR_PAPER,
  THEME_STORAGE_KEY,
  refreshThemeTokens,
} from '../styles/themeTokens'

/** 主题名：paper = 浅纸（默认），night = 夜纸。 */
export type ThemeName = 'paper' | 'night'

/** PWA / 浏览器 UI 主题色 meta 选择器。 */
export const THEME_META_SELECTOR = 'meta[name="theme-color"]'

/**
 * 归一化任意存储值：只有精确的 'night' 才是夜纸，其余一律浅纸。
 *
 * @param value 存储或调用方传入的候选值
 * @returns 合法主题名
 */
function normalizeTheme(value: string | null | undefined): ThemeName {
  return value === 'night' ? 'night' : 'paper'
}

/**
 * 读取持久化主题；localStorage 不可用（SSR / 隐私模式受限）时安全回退浅纸。
 *
 * @returns 初始主题名
 */
function readStoredTheme(): ThemeName {
  if (typeof localStorage === 'undefined') {
    return 'paper'
  }
  try {
    return normalizeTheme(localStorage.getItem(THEME_STORAGE_KEY))
  } catch {
    return 'paper'
  }
}

/** 全局唯一主题状态（模块单例）。 */
const theme: Ref<ThemeName> = ref<ThemeName>(readStoredTheme())

/** 是否夜纸（computed，模板可直接用）。 */
const isNight: ComputedRef<boolean> = computed(() => theme.value === 'night')

/**
 * 同步 <meta name="theme-color">；不存在则补建，保证 PWA 外观跟随主题。
 *
 * @param next 目标主题
 */
function syncThemeMeta(next: ThemeName): void {
  if (typeof document === 'undefined') {
    return
  }
  let meta = document.querySelector<HTMLMetaElement>(THEME_META_SELECTOR)
  if (meta === null) {
    meta = document.createElement('meta')
    meta.setAttribute('name', 'theme-color')
    document.head.appendChild(meta)
  }
  meta.setAttribute('content', next === 'night' ? THEME_COLOR_NIGHT : THEME_COLOR_PAPER)
}

/**
 * 把主题写到 DOM 与 meta（不含持久化 / 重绘）。
 *
 * @param next 目标主题
 */
function applyThemeToDom(next: ThemeName): void {
  if (typeof document === 'undefined') {
    return
  }
  document.documentElement.dataset.theme = next === 'night' ? 'night' : ''
  syncThemeMeta(next)
}

/**
 * 持久化主题；存储写入失败不影响内存态与视觉切换。
 *
 * @param next 目标主题
 */
function persistTheme(next: ThemeName): void {
  if (typeof localStorage === 'undefined') {
    return
  }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next)
  } catch {
    // 隐私模式 / 存储配额异常：忽略，仍保证本次会话内主题可用。
  }
}

/**
 * 设置主题（全站立即生效）。
 *
 * @param next 目标主题；非 'night' 值一律按浅纸处理
 */
export function setTheme(next: ThemeName): void {
  const target = normalizeTheme(next)
  theme.value = target
  persistTheme(target)
  applyThemeToDom(target)
  refreshThemeTokens()
}

/** 在浅纸 / 夜纸之间切换。 */
export function toggleTheme(): void {
  setTheme(theme.value === 'night' ? 'paper' : 'night')
}

/** 应用启动时调用：把持久化主题同步到 DOM / meta，不递增重绘信号。 */
export function initTheme(): void {
  applyThemeToDom(theme.value)
}

export { isNight, theme }
