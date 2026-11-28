/**
 * SyncEngine —— 同步编排（批 5，§6.6）
 *
 * 旧版 `sync_service.dart`（305 行）的重写，并补齐 §6.6.1 五条一致性设计：
 * 1. 失败分类 / 死信：pending 带 attempts / last_error_code / next_retry_at /
 *    state(pending|dead)；`account_closed` / `account_balance_not_zero` /
 *    `opening_via_api_only` / 幂等冲突 → dead；`account_not_found` → 全量 pull +
 *    自然键重映射重试一次，二次失败才 dead；网络与 5xx → 指数退避封顶 1h。
 * 2~3. 原子操作与 uuid_map 崩溃回放在 LocalStore（同事务落库 + push 前回放）。
 * 4. 多标签页租约：IndexedDB CAS，非 leader 直接跳过本次同步。
 * 5. 库世代：pull/push 响应 `instance_id` 与本地不一致 → pending 转隔离区 +
 *    清实体 + 全量重拉；水位只单调推进，空结果（checkpoint=0）不回退。
 *
 * P0 修复：push 结果先做完整性校验，再由纯函数 decideDisposition 逐条定责；
 * 四类处置一次性 applyPushOutcome 落地；死信 code/error 逐条独立；
 * account_not_found 只影响本条目，不再全局连坐；getState 返回真实计数。
 *
 * 同步节奏与旧版一致：pull → push（最多两轮，自然键合并重映射）→ pull。
 */
import type { SyncPullResponse, PushChange, SyncPushResponse, PushResult } from '@/api/types'

/** push 请求里的一条变更（wire：entity_type / op / entity）。 */
export type { PushChange }
import {
  classifyResult,
  isRetryingPending,
  DEAD_CODES,
  type LocalAccount,
  type LocalTxn,
  type PendingChange,
  type PendingEntry,
} from './models'
import {
  backoffMs,
  type DeadOutcome,
  type RetryOutcome,
  type SyncStore,
} from './localStore'
import { getTabId } from './dataChangeChannel'

/** 同步 API 适配层（生产用 `@/api/client` 的 syncApi，测试注入 mock）。 */
export interface SyncApiClient {
  pull(since: number, clientId: string): Promise<SyncPullResponse>
  push(clientId: string, since: number, changes: PushChange[]): Promise<SyncPushResponse>
}

export type SyncOutcome = 'ok' | 'offline' | 'error' | 'skipped'

export type SyncStatus = 'idle' | 'syncing' | 'ok' | 'offline' | 'error'

/** 顶层错误的发生阶段；lease = 租约 / 启动阶段，拿不到抛出点时默认 push。 */
export type SyncErrorPhase = 'pull' | 'push' | 'lease'

/** 顶层错误（网络 / 5xx / 4xx / 401 之外的 API 错误）的可观测形态。 */
export interface SyncErrorInfo {
  code: string
  message: string
  at: number
  phase: SyncErrorPhase
}

/** 本次同步结果摘要：成功数取自 push 结果，重试/死信取最终队列状态。 */
export interface SyncSummary {
  success: number
  retry: number
  dead: number
  at: number
}

export interface SyncState {
  status: SyncStatus
  lastSyncAt: number
  pendingCount: number
  deadCount: number
  /** P1：顶层错误；成功同步后清空。 */
  lastSyncError?: SyncErrorInfo
  /** P1：本次同步摘要，保留到下一轮同步结束才覆盖。 */
  lastSyncSummary?: SyncSummary
}

/**
 * 任意抛出形态 → 顶层错误对象（纯函数，供引擎与 store 共用）。
 *
 * 不再只把 err.status 映射成状态而丢掉 code/message：UI 需要真实文案与阶段。
 */
