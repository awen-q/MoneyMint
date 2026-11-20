// @vitest-environment jsdom
/**
 * T04 回归：全局脏标记的 version / 消费水位 / 跨 tab 去重 / iOS 回退。
 *
 * 每个用例使用不同 ledgerId，避免模块级单例状态互相污染。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  checkAndReload,
  consume,
  dirtyByLedger,
  isPageVisible,
  markDirty,
  registerReloadHandler,
} from './dataFreshness'
import {
  DATA_CHANGE_KEY,
  getTabId,
  publishDataChange,
  subscribeDataChange,
} from '@/core/sync/dataChangeChannel'
import type { DataChangeEvent } from '@/core/sync/engine'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('dataFreshness：version + 消费水位', () => {
  it('版本单调递增；checkAndReload 只触发一次，已消费后再查为 noop', () => {
    const reload = vi.fn()
    const unregister = registerReloadHandler(reload)
    try {
      markDirty('local-write', 101)
      markDirty('pull-changes', 101)
      expect(dirtyByLedger[101].version).toBe(2)
      expect(dirtyByLedger[101].reason).toBe('pull-changes')

      expect(checkAndReload(101)).toBe(true)
      expect(reload).toHaveBeenCalledTimes(1)
      expect(reload).toHaveBeenCalledWith(101)
      expect(checkAndReload(101)).toBe(false)
      expect(reload).toHaveBeenCalledTimes(1)

      expect(consume(101)).toBe(2)
    } finally {
      unregister()
    }
  })

  it('账本隔离：A 的脏标记不会让 B 触发 reload', () => {
    const reload = vi.fn()
    const unregister = registerReloadHandler(reload)
    try {
      markDirty('local-write', 102)
      expect(checkAndReload(103)).toBe(false)
      expect(reload).not.toHaveBeenCalled()
      expect(checkAndReload(102)).toBe(true)
      expect(reload).toHaveBeenCalledWith(102)
    } finally {
      unregister()
    }
  })

  it('未注册 reload 回调时检查返回 false，且不推进水位', () => {
    markDirty('local-write', 104)
    expect(checkAndReload(104)).toBe(false)
    const reload = vi.fn()
    const unregister = registerReloadHandler(reload)
    try {
      expect(checkAndReload(104)).toBe(true)
    } finally {
      unregister()
    }
  })

  it('visible 判定：hidden 不做即时刷新，其它状态按可见处理', () => {
    expect(isPageVisible()).toBe(true)
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    try {
      visibility.mockReturnValue('hidden')
      expect(isPageVisible()).toBe(false)
      visibility.mockReturnValue('visible')
      expect(isPageVisible()).toBe(true)
    } finally {
      visibility.mockRestore()
    }
  })
})

describe('dataChangeChannel：BroadcastChannel 缺失时的 storage 回退', () => {
  it('校验 key + 形状，过滤自身 tabId 与不匹配账本，重复指纹只投递一次', () => {
    // jsdom 无 BroadcastChannel；显式 stub 以钉死 iOS 14 场景。
    vi.stubGlobal('BroadcastChannel', undefined)
    const received: DataChangeEvent[] = []
    const stop = subscribeDataChange((event) => received.push(event))
    try {
      const base: DataChangeEvent = {
        ledgerId: 201,
        seq: 1,
        reason: 'local-write',
        tabId: getTabId(),
        at: 1000,
      }
      const fire = (key: string, value: unknown): void => {
        window.dispatchEvent(
          new StorageEvent('storage', { key, newValue: JSON.stringify(value) }),
        )
      }
      // 通道层只校验 key / 形状 / 自身 tab；账本隔离由 sync.ts 桥接层比对
      // getLedgerId() 完成，这里断言通道确实把别的账本事件也送到了消费方。
      fire('unrelated-key', { ...base, tabId: 'other-tab' })
      fire(DATA_CHANGE_KEY, base)
      window.dispatchEvent(new StorageEvent('storage', { key: DATA_CHANGE_KEY, newValue: '{oops' }))
      expect(received).toEqual([])

      fire(DATA_CHANGE_KEY, { ...base, tabId: 'other-tab', ledgerId: 202 })
      expect(received).toHaveLength(1)
      expect(received[0].ledgerId).toBe(202)

      const remote: DataChangeEvent = { ...base, tabId: 'other-tab', seq: 2 }
      fire(DATA_CHANGE_KEY, remote)
      fire(DATA_CHANGE_KEY, remote) // 双通道重复投递由 tabId:seq 去重
      expect(received).toHaveLength(2)
      expect(received[1].ledgerId).toBe(201)
    } finally {
      stop()
    }
  })

  it('publish 写 storage；消费 cross-tab 不再广播，避免 A→B→A 回声', () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    publishDataChange({
      ledgerId: 205,
      seq: 1,
      reason: 'local-write',
      tabId: 'remote-tab',
      at: 1000,
    })
    expect(localStorage.getItem(DATA_CHANGE_KEY)).not.toBeNull()

    localStorage.clear()
    markDirty('cross-tab', 205)
    expect(localStorage.getItem(DATA_CHANGE_KEY)).toBeNull()
  })
})
