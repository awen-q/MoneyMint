/**
 * 筛选 query 化用例（AC-16：写 / 读往返还原、非法值容错、筛选应用）
 */
import { describe, expect, it } from 'vitest'

import {
  SERVER_FILTER_KEYS,
  emptyFilters,
  filtersFromQuery,
  filtersToQuery,
  filtersToServerQuery,
  hasActiveFilters,
} from './filters'

describe('筛选 query 化（AC-16）', () => {
  it('写 / 读往返还原：全部字段都进 query 并能完整还原', () => {
    const filters = {
      from: '2026-11-01',
      to: '2026-11-09',
      kind: 'transfer' as const,
      account: 2,
      category: 4,
      member: '阿文',
      tag: '出差',
      keyword: '火锅',
    }
    const query = filtersToQuery(filters)
    expect(query).toEqual({
      from: '2026-11-01',
      to: '2026-11-09',
      kind: 'transfer',
      account: '2',
      category: '4',
      member: '阿文',
      tag: '出差',
      q: '火锅',
    })
    expect(filtersFromQuery(query)).toEqual(filters)
  })

  it('空筛选产出干净 query（空值省略），还原回默认值', () => {
    const filters = emptyFilters()
    expect(filtersToQuery(filters)).toEqual({})
    expect(filtersFromQuery({})).toEqual(filters)
    expect(hasActiveFilters(filters)).toBe(false)
  })

  it('非法值容错：坏日期 / 坏枚举 / 坏 id 一律回退默认，不抛错', () => {
    const restored = filtersFromQuery({
      from: '2026/11/01',
      to: 'not-a-date',
      kind: 'hack',
      account: '-3',
      category: 'abc',
    })
    expect(restored).toEqual(emptyFilters())
  })

  it('vue-router 数组形状的 query 取第一个值', () => {
    expect(filtersFromQuery({ member: ['阿文', '太太'] }).member).toBe('阿文')
    expect(filtersFromQuery({ account: ['2', '9'] }).account).toBe(2)
  })

  it('hasActiveFilters 随任一字段生效而变化', () => {
    const filters = emptyFilters()
    filters.kind = 'expense'
    expect(hasActiveFilters(filters)).toBe(true)
    filters.kind = 'all'
    filters.from = '2026-11-01'
    expect(hasActiveFilters(filters)).toBe(true)
  })
})

describe('关键词（B3）：query 化与激活判定', () => {
  it('hasActiveFilters：有关键词为 true，纯空格为 false', () => {
    expect(hasActiveFilters({ ...emptyFilters(), keyword: '火锅' })).toBe(true)
    // 纯空格不算激活：否则敲一个空格就冒出「清除筛选」按钮
    expect(hasActiveFilters({ ...emptyFilters(), keyword: '   ' })).toBe(false)
    expect(hasActiveFilters({ ...emptyFilters(), keyword: '' })).toBe(false)
  })

  it('query 往返：keyword → ?q=火锅 → 读回原值', () => {
    const filters = { ...emptyFilters(), keyword: '火锅' }
    const query = filtersToQuery(filters)
    expect(query).toEqual({ q: '火锅' })
    expect(filtersFromQuery(query).keyword).toBe('火锅')
  })

  it('空关键词不出现在 query 里（URL 保持干净）', () => {
    expect(filtersToQuery(emptyFilters())).not.toHaveProperty('q')
    // 纯空格同样不写出，与 hasActiveFilters 的 trim 判据保持一致
    expect(filtersToQuery({ ...emptyFilters(), keyword: '   ' })).not.toHaveProperty('q')
  })

  it('q 缺失 / 数组形状 / 空串一律回退默认值', () => {
    expect(filtersFromQuery({}).keyword).toBe('')
    expect(filtersFromQuery({ q: ['火锅', '烤肉'] }).keyword).toBe('火锅')
    expect(filtersFromQuery({ q: '' }).keyword).toBe('')
  })
})

describe('标签维度（B3/T32）：单值、URL 与请求两条通路同口径', () => {
  it('query 往返：非空才写出，能完整还原', () => {
    const filters = { ...emptyFilters(), tag: '出差' }
    const query = filtersToQuery(filters)
    expect(query.tag).toBe('出差')
    expect(filtersFromQuery(query).tag).toBe('出差')
  })

  it('空串不写出 tag 键（URL 干净）', () => {
    expect(filtersToQuery(emptyFilters())).toEqual({})
  })

  it('hasActiveFilters 认 tag，清空后回落 false', () => {
    const filters = { ...emptyFilters(), tag: '出差' }
    expect(hasActiveFilters(filters)).toBe(true)
    filters.tag = ''
    expect(hasActiveFilters(filters)).toBe(false)
  })

})

describe('服务端查询序列化（T32）：白名单与「URL ≠ 请求」', () => {
  it('空筛选 + 无分页选项时输出空对象', () => {
    expect(filtersToServerQuery(emptyFilters())).toEqual({})
  })

  it('输出键严格是白名单子集（排序比对，不是 toContain）', () => {
    const filters = {
      ...emptyFilters(),
      from: '2026-11-01',
      to: '2026-11-30',
      kind: 'expense' as const,
      account: 1,
      category: 4,
      member: '阿文',
      tag: '出差',
      keyword: '火锅',
    }
    const query = filtersToServerQuery(filters)
    const keys = Object.keys(query).sort()
    const allowed = [...SERVER_FILTER_KEYS].sort()
    expect(keys.filter((key) => allowed.indexOf(key) < 0)).toEqual([])
    expect(keys).toEqual(['account', 'category', 'from', 'kind', 'member', 'q', 'tag', 'to'])
  })

  it('页面状态键（view / ym / day）绝不进入请求', () => {
    // 用带多余属性的对象模拟「从 URL 里读到的完整 query」
    const dirty = { ...emptyFilters(), view: 'calendar', ym: '2026-11', day: '16' }
    const query = filtersToServerQuery(dirty as typeof dirty)
    expect(Object.keys(query).indexOf('view')).toBe(-1)
    expect(Object.keys(query).indexOf('ym')).toBe(-1)
    expect(Object.keys(query).indexOf('day')).toBe(-1)
  })

  it('limit / cursor 只在显式传入时出现；limit=0 是合法值（导出用）', () => {
    const filters = emptyFilters()
    expect(filtersToServerQuery(filters).limit).toBeUndefined()
    expect(filtersToServerQuery(filters, { limit: 20 }).limit).toBe('20')
    expect(filtersToServerQuery(filters, { limit: 0 }).limit).toBe('0')
    expect(filtersToServerQuery(filters, { cursor: 'abc' }).cursor).toBe('abc')
    // 空串游标 = 不传（首屏），避免发出 `cursor=` 让后端当成无效游标
    expect(filtersToServerQuery(filters, { cursor: '' }).cursor).toBeUndefined()
  })

  it('纯空白关键词不发出（与 hasActiveFilters 口径一致）', () => {
    const filters = { ...emptyFilters(), keyword: '   ' }
    expect(filtersToServerQuery(filters)).toEqual({})
  })
})
