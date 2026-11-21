// @vitest-environment jsdom
/**
 * appVersion 展示逻辑回归：
 * - 极简版本文案只含 v + 版本号；
 * - 预发布号打「预览版」角标，正式版不打；
 * - 复制文案含版本 / 构建号 / 日期，离线也能取（全部来自构建期常量）。
 */
import { describe, expect, it } from 'vitest'

import { isPrerelease, shortVersion, versionCopyText, type VersionInfo } from './appVersion'

const prerelease: VersionInfo = {
  version: '0.6.2-pre',
  buildHash: 'd14dfdc',
  buildDate: '2026-11-21',
}

const stable: VersionInfo = {
  version: '0.6.2',
  buildHash: 'unknown',
  buildDate: '2026-11-22',
}

describe('appVersion：展示文案', () => {
  it('极简文案只含 v + 版本号', () => {
    expect(shortVersion(prerelease)).toBe('v0.6.2-pre')
  })

  it('预发布号才算预览版', () => {
    expect(isPrerelease(prerelease.version)).toBe(true)
    expect(isPrerelease(stable.version)).toBe(false)
  })

  it('复制文案含版本 / 预览角标 / 构建号 / 日期', () => {
    const text = versionCopyText(prerelease)
    expect(text).toContain('FamBean v0.6.2-pre（预览版）')
    expect(text).toContain('构建：d14dfdc')
    expect(text).toContain('日期：2026-11-21')
  })

  it('正式版复制文案不带预览角标；git 不可用时构建号降级为 unknown', () => {
    const text = versionCopyText(stable)
    expect(text).not.toContain('预览版')
    expect(text).toContain('构建：unknown')
  })
})
