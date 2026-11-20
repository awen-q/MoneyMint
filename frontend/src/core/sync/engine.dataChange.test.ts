/**
 * T01 回归：SyncEngine 只在「真实变更」时发一次 DataChangeEvent。
 *
 * 守住的口径：
 * - 两轮 pull 聚合为一次事件，60s 空心跳不发（避免每分钟全设备无谓重拉）；
 * - 世代重置单独归因为 generation-reset；
 * - 非 leader 标签页自己不发事件（租约协议零改动，靠跨 tab 广播补刷新）。
 */
import { describe, expect, it } from 'vitest'

import { SyncEngine, type DataChangeEvent, type SyncApiClient } from './engine'
import { MemorySyncStore } from './localStore'
import type { SyncChange, SyncPullResponse, SyncPushResponse } from '@/api/types'

const LID = 7
const INSTANCE = 'instance-stable'

function change(seq: number): SyncChange {
  return {
    seq,
    entity_type: 'transaction',
    op: 'update',
    entity: { uuid: `txn-${seq}`, date: '2026-11-20', postings: [] },
  }
}

function pullResp(changes: SyncChange[], checkpoint: number, instanceId = INSTANCE): SyncPullResponse {
  return { instance_id: instanceId, checkpoint, changes }
}

function makeApi(pulls: SyncPullResponse[]): SyncApiClient {
  return {
    async pull(): Promise<SyncPullResponse> {
      const next = pulls.shift()
      if (next === undefined) throw new Error('pull 脚本耗尽')
      return next
    },
    async push(): Promise<SyncPushResponse> {
      throw new Error('本用例无 pending，不应触发 push')
    },
  }
}

describe('SyncEngine：数据变更事件', () => {
  it('pull 到非空 changes → 恰好一次 pull-changes 事件', async () => {
    const events: DataChangeEvent[] = []
    const engine = new SyncEngine(
      new MemorySyncStore(),
      makeApi([pullResp([change(1)], 1), pullResp([], 1)]),
      () => LID,
    )
    engine.subscribeDataChange((event) => events.push(event))

    expect(await engine.sync()).toBe('ok')
    expect(events).toHaveLength(1)
    expect(events[0].reason).toBe('pull-changes')
    expect(events[0].ledgerId).toBe(LID)
    expect(events[0].seq).toBe(1)
    expect(events[0].tabId).not.toBe('')
    expect(events[0].at).toBeGreaterThan(0)

    const unsubscribe = engine.subscribeDataChange(() => undefined)
    unsubscribe()
  })

  it('两轮 pull 都为空（checkpoint=0）→ 不发事件', async () => {
    const events: DataChangeEvent[] = []
    const engine = new SyncEngine(
      new MemorySyncStore(),
      makeApi([pullResp([], 0), pullResp([], 0)]),
      () => LID,
    )
    engine.subscribeDataChange((event) => events.push(event))

    expect(await engine.sync()).toBe('ok')
    expect(events).toEqual([])
  })

  it('世代号不匹配 → 一次 generation-reset 事件（两轮 pull 聚合）', async () => {
    const store = new MemorySyncStore()
    await store.setInstanceId(LID, 'old-instance')
    const events: DataChangeEvent[] = []
    const engine = new SyncEngine(
      store,
      makeApi([
        pullResp([], 0, 'new-instance'),
        pullResp([change(9)], 9, 'new-instance'),
        pullResp([], 9, 'new-instance'),
      ]),
      () => LID,
    )
    engine.subscribeDataChange((event) => events.push(event))

    expect(await engine.sync()).toBe('ok')
    expect(events).toHaveLength(1)
    expect(events[0].reason).toBe('generation-reset')
  })

  it('非 leader 标签页（租约被占用）不发事件，也不消耗 pull 脚本', async () => {
    const store = new MemorySyncStore()
    // 另一个 tab 持有租约：本 tab 的 tryAcquireLease 必然失败。
    expect(await store.tryAcquireLease('other-tab', Date.now(), 90_000)).toBe(true)
    const events: DataChangeEvent[] = []
    const api = makeApi([pullResp([change(1)], 1), pullResp([], 1)])
    const engine = new SyncEngine(store, api, () => LID)
    engine.subscribeDataChange((event) => events.push(event))

    expect(await engine.sync()).toBe('skipped')
    expect(events).toEqual([])
  })
})
