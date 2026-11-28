/**
 * P0 存储层回归：两个 SyncStore 实现必须满足同一组契约。
 *
 * 覆盖：pending 行账本归属隔离 / 死信逐条 code-error / applyPushOutcome
 * 单事务多处置与幂等 / 旧数据（无 ledger_id）保持未知归属且不被误删。
 */
import 'fake-indexeddb/auto'

import { describe, expect, it } from 'vitest'

import { IdbSyncStore } from './idbStore'
import { MemorySyncStore, type SyncStore } from './localStore'
import type { PendingChange, PendingEntry } from './models'

const LEDGER_A = 11
const LEDGER_B = 22

function change(key: string): PendingChange {
  return { entity_type: 'transaction', key, entity: { uuid: key } }
}

/** 两个实现共用的一组断言；legacy 注入/检查由调用方提供（内存 Map vs IDB 原始行）。 */
async function assertStoreContract(
  store: SyncStore,
  injectLegacy: () => Promise<void>,
  legacyExists: () => Promise<boolean>,
): Promise<void> {
  // ① 读取严格按 ledger_id 隔离。
  const a1 = await store.recordEntry(LEDGER_A, { pending: change('a1') })
  const b1 = await store.recordEntry(LEDGER_B, { pending: change('b1') })
  expect((await store.getPending(LEDGER_A)).map((e) => e.change.key)).toEqual(['a1'])
  expect((await store.getPending(LEDGER_B)).map((e) => e.change.key)).toEqual(['b1'])
  expect(await store.countPending(LEDGER_A, 'pending')).toBe(1)

  // ② 所有涉及 pending 的写操作都带账本守卫：B 的行不能被 A 的操作改动。
  await store.markDead(LEDGER_A, [{ id: b1, code: 'wrong', error: 'wrong' }])
  await store.scheduleRetry(LEDGER_A, b1, 9, 999, 'wrong', 'wrong')
  await store.reviveDead(LEDGER_A, [b1])
  await store.discardPending(LEDGER_A, [b1])
  await store.applyPushOutcome(LEDGER_A, {
    uuidMap: {},
    removedIds: [b1],
    updates: [{ id: b1, change: change('hijacked') }],
    dead: [{ id: b1, code: 'wrong', error: 'wrong' }],
    retries: [{ id: b1, attempts: 9, nextRetryAt: 999, code: 'wrong', error: 'wrong' }],
    checkpoint: 50,
  })
  const bRows = await store.getPending(LEDGER_B, 'pending')
  expect(bRows).toHaveLength(1)
  expect(bRows[0].id).toBe(b1)
  expect(bRows[0].change.key).toBe('b1')
  expect(bRows[0].state).toBe('pending')
  expect(bRows[0].attempts).toBe(0)
  expect(await store.getLastSeq(LEDGER_B)).toBe(0)
  expect(await store.getLastSeq(LEDGER_A)).toBe(50)

  // ③ 多条死信各自保存 code/error（原共享变量 bug）。
  const a2 = await store.recordEntry(LEDGER_A, { pending: change('a2') })
  const a3 = await store.recordEntry(LEDGER_A, { pending: change('a3') })
  await store.markDead(LEDGER_A, [
    { id: a1, code: 'account_closed', error: 'err-a1' },
    { id: a2, code: 'validation', error: 'err-a2' },
    { id: a3, code: 'account_balance_not_zero', error: 'err-a3' },
  ])
  const dead = await store.getPending(LEDGER_A, 'dead')
  expect(dead.map((d) => d.last_error_code)).toEqual([
    'account_closed',
    'validation',
    'account_balance_not_zero',
  ])
  expect(dead.map((d) => d.last_error)).toEqual(['err-a1', 'err-a2', 'err-a3'])

  // ④ 四类处置一次落地，重复应用同批结果无副作用，水位单调。
  const r1 = await store.recordEntry(LEDGER_A, { pending: change('r1') })
  const r2 = await store.recordEntry(LEDGER_A, { pending: change('r2') })
  const r3 = await store.recordEntry(LEDGER_A, { pending: change('r3') })
  const outcome = {
    uuidMap: {},
    removedIds: [r1],
    updates: [] as Array<{ id: number; change: PendingChange }>,
    dead: [{ id: r2, code: 'validation', error: 'v2' }],
    retries: [{ id: r3, attempts: 1, nextRetryAt: 1_234, code: 'busy', error: 'b3' }],
    checkpoint: 90,
  }
  await store.applyPushOutcome(LEDGER_A, outcome)

  const all = await store.getPending(LEDGER_A)
  expect(all.some((e) => e.id === r1)).toBe(false)
  const deadR2 = all.find((e) => e.id === r2)
  expect(deadR2?.state).toBe('dead')
  expect(deadR2?.last_error_code).toBe('validation')
  expect(deadR2?.last_error).toBe('v2')
  const retryR3 = all.find((e) => e.id === r3)
  expect(retryR3?.state).toBe('pending')
  expect(retryR3?.attempts).toBe(1)
  expect(retryR3?.next_retry_at).toBe(1_234)
  expect(retryR3?.last_error_code).toBe('busy')
  expect(await store.getLastSeq(LEDGER_A)).toBe(90)

  // 同批结果重复应用（crash replay）：同账本、同 code/error/attempts，无副作用。
  await store.applyPushOutcome(LEDGER_A, outcome)
  const afterRepeat = await store.getPending(LEDGER_A)
  expect(afterRepeat.find((e) => e.id === r2)?.last_error_code).toBe('validation')
  const repeatR3 = afterRepeat.find((e) => e.id === r3)
  expect(repeatR3?.attempts).toBe(1)
  expect(repeatR3?.next_retry_at).toBe(1_234)
  expect(repeatR3?.last_error_code).toBe('busy')
  // 水位单调：回退的 checkpoint 不写。
  await store.applyPushOutcome(LEDGER_A, {
    uuidMap: {},
    removedIds: [],
    updates: [],
    dead: [],
    retries: [],
    checkpoint: 10,
  })
  expect(await store.getLastSeq(LEDGER_A)).toBe(90)

  // ⑤ updates 正向分支：同账本行被改写，B 账本不受影响（IDB 这条 put 此前的零覆盖点）。
  const u1 = await store.recordEntry(LEDGER_A, { pending: change('to-rewrite') })
  await store.applyPushOutcome(LEDGER_A, {
    uuidMap: {},
    removedIds: [],
    updates: [{ id: u1, change: change('rewritten') }],
    dead: [],
    retries: [],
    checkpoint: 0,
  })
  expect((await store.getPending(LEDGER_A)).find((e) => e.id === u1)?.change.key).toBe('rewritten')
  expect((await store.getPending(LEDGER_B)).map((e) => e.change.key)).toEqual(['b1'])

  // ⑥ uuidMap 正向分支（M1 回归锁）：账户重映射不抛错、实体换 key、水位推进。
  await store.recordEntry(LEDGER_A, {
    account: {
      uuid: 'loc-acc',
      name: 'Assets:Cash',
      type: 'Assets',
      open_date: '2026-01-01',
    },
    pending: change('loc-acc'),
  })
  await store.applyPushOutcome(LEDGER_A, {
    uuidMap: { 'loc-acc': 'srv-acc' },
    removedIds: [],
    updates: [],
    dead: [],
    retries: [],
    checkpoint: 100,
  })
  expect(await store.getAccount(LEDGER_A, 'srv-acc')).not.toBeNull()
  expect(await store.getAccount(LEDGER_A, 'loc-acc')).toBeNull()
  expect(await store.getLastSeq(LEDGER_A)).toBe(100)
  expect(await store.getUuidMap(LEDGER_A)).toEqual({ 'loc-acc': 'srv-acc' })

  // ⑦ 世代重置只影响本账本的 pending。
  await store.quarantineAndReset(LEDGER_A, 'new-instance')
  expect((await store.getPending(LEDGER_A, 'pending')).some((e) => e.id === b1)).toBe(false)
  expect((await store.getPending(LEDGER_B, 'pending'))[0].state).toBe('pending')

  // ⑧ 旧数据无 ledger_id：未知归属，任何账本都读不到，也不会被丢弃。
  await injectLegacy()
  expect((await store.getPending(LEDGER_A)).some((e) => e.change.key === 'legacy')).toBe(false)
  expect((await store.getPending(LEDGER_B)).some((e) => e.change.key === 'legacy')).toBe(false)
  await store.discardPending(LEDGER_A, [9001])
  await store.markDead(LEDGER_B, [{ id: 9001, code: 'x', error: 'x' }])
  expect(await legacyExists()).toBe(true)

  // ⑨ P1：写入口生成可观测摘要；retryNow 清退避但保留 attempts，跨账本不动。
  const retryId = await store.recordEntry(LEDGER_A, {
    account: {
      uuid: 'acc-observe',
      name: 'Assets:Cash',
      display_name: '现金',
      type: 'Assets',
      open_date: '2026-01-01',
    },
    pending: {
      entity_type: 'account',
      key: 'acc-observe',
      entity: { uuid: 'acc-observe', name: 'Assets:Cash', display_name: '现金' },
    },
  })
  const written = (await store.getPending(LEDGER_A)).find((entry) => entry.id === retryId)
  expect(written?.entity_type).toBe('account')
  expect(written?.op).toBe('create')
  expect(written?.entity_uuid).toBe('acc-observe')
  expect(written?.display_label).toBe('现金')
  expect(written?.created_at ?? 0).toBeGreaterThan(0)

  await store.scheduleRetry(LEDGER_A, retryId, 3, 9_999_999, 'busy', '逐条错误')
  await store.scheduleRetry(LEDGER_B, b1, 5, 8_888_888, 'other', 'other')
  await store.retryNow(LEDGER_A, [retryId, b1])
  const retried = (await store.getPending(LEDGER_A)).find((entry) => entry.id === retryId)
  expect(retried?.next_retry_at).toBe(0)
  expect(retried?.attempts).toBe(3)
  expect(retried?.last_error ?? '').toBe('')
  expect(retried?.state_changed_at ?? 0).toBeGreaterThan(0)
  const untouchedB = (await store.getPending(LEDGER_B)).find((entry) => entry.id === b1)
  expect(untouchedB?.next_retry_at).toBe(8_888_888)
  expect(untouchedB?.attempts).toBe(5)

  // 幂等：重复 retryNow 不改 attempts。
  await store.retryNow(LEDGER_A, [retryId])
  expect((await store.getPending(LEDGER_A)).find((entry) => entry.id === retryId)?.attempts).toBe(3)
  // 死信不在 retryNow 作用域内（需先 reviveDead）。
  await store.markDead(LEDGER_A, [{ id: retryId, code: 'validation', error: 'x' }])
  await store.retryNow(LEDGER_A, [retryId])
  expect((await store.getPending(LEDGER_A, 'dead')).some((entry) => entry.id === retryId)).toBe(true)
}

