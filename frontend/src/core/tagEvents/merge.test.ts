// @vitest-environment jsdom
/**
 * P1 收敛内核单测（US3 并集 / LWW / 墓碑 / ts / 漂移）。
 *
 * 全部是纯函数断言，不碰网络、不碰经济事实表；ts 用固定值或 vi spy，
 * 保证 CI 上确定性。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { LocalTxn, TagEvent } from '@/core/sync/models'
import { TAG_MERGE_STRATEGY } from './config'
import {
  TAG_TOMBSTONE_DAYS,
  TAG_TOMBSTONE_KEEP,
  converge,
  hasMergeConflict,
  later,
  maxEventTs,
  mergeConflictCount,
  nextTs,
  normalizeTags,
  pruneTombstones,
  readStringArray,
  replayTagEvents,
  sameTags,
} from './merge'
import type { TagEventBatch } from './types'

const SERVER_TS = '2026-11-27T09:00:00.000Z'

function event(tag: string, op: 'add' | 'remove', ts: string, deviceId: string): TagEvent {
  return { tag, op, ts, device_id: deviceId }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('normalizeTags：唯一规范化口径', () => {
  it('trim → 丢空 → 精确去重（大小写敏感）→ 排序', () => {
    expect(normalizeTags(['  乙 ', '', '甲', '乙', 'Alpha', 'alpha', '  '])).toEqual([
      'Alpha',
      'alpha',
      '乙',
      '甲',
    ])
  })

  it('非数组 / 非字符串项安全降级', () => {
    expect(normalizeTags(undefined)).toEqual([])
    expect(normalizeTags('not-an-array')).toEqual([])
    expect(normalizeTags([1, null, '  ok  '])).toEqual(['ok'])
  })

  it('sameTags 逐项比较，readStringArray 宽松解析', () => {
    expect(sameTags(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(sameTags(['a'], ['a', 'b'])).toBe(false)
    expect(sameTags(['a', 'b'], ['b', 'a'])).toBe(false)
    expect(readStringArray(['a', 3, 'b', null])).toEqual(['a', 'b'])
    expect(readStringArray({ tags: ['a'] })).toEqual([])
  })
})

describe('later / nextTs：单调混合时钟', () => {
  it('先比 ts，ts 相同再比 device_id 字典序', () => {
    expect(
      later(
        { tag: 'x', op: 'add', ts: '2026-11-27T10:00:00.000Z', device_id: 'a' },
        { tag: 'x', op: 'remove', ts: '2026-11-27T09:00:00.000Z', device_id: 'z' },
      ),
    ).toBe(true)
    expect(
      later(
        { tag: 'x', op: 'add', ts: SERVER_TS, device_id: 'b' },
        { tag: 'x', op: 'remove', ts: SERVER_TS, device_id: 'a' },
      ),
    ).toBe(true)
    // 服务端基线 device_id='' 恒输给真实设备。
    expect(
      later(
        { tag: 'x', op: 'add', ts: SERVER_TS, device_id: '' },
        { tag: 'x', op: 'add', ts: SERVER_TS, device_id: 'web-1' },
      ),
    ).toBe(false)
  })

  it('nextTs 输出 ISO 8601 毫秒串，与后端格式一致', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-27T09:31:12.345Z'))
    expect(nextTs()).toBe('2026-11-27T09:31:12.345Z')
  })

  it('同毫秒 / 时钟回拨：基于上一条 ts +1ms，严格单调', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(SERVER_TS))
    expect(nextTs(SERVER_TS)).toBe('2026-11-27T09:00:00.001Z')
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-26T00:00:00.000Z'))
    expect(nextTs('2026-11-27T09:00:00.005Z')).toBe('2026-11-27T09:00:00.006Z')
    expect(nextTs('not-a-date')).toBe('2026-11-26T00:00:00.000Z')
  })

  it('maxEventTs 取批次内最大 ts', () => {
    expect(maxEventTs([event('a', 'add', SERVER_TS, 'a'), event('b', 'remove', '2026-11-28T00:00:00.000Z', 'a')])).toBe(
      '2026-11-28T00:00:00.000Z',
    )
    expect(maxEventTs([])).toBe('')
  })
})

describe('converge：US3 并集 + LWW + 墓碑', () => {
  it('双端各加不同标签 → 并集（服务端基线 + 本地 add）', () => {
    const result = converge(['餐饮'], SERVER_TS, [
      event('周末', 'add', '2026-11-27T10:00:00.000Z', 'dev-A'),
      event('孩子', 'add', '2026-11-27T10:01:00.000Z', 'dev-B'),
    ])
    expect(result).toEqual(['周末', '孩子', '餐饮'])
  })

  it('同 tag 两事件 ts 后者为准（墓碑胜出，与数组顺序无关）', () => {
    const earlyAdd = event('周末', 'add', '2026-11-27T10:00:00.000Z', 'dev-A')
    const lateRemove = event('周末', 'remove', '2026-11-27T10:05:00.000Z', 'dev-B')
    expect(converge(['餐饮'], SERVER_TS, [earlyAdd, lateRemove])).toEqual(['餐饮'])
    expect(converge(['餐饮'], SERVER_TS, [lateRemove, earlyAdd])).toEqual(['餐饮'])
    // add 更晚时正常复活（用户重新加回）。
    const lateAdd = event('周末', 'add', '2026-11-27T10:06:00.000Z', 'dev-A')
    expect(converge([], SERVER_TS, [lateRemove, lateAdd])).toEqual(['周末'])
  })

  it("ts 相同则 device_id 字典序大者胜，'' 服务端基线最小", () => {
    expect(
      converge(['餐饮'], SERVER_TS, [
        event('餐饮', 'remove', SERVER_TS, 'web-A'),
        event('餐饮', 'add', SERVER_TS, 'web-B'),
      ]),
    ).toEqual(['餐饮'])
    expect(converge(['餐饮'], SERVER_TS, [event('餐饮', 'remove', SERVER_TS, 'web-A')])).toEqual([])
  })

  it('陈旧本地 remove 不静默压过服务端较新的 add', () => {
    expect(converge(['餐饮'], '2026-11-27T12:00:00.000Z', [event('餐饮', 'remove', '2026-11-27T08:00:00.000Z', 'web-A')])).toEqual([
      '餐饮',
    ])
  })

  it('空 tag 事件被忽略，最终结果仍规范化', () => {
    expect(
      converge(['  餐饮 ', '餐饮'], SERVER_TS, [event('   ', 'add', '2026-11-28T00:00:00.000Z', 'a')]),
    ).toEqual(['餐饮'])
  })

  it('无事件时服务端 tags 原样规范化返回', () => {
    expect(converge(['b', 'a'], SERVER_TS, [])).toEqual(['a', 'b'])
  })
})

describe('冲突检测与墓碑裁剪', () => {
  it('同 tag 同时出现 add / remove 计为冲突（服务端基线算 add）', () => {
    const events = [event('餐饮', 'remove', '2026-11-27T10:00:00.000Z', 'a')]
    expect(mergeConflictCount(['餐饮'], SERVER_TS, events)).toBe(1)
    expect(hasMergeConflict(['餐饮'], SERVER_TS, events)).toBe(true)
    expect(hasMergeConflict([], SERVER_TS, [event('a', 'add', SERVER_TS, 'a')])).toBe(false)
  })

  it('150 条 remove 裁剪后不超过 100 条（D1）', () => {
    const now = Date.now()
    const events: TagEvent[] = []
    for (let i = 0; i < 150; i += 1) {
      events.push(event(`t${i}`, 'remove', new Date(now - i * 1000).toISOString(), 'a'))
    }
    const pruned = pruneTombstones(events)
    expect(pruned.length).toBe(TAG_TOMBSTONE_KEEP)
    expect(pruned[0].tag).toBe('t0')
  })

  it('超过 30 天的墓碑被丢弃（超出 keep 条时按时间窗裁剪）', () => {
    const now = Date.now()
    const old = new Date(now - (TAG_TOMBSTONE_DAYS + 1) * 86_400_000).toISOString()
    const fresh = new Date(now - 1000).toISOString()
    const events: TagEvent[] = []
    for (let i = 0; i < 110; i += 1) {
      events.push(event(`old-${i}`, 'remove', old, 'a'))
    }
    events.push(event('fresh', 'remove', fresh, 'a'))
    const pruned = pruneTombstones(events)
    expect(pruned).toHaveLength(1)
    expect(pruned[0].tag).toBe('fresh')
    // 未超上限时按伪代码直接保留（含旧墓碑），由下一轮超限裁剪清理。
    expect(pruneTombstones([event('old', 'remove', old, 'a')])).toHaveLength(1)
  })

  it('add 事件不会被当作墓碑保留', () => {
    expect(
      pruneTombstones([event('a', 'add', '2026-11-27T10:00:00.000Z', 'a'), event('b', 'remove', '2026-11-27T10:01:00.000Z', 'a')]),
    ).toEqual([event('b', 'remove', '2026-11-27T10:01:00.000Z', 'a')])
  })

  it('方案 C 默认关闭，只留开关位', () => {
    expect(TAG_MERGE_STRATEGY).toBe('client')
  })
})

describe('replayTagEvents：pull 后重放', () => {
  const txn: LocalTxn = {
    uuid: 't-1',
    date: '2026-11-27',
    flag: '*',
    description: '午餐',
    tags: ['餐饮', '孩子'],
    tags_updated_at: '2026-11-27T11:00:00.000Z',
    postings: [],
  }

  it('无批次时不改实体，「一笔一行」语义不变', () => {
    const result = replayTagEvents(txn, null)
    expect(result.entity).toBe(txn)
    expect(result.batch).toBeNull()
    expect(result.conflictCount).toBe(0)
  })

  it('有事件时覆盖 tags 为预测值并刷新 baseTags', () => {
    const batch: TagEventBatch = {
      uuid: 't-1',
      baseTags: ['餐饮'],
      events: [event('周末', 'add', '2026-11-27T12:00:00.000Z', 'web-A')],
      clientOpId: 'web-A:1',
    }
    const result = replayTagEvents(txn, batch)
    expect(result.entity.tags).toEqual(['周末', '孩子', '餐饮'])
    expect(result.entity.uuid).toBe(txn.uuid)
    expect(result.batch?.baseTags).toEqual(['孩子', '餐饮'])
    expect(result.batch?.conflictMerged).toBe(false)
    expect(result.conflictCount).toBe(0)
  })

  it('冲突时置 conflictMerged 并返回冲突标签数', () => {
    const batch: TagEventBatch = {
      uuid: 't-1',
      baseTags: ['餐饮'],
      events: [event('餐饮', 'remove', '2026-11-27T12:00:00.000Z', 'web-A')],
      clientOpId: 'web-A:2',
    }
    const result = replayTagEvents(txn, batch)
    expect(result.entity.tags).toEqual(['孩子'])
    expect(result.batch?.conflictMerged).toBe(true)
    expect(result.conflictCount).toBe(1)
  })
})
