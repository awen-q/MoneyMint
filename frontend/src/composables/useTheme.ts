/**
 * 主题状态（三态偏好）：跟随系统 / 浅纸 / 夜纸。
 *
 * 设计要点：
 * - **偏好与解析结果分层**：用户偏好（ThemePreference = system / light / dark）
 *   持久化到 localStorage（key = THEME_MODE_STORAGE_KEY）；解析结果
 *   （ThemeName = paper / night）只存内存——DOM dataset / meta theme-color /
 *   图表重绘链路全部沿用解析结果，下游零改动；
 * - **旧键一次性迁移**：读旧键 fambean.theme —— night→dark、paper→light，
 *   迁移值写入新键并删除旧键；无键→system（不落盘，避免冷启动多一次写）；
 *   非法旧值→system 并清理旧键；
 * - **system 偏好监听系统切换**：matchMedia(prefers-color-scheme) change 回调
 *   只更新内存态 + DOM + meta + themeEpoch（触发图表重绘），**不写 localStorage**
 *   （偏好仍是「跟随系统」，没有产生需要持久化的用户决定）；监听按
 *   addEventListener → addListener（旧 Safari）→ 静默不监听三级回退，
 *   皆无时系统切换在下次启动重读系统值时生效；
 * - setThemePreference 全站立即生效并递增 themeEpoch；
 * - initTheme 在应用启动时把已解析主题补写回 DOM（组件未挂载，不触发重绘）。
 *
 * **与 index.html 内联防闪屏脚本同口径**：那边在 bundle 执行前按同一套键名 /
 * 迁移 / 解析规则预设 data-theme 与 meta theme-color，改任何一处必须同步检查另一处。
 *
 * 兼容约束：不用 .at() / structuredClone 等 Safari 14.1 缺失的 API。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'

import {
  THEME_COLOR_NIGHT,
  THEME_COLOR_PAPER,
  THEME_MODE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  refreshThemeTokens,
} from '../styles/themeTokens'

/** 主题名（解析结果）：paper = 浅纸，night = 夜纸。 */
export type ThemeName = 'paper' | 'night'

/** 主题偏好（用户选择）：跟随系统 / 强制浅纸 / 强制夜纸。 */
export type ThemePreference = 'system' | 'light' | 'dark'

/** PWA / 浏览器 UI 主题色 meta 选择器。 */
export const THEME_META_SELECTOR = 'meta[name="theme-color"]'

/** 系统暗色偏好的 matchMedia 查询串（与 index.html 内联脚本逐字一致）。 */
const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)'

/**
 * 归一化偏好：只有精确的 'light' / 'dark' / 'system' 合法，其余一律跟随系统。
 *
 * @param value 存储或调用方传入的候选值
 * @returns 合法偏好
 */
function normalizeThemePreference(value: string | null | undefined): ThemePreference {
  if (value === 'light' || value === 'dark' || value === 'system') {
    return value
  }
  return 'system'
}

/**
 * 按偏好 + 系统暗色开关解析实际主题名。
 *
 * @param preference 用户偏好
 * @param systemDark 系统当前是否偏好暗色
 * @returns 解析结果（paper / night）
 */
function resolveThemeName(preference: ThemePreference, systemDark: boolean): ThemeName {
  if (preference === 'dark') {
    return 'night'
  }
  if (preference === 'light') {
    return 'paper'
  }
  return systemDark ? 'night' : 'paper'
}

/**
 * 读取系统是否偏好暗色；matchMedia 不可用（老 WebView / 测试环境）视为浅纸。
 */
function readSystemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  return window.matchMedia(SYSTEM_DARK_QUERY).matches
}

/**
 * 读取持久化偏好，并完成旧键 fambean.theme 的一次性迁移：
 * night→dark、paper→light 写入新键并删除旧键；无键→system（不落盘）；
 * 非法旧值→system 并清理旧键。迁移全程 try-catch：隐私模式 / 配额受限时
 * 写入失败不影响本次解析结果（下次启动重试迁移）。
 */
function readStoredPreference(): ThemePreference {
  if (typeof localStorage === 'undefined') {
    return 'system'
  }
  try {
    const stored = localStorage.getItem(THEME_MODE_STORAGE_KEY)
    if (stored !== null) {
      return normalizeThemePreference(stored)
    }
    const legacy = localStorage.getItem(THEME_STORAGE_KEY)
    if (legacy === 'night' || legacy === 'paper') {
      const migrated: ThemePreference = legacy === 'night' ? 'dark' : 'light'
      try {
        localStorage.setItem(THEME_MODE_STORAGE_KEY, migrated)
        localStorage.removeItem(THEME_STORAGE_KEY)
      } catch {
        // 迁移写失败：本次仍按迁移值生效，下次启动重试迁移。
      }
      return migrated
    }
    if (legacy !== null) {
      // 非法旧值：按跟随系统处理，顺手清掉脏数据（失败同样不阻断）。
      try {
        localStorage.removeItem(THEME_STORAGE_KEY)
      } catch {
        // 忽略。
      }
    }
    return 'system'
  } catch {
    return 'system'
  }
}

