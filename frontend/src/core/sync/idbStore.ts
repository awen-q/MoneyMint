/**
 * IndexedDB 实现（生产）——与 MemorySyncStore 同接口 `SyncStore`。
 *
 * §6.6.1 #2：三个原子操作各自在**单个 readwrite 事务**里跨
 * accounts / txns / pending / meta / uuid_map 五个 store 完成；
 * 事务失败自动回滚，崩溃只能落在事务边界外、重放幂等。
 *
 * P0 修复：`applyPushOutcome` 将删除 / 合并 / 死信 / 重试四类处置放进
 * 同一个 ALL_STORES 事务；pending 行写入 `ledger_id`，所有读写严格按
 * 账本归属守卫；`markDead` 逐条保存 code/error。
 *
 * Safari 14.1 兼容：只用最基础的 IDB API（open / transaction / objectStore /
 * get / put / delete / getAll + IDBKeyRange），不用 cursor 高级特性。
 */
import { describePendingChange } from './models'
import type {
  LocalAccount,
  LocalTxn,
  PendingChange,
  PendingEntry,
  TagEventBatch,
} from './models'
import type { SyncChange } from '@/api/types'
import { replayTagEvents } from '@/core/tagEvents/merge'
import { notifyMergeSuccess } from '@/core/tagEvents/notice'
import {
  ownsPendingRow,
  type ApplyPushOutcomeInput,
  type ApplyPushResultsInput,
  type DeadOutcome,
  type MemorySyncStore,
  type RecordEntryInput,
  type SyncStore,
} from './localStore'

const DB_NAME = 'fambean-sync'
/** P1：1→2 纯加法升级，只新增 tag_events；既有 5 个 store 不删不重建。 */
const DB_VERSION = 2
const S_ACCOUNTS = 'accounts'
const S_TXNS = 'txns'
const S_PENDING = 'pending'
const S_META = 'meta'
const S_UUID_MAP = 'uuid_map'
const S_TAG_EVENTS = 'tag_events'

const ALL_STORES = [S_ACCOUNTS, S_TXNS, S_PENDING, S_META, S_UUID_MAP, S_TAG_EVENTS]

/** pending 物理行。`v` 是新口径，`change` 只用于兼容升级前写入的旧行。 */
interface PendingRow {
  id: number
  ledger_id?: number
  state: 'pending' | 'dead'
  attempts: number
  next_retry_at: number
  last_error_code?: string
  last_error?: string
  entity_type?: PendingEntry['entity_type']
  op?: PendingEntry['op']
  entity_uuid?: string
  display_label?: string
  created_at?: number
  state_changed_at?: number
  last_attempt_at?: number
  v?: PendingChange
  change?: PendingChange
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(S_ACCOUNTS)) db.createObjectStore(S_ACCOUNTS)
      if (!db.objectStoreNames.contains(S_TXNS)) db.createObjectStore(S_TXNS)
      if (!db.objectStoreNames.contains(S_PENDING)) {
        db.createObjectStore(S_PENDING, { keyPath: 'id', autoIncrement: true })
      }
      if (!db.objectStoreNames.contains(S_META)) db.createObjectStore(S_META)
      if (!db.objectStoreNames.contains(S_UUID_MAP)) db.createObjectStore(S_UUID_MAP)
      if (!db.objectStoreNames.contains(S_TAG_EVENTS)) db.createObjectStore(S_TAG_EVENTS)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
  })
}

function reqAs<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
  })
}

export class IdbSyncStore implements SyncStore {
  readonly persistent = true
  private constructor(private db: IDBDatabase) {}

  static async open(): Promise<IdbSyncStore> {
    return new IdbSyncStore(await openDB())
  }

  private entityKey(ledgerId: number, uuid: string): string {
    return `${ledgerId}:${uuid}`
  }

  private metaKey(name: string): string {
    return name
  }