export function toSyncError(err: unknown, phase: SyncErrorPhase, now: number): SyncErrorInfo {
  const record: Record<string, unknown> =
    typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : {}
  const rawCode = typeof record['code'] === 'string' && record['code'] !== '' ? record['code'] : undefined
  const status = typeof record['status'] === 'number' ? record['status'] : undefined
  const code =
    rawCode ??
    (status === 401
      ? 'unauthorized'
      : status === 403
        ? 'forbidden'
        : status !== undefined
          ? `http_${status}`
          : 'unknown_error')
  const message =
    typeof record['message'] === 'string' && record['message'] !== ''
      ? record['message']
      : err instanceof Error && err.message !== ''
        ? err.message
        : typeof err === 'string'
          ? err
          : String(err)
  return { code, message, at: now, phase }
}

/**
 * 「数据已变更」事件的触发原因。
 *
 * `local-write` 由 UI 写操作经全局脏标记发出；引擎自身只会产生
 * `pull-changes` / `generation-reset`。跨 tab 转发用 `cross-tab`，
 * 消费方据此避免再次广播造成回声循环。
 */
export type DataChangeReason =
  | 'local-write'
  | 'pull-changes'
  | 'generation-reset'
  | 'cross-tab'

/** 快照数据源发生真实变更的通知（只读观察，不写同步库）。 */
export interface DataChangeEvent {
  ledgerId: number
  /** 单调 seq，用于同账本内排序 / 重复事件丢弃。 */
  seq: number
  /** 触发原因，便于观测与回归断言。 */
  reason: DataChangeReason
  /** 发出 tab 的 id；BroadcastChannel 自发自收时据此过滤。 */
  tabId: string
  at: number
}

/** 一轮 pull 的摘要：只有 changes 非空 / 世代重置才是真变更。 */
export interface PullSummary {
  changed: boolean
  generationReset: boolean
  checkpoint: number
}

export interface SyncEngineOptions {
  /** 租约 TTL（ms），默认 90s（§6.6.1 #4：30s 心跳 / 90s 过期抢占的收敛值）。 */
  leaseTtlMs?: number
  /** push 最大轮数，默认 2（与旧版一致）。 */
  maxPushRounds?: number
  now?: () => number
}

// ---------------------------------------------------------------------------
// P0：push 结果校验 + 纯函数定责（可独立单测）
// ---------------------------------------------------------------------------

export type PushResultsValidation = { ok: true } | { ok: false; reason: string }

/**
 * 完整性校验：results 数量必须等于本次 changes 数量，且 index 恰好覆盖 0..n-1。
 * 任何缺失 / 重复 / 越界都视为协议错误，由调用方整批按重试处理（绝不删条目）。
 */
export function validatePushResults(results: PushResult[], expectedCount: number): PushResultsValidation {
  if (!Array.isArray(results)) {
    return { ok: false, reason: 'push 响应缺少 results 数组' }
  }
  if (results.length !== expectedCount) {
    return {
      ok: false,
      reason: `push 结果数 ${results.length} 与变更数 ${expectedCount} 不一致`,
    }
  }
  const seen = new Set<number>()
  for (const result of results) {
    if (result === null || typeof result !== 'object') {
      return { ok: false, reason: 'push 响应含空结果项' }
    }
    const index = result.index
    if (!Number.isInteger(index) || index < 0 || index >= expectedCount) {
      return { ok: false, reason: `push 结果 index 越界: ${String(index)}` }
    }
    if (seen.has(index)) {
      return { ok: false, reason: `push 结果 index 重复: ${index}` }
    }
    seen.add(index)
  }
  if (seen.size !== expectedCount) {
    return { ok: false, reason: 'push 结果 index 集合不完整' }
  }
  return { ok: true }
}

export interface DispositionInput {
  entry: PendingEntry
  result: PushResult
  round: number
  now: number
  maxPushRounds: number
}

export type PushDisposition =
  | { kind: 'removed'; id: number }
  | { kind: 'merged'; id: number; localUuid: string; serverUuid: string }
  | { kind: 'dead'; dead: DeadOutcome }
  | { kind: 'retry-now'; retry: RetryOutcome }
  | { kind: 'retry-backoff'; retry: RetryOutcome }

/**
 * 单条 push 结果的处置（纯函数，无副作用）。
 *
 * `account_not_found` 严格按本条目判断：只有该条目自己命中时才产生 retry-now，
 * 由调用方据此触发全量 pull + 重映射重试；不再因为同批另一条命中而全批立即重推。
 * 命中两次（attempts 已达 2）或已无剩余轮次 → dead。
 */
