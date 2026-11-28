/**
 * 同步引擎契约测试（批 5，AC-17 / RK-05）
 *
 * 请求/响应样本来自真实服务端录制（`fixtures/*.json`，2026-11-11 起 ：18082
 * 临时库按旧版 Dart payload 形态录制），逐条与旧版行为对齐：
 *   - push-1：自然键合并（loc 账户 → server_uuid）+ 交易 account_not_found；
 *   - push-2：重映射后重推被接受（accepted=true，checkpoint 推进）；
 *   - push-3：同 uuid 重放幂等（ok 但 accepted=false，不产生重复交易）；
 *   - push-4：op=delete 墓碑（accepted，pull 出 delete 事件）；
 *   - pull-incremental-empty：**checkpoint=0**（空结果不推进水位的依据）；
 *   - push-6：引用已关闭账户 → code=account_closed（死信）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import push1 from './fixtures/push-1-natural-key-merge.json'
import push2 from './fixtures/push-2-remapped-accept.json'
import push3 from './fixtures/push-3-duplicate-idempotent.json'
import pullEmpty from './fixtures/pull-incremental-empty.json'
import push6 from './fixtures/push-6-account-closed.json'
import {
  SyncEngine,
  decideDisposition,
  toSyncError,
  validatePushResults,
  type PushChange,
  type SyncApiClient,
} from './engine'
import { MemorySyncStore, backoffMs } from './localStore'
import { classifyResult, DEAD_CODES, type PendingEntry } from './models'
import type { PushResult, SyncPullResponse, SyncPushResponse } from '@/api/types'

const LID = 1
const INSTANCE = '73ba0e6e-a86f-4c1d-abd5-d9b43ff599c0'
const SERVER_CASH = '35c75bf6-98d2-407b-890a-9a6de3f9e638'
const SERVER_FOOD = 'a615d5d2-c373-48ec-9a88-f9b6057e0261'

type PushHandler = (changes: PushChange[]) => SyncPushResponse

interface ApiScript {
  pulls: SyncPullResponse[]
  pushes?: SyncPushResponse[]
  onPush?: PushHandler
}

function makeApi(script: ApiScript): SyncApiClient & { pushBodies: PushChange[][]; pulls: SyncPullResponse[] } {
  const pushBodies: PushChange[][] = []
  return {
    pushBodies,
    pulls: script.pulls,
    async pull(since: number): Promise<SyncPullResponse> {
      void since
      const next = script.pulls.shift()
      if (next === undefined) throw new Error('pull 脚本耗尽')
      return next
    },
    async push(_clientId: string, _since: number, changes: PushChange[]): Promise<SyncPushResponse> {
      pushBodies.push(changes)
      if (script.onPush !== undefined) return script.onPush(changes)
      const next = script.pushes?.shift()
      if (next === undefined) throw new Error('push 脚本耗尽')
      return next
    },
  }
}

function pullResp(changes: SyncPullResponse['changes'], checkpoint: number): SyncPullResponse {
  return { instance_id: INSTANCE, checkpoint, changes }
}

let clock = 1_000_000

beforeEach(() => {
  clock = 1_000_000
})

describe('C-1：离线记账 → 恢复联网完整上报（AC-04 / RK-05）', () => {
  it('断网记录入队不丢失，恢复后一次 push 恰好一条、服务端只新增 1 笔', async () => {
    const store = new MemorySyncStore()
    const api = makeApi({
      // recordOffline 内部 sync 消耗 pull0/push/pull1；显式 sync 消耗 pull2/pull3。
      pulls: [pullResp([], 0), pullResp([], 40), pullResp([], 40), pullResp([], 40)],
      pushes: [
        {
          instance_id: INSTANCE,
          checkpoint: 40,
          accepted: 1,
          results: [{ index: 0, entity_type: 'transaction', uuid: 'loc-txn-9', status: 'ok', accepted: true }],
        },
      ],
    })
    const engine = new SyncEngine(store, api, () => LID)

    await engine.recordOffline({
      txn: {
        uuid: 'loc-txn-9',
        date: '2026-01-05',
        flag: '*',
        description: '断网记的早餐',
        tags: [],
        postings: [
          { account_uuid: SERVER_CASH, commodity: 'CNY', amount: '12.50' },
          { account_uuid: SERVER_FOOD, commodity: 'CNY', amount: '-12.50' },
        ],
      },
      pending: {
        entity_type: 'transaction',
        key: 'loc-txn-9',
        entity: {
          uuid: 'loc-txn-9',
          date: '2026-01-05',
          postings: [
            { account_uuid: SERVER_CASH, commodity: 'CNY', amount: '12.50' },
            { account_uuid: SERVER_FOOD, commodity: 'CNY', amount: '-12.50' },
          ],
        },
      },
    })

    // recordOffline 内部已同步（联网即推）：队列清空、服务端恰新增 1 笔。
    expect(await store.countPending(LID, 'pending')).toBe(0)
    expect(api.pushBodies.length).toBe(1)
    expect(api.pushBodies[0].length).toBe(1)
    expect(api.pushBodies[0][0].entity['uuid']).toBe('loc-txn-9')
    // 显式 sync 收尾仍 ok，且不再重复 push（幂等，不产生重复交易）。
    const outcome = await engine.sync()
    expect(outcome).toBe('ok')
    expect(api.pushBodies.length).toBe(1)
  })

  it('push 幂等重放：同 uuid 服务端 accepted=false，本地不产生重复交易', async () => {
    const store = new MemorySyncStore()
    const api = makeApi({
      pulls: [pullResp([], 0), pullResp([], 0)],
      pushes: [push3 as unknown as SyncPushResponse],
    })
    const engine = new SyncEngine(store, api, () => LID)
    await store.recordEntry(LID, {
      txn: { uuid: 'loc-txn-1', date: '2026-01-05', flag: '*', description: 'x', tags: [], postings: [] },
      pending: { entity_type: 'transaction', key: 'loc-txn-1', entity: { uuid: 'loc-txn-1' } },
    })
    const outcome = await engine.sync()
    expect(outcome).toBe('ok')
    // push-3：status=ok 但 accepted=false（服务端已存在）→ 本地视为成功、移除队列。
    expect(await store.countPending(LID, 'pending')).toBe(0)
  })
})

describe('C-2：自然键合并 + uuid 重映射（旧版对齐 / §6.6.1 #3）', () => {
  it('loc 账户合并到服务端同名账户：引用重写、重推被接受、合并可崩溃回放', async () => {
    const store = new MemorySyncStore()
    const api = makeApi({
      pulls: [pullResp([], 0), pullResp([], 0), pullResp([], 37)],
      pushes: [push1 as unknown as SyncPushResponse, push2 as unknown as SyncPushResponse],
    })
    const engine = new SyncEngine(store, api, () => LID)

    // 离线期本地已插入 3 条 pending：2 账户 + 1 交易（引用 loc 账户）。
    await store.recordEntry(LID, {
      account: { uuid: 'loc-acc-1', name: 'Expenses:Food', type: 'Expenses', open_date: '2026-01-01' },
      pending: { entity_type: 'account', key: 'loc-acc-1', entity: { uuid: 'loc-acc-1', name: 'Expenses:Food' } },
    })
    await store.recordEntry(LID, {
      account: { uuid: 'loc-acc-2', name: 'Assets:Cash', type: 'Assets', open_date: '2026-01-01' },
      pending: { entity_type: 'account', key: 'loc-acc-2', entity: { uuid: 'loc-acc-2', name: 'Assets:Cash' } },
    })
    await store.recordEntry(LID, {
      pending: {
        entity_type: 'transaction',
        key: 'loc-txn-1',
        entity: {
          uuid: 'loc-txn-1',
          date: '2026-01-05',
          postings: [
            { account_uuid: 'loc-acc-2', commodity: 'CNY', amount: '12.50' },
            { account_uuid: 'loc-acc-1', commodity: 'CNY', amount: '-12.50' },
          ],
        },
      },
    })

    const outcome = await engine.sync()
    expect(outcome).toBe('ok')

    // 第一轮：合并映射落 uuid_map（崩溃后可回放），交易引用被改写为 server uuid。
    const map = await store.getUuidMap(LID)
    expect(map['loc-acc-2']).toBe(SERVER_CASH)
    expect(map['loc-acc-1']).toBe(SERVER_FOOD)
    // 第二轮 push 的交易 postings 已是 server uuid（与 push-2 fixture 请求一致）。
    expect(api.pushBodies.length).toBe(2)
    const round2 = api.pushBodies[1][0]
    const postings = round2.entity['postings'] as Array<{ account_uuid: string }>
    expect(postings.map((p) => p.account_uuid)).toEqual([SERVER_CASH, SERVER_FOOD])
    // 全部成功：队列清空，本地账户被重映射到 server uuid。
    expect(await store.countPending(LID)).toBe(0)
    const accounts = await store.getAllAccounts(LID)
    expect(accounts.map((a) => a.uuid).sort()).toEqual([SERVER_CASH, SERVER_FOOD].sort())
  })

  it('uuid_map 崩溃回放：上次 push 中断留下的映射在下次 sync 前重放', async () => {
    const store = new MemorySyncStore()
    // 模拟崩溃残留：uuid_map 已有 loc-acc-2 → SERVER_CASH，但 pending 引用未改写。
    await store.applyPushResults(LID, {
      uuidMap: { 'loc-acc-2': SERVER_CASH },
      removedIds: [],
      updates: [],
      checkpoint: 0,
    })
    await store.recordEntry(LID, {
      pending: {
        entity_type: 'transaction',
        key: 'loc-txn-x',
        entity: {
          uuid: 'loc-txn-x',
          date: '2026-01-06',
          postings: [{ account_uuid: 'loc-acc-2', commodity: 'CNY', amount: '1.00' }],
        },
      },
    })

    const api = makeApi({
      pulls: [pullResp([], 0), pullResp([], 0)],
      pushes: [
        {
          instance_id: INSTANCE,
          checkpoint: 5,
          accepted: 1,
          results: [{ index: 0, entity_type: 'transaction', uuid: 'loc-txn-x', status: 'ok', accepted: true }],
        },
      ],
    })
    const engine = new SyncEngine(store, api, () => LID)
    await engine.sync()

    // push 请求里的引用已被回放修正。
    expect(api.pushBodies[0][0].entity['postings']).toEqual([
      { account_uuid: SERVER_CASH, commodity: 'CNY', amount: '1.00' },
    ])
  })
})

describe('C-3：死信分类（§6.6.1 #1 / AC-30）', () => {
  it('account_closed → 转 dead，同步页可见、可丢弃、可复活', async () => {
    const store = new MemorySyncStore()
    const api = makeApi({
      pulls: [pullResp([], 0), pullResp([], 0)],
      pushes: [push6 as unknown as SyncPushResponse],
    })
    const engine = new SyncEngine(store, api, () => LID)
    await store.recordEntry(LID, {
      pending: {
        entity_type: 'transaction',
        key: 'txn-on-closed',
        entity: { uuid: 'txn-on-closed', date: '2026-01-07', postings: [] },
      },
    })
    const outcome = await engine.sync()
    expect(outcome).toBe('ok')

    const dead = await store.getPending(LID, 'dead')
    expect(dead.length).toBe(1)
    expect(dead[0].last_error_code).toBe('account_closed')
    expect(await store.countPending(LID, 'pending')).toBe(0)

    // 丢弃路径：清掉死信。
    await store.discardPending(LID, dead.map((d) => d.id))
    expect(await store.countPending(LID, 'dead')).toBe(0)
  })

  it('account_not_found → 全量 pull 重映射重试一次，二次失败才 dead（§6.6.1 #1）', async () => {
    const store = new MemorySyncStore()
    // 只推 1 条交易；服务端持续返回 account_not_found（重映射后自然键依旧对不上）。
    const notFoundResp: SyncPushResponse = {
      ...(push1 as unknown as SyncPushResponse),
      // P0：results 必须严格按本次变更的 index 对齐（单条变更 → index=0）。
      results: [{ ...(push1 as unknown as SyncPushResponse).results[2], index: 0 }],
    }
    const api = makeApi({
      pulls: [pullResp([], 0), pullResp([], 50), pullResp([], 50)],
      pushes: [],
      onPush: () => notFoundResp,
    })
    const engine = new SyncEngine(store, api, () => LID)
    await store.recordEntry(LID, {
      pending: {
        entity_type: 'transaction',
        key: 'loc-txn-1',
        entity: {
          uuid: 'loc-txn-1',
          date: '2026-01-05',
          postings: [{ account_uuid: 'loc-acc-2', commodity: 'CNY', amount: '12.50' }],
        },
      },
    })
    await engine.sync()

    // 两轮 push 都发起了（第一轮 + 重映射重试）。
    expect(api.pushBodies.length).toBe(2)
    const dead = await store.getPending(LID, 'dead')
    expect(dead.length).toBe(1)
    expect(dead[0].last_error_code).toBe('account_not_found')
  })

  it('网络失败 → 指数退避，重试时间未到不发起 push（不静默丢数据）', async () => {
    const store = new MemorySyncStore()
    let now = 1_000_000
    const failingApi: SyncApiClient = {
      pull: async () => {
        throw Object.assign(new Error('net'), { code: 'network_error', status: 0 })
      },
      push: async () => {
        throw new Error('should not push')
      },
    }
    const failingEngine = new SyncEngine(store, failingApi, () => LID, { now: () => now })
    await store.recordEntry(LID, {
      pending: { entity_type: 'transaction', key: 't1', entity: { uuid: 't1' } },
    })

    const outcome = await failingEngine.sync()
    expect(outcome).toBe('offline')
    const pending = await store.getPending(LID, 'pending')
    expect(pending.length).toBe(1)
    expect(pending[0].attempts).toBe(1)
    expect(pending[0].next_retry_at).toBeGreaterThan(now)

    // 时间未到：再次 sync 不发 push、attempts 不变。
    now += 10_000
    await failingEngine.sync()
    expect((await store.getPending(LID, 'pending'))[0].attempts).toBe(1)
  })
})

describe('C-4：库世代与水位（§6.6.1 #5 / AC-30）', () => {
  it('instance_id 不匹配 → pending 转隔离区 + 清实体 + 全量重拉（不静默删）', async () => {
    const store = new MemorySyncStore()
    await store.setInstanceId(LID, 'old-instance')
    await store.recordEntry(LID, {
      account: { uuid: 'a1', name: 'X', type: 'Assets', open_date: '' },
      pending: { entity_type: 'account', key: 'a1', entity: { uuid: 'a1' } },
    })

    const fullChanges: SyncPullResponse['changes'] = [
      {
        seq: 1,
        entity_type: 'account',
        op: 'create',
        entity: { uuid: 'srv-acc', name: 'Assets:Cash', type: 'Assets', open_date: '2026-01-01' },
      },
    ]
    const api = makeApi({
      // 初始 pull 返回新世代触发隔离；隔离后全量重拉；收尾 pull。
      pulls: [pullResp([], 0), pullResp([], 1), pullResp([], 1), pullResp([], 1)],
    })
    api.pulls[0] = { instance_id: 'new-instance', checkpoint: 0, changes: [] }
    api.pulls[1] = { instance_id: 'new-instance', checkpoint: 1, changes: fullChanges }
    // 收尾 pull 必须与隔离后的世代一致，否则会再次触发隔离。
    api.pulls[2] = { instance_id: 'new-instance', checkpoint: 1, changes: [] }
    api.pulls[3] = { instance_id: 'new-instance', checkpoint: 1, changes: [] }
    const engine = new SyncEngine(store, api, () => LID)
    const outcome = await engine.sync()
    expect(outcome).toBe('ok')

    // pending 被隔离（dead + instance_rotated），不静默删。
    const dead = await store.getPending(LID, 'dead')
    expect(dead.length).toBe(1)
    expect(dead[0].last_error_code).toBe('instance_rotated')
    // 本地旧实体被清空，全量重拉后只剩服务端实体。
    const accounts = await store.getAllAccounts(LID)
    expect(accounts.map((a) => a.uuid)).toEqual(['srv-acc'])
    expect(await store.getInstanceId(LID)).toBe('new-instance')
    expect(await store.getLastSeq(LID)).toBe(1)
  })

  it('空增量 pull（checkpoint=0）不回退水位（fixture 实录口径）', async () => {
    const store = new MemorySyncStore()
    await store.applyPullChanges(LID, [], 40)
    const api = makeApi({
      pulls: [pullEmpty as unknown as SyncPullResponse],
    })
    const engine = new SyncEngine(store, api, () => LID)
    await engine.sync()
    expect(await store.getLastSeq(LID)).toBe(40)
  })

  it('多标签页：租约被占用时第二个引擎跳过同步（§6.6.1 #4）', async () => {
    const store = new MemorySyncStore()
    const fixedNow = 1_000_000
    const leader = new SyncEngine(
      store,
      makeApi({ pulls: [pullResp([], 0), pullResp([], 0)], pushes: [] }),
      () => LID,
      { now: () => fixedNow },
    )
    const follower = new SyncEngine(store, makeApi({ pulls: [], pushes: [] }), () => LID, {
      now: () => fixedNow,
    })
    const r1 = await leader.sync()
    expect(r1).toBe('ok')
    // leader 同步结束即释放租约；此时另一标签页占住租约（未过期）→ follower 跳过。
    await store.tryAcquireLease('other-tab', fixedNow, 90_000)
    const r2 = await follower.sync()
    expect(r2).toBe('skipped')
  })
})

describe('C-5：wire 契约样本断言（AC-17，与旧版行为逐条一致）', () => {
  it('录制的 push 响应经 classifyResult 得到与旧版一致的处置', () => {
    const results1 = (push1 as unknown as SyncPushResponse).results
    expect(classifyResult(results1[0])).toBe('merged') // loc-acc-1 → server
    expect(classifyResult(results1[1])).toBe('merged') // loc-acc-2 → server
    expect(classifyResult(results1[2])).toBe('retry') // account_not_found

    const results2 = (push2 as unknown as SyncPushResponse).results
    expect(classifyResult(results2[0])).toBe('removed')

    const results6 = (push6 as unknown as SyncPushResponse).results
    expect(classifyResult(results6[0])).toBe('dead') // account_closed
  })

  it('死信码表与后端稳定码白名单一致（同一张表，契约断言）', () => {
    expect(DEAD_CODES).toContain('account_closed')
    expect(DEAD_CODES).toContain('account_balance_not_zero')
    expect(DEAD_CODES).toContain('opening_via_api_only')
    expect(DEAD_CODES).toContain('idempotency_key_deleted')
    expect(DEAD_CODES).toContain('idempotency_payload_mismatch')
  })

  it('pull-full 契约：changes 形态与旧版 SyncChange.fromJson 字段一一对应', async () => {
    const { default: pullFull } = await import('./fixtures/pull-full.json')
    const resp = pullFull as unknown as SyncPullResponse
    expect(resp.checkpoint).toBeGreaterThan(0)
    expect(resp.changes.length).toBeGreaterThan(0)
    const txnChange = resp.changes.find((c) => c.entity_type === 'transaction' && c.op === 'create')
    expect(txnChange).toBeDefined()
    const entity = txnChange!.entity as Record<string, unknown>
    expect(entity['uuid']).toBeDefined()
    expect(Array.isArray(entity['postings'])).toBe(true)
    const posting = (entity['postings'] as Array<Record<string, unknown>>)[0]
    expect(posting['account_uuid']).toBeDefined()
    expect(posting['commodity']).toBeDefined()
    expect(posting['amount']).toBeDefined()
  })

  it('空增量 pull：checkpoint=0 且 changes 空（水位不推进的实录依据）', () => {
    const resp = pullEmpty as unknown as SyncPullResponse
    expect(resp.checkpoint).toBe(0)
    expect(resp.changes).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// P0 正确性修复回归
// ---------------------------------------------------------------------------

describe('P0：decideDisposition / validatePushResults 纯函数', () => {
  function entry(id: number, key: string, attempts = 0): PendingEntry {
    return {
      id,
      ledger_id: LID,
      state: 'pending',
      attempts,
      next_retry_at: 0,
      change: { entity_type: 'transaction', key, entity: { uuid: key } },
    }
  }

  function result(index: number, extra: Partial<PushResult>): PushResult {
    return {
      index,
      entity_type: 'transaction',
      status: 'ok',
      accepted: true,
      ...extra,
    }
  }

  it('account_not_found 按条目判定：本条 retry-now，其他条 retry-backoff，二次失败 dead', () => {
    const now = 5_000
    const notFound = decideDisposition({
      entry: entry(1, 'a'),
      result: result(0, { status: 'error', accepted: false, code: 'account_not_found', error: 'missing' }),
      round: 1,
      now,
      maxPushRounds: 2,
    })
    expect(notFound.kind).toBe('retry-now')
    if (notFound.kind === 'retry-now') {
      expect(notFound.retry.nextRetryAt).toBe(now)
      expect(notFound.retry.attempts).toBe(1)
      expect(notFound.retry.code).toBe('account_not_found')
    }

    const other = decideDisposition({
      entry: entry(2, 'b'),
      result: result(1, { status: 'error', accepted: false, code: 'server_busy', error: 'busy' }),
      round: 1,
      now,
      maxPushRounds: 2,
    })
    expect(other.kind).toBe('retry-backoff')
    if (other.kind === 'retry-backoff') {
      expect(other.retry.nextRetryAt).toBe(now + backoffMs(1))
      expect(other.retry.error).toBe('busy')
    }

    const secondFailure = decideDisposition({
      entry: entry(3, 'c', 1),
      result: result(2, { status: 'error', accepted: false, code: 'account_not_found', error: 'again' }),
      round: 2,
      now,
      maxPushRounds: 2,
    })
    expect(secondFailure.kind).toBe('dead')
  })

  it('merged 保留本地→服务端映射，dead 逐条带自己的 code/error', () => {
    const now = 5_000
    const merged = decideDisposition({
      entry: entry(1, 'loc-acc'),
      result: result(0, { status: 'ok', accepted: false, uuid: 'loc-acc', server_uuid: 'srv-acc' }),
      round: 1,
      now,
      maxPushRounds: 2,
    })
    expect(merged).toEqual({
      kind: 'merged',
      id: 1,
      localUuid: 'loc-acc',
      serverUuid: 'srv-acc',
    })

    const dead = decideDisposition({
      entry: entry(2, 'x'),
      result: result(1, { status: 'error', accepted: false, code: 'validation', error: 'bad-x' }),
      round: 1,
      now,
      maxPushRounds: 2,
    })
    expect(dead).toEqual({
      kind: 'dead',
      dead: { id: 2, code: 'validation', error: 'bad-x' },
    })
  })

  it('校验 results 数量、index 完整性与越界/重复', () => {
    const two = [
      { index: 0, entity_type: 'transaction' as const, status: 'ok', accepted: true },
      { index: 1, entity_type: 'transaction' as const, status: 'ok', accepted: true },
    ]
    expect(validatePushResults(two, 2)).toEqual({ ok: true })
    expect(validatePushResults(two.slice(0, 1), 2).ok).toBe(false)
    expect(validatePushResults([two[0], { ...two[0] }], 2).ok).toBe(false)
    expect(validatePushResults([two[0], { ...two[1], index: 2 }], 2).ok).toBe(false)
    expect(validatePushResults(two, 3).ok).toBe(false)
  })
})

describe('P0：push 结果落地路径', () => {
  function record(store: MemorySyncStore, key: string): Promise<number> {
    return store.recordEntry(LID, {
      pending: { entity_type: 'transaction', key, entity: { uuid: key } },
    })
  }

  it('getState 返回真实 pending/dead 计数（不再恒为 0）', async () => {
    const store = new MemorySyncStore()
    const engine = new SyncEngine(store, makeApi({ pulls: [] }), () => LID)
    const deadId = await record(store, 'a')
    await store.markDead(LID, [{ id: deadId, code: 'validation', error: 'x' }])
    await record(store, 'b')

    const state = await engine.getState()
    expect(state.status).toBe('idle')
    expect(state.pendingCount).toBe(1)
    expect(state.deadCount).toBe(1)
  })

  it('三条不同 code 的死信逐条保存各自的 code/error（原共享变量 bug）', async () => {
    const store = new MemorySyncStore()
    await record(store, 'a')
    await record(store, 'b')
    await record(store, 'c')
    const api = makeApi({
      pulls: [pullResp([], 0), pullResp([], 0)],
      pushes: [
        {
          instance_id: INSTANCE,
          checkpoint: 60,
          accepted: 0,
          results: [
            { index: 0, entity_type: 'transaction', status: 'error', accepted: false, code: 'account_closed', error: 'closed-a' },
            { index: 1, entity_type: 'transaction', status: 'error', accepted: false, code: 'validation', error: 'bad-b' },
            { index: 2, entity_type: 'transaction', status: 'error', accepted: false, code: 'account_balance_not_zero', error: 'balance-c' },
          ],
        },
      ],
    })
    await new SyncEngine(store, api, () => LID).sync()

    const dead = await store.getPending(LID, 'dead')
    expect(dead.map((d) => d.last_error_code)).toEqual([
      'account_closed',
      'validation',
      'account_balance_not_zero',
    ])
    expect(dead.map((d) => d.last_error)).toEqual(['closed-a', 'bad-b', 'balance-c'])
  })

  it('一条 account_not_found 不再连坐：下一轮只重推命中条目', async () => {
    const now = 1_000_000
    const store = new MemorySyncStore()
    await record(store, 'a')
    await record(store, 'b')
    const api = makeApi({
      pulls: [pullResp([], 0), pullResp([], 50), pullResp([], 50)],
      onPush: (changes) => {
        if (changes.length === 2) {
          return {
            instance_id: INSTANCE,
            checkpoint: 0,
            accepted: 0,
            results: [
              { index: 0, entity_type: 'transaction', status: 'error', accepted: false, code: 'account_not_found', error: 'missing' },
              { index: 1, entity_type: 'transaction', status: 'error', accepted: false, code: 'server_busy', error: 'busy' },
            ],
          }
        }
        return {
          instance_id: INSTANCE,
          checkpoint: 50,
          accepted: 1,
          results: [{ index: 0, entity_type: 'transaction', uuid: 'a', status: 'ok', accepted: true }],
        }
      },
    })
    await new SyncEngine(store, api, () => LID, { now: () => now }).sync()

    expect(api.pushBodies).toHaveLength(2)
    expect(api.pushBodies[1]).toHaveLength(1)
    expect(api.pushBodies[1][0].entity['uuid']).toBe('a')
    const pending = await store.getPending(LID, 'pending')
    expect(pending.map((p) => p.change.key)).toEqual(['b'])
    expect(pending[0].attempts).toBe(1)
    expect(pending[0].next_retry_at).toBe(now + backoffMs(1))
  })

  it('results 数量不匹配 → 整批退避重试，不 remove 任何条目、不推进水位', async () => {
    const now = 2_000_000
    const store = new MemorySyncStore()
    await record(store, 'a')
    await record(store, 'b')
    const api = makeApi({
      pulls: [pullResp([], 0), pullResp([], 0)],
      pushes: [
        {
          instance_id: INSTANCE,
          checkpoint: 999,
          accepted: 1,
          // 少了 index=1 的结果：整批按协议错误处理。
          results: [{ index: 0, entity_type: 'transaction', uuid: 'a', status: 'ok', accepted: true }],
        },
      ],
    })
    await new SyncEngine(store, api, () => LID, { now: () => now }).sync()

    const pending = await store.getPending(LID, 'pending')
    expect(pending.map((p) => p.change.key)).toEqual(['a', 'b'])
    expect(pending.map((p) => p.attempts)).toEqual([1, 1])
    expect(pending.map((p) => p.last_error_code)).toEqual(['invalid_push_results', 'invalid_push_results'])
    expect(pending.every((p) => p.next_retry_at > now)).toBe(true)
    expect(await store.getLastSeq(LID)).toBe(0)
    expect(api.pushBodies).toHaveLength(1)
  })

  it('严格按 result.index 对齐条目，乱序结果也不会错配', async () => {
    const store = new MemorySyncStore()
    await record(store, 'a')
    await record(store, 'b')
    const api = makeApi({
      pulls: [pullResp([], 0), pullResp([], 0)],
      pushes: [
        {
          instance_id: INSTANCE,
          checkpoint: 70,
          accepted: 0,
          // 故意先给 index=1、再给 index=0；错误码必须跟着各自条目走。
          results: [
            { index: 1, entity_type: 'transaction', status: 'error', accepted: false, code: 'validation', error: 'bad-b' },
            { index: 0, entity_type: 'transaction', status: 'error', accepted: false, code: 'account_closed', error: 'closed-a' },
          ],
        },
      ],
    })
    await new SyncEngine(store, api, () => LID).sync()

    const dead = await store.getPending(LID, 'dead')
    expect(dead.find((d) => d.change.key === 'a')?.last_error_code).toBe('account_closed')
    expect(dead.find((d) => d.change.key === 'b')?.last_error_code).toBe('validation')
  })

  it('主路径只调用一次 applyPushOutcome，不再分开调用 applyPushResults/markDead', async () => {
    const store = new MemorySyncStore()
    await record(store, 'a')
    await record(store, 'b')
    const outcomeSpy = vi.spyOn(store, 'applyPushOutcome')
    const resultsSpy = vi.spyOn(store, 'applyPushResults')
    const api = makeApi({
      pulls: [pullResp([], 0), pullResp([], 0)],
      pushes: [
        {
          instance_id: INSTANCE,
          checkpoint: 80,
          accepted: 0,
          results: [
            { index: 0, entity_type: 'transaction', status: 'error', accepted: false, code: 'account_closed', error: 'closed' },
            { index: 1, entity_type: 'transaction', status: 'error', accepted: false, code: 'server_busy', error: 'busy' },
          ],
        },
      ],
    })
    await new SyncEngine(store, api, () => LID).sync()

    expect(outcomeSpy).toHaveBeenCalledTimes(1)
    expect(resultsSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// P1 可观测性与立即重试
// ---------------------------------------------------------------------------

describe('P1：顶层错误通道 / 逐条错误隔离', () => {
  function record(store: MemorySyncStore, key: string): Promise<number> {
    return store.recordEntry(LID, {
      pending: { entity_type: 'transaction', key, entity: { uuid: key } },
    })
  }

  it('pull 抛网络错误：SyncState 带真实 code/message/at/phase，成功同步后清空', async () => {
    const now = 3_000_000
    const store = new MemorySyncStore()
    let fail = true
    const api: SyncApiClient = {
      pull: async () => {
        if (fail) throw Object.assign(new Error('net down'), { code: 'network_error', status: 0 })
        return pullResp([], 0)
      },
      push: async () => pullResp([], 0) as unknown as SyncPushResponse,
    }
    const engine = new SyncEngine(store, api, () => LID, { now: () => now })

    expect(await engine.sync()).toBe('offline')
    expect(await engine.getState()).toMatchObject({
      status: 'offline',
      lastSyncError: { code: 'network_error', message: 'net down', at: now, phase: 'pull' },
    })

    fail = false
    expect(await engine.sync()).toBe('ok')
    expect((await engine.getState()).lastSyncError).toBeUndefined()
  })

  it('push 抛 5xx：phase=push，code 由 status 生成，message 不丢', async () => {
    const now = 4_000_000
    const store = new MemorySyncStore()
    await record(store, 'a')
    const api = makeApi({ pulls: [pullResp([], 0)] })
    api.push = async () => {
      throw Object.assign(new Error('server exploded'), { status: 503 })
    }
    const engine = new SyncEngine(store, api, () => LID, { now: () => now })

    expect(await engine.sync()).toBe('offline')
    expect((await engine.getState()).lastSyncError).toEqual({
      code: 'http_503',
      message: 'server exploded',
      at: now,
      phase: 'push',
    })
  })

  it('toSyncError：401/403 归一，未知抛出形态也不丢文案', () => {
    expect(toSyncError({ status: 401 }, 'pull', 1).code).toBe('unauthorized')
    expect(toSyncError({ status: 403 }, 'push', 1).code).toBe('forbidden')
    expect(toSyncError(new Error('boom'), 'push', 9)).toEqual({
      code: 'unknown_error',
      message: 'boom',
      at: 9,
      phase: 'push',
    })
  })

  it('网络退避不把顶层文案灌进本来干净的 last_error，已有逐条错误保留', async () => {
    const now = 5_000_000
    const store = new MemorySyncStore()
    const fresh = await record(store, 'fresh')
    const stale = await record(store, 'stale')
    await store.scheduleRetry(LID, stale, 1, 0, 'validation', '原有逐条错误')
    const api: SyncApiClient = {
      pull: async () => {
        throw Object.assign(new Error('顶层网络文案'), { code: 'network_error', status: 0 })
      },
      push: async () => pullResp([], 0) as unknown as SyncPushResponse,
    }
    await new SyncEngine(store, api, () => LID, { now: () => now }).sync()

    const pending = await store.getPending(LID, 'pending')
    const freshRow = pending.find((entry) => entry.id === fresh)
    const staleRow = pending.find((entry) => entry.id === stale)
    expect(freshRow?.attempts).toBe(1)
    expect(freshRow?.last_error ?? '').not.toContain('顶层网络文案')
    expect(staleRow?.last_error).toBe('原有逐条错误')
    expect(staleRow?.attempts).toBe(2)
  })
})

describe('P1：requestRetry 与本次同步摘要', () => {
  function record(store: MemorySyncStore, key: string): Promise<number> {
    return store.recordEntry(LID, {
      pending: { entity_type: 'transaction', key, entity: { uuid: key } },
    })
  }

  it('持租约 tab：retryNow + sync 一步完成；非 leader 跳过且不动队列', async () => {
    const now = 6_000_000
    const store = new MemorySyncStore()
    const id = await record(store, 'retry-me')
    await store.scheduleRetry(LID, id, 3, now + 99_999, 'busy', 'boom')
    const api = makeApi({
      pulls: [pullResp([], 0), pullResp([], 0)],
      pushes: [
        {
          instance_id: INSTANCE,
          checkpoint: 12,
          accepted: 1,
          results: [{ index: 0, entity_type: 'transaction', uuid: 'retry-me', status: 'ok', accepted: true }],
        },
      ],
    })
    const engine = new SyncEngine(store, api, () => LID, { now: () => now })
    expect(await engine.requestRetry([id])).toBe('ok')
    expect(api.pushBodies).toHaveLength(1)
    expect(await store.countPending(LID)).toBe(0)

    const otherStore = new MemorySyncStore()
    const otherId = await record(otherStore, 'not-mine')
    await otherStore.scheduleRetry(LID, otherId, 2, now + 88_888, 'busy', 'x')
    const otherEngine = new SyncEngine(otherStore, makeApi({ pulls: [] }), () => LID, { now: () => now })
    await otherStore.tryAcquireLease('other-tab', now, 90_000)
    expect(await otherEngine.requestRetry([otherId])).toBe('skipped')
    const rows = await otherStore.getPending(LID, 'pending')
    expect(rows[0].attempts).toBe(2)
    expect(rows[0].next_retry_at).toBe(now + 88_888)
  })

  it('摘要成功/重试/死信三数取最终队列，与列表口径一致', async () => {
    const now = 7_000_000
    const store = new MemorySyncStore()
    await record(store, 'ok')
    await record(store, 'dead')
    await record(store, 'wait')
    const api = makeApi({
      pulls: [pullResp([], 0), pullResp([], 0)],
      pushes: [
        {
          instance_id: INSTANCE,
          checkpoint: 77,
          accepted: 1,
          results: [
            { index: 0, entity_type: 'transaction', uuid: 'ok', status: 'ok', accepted: true },
            { index: 1, entity_type: 'transaction', status: 'error', accepted: false, code: 'account_closed', error: 'closed' },
            { index: 2, entity_type: 'transaction', status: 'error', accepted: false, code: 'server_busy', error: 'busy' },
          ],
        },
      ],
    })
    const engine = new SyncEngine(store, api, () => LID, { now: () => now })
    expect(await engine.sync()).toBe('ok')
    expect((await engine.getState()).lastSyncSummary).toEqual({
      success: 1,
      retry: 1,
      dead: 1,
      at: now,
    })
  })
})
