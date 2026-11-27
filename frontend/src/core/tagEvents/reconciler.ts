/**
 * 重连提交编排（P1 reconciler）。
 *
 * 严格只走 PUT /api/transactions/{uuid}/tags 窄通道：
 *   ① pull 后本地已有服务端 tags + tags_updated_at（applyPullChanges 落库）
 *   ② converge(serverTags, updatedAt, events) → finalTags
 *   ③ PUT {tags, base_tags, device_id, client_op_id}
 *   ④ 409 三分支：结果幂等当成功 / 以 current_tags 为新 base 重收敛（≤3 次，
 *      复用同一 clientOpId）/ 不可恢复码保留 batch 并提示
 *   ⑤ 成功清事件，仅保留最近 100 条 / 30 天 remove 墓碑
 *
 * 硬边界：事件存 IndexedDB `tag_events`，与 pending 物理隔离；
 * reconciler **绝不调用 api.push**，也不写任何经济事实字段。
 */
import { getLedgerId, transactionApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { TagEditResponse } from '@/api/types'
import { IdbSyncStore } from '@/core/sync/idbStore'
import { MemorySyncStore, type SyncStore } from '@/core/sync/localStore'
import type { TagEvent, TagEventBatch } from '@/core/sync/models'
import { TAG_MERGE_STRATEGY } from './config'
import { getOrCreateSeq, makeClientOpId, stableDeviceId } from './device'
import {
  converge,
  maxEventTs,
  mergeConflictCount,
  nextTs,
  normalizeTags,
  pruneTombstones,
  readStringArray,
  sameTags,
} from './merge'
import {
  notifyMergeDropped,
  notifyMergeRetryLater,
  notifyMergeSuccess,
} from './notice'
import type {
  AppendTagEventOptions,
  CommitBatchOptions,
  CommitOutcome,
  TagIntent,
} from './types'

/** 不可恢复码：交易被冲正 / 无权限 / 不存在，保留事件等人工处理。 */
const UNRECOVERABLE_CODES: readonly string[] = [
  'txn_already_reversed',
  'txn_not_editable',
  'txn_edit_forbidden',
  'txn_not_found',
  'not_found',
]

let storeOverride: SyncStore | null = null
let lazyStore: Promise<SyncStore> | null = null

/** 由 stores/sync.ts 注入与 SyncEngine 同一个存储实例（生产为 IndexedDB）。 */
export function configureTagMergeStore(store: SyncStore): void {
  storeOverride = store
  lazyStore = Promise.resolve(store)
}

/** 测试用：重置模块级存储与去重状态（可注入干净内存库）。 */
export function resetTagMergeCoordinator(store?: SyncStore): void {
  storeOverride = store ?? null
  lazyStore = store === undefined ? null : Promise.resolve(store)
}

async function getStore(): Promise<SyncStore> {
  if (storeOverride !== null) {
    return storeOverride
  }
  if (lazyStore === null) {
    lazyStore =
      typeof indexedDB !== 'undefined'
        ? IdbSyncStore.open().catch(() => new MemorySyncStore())
        : Promise.resolve(new MemorySyncStore())
  }
  return lazyStore
}

/** 账本 id 优先取显式参数，其次取 API 会话；测试 mock 缺 getter 时落 0。 */
function resolveLedgerId(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit)) {
    return explicit
  }
  try {
    if (typeof getLedgerId === 'function') {
      const id = getLedgerId()
      if (id !== null) {
        return id
      }
    }
  } catch {
    // mock / 未登录场景：用 0 作为隔离命名空间即可。
  }
  return 0
}

/**
 * chip 变更当下产生事件（add / remove 墓碑）。
 *
 * 批次首次创建时固定 clientOpId；已提交批次的 remove 墓碑带入新批次，
 * 防止「删了又复活」。事件只写 tag_events，不碰 pending。
 */