export function decideDisposition(input: DispositionInput): PushDisposition {
  const { entry, result, round, now, maxPushRounds } = input
  const kind = classifyResult(result)
  if (kind === 'removed') {
    return { kind: 'removed', id: entry.id }
  }
  if (kind === 'merged') {
    return {
      kind: 'merged',
      id: entry.id,
      localUuid: result.uuid ?? '',
      serverUuid: result.server_uuid ?? '',
    }
  }
  if (kind === 'dead') {
    return {
      kind: 'dead',
      dead: {
        id: entry.id,
        code: result.code ?? 'dead',
        error: result.error ?? '永久失败',
      },
    }
  }

  const attempts = entry.attempts + 1
  const code = result.code ?? 'error'
  const error = result.error ?? ''
  if (code === 'account_not_found') {
    if (attempts >= 2 || round >= maxPushRounds) {
      return {
        kind: 'dead',
        dead: { id: entry.id, code, error: error === '' ? '账户重映射重试仍失败' : error },
      }
    }
    return {
      kind: 'retry-now',
      retry: { id: entry.id, attempts, nextRetryAt: now, code, error },
    }
  }
  return {
    kind: 'retry-backoff',
    retry: {
      id: entry.id,
      attempts,
      nextRetryAt: now + backoffMs(attempts),
      code,
      error,
    },
  }
}

export class SyncEngine {
  private syncing = false
  private listeners = new Set<(state: SyncState) => void>()
  private dataChangeListeners = new Set<(event: DataChangeEvent) => void>()
  private dataChangeSeq = 0
  private statusValue: SyncStatus = 'idle'
  private lastSyncAt = 0
  private lastSyncError: SyncErrorInfo | undefined
  private lastSyncSummary: SyncSummary | undefined
  private readonly leaseTtlMs: number
  private readonly maxPushRounds: number
  private readonly nowFn: () => number

  constructor(
    private store: SyncStore,
    private api: SyncApiClient,
    private ledgerIdProvider: () => number | null,
    options: SyncEngineOptions = {},
  ) {
    this.leaseTtlMs = options.leaseTtlMs ?? 90_000
    this.maxPushRounds = options.maxPushRounds ?? 2
    this.nowFn = options.now ?? (() => Date.now())
  }

