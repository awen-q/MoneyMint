import { describe, expect, it, vi } from 'vitest'

import { createOnceLoader } from './echarts'
import {
  MAX_LIVE_CHARTS,
  acquireChart,
  liveChartCount,
  resetLiveChartCount,
} from './liveCount'

describe('createOnceLoader', () => {
  it('并发调用只执行一次 loader', async () => {
    const loader = vi.fn(async () => 'value')
    const ensure = createOnceLoader(loader)

    const [a, b, c] = await Promise.all([ensure(), ensure(), ensure()])

    expect(loader).toHaveBeenCalledTimes(1)
    expect([a, b, c]).toEqual(['value', 'value', 'value'])
  })

  it('成功后续调用复用同一 Promise（不再执行 loader）', async () => {
    const loader = vi.fn(async () => 1)
    const ensure = createOnceLoader(loader)

    const first = ensure()
    const second = ensure()
    expect(first).toBe(second)

    await first
    await ensure()
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('失败不缓存，下次调用重试', async () => {
    let attempt = 0
    const loader = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('network')
      return 'ok'
    })
    const ensure = createOnceLoader(loader)

    await expect(ensure()).rejects.toThrow('network')
    await expect(ensure()).resolves.toBe('ok')
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('并发中的失败对每个等待者都可见，且之后可重试', async () => {
    let attempt = 0
    const loader = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('boom')
      return attempt
    })
    const ensure = createOnceLoader(loader)

    const results = await Promise.allSettled([ensure(), ensure()])
    expect(results.every((r) => r.status === 'rejected')).toBe(true)
    await expect(ensure()).resolves.toBe(2)
  })
})

describe('liveChartCount', () => {
  it('acquire/release 成对增减', () => {
    resetLiveChartCount()
    expect(liveChartCount()).toBe(0)

    const releaseA = acquireChart('trend')
    const releaseB = acquireChart('donut')
    expect(liveChartCount()).toBe(2)

    releaseA()
    expect(liveChartCount()).toBe(1)

    releaseB()
    expect(liveChartCount()).toBe(0)
  })

  it('重复 release 不会把计数压成负数', () => {
    resetLiveChartCount()
    const release = acquireChart('trend')
    release()
    release()
    release()
    expect(liveChartCount()).toBe(0)
  })

  it('超过上限只告警，不抛错（不阻断业务）', () => {
    resetLiveChartCount()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const releases = []
    for (let i = 0; i < MAX_LIVE_CHARTS + 2; i += 1) {
      releases.push(acquireChart(`chart-${i}`))
    }

    expect(liveChartCount()).toBe(MAX_LIVE_CHARTS + 2)
    // DEV 下应给出可定位的告警；PROD 构建里该分支会被摇掉，故只在有调用时断言内容。
    if (warn.mock.calls.length > 0) {
      expect(String(warn.mock.calls[0][0])).toContain('超过上限')
    }

    releases.forEach((release) => release())
    expect(liveChartCount()).toBe(0)
    warn.mockRestore()
  })
})