export async function appendTagEvent(
  uuid: string,
  intent: TagIntent,
  options: AppendTagEventOptions = {},
): Promise<void> {
  const tag = intent.tag.trim()
  if (tag === '') {
    return
  }
  const ledgerId = resolveLedgerId(options.ledgerId)
  const store = await getStore()
  const deviceId = options.deviceId ?? stableDeviceId()
  let batch = await store.getTagBatch(ledgerId, uuid)
  const retained = batch === null ? [] : pruneTombstones(batch.events)

  if (batch === null || batch.committed === true) {
    const seq = await getOrCreateSeq(store, ledgerId)
    batch = {
      uuid,
      baseTags: normalizeTags(options.baseTags ?? (batch === null ? [] : batch.baseTags)),
      events: retained,
      clientOpId: makeClientOpId(deviceId, seq),
      conflictMerged: false,
      committed: false,
    }
  }

  // nextTs 基于批次内最大 ts：刷新页面后也不回退（抗同毫秒 / 时钟回拨）。
  const ts = nextTs(maxEventTs(batch.events))
  const event: TagEvent = { tag, op: intent.op, ts, device_id: deviceId }
  batch.events = batch.events.concat([event])
  await store.putTagBatch(ledgerId, batch)
}

/** 成功收尾：清已合并事件、只留墓碑，更新 CAS 基线为响应回显值。 */
async function finalizeSuccess(
  store: SyncStore,
  ledgerId: number,
  batch: TagEventBatch,
  responseTags: string[],
  responseTagsUpdatedAt: string,
  hadEvents: boolean,
): Promise<void> {
  const retained = pruneTombstones(batch.events)
  const next: TagEventBatch = {
    ...batch,
    baseTags: normalizeTags(responseTags),
    events: retained,
    conflictMerged: false,
    committed: true,
  }
  await store.putTagBatch(ledgerId, next)
  if (hadEvents) {
    const conflictCount =
      batch.conflictMerged === true
        ? Math.max(1, mergeConflictCount(batch.baseTags, responseTagsUpdatedAt, batch.events))
        : 0
    notifyMergeSuccess(batch.clientOpId, conflictCount)
  }
}

function isUnrecoverable(err: ApiError): boolean {
  return err.status === 404 || (err.code !== undefined && UNRECOVERABLE_CODES.includes(err.code))
}

/**
 * 提交一个批次。
 *
 * 编辑器交互路径传 `maxAttempts: 1`：首个 409 以 `{status:'conflict'}` 交还
 * 编辑器展示 P0 冲突面板；重连 flush 用默认 3 次自动重试。
 */
export async function commitBatch(
  uuid: string,
  options: CommitBatchOptions = {},
): Promise<CommitOutcome> {
  if (TAG_MERGE_STRATEGY === 'server') {
    // 方案 C 本期不实现：不发批量端点请求，按客户端收敛兜底（开关位保留）。
  }
  const ledgerId = resolveLedgerId(options.ledgerId)
  const store = await getStore()
  const deviceId = options.deviceId ?? stableDeviceId()
  const updatedAt = options.tagsUpdatedAt ?? ''
  let batch = await store.getTagBatch(ledgerId, uuid)

  if (batch === null) {
    const seq = await getOrCreateSeq(store, ledgerId)
    batch = {
      uuid,
      baseTags: normalizeTags(options.baseTags ?? []),
      events: [],
      clientOpId: makeClientOpId(deviceId, seq),
      committed: false,
    }
  } else if (batch.committed === true) {
    // 已提交批次再次编辑 / 无变更保存：新操作 → 新 op id，墓碑继续参与收敛。
    const seq = await getOrCreateSeq(store, ledgerId)
    batch = {
      ...batch,
      baseTags: normalizeTags(options.baseTags ?? batch.baseTags),
      clientOpId: makeClientOpId(deviceId, seq),
      committed: false,
    }
  }

  // 保留最近一次 pull / 409 回带的服务端顺序（后端 CAS 自行规范化），
  // 不在这里重排，避免「用最新标签重试」的 base_tags 与响应原序不一致。
  let base = batch.baseTags.slice()
  const hadEvents = batch.events.length > 0
  let finalTags =
    options.targetTags !== undefined
      ? normalizeTags(options.targetTags)
      : converge(base, updatedAt, batch.events)
  const maxAttempts = options.maxAttempts ?? 3

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response: TagEditResponse = await transactionApi.updateTags(uuid, {
        tags: finalTags.slice(),
        base_tags: base.slice(),
        device_id: deviceId,
        client_op_id: batch.clientOpId,
      })
      await finalizeSuccess(store, ledgerId, batch, response.tags, response.tags_updated_at, hadEvents)
      return { status: 'saved', response }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'txn_tags_conflict') {
        const details = err.details ?? {}
        const current = readStringArray(details['current_tags'])
        const currentUpdatedAt =
          typeof details['current_tags_updated_at'] === 'string'
            ? (details['current_tags_updated_at'] as string)
            : ''
        // 结果幂等：首次 PUT 其实已落库（响应丢失）→ 按成功处理，不写第二条审计。
        if (sameTags(normalizeTags(current), finalTags)) {
          const replayed: TagEditResponse = {
            uuid,
            tags: finalTags.slice(),
            tags_updated_at: currentUpdatedAt,
            edit_id: 0,
          }
          await finalizeSuccess(store, ledgerId, batch, replayed.tags, replayed.tags_updated_at, hadEvents)
          return { status: 'saved', response: replayed }
        }
        // 按服务端 current_tags 原序作为新 base（P0 口径；收敛内部仍归一化）。
        base = current.slice()
        batch.baseTags = base.slice()
        batch.conflictMerged = true
        await store.putTagBatch(ledgerId, batch)
        if (attempt + 1 >= maxAttempts) {
          if (options.notifyOnError === true) {
            notifyMergeRetryLater(batch.clientOpId)
          }
          return { status: 'conflict', current, updatedAt: currentUpdatedAt }
        }
        finalTags =
          options.targetTags !== undefined
            ? normalizeTags(options.targetTags)
            : converge(base, currentUpdatedAt, batch.events)
        continue
      }

      const apiError = err instanceof ApiError ? err : null
      const code = apiError?.code ?? 'network_error'
      const message = apiError?.message ?? '标签合并失败，稍后自动重试'
      if (options.notifyOnError === true) {
        if (apiError !== null && isUnrecoverable(apiError)) {
          notifyMergeDropped(batch.clientOpId)
        } else {
          notifyMergeRetryLater(batch.clientOpId)
        }
      }
      return { status: 'error', code, message }
    }
  }
  return { status: 'error', code: 'txn_tags_conflict', message: '标签合并重试次数已用尽' }
}