describe('P0：MemorySyncStore 账本隔离与单事务处置', () => {
  it('满足共享存储契约', async () => {
    const store = new MemorySyncStore()
    await assertStoreContract(
      store,
      async () => {
        const legacy: PendingEntry = {
          id: 9001,
          state: 'pending',
          attempts: 0,
          next_retry_at: 0,
          change: change('legacy'),
        }
        const pendings = (store as unknown as { pendings: Map<number, PendingEntry> }).pendings
        pendings.set(legacy.id, legacy)
      },
      async () => (store as unknown as { pendings: Map<number, PendingEntry> }).pendings.has(9001),
    )
  })
})

describe('P0：IdbSyncStore 账本隔离与单事务处置', () => {
  it('满足共享存储契约', async () => {
    const store = await IdbSyncStore.open()
    const db = (store as unknown as { db: IDBDatabase }).db
    await assertStoreContract(
      store,
      async () => {
        // 直接插入升级前形态的行：没有 ledger_id，实体字段兼用旧名 change。
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('pending', 'readwrite')
          tx.objectStore('pending').add({
            id: 9001,
            state: 'pending',
            attempts: 0,
            next_retry_at: 0,
            change: change('legacy'),
          })
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error ?? new Error('legacy insert failed'))
        })
      },
      async () =>
        new Promise<boolean>((resolve, reject) => {
          const tx = db.transaction('pending', 'readonly')
          const req = tx.objectStore('pending').get(9001)
          req.onsuccess = () => resolve(req.result !== undefined)
          req.onerror = () => reject(req.error ?? new Error('legacy read failed'))
        }),
    )
  })
})