  /** 订阅状态变化（SyncBadge / 同步页用）。返回取消函数。 */
  subscribe(listener: (state: SyncState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 订阅「pull 到真实变更」（与状态订阅分开，避免无变更的 60s 心跳误触刷新）。 */
  subscribeDataChange(listener: (event: DataChangeEvent) => void): () => void {
    this.dataChangeListeners.add(listener)
    return () => this.dataChangeListeners.delete(listener)
  }

  /** 只在真实变更后发事件；不写任何同步库状态。 */
  private emitDataChange(ledgerId: number, reason: DataChangeReason): void {
    this.dataChangeSeq += 1
    const event: DataChangeEvent = {
      ledgerId,
      seq: this.dataChangeSeq,
      reason,
      tabId: getTabId(),
      at: this.nowFn(),
    }
    for (const listener of this.dataChangeListeners) {
      listener(event)
    }
  }

  /** 从 store 读取真实队列计数（P0：getState 与 emit 共用同一口径；P1 带错误/摘要）。 */
  private async snapshot(status: SyncStatus): Promise<SyncState> {
    const ledgerId = this.ledgerIdProvider()
    if (ledgerId === null) {
      return {
        status,
        lastSyncAt: this.lastSyncAt,
        pendingCount: 0,
        deadCount: 0,
        lastSyncError: this.lastSyncError,
        lastSyncSummary: this.lastSyncSummary,
      }
    }
    const [pendingCount, deadCount] = await Promise.all([
      this.store.countPending(ledgerId, 'pending'),
      this.store.countPending(ledgerId, 'dead'),
    ])
    return {
      status,
      lastSyncAt: this.lastSyncAt,
      pendingCount,
      deadCount,
      lastSyncError: this.lastSyncError,
      lastSyncSummary: this.lastSyncSummary,
    }
  }

  private async emit(status: SyncStatus): Promise<void> {
    this.statusValue = status
    const state = await this.snapshot(status)
    for (const listener of this.listeners) {
      listener(state)
    }
  }

  /**
   * 当前状态快照（P0：async，真实计数）。
   * 现有 UI 不直接调用它，而是走 subscribe 推送；本方法供测试 / 命令式读取使用。
   */
  async getState(): Promise<SyncState> {
    return this.snapshot(this.statusValue)
  }

  /**
   * 离线记账：本地写入 + 入待推队列（原子），随后尽力同步一次。
   * 网络失败不抛错——本地已落库，等下次 sync / online 事件补推（AC-04）。
   */
  async recordOffline(input: { account?: LocalAccount; txn?: LocalTxn; pending: PendingChange }): Promise<void> {
    const ledgerId = this.requireLedgerId()
    await this.store.recordEntry(ledgerId, input)
    await this.emit(this.statusValue)
    // 与旧版一致：写完立即尝试同步（联网即推；断网由 sync 内部兜底为 offline）。
    await this.sync().catch(() => undefined)
  }

  /** 手动 / 自动触发全量同步。并发调用收敛为一次。 */
  async sync(): Promise<SyncOutcome> {
    if (this.syncing) {
      return 'skipped'
    }
    const ledgerId = this.ledgerIdProvider()
    if (ledgerId === null) {
      return 'skipped'
    }
    this.syncing = true
    const clientId = await this.store.getClientId()
    const holder = `sync-${clientId}`
    let leaseHeld = false
    // P1：抛出点即错误阶段；拿不到时按 push 处理（绝大多数 API 错误来自 push）。
    let phase: SyncErrorPhase = 'lease'
    try {
      await this.emit('syncing')
      // §6.6.1 #4：非 leader 跳过（另一个标签页在同步）。
      leaseHeld = await this.store.tryAcquireLease(holder, this.nowFn(), this.leaseTtlMs)
      if (!leaseHeld) {
        await this.emit(this.statusValue === 'syncing' ? 'idle' : this.statusValue)
        return 'skipped'
      }

      // ① pull（增量；库世代不匹配时内部会全量重拉）。
      phase = 'pull'
      const first = await this.pullNow(ledgerId, clientId, false)

      // ② push 循环（自然键合并重映射，最多 maxPushRounds 轮）。
      phase = 'push'
      const success = await this.pushLoop(ledgerId, clientId)

      // ③ 再 pull：合并 push 后服务端事件（含他人删除等）。
      phase = 'pull'
      const second = await this.pullNow(ledgerId, clientId, false)

      this.lastSyncAt = this.nowFn()
      this.lastSyncError = undefined
      await this.refreshSummary(ledgerId, success)
      await this.emit('ok')
      // 两轮 pull 聚合为**一次**变更事件：空变化（60s 心跳）不通知，
      // 避免每分钟全设备无谓重拉。世代重置优先于普通 pull 原因。
      if (first.changed || first.generationReset || second.changed || second.generationReset) {
        const reason: DataChangeReason =
          first.generationReset || second.generationReset ? 'generation-reset' : 'pull-changes'
        this.emitDataChange(ledgerId, reason)
      }
      return 'ok'
    } catch (err) {
      // P1：真实 code/message/at/phase 写进 SyncState，不再只映射 status 丢详情。
      this.lastSyncError = toSyncError(err, phase, this.nowFn())
      // 网络 / 5xx：离线退避（不要求 ApiError 实例，容错任意抛出形态）。
      const status = (err as { status?: unknown }).status
      const code = (err as { code?: unknown }).code
      const isOffline =
        code === 'network_error' || (typeof status === 'number' && status >= 500)
      if (isOffline) {
        await this.backoffAll(ledgerId, err, this.lastSyncError.at)
        await this.refreshSummary(ledgerId, 0)
        await this.emit('offline')
        return 'offline'
      }
      // 401 已由客户端全局登出处理；其余 API 错误标记 error，保留队列。
      await this.refreshSummary(ledgerId, 0)
      await this.emit('error')
      return 'error'
    } finally {
      if (leaseHeld) {
        await this.store.releaseLease(holder).catch(() => undefined)
      }
      this.syncing = false
    }
  }

  /**
   * 退避：网络/5xx 时给所有 pending 项推进 attempts 并设下次重试时间。
   *
   * P1：顶层网络错误只写 SyncState.lastSyncError。条目本来没有逐条错误时
   * 不把顶层文案灌进 last_error（否则 UI 会把所有正常排队误报成「失败」）。
   */
  private async backoffAll(ledgerId: number, err: unknown, at: number): Promise<void> {
    const entries = await this.store.getPending(ledgerId, 'pending')
    const now = this.nowFn()
    const top = toSyncError(err, 'push', at)
    for (const entry of entries) {
      if (entry.next_retry_at > now) continue
      await this.store.scheduleRetry(
        ledgerId,
        entry.id,
        entry.attempts + 1,
        now + backoffMs(entry.attempts + 1),
        entry.last_error_code ?? top.code,
        entry.last_error ?? '',
      )
    }
  }

  /** 本次同步摘要：成功数来自 push 结果，重试/死信取最终队列（与列表同口径）。 */
  private async refreshSummary(ledgerId: number, success: number): Promise<void> {
    try {
      const now = this.nowFn()
      const pending = await this.store.getPending(ledgerId, 'pending')
      const dead = await this.store.countPending(ledgerId, 'dead')
      this.lastSyncSummary = {
        success,
        retry: pending.filter((entry) => isRetryingPending(entry, now)).length,
        dead,
        at: now,
      }
    } catch {
      // 摘要是只读观测，读失败保留上一轮结果，绝不打断同步主路径。
    }
  }

  /**
   * 立即重试（P1）：仅持租约的 tab 执行，一步完成 retryNow + 一轮 sync。
   *
   * 非 leader 直接返回 'skipped'，避免多 tab 互相通知导致同一批条目反复重试。
   * retryNow 保留 attempts、清逐条错误并归零 next_retry_at；随后 sync 会真正重推。
   */
  async requestRetry(ids: number[]): Promise<'ok' | 'skipped'> {
    const ledgerId = this.ledgerIdProvider()
    if (ledgerId === null || ids.length === 0) return 'skipped'
    const clientId = await this.store.getClientId()
    const holder = `sync-${clientId}`
    const leader = await this.store.tryAcquireLease(holder, this.nowFn(), this.leaseTtlMs)
    if (!leader) return 'skipped'

    let handedToSync = false
    try {
      await this.store.retryNow(ledgerId, ids)
      await this.emit(this.statusValue)
      if (this.syncing) {
        // 同 tab 已有同步在跑：重试已落库，交给它带走；租约由它释放。
        handedToSync = true
        return 'ok'
      }
      const outcome = await this.sync()
      handedToSync = outcome !== 'skipped'
      return 'ok'
    } finally {
      // sync 自己会在结束时释放租约；skipped（同 tab 正在同步 / 租约被抢）时这里收尾。
      if (!handedToSync) {
        await this.store.releaseLease(holder).catch(() => undefined)
      }
    }
  }

  /**
   * 拉取并应用服务端变更。
   * @param forceFull true 时从 0 重拉（库世代不匹配 / account_not_found 重映射）。
   */
  private async pullNow(ledgerId: number, clientId: string, forceFull: boolean): Promise<PullSummary> {
    const lastSeq = forceFull ? 0 : await this.store.getLastSeq(ledgerId)
    const resp = await this.api.pull(lastSeq, clientId)

    // §6.6.1 #5：库世代不匹配 → pending 转隔离区 + 清实体 + 全量重拉。
    const storedInstance = await this.store.getInstanceId(ledgerId)
    if (resp.instance_id !== undefined && resp.instance_id !== '') {
      if (storedInstance === null) {
        await this.store.setInstanceId(ledgerId, resp.instance_id)
      } else if (resp.instance_id !== storedInstance) {
        await this.store.quarantineAndReset(ledgerId, resp.instance_id)
        await this.emit(this.statusValue)
        const full = await this.api.pull(0, clientId)
        await this.store.applyPullChanges(ledgerId, full.changes, full.checkpoint)
        return {
          changed: Array.isArray(full.changes) && full.changes.length > 0,
          generationReset: true,
          checkpoint: full.checkpoint,
        }
      }
    }

    // 水位单调推进：空增量（checkpoint=0）不回退（store 内亦守卫）。
    await this.store.applyPullChanges(ledgerId, resp.changes, resp.checkpoint)
    if (forceFull && resp.checkpoint > 0) {
      await this.store.setInstanceId(ledgerId, resp.instance_id ?? storedInstance ?? '')
    }
    return {
      changed: Array.isArray(resp.changes) && resp.changes.length > 0,
      generationReset: false,
      checkpoint: resp.checkpoint,
    }
  }

  /** push 循环（最多两轮）：收集合并映射 → 重映射 → 重推；返回成功落地笔数。 */
  private async pushLoop(ledgerId: number, clientId: string): Promise<number> {
    let success = 0
    for (let round = 1; round <= this.maxPushRounds; round += 1) {
      // §6.6.1 #3：push 前回放 uuid_map（崩溃恢复路径）。
      await this.replayUuidMap(ledgerId)

      const now = this.nowFn()
      const all = await this.store.getPending(ledgerId, 'pending')
      const entries = all.filter((e) => e.next_retry_at <= now)
      if (entries.length === 0) return success

      const changes: PushChange[] = entries.map((e) => ({
        entity_type: e.change.entity_type,
        op: e.change.op ?? 'create',
        entity: e.change.entity,
      }))
      const lastSeq = await this.store.getLastSeq(ledgerId)
      const resp = await this.api.push(clientId, lastSeq, changes)

      // P0：结果完整性优先。缺失 / 重复 / 越界 → 整批退避重试，一条都不删。
      const validation = validatePushResults(resp.results, entries.length)
      if (!validation.ok) {
        await this.retryWholeBatch(ledgerId, entries, now, validation.reason)
        continue
      }

      const uuidMap: Record<string, string> = {}
      const removedIds: number[] = []
      const dead: DeadOutcome[] = []
      const retries: RetryOutcome[] = []
      let needsRemapPull = false
      let allSettled = true

      for (const result of resp.results) {
        // 严格按 result.index 定位；校验已保证对齐，这里再做防御性检查，
        // 绝不用 `?? entries[i]` 静默兜底造成条目错配。
        const entry: PendingEntry | undefined = entries[result.index]
        if (entry === undefined) {
          await this.retryWholeBatch(
            ledgerId,
            entries,
            now,
            `push 结果 index 越界: ${String(result.index)}`,
          )
          return success
        }
        const disposition = decideDisposition({
          entry,
          result,
          round,
          now,
          maxPushRounds: this.maxPushRounds,
        })
        switch (disposition.kind) {
          case 'removed':
            removedIds.push(disposition.id)
            success += 1
            break
          case 'merged':
            // 自然键合并：记录本地→服务端映射并移除本地 pending；
            // 本地账户实体由 store 在同事务里重映射。
            if (disposition.localUuid !== '' && disposition.serverUuid !== '') {
              uuidMap[disposition.localUuid] = disposition.serverUuid
            }
            removedIds.push(disposition.id)
            success += 1
            break
          case 'dead':
            dead.push(disposition.dead)
            allSettled = false
            break
          case 'retry-now':
            retries.push(disposition.retry)
            needsRemapPull = true
            allSettled = false
            break
          case 'retry-backoff':
            retries.push(disposition.retry)
            allSettled = false
            break
        }
      }

      // 合并重映射：修正剩余 pending 的 postings 引用（与旧版 _rewritePendingRefs 一致）。
      const updates = collectPendingUpdates(entries, new Set<number>(removedIds), uuidMap)

      // P0：四类处置一次性落地（单事务）；不再 applyPushResults 之后重新 getPending。
      await this.store.applyPushOutcome(ledgerId, {
        uuidMap,
        removedIds,
        updates,
        dead,
        retries,
        checkpoint: resp.checkpoint,
      })

      // 只有本条目自己命中 account_not_found 才触发全量 pull + 重映射重试。
      if (needsRemapPull && round < this.maxPushRounds) {
        await this.pullNow(ledgerId, clientId, true)
      }

      if (allSettled) return success
    }
    return success
  }

  /** 协议错误：整批按临时失败退避；checkpoint=0 由 store 单调守卫挡住，不推进水位。 */
  private async retryWholeBatch(
    ledgerId: number,
    entries: PendingEntry[],
    now: number,
    reason: string,
  ): Promise<void> {
    if (entries.length === 0) return
    const retries: RetryOutcome[] = entries.map((entry) => {
      const attempts = entry.attempts + 1
      return {
        id: entry.id,
        attempts,
        nextRetryAt: now + backoffMs(attempts),
        code: 'invalid_push_results',
        error: reason,
      }
    })
    await this.store.applyPushOutcome(ledgerId, {
      uuidMap: {},
      removedIds: [],
      updates: [],
      dead: [],
      retries,
      checkpoint: 0,
    })
  }

  /** uuid_map 崩溃回放：把映射再应用到 pending 引用（幂等）。 */
  private async replayUuidMap(ledgerId: number): Promise<void> {
    const map = await this.store.getUuidMap(ledgerId)
    const keys = Object.keys(map)
    if (keys.length === 0) return
    const entries = await this.store.getPending(ledgerId, 'pending')
    const updates = collectPendingUpdates(entries, new Set<number>(), map)
    if (updates.length > 0) {
      await this.store.applyPushResults(ledgerId, {
        uuidMap: {},
        removedIds: [],
        updates,
        checkpoint: await this.store.getLastSeq(ledgerId),
      })
    }
  }

  /** 自动同步挂载：online / visibilitychange / 周期定时。返回卸载函数。 */
  startAutoSync(intervalMs = 60_000): () => void {
    const onOnline = (): void => {
      void this.sync().catch(() => undefined)
    }
    const onVisible = (): void => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        void this.sync().catch(() => undefined)
      }
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', onOnline)
      document.addEventListener('visibilitychange', onVisible)
    }
    const timer = setInterval(() => {
      void this.sync().catch(() => undefined)
    }, intervalMs)
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline)
        document.removeEventListener('visibilitychange', onVisible)
      }
      clearInterval(timer)
    }
  }

  private requireLedgerId(): number {
    const ledgerId = this.ledgerIdProvider()
    if (ledgerId === null || ledgerId <= 0) {
      throw new Error('尚未选择账本，离线写入缺少账本上下文')
    }
    return ledgerId
  }
}