/** 重连后逐笔提交；返回成功提交数。单笔失败不影响其他交易。 */
export async function flush(ledgerId: number): Promise<number> {
  const store = await getStore()
  const uuids = await store.allTagBatchUuids(ledgerId)
  let succeeded = 0
  for (const uuid of uuids) {
    const outcome = await flushOne(uuid, { ledgerId })
    if (outcome !== null && outcome.status === 'saved') {
      succeeded += 1
    }
  }
  return succeeded
}

/** 提交单笔；无待提交事件返回 null（已提交批次只留墓碑，不重放）。 */
export async function flushOne(
  uuid: string,
  options: AppendTagEventOptions = {},
): Promise<CommitOutcome | null> {
  const ledgerId = resolveLedgerId(options.ledgerId)
  const store = await getStore()
  const batch = await store.getTagBatch(ledgerId, uuid)
  if (batch === null || batch.committed === true || batch.events.length === 0) {
    return null
  }
  let tagsUpdatedAt = options.tagsUpdatedAt ?? ''
  if (tagsUpdatedAt === '') {
    const txns = await store.getAllTxns(ledgerId)
    for (const txn of txns) {
      if (txn.uuid === uuid) {
        tagsUpdatedAt = txn.tags_updated_at ?? ''
        break
      }
    }
  }
  try {
    return await commitBatch(uuid, {
      ledgerId,
      deviceId: options.deviceId ?? stableDeviceId(),
      tagsUpdatedAt,
      maxAttempts: 3,
      notifyOnError: true,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : '标签合并失败'
    notifyMergeRetryLater(`${ledgerId}:${uuid}:${message}`)
    return { status: 'error', code: 'tag_merge_unexpected', message }
  }
}

/** 显式清空批次（编辑器 P0 冲突面板处理成功后调用，防残留重放）。 */
export async function clearBatch(ledgerId: number, uuid: string): Promise<void> {
  const store = await getStore()
  await store.deleteTagBatch(resolveLedgerId(ledgerId), uuid)
}

/** 预测当前收敛结果（离线 chip 回显，edit_id=0 表示尚未落库）。 */
export async function predictTags(
  uuid: string,
  options: AppendTagEventOptions = {},
): Promise<string[]> {
  const ledgerId = resolveLedgerId(options.ledgerId)
  const store = await getStore()
  const batch = await store.getTagBatch(ledgerId, uuid)
  if (batch === null) {
    return normalizeTags(options.baseTags ?? [])
  }
  return converge(batch.baseTags, options.tagsUpdatedAt ?? '', batch.events)
}

export const tagMergeCoordinator = {
  appendTagEvent,
  commitBatch,
  flush,
  flushOne,
  clearBatch,
  predictTags,
}
