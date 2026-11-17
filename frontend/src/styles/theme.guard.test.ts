// @vitest-environment node
/**
 * 主题护栏单测：白名单覆盖全部已知违规，收编后扫描结果必须为零。
 */
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { loadExceptions, scanSources } from '../../scripts/check-theme-sources.mjs'

const frontendRoot = fileURLToPath(new URL('../..', import.meta.url))

describe('主题护栏：源码无未授权硬编码色值', () => {
  it('当前白名单下扫描结果为零', () => {
    const exceptions = loadExceptions()
    expect(scanSources(frontendRoot, exceptions)).toEqual([])
  })

  it('扫描器自检：移除白名单后必须能命中 token 定义（防止假绿灯）', () => {
    const hits = scanSources(frontendRoot, { allowFiles: [], allowLines: [] })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((hit) => hit.file === 'src/styles/tokens.css')).toBe(true)
  })

  it('阶段 0 退出时 allowLines 已清空，只剩两个 allowFiles', () => {
    const exceptions = loadExceptions()
    expect(exceptions.allowFiles).toEqual(['src/styles/tokens.css', 'src/styles/themeTokens.ts'])
    expect(exceptions.allowLines).toEqual([])
  })
})
