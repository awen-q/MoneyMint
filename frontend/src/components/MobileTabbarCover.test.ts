// @vitest-environment node
/**
 * 移动底栏遮盖契约（源码断言，jsdom 无布局引擎无法验证 fixed 层叠）。
 *
 * 契约：记账弹窗打开期间必须隐藏底部 TabBar（AppLayout 里的 ShellTabs）。
 *
 * 背景 Bug：安卓真机上「记账弹窗没有遮住底部 账单/统计/资产/更多」。
 * 根因链：.rs-mask 是 inset:0 的 layout viewport 全屏遮罩，但 .rs-panel
 * 高度取 --vvh（visualViewport.height，见 RecordSheet syncVv）——安卓地址栏
 * 收起/展开、UC·夸克等自带底部工具栏的浏览器里 visualViewport 小于 layout
 * 视口，面板高度 < 遮罩高度，底部露出一截缝隙；底栏 z-index 30 在遮罩 60
 * 之下，透过 44% 半透明遮罩可见。修复：sheet.isOpen 期间 v-show 隐藏底栏。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

import { describe, expect, it } from 'vitest'

const appLayout = readFileSync(fileURLToPath(new URL('./AppLayout.vue', import.meta.url)), 'utf8')
const recordSheet = readFileSync(fileURLToPath(new URL('./RecordSheet.vue', import.meta.url)), 'utf8')

describe('记账弹窗打开期间隐藏移动底栏（安卓 vvh 缝隙漏底栏）', () => {
  it('ShellTabs 绑定 v-show="!sheet.isOpen"（弹窗全屏接管，FAB 一并隐藏）', () => {
    const start = appLayout.indexOf('<ShellTabs')
    const end = appLayout.indexOf('/>', start)
    const tag = appLayout.slice(start, end)
    expect(tag).toContain('v-show="!sheet.isOpen"')
  })

  it('契约前提仍在守：--vvh 由 syncVv 写入 documentElement（面板高度与遮罩可能不等）', () => {
    expect(recordSheet).toContain("setProperty('--vvh'")
    expect(recordSheet).toContain('visualViewport')
  })
})
