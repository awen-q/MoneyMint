// @vitest-environment jsdom
/**
 * P1：pull 后本地标签事件重放（§2.6）与库世代重置（D5）。
 *
 * 断言交易始终「一笔一行」：applyPullChanges 只覆盖既有 key 的 tags，
 * 不新增 uuid、不产生冲正、事件不进 pending。
 */
import 'fake-indexeddb/auto'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { SyncChange } from '@/api/types'
import type { TagEventBatch } from '@/core/tagEvents/types'
import { resetMergeNotices, subscribeMergeNotice, type MergeNotice } from '@/core/tagEvents/notice'
import { IdbSyncStore } from './idbStore'
import { MemorySyncStore, type SyncStore } from './localStore'

const UUID = 'txn-pull-1'
const UPDATED_AT = '2026-11-27T11:00:00.000Z'

function pullChange(tags: string[]): SyncChange {
  return {
    seq: 10,
    entity_type: 'transaction',
    op: 'update',
    entity: {
      uuid: UUID,
      date: '2026-11-27',
      flag: '*',
      description: '午餐',
      tags,
      tags_updated_at: UPDATED_AT,
      postings: [],
    },
  }
}

function batch(conflict = false): TagEventBatch {
  return {
    uuid: UUID,
    baseTags: ['餐饮'],
    events: [
      {
        tag: '周末',
        op: 'add',
        ts: '2026-11-27T12:00:00.000Z',
        device_id: 'web-A',
      },
      ...(conflict
        ? [{ tag: '餐饮', op: 'remove' as const, ts: '2026-11-27T12:01:00.000Z', device_id: 'web-A' }]
        : []),
    ],
    clientOpId: 'web-A:1',
  }
}

let notices: MergeNotice[]
let stopNotices: (() => void) | null = null

beforeEach(() => {
  resetMergeNotices()
  notices = []
  stopNotices = subscribeMergeNotice((notice) => notices.push(notice))
})

afterEach(() => {
  if (stopNotices !== null) {
    stopNotices()
    stopNotices = null
  }
})

async function assertPullReplay(store: SyncStore): Promise<void> {
  await store.putTagBatch(7, batch())
  await store.applyPullChanges(7, [pullChange(['餐饮', '孩子'])], 10)

  const txns = await store.getAllTxns(7)
  expect(txns.filter((txn) => txn.uuid === UUID)).toHaveLength(1)
  expect(txns[0].tags).toEqual(['周末', '孩子', '餐饮'])
  expect(txns[0].date).toBe('2026-11-27')
  const after = await store.getTagBatch(7, UUID)
  expect(after?.baseTags).toEqual(['孩子', '餐饮'])
  expect(after?.events).toHaveLength(1)
  // 事件与 pending 物理隔离。
  expect(await store.countPending(7, 'pending')).toBe(0)
}

describe('applyPullChanges + tag_events 重放', () => {
  it('MemorySyncStore：覆盖后重放，交易仍 1 行、事件不丢', async () => {
    await assertPullReplay(new MemorySyncStore())
  })

  it('IdbSyncStore：DB v2 新增 tag_events，重放与其他 store 同事务', async () => {
    const store = await IdbSyncStore.open()
    await assertPullReplay(store)
  })

  it('冲突合并只发一次 role=status 信号（同 key 去重）', async () => {
    const store = new MemorySyncStore()
    await store.putTagBatch(7, batch(true))
    await store.applyPullChanges(7, [pullChange(['餐饮', '孩子'])], 10)
    await store.applyPullChanges(7, [pullChange(['餐饮', '孩子'])], 11)

    const merged = notices.filter((notice) => notice.key === 'merged:7:txn-pull-1:web-A:1')
    expect(merged).toHaveLength(1)
    expect(merged[0].conflictCount).toBe(1)
    expect(merged[0].noticeLine).toContain('非阻断')
  })

  it('无事件时 pull 原样覆盖，不产生合并提示', async () => {
    const store = new MemorySyncStore()
    await store.applyPullChanges(7, [pullChange(['餐饮'])], 10)
    expect((await store.getAllTxns(7))[0].tags).toEqual(['餐饮'])
    expect(notices.filter((notice) => notice.key.indexOf('merged:') === 0)).toHaveLength(0)
  })

  it('quarantineAndReset 清空该 ledger 的 tag_events（D5）', async () => {
    const store = new MemorySyncStore()
    await store.putTagBatch(7, batch())
    await store.putTagBatch(8, { ...batch(), uuid: 'other' })
    await store.quarantineAndReset(7, 'new-instance')

    expect(await store.getTagBatch(7, UUID)).toBeNull()
    expect(await store.allTagBatchUuids(7)).toEqual([])
    expect(await store.getTagBatch(8, 'other')).not.toBeNull()
  })
})
