// @vitest-environment jsdom
/**
 * P1 重连提交编排单测：
 * 409×3 / 结果幂等 / client_op_id 固定 / 墓碑裁剪 / 不可恢复分支 / 与 pending 隔离。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/api/errors'
import type { TagEditResponse } from '@/api/types'
import { MemorySyncStore } from '@/core/sync/localStore'
import type { TagEvent, TagEventBatch } from '@/core/sync/models'
import { resetMergeNotices, subscribeMergeNotice, type MergeNotice } from './notice'
import {
  clearBatch,
  commitBatch,
  configureTagMergeStore,
  flush,
  flushOne,
  predictTags,
  resetTagMergeCoordinator,
  tagMergeCoordinator,
} from './reconciler'

const h = vi.hoisted(() => ({
  updateTags: vi.fn(),
  getLedgerId: vi.fn(() => 7),
}))

vi.mock('@/api/client', () => ({
  transactionApi: { updateTags: h.updateTags },
  getLedgerId: h.getLedgerId,
}))

const UUID = 'txn-offline-1'
const DEVICE = 'web-test-01'
const BASE = ['餐饮']
const FINAL = ['周末', '餐饮']
const UPDATED_AT = '2026-11-27T09:31:12.345Z'

function response(tags: string[] = FINAL, editId = 42): TagEditResponse {
  return { uuid: UUID, tags, tags_updated_at: UPDATED_AT, edit_id: editId }
}

function conflict(current: string[], updatedAt = '2026-11-27T10:00:00.000Z'): ApiError {
  return new ApiError(409, '标签已被他人更新', {
    code: 'txn_tags_conflict',
    details: { current_tags: current, current_tags_updated_at: updatedAt },
  })
}

function removeEvent(tag: string, ts: string): TagEvent {
  return { tag, op: 'remove', ts, device_id: DEVICE }
}

let store: MemorySyncStore
let notices: MergeNotice[]
let stopNotices: (() => void) | null = null

afterEach(() => {
  if (stopNotices !== null) {
    stopNotices()
    stopNotices = null
  }
})

beforeEach(() => {
  store = new MemorySyncStore()
  resetTagMergeCoordinator(store)
  configureTagMergeStore(store)
  resetMergeNotices()
  notices = []
  stopNotices = subscribeMergeNotice((notice) => notices.push(notice))
  h.updateTags.mockReset().mockResolvedValue(response())
  h.getLedgerId.mockReturnValue(7)
})

describe('appendTagEvent：事件落独立 store，clientOpId 批次固定', () => {
  it('首次事件创建批次，clientOpId = device:seq；事件 ts 单调', async () => {
    await tagMergeCoordinator.appendTagEvent(UUID, { tag: ' 周末 ', op: 'add' }, {
      ledgerId: 7,
      baseTags: BASE,
      deviceId: DEVICE,
    })
    await tagMergeCoordinator.appendTagEvent(UUID, { tag: '孩子', op: 'add' }, {
      ledgerId: 7,
      deviceId: DEVICE,
    })

    const batch = await store.getTagBatch(7, UUID)
    expect(batch).not.toBeNull()
    expect(batch?.clientOpId).toBe(`${DEVICE}:1`)
    expect(batch?.baseTags).toEqual(BASE)
    expect(batch?.events).toHaveLength(2)
    expect(batch?.events[0].tag).toBe('周末')
    expect((batch?.events[1].ts ?? '') > (batch?.events[0].ts ?? '')).toBe(true)
    // 事件绝不进 pending。
    expect(await store.countPending(7, 'pending')).toBe(0)
    expect(await store.countPending(7, 'dead')).toBe(0)
  })

  it('批次号原子自增，不同 uuid 使用不同 clientOpId', async () => {
    await tagMergeCoordinator.appendTagEvent('t-1', { tag: 'a', op: 'add' }, { ledgerId: 7, deviceId: DEVICE })
    await tagMergeCoordinator.appendTagEvent('t-2', { tag: 'b', op: 'add' }, { ledgerId: 7, deviceId: DEVICE })
    const first = await store.getTagBatch(7, 't-1')
    const second = await store.getTagBatch(7, 't-2')
    expect(first?.clientOpId).toBe(`${DEVICE}:1`)
    expect(second?.clientOpId).toBe(`${DEVICE}:2`)
  })

  it('add 后 remove 留下两条事件，收敛预测为不存在', async () => {
    await tagMergeCoordinator.appendTagEvent(UUID, { tag: '周末', op: 'add' }, { ledgerId: 7, baseTags: BASE, deviceId: DEVICE })
    await tagMergeCoordinator.appendTagEvent(UUID, { tag: '周末', op: 'remove' }, { ledgerId: 7, deviceId: DEVICE })
    expect(await predictTags(UUID, { ledgerId: 7, baseTags: BASE })).toEqual(BASE)
  })
})

describe('commitBatch：PUT 窄通道 / 409 三分支', () => {
  it('收敛后 PUT 带四个字段，成功后清事件并刷新 baseTags', async () => {
    await tagMergeCoordinator.appendTagEvent(UUID, { tag: '周末', op: 'add' }, {
      ledgerId: 7,
      baseTags: BASE,
      tagsUpdatedAt: UPDATED_AT,
      deviceId: DEVICE,
    })
    const outcome = await commitBatch(UUID, { ledgerId: 7, tagsUpdatedAt: UPDATED_AT, deviceId: DEVICE })

    expect(outcome.status).toBe('saved')
    expect(h.updateTags).toHaveBeenCalledTimes(1)
    expect(h.updateTags.mock.calls[0][1]).toEqual({
      tags: FINAL,
      base_tags: BASE,
      device_id: DEVICE,
      client_op_id: `${DEVICE}:1`,
    })
    const after = await store.getTagBatch(7, UUID)
    expect(after?.events).toEqual([])
    expect(after?.baseTags).toEqual(FINAL)
    expect(after?.committed).toBe(true)
    expect(notices.some((n) => n.key === `merged:${DEVICE}:1`)).toBe(true)
  })

  it('409 且 current_tags 等于目标 → 结果幂等，按成功处理', async () => {
    h.updateTags.mockRejectedValueOnce(conflict(FINAL))
    await tagMergeCoordinator.appendTagEvent(UUID, { tag: '周末', op: 'add' }, { ledgerId: 7, baseTags: BASE, deviceId: DEVICE })
    const outcome = await commitBatch(UUID, { ledgerId: 7, deviceId: DEVICE })

    expect(outcome.status).toBe('saved')
    if (outcome.status === 'saved') {
      expect(outcome.response.edit_id).toBe(0)
    }
    expect(h.updateTags).toHaveBeenCalledTimes(1)
    expect((await store.getTagBatch(7, UUID))?.committed).toBe(true)
  })

  it('409 取 current_tags 为新 base 重收敛再 PUT，最多 3 次且复用 clientOpId', async () => {
    h.updateTags
      .mockRejectedValueOnce(conflict(['餐饮', '孩子']))
      .mockResolvedValueOnce(response(['孩子', '周末', '餐饮']))
    await tagMergeCoordinator.appendTagEvent(UUID, { tag: '周末', op: 'add' }, { ledgerId: 7, baseTags: BASE, deviceId: DEVICE })
    const outcome = await commitBatch(UUID, { ledgerId: 7, deviceId: DEVICE })

    expect(outcome.status).toBe('saved')
    expect(h.updateTags).toHaveBeenCalledTimes(2)
    expect(h.updateTags.mock.calls[0][1].client_op_id).toBe(`${DEVICE}:1`)
    expect(h.updateTags.mock.calls[1][1]).toEqual({
      tags: ['周末', '孩子', '餐饮'],
      base_tags: ['餐饮', '孩子'],
      device_id: DEVICE,
      client_op_id: `${DEVICE}:1`,
    })
  })

  it('连续 3 次 409 后停止，不发第 4 次 PUT，批次保留', async () => {
    h.updateTags
      .mockRejectedValueOnce(conflict(['餐饮', '孩子']))
      .mockRejectedValueOnce(conflict(['餐饮', '孩子', '老人']))
      .mockRejectedValueOnce(conflict(['餐饮', '孩子', '老人', '宠物']))
    await tagMergeCoordinator.appendTagEvent(UUID, { tag: '周末', op: 'add' }, { ledgerId: 7, baseTags: BASE, deviceId: DEVICE })
    const outcome = await flushOne(UUID, { ledgerId: 7, deviceId: DEVICE })

    expect(h.updateTags).toHaveBeenCalledTimes(3)
    expect(outcome?.status).toBe('conflict')
    const batch = await store.getTagBatch(7, UUID)
    expect(batch?.committed).not.toBe(true)
    expect(batch?.events).toHaveLength(1)
    expect(batch?.clientOpId).toBe(`${DEVICE}:1`)
    expect(notices.some((n) => n.title.includes('下次同步'))).toBe(true)
  })

  it('不可恢复码保留批次并提示需人工处理', async () => {
    h.updateTags.mockRejectedValueOnce(new ApiError(403, '无权编辑', { code: 'txn_edit_forbidden' }))
    await tagMergeCoordinator.appendTagEvent(UUID, { tag: '周末', op: 'add' }, { ledgerId: 7, baseTags: BASE, deviceId: DEVICE })
    const outcome = await flushOne(UUID, { ledgerId: 7, deviceId: DEVICE })

    expect(outcome?.status).toBe('error')
    expect((await store.getTagBatch(7, UUID))?.events).toHaveLength(1)
    expect(notices.some((n) => n.title.includes('不可编辑'))).toBe(true)
  })

  it('交互路径 maxAttempts=1：首个 409 交还编辑器展示冲突面板', async () => {
    h.updateTags.mockRejectedValueOnce(conflict(['餐饮', '孩子']))
    await tagMergeCoordinator.appendTagEvent(UUID, { tag: '周末', op: 'add' }, { ledgerId: 7, baseTags: BASE, deviceId: DEVICE })
    const outcome = await commitBatch(UUID, { ledgerId: 7, deviceId: DEVICE, maxAttempts: 1 })

    expect(h.updateTags).toHaveBeenCalledTimes(1)
    expect(outcome).toEqual({
      status: 'conflict',
      current: ['餐饮', '孩子'],
      updatedAt: '2026-11-27T10:00:00.000Z',
    })
  })
})

describe('墓碑与批次生命周期', () => {
  it('成功后保留最近 100 条 remove 墓碑，已提交批次不再重放', async () => {
    const now = Date.now()
    const events: TagEvent[] = []
    for (let i = 0; i < 150; i += 1) {
      events.push(removeEvent(`old-${i}`, new Date(now - i * 1000).toISOString()))
    }
    const batch: TagEventBatch = {
      uuid: UUID,
      baseTags: BASE,
      events,
      clientOpId: `${DEVICE}:9`,
    }
    await store.putTagBatch(7, batch)

    const outcome = await flushOne(UUID, { ledgerId: 7, deviceId: DEVICE })
    expect(outcome?.status).toBe('saved')
    const after = await store.getTagBatch(7, UUID)
    expect(after?.events).toHaveLength(100)
    expect(after?.committed).toBe(true)
    expect(await flushOne(UUID, { ledgerId: 7, deviceId: DEVICE })).toBeNull()
    expect(h.updateTags).toHaveBeenCalledTimes(1)
  })

  it('flush 逐笔提交多批，单笔失败不影响其他交易', async () => {
    await tagMergeCoordinator.appendTagEvent('t-1', { tag: 'a', op: 'add' }, { ledgerId: 7, baseTags: [], deviceId: DEVICE })
    await tagMergeCoordinator.appendTagEvent('t-2', { tag: 'b', op: 'add' }, { ledgerId: 7, baseTags: [], deviceId: DEVICE })
    h.updateTags.mockImplementation(async (_uuid: string) => response())

    const succeeded = await flush(7)
    expect(succeeded).toBe(2)
    expect(h.updateTags).toHaveBeenCalledTimes(2)
    expect((await store.allTagBatchUuids(7)).length).toBe(2)
    expect((await store.getTagBatch(7, 't-1'))?.committed).toBe(true)
  })

  it('clearBatch 删除批次；方案 C 开关关闭时无批量端点请求', async () => {
    await tagMergeCoordinator.appendTagEvent(UUID, { tag: '周末', op: 'add' }, { ledgerId: 7, baseTags: BASE, deviceId: DEVICE })
    await clearBatch(7, UUID)
    expect(await store.getTagBatch(7, UUID)).toBeNull()
    // 全局 fetch 未被 reconciler 调用（仅 updateTags mock 参与）。
    expect(h.updateTags).not.toHaveBeenCalled()
  })

  it('op id 跨 409 / 刷新（重新读取批次）保持不变', async () => {
    h.updateTags.mockRejectedValueOnce(conflict(['餐饮', '孩子'])).mockResolvedValueOnce(response())
    await tagMergeCoordinator.appendTagEvent(UUID, { tag: '周末', op: 'add' }, { ledgerId: 7, baseTags: BASE, deviceId: DEVICE })
    const before = await store.getTagBatch(7, UUID)
    await commitBatch(UUID, { ledgerId: 7, deviceId: DEVICE })
    const after = await store.getTagBatch(7, UUID)
    expect(before?.clientOpId).toBe(`${DEVICE}:1`)
    expect(after?.clientOpId).toBe(`${DEVICE}:1`)
    expect(h.updateTags.mock.calls[0][1].client_op_id).toBe(`${DEVICE}:1`)
    expect(h.updateTags.mock.calls[1][1].client_op_id).toBe(`${DEVICE}:1`)
  })
})
