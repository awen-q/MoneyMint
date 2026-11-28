// @vitest-environment jsdom
/**
 * 英文字典「搬出 JS bundle」后的加载路径回归（不改动既有 6 个测试文件的断言）。
 *
 * 覆盖三件事：
 *  1. 构建期生成的 public/i18n/en.json 与源字典 en.ts 逐键逐值一致（防生成脚本漂移）；
 *  2. 生产加载器 fetch → 校验 → 装字典 → t() 同步返回英文（含插值）；
 *  3. 加载失败（网络异常 / HTTP 非 2xx / JSON 结构非法）时字典保持空，t() 回退 zh-CN。
 *
 * vitest 下 MODE === 'test'，index.ts 静态挂 en 字典，ensureEnDictionary() 不发请求；
 * 本文件通过直接调用可注入 fetcher 的 fetchEnDictionary() 覆盖生产分支。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { en } from './en'
import {
  LOCALE_STORAGE_KEY,
  ensureEnDictionary,
  fetchEnDictionary,
  installEnDictionary,
  locale,
  setLocale,
  t,
} from './index'
import type { MessageKey } from './zh-CN'

/** 复位语言单例与动态装入的字典，避免污染同文件后续用例。 */
function reset(): void {
  locale.value = 'zh-CN'
  installEnDictionary(en)
  localStorage.removeItem(LOCALE_STORAGE_KEY)
  document.documentElement.lang = ''
  document.title = ''
}

/** 构造一个可控的 fetch 替身。 */
function mockFetch(payload: unknown, options: { ok?: boolean; reject?: boolean } = {}): typeof fetch {
  const ok = options.ok !== false
  return vi.fn(async (): Promise<unknown> => {
    if (options.reject === true) throw new Error('network down')
    return {
      ok,
      json: async (): Promise<unknown> => payload,
    }
  }) as unknown as typeof fetch
}

afterEach(() => {
  reset()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('构建期字典产物', () => {
  it('public/i18n/en.json 与 src/i18n/en.ts 逐键逐值一致', () => {
    // vitest 的 import.meta.url 是 http scheme，改用进程 cwd（= frontend 根）解析。
    const jsonPath = path.resolve(process.cwd(), 'public/i18n/en.json')
    if (!existsSync(jsonPath)) {
      // 全新 clone 可能尚未 build：现场生成一次，仍以 en.ts 为唯一事实源。
      execFileSync(
        process.execPath,
        [path.resolve(process.cwd(), 'scripts/generate-en-dict.mjs')],
        { stdio: 'ignore' },
      )
    }
    const raw = readFileSync(jsonPath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    expect(parsed).toEqual(en)
    expect(Object.keys(parsed as Record<string, unknown>).length).toBeGreaterThan(0)
  })
})

describe('生产加载路径', () => {
  it('测试环境静态字典已就位：ensureEnDictionary 不发请求即返回 true', async () => {
    const forbiddenFetch = vi.fn(async (): Promise<never> => {
      throw new Error('测试环境不应发字典请求')
    })
    vi.stubGlobal('fetch', forbiddenFetch)

    expect(await ensureEnDictionary()).toBe(true)
    expect(forbiddenFetch).not.toHaveBeenCalled()
    setLocale('en')
    expect(t('shell.nav.bills')).toBe('Bills')
  })

  it('fetch 成功时字典被填充，t() 同步返回英文（含插值）', async () => {
    locale.value = 'en'
    const payload: Record<string, string> = {
      'shell.nav.bills': 'Bills from JSON',
      'i18n.production.greet': 'Hi {name}',
    }
    const fetcher = mockFetch(payload)

    expect(await fetchEnDictionary(fetcher)).toBe(true)
    expect(fetcher).toHaveBeenCalledOnce()
    const url = String(vi.mocked(fetcher).mock.calls[0][0])
    expect(url).toContain('i18n/en.json')
    expect(t('shell.nav.bills')).toBe('Bills from JSON')
    expect(t('i18n.production.greet' as MessageKey, { name: 'Ada' })).toBe('Hi Ada')
  })

  it('网络异常时返回 false，未覆盖的 key 回退 zh-CN', async () => {
    locale.value = 'en'
    // 模拟「字典为空」的生产冷启动：装一份不含业务 key 的非空字典。
    installEnDictionary({ 'i18n.production.notLoaded': 'placeholder' })
    expect(await fetchEnDictionary(mockFetch({}, { reject: true }))).toBe(false)
    expect(t('shell.nav.bills')).toBe('账单')
    expect(t('common.retry')).toBe('重试')
  })

  it('HTTP 非 2xx / JSON 结构非法 / 空字典一律拒绝安装', async () => {
    expect(await fetchEnDictionary(mockFetch({ a: 'b' }, { ok: false }))).toBe(false)
    expect(await fetchEnDictionary(mockFetch({ a: 1 }))).toBe(false)
    expect(await fetchEnDictionary(mockFetch({ a: [] }))).toBe(false)
    expect(await fetchEnDictionary(mockFetch({}))).toBe(false)
    locale.value = 'en'
    installEnDictionary({ 'i18n.production.notLoaded': 'placeholder' })
    expect(t('shell.nav.bills')).toBe('账单')
  })

  it('装字典后响应式版本号自增：await nextTick 后仍为英文', async () => {
    locale.value = 'en'
    const before = t('shell.nav.bills')
    expect(installEnDictionary({ 'shell.nav.bills': 'Bills after load' })).toBe(true)
    await nextTick()
    expect(before).toBe('Bills')
    expect(t('shell.nav.bills')).toBe('Bills after load')
  })
})
