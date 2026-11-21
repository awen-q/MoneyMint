/**
 * 分类拖拽顺序持久化用例（§14.5 #2：写 / 读往返、按账本命名空间、损坏容错）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  categoryOrderKey,
  readCategoryOrder,
  writeCategoryOrder,
} from './storage'

let store: Map<string, string>

beforeEach(() => {
  store = new Map<string, string>()
  const getItem = vi.fn((key: string) => (store.has(key) ? store.get(key) ?? null : null))
  const setItem = vi.fn((key: string, value: string) => {
    store.set(key, value)
  })
  const removeItem = vi.fn((key: string) => {
    store.delete(key)
  })
  vi.stubGlobal('localStorage', { getItem, setItem, removeItem })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('分类顺序持久化（localStorage，按账本命名空间）', () => {
  it('写 / 读往返：分组 uuid 序列完整还原', () => {
    writeCategoryOrder(7, { Expenses: ['u-12', 'u-11', 'u-13'], Income: ['u-21'] })
    expect(readCategoryOrder(7)).toEqual({
      Expenses: ['u-12', 'u-11', 'u-13'],
      Income: ['u-21'],
    })
    // 键按账本命名空间隔离。
    expect(categoryOrderKey(7)).toBe('fambean.category_order.7')
    expect(store.has('fambean.category_order.7')).toBe(true)
  })

  it('不同账本互不干扰', () => {
    writeCategoryOrder(1, { Expenses: ['u-1'] })
    writeCategoryOrder(2, { Expenses: ['u-2'] })
    expect(readCategoryOrder(1).Expenses).toEqual(['u-1'])
    expect(readCategoryOrder(2).Expenses).toEqual(['u-2'])
  })

  it('损坏 JSON 容错为空对象，不抛错', () => {
    store.set(categoryOrderKey(7), '{broken json')
    expect(readCategoryOrder(7)).toEqual({})
  })

  it('非对象 / 数组形状容错为空对象', () => {
    store.set(categoryOrderKey(7), JSON.stringify([1, 2, 3]))
    expect(readCategoryOrder(7)).toEqual({})
    store.set(categoryOrderKey(7), JSON.stringify('oops'))
    expect(readCategoryOrder(7)).toEqual({})
  })

  it('旧格式 number[] 整组丢弃并清理，不污染 uuid 排序', () => {
    store.set(
      categoryOrderKey(7),
      JSON.stringify({ Expenses: [3, 11, 13], Income: ['u-21'] }),
    )
    expect(readCategoryOrder(7)).toEqual({ Income: ['u-21'] })
    // 脏数据已就地清理，不做「每次读都降级」的隐性负担。
    expect(store.get(categoryOrderKey(7))).toBe(JSON.stringify({ Income: ['u-21'] }))
  })

  it('旧格式 number[] 是唯一分组时清键，回落服务端 sort_order', () => {
    store.set(categoryOrderKey(7), JSON.stringify({ Expenses: [3, 11, 13] }))
    expect(readCategoryOrder(7)).toEqual({})
    expect(store.has(categoryOrderKey(7))).toBe(false)
  })

  it('非法项（空串 / 数字 / null）整组丢弃，合法 uuid 组保留', () => {
    store.set(
      categoryOrderKey(7),
      JSON.stringify({ Expenses: ['u-3', '', 5, null], Income: ['u-21'] }),
    )
    expect(readCategoryOrder(7)).toEqual({ Income: ['u-21'] })
  })

  it('无数据返回空对象（不写 localStorage）', () => {
    expect(readCategoryOrder(9)).toEqual({})
    expect(store.size).toBe(0)
  })
})
