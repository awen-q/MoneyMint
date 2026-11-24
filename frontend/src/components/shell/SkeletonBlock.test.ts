// @vitest-environment jsdom
/**
 * SkeletonBlock 回归（骨架屏批）：
 * - 渲染：灰底圆角块 + aria-hidden（纯装饰、无文本，金额占位红线）；
 * - variant 预设：line / card / calendar / chart 四档尺寸各不相同；
 * - width / height props 覆盖预设（落点按真实内容区微调用）；
 * - 源码护栏：色值只引用 --fb-skeleton-* 三 token（无色值字面量）、shimmer 是纯 CSS
 *   动画且带 prefers-reduced-motion 停动画守卫（check-theme 护栏只放行
 *   tokens.css 与 themeTokens.ts，组件内出现任何色值字面量都会被拦，
 *   这里再守一层结构与动效豁免）。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import SkeletonBlock from './SkeletonBlock.vue'

describe('SkeletonBlock：渲染', () => {
  it('默认 line 档：渲染 .skel 且 aria-hidden、无任何文本（金额占位红线）', () => {
    const wrapper = mount(SkeletonBlock)
    expect(wrapper.classes()).toContain('skel')
    expect(wrapper.classes()).toContain('skel--line')
    expect(wrapper.attributes('aria-hidden')).toBe('true')
    expect(wrapper.text()).not.toMatch(/[0-9]/)
  })

  it('variant 预设四档高度各不相同，圆角随档位走', () => {
    const line = mount(SkeletonBlock, { props: { variant: 'line' } })
    const card = mount(SkeletonBlock, { props: { variant: 'card' } })
    const calendar = mount(SkeletonBlock, { props: { variant: 'calendar' } })
    const chart = mount(SkeletonBlock, { props: { variant: 'chart' } })
    expect(line.element.style.height).toBe('14px')
    expect(card.element.style.height).toBe('64px')
    expect(calendar.element.style.height).toBe('300px')
    expect(chart.element.style.height).toBe('200px')
    // 小条是半高圆角；块级圆角走 token（断言 px 档，var() 档由浏览器解析）
    expect(line.element.style.borderRadius).toBe('7px')
    expect(calendar.element.style.borderRadius).not.toBe('')
  })

  it('width / height props 覆盖预设（宽度微调用）', () => {
    const wrapper = mount(SkeletonBlock, {
      props: { variant: 'line', width: '92%', height: '10px' },
    })
    expect(wrapper.element.style.width).toBe('92%')
    expect(wrapper.element.style.height).toBe('10px')
  })
})

describe('SkeletonBlock：源码护栏', () => {
  // 本文件是 jsdom 环境（mount 需要 DOM）：jsdom 下 import.meta.url 不是 file scheme，
  // 不能像 node 环境的源码扫描测试那样用 fileURLToPath，改从进程 cwd（frontend/，
  // npm script / CI web-verify 的执行目录）解析相对路径。
  const source = readFileSync(resolve(process.cwd(), 'src/components/shell/SkeletonBlock.vue'), 'utf8')

  it('组件内无色值字面量，色值只引用 --fb-skeleton-* 三 token', () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
    for (const token of ['--fb-skeleton-base', '--fb-skeleton-sheen-soft', '--fb-skeleton-sheen']) {
      expect(source).toContain(`var(${token})`)
    }
  })

  it('shimmer 是纯 CSS 动画，且带 prefers-reduced-motion 停动画守卫', () => {
    expect(source).toContain('@keyframes')
    expect(source).toContain('@media (prefers-reduced-motion: reduce)')
  })
})
