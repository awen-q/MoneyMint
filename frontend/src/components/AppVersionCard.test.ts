// @vitest-environment jsdom
/**
 * AppVersionCard 回归：版本 / 构建号 / 日期展示、预览版角标、一键复制与失败提示。
 */
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import AppVersionCard from './AppVersionCard.vue'
import type { VersionInfo } from '@/core/appVersion'

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

const writeText = vi.fn<(text: string) => Promise<void>>()

beforeEach(() => {
  writeText.mockReset()
  writeText.mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
})

describe('AppVersionCard：展示', () => {
  it('显示版本 / 构建号 / 日期，预发布版带角标', () => {
    const wrapper = mount(AppVersionCard, { props: { info: prerelease } })
    const text = wrapper.text()
    expect(text).toContain('v0.6.2-pre')
    expect(text).toContain('d14dfdc')
    expect(text).toContain('2026-11-21')
    expect(wrapper.find('.av__badge').text()).toBe('预览版')
  })

  it('正式版不打预览角标', () => {
    const wrapper = mount(AppVersionCard, { props: { info: stable } })
    expect(wrapper.find('.av__badge').exists()).toBe(false)
  })
})

describe('AppVersionCard：复制', () => {
  it('点击后复制整段版本信息并反馈已复制', async () => {
    const wrapper = mount(AppVersionCard, { props: { info: prerelease } })
    await wrapper.find('.av__copy').trigger('click')
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0][0]).toContain('FamBean v0.6.2-pre（预览版）')
    expect(wrapper.text()).toContain('已复制')
  })

  it('剪贴板不可用时给出可操作提示，不静默失败', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'))
    const wrapper = mount(AppVersionCard, { props: { info: stable } })
    await wrapper.find('.av__copy').trigger('click')
    expect(wrapper.find('.av__failed').text()).toContain('复制失败')
  })
})