/** 初始偏好只读一次：迁移逻辑必须只跑一遍，两个 ref 共用同一初值。 */
const initialPreference: ThemePreference = readStoredPreference()

/** 用户偏好（模块单例，设置页三段选择直接绑定）。 */
const themePreference: Ref<ThemePreference> = ref<ThemePreference>(initialPreference)

/** 解析结果（模块单例；下游 DOM / meta / 重绘链路只认这个）。 */
const theme: Ref<ThemeName> = ref<ThemeName>(
  resolveThemeName(initialPreference, readSystemPrefersDark()),
)

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
 * 持久化偏好到新键；写入失败不影响内存态与视觉切换。
 *
 * @param next 目标偏好
 */
function persistThemeMode(next: ThemePreference): void {
  if (typeof localStorage === 'undefined') {
    return
  }
  try {
    localStorage.setItem(THEME_MODE_STORAGE_KEY, next)
  } catch {
    // 隐私模式 / 存储配额异常：忽略，仍保证本次会话内主题可用。
  }
}

/** 当前已挂接系统暗色监听的 MediaQueryList（null = 未挂接）。 */
let boundMediaQuery: MediaQueryList | null = null

/**
 * 系统暗色偏好变化回调：只更新内存态 / DOM / meta / 重绘信号，**不写 localStorage**。
 */
function onSystemSchemeChange(): void {
  const resolved = resolveThemeName('system', readSystemPrefersDark())
  theme.value = resolved
  applyThemeToDom(resolved)
  refreshThemeTokens()
}

/** 摘除系统暗色监听（幂等；未挂接时是空操作）。 */
function detachSystemListener(): void {
  const media = boundMediaQuery
  if (media === null) {
    return
  }
  if (typeof media.removeEventListener === 'function') {
    media.removeEventListener('change', onSystemSchemeChange)
  } else if (typeof media.removeListener === 'function') {
    // 旧 Safari 只有 addListener / removeListener。
    media.removeListener(onSystemSchemeChange)
  }
  boundMediaQuery = null
}

/**
 * 按偏好挂接 / 摘除系统暗色监听（幂等；重复挂接同一查询是空操作）。
 *
 * 兼容回退：addEventListener → addListener（旧 Safari）→ 皆无则静默不监听。
 *
 * @param preference 当前偏好；仅 system 需要监听
 */
function syncSystemListener(preference: ThemePreference): void {
  if (preference !== 'system') {
    detachSystemListener()
    return
  }
  if (boundMediaQuery !== null) {
    return
  }
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return
  }
  const media = window.matchMedia(SYSTEM_DARK_QUERY)
  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', onSystemSchemeChange)
    boundMediaQuery = media
    return
  }
  if (typeof media.addListener === 'function') {
    media.addListener(onSystemSchemeChange)
    boundMediaQuery = media
  }
  // 两种监听 API 都不可用：静默跳过，下次启动重读系统值。
}

/**
 * 设置主题偏好（全站立即生效并持久化到新键）。
 *
 * @param next 目标偏好；非法值一律按跟随系统处理
 */
export function setThemePreference(next: ThemePreference): void {
  const target = normalizeThemePreference(next)
  themePreference.value = target
  persistThemeMode(target)
  const resolved = resolveThemeName(target, readSystemPrefersDark())
  theme.value = resolved
  applyThemeToDom(resolved)
  refreshThemeTokens()
  syncSystemListener(target)
}

/**
 * 兼容入口（阶段 4 二态导出残留）：等价于显式选择浅纸 / 夜纸偏好（放弃跟随系统）。
 * 当前仓内已无调用方，仅为既有导出兼容保留。
 *
 * @param next 目标主题名；night → dark 偏好，其余一律 light
 */
export function setTheme(next: ThemeName): void {
  setThemePreference(next === 'night' ? 'dark' : 'light')
}

/** 应用启动时调用：把已解析主题同步到 DOM / meta，不递增重绘信号。 */
export function initTheme(): void {
  applyThemeToDom(theme.value)
  // 幂等补挂系统监听（模块导入时已按初始偏好挂接，这里是防未来初始化顺序变化的兜底）。
  syncSystemListener(themePreference.value)
}

export { isNight, theme, themePreference }