/**
 * 收集需要重写实体引用的 pending（合并重映射 / uuid_map 回放共用）。
 * 与旧版 `_rewritePendingRefs` 一致：只改 transaction 的 postings.account_uuid。
 */
function collectPendingUpdates(
  entries: PendingEntry[],
  removedSet: Set<number>,
  uuidMap: Record<string, string>,
): Array<{ id: number; change: PendingChange }> {
  const updates: Array<{ id: number; change: PendingChange }> = []
  for (const entry of entries) {
    if (removedSet.has(entry.id)) continue
    if (entry.change.entity_type !== 'transaction') continue
    const postings = entry.change.entity['postings']
    if (!Array.isArray(postings)) continue
    let changed = false
    const newPostings = postings.map((p) => {
      const pm = { ...(p as Record<string, unknown>) }
      const accountUuid = pm['account_uuid']
      if (typeof accountUuid === 'string' && uuidMap[accountUuid] !== undefined) {
        pm['account_uuid'] = uuidMap[accountUuid]
        changed = true
      }
      return pm
    })
    if (!changed) continue
    updates.push({
      id: entry.id,
      change: { ...entry.change, entity: { ...entry.change.entity, postings: newPostings } },
    })
  }
  return updates
}

/** 死信码表导出（同步页展示与测试用）。 */
export { DEAD_CODES }