  /** 单 readwrite 事务跑完一批操作；任一步失败整体回滚。 */
  private tx<T>(stores: string[], body: (t: IDBTransaction) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const tx = this.db.transaction(stores, 'readwrite')
      let result: T
      tx.oncomplete = () => resolve(result)
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB tx failed'))
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB tx aborted'))
      body(tx)
        .then((r) => {
          result = r
        })
        .catch((cause) => {
          try {
            tx.abort()
          } catch {
            /* 已提交/中止时忽略 */
          }
          reject(cause)
        })
    })
  }

  async getAllAccounts(ledgerId: number): Promise<LocalAccount[]> {
    const tx = this.db.transaction(S_ACCOUNTS, 'readonly')
    const rows = await reqAs(tx.objectStore(S_ACCOUNTS).getAll() as IDBRequest<Array<{ k: string; v: LocalAccount }>>)
    const prefix = `${ledgerId}:`
    return rows.filter((r) => r.k.startsWith(prefix)).map((r) => r.v)
  }

  async getAllTxns(ledgerId: number): Promise<LocalTxn[]> {
    const tx = this.db.transaction(S_TXNS, 'readonly')
    const rows = await reqAs(tx.objectStore(S_TXNS).getAll() as IDBRequest<Array<{ k: string; v: LocalTxn }>>)
    const prefix = `${ledgerId}:`
    return rows
      .filter((r) => r.k.startsWith(prefix))
      .map((r) => r.v)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  }

  async getAccount(ledgerId: number, uuid: string): Promise<LocalAccount | null> {
    const tx = this.db.transaction(S_ACCOUNTS, 'readonly')
    const row = await reqAs(
      tx.objectStore(S_ACCOUNTS).get(this.entityKey(ledgerId, uuid)) as IDBRequest<
        { k: string; v: LocalAccount } | undefined
      >,
    )
    return row === undefined ? null : row.v
  }

  async getClientId(): Promise<string> {
    const tx = this.db.transaction(S_META, 'readonly')
    const row = await reqAs(
      tx.objectStore(S_META).get(this.metaKey('client_id')) as IDBRequest<{ v: string } | undefined>,
    )
    if (row !== undefined) return row.v
    const id = `web-${Date.now()}`
    await this.tx([S_META], async (t) => {
      t.objectStore(S_META).put({ v: id }, this.metaKey('client_id'))
      await Promise.resolve()
    })
    return id
  }

  async getLastSeq(ledgerId: number): Promise<number> {
    const tx = this.db.transaction(S_META, 'readonly')
    const row = await reqAs(
      tx.objectStore(S_META).get(this.metaKey(`seq.${ledgerId}`)) as IDBRequest<{ v: number } | undefined>,
    )
    return row === undefined ? 0 : row.v
  }

  async getInstanceId(ledgerId: number): Promise<string | null> {
    const tx = this.db.transaction(S_META, 'readonly')
    const row = await reqAs(
      tx.objectStore(S_META).get(this.metaKey(`instance.${ledgerId}`)) as IDBRequest<
        { v: string } | undefined
      >,
    )
    return row === undefined ? null : row.v
  }

  async setInstanceId(ledgerId: number, id: string): Promise<void> {
    await this.tx([S_META], async (t) => {
      t.objectStore(S_META).put({ v: id }, this.metaKey(`instance.${ledgerId}`))
      await Promise.resolve()
    })
  }

  async recordEntry(ledgerId: number, input: RecordEntryInput): Promise<number> {
    return this.tx([S_ACCOUNTS, S_TXNS, S_PENDING], async (t) => {
      if (input.account !== undefined) {
        t.objectStore(S_ACCOUNTS).put(
          { k: this.entityKey(ledgerId, input.account.uuid), v: input.account },
          this.entityKey(ledgerId, input.account.uuid),
        )
      }
      if (input.txn !== undefined) {
        t.objectStore(S_TXNS).put(
          { k: this.entityKey(ledgerId, input.txn.uuid), v: input.txn },
          this.entityKey(ledgerId, input.txn.uuid),
        )
      }
      // P0：显式写归属；`v` 与 getPending / applyPushOutcome 的字段名保持一致。
      // P1：摘要就地生成，UI 无需解析实体；时间戳给失败时间倒序用。
      const now = Date.now()
      const entry: Omit<PendingRow, 'id'> = {
        ledger_id: ledgerId,
        state: 'pending',
        attempts: 0,
        next_retry_at: 0,
        created_at: now,
        state_changed_at: now,
        ...describePendingChange(input.pending),
        v: input.pending,
      }
      const id = await reqAs(t.objectStore(S_PENDING).add(entry) as IDBRequest<IDBValidKey>)
      return Number(id)
    })
  }

  /** 兼容公开 API：四类处置中的死信/重试为空，等价于旧版行为。 */
  async applyPushResults(ledgerId: number, input: ApplyPushResultsInput): Promise<void> {
    await this.applyOutcome(ledgerId, { ...input, dead: [], retries: [] })
  }

  /** 引擎主路径：四类处置合并为单个 ALL_STORES 事务。 */
  async applyPushOutcome(ledgerId: number, input: ApplyPushOutcomeInput): Promise<void> {
    await this.applyOutcome(ledgerId, input)
  }

  private async applyOutcome(ledgerId: number, input: ApplyPushOutcomeInput): Promise<void> {
    await this.tx([...ALL_STORES], async (t) => {
      const mapStore = t.objectStore(S_UUID_MAP)
      const mapRow =
        (await reqAs(mapStore.get(String(ledgerId)) as IDBRequest<Record<string, string> | undefined>)) ?? {}
      const accStore = t.objectStore(S_ACCOUNTS)
      const txnStore = t.objectStore(S_TXNS)

      for (const [localUuid, serverUuid] of Object.entries(input.uuidMap)) {
        // §6.6.1 #3：映射先落库（与删 pending 同事务），崩溃后可回放。
        mapRow[localUuid] = serverUuid
        // 实体重映射。
        const accRow = (await reqAs(
          accStore.get(this.entityKey(ledgerId, localUuid)) as IDBRequest<
            { k: string; v: LocalAccount } | undefined
          >,
        )) ?? null
        if (accRow !== null) {
          accStore.delete(accRow.k)
          // accounts store 无 keyPath，必须显式传 key（与 txnStore.put 一致）。
          accStore.put(
            { k: this.entityKey(ledgerId, serverUuid), v: { ...accRow.v, uuid: serverUuid } },
            this.entityKey(ledgerId, serverUuid),
          )
        }
        const txnRows = (await reqAs(
          txnStore.getAll() as IDBRequest<Array<{ k: string; v: LocalTxn }>>,
        )) ?? []
        for (const row of txnRows) {
          if (!row.k.startsWith(`${ledgerId}:`)) continue
          if (!row.v.postings.some((p) => p.account_uuid === localUuid)) continue
          txnStore.put(
            {
              k: row.k,
              v: {
                ...row.v,
                postings: row.v.postings.map((p) =>
                  p.account_uuid === localUuid ? { ...p, account_uuid: serverUuid } : p,
                ),
              },
            },
            row.k,
          )
        }
      }
      if (Object.keys(mapRow).length > 0) {
        mapStore.put(mapRow, String(ledgerId))
      }

      const pendingStore = t.objectStore(S_PENDING)
      const readRow = (id: number): Promise<PendingRow | undefined> =>
        reqAs(pendingStore.get(id) as IDBRequest<PendingRow | undefined>)

      // 删除：账本守卫，绝不跨账本移除别人的待推项。
      for (const id of new Set(input.removedIds)) {
        const row = await readRow(id)
        if (ownsPendingRow(row, ledgerId)) pendingStore.delete(id)
      }
      // 引用改写（合并重映射）：同样带账本守卫。
      for (const u of input.updates) {
        const row = await readRow(u.id)
        if (ownsPendingRow(row, ledgerId)) {
          // pending store 有 keyPath=id，不能用显式 key（IndexedDB 会抛 DataError）。
          pendingStore.put({ ...(row as PendingRow), v: u.change })
        }
      }
      // 死信：逐条 code/error，只对仍为 pending 的同账本行生效（幂等）。
      const changedAt = Date.now()
      for (const item of input.dead) {
        const row = await readRow(item.id)
        if (ownsPendingRow(row, ledgerId) && row.state === 'pending') {
          pendingStore.put(
            {
              ...(row as PendingRow),
              state: 'dead',
              last_error_code: item.code,
              last_error: item.error,
              state_changed_at: changedAt,
              last_attempt_at: changedAt,
            },
          )
        }
      }
      // 重试：逐条落盘，重复应用不会二次写坏 attempts。
      for (const item of input.retries) {
        const row = await readRow(item.id)
        if (ownsPendingRow(row, ledgerId) && row.state === 'pending') {
          pendingStore.put(
            {
              ...(row as PendingRow),
              attempts: item.attempts,
              next_retry_at: item.nextRetryAt,
              last_error_code: item.code,
              last_error: item.error,
              state_changed_at: changedAt,
              last_attempt_at: changedAt,
            },
          )
        }
      }

      // 水位单调推进（回退不写）。
      const metaStore = t.objectStore(S_META)
      const seqRow = (await reqAs(
        metaStore.get(this.metaKey(`seq.${ledgerId}`)) as IDBRequest<{ v: number } | undefined>,
      )) ?? undefined
      const cur = seqRow === undefined ? 0 : seqRow.v
      if (input.checkpoint > cur) {
        metaStore.put({ v: input.checkpoint }, this.metaKey(`seq.${ledgerId}`))
      }
    })
  }

  async applyPullChanges(ledgerId: number, changes: SyncChange[], checkpoint: number): Promise<void> {
    // tag_events 加入同一 readwrite 事务：读事件 → 收敛 → 写 txns / 批次原子完成。
    await this.tx([S_ACCOUNTS, S_TXNS, S_META, S_TAG_EVENTS], async (t) => {
      const accStore = t.objectStore(S_ACCOUNTS)
      const txnStore = t.objectStore(S_TXNS)
      const tagStore = t.objectStore(S_TAG_EVENTS)
      for (const c of changes) {
        const uuid = c.entity['uuid']
        if (typeof uuid !== 'string' || uuid === '') continue
        const rawOp = c.op as string | undefined
        const op: string = rawOp === undefined || rawOp === '' ? 'create' : rawOp
        const key = this.entityKey(ledgerId, uuid)
        if (op === 'create' || op === 'update') {
          if (c.entity_type === 'account') {
            const prev =
              (await reqAs(accStore.get(key) as IDBRequest<{ k: string; v: LocalAccount } | undefined>)) ?? null
            accStore.put(
              { k: key, v: { ...(prev?.v ?? {}), ...(c.entity as unknown as LocalAccount) } },
              key,
            )
          } else if (c.entity_type === 'transaction') {
            // P1：整条覆盖后重放本地事件，交易仍 1 行；写回新 CAS 基线。
            const server = c.entity as unknown as LocalTxn
            const row = await reqAs(
              tagStore.get(key) as IDBRequest<{ k: string; v: TagEventBatch } | undefined>,
            )
            const replay = replayTagEvents(server, row === undefined ? null : row.v)
            txnStore.put({ k: key, v: replay.entity }, key)
            if (replay.batch !== null) {
              tagStore.put({ k: key, v: replay.batch }, key)
              if (replay.conflictCount > 0) {
                notifyMergeSuccess(`${ledgerId}:${uuid}:${replay.batch.clientOpId}`, replay.conflictCount)
              }
            }
          }
        } else if (op === 'close') {
          const prev =
            (await reqAs(accStore.get(key) as IDBRequest<{ k: string; v: LocalAccount } | undefined>)) ?? null
          if (prev !== null) {
            accStore.put(
              {
                k: key,
                v: { ...prev.v, close_date: (c.entity['close_date'] as string | undefined) ?? '' },
              },
              key,
            )
          }
        } else if (op === 'delete') {
          if (c.entity_type === 'transaction') {
            txnStore.delete(key)
          } else if (c.entity_type === 'account') {
            const prev =
              (await reqAs(accStore.get(key) as IDBRequest<{ k: string; v: LocalAccount } | undefined>)) ?? null
            if (prev !== null) {
              accStore.put(
                {
                  k: key,
                  v: { ...prev.v, close_date: (c.entity['close_date'] as string | undefined) ?? '' },
                },
                key,
              )
            }
          }
        }
      }
      const metaStore = t.objectStore(S_META)
      const seqRow = (await reqAs(
        metaStore.get(this.metaKey(`seq.${ledgerId}`)) as IDBRequest<{ v: number } | undefined>,
      )) ?? undefined
      const cur = seqRow === undefined ? 0 : seqRow.v
      if (checkpoint > cur) {
        metaStore.put({ v: checkpoint }, this.metaKey(`seq.${ledgerId}`))
      }
    })
  }

  async getPending(ledgerId: number, state?: 'pending' | 'dead'): Promise<PendingEntry[]> {
    const tx = this.db.transaction(S_PENDING, 'readonly')
    const rows =
      (await reqAs(
        tx.objectStore(S_PENDING).getAll() as IDBRequest<PendingRow[]>,
      )) ?? []
    const out: PendingEntry[] = []
    for (const r of rows) {
      if (!ownsPendingRow(r, ledgerId)) continue
      if (state !== undefined && r.state !== state) continue
      const change = r.v ?? r.change
      // 归属明确但实体字段缺失 = 损坏行；不伪造空变更，直接跳过。
      if (change === undefined) continue
      out.push({
        id: r.id,
        ledger_id: r.ledger_id,
        state: r.state,
        attempts: r.attempts,
        next_retry_at: r.next_retry_at,
        last_error_code: r.last_error_code,
        last_error: r.last_error,
        entity_type: r.entity_type,
        op: r.op,
        entity_uuid: r.entity_uuid,
        display_label: r.display_label,
        created_at: r.created_at,
        state_changed_at: r.state_changed_at,
        last_attempt_at: r.last_attempt_at,
        change,
      })
    }
    return out.sort((a, b) => a.id - b.id)
  }

  async countPending(ledgerId: number, state?: 'pending' | 'dead'): Promise<number> {
    return (await this.getPending(ledgerId, state)).length
  }

  async markDead(ledgerId: number, items: DeadOutcome[]): Promise<void> {
    await this.tx([S_PENDING], async (t) => {
      const store = t.objectStore(S_PENDING)
      const changedAt = Date.now()
      for (const item of items) {
        const row = await reqAs(store.get(item.id) as IDBRequest<PendingRow | undefined>)
        if (ownsPendingRow(row, ledgerId) && row.state === 'pending') {
          store.put(
            {
              ...(row as PendingRow),
              state: 'dead',
              last_error_code: item.code,
              last_error: item.error,
              state_changed_at: changedAt,
              last_attempt_at: changedAt,
            },
          )
        }
      }
      await Promise.resolve()
    })
  }

  async scheduleRetry(
    ledgerId: number,
    id: number,
    attempts: number,
    nextRetryAt: number,
    code: string,
    error: string,
  ): Promise<void> {
    await this.tx([S_PENDING], async (t) => {
      const store = t.objectStore(S_PENDING)
      const row = await reqAs(store.get(id) as IDBRequest<PendingRow | undefined>)
      if (ownsPendingRow(row, ledgerId) && row.state === 'pending') {
        const changedAt = Date.now()
        store.put(
          {
            ...(row as PendingRow),
            attempts,
            next_retry_at: nextRetryAt,
            last_error_code: code,
            last_error: error,
            state_changed_at: changedAt,
            last_attempt_at: changedAt,
          },
        )
      }
      await Promise.resolve()
    })
  }

  async reviveDead(ledgerId: number, ids: number[]): Promise<void> {
    await this.tx([S_PENDING], async (t) => {
      const store = t.objectStore(S_PENDING)
      const changedAt = Date.now()
      for (const id of ids) {
        const row = await reqAs(store.get(id) as IDBRequest<PendingRow | undefined>)
        if (ownsPendingRow(row, ledgerId) && row.state === 'dead') {
          store.put({
            ...(row as PendingRow),
            state: 'pending',
            attempts: 0,
            next_retry_at: 0,
            last_error: undefined,
            last_error_code: undefined,
            state_changed_at: changedAt,
          })
        }
      }
      await Promise.resolve()
    })
  }

  /** P1：与 MemorySyncStore.retryNow 同契约，单事务、账本守卫、保留 attempts。 */
  async retryNow(ledgerId: number, ids: number[]): Promise<void> {
    await this.tx([S_PENDING], async (t) => {
      const store = t.objectStore(S_PENDING)
      const changedAt = Date.now()
      for (const id of new Set(ids)) {
        const row = await reqAs(store.get(id) as IDBRequest<PendingRow | undefined>)
        if (!ownsPendingRow(row, ledgerId) || row.state !== 'pending') continue
        store.put({
          ...(row as PendingRow),
          next_retry_at: 0,
          last_error: undefined,
          last_error_code: undefined,
          state_changed_at: changedAt,
        })
      }
      await Promise.resolve()
    })
  }

  async discardPending(ledgerId: number, ids: number[]): Promise<void> {
    await this.tx([S_PENDING], async (t) => {
      const store = t.objectStore(S_PENDING)
      for (const id of new Set(ids)) {
        const row = await reqAs(store.get(id) as IDBRequest<PendingRow | undefined>)
        if (ownsPendingRow(row, ledgerId)) store.delete(id)
      }
      await Promise.resolve()
    })
  }

  async quarantineAndReset(ledgerId: number, newInstanceId: string): Promise<void> {
    await this.tx([...ALL_STORES], async (t) => {
      const prefix = `${ledgerId}:`
      const accStore = t.objectStore(S_ACCOUNTS)
      const txnStore = t.objectStore(S_TXNS)
      const accRows = (await reqAs(accStore.getAll() as IDBRequest<Array<{ k: string }>>)) ?? []
      for (const row of accRows) {
        if (row.k.startsWith(prefix)) accStore.delete(row.k)
      }
      const txnRows = (await reqAs(txnStore.getAll() as IDBRequest<Array<{ k: string }>>)) ?? []
      for (const row of txnRows) {
        if (row.k.startsWith(prefix)) txnStore.delete(row.k)
      }
      const pendingStore = t.objectStore(S_PENDING)
      const pendingRows =
        (await reqAs(pendingStore.getAll() as IDBRequest<PendingRow[]>)) ?? []
      const now = Date.now()
      for (const row of pendingRows) {
        if (ownsPendingRow(row, ledgerId) && row.state === 'pending') {
          pendingStore.put(
            {
              ...row,
              state: 'dead',
              last_error_code: 'instance_rotated',
              last_error: '服务端账本已被还原，本条待同步变更已隔离（同步页可导出后丢弃或重试）',
              state_changed_at: now,
              last_attempt_at: now,
            },
          )
        }
      }
      const metaStore = t.objectStore(S_META)
      metaStore.put({ v: 0 }, this.metaKey(`seq.${ledgerId}`))
      metaStore.put({ v: newInstanceId }, this.metaKey(`instance.${ledgerId}`))
      // uuid_map 是「本地→服务端」映射，库被替换后全部失效。
      t.objectStore(S_UUID_MAP).delete(String(ledgerId))
      // D5：库世代重置清空离线标签意图（轻量意图，不隔离）。
      const tagRows =
        (await reqAs(
          t.objectStore(S_TAG_EVENTS).getAll() as IDBRequest<Array<{ k: string }>>,
        )) ?? []
      for (const row of tagRows) {
        if (row.k.startsWith(prefix)) t.objectStore(S_TAG_EVENTS).delete(row.k)
      }
      metaStore.delete(this.metaKey(`tagOpSeq.${ledgerId}`))
      await Promise.resolve()
    })
  }

  async getTagBatch(ledgerId: number, uuid: string): Promise<TagEventBatch | null> {
    const key = this.entityKey(ledgerId, uuid)
    const tx = this.db.transaction(S_TAG_EVENTS, 'readonly')
    const row = await reqAs(
      tx.objectStore(S_TAG_EVENTS).get(key) as IDBRequest<{ k: string; v: TagEventBatch } | undefined>,
    )
    return row === undefined ? null : row.v
  }

  async putTagBatch(ledgerId: number, batch: TagEventBatch): Promise<void> {
    const key = this.entityKey(ledgerId, batch.uuid)
    await this.tx([S_TAG_EVENTS], async (t) => {
      t.objectStore(S_TAG_EVENTS).put({ k: key, v: batch }, key)
      await Promise.resolve()
    })
  }

  async allTagBatchUuids(ledgerId: number): Promise<string[]> {
    const tx = this.db.transaction(S_TAG_EVENTS, 'readonly')
    const rows =
      (await reqAs(
        tx.objectStore(S_TAG_EVENTS).getAll() as IDBRequest<
          Array<{ k: string; v: TagEventBatch }>
        >,
      )) ?? []
    const prefix = `${ledgerId}:`
    return rows
      .filter((row) => row.k.startsWith(prefix))
      .map((row) => row.v.uuid)
      .sort()
  }

  async deleteTagBatch(ledgerId: number, uuid: string): Promise<void> {
    const key = this.entityKey(ledgerId, uuid)
    await this.tx([S_TAG_EVENTS], async (t) => {
      t.objectStore(S_TAG_EVENTS).delete(key)
      await Promise.resolve()
    })
  }

  async nextTagOpSeq(ledgerId: number): Promise<number> {
    return this.tx([S_META], async (t) => {
      const store = t.objectStore(S_META)
      const key = this.metaKey(`tagOpSeq.${ledgerId}`)
      const row = (await reqAs(store.get(key) as IDBRequest<{ v: number } | undefined>)) ?? undefined
      const next = (row === undefined ? 0 : row.v) + 1
      store.put({ v: next }, key)
      return next
    })
  }

  async getUuidMap(ledgerId: number): Promise<Record<string, string>> {
    const tx = this.db.transaction(S_UUID_MAP, 'readonly')
    const row =
      (await reqAs(
        tx.objectStore(S_UUID_MAP).get(String(ledgerId)) as IDBRequest<Record<string, string> | undefined>,
      )) ?? {}
    return row
  }

  async tryAcquireLease(holder: string, now: number, ttlMs: number): Promise<boolean> {
    const result = await this.tx([S_META], async (t) => {
      const store = t.objectStore(S_META)
      const row = (await reqAs(
        store.get(this.metaKey('lease')) as IDBRequest<{ v: { holder: string; expiresAt: number } } | undefined>,
      )) ?? undefined
      if (row !== undefined && row.v.holder !== holder && row.v.expiresAt > now) {
        return false
      }
      store.put({ v: { holder, expiresAt: now + ttlMs } }, this.metaKey('lease'))
      return true
    })
    return result
  }

  async releaseLease(holder: string): Promise<void> {
    await this.tx([S_META], async (t) => {
      const store = t.objectStore(S_META)
      const row = (await reqAs(
        store.get(this.metaKey('lease')) as IDBRequest<{ v: { holder: string; expiresAt: number } } | undefined>,
      )) ?? undefined
      if (row !== undefined && row.v.holder === holder) {
        store.delete(this.metaKey('lease'))
      }
      await Promise.resolve()
    })
  }
}

// MemorySyncStore 仅作类型关联引用（接口一致性由测试保证）。
export type { MemorySyncStore }
