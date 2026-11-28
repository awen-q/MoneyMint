/**
 * P1 错误薄映射契约：已知码给中文原因 + 动作，未知码原文透传不留白。
 */
import { afterEach, describe, expect, it } from 'vitest'

import { setLocale } from '@/i18n'

import { describeSyncError, httpErrorCode } from './errorMessages'
import { DEAD_CODES } from './models'

afterEach(() => {
  setLocale('zh-CN')
})

describe('P1：describeSyncError 已知码', () => {
  it('全部 DEAD_CODES 都有非空 reason 与 action', () => {
    for (const code of DEAD_CODES) {
      const described = describeSyncError(code, `raw-${code}`)
      expect(described.reason.trim().length).toBeGreaterThan(0)
      expect(described.reason).not.toContain('syncError.')
      expect(described.action?.trim().length ?? 0).toBeGreaterThan(0)
    }
  })

  it('account_not_found / invalid_push_results 覆盖 P0+P1 常见码', () => {
    expect(describeSyncError('account_not_found', 'missing').reason).toContain('账户')
    expect(describeSyncError('invalid_push_results', '结果缺失').reason).toContain('结果不完整')
    expect(describeSyncError('network_error', 'offline').reason).toContain('网络')
  })

  it('401/403 的 status 形态与顶层别名归一到同一文案', () => {
    const unauthorized = describeSyncError('unauthorized', 'unauthorized')
    expect(describeSyncError('401', 'plain').reason).toBe(unauthorized.reason)
    expect(describeSyncError('http_401', 'plain').reason).toBe(unauthorized.reason)
    expect(describeSyncError('unauthorized', 'plain').action).toContain('重新登录')
    expect(describeSyncError('403', 'plain').reason).toContain('权限')
  })

  it('5xx 走带 status 占位的通用文案，不把 HTTP 原文甩给用户', () => {
    const described = describeSyncError(httpErrorCode(503), 'upstream exploded')
    expect(described.reason).toContain('503')
    expect(described.reason).not.toContain('{status}')
    expect(described.action?.length ?? 0).toBeGreaterThan(0)
  })

  it('切到 en 后文案随语言切换', () => {
    setLocale('en')
    expect(describeSyncError('network_error', 'offline').reason).toContain('network')
  })
})

describe('P1：describeSyncError 未知码原文透传', () => {
  it('未知码 reason 恒等于 rawMessage', () => {
    expect(describeSyncError('weird_new_code', '服务端返回了奇怪的错误')).toEqual({
      reason: '服务端返回了奇怪的错误',
    })
  })

  it('原文为空时回退 code，不留白', () => {
    expect(describeSyncError('weird_new_code', '   ')).toEqual({ reason: 'weird_new_code' })
    expect(describeSyncError('', '').reason).toBe('未知同步错误')
  })
})
