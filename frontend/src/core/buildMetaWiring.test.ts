// @vitest-environment node
/**
 * 构建元数据链路（源码级）：CI / 本地镜像构建传入的 BUILD_HASH / BUILD_DATE
 * 必须能穿过 Dockerfile 的 web-builder 阶段，被 Vite 注入到设置页。
 * Docker 上下文不含 .git，这条链路断了页面就会显示 unknown。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

import { describe, expect, it } from 'vitest'

const readRoot = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8')

const viteConfig = readFileSync(
  fileURLToPath(new URL('../../vite.config.ts', import.meta.url)),
  'utf8',
)
const dockerfile = readRoot('Dockerfile')
const makefile = readRoot('Makefile')
const workflow = readRoot('.github/workflows/docker-image.yml')

describe('构建号注入链路', () => {
  it('Vite 优先读显式环境变量，再降级到 git', () => {
    expect(viteConfig).toContain('process.env.FAMBEAN_BUILD_HASH')
    expect(viteConfig).toContain('process.env.FAMBEAN_BUILD_DATE')
    expect(viteConfig).toContain('__APP_BUILD_HASH__: JSON.stringify(buildHash())')
    expect(viteConfig).toContain('__APP_BUILD_DATE__: JSON.stringify(buildDate())')
  })

  it('Dockerfile 的 web-builder 在 npm run build 前接收并导出构建元数据', () => {
    const stage = dockerfile.slice(
      dockerfile.indexOf('FROM ${NODE_IMAGE} AS web-builder'),
      dockerfile.indexOf('FROM ${GO_IMAGE} AS go-builder'),
    )
    expect(stage).toContain('ARG BUILD_HASH=unknown')
    expect(stage).toContain('ARG BUILD_DATE=unknown')
    expect(stage).toContain('FAMBEAN_BUILD_HASH=${BUILD_HASH}')
    expect(stage).toContain('FAMBEAN_BUILD_DATE=${BUILD_DATE}')
    expect(stage.indexOf('ARG BUILD_HASH')).toBeLessThan(stage.indexOf('RUN npm run build'))
  })

  it('CI 与本地镜像入口都传 BUILD_HASH / BUILD_DATE', () => {
    expect(workflow).toContain('BUILD_HASH=${{ steps.info.outputs.hash }}')
    expect(workflow).toContain('BUILD_DATE=${{ steps.info.outputs.date }}')
    expect(makefile).toContain('--build-arg BUILD_HASH=$$(git rev-parse --short HEAD)')
    expect(makefile).toContain('--build-arg BUILD_DATE=$$(date -u +%Y-%m-%d)')
  })
})
