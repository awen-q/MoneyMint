/**
 * A-03 回归：pull 的 transaction op=update 为整条覆盖，
 * Memory 与 IndexedDB 两个实现都必须保留 reversed_by 标记且不丢既有字段。
 *
 * 服务端 loadEntity 在交易被冲正后输出完整实体 + reversed_by（A-02），
 * 本地 applyPullChanges 对该 op 已是整条覆盖，不需要新增同步 op、不升协议版本。
 * fake-indexeddb 是仓库既有 devDependency，本用例不引入任何新依赖。
 */
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'

import { IdbSyncStore } from './idbStore'
import { MemorySyncStore, type SyncStore } from './localStore'
import type { LocalTxn } from './models'
import type { SyncChange } from '@/api/types'

const LID = 1

function baseTxn(): LocalTxn {
  return {
    uuid: 'txn-1',
    date: '2026-11-01',
    flag: '*',
    description: '早餐',
    tags: ['food'],
    reversed_of: 'txn-0',
    created_by_name: '阿文',
    postings: [
      { account_uuid: 'acc-cash', commodity: 'CNY', amount: '-12.50' },
      { account_uuid: 'acc-food', commodity: 'CNY', amount: '12.50' },
    ],
  }
}

/** 服务端下发的全量实体：既有字段全部保留，额外带 reversed_by。 */
function pullUpdate(): SyncChange {
  const full = { ...baseTxn(), reversed_by: 'rev-1' }
  return {
    seq: 2,
    entity_type: 'transaction',
    op: 'update',
    entity: { ...full },
  }
}

function pending() {
  return {
    entity_type: 'transaction' as const,
    key: 'txn-1',
    entity: { uuid: 'txn-1' },
  }
}

async function assertUpdateKeepsReversedBy(store: SyncStore): Promise<void> {
  await store.recordEntry(LID, { txn: baseTxn(), pending: pending() })
  await store.applyPullChanges(LID, [pullUpdate()], 2)

  const txns = await store.getAllTxns(LID)
  expect(txns.length).toBe(1)
  expect(txns[0].reversed_by).toBe('rev-1')
  // 整条覆盖下既有字段不丢：冲正关系、标签、创建人、分录。
  expect(txns[0].reversed_of).toBe('txn-0')
  expect(txns[0].tags).toEqual(['food'])
  expect(txns[0].created_by_name).toBe('阿文')
  expect(txns[0].description).toBe('早餐')
  expect(txns[0].postings.length).toBe(2)
  expect(txns[0].postings[0].account_uuid).toBe('acc-cash')
  // 水位按本次 pull 单调推进。
  expect(await store.getLastSeq(LID)).toBe(2)
}

describe('A-03：pull op=update 带 reversed_by 的整条覆盖', () => {
  it('MemorySyncStore 保留冲正标记且不丢既有字段', async () => {
    await assertUpdateKeepsReversedBy(new MemorySyncStore())
  })

  it('IdbSyncStore 保留冲正标记且不丢既有字段', async () => {
    const store = await IdbSyncStore.open()
    await assertUpdateKeepsReversedBy(store)
  })
})
